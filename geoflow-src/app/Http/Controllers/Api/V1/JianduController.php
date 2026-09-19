<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Services\Api\IdempotencyService;
use App\Services\Jiandu\JianduApiClient;
use App\Services\Jiandu\JianduConnectionService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * 「见度检测」——把见度GEO 检测系统的数据接进本后台。
 *
 * 交互模型（对应用户的操作顺序）：
 *  1. `POST /jiandu/session` 输入见度账号密码换取连接（可能回
 *     `requires_verification`，走 `session/send-code` 发码后带 `verify_code` 重试）；
 *  2. `GET /jiandu/projects|overview|detections` 用连接拉数据；
 *  3. `DELETE /jiandu/session` 断开。
 *
 * 凭据、出站请求与错误翻译全部落在 App\Services\Jiandu\*（前端永远不接触
 * 见度 token，也不直连见度）。所有响应带 `source` 标注——页面上的数字来自
 * 见度系统而非本库，这一点必须在 UI 上如实呈现。
 */
final class JianduController extends BaseApiController
{
    public function __construct(
        private readonly JianduConnectionService $connections,
        private readonly JianduApiClient $client,
    ) {}

    /** 当前连接状态（未连接时 connection 为 null）。 */
    public function status(Request $request): JsonResponse
    {
        $this->executionAdmin($request);

        return $this->success($request, ['connection' => $this->connections->status()]);
    }

    /**
     * 建立连接（账号密码换见度服务端会话）。
     *
     * 成功 201；需要新设备验证码时 200 + `requires_verification: true`（这是流程
     * 中间态，不是错误——与见度侧同一语义）。
     */
    public function storeSession(Request $request): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        $payload = $request->validate([
            'account' => ['required', 'string', 'max:190'],
            'password' => ['required', 'string', 'max:190'],
            'verify_code' => ['nullable', 'string', 'max:12'],
        ]);

