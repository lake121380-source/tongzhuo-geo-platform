<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Models\SiteSetting;
use App\Services\Api\IdempotencyService;
use App\Services\Site\SeoDiscoverabilityAuditService;
use App\Services\Site\SiteDiscoveryRenderer;
use App\Support\Site\CurrentSite;
use App\Support\Site\SiteSettingsBag;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

final class SiteSeoController extends BaseApiController
{
    public function config(Request $request, SiteDiscoveryRenderer $renderer): JsonResponse
    {
        $this->executionAdmin($request);
        $state = $this->state();

        return $this->success($request, [
            'base_url' => app(CurrentSite::class)->baseUrl(),
            'config' => $renderer->normalizeConfig(is_array($state['config'] ?? null) ? $state['config'] : $renderer->config()),
            'published_config' => $renderer->config(),
            'version' => (int) ($state['version'] ?? 0),
            'published_at' => $state['published_at'] ?? null,
            'published_by_admin_id' => $state['published_by_admin_id'] ?? null,
        ]);
    }

    /** 可发现性体检：把当前生效的发现配置与 AI 爬虫名单对撞，输出可执行结论。 */
    public function audit(Request $request, SeoDiscoverabilityAuditService $audit): JsonResponse
    {
        $this->executionAdmin($request);

        return $this->success($request, $audit->build());
    }

    public function updateConfig(Request $request, SiteDiscoveryRenderer $renderer): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        $payload = $request->validate([
            'site_title' => ['sometimes', 'string', 'max:200'],
            'summary' => ['sometimes', 'string', 'max:2000'],
            'core_directives' => ['sometimes', 'array', 'max:50'],
            'core_directives.*' => ['string', 'max:500'],
            'allow_all_by_default' => ['sometimes', 'boolean'],
            'include_llms_txt' => ['sometimes', 'boolean'],
            'include_sitemap' => ['sometimes', 'boolean'],
            'protected_paths' => ['sometimes', 'array', 'max:50'],
            'protected_paths.*' => ['string', 'max:200'],
            'bot_policies' => ['sometimes', 'array', 'max:20'],
        ]);

        return IdempotencyService::executeJson($request, 'PATCH /site/seo-config', function () use ($request, $admin, $renderer, $payload): JsonResponse {
            $state = $this->state();
            $base = is_array($state['config'] ?? null) ? $state['config'] : $renderer->config();
            $config = $renderer->normalizeConfig(array_replace($base, $payload));
            $nextState = [
                'config' => $config,
                'published_config' => is_array($state['published_config'] ?? null) ? $state['published_config'] : null,
                'version' => (int) ($state['version'] ?? 0) + 1,
                'updated_at' => now()->toIso8601String(),
                'updated_by_admin_id' => (int) $admin->id,
                'published_at' => $state['published_at'] ?? null,
                'published_by_admin_id' => $state['published_by_admin_id'] ?? null,
            ];
            $this->saveState($nextState);

            return $this->success($request, [
                'config' => $config,
                'published_config' => $renderer->config(),
                'version' => $nextState['version'],
                'published_at' => $nextState['published_at'],
            ]);
        });
    }

    public function robotsPreview(Request $request, SiteDiscoveryRenderer $renderer): JsonResponse
    {
        $this->executionAdmin($request);

        return $this->success($request, ['content' => $renderer->robotsText(), 'content_type' => 'text/plain']);
    }

    public function sitemapPreview(Request $request, SiteDiscoveryRenderer $renderer): JsonResponse
    {
        $this->executionAdmin($request);
        $content = $renderer->sitemapXml();

        return $this->success($request, ['content' => $content, 'content_type' => 'application/xml', 'url_count' => substr_count($content, '<url>')]);
    }

    public function rebuildSitemap(Request $request, SiteDiscoveryRenderer $renderer): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->executionAdmin($request);

        return IdempotencyService::executeJson($request, 'POST /site/sitemap/rebuild', fn (): JsonResponse => $this->success($request, [
            'content' => $renderer->sitemapXml(),
            'generated_at' => now()->toIso8601String(),
            'page_count' => $renderer->sitemapPageCount(),
        ]));
    }

    public function llmsPreview(Request $request, SiteDiscoveryRenderer $renderer): JsonResponse
    {
        $this->executionAdmin($request);
        $variant = (string) $request->query('variant', 'short');
        if (! in_array($variant, ['short', 'full'], true)) {
            throw new ApiException('invalid_variant', 'llms.txt variant 必须是 short 或 full', 422);
        }

        return $this->success($request, ['content' => $renderer->llmsText($variant), 'variant' => $variant, 'content_type' => 'text/plain']);
    }

    public function publishLlms(Request $request, SiteDiscoveryRenderer $renderer): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);

        return IdempotencyService::executeJson($request, 'POST /site/llms-txt/publish', function () use ($request, $renderer, $admin): JsonResponse {
            $state = $this->state();
            $config = is_array($state['config'] ?? null) ? $state['config'] : $renderer->config();
            $state['published_config'] = $renderer->normalizeConfig($config);
            $state['published_at'] = now()->toIso8601String();
            $state['published_by_admin_id'] = (int) $admin->id;
            $this->saveState($state);

            return $this->success($request, [
                'published_at' => $state['published_at'],
                'version' => (int) ($state['version'] ?? 0),
                'content' => $renderer->llmsText('short'),
                'robots' => $renderer->robotsText(),
                'sitemap' => $renderer->sitemapXml(),
            ]);
        });
    }

    /** @return array<string,mixed> */
    private function state(): array
    {
        $raw = (string) SiteSetting::query()->where('setting_key', 'geo_discovery_config')->value('setting_value');
        $state = json_decode($raw, true);

        return is_array($state) ? $state : [];
    }

    /** @param array<string,mixed> $state */
    private function saveState(array $state): void
    {
        DB::transaction(function () use ($state): void {
            SiteSetting::query()->updateOrCreate(
                ['setting_key' => 'geo_discovery_config'],
                ['setting_value' => json_encode($state, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)],
            );
        });
        SiteSettingsBag::forget();
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }
}
