<?php

namespace Tests\Unit\AiWorkspace;

use App\Services\AiWorkspace\AdminHelpFeatureRegistry;
use App\Support\AdminTabs;
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

    public function test_media_manifest_has_24_unique_hash_verified_private_screenshots(): void
    {
        $manifest = json_decode((string) file_get_contents(
            resource_path('knowledge/ai-workspace/media/manifest.json'),
        ), true, flags: JSON_THROW_ON_ERROR);
        $assets = $manifest['assets'] ?? [];
        $knowledge = (string) file_get_contents(
            resource_path('knowledge/ai-workspace/geoflow-admin-guide.zh_CN.md'),
        );

        self::assertCount(24, $assets);
        self::assertSame('ai_workspace_manual', $manifest['knowledge_key'] ?? null);
        self::assertMatchesRegularExpression('/\A\d+\.\d+\.\d+\z/', (string) ($manifest['captured_app_version'] ?? ''));
        self::assertCount(24, array_unique(array_map(
            static fn (array $asset): string => (string) $asset['asset_key'].'|'.(string) $asset['locale'],
            $assets,
        )));
        self::assertCount(24, array_unique(array_column($assets, 'content_hash')));
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
            self::assertSame('image/webp', $image['mime'] ?? null);
            self::assertSame([1440, 900], [$image[0], $image[1]]);
            self::assertNotSame('', trim((string) $asset['title']));
            self::assertNotSame('', trim((string) $asset['alt_text']));
            self::assertNotSame('', trim((string) $asset['caption']));
            self::assertNotFalse(strtotime((string) ($asset['captured_at'] ?? '')));
            self::assertStringContainsString((string) $asset['section_key'], $knowledge);

            // 截图挂的是 React 后台的页签深链，不再是 Laravel 路由名：判据改为
            // 「深链形状合法」+「帮助目录里真有这条入口」。
            $tabPath = (string) $asset['tab_path'];
            self::assertNotNull(AdminTabs::tabFromPath($tabPath), $tabPath);
            self::assertIsArray($registry->featureForPath($tabPath), $tabPath);
        }

        self::assertLessThanOrEqual(12 * 1024 * 1024, $totalBytes);
    }
}
