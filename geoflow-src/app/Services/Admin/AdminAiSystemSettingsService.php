<?php

namespace App\Services\Admin;

use App\Models\Admin;
use App\Models\AiModel;
use App\Models\SiteSetting;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

final class AdminAiSystemSettingsService
{
    /** 知识库切片策略全集。`semantic_llm` 必须同时指定切片模型。 */
    public const CHUNK_STRATEGIES = ['rule', 'auto', 'semantic_llm'];

    public const SETTING_CHUNK_STRATEGY = 'knowledge_chunk_strategy';

    public const SETTING_CHUNKING_MODEL_ID = 'knowledge_chunking_model_id';

    public const SETTING_DEFAULT_EMBEDDING = 'default_embedding_model_id';

    /**
     * 系统默认的 embedding 模型 ID；未配置为 0。
     *
     * 这是「知识库向量化到底用哪条模型」的唯一权威读法——旧后台页面、api/v1
     * 与后续的向量化流水线都必须从这里取，不要各自去查 SiteSetting。
     */
    public function defaultEmbeddingModelId(): int
    {
        return max(0, (int) (SiteSetting::query()
            ->where('setting_key', self::SETTING_DEFAULT_EMBEDDING)
            ->value('setting_value') ?? 0));
    }

    /**
     * 当前切片策略与切片模型 ID。
     *
     * 存量数据里可能是空值或不在全集内的脏值，一律回落到 `rule` / 0——
     * 页面按回落值显示，切片行为也按回落值执行，两者必须一致。
     *
     * @return array{strategy:string,model_id:int}
     */
    public function chunkingConfig(): array
    {
        $settings = SiteSetting::query()
            ->whereIn('setting_key', [self::SETTING_CHUNK_STRATEGY, self::SETTING_CHUNKING_MODEL_ID])
            ->pluck('setting_value', 'setting_key');
        $strategy = (string) ($settings[self::SETTING_CHUNK_STRATEGY] ?? 'rule');

        return [
            'strategy' => in_array($strategy, self::CHUNK_STRATEGIES, true) ? $strategy : 'rule',
            'model_id' => max(0, (int) ($settings[self::SETTING_CHUNKING_MODEL_ID] ?? 0)),
        ];
    }

    public function updateDefaultEmbedding(Admin $actor, int $modelId): void
    {
        DB::transaction(function () use ($actor, $modelId): void {
            $lockedActor = $this->lockActiveSuperAdmin($actor);
            if ($modelId > 0 && ! $this->lockSystemModel($lockedActor, $modelId, 'embedding') instanceof AiModel) {
                throw ValidationException::withMessages([
                    'default_embedding_model_id' => __('admin.ai_models.error.embedding_unavailable'),
                ]);
            }

            $this->writeSetting(self::SETTING_DEFAULT_EMBEDDING, (string) $modelId);
        }, 3);
    }

    public function updateChunking(Admin $actor, string $strategy, int $modelId): void
    {
        DB::transaction(function () use ($actor, $strategy, $modelId): void {
            $lockedActor = $this->lockActiveSuperAdmin($actor);
            if ($strategy === 'semantic_llm' && $modelId <= 0) {
                throw ValidationException::withMessages([
                    'knowledge_chunking_model_id' => __('admin.ai_models.error.chunking_model_required'),
                ]);
            }
            if ($modelId > 0 && ! $this->lockSystemModel($lockedActor, $modelId, 'chat') instanceof AiModel) {
                throw ValidationException::withMessages([
                    'knowledge_chunking_model_id' => __('admin.ai_models.error.chunking_model_unavailable'),
                ]);
            }

            $this->writeSetting(self::SETTING_CHUNK_STRATEGY, $strategy);
            $this->writeSetting(self::SETTING_CHUNKING_MODEL_ID, (string) $modelId);
        }, 3);
    }

    /** @return array<int, array{id:int,name:string,model_id:string}> */
    public function modelOptions(Admin $actor, string $modelType): array
    {
        $currentActor = Admin::query()->whereKey($actor->getKey())->active()->first();
        if (! $currentActor instanceof Admin || ! $currentActor->isSuperAdmin()) {
            throw new AuthorizationException('ai_system_config_super_admin_only');
        }

        return $this->systemModelQuery($currentActor, $modelType)
            ->select(['id', 'name', 'model_id'])
            ->orderBy('name')
            ->orderByDesc('id')
            ->get()
            ->map(static fn (AiModel $model): array => [
                'id' => (int) $model->getKey(),
                'name' => (string) $model->name,
                'model_id' => (string) $model->model_id,
            ])
            ->all();
    }

    public function initializeDefaultEmbeddingForNewModel(Admin $lockedActor, AiModel $lockedModel): void
    {
        if (! $lockedActor->isSuperAdmin()
            || (int) $lockedModel->owner_admin_id !== (int) $lockedActor->getKey()
            || (string) $lockedModel->access_scope !== AiModel::ACCESS_SCOPE_SYSTEM_ONLY
            || (string) $lockedModel->status !== 'active'
            || $lockedModel->archived_at !== null
            || (string) $lockedModel->model_type !== 'embedding') {
            return;
        }

        $setting = SiteSetting::query()
            ->where('setting_key', 'default_embedding_model_id')
            ->lockForUpdate()
            ->first();
        if ($setting instanceof SiteSetting && (int) $setting->setting_value > 0) {
            return;
        }

        $this->writeSetting('default_embedding_model_id', (string) $lockedModel->getKey());
    }

    public function clearDefaultEmbeddingForModel(Admin $lockedActor, AiModel $lockedModel): void
    {
        if (! $lockedActor->isSuperAdmin()) {
            return;
        }

        $setting = SiteSetting::query()
            ->where('setting_key', 'default_embedding_model_id')
            ->lockForUpdate()
            ->first();
        if (! $setting instanceof SiteSetting || (int) $setting->setting_value !== (int) $lockedModel->getKey()) {
            return;
        }

        $setting->forceFill(['setting_value' => '0'])->save();
    }

    private function lockActiveSuperAdmin(Admin $actor): Admin
    {
        $lockedActor = Admin::query()->whereKey($actor->getKey())->lockForUpdate()->first();
        if (! $lockedActor instanceof Admin
            || (string) $lockedActor->status !== 'active'
            || ! $lockedActor->isSuperAdmin()) {
            throw new AuthorizationException('ai_system_config_super_admin_only');
        }

        return $lockedActor;
    }

    private function lockSystemModel(Admin $lockedActor, int $modelId, string $modelType): ?AiModel
    {
        return $this->systemModelQuery($lockedActor, $modelType)
            ->whereKey($modelId)
            ->lockForUpdate()
            ->first();
    }

    private function systemModelQuery(Admin $actor, string $modelType): Builder
    {
        return AiModel::query()
            ->ownedBy($actor)
            ->systemOnly()
            ->active()
            ->unarchived()
            ->where(function (Builder $query) use ($modelType): void {
                if ($modelType === 'chat') {
                    $query->whereNull('model_type')->orWhere('model_type', '')->orWhere('model_type', 'chat');

                    return;
                }

                $query->where('model_type', 'embedding');
            });
    }

    private function writeSetting(string $key, string $value): void
    {
        SiteSetting::query()->updateOrCreate(
            ['setting_key' => $key],
            ['setting_value' => $value],
        );
    }
}