        return IdempotencyService::executeJson($request, 'POST /jiandu/session', function () use ($admin, $payload, $request): JsonResponse {
            $result = $this->connections->connect(
                $admin,
                (string) $payload['account'],
                (string) $payload['password'],
                isset($payload['verify_code']) ? (string) $payload['verify_code'] : null,
            );

            if (($result['status'] ?? '') === 'verification_required') {
                return $this->success($request, [
                    'requires_verification' => true,
                    'channel' => (string) ($result['channel'] ?? 'email'),
                    'message' => (string) ($result['message'] ?? ''),
                    'connection' => null,
                ]);
            }

            return $this->success($request, [
                'requires_verification' => false,
                'channel' => null,
                'message' => '',
                'connection' => $result['connection'] ?? null,
            ], 201);
        });
    }

    /** 触发新设备验证码（转发见度发码端点；见度侧自带 60 秒冷却）。 */
    public function sendCode(Request $request): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->executionAdmin($request);
        $payload = $request->validate([
            'channel' => ['required', Rule::in(['sms', 'email'])],
            'account' => ['required', 'string', 'max:190'],
        ]);

        // 发码有真实成本（短信按条计费），用 executeExternalJson：dispatch 开始后
        // 失败不删预留——同键重试 fail closed，不会重复发一条。
        return IdempotencyService::executeExternalJson($request, 'POST /jiandu/session/send-code', function () use ($payload, $request): JsonResponse {
            $result = $this->connections->sendCode((string) $payload['channel'], (string) $payload['account']);

            return $this->success($request, [
                'sent' => true,
                'message' => is_string($result['message'] ?? null) && $result['message'] !== ''
                    ? (string) $result['message']
                    : '验证码已发送',
            ]);
        });
    }

    /** 断开连接（见度侧尽力吊销；重复调用幂等）。 */
    public function destroySession(Request $request): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->executionAdmin($request);

        return IdempotencyService::executeJson($request, 'DELETE /jiandu/session', function () use ($request): JsonResponse {
            $this->connections->disconnect();

            return $this->success($request, ['connection' => null]);
        });
    }

    /** 见度侧项目列表（投影：只给 id / 名称 / 品牌 / 行业）。 */
    public function projects(Request $request): JsonResponse
    {
        $this->executionAdmin($request);
        $projects = $this->connections->withFreshToken(
            fn (string $token): array => $this->client->fetchProjects($token),
        );

        return $this->success($request, [
            'source' => $this->sourceMeta(),
            'projects' => array_map(static fn (array $project): array => [
                'id' => (string) ($project['id'] ?? ''),
                'name' => (string) ($project['name'] ?? ''),
                'brand_name' => (string) ($project['brandName'] ?? ''),
                'industry' => (string) ($project['industry'] ?? ''),
            ], $projects),
        ]);
    }

    /** 概览指标（提及率等；原样透传见度的 overview，另附来源标注）。 */
    public function overview(Request $request): JsonResponse
    {
        $this->executionAdmin($request);
        $payload = $request->validate([
            'project_id' => ['required', 'string', 'max:120'],
            'range' => ['nullable', Rule::in(['30d', '90d'])],
        ]);

        $overview = $this->connections->withFreshToken(
            fn (string $token): array => $this->client->fetchOverview(
                $token,
                (string) $payload['project_id'],
                (string) ($payload['range'] ?? '30d'),
            ),
        );

        return $this->success($request, [
            'source' => $this->sourceMeta(),
            'project_id' => (string) $payload['project_id'],
            'overview' => $overview,
        ]);
    }

    /** 检测批次列表。 */
    public function detections(Request $request): JsonResponse
    {
        $this->executionAdmin($request);
        $payload = $request->validate([
            'project_id' => ['required', 'string', 'max:120'],
            'page' => ['nullable', 'integer', 'min:1', 'max:1000'],
            'page_size' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $result = $this->connections->withFreshToken(
            fn (string $token): array => $this->client->fetchDetections(
                $token,
                (string) $payload['project_id'],
                (int) ($payload['page'] ?? 1),
                (int) ($payload['page_size'] ?? 20),
            ),
        );

        return $this->success($request, [
            'source' => $this->sourceMeta(),
            'project_id' => (string) $payload['project_id'],
            'detections' => $result,
        ]);
    }

    /**
     * 检测报告列表。
     *
     * 见度侧报告有**套餐特性门禁**：套餐不含时回 403 `feature_not_in_plan`，
     * 由 `JianduConnectionService::translate()` 翻成明确文案（「XX 不在当前套餐里」），
     * 前端把这一条呈现为该卡片的提示，而不是整页故障。
     */
    public function reports(Request $request): JsonResponse
    {
        $this->executionAdmin($request);
        $payload = $request->validate([
            'project_id' => ['required', 'string', 'max:120'],
            'page' => ['nullable', 'integer', 'min:1', 'max:1000'],
            'page_size' => ['nullable', 'integer', 'min:1', 'max:100'],
        ]);

        $result = $this->connections->withFreshToken(
            fn (string $token): array => $this->client->fetchReports(
                $token,
                (string) $payload['project_id'],
                (int) ($payload['page'] ?? 1),
                (int) ($payload['page_size'] ?? 10),
            ),
        );

        return $this->success($request, [
            'source' => $this->sourceMeta(),
            'project_id' => (string) $payload['project_id'],
            'reports' => $result,
        ]);
    }

    /**
     * 见度侧账号/套餐/额度（连接信息条用它显示「专业版 · 本月 3/300 次 · 积分 1200」）。
     *
     * `key` 字段是给 API Key 语境准备的（会话调用时恒为 null），不透传——本页面
     * 永远不接触凭据，包括这种「本来就是空」的字段也一并不给，省得将来误用。
     */
    public function me(Request $request): JsonResponse
    {
        $this->executionAdmin($request);
        $account = $this->connections->withFreshToken(
            fn (string $token): array => $this->client->fetchMe($token),
        );
        unset($account['key']);

        return $this->success($request, [
            'source' => $this->sourceMeta(),
            'account' => $account,
        ]);
    }

    /**
     * 数据来源标注：这批数字来自见度系统（实时拉取），不是本库自有数据。
     * 前端据此在页面上如实注明来源——两套系统的口径不同，混在一起说会误导。
     *
     * @return array<string, string>
     */
    private function sourceMeta(): array
    {
        return [
            'kind' => 'jiandu_api',
            'system' => '见度GEO',
            'fetched_at' => now()->toIso8601String(),
        ];
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }
}
