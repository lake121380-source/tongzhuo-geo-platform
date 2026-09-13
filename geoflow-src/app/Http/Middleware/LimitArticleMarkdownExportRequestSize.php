<?php

namespace App\Http\Middleware;

use App\Services\GeoFlow\ArticleMarkdownExportService;
use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

final class LimitArticleMarkdownExportRequestSize
{
    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        if (! $request->isMethod('POST') || ! $this->isPreparePath($request)) {
            return $next($request);
        }

        $contentLength = $request->server('CONTENT_LENGTH');
        if (is_numeric($contentLength)
            && (int) $contentLength > ArticleMarkdownExportService::MAX_PREPARE_REQUEST_BYTES) {
            return new JsonResponse([
                'message' => __('admin.articles.export.errors.request_too_large'),
                'code' => 'article_export_request_too_large',
            ], 413);
        }

        return $next($request);
    }

    /**
     * 2026-09-12 退役改指向：旧 Blade 后台那条 `<admin 前缀>/articles/batch/export-markdown/prepare`
     * 已随退役删除，这条改守新接口 `/api/v1/articles/markdown-export/prepare`。
     *
     * 顺带**去掉了对 `geoflow.admin_base_path` 的依赖**——那个配置项随退役一起清掉了，
     * 继续读它会退回兜底值、指向一个不存在的路径（静默空守）。
     *
     * 版本段用 `v\d+` 而不是写死 `v1`：将来升到 v2 时这条仍然生效，不会再悄悄失效一次。
     * 这里用 `preg_match` 而不是 `hash_equals`：比的是公开的路径、不是密钥，没有时序侧信道可言。
     */
    private function isPreparePath(Request $request): bool
    {
        return preg_match(
            '#^api/v\d+/articles/markdown-export/prepare$#',
            trim($request->path(), '/'),
        ) === 1;
    }
}
