<?php

namespace App\Services\Site;

use App\Models\Article;
use App\Support\Analytics\TrafficClassifier;

/**
 * 站点「可发现性体检」。
 *
 * 把**当前生效的** SEO/发现配置与产品自己认可的 AI 爬虫名单对撞，输出可直接执行的结论，
 * 例如「Bytespider 被 disallow，豆包永远抓不到你」。全部结论都来自已持久化的配置与
 * 真实文章计数，没有任何推测或合成分数。
 *
 * 这里只做体检，不做传统 SEO 指标（关键词排名、搜索量、外链）——那些没有可核验的数据源。
 */
final class SeoDiscoverabilityAuditService
{
    public function __construct(private readonly SiteDiscoveryRenderer $renderer) {}

    /** @return array<string, mixed> */
    public function build(): array
    {
        $config = $this->renderer->config();
        $blockedBots = $this->blockedAiCrawlers($config['bot_policies']);
        $publishedCount = Article::query()->whereIn('status', ['published', 'private'])->count();
        // 2026-09-12 退役：原先这里从 `geoflow.admin_base_path` 推导旧 Blade 后台路径来做校验。
        // 那个配置项与旧后台都已删除——继续推导只会退回**硬编码兜底值 `/legacy-admin`**，
        // 于是这里会**持续报一条指向不存在路径的假告警**（只要运营方把那条从保护路径里清掉就会引爆）。
        // 现在只校验 `/geo_admin`：它是 React 后台，硬编码在 nginx 里，不来自任何配置。
        $protectedPaths = array_values(array_map('strval', (array) $config['protected_paths']));

        $findings = [];
        if ($blockedBots !== []) {
            $findings[] = [
                'key' => 'ai_crawler_blocked',
                'severity' => 'warning',
                'title' => '有 AI 爬虫被禁止抓取',
                'detail' => '当前生效的 robots 策略禁止了：'.implode('、', array_column($blockedBots, 'name')).'。被挡住的引擎不可能引用你的内容。',
            ];
        }
        if (! (bool) $config['include_llms_txt']) {
            $findings[] = [
                'key' => 'llms_txt_disabled',
                'severity' => 'warning',
                'title' => 'llms.txt 未启用',
                'detail' => '当前配置不生成 llms.txt，AI 引擎缺少按你的口径读取站点摘要的入口。',
            ];
        }
        if (! (bool) $config['include_sitemap']) {
            $findings[] = [
                'key' => 'sitemap_disabled',
                'severity' => 'warning',
                'title' => 'sitemap 未启用',
                'detail' => '当前配置不生成 sitemap，爬虫无法从站点地图发现已发布内容。',
            ];
        }
        if ($publishedCount === 0) {
            $findings[] = [
                'key' => 'no_published_content',
                'severity' => 'warning',
                'title' => '当前没有已发布内容',
                'detail' => 'sitemap 与 llms.txt 里不会有任何条目，AI 引擎也就没有可引用的页面。',
            ];
        }
        if (! in_array('/geo_admin', $protectedPaths, true)) {
            $findings[] = [
                'key' => 'admin_path_not_protected',
                'severity' => 'warning',
                'title' => '后台路径未被 robots 保护',
                'detail' => '受保护路径里缺少 /geo_admin，后台可能被抓取。',
            ];
        }

        return [
            'robots' => [
                'allow_all' => (bool) $config['allow_all_by_default'],
                'protected_paths' => $protectedPaths,
                'bot_policies' => array_values(array_map(static fn (array $policy): array => [
                    'name' => (string) ($policy['name'] ?? ''),
                    'user_agent' => (string) ($policy['user_agent'] ?? ''),
                    'action' => (string) ($policy['action'] ?? ''),
                    'is_ai_crawler' => TrafficClassifier::classify((string) ($policy['user_agent'] ?? '')) === TrafficClassifier::AI_BOT,
                ], (array) $config['bot_policies'])),
                'blocked_ai_crawlers' => $blockedBots,
            ],
            'llms_txt' => [
                'enabled' => (bool) $config['include_llms_txt'],
                'published_article_count' => $publishedCount,
            ],
            'sitemap' => [
                'enabled' => (bool) $config['include_sitemap'],
                'published_article_count' => $publishedCount,
            ],
            'findings' => $findings,
            'source' => ['kind' => 'geoflow_database', 'estimated' => false],
        ];
    }

    /**
     * 当前生效策略里「被禁止抓取」的 AI 爬虫。
     *
     * @return list<array{name: string, user_agent: string, action: string}>
     */
    private function blockedAiCrawlers(mixed $policies): array
    {
        return collect(is_array($policies) ? $policies : [])
            ->filter(fn (mixed $policy): bool => is_array($policy))
            ->map(function (array $policy): ?array {
                $action = (string) ($policy['action'] ?? '');
                $userAgent = (string) ($policy['user_agent'] ?? '');
                // 只对「产品自己认定为 AI 爬虫」的 UA 报警；throttle 是限流不是禁止。
                if ($action === 'allow' || $action === 'throttle' || $userAgent === '') {
                    return null;
                }
                if (TrafficClassifier::classify($userAgent) !== TrafficClassifier::AI_BOT) {
                    return null;
                }

                return [
                    'name' => (string) ($policy['name'] ?? $userAgent),
                    'user_agent' => $userAgent,
                    'action' => $action,
                ];
            })
            ->filter()
            ->values()
            ->all();
    }
}
