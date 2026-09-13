<?php

namespace App\Services\Site;

use App\Models\HostedSiteProfile;
use App\Support\Site\CurrentSite;
use App\Support\Site\SiteSettingsBag;

final class SiteDiscoveryRenderer
{
    public function __construct(
        private readonly CurrentSite $currentSite,
        private readonly SiteScopedArticleQuery $articles,
        private readonly SiteUrlGenerator $urls,
    ) {}

    /** @return array<string,mixed> */
    public function config(): array
    {
        $defaults = [
            'site_title' => SiteSettingsBag::get('site_name', config('geoflow.site_name', config('app.name'))),
            'summary' => SiteSettingsBag::get('site_description', config('geoflow.site_description', '')),
            'core_directives' => [],
            'allow_all_by_default' => true,
            'include_llms_txt' => true,
            'include_sitemap' => true,
            'protected_paths' => $this->requiredProtectedPaths(),
            'bot_policies' => $this->defaultBotPolicies(),
        ];
        $raw = SiteSettingsBag::get('geo_discovery_config');
        $stored = json_decode($raw, true);
        // Draft and published configuration are stored separately by the API.
        // A draft without a published snapshot must not alter the live output
        // until an explicit publish operation is completed.
        $hasVersionedState = is_array($stored)
            && (array_key_exists('config', $stored) || array_key_exists('published_config', $stored) || array_key_exists('version', $stored));
        $storedConfig = $hasVersionedState
            ? (is_array($stored['published_config'] ?? null) ? $stored['published_config'] : [])
            : (is_array($stored) ? $stored : []);

        return $this->normalizeConfig(array_replace($defaults, $storedConfig));
    }

    public function robotsText(): string
    {
        $config = $this->config();
        $lines = ['User-agent: *'];
        if (! $this->indexingAllowed() || ! (bool) $config['allow_all_by_default']) {
            $lines[] = 'Disallow: /';
        } else {
            $lines[] = 'Allow: /';
        }
        foreach ($config['protected_paths'] as $path) {
            $lines[] = 'Disallow: '.$path;
        }
        foreach ($config['bot_policies'] as $policy) {
            $lines[] = '';
            $lines[] = 'User-agent: '.$policy['user_agent'];
            if ($policy['action'] === 'disallow') {
                $lines[] = 'Disallow: /';
            } else {
                $lines[] = 'Allow: /';
            }
            if ($policy['action'] === 'throttle' && $policy['crawl_delay'] !== null) {
                $lines[] = 'Crawl-delay: '.$policy['crawl_delay'];
            }
        }
        if ((bool) $config['include_sitemap'] && $this->indexingAllowed()) {
            $lines[] = '';
            $lines[] = 'Sitemap: '.$this->urls->sitemap();
        }
        if ((bool) $config['include_llms_txt'] && $this->indexingAllowed()) {
            $lines[] = 'LLMs: '.$this->urls->url('/llms.txt');
        }

        return implode("\n", $lines)."\n";
    }

    public function llmsText(string $variant = 'short'): string
    {
        $config = $this->config();
        $articles = $this->articles->query()
            ->with(['category'])
            ->orderByDesc('published_at')
            ->orderByDesc('id')
            ->limit($variant === 'full' ? 1000 : 200)
            ->get(['id', 'slug', 'title', 'excerpt', 'content', 'updated_at']);
        $title = $this->text($config['site_title']);
        $summary = $this->text($config['summary']);
        $lines = ['# '.$title, '', '> '.$summary, ''];
        if ($config['core_directives'] !== []) {
            $lines[] = '## Retrieval and citation rules';
            foreach ($config['core_directives'] as $directive) {
                $lines[] = '- '.$directive;
            }
            $lines[] = '';
        }
        $lines[] = $variant === 'full' ? '## Published knowledge corpus' : '## Published articles';
        foreach ($articles as $article) {
            $url = $this->urls->article($article);
            $excerpt = preg_replace('/\s+/u', ' ', trim((string) $article->excerpt)) ?: '';
            $lines[] = '- ['.$this->text($article->title).']('.$url.'): '.$this->text($excerpt);
            if ($variant === 'full') {
                $lines[] = '';
                $lines[] = '<document id="'.(int) $article->id.'" url="'.$url.'">';
                $lines[] = trim((string) $article->content);
                $lines[] = '</document>';
            }
        }
        $lines[] = '';
        $lines[] = 'Generated from published content only.';

        return implode("\n", $lines)."\n";
    }

