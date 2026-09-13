<?php

namespace App\Services\Admin;

use App\Data\Admin\AdminAiModelMutationResult;
use App\Models\Admin;
use App\Models\AiModel;
use App\Models\AiWorkspaceRun;
use App\Models\EnterpriseKnowledgeProject;
use App\Models\KnowledgeFactGenerationRun;
use App\Models\TitleGenerationRun;
use App\Models\UrlImportJob;
use App\Services\AiWorkspace\AiModelInvocationLock;
use App\Services\GeoFlow\ArticleAiQualityInvalidationService;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;
use Throwable;

final class AdminAiModelMutationService
{
    public function __construct(
        private readonly AdminAiSettingsService $personalSettings,
        private readonly AdminAiSystemSettingsService $systemSettings,
        private readonly AiModelInvocationLock $invocationLocks,
        private readonly ArticleAiQualityInvalidationService $qualityInvalidation,
    ) {}

    /** @param array<string, mixed> $attributes */
    public function create(Admin $actor, array $attributes, string $requestedScope): AdminAiModelMutationResult
    {
        $result = DB::transaction(function () use ($actor, $attributes, $requestedScope): AdminAiModelMutationResult {
            $lockedActor = $this->lockActiveActor($actor);
            $scope = $this->authorizedScope($lockedActor, $requestedScope);
            $model = new AiModel($attributes);
            $model->forceFill([
                'owner_admin_id' => (int) $lockedActor->getKey(),
                'access_scope' => $scope,
            ])->save();

            if ($scope === AiModel::ACCESS_SCOPE_USER_CONTENT) {
                $this->personalSettings->setPersonalDefaultIfMissing($lockedActor, $model);
            } else {
                $this->systemSettings->initializeDefaultEmbeddingForNewModel($lockedActor, $model);
            }

            return new AdminAiModelMutationResult($model);
        }, 3);

        // 新增一条 chat 模型会改变质检智能切换的候选集，已有质检结论不再可追溯。
        // 放在事务**之外**：事务回滚时不能留下「结论被作废但模型没改」的中间态；
        // 同时也不能用 afterCommit —— 测试的 RefreshDatabase 会一直开着外层事务，
        // 那类回调永远不触发，等于把副作用藏进了测不到的地方。
        if ((string) $result->model->model_type === 'chat') {
            $this->invalidateQualityAfterCommit((int) $result->model->getKey(), 'AI 质检智能切换候选模型已增加');
        }

        return $result;
    }

    /** @param array<string, mixed> $attributes */
    public function update(
        Admin $actor,
        int $modelId,
        array $attributes,
        string $requestedScope,
    ): AdminAiModelMutationResult {
        $result = DB::transaction(function () use ($actor, $modelId, $attributes, $requestedScope): AdminAiModelMutationResult {
            $lockedActor = $this->lockActiveActor($actor);
            $lockedModel = $this->lockConfigurableModel($lockedActor, $modelId, 'update');
            $scope = $this->authorizedScope($lockedActor, $requestedScope);
            $invocationLock = $this->invocationLocks->acquireForMutation($modelId);
            if ($invocationLock === null) {
                return new AdminAiModelMutationResult($lockedModel, 'task');
            }

            try {
                if ($this->activeTitleGenerationCount($modelId) > 0) {
                    return new AdminAiModelMutationResult($lockedModel, 'title_generation');
                }
                if ($this->activeAiWorkspaceRunCount($modelId) > 0) {
                    return new AdminAiModelMutationResult($lockedModel, 'task');
                }
                if ($this->activeKnowledgeFactGenerationIds($modelId) !== []) {
                    return new AdminAiModelMutationResult($lockedModel, 'task');
                }

                $lockedModel->fill(Arr::except($attributes, ['access_scope']));
                $lockedModel->forceFill(['access_scope' => $scope])->save();
                $this->personalSettings->clearIncompatibleDefaultsForModel($lockedModel, $lockedActor);
                if (! $this->isUsableSystemEmbedding($lockedModel)) {
                    $this->systemSettings->clearDefaultEmbeddingForModel($lockedActor, $lockedModel);
                }

                return new AdminAiModelMutationResult($lockedModel->refresh());
            } finally {
                $this->invocationLocks->release($invocationLock);
            }
        }, 3);

        // 只在真正改成功时失效：上面几条「被任务占用」的提前返回并没有动模型。
        if ($result->succeeded()) {
            $this->invalidateQualityAfterCommit((int) $result->model->getKey(), 'AI 质检模型配置已更新');
        }

        return $result;
    }

