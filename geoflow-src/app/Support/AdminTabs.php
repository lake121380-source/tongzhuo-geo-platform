<?php

namespace App\Support;

/**
 * React 后台（SPA）的页签清单——**后端侧的权威副本**。
 *
 * 2026-09-12 退役新增：旧 Blade 后台是「一页 = 一条 Laravel 路由」，助手可以直接枚举
 * `admin.*` 路由来知道后台有哪些页面。React 后台是 SPA、页面由页签 id 决定、没有逐页路由，
 * 所以需要一份独立的页签清单，否则：
 *   · 「帮助覆盖了哪些页面」这个不变量会退化成**循环论证**（拿目录去校验目录）；
 *   · 助手也没法知道「后台一共有哪些页面」。
 *
 * ⚠️ **与前端 `ai-ui-src/src/tabs.ts` 的 `ADMIN_TABS` 必须保持一致**——两边不同步就会出现
 * 与 `protected_paths` 同类的错位（一边以为有、另一边没有）。改动时请一起改。
 */
final class AdminTabs
{
    /** @var list<string> */
    public const TABS = [
        'seo_dashboard',
        'seo_foundation',
        'robots_policy',
        'brand_entity',
        'url_scanner',
        'dashboard',
        'ai-workspace',
        'generator',
        'articles',
        'llmstxt',
        'knowledge',
        'materials',
        'tasks',
        'distribution',
        'manual-publications',
        'attribution_funnel',
        'query_radar',
        'competitor',
        'sandbox',
        'analytics',
        'leads',
        'ai-models',
        'admin-settings',
        'system-updates',
        'preview',
    ];

    public static function path(string $tab): string
    {
        return '/geo_admin?tab='.$tab;
    }

    public static function isKnown(string $tab): bool
    {
        return in_array($tab, self::TABS, true);
    }

    /** 从 `/geo_admin?tab=articles` 里取出 `articles`；不是这个形状就返回 null。 */
    public static function tabFromPath(string $path): ?string
    {
        $matched = preg_match('#^/geo_admin\?tab=([a-z0-9_-]+)$#', $path, $matches) === 1;

        return $matched ? $matches[1] : null;
    }
}
