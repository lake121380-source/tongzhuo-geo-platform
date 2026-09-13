<?php

namespace App\Services\AiWorkspace;

use App\Models\Admin;
use Illuminate\Support\Str;

/**
 * 后台功能注册表：把「帮助目录条目」与「用户在后台的哪个位置」对应起来。
 *
 * **2026-09-12 退役重写**：原先这套逻辑建立在**活着的 Blade 路由**之上——
 * 「路由存在吗 / 是 GET 吗 / 有没有参数 / 挂没挂 `admin.super`」全是从 Laravel 路由对象上读的。
 * 旧后台删除后那些路由不存在了，于是：
 *   · 帮助目录的 20 条入口被 `router->has()` 全部过滤掉（助手帮助变空）
 *   · `relatedFeatures()` 经 `AdminWeb::routePath()` 抛 `RouteNotFoundException`（助手一问答就 500）
 *
 * 现在判据统一改为**条目自身的 `path`**（React 后台的深链，形如 `/geo_admin?tab=articles`）：
 *   · 「页面存在」→ 路径形状合法（`AdminHelpKnowledgeCatalog::isAvailableTo` 已做同一校验）
 *   · 「需要超管」→ 条目上的 `protected` 标志（不再从路由中间件推导）
 *   · 「该去哪一页」→ 直接就是那条 `path`，不再经 `route()` 解析
 *
 * 与旧实现的对应关系一目了然：凡是原来读 `Route` 对象的地方，现在读条目字段。
 */
final class AdminHelpFeatureRegistry
{
    public function __construct(private readonly AdminHelpKnowledgeCatalog $catalog) {}

    /** @return list<array<string, mixed>> */
    public function entries(): array
    {
        return $this->catalog->entries();
    }

    /**
     * @param  string  $path  形如 `/geo_admin?tab=articles`
     * @return array<string, mixed>|null
     */
    public function featureForPath(string $path): ?array
    {
        foreach ($this->entries() as $entry) {
            if ((string) ($entry['path'] ?? '') === $path) {
                return $entry;
            }
        }

        return null;
    }

    /** @return array<string, mixed>|null */
    public function featureForId(string $featureId): ?array
    {
        foreach ($this->entries() as $entry) {
            if ((string) ($entry['id'] ?? '') === $featureId) {
                return $entry;
            }
        }

        return null;
    }

    /**
     * 从内容里解析出「可信的站内入口」。
     *
     * 指令形状由 `[[route:admin.x|标签]]` 改为 `[[tab:articles|标签]]`——旧后台的路由名
     * 已经不存在了，继续沿用会解析出一堆死链。用 tab id 也更短、更接近 SPA 的真实结构。
     *
     * @return list<string>
     */
    public function trustedPaths(Admin $admin, string $content): array
    {
        preg_match_all('/\[\[tab:([a-z0-9_-]+)\|[^\]]+\]\]/u', $content, $matches);

        return collect($matches[1] ?? [])
            ->map(static fn (mixed $tab): string => trim((string) $tab))
            ->map(static fn (string $tab): string => '/geo_admin?tab='.$tab)
            ->filter(fn (string $path): bool => $this->isTrustedEntryPath($admin, $path))
            ->unique()
            ->values()
            ->all();
    }

    /**
     * @param  list<string>  $paths
     * @return list<array{id:string,title:string,description:string,icon:string,url:string}>
     */
    public function relatedFeatures(Admin $admin, array $paths, int $limit = 3): array
    {
        return collect($paths)
            ->map(function (string $path) use ($admin): ?array {
                $entry = $this->featureForPath($path);
                if (! is_array($entry) || ! $this->isAvailableTo($entry, $admin)) {
                    return null;
                }

                return ['path' => $path, 'entry' => $entry];
            })
            ->filter()
            ->unique('path')
            ->take(max(1, min(3, $limit)))
            ->map(static fn (array $item): array => [
                'id' => (string) $item['entry']['id'],
                'title' => (string) $item['entry']['name'],
                'description' => (string) $item['entry']['description'],
                'icon' => (string) $item['entry']['icon'],
                // 入口就是这条深链本身，不再经 route() 解析（那条路径已经不存在了）。
                'url' => (string) $item['path'],
            ])
            ->values()
            ->all();
    }

    /** @return list<string> */
    public function aliasesFor(array $entry): array
    {
        return collect([
            (string) ($entry['id'] ?? ''),
            (string) ($entry['name'] ?? ''),
            ...((array) ($entry['keywords'] ?? [])),
            // 原先取路由名的最后一段（`admin.articles.index` → `index`，随后被下面 reject 掉）；
            // 现在取深链里的 tab id（`/geo_admin?tab=articles` → `articles`），是有效别名。
            Str::afterLast((string) ($entry['path'] ?? ''), '='),
        ])->map(static fn (mixed $alias): string => Str::lower(trim((string) $alias)))
            ->filter()
            ->reject(static fn (string $alias): bool => in_array($alias, ['index', 'show', 'create', 'edit'], true))
            ->unique()
            ->values()
            ->all();
    }

    /**
     * @param  string  $path  形如 `/geo_admin?tab=articles`
     */
    public function canAccessPath(Admin $admin, string $path): bool
    {
        return $this->isTrustedEntryPath($admin, $path);
    }

    private function isTrustedEntryPath(Admin $admin, string $path): bool
    {
        $entry = $this->featureForPath($path);
        if (! is_array($entry)) {
            return false;
        }

        // 旧的「是 GET、无参数、挂了 admin.super」三项检查都是**路由层**事实，SPA 里没有对应物：
        // 前两项由「路径形状合法」覆盖（目录里每条入口都是一个 GET 页面、无参数），
        // 超管门禁改由条目上的 `protected` 标志承担——它在 isAvailableTo 里校验。
        return $this->isAvailableTo($entry, $admin);
    }

    /** @param array<string, mixed> $entry */
    private function isAvailableTo(array $entry, Admin $admin): bool
    {
        // 与目录侧同一套判据：路径形状必须指向 React 后台的页签深链。
        if (preg_match('#^/geo_admin\?tab=[a-z0-9_-]+$#', (string) ($entry['path'] ?? '')) !== 1) {
            return false;
        }

        return ! (bool) ($entry['protected'] ?? false) || $admin->canManageProtectedWorkflows();
    }
}