    public function delete(Admin $actor, int $modelId): AdminAiModelMutationResult
    {
        return DB::transaction(function () use ($actor, $modelId): AdminAiModelMutationResult {
            $lockedActor = $this->lockActiveActor($actor);
            $lockedModel = $this->lockConfigurableModel($lockedActor, $modelId, 'delete');
            $invocationLock = $this->invocationLocks->acquireForMutation($modelId);
            if ($invocationLock === null) {
                return new AdminAiModelMutationResult($lockedModel, 'task');
            }

            try {
                if ($this->activeTitleGenerationCount($modelId) > 0) {
                    return new AdminAiModelMutationResult($lockedModel, 'title_generation');
                }

                $taskCount = $lockedModel->tasks()->withTrashed()->count()
                    + $lockedModel->qualityTasks()->withTrashed()->count();
                $taskCount += $this->activeUrlImportCount($modelId);
                $taskCount += $this->activeEnterpriseKnowledgeCount($modelId);
                $taskCount += $this->activeAiWorkspaceRunCount($modelId);
                $taskCount += count($this->activeKnowledgeFactGenerationIds($modelId));
                if ($taskCount > 0) {
                    return new AdminAiModelMutationResult($lockedModel, 'task', $taskCount);
                }

                $this->personalSettings->clearAllDefaultsForModel($lockedModel, $lockedActor);
                $this->systemSettings->clearDefaultEmbeddingForModel($lockedActor, $lockedModel);
                $lockedModel->delete();

                return new AdminAiModelMutationResult($lockedModel);
            } finally {
                $this->invocationLocks->release($invocationLock);
            }
        }, 3);
    }

    private function lockActiveActor(Admin $actor): Admin
    {
        $lockedActor = Admin::query()->whereKey($actor->getKey())->lockForUpdate()->first();
        abort_unless($lockedActor instanceof Admin && (string) $lockedActor->status === 'active', 404);

        return $lockedActor;
    }

    private function lockConfigurableModel(Admin $actor, int $modelId, string $ability): AiModel
    {
        $query = AiModel::query()->ownedBy($actor);
        if (! $actor->isSuperAdmin()) {
            $query->userContent();
        }

        $model = $query->whereKey($modelId)->lockForUpdate()->firstOrFail();
        Gate::forUser($actor)->authorize($ability, $model);

        return $model;
    }

    private function authorizedScope(Admin $actor, string $requestedScope): string
    {
        if ($requestedScope === AiModel::ACCESS_SCOPE_SYSTEM_ONLY && ! $actor->isSuperAdmin()) {
            throw ValidationException::withMessages([
                'access_scope' => __('admin.ai_models.error.system_scope_super_admin_only'),
            ]);
        }

        return $actor->isSuperAdmin() ? $requestedScope : AiModel::ACCESS_SCOPE_USER_CONTENT;
    }

    private function activeTitleGenerationCount(int $modelId): int
    {
        return TitleGenerationRun::query()
            ->where(function ($query) use ($modelId): void {
                $query->where('ai_model_id', $modelId)
                    ->orWhere('requested_ai_model_id', $modelId)
                    ->orWhere('resolved_ai_model_id', $modelId);
            })
            ->where(function ($query): void {
                $query->whereIn('status', [
                    TitleGenerationRun::STATUS_QUEUED,
                    TitleGenerationRun::STATUS_RUNNING,
                ])->orWhere(function ($retryable): void {
                    $retryable
                        ->whereIn('status', [
                            TitleGenerationRun::STATUS_PARTIAL,
                            TitleGenerationRun::STATUS_FAILED,
                            TitleGenerationRun::STATUS_CANCELLED,
                        ])
                        ->whereNotNull('ai_model_id')
                        ->where('retryable_failure', true)
                        ->where(function ($failure): void {
                            $failure
                                ->whereNull('failure_code')
                                ->orWhere('failure_code', '!=', 'request_budget_exhausted');
                        })
                        ->where(
                            'manual_retry_count',
                            '<',
                            (int) config('geoflow.title_ai_max_manual_retries', 3),
                        );
                });
            })
            ->count();
    }