    public function sitemapXml(): string
    {
        if ($this->currentSite->isHosted()) {
            return $this->sitemapIndexXml();
        }

        $urls = [];
        if ($this->indexingAllowed()) {
            $urls[] = ['loc' => $this->urls->home(), 'lastmod' => null];
            foreach ($this->articles->query()->orderByDesc('published_at')->orderByDesc('id')->limit(5000)->get(['id', 'slug', 'updated_at']) as $article) {
                $urls[] = ['loc' => $this->urls->article($article), 'lastmod' => $article->updated_at?->toAtomString()];
            }
        }

        return $this->urlSetXml($urls);
    }

    public function sitemapShardXml(int $page): string
    {
        abort_unless($this->currentSite->isHosted() && $page > 0, 404);
        $pageCount = $this->sitemapPageCount();
        abort_if($page > $pageCount, 404);
        $urls = [];
        if ($this->indexingAllowed()) {
            $limit = $this->sitemapUrlLimit();
            $offset = max(0, (($page - 1) * $limit) - 1);
            $take = $limit - ($page === 1 ? 1 : 0);
            if ($page === 1) {
                $urls[] = ['loc' => $this->urls->home(), 'lastmod' => null];
            }
            foreach ($this->articles->query()->orderByDesc('published_at')->orderByDesc('id')->offset($offset)->limit($take)->get(['id', 'slug', 'updated_at']) as $article) {
                $urls[] = ['loc' => $this->urls->article($article), 'lastmod' => $article->updated_at?->toAtomString()];
            }
        }

        return $this->urlSetXml($urls);
    }

    public function sitemapPageCount(): int
    {
        $count = $this->indexingAllowed() ? $this->articles->query()->count() : 0;

        return max(1, (int) ceil(($count + 1) / $this->sitemapUrlLimit()));
    }

    /** @param array<string,mixed> $config @return array<string,mixed> */
    public function normalizeConfig(array $config): array
    {
        $directives = is_array($config['core_directives'] ?? null) ? $config['core_directives'] : [];
        $paths = array_merge(
            $this->requiredProtectedPaths(),
            is_array($config['protected_paths'] ?? null) ? $config['protected_paths'] : [],
        );
        $policies = is_array($config['bot_policies'] ?? null) ? $config['bot_policies'] : [];

        return [
            'site_title' => mb_substr(trim((string) ($config['site_title'] ?? '')), 0, 200),
            'summary' => mb_substr(trim((string) ($config['summary'] ?? '')), 0, 2000),
            'core_directives' => array_values(array_filter(array_map(static fn (mixed $value): string => mb_substr(trim((string) $value), 0, 500), $directives))),
            'allow_all_by_default' => (bool) ($config['allow_all_by_default'] ?? true),
            'include_llms_txt' => (bool) ($config['include_llms_txt'] ?? true),
            'include_sitemap' => (bool) ($config['include_sitemap'] ?? true),
            'protected_paths' => array_values(array_unique(array_filter(array_map(static function (mixed $value): string {
                $path = trim((string) $value);

                return $path === '' ? '' : '/'.ltrim($path, '/');
            }, $paths)))),
            'bot_policies' => $this->normalizePolicies($policies),
        ];
    }

    /** @return list<string> */
    private function requiredProtectedPaths(): array
    {
        // 2026-09-12 退役：原先这里还从 `geoflow.admin_base_path` 派生一条 `/<前缀>` 的 Disallow
        // （指向旧 Blade 后台）。那个配置项与旧后台都已删除——继续派生只会退回**硬编码兜底值**，
        // 于是公网 robots 会一直给一个已经不存在的路径加 Disallow（实测确认）。这里去掉派生。
        // `/geo_admin` 必须保留：它是 React 后台，在 nginx 里硬编码，不来自任何配置。
        return array_values(array_unique([
            '/geo_admin',
            '/api',
            '/storage',
        ]));
    }

