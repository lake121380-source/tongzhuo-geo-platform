<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Services\Admin\AdminAiSystemSettingsService;
use App\Services\Api\IdempotencyService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Bearer 版的系统级 AI 配置：默认 embedding 模型与知识库切片策略。
 *
 * 这两项决定知识库向量化与切片用哪条模型，旧后台一直是超管专属开关；
 * api/v1 之前完全没有入口，退役后就只能停在部署值。
 *
 * 读写都委派 {@see AdminAiSystemSettingsService}——与旧后台页面同一份实现，
 * 因此「页面显示的当前值」与「切片实际用的值」不会分叉。**超管边界保留**：
 * 非超管读也读不到（旧页面的模型下拉本来就只对超管开放）。
 */
final class AiSystemSettingsApiController extends BaseApiController
{
    public function __construct(
        private readonly AdminAiSystemSettingsService $settings,
    ) {}

    /** 当前生效的切片策略、默认 embedding，以及可选的系统模型。 */
    public function show(Request $request): JsonResponse
    {
        $admin = $this->superAdmin($request);

        return $this->success($request, [
            'default_embedding_model_id' => $this->settings->defaultEmbeddingModelId(),
            'chunking' => $this->settings->chunkingConfig(),
            'strategies' => AdminAiSystemSettingsService::CHUNK_STRATEGIES,
            'options' => [
                'chat' => $this->settings->modelOptions($admin, 'chat'),
                'embedding' => $this->settings->modelOptions($admin, 'embedding'),
            ],
        ]);
    }

    /** 更新知识库切片策略与切片模型。 */
    public function updateChunking(Request $request): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->superAdmin($request);
        $payload = $request->validate([
            'knowledge_chunk_strategy' => ['required', Rule::in(AdminAiSystemSettingsService::CHUNK_STRATEGIES)],
            'knowledge_chunking_model_id' => ['nullable', 'integer', 'min:0'],
        ]);
        $strategy = (string) $payload['knowledge_chunk_strategy'];
        $modelId = max(0, (int) ($payload['knowledge_chunking_model_id'] ?? 0));

        return IdempotencyService::executeJson(
            $request,
            'POST /ai-system-settings/chunking',
            function () use ($request, $admin, $strategy, $modelId): JsonResponse {
                $this->settings->updateChunking($admin, $strategy, $modelId);

                // 回读而不是回显请求值：服务可能拒绝或回落，前端要看到真正生效的那份。
                return $this->success($request, ['chunking' => $this->settings->chunkingConfig()]);
            },
        );
    }

    /** 更新系统默认 embedding 模型（0 表示清空）。 */
    public function updateDefaultEmbedding(Request $request): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->superAdmin($request);
        $payload = $request->validate([
            'default_embedding_model_id' => ['nullable', 'integer', 'min:0'],
        ]);
        $modelId = max(0, (int) ($payload['default_embedding_model_id'] ?? 0));

        return IdempotencyService::executeJson(
            $request,
            'POST /ai-system-settings/default-embedding',
            function () use ($request, $admin, $modelId): JsonResponse {
                $this->settings->updateDefaultEmbedding($admin, $modelId);

                return $this->success($request, [
                    'default_embedding_model_id' => $this->settings->defaultEmbeddingModelId(),
                ]);
            },
        );
    }

    /**
     * 系统级配置的超管边界。
     *
     * 服务内部还会再判一次（`lockActiveSuperAdmin`）——那是给队列/命令等非 HTTP
     * 入口兜底的，这里这一层是为了给出统一的 api/v1 错误信封。
     */
    private function superAdmin(Request $request): Admin
    {
        $admin = $this->executionAdmin($request);
        if (! $admin->isSuperAdmin()) {
            throw new ApiException(
                'ai_system_config_super_admin_only',
                '系统级 AI 配置仅超级管理员可见可改',
                403,
            );
        }

        return $admin;
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }
}