    private function activeUrlImportCount(int $modelId): int
    {
        return UrlImportJob::query()
            ->where(function ($query) use ($modelId): void {
                $query->where('requested_ai_model_id', $modelId)
                    ->orWhere('resolved_ai_model_id', $modelId);
            })
            ->where(function ($query): void {
                $query->whereIn('status', ['queued', 'running'])
                    ->orWhere(function ($retryable): void {
                        $retryable->where('status', 'failed')
                            ->where('retryable_failure', true);
                    });
            })
            ->count();
    }

    private function activeEnterpriseKnowledgeCount(int $modelId): int
    {
        return EnterpriseKnowledgeProject::query()
            ->where(function ($query) use ($modelId): void {
                $query->where('requested_ai_model_id', $modelId)
                    ->orWhere('resolved_ai_model_id', $modelId);
            })
            ->where(function ($query): void {
                $query->whereIn('status', ['queued', 'processing'])
                    ->orWhere(function ($retryable): void {
                        $retryable->where('status', 'failed')
                            ->where('retryable_failure', true);
                    });
            })
            ->count();
    }

    private function activeAiWorkspaceRunCount(int $modelId): int
    {
        return AiWorkspaceRun::query()
            ->where(function ($query) use ($modelId): void {
                $query->where('requested_ai_model_id', $modelId)
                    ->orWhere('resolved_ai_model_id', $modelId);
            })
            ->where(function ($query): void {
                $query->whereNotIn('state', AiWorkspaceRun::TERMINAL_STATES)
                    ->orWhere(function ($retryable): void {
                        $retryable->whereIn('state', ['failed', 'partially_completed'])
                            ->where('retryable_failure', true);
                    });
            })
            ->count();
    }

    /** @return list<int> */
    private function activeKnowledgeFactGenerationIds(int $modelId): array
    {
        $runIds = [];
        KnowledgeFactGenerationRun::query()
            ->where(function ($state): void {
                $state->whereIn('status', KnowledgeFactGenerationRun::ACTIVE_STATUSES)
                    ->orWhere(function ($retryable): void {
                        $retryable->whereIn('status', [
                            KnowledgeFactGenerationRun::STATUS_FAILED,
                            'partial',
                        ])->where('retryable_failure', true);
                    });
            })
            ->select([
                'id',
                'ai_model_id',
                'requested_ai_model_id',
                'resolved_ai_model_id',
                'batch_claims_json',
            ])
            ->orderBy('id')
            ->lockForUpdate()
            ->chunkById(200, function ($runs) use ($modelId, &$runIds): void {
                foreach ($runs as $run) {
                    if ((int) $run->ai_model_id === $modelId
                        || (int) $run->requested_ai_model_id === $modelId
                        || (int) $run->resolved_ai_model_id === $modelId
                        || collect((array) $run->batch_claims_json)->contains(
                            static fn (mixed $claim): bool => (int) data_get($claim, 'resolved_ai_model_id') === $modelId,
                        )) {
                        $runIds[] = (int) $run->getKey();
                    }
                }
            });

        return $runIds;
    }

    private function isUsableSystemEmbedding(AiModel $model): bool
    {
        return (string) $model->access_scope === AiModel::ACCESS_SCOPE_SYSTEM_ONLY
            && (string) $model->model_type === 'embedding'
            && (string) $model->status === 'active'
            && $model->archived_at === null;
    }

    /**
     * AI 质检结论绑定在「当时用的模型 + 当时那版方案」上。模型配置一变，已有结论就
     * 不再可追溯到产生它的规则版本，必须标记失效。
     *
     * 调用点必须在事务**提交之后**（本服务的 create/update 都在事务外调用它），
     * 这样回滚不会留下「结论被作废但模型没改」的中间态；失效失败也只上报不抛出，
     * 免得把已经成功的模型改动一起回滚掉。
     */
    private function invalidateQualityAfterCommit(int $modelId, string $reason): void
    {
        try {
            $this->qualityInvalidation->invalidateModel($modelId, $reason);
        } catch (Throwable $exception) {
            report($exception);
            Log::warning('AI quality model invalidation failed after model mutation.', [
                'ai_model_id' => $modelId,
                'exception' => $exception::class,
            ]);
        }
    }
}
