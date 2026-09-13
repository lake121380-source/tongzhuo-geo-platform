<?php

namespace App\Support;

use Illuminate\Support\Facades\Route;

final class AdminWeb
{
    /**
     * 兼容 bak 语言占位符：同时支持 Laravel `:key` 与旧版 `{key}`。
     *
     * @param  array<string, scalar|null>  $replace
     */
    public static function trans(string $key, array $replace = []): string
    {
        $target = str_starts_with($key, 'admin.') ? $key : 'admin.'.$key;
        $text = (string) __($target, $replace);

        foreach ($replace as $name => $value) {
            $text = str_replace('{'.$name.'}', (string) $value, $text);
        }

        return $text;
    }

    public static function siteName(): string
    {
        return '桐灼GEO';
    }

    public static function basePath(): string
    {
        try {
            return AdminBasePathManager::normalize((string) config('geoflow.admin_base_path', AdminBasePathManager::DEFAULT_PATH));
        } catch (\Throwable) {
            return AdminBasePathManager::DEFAULT_PATH;
        }
    }

    public static function url(string $path = ''): string
    {
        $base = self::basePath();
        $path = ltrim($path, '/');

        return url($base.($path !== '' ? '/'.$path : ''));
    }

    /**
     * 为同源前端请求补全 APP_URL 中的二级目录前缀（如 /doc/broadcasting/auth）。
     */
    public static function appPath(string $path): string
    {
        $path = '/'.ltrim($path, '/');
        $appPath = trim((string) (parse_url((string) config('app.url', ''), PHP_URL_PATH) ?: ''), '/');

        if ($appPath === '') {
            return $path;
        }

        $appPrefix = '/'.$appPath;
        if ($path === $appPrefix || str_starts_with($path, $appPrefix.'/')) {
            return $path;
        }

        return rtrim($appPrefix, '/').$path;
    }

    /**
     * Build a same-origin route path for admin JavaScript endpoints and forms.
     *
     * This keeps URLs independent from the configured APP_URL host while still
     * preserving an APP_URL subdirectory such as https://example.com/geoflow.
     *
     * @param  array<string, mixed>  $parameters
     */
    public static function routePath(string $name, array $parameters = []): string
    {
        // 2026-09-12 退役**止血**：旧 Blade 后台的路由已全部删除，但仍有代码按**路由名**引用它们
        // （AI 助手的帮助目录与能力清单，共 790 处）。`route()` 对不存在的路由会抛
        // `RouteNotFoundException`——那会让「向 AI 助手提问」直接 500（实测复现：
        // `AdminHelpAnswerStream:142` → 帮助目录 `search()` → 本方法）。
        // 这里对不存在的路由返回空串：调用方拿到空链接，而不是整条链路崩掉。
        //
        // ⚠️ **这只是止血，不是收口**：那些引用仍指向已经不存在的页面，需要被重新指向
        // React 后台的入口（见 docs/LEGACY_ADMIN_RETIREMENT_MATRIX.md 第六节）。
        if (! Route::has($name)) {
            return '';
        }

        $path = route($name, $parameters, false);
        $appPath = trim((string) (parse_url((string) config('app.url', ''), PHP_URL_PATH) ?: ''), '/');
        if ($appPath === '') {
            return $path;
        }

        $appPrefix = '/'.$appPath;
        if ($path === $appPrefix || str_starts_with($path, $appPrefix.'/')) {
            return $path;
        }

        $adminBase = trim(self::basePath(), '/');
        if ($adminBase !== '' && ($path === '/'.$adminBase || str_starts_with($path, '/'.$adminBase.'/')) && str_ends_with($appPrefix, '/'.$adminBase)) {
            $appPrefix = substr($appPrefix, 0, -strlen('/'.$adminBase));
            if ($appPrefix === '') {
                return $path;
            }
        }

        return rtrim($appPrefix, '/').(str_starts_with($path, '/') ? $path : '/'.$path);
    }

    public static function supportedLocales(): array
    {
        return [
            'zh_CN' => '简体中文',
            'en' => 'English',
            'ja' => '日本語',
            'es' => 'Español',
            'ru' => 'Русский',
            'pt_BR' => 'Português (BR)',
        ];
    }

    public static function isSupportedLocale(string $locale): bool
    {
        return array_key_exists($locale, self::supportedLocales());
    }
}
