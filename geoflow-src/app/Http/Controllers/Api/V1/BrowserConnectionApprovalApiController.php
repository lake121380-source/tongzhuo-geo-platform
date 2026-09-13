<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Services\BrowserOperations\DeviceAuthorizationService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Bearer 版的浏览器插件连接流程。
 *
 * 插件侧（`browser-operations/*`）自己申请配对码；这里补的是**运营方这一侧**：
 * 看到待批准的配对请求、并做出批准/拒绝的决定。判定逻辑完全复用
 * {@see DeviceAuthorizationService}——包括配对码过期与并发决策的锁。
 */
final class BrowserConnectionApprovalApiController extends BaseApiController
{
    /** 查询某个配对码当前的授权状态（供后台展示「插件正在请求连接」）。 */
    public function show(Request $request, DeviceAuthorizationService $authorizations): JsonResponse
    {
        $this->executionAdmin($request);
        $payload = $request->validate([
            'user_code' => ['required', 'string', 'max:16'],
        ]);

        $userCode = (string) $payload['user_code'];
        $record = $authorizations->findByUserCode($userCode);

        return $this->success($request, [
            'user_code' => $userCode,
            // null 表示「没有这个待批请求」或「已过期」——两者对运营方是同一件事：
            // 让他在插件里重新申请，而不是给一个含糊的空对象。
            'authorization' => $record === null ? null : [
                'status' => (string) ($record['status'] ?? 'pending'),
                'expires_at' => isset($record['expires_at']) ? (int) $record['expires_at'] : null,
                'client_name' => (string) ($record['client_name'] ?? ''),
                'requested_at' => isset($record['created_at']) ? (int) $record['created_at'] : null,
            ],
        ]);
    }

    /** 批准或拒绝一个配对待批请求。 */
    public function decision(Request $request, DeviceAuthorizationService $authorizations): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        $payload = $request->validate([
            'user_code' => ['required', 'string', 'max:16'],
            'decision' => ['required', Rule::in(['approve', 'deny'])],
        ]);

        // 配对码失效/重复决策由服务抛 ApiException，直接走 api/v1 错误信封。
        $authorizations->decide(
            (string) $payload['user_code'],
            $admin,
            (string) $payload['decision'] === 'approve',
        );

        return $this->success($request, [
            'user_code' => (string) $payload['user_code'],
            'decision' => (string) $payload['decision'],
        ]);
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }
}
