<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Models\SiteSetting;
use App\Services\Api\IdempotencyService;
use App\Support\Site\HomepageModuleBuilder;
use App\Support\Site\SiteSettingsBag;
use App\Support\Site\SiteThemeCatalog;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

final class SiteSettingsController extends BaseApiController
{
    public function __construct(private readonly SiteThemeCatalog $themeCatalog) {}

    public function show(Request $request): JsonResponse
    {
        $this->executionAdmin($request);

        return $this->success($request, $this->projection());
    }

    public function update(Request $request): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $this->requireIdempotencyKey($request);
        $payload = $request->validate([
            'site_name' => ['sometimes', 'required', 'string', 'max:120'],
            'site_subtitle' => ['sometimes', 'nullable', 'string', 'max:255'],
            'site_description' => ['sometimes', 'nullable', 'string', 'max:5000'],
            'site_keywords' => ['sometimes', 'nullable', 'string', 'max:500'],
            'copyright_info' => ['sometimes', 'nullable', 'string', 'max:500'],
            'filing_info' => ['sometimes', 'nullable', 'string', 'max:255'],
            'filing_url' => ['sometimes', 'nullable', 'url:http,https', 'max:500'],
            'site_logo' => ['sometimes', 'nullable', 'url:http,https', 'max:500'],
            'site_favicon' => ['sometimes', 'nullable', 'url:http,https', 'max:500'],
            'seo_title_template' => ['sometimes', 'nullable', 'string', 'max:255'],
            'seo_description_template' => ['sometimes', 'nullable', 'string', 'max:255'],
            'featured_limit' => ['sometimes', 'integer', 'min:1', 'max:100'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:200'],
            'home_carousel_slides' => ['sometimes', 'array', 'max:3'],
            'home_carousel_slides.*.image_url' => ['nullable', 'string', 'max:500'],
            'home_carousel_slides.*.title' => ['nullable', 'string', 'max:120'],
            'home_carousel_slides.*.link_url' => ['nullable', 'string', 'max:500'],
            'home_carousel_slides.*.enabled' => ['nullable', 'boolean'],
            'analytics_code' => ['sometimes', 'nullable', 'string', 'max:50000'],
        ]);
        if (array_key_exists('analytics_code', $payload) && ! $admin->isSuperAdmin()) {
            throw new ApiException('forbidden', '只有超级管理员可以修改统计代码', 403, [
                'required_role' => 'super_admin',
                'field' => 'analytics_code',
            ]);
        }

        return IdempotencyService::executeJson($request, 'PATCH /site-settings', function () use ($request, $admin, $payload): JsonResponse {
            foreach ($payload as $key => $value) {
                if ($key === 'home_carousel_slides') {
                    $value = $this->normalizeCarousel($value);
                }
                if (is_string($value)) {
                    $value = trim($value);
                }
                SiteSetting::query()->updateOrCreate(
                    ['setting_key' => $key],
                    ['setting_value' => is_array($value) ? json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) : (string) $value],
                );
            }
            SiteSettingsBag::forget();

            return $this->success($request, ['settings' => $this->settings(), 'updated_by_admin_id' => (int) $admin->id]);
        });
    }

    public function updateTheme(Request $request): JsonResponse
    {
        $this->executionAdmin($request);
        $this->requireIdempotencyKey($request);
        $payload = $request->validate(['active_theme' => ['nullable', 'string', Rule::in(array_merge([''], $this->themeCatalog->ids()))]]);

        return IdempotencyService::executeJson($request, 'POST /site-settings/theme', function () use ($request, $payload): JsonResponse {
            SiteSetting::query()->updateOrCreate(['setting_key' => 'active_theme'], ['setting_value' => trim((string) ($payload['active_theme'] ?? ''))]);
            SiteSettingsBag::forget();

            return $this->success($request, $this->projection());
        });
    }

    public function updateHomepage(Request $request): JsonResponse
    {
        $this->executionAdmin($request);
        $this->requireIdempotencyKey($request);
        $payload = $request->validate(['homepage_style' => ['sometimes', 'array'], 'homepage_modules' => ['sometimes', 'array']]);
        $style = HomepageModuleBuilder::normalizeStyle($payload['homepage_style'] ?? $this->jsonSetting('homepage_style', []));
        $modules = $this->normalizeModules($payload['homepage_modules'] ?? $this->jsonSetting('homepage_modules', []));

        return IdempotencyService::executeJson($request, 'PATCH /site-settings/homepage', function () use ($request, $style, $modules): JsonResponse {
            $this->saveJson('homepage_style', $style);
            $this->saveJson('homepage_modules', $modules);
            SiteSettingsBag::forget();

            return $this->success($request, $this->projection());
        });
    }

    public function applyHomepagePreset(Request $request): JsonResponse
    {
        $this->executionAdmin($request);
        $this->requireIdempotencyKey($request);
        $payload = $request->validate([
            'homepage_preset' => ['required', 'string', Rule::in(HomepageModuleBuilder::presetIds())],
            'preset_mode' => ['nullable', 'string', Rule::in(HomepageModuleBuilder::presetModes())],
        ]);

        return IdempotencyService::executeJson($request, 'POST /site-settings/homepage/preset', function () use ($request, $payload): JsonResponse {
            $preset = HomepageModuleBuilder::buildPreset((string) $payload['homepage_preset']);
            $style = $preset['style'];
            $modules = $preset['modules'];
            if (($payload['preset_mode'] ?? 'replace') === 'append') {
                $style = HomepageModuleBuilder::styleFromRaw((string) $this->rawSetting('homepage_style', '{}'));
                $modules = $this->normalizeModules(array_merge($this->jsonSetting('homepage_modules', []), $modules));
            }
            $this->saveJson('homepage_style', $style);
            $this->saveJson('homepage_modules', $modules);
            SiteSettingsBag::forget();

            return $this->success($request, $this->projection());
        });
    }

    public function importHomepage(Request $request): JsonResponse
    {
        $this->executionAdmin($request);
        $this->requireIdempotencyKey($request);
        $payload = $request->validate(['homepage_design' => ['required', 'array'], 'import_mode' => ['nullable', 'string', Rule::in(HomepageModuleBuilder::presetModes())]]);
        $imported = HomepageModuleBuilder::normalizeDesignPayload($payload['homepage_design']);
        if ($imported['modules'] === []) {
            throw ValidationException::withMessages(['homepage_design' => '首页设计至少需要一个模块']);
        }

        return IdempotencyService::executeJson($request, 'POST /site-settings/homepage/import', function () use ($request, $payload, $imported): JsonResponse {
            $style = $imported['style'];
            $modules = $imported['modules'];
            if (($payload['import_mode'] ?? 'replace') === 'append') {
                $style = HomepageModuleBuilder::styleFromRaw((string) $this->rawSetting('homepage_style', '{}'));
                $modules = $this->normalizeModules(array_merge($this->jsonSetting('homepage_modules', []), $modules));
            }
            $this->saveJson('homepage_style', $style);
            $this->saveJson('homepage_modules', $modules);
            SiteSettingsBag::forget();

            return $this->success($request, $this->projection());
        });
    }

    /** @return array<string,mixed> */
    private function projection(): array
    {
        return [
            'settings' => $this->settings(),
            'themes' => $this->themeCatalog->all(),
            'homepage' => $this->homepageProjection(),
        ];
    }

    /** @return array<string,string> */
    private function settings(): array
    {
        $defaults = [
            'site_name' => '桐灼GEO', 'site_subtitle' => '', 'site_description' => '', 'site_keywords' => '',
            'copyright_info' => '', 'filing_info' => '', 'filing_url' => 'https://beian.miit.gov.cn/', 'site_logo' => '', 'site_favicon' => '',
            'seo_title_template' => '{title} - {site_name}', 'seo_description_template' => '{description}',
            'featured_limit' => '6', 'per_page' => '12', 'active_theme' => (string) config('geoflow.default_theme', ''),
            'analytics_code' => '', 'home_carousel_slides' => '[]',
        ];
        $stored = SiteSetting::query()->whereIn('setting_key', array_keys($defaults))->pluck('setting_value', 'setting_key')->all();
        foreach ($defaults as $key => $default) {
            if (! array_key_exists($key, $stored)) {
                $stored[$key] = $default;
            }
        }
        $stored['active_theme'] = (string) ($stored['active_theme'] !== '' ? $stored['active_theme'] : $defaults['active_theme']);

        return array_map(static fn ($value): string => is_array($value) ? json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : (string) $value, $stored);
    }

    /** @return array<string,mixed> */
    private function homepageProjection(): array
    {
        return [
            'style' => HomepageModuleBuilder::styleFromRaw((string) $this->rawSetting('homepage_style', '{}')),
            'modules' => HomepageModuleBuilder::fromRaw((string) $this->rawSetting('homepage_modules', '[]'), false),
            'presets' => HomepageModuleBuilder::presetIds(), 'preset_modes' => HomepageModuleBuilder::presetModes(),
            'types' => HomepageModuleBuilder::TYPES, 'layouts' => HomepageModuleBuilder::LAYOUTS,
            'article_sources' => HomepageModuleBuilder::ARTICLE_SOURCES,
            'container_widths' => HomepageModuleBuilder::CONTAINER_WIDTHS, 'spacings' => HomepageModuleBuilder::SPACINGS,
            'radii' => HomepageModuleBuilder::RADII, 'alignments' => HomepageModuleBuilder::ALIGNMENTS,
        ];
    }

    private function rawSetting(string $key, string $default): string
    {
        return (string) (SiteSetting::query()->where('setting_key', $key)->value('setting_value') ?? $default);
    }

    /** @return array<int,mixed> */
    private function jsonSetting(string $key, array $default): array
    {
        $decoded = json_decode($this->rawSetting($key, json_encode($default)), true);

        return is_array($decoded) ? $decoded : $default;
    }

    private function saveJson(string $key, array $value): void
    {
        SiteSetting::query()->updateOrCreate(['setting_key' => $key], ['setting_value' => json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)]);
    }

    /** @return array<int,array<string,mixed>> */
    private function normalizeModules(mixed $modules): array
    {
        if (! is_array($modules) || count($modules) > HomepageModuleBuilder::MAX_MODULES) {
            throw ValidationException::withMessages(['homepage_modules' => '首页模块数量不合法']);
        }
        foreach ($modules as $module) {
            if (! is_array($module)) {
                continue;
            }
            foreach (['image_url', 'link_url'] as $field) {
                if (($module[$field] ?? '') !== '' && HomepageModuleBuilder::normalizeUrl((string) $module[$field]) === '') {
                    throw ValidationException::withMessages(['homepage_modules' => '首页模块 URL 不合法']);
                }
            }
        }

        return HomepageModuleBuilder::normalizeModules($modules, false, HomepageModuleBuilder::MAX_MODULES);
    }

    /** @return array<int,array<string,mixed>> */
    private function normalizeCarousel(mixed $slides): array
    {
        if (! is_array($slides)) {
            return [];
        }

        return array_values(array_filter(array_map(static function ($slide): ?array {
            if (! is_array($slide)) {
                return null;
            }
            $title = trim((string) ($slide['title'] ?? ''));
            $image = trim((string) ($slide['image_url'] ?? ''));
            if ($title === '' && $image === '') {
                return null;
            }

            return ['image_url' => $image, 'title' => $title, 'link_url' => trim((string) ($slide['link_url'] ?? '')), 'enabled' => ! empty($slide['enabled'])];
        }, array_slice($slides, 0, 3))));
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }
}
