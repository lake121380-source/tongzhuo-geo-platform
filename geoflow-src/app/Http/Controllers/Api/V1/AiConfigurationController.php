<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Http\Controllers\Shared\AiModelController;
use App\Models\Admin;
use App\Models\AdminAiSetting;
use App\Models\AiModel;
use App\Models\Prompt;
use App\Services\Admin\AdminAiConfiguratorOverviewService;
use App\Services\Admin\AdminAiModelAccessResolver;
use App\Services\Admin\AdminAiModelMutationService;
use App\Services\Admin\AdminAiPromptService;
use App\Services\Admin\AdminAiSettingsService;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\ArticleAiQualityInvalidationService;
use App\Services\GeoFlow\ArticleAiQualityPromptRenderer;
use App\Support\ApiResponse;
use App\Support\GeoFlow\ApiKeyCrypto;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

/**
 * API v1 AI 配置投影。
 *
 * 这里只暴露可供当前管理员使用的模型和提示词，不返回 API key 或其它
 * 模型凭据。模型默认值通过既有 AdminAiSettingsService 写入，避免 React
 * 客户端绕过模型访问边界直接修改 ai_models。
 */
class AiConfigurationController extends BaseApiController
{
    public function models(Request $request, AdminAiModelAccessResolver $accessResolver): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $settings = AdminAiSetting::query()->where('admin_id', $admin->id)->first();
        $models = $accessResolver->managementQuery($admin)
            ->orderBy('model_type')
            ->orderBy('failover_priority')
            ->orderBy('id')
            ->get([
                'id',
                'owner_admin_id',
                'name',
                'version',
                'model_id',
                'model_type',
                'api_url',
                'status',
                'failover_priority',
                'archived_at',
                'api_key',
                'daily_limit',
                'max_tokens',
            ])
            ->map(function (AiModel $model) use ($settings, $admin): array {
                $type = trim((string) $model->model_type) ?: 'chat';

                return [
                    'id' => (int) $model->id,
                    'name' => (string) $model->name,
                    'version' => (string) ($model->version ?? ''),
                    'model_id' => $this->safeModelId((string) ($model->model_id ?? '')),
                    'model_type' => $type,
                    'status' => (string) $model->status,
                    'failover_priority' => (int) ($model->failover_priority ?? 100),
                    'is_available' => (string) $model->status === 'active' && $model->archived_at === null,
                    'is_default' => $type === 'embedding'
                        ? (int) ($settings?->default_embedding_model_id ?? 0) === (int) $model->id
                        : (int) ($settings?->default_chat_model_id ?? 0) === (int) $model->id,
                    'api_url' => (string) ($model->api_url ?? ''),
                    'api_key_configured' => trim((string) ($model->getRawOriginal('api_key') ?? '')) !== '',
                    'daily_limit' => (int) ($model->daily_limit ?? 0),
                    'max_tokens' => $model->max_tokens !== null ? (int) $model->max_tokens : null,
                    'access_scope' => (string) ($model->access_scope ?? AiModel::ACCESS_SCOPE_USER_CONTENT),
                    'is_owned' => (int) $model->owner_admin_id === (int) $admin->id,
                ];
            })
            ->values()
            ->all();

