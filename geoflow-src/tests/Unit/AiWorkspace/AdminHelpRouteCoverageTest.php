<?php

namespace Tests\Unit\AiWorkspace;

use App\Models\Admin;
use App\Services\AiWorkspace\AdminHelpFeatureRegistry;
use App\Services\AiWorkspace\AdminHelpRouteCoverage;
use App\Support\AdminTabs;
use Tests\TestCase;

/**
 * 帮助子系统的契约守卫。
 *
 * **2026-09-12 退役改写**：原版建立在对 `admin.*` Laravel 路由的枚举之上
 * （断言 ≥290 条路由被分类、断言知识库里的 `[[route:admin.x|…]]` 指令都能解析到真实 GET 路由）。
 * 旧 Blade 后台删除后那些路由不存在了，帮助的「页面」概念整体迁移到 **React 后台的页签深链**
 * （`/geo_admin?tab=<id>`，清单见 {@see AdminTabs}），因此这一组断言按页签模型重写。
 */
final class AdminHelpRouteCoverageTest extends TestCase
{
    public function test_every_admin_tab_receives_exactly_one_classification(): void
    {
        $coverage = app(AdminHelpRouteCoverage::class)->all();

        // 覆盖面的全集现在是**页签**，不再是路由——数量由 AdminTabs 独立给定。
        self::assertSame(count(AdminTabs::TABS), count($coverage));
        self::assertSame(count($coverage), collect($coverage)->pluck('path')->unique()->count());
        foreach ($coverage as $row) {
            self::assertContains($row['category'], ['entry', 'uncovered']);
            self::assertNotSame('', $row['path']);
            self::assertNotNull(AdminTabs::tabFromPath($row['path']));
        }
    }

    /**
     * 覆盖率**如实反映现状**：有帮助条目的页签是 `entry`，没有的是 `uncovered`。
     *
     * 这里刻意**不**断言「全覆盖」——因为现在确实没铺满。写成断言全覆盖只会逼出一个
     * 「把 uncovered 偷偷改回 entry」的假绿灯。真要让它变绿，就该去补内容条目。
     */
    public function test_coverage_reports_uncovered_tabs_instead_of_pretending_full_coverage(): void
    {
        $coverage = app(AdminHelpRouteCoverage::class);
        $uncovered = $coverage->uncoveredTabs();
        $all = $coverage->all();

        $entryCount = collect($all)->where('category', 'entry')->count();
        self::assertSame(count($all), $entryCount + count($uncovered));
        // 至少要有一条被覆盖，否则说明目录与页签完全对不上（多半是路径格式改了而这边没跟）。
        self::assertGreaterThan(0, $entryCount, '帮助目录与页签路径完全对不上，检查两边格式是否一致');
    }

    public function test_knowledge_guide_tab_directives_point_at_known_admin_tabs(): void
    {
        $content = file_get_contents(resource_path('knowledge/ai-workspace/geoflow-admin-guide.zh_CN.md'));
        self::assertIsString($content);
        preg_match_all('/\[\[tab:([a-z0-9_-]+)\|[^\]]+\]\]/u', $content, $matches);
        $directives = array_unique($matches[1] ?? []);
        self::assertNotSame([], $directives, '知识库指南里没有任何 [[tab:…]] 指令');

        $registry = app(AdminHelpFeatureRegistry::class);
        foreach ($directives as $tab) {
            // 指令里的页签必须是**真实存在的页签**，且帮助目录里真有对应条目——
            // 否则助手会给出一个指向不存在页面的入口。
            self::assertTrue(AdminTabs::isKnown((string) $tab), 'Unknown tab directive: '.$tab);
            self::assertNotNull(
                $registry->featureForPath(AdminTabs::path((string) $tab)),
                'Tab directive has no help entry: '.$tab,
            );
        }
    }

    public function test_registry_resolves_entries_by_path_and_honours_the_protected_flag(): void
    {
        $registry = app(AdminHelpFeatureRegistry::class);
        $regularAdmin = new Admin(['role' => 'admin', 'status' => 'active']);
        $superAdmin = new Admin(['role' => 'super_admin', 'status' => 'active']);

        self::assertSame('ai-workspace', $registry->featureForPath(AdminTabs::path('ai-workspace'))['id'] ?? null);
        self::assertSame('account', $registry->featureForPath(AdminTabs::path('admin-settings'))['id'] ?? null);

        // 普通管理员能进未被保护的入口。
        self::assertTrue($registry->canAccessPath($regularAdmin, AdminTabs::path('ai-workspace')));

        // 被 `protected` 标记的条目只有能管受保护流程的管理员才拿得到——
        // 旧实现是从路由的 `admin.super` 中间件推导的，现在由条目标志承担。
        $protectedPath = null;
        foreach ($registry->entries() as $entry) {
            if (($entry['protected'] ?? false) === true) {
                $protectedPath = (string) $entry['path'];
                break;
            }
        }
        self::assertNotNull($protectedPath, '帮助目录里应当有至少一条 protected 条目');
        self::assertFalse($registry->canAccessPath($regularAdmin, $protectedPath));
        self::assertTrue($registry->canAccessPath($superAdmin, $protectedPath));

        // 形状不对的路径一律不可信，即使它恰好出现在目录里。
        self::assertFalse($registry->canAccessPath($superAdmin, '/legacy-admin/articles'));
    }
}