    /** @return list<array<string,mixed>> */
    private function defaultBotPolicies(): array
    {
        return [
            ['id' => 'gptbot', 'name' => 'GPTBot', 'user_agent' => 'GPTBot', 'action' => 'allow', 'crawl_delay' => null],
            ['id' => 'perplexity', 'name' => 'PerplexityBot', 'user_agent' => 'PerplexityBot', 'action' => 'allow', 'crawl_delay' => null],
            ['id' => 'claude', 'name' => 'ClaudeBot', 'user_agent' => 'ClaudeBot', 'action' => 'allow', 'crawl_delay' => null],
            // Bytespider 是字节（豆包）的爬虫。本产品专门测量豆包等中文 AI 引擎的可见性，
            // 默认挡住它的爬虫与产品目的自相矛盾——挡了爬虫就不可能被引用。
            // 需要限流的运营方可以在配置里把它改回 disallow / throttle。
            ['id' => 'bytespider', 'name' => 'Bytespider', 'user_agent' => 'Bytespider', 'action' => 'allow', 'crawl_delay' => null],
        ];
    }

    /** @param list<mixed> $policies @return list<array<string,mixed>> */
    private function normalizePolicies(array $policies): array
    {
        $defaults = collect($this->defaultBotPolicies())->keyBy('id');
        foreach ($policies as $policy) {
            if (! is_array($policy)) {
                continue;
            }
            $id = trim((string) ($policy['id'] ?? ''));
            if ($id === '' || ! $defaults->has($id)) {
                continue;
            }
            $current = $defaults->get($id);
            $current['action'] = in_array(($policy['action'] ?? ''), ['allow', 'disallow', 'throttle'], true) ? $policy['action'] : $current['action'];
            $delay = filter_var($policy['crawl_delay'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 60]]);
            $current['crawl_delay'] = $delay === false ? null : $delay;
            $defaults->put($id, $current);
        }

        return $defaults->values()->all();
    }

    /** @param list<array{loc:string,lastmod:?string}> $urls */
    private function urlSetXml(array $urls): string
    {
        $body = '<?xml version="1.0" encoding="UTF-8"?>'."\n".'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'."\n";
        foreach ($urls as $url) {
            $body .= '  <url><loc>'.htmlspecialchars($url['loc'], ENT_XML1 | ENT_QUOTES, 'UTF-8').'</loc>';
            if ($url['lastmod'] !== null) {
                $body .= '<lastmod>'.htmlspecialchars($url['lastmod'], ENT_XML1 | ENT_QUOTES, 'UTF-8').'</lastmod>';
            }
            $body .= '</url>'."\n";
        }

        return $body."</urlset>\n";
    }

    private function sitemapIndexXml(): string
    {
        $body = '<?xml version="1.0" encoding="UTF-8"?>'."\n".'<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'."\n";
        if ($this->indexingAllowed()) {
            for ($page = 1; $page <= $this->sitemapPageCount(); $page++) {
                $body .= '  <sitemap><loc>'.htmlspecialchars($this->urls->sitemapShard($page), ENT_XML1 | ENT_QUOTES, 'UTF-8').'</loc></sitemap>'."\n";
            }
        }

        return $body."</sitemapindex>\n";
    }

    private function indexingAllowed(): bool
    {
        return ! $this->currentSite->isHosted() || $this->currentSite->profile()?->indexing_status === HostedSiteProfile::INDEXING_INDEX;
    }

    private function sitemapUrlLimit(): int
    {
        return min(50000, max(2, (int) config('geoflow.hosted_sites.sitemap_url_limit', 50000)));
    }

    private function text(mixed $value): string
    {
        return trim((string) $value);
    }
}