        return $this->success($request, [
            'items' => $models,
            'defaults' => [
                'chat_model_id' => $settings?->default_chat_model_id !== null ? (int) $settings->default_chat_model_id : null,
                'embedding_model_id' => $settings?->default_embedding_model_id !== null ? (int) $settings->default_embedding_model_id : null,
            ],
        ]);
    }

    public function storeModel(Request $request, ApiKeyCrypto $crypto, AdminAiModelMutationService $mutations): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        $payload = $this->validateModelPayload($request, true);

        return IdempotencyService::executeJson($request, 'POST /models', function () use ($request, $admin, $payload, $crypto, $mutations): JsonResponse {
            try {
                $payload['api_key'] = $crypto->encrypt((string) $payload['api_key']);
                $result = $mutations->create($admin, $payload, (string) ($payload['access_scope'] ?? AiModel::ACCESS_SCOPE_USER_CONTENT));

                return $this->success($request, ['model' => $this->managedProjection($result->model)], 201);
            } catch (\RuntimeException) {
                throw new ApiException('model_key_encryption_failed', '模型 API Key 无法安全加密', 500);
            }
        });
    }

    public function updateModel(Request $request, int $model, ApiKeyCrypto $crypto, AdminAiModelMutationService $mutations): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        $payload = $this->validateModelPayload($request, false);

        return IdempotencyService::executeJson($request, 'PATCH /models/{model}', function () use ($request, $admin, $model, $payload, $crypto, $mutations): JsonResponse {
            $attributes = $payload;
            $existing = AiModel::query()->whereKey($model)->first();
            if (! $existing instanceof AiModel) {
                throw new ApiException('model_not_found', '模型不存在或当前管理员无权编辑', 404);
            }
            if (! array_key_exists('status', $attributes) || trim((string) $attributes['status']) === '') {
                $attributes['status'] = (string) ($existing->status ?: 'active');
            }
            if (! array_key_exists('access_scope', $attributes) || trim((string) $attributes['access_scope']) === '') {
                $attributes['access_scope'] = (string) ($existing->access_scope ?: AiModel::ACCESS_SCOPE_USER_CONTENT);
            }
            if (trim((string) ($attributes['api_key'] ?? '')) !== '') {
                try {
                    $attributes['api_key'] = $crypto->encrypt((string) $attributes['api_key']);
                } catch (\RuntimeException) {
                    throw new ApiException('model_key_encryption_failed', '模型 API Key 无法安全加密', 500);
                }
            } else {
                unset($attributes['api_key']);
            }
            try {
                $result = $mutations->update($admin, $model, $attributes, (string) ($attributes['access_scope'] ?? AiModel::ACCESS_SCOPE_USER_CONTENT));
            } catch (ModelNotFoundException) {
                throw new ApiException('model_not_found', '模型不存在或当前管理员无权编辑', 404);
            }
            if (! $result->succeeded()) {
                throw new ApiException('model_in_use', '模型正在被运行中的任务或工作流使用，暂不能修改', 409, ['dependency_count' => $result->dependencyCount, 'dependency_type' => $result->error]);
            }

            return $this->success($request, ['model' => $this->managedProjection($result->model)]);
        });
    }

    public function destroyModel(Request $request, int $model, AdminAiModelMutationService $mutations): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);

        return IdempotencyService::executeJson($request, 'DELETE /models/{model}', function () use ($request, $admin, $model, $mutations): JsonResponse {
            try {
                $result = $mutations->delete($admin, $model);
            } catch (ModelNotFoundException) {
                throw new ApiException('model_not_found', '模型不存在或当前管理员无权删除', 404);
            }
            if (! $result->succeeded()) {
                throw new ApiException('model_in_use', '模型仍被任务或工作流引用，不能删除', 409, ['dependency_count' => $result->dependencyCount, 'dependency_type' => $result->error]);
            }

            return $this->success($request, ['deleted' => true, 'model_id' => $model]);
        });
    }

    public function testModel(Request $request, int $model, AiModelController $legacy): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        $request->attributes->set('api_execution_admin', $admin);
        $legacyResponse = $legacy->testConnection($request, $model);
        $body = json_decode((string) $legacyResponse->getContent(), true);
        $body = is_array($body) ? $body : [];
        if (($body['success'] ?? false) !== true) {
            return ApiResponse::error('model_test_failed', (string) ($body['message'] ?? '模型连接测试失败'), $this->requestId($request), $legacyResponse->getStatusCode(), (array) ($body['meta'] ?? []));
        }

        return $this->success($request, ['model_id' => $model, 'message' => (string) ($body['message'] ?? '连接测试成功'), 'result' => (array) ($body['meta'] ?? [])]);
    }

    public function prompt(Request $request, int $prompt): JsonResponse
    {
        $this->executionAdmin($request);

        return $this->success($request, ['prompt' => $this->promptProjection($this->findPrompt($prompt))]);
    }

    public function storePrompt(Request $request, ArticleAiQualityPromptRenderer $renderer): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->executionAdmin($request);
        $payload = $this->validatePromptPayload($request, true);

        return IdempotencyService::executeJson($request, 'POST /prompts', function () use ($request, $payload, $renderer): JsonResponse {
            $this->validatePromptTemplate($payload['type'], $payload['content'], $renderer);
            $prompt = Prompt::query()->create([
                'name' => trim((string) $payload['name']),
                'type' => $payload['type'],
                'content' => trim((string) $payload['content']),
                'variables' => null,
                'system_key' => null,
                'system_version' => null,
            ]);

            return $this->success($request, ['prompt' => $this->promptProjection($prompt)], 201);
        });
    }

    public function updatePrompt(
        Request $request,
        int $prompt,
        ArticleAiQualityPromptRenderer $renderer,
        ArticleAiQualityInvalidationService $qualityInvalidation,
    ): JsonResponse {
        $this->requireIdempotencyKey($request);
        $this->executionAdmin($request);
        $payload = $this->validatePromptPayload($request, false);

        return IdempotencyService::executeJson($request, 'PATCH /prompts/{prompt}', function () use ($request, $prompt, $payload, $renderer, $qualityInvalidation): JsonResponse {
            $record = $this->findPrompt($prompt);
            if (filled($record->system_key)) {
                throw new ApiException('prompt_read_only', '系统内置提示词为只读，不能修改', 409);
            }
            $this->validatePromptTemplate((string) $record->type, $payload['content'], $renderer);
            $record->forceFill(['name' => trim((string) $payload['name']), 'content' => trim((string) $payload['content'])])->save();

            // 质检方案一改，用旧方案得出的结论就不再可追溯到产生它的规则版本。
            // 旧后台一直这么做，api/v1 这条写路径此前漏了——两条路径必须一致。
            if ((string) $record->type === 'quality_check') {
                $qualityInvalidation->invalidatePrompt((int) $record->getKey(), 'AI 质检方案已更新');
            }

            return $this->success($request, ['prompt' => $this->promptProjection($record->fresh())]);
        });
    }

    public function destroyPrompt(Request $request, int $prompt): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->executionAdmin($request);

        return IdempotencyService::executeJson($request, 'DELETE /prompts/{prompt}', function () use ($request, $prompt): JsonResponse {
            $record = $this->findPrompt($prompt);
            if (filled($record->system_key)) {
                throw new ApiException('prompt_read_only', '系统内置提示词为只读，不能删除', 409);
            }
            $count = $record->tasks()->withTrashed()->count() + $record->qualityTasks()->withTrashed()->count();
            if ($count > 0) {
                throw new ApiException('prompt_in_use', '提示词仍被任务引用，不能删除', 409, ['dependency_count' => $count]);
            }
            $record->delete();

            return $this->success($request, ['deleted' => true, 'prompt_id' => $prompt]);
        });
    }

    public function setDefault(Request $request, int $model, AdminAiModelAccessResolver $accessResolver, AdminAiSettingsService $settingsService): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        $selected = $accessResolver->usableQuery($admin)->whereKey($model)->first();
        if (! $selected instanceof AiModel) {
            throw new ApiException('model_not_found', '模型不存在或当前管理员无权使用', 404);
        }
        if (trim((string) $selected->model_type) === 'embedding') {
            throw new ApiException('model_type_not_allowed', 'Embedding 模型不能设为默认生成模型', 422);
        }

        return IdempotencyService::executeJson($request, 'POST /models/{model}/default', function () use ($request, $admin, $selected, $settingsService, $accessResolver): JsonResponse {
            $current = AdminAiSetting::query()->where('admin_id', $admin->id)->first();
            $embedding = null;
            if ($current?->default_embedding_model_id) {
                $embedding = $accessResolver->usableQuery($admin)
                    ->whereKey((int) $current->default_embedding_model_id)
                    ->where('model_type', 'embedding')
                    ->first();
            }
            $settings = $settingsService->setDefaults($admin, $selected, $embedding, $admin);

            return $this->success($request, [
                'default_chat_model_id' => $settings->default_chat_model_id !== null ? (int) $settings->default_chat_model_id : null,
                'default_embedding_model_id' => $settings->default_embedding_model_id !== null ? (int) $settings->default_embedding_model_id : null,
                'model' => [
                    'id' => (int) $selected->id,
                    'name' => (string) $selected->name,
                    'model_type' => trim((string) $selected->model_type) ?: 'chat',
                    'is_default' => true,
                ],
            ]);
        });
    }

    /**
     * 一次性设置本人的默认对话模型与默认 embedding 模型（旧后台 personal-defaults）。
     *
     * 与 `models/{model}/default` 的区别：那条只改 chat、embedding 保持不动；
     * 这条两个槽位一起决定。
     *
     * **字段缺省与显式传 0 不等价**：缺省表示「保持现状」，传 0 表示「清空」。
     * 旧后台的表单每次都会提交两个字段，所以真实调用方看到的行为与旧页面一致；
     * 这样区分是为了不让漏传一个字段悄悄清掉另一个默认值。
     */
    public function setPersonalDefaults(Request $request, AdminAiModelAccessResolver $accessResolver, AdminAiSettingsService $settingsService): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        $payload = $request->validate([
            'default_chat_model_id' => ['nullable', 'integer', 'min:0'],
            'default_embedding_model_id' => ['nullable', 'integer', 'min:0'],
        ]);

        return IdempotencyService::executeJson($request, 'POST /models/defaults', function () use ($request, $admin, $payload, $accessResolver, $settingsService): JsonResponse {
            $current = AdminAiSetting::query()->where('admin_id', $admin->id)->first();
            $chat = $this->resolvePersonalDefault($accessResolver, $admin, $payload, 'default_chat_model_id', $current?->default_chat_model_id, 'chat');
            $embedding = $this->resolvePersonalDefault($accessResolver, $admin, $payload, 'default_embedding_model_id', $current?->default_embedding_model_id, 'embedding');

            $settings = $settingsService->setDefaults($admin, $chat, $embedding, $admin);

            return $this->success($request, [
                'default_chat_model_id' => $settings->default_chat_model_id !== null ? (int) $settings->default_chat_model_id : null,
                'default_embedding_model_id' => $settings->default_embedding_model_id !== null ? (int) $settings->default_embedding_model_id : null,
            ]);
        });
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    private function resolvePersonalDefault(
        AdminAiModelAccessResolver $accessResolver,
        Admin $admin,
        array $payload,
        string $field,
        ?int $currentId,
        string $expectedType,
    ): ?AiModel {
        $modelId = array_key_exists($field, $payload)
            ? max(0, (int) ($payload[$field] ?? 0))
            : max(0, (int) ($currentId ?? 0));
        if ($modelId === 0) {
            return null;
        }

        $model = $accessResolver->usableQuery($admin)->whereKey($modelId)->first();
        if (! $model instanceof AiModel) {
            throw new ApiException('model_not_found', '模型不存在或当前管理员无权使用', 404);
        }
        $actualType = trim((string) $model->model_type) ?: 'chat';
        if ($actualType !== $expectedType) {
            throw new ApiException(
                'model_type_not_allowed',
                $expectedType === 'chat' ? '该模型不是对话模型，不能设为默认生成模型' : '该模型不是 Embedding 模型，不能设为默认向量模型',
                422,
            );
        }

        return $model;
    }

    /**
     * 复制一条提示词为可编辑副本。
     *
     * 这是改**系统内置提示词**的唯一途径：内置条目带 `system_key`，`PATCH`/`DELETE`
     * 都按只读拒绝（409 `prompt_read_only`），只能复制成一条自由条目再改
     * （旧后台 `ai-prompts/{id}/copy` 就是这个用途）。副本必须清掉
     * `system_key`/`system_version`，否则它仍然「像系统条目」——见
     * {@see AdminAiPromptService}。
     */
    public function copyPrompt(Request $request, int $prompt, AdminAiPromptService $prompts): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->executionAdmin($request);

        return IdempotencyService::executeJson($request, 'POST /prompts/{prompt}/copy', function () use ($request, $prompt, $prompts): JsonResponse {
            $source = Prompt::query()
                ->whereKey($prompt)
                ->whereIn('type', AdminAiPromptService::COPYABLE_TYPES)
                ->first();
            if (! $source instanceof Prompt) {
                throw new ApiException('prompt_not_found', '提示词不存在或不可复制', 404);
            }

            return $this->success($request, ['prompt' => $this->promptProjection($prompts->copy($source))], 201);
        });
    }

    /**
     * AI 配置器的概览计数（旧后台 `ai-configurator` 页顶部那几个数字）。
     *
     * 与旧页面同一份计算（{@see AdminAiConfiguratorOverviewService}），**不是新指标**——
     * 退役后这些监测数字不该消失。
     *
     * 三个超管专属计数在非超管视角下返回 **null 而不是 0**：0 会被读成
     * 「没有可用的搜索来源」「没有失败的可见度运行」，而真相是「你没权限看」。
     * 旧 Blade 页面对非超管也显示 0，那是页面自己的取舍；API 这边按本项目的口径
     * 如实区分「无权限」与「真的是零」。
     */
    public function overview(Request $request, AdminAiConfiguratorOverviewService $overview): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $stats = $overview->stats($admin);

        if (! $admin->isSuperAdmin()) {
            foreach (AdminAiConfiguratorOverviewService::superAdminOnlyKeys() as $key) {
                $stats[$key] = null;
            }
        }

        return $this->success($request, ['stats' => $stats]);
    }

    public function prompts(Request $request): JsonResponse
    {
        $this->executionAdmin($request);
        $items = Prompt::query()
            ->whereIn('type', ['content', 'quality_check'])
            // User-editable prompts are more useful at the top of the React
            // settings view; system-managed prompts remain visible below.
            ->orderByRaw('CASE WHEN system_key IS NULL OR system_key = \'\' THEN 0 ELSE 1 END')
            ->orderByDesc('created_at')
            ->orderBy('type')
            ->orderBy('name')
            ->get(['id', 'name', 'type', 'content', 'system_key', 'system_version', 'variables', 'created_at', 'updated_at'])
            ->map(static fn (Prompt $prompt): array => [
                'id' => (int) $prompt->id,
                'name' => (string) $prompt->name,
                'type' => (string) $prompt->type,
                'content' => (string) ($prompt->content ?? ''),
                'system_key' => $prompt->system_key,
                'system_version' => $prompt->system_version,
                'variables' => $prompt->variables,
                'created_at' => $prompt->created_at?->toIso8601String(),
                'updated_at' => $prompt->updated_at?->toIso8601String(),
            ])
            ->values()
            ->all();

        return $this->success($request, ['items' => $items]);
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }

    private function safeModelId(string $modelId): string
    {
        $trimmed = trim($modelId);
        if ($trimmed === '' || preg_match('/(sk-|AIza|secret|token|key)/i', $trimmed) === 1) {
            return '';
        }

        return $trimmed;
    }

    /** @return array<string,mixed> */
    private function validateModelPayload(Request $request, bool $creating): array
    {
        $rules = [
            'name' => [$creating ? 'required' : 'sometimes', 'string', 'max:120'],
            'version' => ['nullable', 'string', 'max:120'],
            'model_id' => [$creating ? 'required' : 'sometimes', 'string', 'max:255'],
            'model_type' => [$creating ? 'required' : 'sometimes', 'string', 'in:chat,embedding'],
            'api_url' => [$creating ? 'required' : 'sometimes', 'url:http,https', 'max:500'],
            'api_key' => [$creating ? 'required' : 'nullable', 'string', 'max:4096'],
            'failover_priority' => ['nullable', 'integer', 'min:1', 'max:100000'],
            'daily_limit' => ['nullable', 'integer', 'min:0', 'max:100000000'],
            'max_tokens' => ['nullable', 'integer', 'min:1', 'max:1000000'],
            'status' => ['nullable', 'string', 'in:active,inactive'],
            'access_scope' => ['nullable', 'string', 'in:user_content,system_only'],
        ];
        $payload = $request->validate($rules);
        if ($creating && trim((string) ($payload['api_key'] ?? '')) === '') {
            throw ValidationException::withMessages(['api_key' => '创建模型必须提供 API Key']);
        }
        if (array_key_exists('name', $payload)) {
            $payload['name'] = trim((string) $payload['name']);
        }
        if (array_key_exists('api_url', $payload)) {
            $payload['api_url'] = rtrim(trim((string) $payload['api_url']), '/');
        }
        if ($creating) {
            $payload['status'] = (string) ($payload['status'] ?? 'active');
            $payload['access_scope'] = (string) ($payload['access_scope'] ?? AiModel::ACCESS_SCOPE_USER_CONTENT);
        }
        if ($creating || array_key_exists('failover_priority', $payload)) {
            $payload['failover_priority'] = max(1, (int) ($payload['failover_priority'] ?? 100));
        }
        if ($creating || array_key_exists('daily_limit', $payload)) {
            $payload['daily_limit'] = max(0, (int) ($payload['daily_limit'] ?? 0));
        }

        return $payload;
    }

    /** @return array<string,mixed> */
    private function managedProjection(AiModel $model): array
    {
        return [
            'id' => (int) $model->id, 'name' => (string) $model->name,
            'version' => (string) ($model->version ?? ''), 'model_id' => $this->safeModelId((string) $model->model_id),
            'model_type' => (string) ($model->model_type ?: 'chat'), 'api_url' => (string) ($model->api_url ?? ''),
            'status' => (string) ($model->status ?? 'active'), 'failover_priority' => (int) ($model->failover_priority ?? 100),
            'daily_limit' => (int) ($model->daily_limit ?? 0), 'max_tokens' => $model->max_tokens !== null ? (int) $model->max_tokens : null,
            'api_key_configured' => trim((string) ($model->getRawOriginal('api_key') ?? '')) !== '',
            'access_scope' => (string) ($model->access_scope ?? AiModel::ACCESS_SCOPE_USER_CONTENT),
        ];
    }

    /** @return array<string,mixed> */
    private function validatePromptPayload(Request $request, bool $creating): array
    {
        return $request->validate([
            'name' => ['required', 'string', 'max:100'],
            'type' => [$creating ? 'required' : 'nullable', 'string', 'in:content,quality_check'],
            'content' => ['required', 'string', 'max:200000'],
        ]);
    }

    private function validatePromptTemplate(string $type, string $content, ArticleAiQualityPromptRenderer $renderer): void
    {
        if ($type !== 'quality_check') {
            return;
        }
        try {
            $renderer->render($content, array_fill_keys(['article_title', 'article_excerpt', 'article_outline', 'article_content', 'keywords', 'meta_description', 'fact_candidates', 'knowledge', 'advertising_rules', 'inspection_date', 'publication_context', 'segment_index', 'segment_count', 'segment_start_offset'], 'sample'));
        } catch (\Throwable $exception) {
            throw new ApiException('prompt_template_invalid', '质检提示词包含未知变量或模板格式无效', 422, ['reason' => $exception->getMessage()]);
        }
    }

    private function findPrompt(int $id): Prompt
    {
        $prompt = Prompt::query()->whereKey($id)->whereIn('type', ['content', 'quality_check'])->first();
        if (! $prompt instanceof Prompt) {
            throw new ApiException('prompt_not_found', '提示词不存在', 404);
        }

        return $prompt;
    }

    /** @return array<string,mixed> */
    private function promptProjection(Prompt $prompt): array
    {
        return ['id' => (int) $prompt->id, 'name' => (string) $prompt->name, 'type' => (string) $prompt->type, 'content' => (string) ($prompt->content ?? ''), 'system_key' => $prompt->system_key, 'system_version' => $prompt->system_version, 'variables' => $prompt->variables, 'system_managed' => filled($prompt->system_key), 'created_at' => $prompt->created_at?->toIso8601String(), 'updated_at' => $prompt->updated_at?->toIso8601String()];
    }
}
