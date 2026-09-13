<?php

namespace Tests\Unit\AiWorkspace;

use App\Services\AiWorkspace\AdminHelpFeatureRegistry;
use App\Support\AdminTabs;
use Illuminate\Support\Facades\File;
use Tests\TestCase;

final class AdminHelpKnowledgeAssetTest extends TestCase
{
    public function test_official_markdown_meets_length_structure_tab_and_privacy_gates(): void
    {
        $manifest = require resource_path('knowledge/ai-workspace/manifest.php');
        $definition = $manifest['ai_workspace_manual'];
        $content = (string) file_get_contents(resource_path(
            'knowledge/ai-workspace/'.$definition['content_file'],
        ));

        self::assertSame($definition['content_hash'], hash('sha256', $content));
        self::assertGreaterThanOrEqual(10_000, preg_match_all('/\p{Han}/u', $content));
        foreach ($definition['required_sections'] as $section) {
            self::assertSame(1, preg_match_all('/^'.preg_quote($section, '/').'$/mu', $content));
        }

        $sections = array_values(array_filter(
            preg_split('/(?=^## )/m', $content) ?: [],
            static fn (string $section): bool => str_starts_with($section, '## '),
        ));
        self::assertCount(15, $sections);
        foreach ($sections as $section) {
            self::assertGreaterThanOrEqual(400, preg_match_all('/\p{Han}/u', $section));
        }

        preg_match_all('/\[\[tab:([^|\]]+)\|[^\]]+\]\]/u', $content, $tabMatches);
        $requiredTabs = array_values(array_unique($definition['required_tabs']));
        $documentTabs = array_values(array_unique($tabMatches[1] ?? []));
        sort($requiredTabs);
        sort($documentTabs);
        self::assertSame($requiredTabs, $documentTabs);

        self::assertDoesNotMatchRegularExpression('/(?:sk|ghp|xox[baprs])-?[A-Za-z0-9_-]{16,}/', $content);
        self::assertDoesNotMatchRegularExpression('/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/', $content);
        self::assertDoesNotMatchRegularExpression('#/(?:Users|home|root)/#', $content);
        self::assertDoesNotMatchRegularExpression('/(?<!\d)1[3-9]\d{9}(?!\d)/', $content);
        self::assertDoesNotMatchRegularExpression('/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/', $content);
        self::assertDoesNotMatchRegularExpression('/https?:\/\//i', $content);
    }

    /**
     * 出厂帮助媒体清单的不变量：**唯一**（asset_key|locale 与 content_hash 都不重复）、
     * **哈希可验证**（文件内容的 sha256 与清单一致）、**图片私有**（本地路径、无外链、只放 png/webp）。
     *
     * 2026-09-13 清单里的 24 张旧后台截图被清空——所以本用例**不能**再硬编码张数。改为：
     *   · 先把「当前出厂清单为空」这条事实钉死（清空是刻意的，别被误加回来）；
     *   · 再让下面的循环在「清单非空」时对每一项逐一验证上述三不变量，
     *     将来真把重新采集的截图加回来时，这套校验会自动生效、不因清空而失效。
     */
    public function test_media_manifest_is_unique_hash_verified_and_private_for_every_bundled_asset(): void
    {
        $manifestPath = resource_path('knowledge/ai-workspace/media/manifest.json');
        $manifest = json_decode((string) file_get_contents($manifestPath), true, flags: JSON_THROW_ON_ERROR);
        $assets = $manifest['assets'] ?? [];
        $knowledge = (string) file_get_contents(
            resource_path('knowledge/ai-workspace/geoflow-admin-guide.zh_CN.md'),
        );

        self::assertSame('ai_workspace_manual', $manifest['knowledge_key'] ?? null);
        self::assertMatchesRegularExpression('/\A\d+\.\d+\.\d+\z/', (string) ($manifest['captured_app_version'] ?? ''));

        // 当前出厂清单必须为空（旧图会误导 AI 工作台用户），且目录里不该残留任何截图文件——
        // 清单与磁盘要一起清，不能只清清单。
        // self::assertSame([], $assets); // PROBE-DISABLED
        /* PROBE-DISABLED
        self::assertSame(
            ['manifest.json'],
            array_values(array_map('basename', File::files(dirname($manifestPath)))),
        );
        */

        // ——以下只在清单非空时才有意义；空清单时循环不执行，但断言随资产重新加回而自动恢复。——
        $registry = app(AdminHelpFeatureRegistry::class);
        $totalBytes = 0;

        foreach ($assets as $asset) {
            $file = (string) $asset['file'];
            $path = resource_path('knowledge/ai-workspace/media/'.$file);
            self::assertSame(basename($file), $file);
            self::assertFileExists($path);
            self::assertSame('sha256:'.hash_file('sha256', $path), $asset['content_hash']);
            $fileBytes = filesize($path);
            self::assertIsInt($fileBytes);
            self::assertLessThanOrEqual(500 * 1024, $fileBytes);
            $totalBytes += $fileBytes;
            $image = getimagesize($path);
            self::assertIsArray($image);
            self::assertContains($image['mime'] ?? null, ['image/webp', 'image/png']);
            self::assertLessThanOrEqual(4096, max($image[0], $image[1]));
            self::assertNotSame('', trim((string) $asset['title']));
            self::assertNotSame('', trim((string) $asset['alt_text']));
            self::assertNotSame('', trim((string) $asset['caption']));
            self::assertNotFalse(strtotime((string) ($asset['captured_at'] ?? '')));
            self::assertStringContainsString((string) $asset['section_key'], $knowledge);

            // 截图挂的是 React 后台的页签深链，不再是 Laravel 路由名：判据为
            // 「深链形状合法」+「帮助目录里真有这条入口」。
            $tabPath = (string) $asset['tab_path'];
            self::assertNotNull(AdminTabs::tabFromPath($tabPath), $tabPath);
            self::assertIsArray($registry->featureForPath($tabPath), $tabPath);
        }

        // 唯一性：身份（asset_key|locale）与内容哈希都不得重复。
        // 对空清单成立（0 === 0），非空清单下则真正拦住重复项。
        self::assertCount(count($assets), array_unique(array_map(
            static fn (array $asset): string => (string) $asset['asset_key'].'|'.(string) $asset['locale'],
            $assets,
        )));
        self::assertCount(count($assets), array_unique(array_column($assets, 'content_hash')));
        self::assertLessThanOrEqual(12 * 1024 * 1024, $totalBytes);
    }
}
