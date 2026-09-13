<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Models\AiSourceProvider;
use App\Services\Admin\AdminAiSourceProviderService;
use App\Services\Admin\AiSourceProviderProbeService;
use App\Services\Api\IdempotencyService;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Throwable;

/**
 * API v1 source-provider configuration.
 *
 * Source providers are system-wide AI-visibility dependencies. Every action
 * therefore retains the existing super-admin service boundary and never
 * returns an API key or its masked representation to the React client.
 */
final class AiSourceProviderApiController extends BaseApiController
{
    public function index(Request $request, AdminAiSourceProviderService $providers): JsonResponse
    {
        $this->superAdmin($request, $providers);

        $items = AiSourceProvider::query()
            ->withCount('visibilityRuns')
            ->orderByDesc('created_at')
            ->get()
            ->map(fn (AiSourceProvider $provider): array => $this->projection($provider))
            ->values()
            ->all();

        return $this->success($request, ['items' => $items]);
    }

    public function store(Request $request, AdminAiSourceProviderService $providers): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->superAdmin($request, $providers);
        $payload = $this->validatedPayload($request, true);

        return IdempotencyService::executeJson($request, 'POST /source-providers', function () use ($request, $providers, $admin, $payload): JsonResponse {
            $provider = $providers->createProvider($admin, $payload);

            return $this->success($request, ['provider' => $this->projection($provider)], 201);
        });
    }

    public function update(Request $request, int $provider, AdminAiSourceProviderService $providers): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->superAdmin($request, $providers);
        $payload = $this->validatedPayload($request, false);

        return IdempotencyService::executeJson($request, 'PATCH /source-providers/{provider}', function () use ($request, $providers, $admin, $provider, $payload): JsonResponse {
            try {
                $updated = $providers->updateProvider($admin, $provider, $payload);
            } catch (ModelNotFoundException) {
                throw new ApiException('source_provider_not_found', '来源 Provider 不存在', 404);
            }

            return $this->success($request, ['provider' => $this->projection($updated)]);
        });
    }

    public function destroy(Request $request, int $provider, AdminAiSourceProviderService $providers): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->superAdmin($request, $providers);

        return IdempotencyService::executeJson($request, 'DELETE /source-providers/{provider}', function () use ($request, $providers, $admin, $provider): JsonResponse {
            try {
                $providers->deleteProvider($admin, $provider);
            } catch (ModelNotFoundException) {
                throw new ApiException('source_provider_not_found', '来源 Provider 不存在', 404);
            }

            return $this->success($request, ['deleted' => true, 'provider_id' => $provider]);
        });
    }

    /**
     * 真实探活：按当前配置出站调一次搜索接口。
     *
     * 旧后台一直有这个按钮，退役后运营方就没有别的办法知道搜索 Provider 还能不能用
     * ——只能等可见度运行失败才发现。探活**会消耗一次额度**，所以按写操作处理
     * （幂等键 + 超管边界），不是只读接口。
     */
    public function test(
        Request $request,
        int $provider,
        AdminAiSourceProviderService $providers,
        AiSourceProviderProbeService $probes,
    ): JsonResponse {
        $this->requireIdempotencyKey($request);
        $admin = $this->superAdmin($request, $providers);
        $payload = $request->validate(['query' => ['nullable', 'string', 'max:200']]);

        return IdempotencyService::executeJson($request, 'POST /source-providers/{provider}/test', function () use ($request, $admin, $provider, $payload, $probes): JsonResponse {
            try {
                $result = $probes->probeProvider($admin, $provider, (string) ($payload['query'] ?? ''));
            } catch (ModelNotFoundException) {
                throw new ApiException('source_provider_not_found', '来源 Provider 不存在', 404);
            } catch (Throwable $exception) {
                throw $this->probeFailure($exception, '探活失败：来源 Provider 当前不可用');
            }

            return $this->success($request, [
                'source_count' => $result['source_count'],
                'latency_ms' => $result['latency_ms'],
            ]);
        });
    }

    /**
     * 当前可见度分析模型的绑定与 API 配置。
     *
     * 这是「可见度引擎到底用哪条模型」的唯一读法。`bindings` 里 0 表示没绑或绑定已失效，
     * 两种情况对调用方是同一个动作：重绑。
     */
    public function bindings(Request $request, AdminAiSourceProviderService $providers): JsonResponse
    {
        $admin = $this->superAdmin($request, $providers);

        return $this->success($request, [
            'bindings' => $providers->bindingModelIds($admin),
            'candidates' => $providers->bindingModelCandidates($admin),
            'api' => [
                'ark' => $this->bindingApiProjection($providers->bindingApiConfig($admin, 'ark')),
                'deepseek' => $this->bindingApiProjection($providers->bindingApiConfig($admin, 'deepseek')),
            ],
        ]);
    }

    /** 切换可见度分析模型（ark / deepseek 各一条）。 */
    public function updateBindings(Request $request, AdminAiSourceProviderService $providers): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->superAdmin($request, $providers);
        $payload = $request->validate([
            'ark_model_id' => ['nullable', 'integer', 'min:0'],
            'deepseek_model_id' => ['nullable', 'integer', 'min:0'],
        ]);

        return IdempotencyService::executeJson($request, 'POST /source-providers/model-bindings', function () use ($request, $providers, $admin, $payload): JsonResponse {
            // 校验失败由服务抛 ValidationException，走 api/v1 既有的
            // validation_failed + field_errors 信封，不在这里另造一套。
            $providers->updateModelBindings(
                $admin,
                (int) ($payload['ark_model_id'] ?? 0),
                (int) ($payload['deepseek_model_id'] ?? 0),
            );

            return $this->success($request, ['bindings' => $providers->bindingModelIds($admin)]);
        });
    }

    /** 写入某条绑定的 API 配置（域名策略、密钥、限额都在服务里校验）。 */
    public function saveModelApi(Request $request, AdminAiSourceProviderService $providers): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->superAdmin($request, $providers);
        $payload = $request->validate([
            'binding_type' => ['required', 'in:ark,deepseek'],
            'name' => ['required', 'string', 'max:100'],
            'model_id' => ['required', 'string', 'max:100'],
            'api_url' => ['required', 'url', 'max:500'],
            'api_key' => ['nullable', 'string', 'max:500'],
            'daily_limit' => ['nullable', 'integer', 'min:0'],
            'max_tokens' => ['nullable', 'integer', 'min:1', 'max:1000000'],
        ]);

        return IdempotencyService::executeJson($request, 'POST /source-providers/model-api', function () use ($request, $providers, $admin, $payload): JsonResponse {
            $model = $providers->upsertModelApi($admin, $payload);

            return $this->success($request, [
                'binding_type' => (string) $payload['binding_type'],
                'model_row_id' => (int) $model->getKey(),
                'api' => $this->bindingApiProjection($providers->bindingApiConfig($admin, (string) $payload['binding_type'])),
            ]);
        });
    }

    /**
     * 探活一条可见度分析模型的绑定。
     *
     * 与 `test` 同一个探活服务、同一套额度与就绪度记账；`workspace_readiness`
     * 是 `-AI` 可见度页面判断「能不能跑」的依据。
     */
    public function testBinding(
        Request $request,
        AdminAiSourceProviderService $providers,
        AiSourceProviderProbeService $probes,
    ): JsonResponse {
        $this->requireIdempotencyKey($request);
        $admin = $this->superAdmin($request, $providers);
        $payload = $request->validate([
            'binding_type' => ['required', 'in:ark,deepseek'],
            'model_id' => ['required', 'integer', 'min:1'],
        ]);

        return IdempotencyService::executeJson($request, 'POST /source-providers/model-bindings/test', function () use ($request, $admin, $payload, $probes): JsonResponse {
            try {
                $result = $probes->probeModelBinding(
                    $admin,
                    (int) $payload['model_id'],
                    (string) $payload['binding_type'],
                );
            } catch (ModelNotFoundException) {
                throw new ApiException('ai_model_not_found', '模型不存在', 404);
            } catch (Throwable $exception) {
                throw $this->probeFailure($exception);
            }

            return $this->success($request, [
                'workspace_readiness' => $result['workspace_readiness'],
                'workspace_readiness_expires_at' => $result['workspace_readiness_expires_at'],
            ]);
        });
    }

    /**
     * 探活失败的对外形状。
     *
     * 已知原因码原样透出（前端按码分支），并且**只给一句产品语言**——底层异常消息
     * 可能带 URL 或密钥片段，不能进响应。
     */
    private function probeFailure(Throwable $exception, string $message = '探活失败：模型当前不可用'): ApiException
    {
        $code = AiSourceProviderProbeService::errorCode($exception);
        $unauthorized = $code === 'ai_system_config_super_admin_only';

        return new ApiException(
            $code,
            $unauthorized ? '系统级配置仅超级管理员可改' : $message,
            $unauthorized ? 403 : 422,
        );
    }

    /**
     * 绑定 API 配置的对外投影。
     *
     * **白名单而不是黑名单**：`bindingApiConfig()` 里带 `masked_api_key`（旧 Blade 页要显示），
     * api/v1 的口径是「连掩码都不给」，只给一个 `api_key_configured` 布尔。
     *
     * @param  array<string, mixed>  $config
     * @return array<string, mixed>
     */
    private function bindingApiProjection(array $config): array
    {
        return [
            'bound' => (int) $config['id'] > 0,
            'model_row_id' => (int) $config['id'],
            'name' => (string) $config['name'],
            'model_id' => (string) $config['model_id'],
            'api_url' => (string) $config['api_url'],
            'daily_limit' => (int) $config['daily_limit'],
            'max_tokens' => $config['max_tokens'] !== null ? (int) $config['max_tokens'] : null,
            'api_key_configured' => (bool) $config['api_key_configured'],
        ];
    }

    /** @return array<string, mixed> */
    private function validatedPayload(Request $request, bool $creating): array
    {
        $payload = $request->validate([
            'name' => ['required', 'string', 'max:120'],
            'endpoint_url' => ['nullable', 'url:http,https', 'max:500'],
            'api_key' => [$creating ? 'required' : 'nullable', 'string', 'max:2000'],
            'daily_limit' => ['nullable', 'integer', 'min:0'],
            'count' => ['nullable', 'integer', 'min:1', 'max:20'],
            'search_type' => ['nullable', 'in:web'],
            'content_formats' => ['nullable', 'in:Markdown,Text'],
            'need_summary' => ['nullable', 'boolean'],
            'need_content' => ['nullable', 'boolean'],
            'need_url' => ['nullable', 'boolean'],
            'auth_info_level' => ['nullable', 'string', 'max:80'],
            'sites' => ['nullable', 'string', 'max:1000'],
            'block_hosts' => ['nullable', 'string', 'max:1000'],
            'status' => ['nullable', 'in:active,inactive'],
        ]);

        if ($creating && trim((string) ($payload['api_key'] ?? '')) === '') {
            throw new ApiException('source_provider_key_required', '创建来源 Provider 必须提供 API Key', 422);
        }

        return $payload;
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }

    private function superAdmin(Request $request, AdminAiSourceProviderService $providers): Admin
    {
        return $providers->activeSuperAdmin($this->executionAdmin($request));
    }

    /** @return array<string, mixed> */
    private function projection(AiSourceProvider $provider): array
    {
        $metadata = is_array($provider->metadata_json) ? $provider->metadata_json : [];

        return [
            'id' => (int) $provider->id,
            'name' => (string) $provider->name,
            'provider_key' => (string) $provider->provider_key,
            'endpoint_url' => (string) ($provider->endpoint_url ?? ''),
            'status' => (string) ($provider->status ?? 'inactive'),
            'api_key_configured' => trim((string) $provider->getRawOriginal('api_key')) !== '',
            'daily_limit' => (int) ($provider->daily_limit ?? 0),
            'used_today' => $provider->usage_date?->toDateString() === now()->toDateString() ? (int) ($provider->used_today ?? 0) : 0,
            'total_used' => (int) ($provider->total_used ?? 0),
            'visibility_runs_count' => (int) ($provider->visibility_runs_count ?? 0),
            'options' => $provider->visibilitySearchOptions(),
            'created_at' => $provider->created_at?->toIso8601String(),
            'updated_at' => $provider->updated_at?->toIso8601String(),
        ];
    }
}
