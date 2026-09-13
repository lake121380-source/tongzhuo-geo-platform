<?php

namespace App\Http\Middleware;

use App\Http\ApiAuthContext;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

class AssignApiRequestId
{
    public function handle(Request $request, Closure $next): Response
    {
        $header = $request->header('X-Request-Id');
        $id = is_string($header)
            && preg_match('/^[A-Za-z0-9._:-]{1,128}$/', trim($header)) === 1
            ? mb_substr(trim($header), 0, 128)
            : (string) Str::uuid();

        $request->attributes->set('request_id', $id);

        /** @var Response $response */
        $response = $next($request);
        $response->headers->set('X-Request-Id', $id);
        if ($response->getStatusCode() === 403) {
            $this->logForbidden($request, $id);
        }

        return $response;
    }

    /**
     * 403 越权尝试的审计。
     *
     * 2026-09-12 退役改指向：这条审计**原先只覆盖旧 Blade 后台**——判据是「请求落在
     * `geoflow.admin_base_path` 前缀下」。旧后台与那个配置项都已删除，而
     * **新接口的 403（scope / 超管校验）此前没有任何审计**；直接删掉判据，等于在清旧后台时
     * 顺手丢掉「管理员尝试越权」这条唯一信号。所以改判 `api/*`——它现在是唯一的后台面。
     *
     * 管理员身份从 `api_auth`（由 `AuthenticateApiToken` 写入）取：本中间件在 `api.auth`
     * **之前**执行，但这里看的是 `$next()` 之后的响应，那时鉴权已经跑完。
     */
    private function logForbidden(Request $request, string $requestId): void
    {
        if (! $request->is('api/*')) {
            return;
        }

        $context = $request->attributes->get('api_auth');

        Log::warning('geoflow.admin_forbidden', [
            'request_id' => $requestId,
            'admin_id' => $context instanceof ApiAuthContext ? $context->auditAdminId : 0,
            'method' => $request->method(),
            'route' => (string) ($request->route()?->getName() ?? ''),
            'path' => $request->path(),
            'ip' => $request->ip(),
        ]);
    }
}
