<?php

namespace App\Services\AiWorkspace;

use App\Support\AdminTabs;

/**
 * 后台帮助的**页签覆盖率**。
 *
 * **2026-09-12 退役重写**：原先它枚举 `admin.*` Laravel 路由并分类
 * （`entry` / `dynamic` / `action` / `restricted` / `endpoint`），量的是
 * 「旧 Blade 后台的页面有多少被帮助覆盖」。旧后台删除后：
 *   · 没有 `admin.*` 路由可枚举了（`all()` 直接返回空，测试断言 ≥290 条随之失败）；
 *   · 而且 React 后台是 SPA，**「带参数的页」「非 GET 动作」这些路由层概念在 SPA 里没有对应物**
 *     ——硬要保留只会得到一批假的分类。
 *
 * 现在量的等价不变量是：**「每个 React 页签是否有帮助条目」**。
 * 页签清单取自 {@see AdminTabs}——**独立于帮助目录**，否则就是拿目录校验目录、永远是 100%。
 *
 * ⚠️ 覆盖率目前**不满**：没有帮助条目的页签会如实标成 `uncovered`，不去粉饰。
 * 补齐那些条目是内容工作，见 `docs/LEGACY_ADMIN_RETIREMENT_MATRIX.md` 第六节。
 */
final class AdminHelpRouteCoverage
{
    public function __construct(private readonly AdminHelpFeatureRegistry $features) {}

    /** @return array{path:string,tab:string,category:string,feature_id:?string} */
    public function classify(string $tab): array
    {
        $path = AdminTabs::path($tab);
        $entry = $this->features->featureForPath($path);

        return [
            'path' => $path,
            'tab' => $tab,
            'category' => is_array($entry) ? 'entry' : 'uncovered',
            'feature_id' => is_array($entry) ? (string) $entry['id'] : null,
        ];
    }

    /** @return list<array{path:string,tab:string,category:string,feature_id:?string}> */
    public function all(): array
    {
        return collect(AdminTabs::TABS)
            ->map(fn (string $tab): array => $this->classify($tab))
            ->values()
            ->all();
    }

    /** @return list<string> 还没有帮助条目的页签 */
    public function uncoveredTabs(): array
    {
        return collect($this->all())
            ->where('category', 'uncovered')
            ->pluck('tab')
            ->values()
            ->all();
    }
}
