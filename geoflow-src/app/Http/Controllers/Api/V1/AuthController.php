<?php

namespace App\Http\Controllers\Api\V1;

use App\Services\Api\ApiAdminAuthService;
use App\Services\Api\ApiTokenService;
use App\Support\AdminActivityLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * API v1 认证：管理员账号登录并签发 API Token。
 *
 * 无需 Bearer；成功返回 token、过期时间与 admin 摘要，与遗留 ApiAdminAuthService 行为对齐。
 */
class AuthController extends BaseApiController
{
    /**
     * 使用用户名密码登录，创建带全量 scope 的 API Token 并更新管理员 last_login。
     *
     * 请求体：username、password（JSON）。错误时抛出/映射为 401 或 422。
     */
    public function login(Request $request, ApiAdminAuthService $adminAuth): JsonResponse
    {
        $body = $request->all();

        return $this->success($request, $adminAuth->login(
            trim((string) ($body['username'] ?? '')),
            (string) ($body['password'] ?? ''),
            (string) ($request->ip() ?? ''),
            trim((string) ($request->userAgent() ?? ''))
        ));
    }

    public function logout(Request $request, ApiTokenService $tokens): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $tokenId = (int) ($this->auth($request)->token['id'] ?? 0);

        AdminActivityLogger::log($admin, 'api.auth.logout', [
            'request_method' => 'POST',
            'page' => 'auth/logout',
            'target_type' => 'personal_access_token',
            'target_id' => $tokenId,
            'ip_address' => (string) ($request->ip() ?? ''),
            'details' => ['token_id' => $tokenId],
        ]);
        $tokens->revokeToken($tokenId);

        return $this->success($request, [
            'logged_out' => true,
            'token_revoked' => true,
        ]);
    }
}
