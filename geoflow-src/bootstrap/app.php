<?php

/**
 * Laravel 11 应用入口：路由、中间件别名、API 异常渲染为统一 JSON 信封。
 *
 * API 路由：`routes/api.php`（前缀 /api）；`ApiException` 在 api/* 请求下转为 {@see ApiResponse::error}。
 */

use App\Exceptions\ApiException;
use App\Http\Middleware\AssignApiRequestId;
use App\Http\Middleware\AuthenticateApiToken;
use App\Http\Middleware\EnforceCurrentSiteSurface;
use App\Http\Middleware\EnsureApiScope;
use App\Http\Middleware\EnsureBrowserOperationsProtocol;
use App\Http\Middleware\EnsureHostedSitesEnabled;
use App\Http\Middleware\LimitArticleMarkdownExportRequestSize;
use App\Http\Middleware\NormalizeRequestHost;
use App\Http\Middleware\RecordSiteViewLog;
use App\Http\Middleware\ResolveCurrentSite;
use App\Http\Middleware\SiteWebLocale;
use App\Support\ApiResponse;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\Exception\SuspiciousOperationException;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        channels: __DIR__.'/../routes/channels.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->prepend(LimitArticleMarkdownExportRequestSize::class);
        $middleware->trustHosts(static function (): array {
            $patterns = [];
            foreach (config('geoflow.hosted_sites.primary_hosts', []) as $hostname) {
                $patterns[] = '^'.preg_quote($hostname, '/').'$';
            }
            foreach (config('geoflow.hosted_sites.root_domains', []) as $rootDomain) {
                $patterns[] = '^[^.]+\\.'.preg_quote($rootDomain, '/').'$';
            }

            return $patterns;
        }, subdomains: false);
        $middleware->append([
            NormalizeRequestHost::class,
            ResolveCurrentSite::class,
            EnforceCurrentSiteSurface::class,
        ]);
        $middleware->appendToGroup('web', AssignApiRequestId::class);

        $middleware->alias([
            // 生成/透传 X-Request-Id，并写入响应头
            'api.request_id' => AssignApiRequestId::class,
            // Authorization: Bearer，解析 Sanctum token 并注入 ApiAuthContext
            'api.auth' => AuthenticateApiToken::class,
            // 校验 Token scopes，如 api.scope:catalog:read
            'api.scope' => EnsureApiScope::class,
            'browser.protocol' => EnsureBrowserOperationsProtocol::class,
            // 前台：固定 public_locale（默认 zh_CN）
            'site.locale' => SiteWebLocale::class,
            // 前台：保存访问日志，供数据分析模块统计 PV、路径和爬虫类型
            'site.view_log' => RecordSiteViewLog::class,
            'hosted-sites.enabled' => EnsureHostedSitesEnabled::class,
            // 2026-09-12 退役：原先还有六个 `admin.*` 别名（admin.auth / admin.locale / admin.super /
            // admin.activity / admin.recent / admin.ui-v3），它们只挂在已删除的 Blade 后台路由上。
            // 别名留着就会把对应中间件类拖成活代码，所以连同中间件一起删掉了。
        ]);

        // 2026-09-12 退役：原先这里把「已登录管理员访问登录页」重定向到 admin.dashboard，
        // 那条 Blade 登录路由已随退役删除，`route('admin.dashboard')` 会直接抛异常（潜在崩溃点）。
        // React 后台在 nginx 侧静态直出，不经过 Laravel 的 guest 中间件，所以整块删除、不替代。
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->dontFlash([
            'api_key',
            'package_password',
            'current_password',
            'current_admin_password',
            'updater_authorization_code',
            'new_password',
            'confirm_password',
            'keywords_text',
            'titles_text',
            'outputs',
        ]);

        // 2026-09-12 退役：原先这里有一条针对 `admin.ai-workspace.*` 路由名的专用错误渲染器
        // （把 AI 工作台的异常翻成它自己的 JSON 形状）。那批 Blade 路由已删除，没有任何路由
        // 会命中这个前缀，渲染器永远不会被触发——连同 `RenderAiWorkspaceJsonErrors` 一起删掉。
        // React 后台走 `/api/v1/ai-workspace/*`，异常由下面统一的 api/* 信封处理。

        $exceptions->render(function (ApiException $e, Request $request) {
            if (! $request->is('api/*')) {
                return null;
            }

            $rid = (string) ($request->attributes->get('request_id') ?? Str::uuid()->toString());

            return ApiResponse::error(
                $e->getErrorCode(),
                $e->getMessage(),
                $rid,
                $e->getHttpStatus(),
                $e->getDetails()
            )->withHeaders(['X-Request-Id' => $rid]);
        });

        // FormRequest/$request->validate() throws ValidationException.  API
        // v1 must keep that failure inside the same JSON envelope as the
        // controller-level ApiException paths instead of returning Laravel's
        // HTML/500 response to the React client.
        $exceptions->render(function (ValidationException $e, Request $request) {
            if (! $request->is('api/*')) {
                return null;
            }

            $rid = (string) ($request->attributes->get('request_id') ?? Str::uuid()->toString());
            $fieldErrors = collect($e->errors())
                ->map(static fn (array $messages): string => (string) ($messages[0] ?? '参数无效'))
                ->all();

            return ApiResponse::error(
                'validation_failed',
                '参数校验失败',
                $rid,
                422,
                ['field_errors' => $fieldErrors],
            )->withHeaders(['X-Request-Id' => $rid]);
        });

        // Policy/Gate denials must use the same JSON contract as scope
        // middleware denials. Without this, Laravel's default conversion to
        // AccessDeniedHttpException falls through to the generic 500 handler.
        $exceptions->render(function (Throwable $e, Request $request) {
            if (! $request->is('api/*')) {
                return null;
            }

            if (! $e instanceof AuthorizationException && ! $e instanceof AccessDeniedHttpException) {
                return null;
            }

            $rid = (string) ($request->attributes->get('request_id') ?? Str::uuid()->toString());

            return ApiResponse::error(
                'forbidden',
                '当前管理员没有执行此操作的权限',
                $rid,
                403,
            )->withHeaders(['X-Request-Id' => $rid]);
        });

        $exceptions->render(function (Throwable $e, Request $request) {
            if ($request->is('api/*')) {
                return null;
            }

            $hostRejected = $e instanceof SuspiciousOperationException
                || ($e instanceof BadRequestHttpException
                    && $e->getPrevious() instanceof SuspiciousOperationException);

            return $hostRejected
                ? response('', 404)->header('X-Robots-Tag', 'noindex, nofollow')
                : null;
        });

        // HttpException 系自带状态码（429 限流、400 坏请求…）。若不在这里放行，
        // 它们会掉进下面那条 `internal_error` 兜底、被渲染成 **500「服务器内部错误」**——
        // 客户端既拿不到 429、也就不会退避重试。AI 工作台从 Blade 端点
        // （有 `RenderAiWorkspaceJsonErrors` 专用渲染器）迁到 `api/v1` 后暴露出这个缺口。
        $exceptions->render(function (Throwable $e, Request $request) {
            if (! $request->is('api/*') || ! $e instanceof HttpExceptionInterface) {
                return null;
            }

            // host 校验失败要伪装成 404（见下面那条分支），别在这里提前接管成 400。
            if ($e instanceof BadRequestHttpException && $e->getPrevious() instanceof SuspiciousOperationException) {
                return null;
            }

            $status = $e->getStatusCode();
            $rid = (string) ($request->attributes->get('request_id') ?? Str::uuid()->toString());

            return ApiResponse::error(
                match ($status) {
                    429 => 'too_many_requests',
                    401 => 'unauthenticated',
                    403 => 'forbidden',
                    404 => 'not_found',
                    default => 'http_error',
                },
                $e->getMessage() !== '' ? $e->getMessage() : '请求无法完成',
                $rid,
                $status,
            )->withHeaders(['X-Request-Id' => $rid]);
        });

        $exceptions->render(function (Throwable $e, Request $request) {
            if (! $request->is('api/*') || $e instanceof ApiException) {
                return null;
            }

            $hostRejected = $e instanceof SuspiciousOperationException
                || ($e instanceof BadRequestHttpException
                    && $e->getPrevious() instanceof SuspiciousOperationException);
            if ($e instanceof NotFoundHttpException || $hostRejected) {
                $rid = (string) ($request->attributes->get('request_id') ?? Str::uuid()->toString());

                return ApiResponse::error(
                    'not_found',
                    'Not Found',
                    $rid,
                    404
                )->withHeaders(['X-Request-Id' => $rid]);
            }

            Log::error($e->getMessage(), [
                'exception' => $e::class,
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ]);

            $rid = (string) ($request->attributes->get('request_id') ?? Str::uuid()->toString());

            return ApiResponse::error(
                'internal_error',
                '服务器内部错误',
                $rid,
                500
            )->withHeaders(['X-Request-Id' => $rid]);
        });
    })->create();
