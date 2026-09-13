<?php

namespace App\Services\Site;

use App\Models\Article;
use App\Models\Category;
use App\Models\DistributionChannel;
use App\Models\HostedSiteProfile;
use App\Models\SiteSetting;
use App\Support\Site\ArticleHtmlPresenter;
use App\Support\Site\CurrentSite;
use App\Support\Site\SiteSettingsBag;
use App\Support\Site\SiteThemeCatalog;
use App\Support\Site\SiteThemeViewResolver;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Schema;

/**
 * Builds a read-only projection of the currently published public site.
 *
 * The projection deliberately contains structured data instead of rendered
 * theme HTML. This keeps the admin preview auditable and prevents stored
 * article markup or generated theme files from becoming executable in the SPA.
 */
final class SitePreviewProjection
{
    private const SCHEMA_VERSION = 1;

    private const MAX_ITEMS = 24;

    private const MAX_BODY_CHARACTERS = 100_000;

    public function __construct(
        private readonly SiteScopedArticleQuery $siteArticles,
        private readonly SiteUrlGenerator $urls,
        private readonly CurrentSite $currentSite,
        private readonly SiteThemeCatalog $themes,
    ) {}

    /**
     * @return array<string,mixed>
     */
    public function build(
        string $page,
        ?int $categoryId = null,
        ?int $articleId = null,
        int $limit = 12,
        ?int $hostedSiteId = null,
    ): array {
        $limit = max(1, min(self::MAX_ITEMS, $limit));
        $settings = SiteSettingsBag::all();
        $theme = $this->themeProjection();
        $categories = $this->publishedCategories();
        $errors = [];

        $content = match ($page) {
            'category' => $this->categoryContent($categories, $categoryId, $limit, $errors),
            'article' => $this->articleContent($articleId, $errors),
            default => $this->homeContent($limit, $errors),
        };

        $site = [
            'id' => $this->currentSite->profileId(),
            'type' => $this->currentSite->type(),
            'name' => $this->setting($settings, 'site_name', (string) config('geoflow.site_name', config('app.name'))),
            'subtitle' => $this->setting($settings, 'site_subtitle'),
            'description' => $this->setting($settings, 'site_description'),
            'base_url' => $this->currentSite->baseUrl(),
            'home_url' => $this->urls->home(),
            'theme' => $theme,
        ];
        if ($this->currentSite->isHosted()) {
            $profile = $this->currentSite->profile();
            $site += [
                'hostname' => (string) ($profile?->hostname ?? $this->currentSite->hostname()),
                'serving_status' => (string) ($profile?->serving_status ?? ''),
                'indexing_status' => (string) ($profile?->indexing_status ?? ''),
                'quality_status' => (string) ($profile?->quality_status ?? ''),
                'channel_id' => $this->currentSite->channelId(),
                'channel_status' => (string) ($profile?->channel?->status ?? ''),
                'topic' => (string) ($profile?->topic ?? ''),
                'locale' => (string) ($profile?->locale ?? ''),
                'settings_version' => (int) ($profile?->settings_version ?? 0),
            ];
        } else {
            $site += [
                'hostname' => $this->currentSite->hostname(),
                'serving_status' => 'online',
                'indexing_status' => 'index',
                'quality_status' => 'passed',
                'channel_id' => null,
                'settings_version' => null,
            ];
        }
        $this->appendSiteStatusErrors($site, $errors);
        $navigation = [
            'categories' => $categories
                ->map(fn (Category $category): array => $this->categoryProjection($category))
                ->values()
                ->all(),
        ];

        $settingsUpdatedAt = $this->settingsUpdatedAt();
        $contentUpdatedAt = $this->dateString($this->siteArticles->query()->max('updated_at'));
        $publishedCount = $this->siteArticles->query()->count();
        $sourceVersion = hash('sha256', (string) json_encode([
            'schema_version' => self::SCHEMA_VERSION,
            'site' => $site,
            'settings_updated_at' => $settingsUpdatedAt,
            'content_updated_at' => $contentUpdatedAt,
            'published_count' => $publishedCount,
            'page' => $page,
            'category_id' => $categoryId,
            'article_id' => $articleId,
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

        return [
            'preview' => [
                'schema_version' => self::SCHEMA_VERSION,
                'source_version' => $sourceVersion,
                'generated_at' => now()->toIso8601String(),
                'settings_updated_at' => $settingsUpdatedAt,
                'content_updated_at' => $contentUpdatedAt,
                'dataset' => 'published',
                'read_only' => true,
                'errors' => $errors,
            ],
            'page' => [
                'type' => $page,
                'category_id' => $categoryId,
                'article_id' => $articleId,
                'limit' => $limit,
            ],
            'site' => $site,
            'selected_hosted_site_id' => $hostedSiteId,
            'navigation' => $navigation,
            'content' => $content,
        ];
    }

    /**
     * The API is normally resolved on the primary host.  When the caller
     * asks for a hosted site, the controller switches the scoped CurrentSite
     * before calling this projection; expose the selected profile's state in
     * the response without leaking credentials or arbitrary channel config.
     */
    /** @return list<array<string,mixed>> */
    public function availableSites(): array
    {
        $sites = [[
            'id' => null,
            'type' => CurrentSite::TYPE_PRIMARY,
            'name' => $this->setting(SiteSettingsBag::primaryAll(), 'site_name', (string) config('geoflow.site_name', config('app.name'))),
            'hostname' => (string) (parse_url((string) config('geoflow.site_url', config('app.url')), PHP_URL_HOST) ?: ''),
            'serving_status' => 'online',
            'indexing_status' => 'index',
            'quality_status' => 'passed',
        ]];

        if (! (bool) config('geoflow.hosted_sites.enabled', false)
            || ! Schema::hasTable('hosted_site_profiles')) {
            return $sites;
        }

        $profiles = HostedSiteProfile::query()
            ->with('channel')
            ->whereHas('channel', static fn ($query) => $query->where('channel_type', DistributionChannel::TYPE_HOSTED_SITE))
            ->orderBy('hostname')
            ->get();

        foreach ($profiles as $profile) {
            $channel = $profile->channel;
            $stored = is_array($channel?->site_settings) ? $channel->site_settings : [];
            $name = trim((string) ($stored['site_name'] ?? $channel?->name ?? $profile->hostname));
            $sites[] = [
                'id' => (int) $profile->id,
                'type' => CurrentSite::TYPE_HOSTED,
                'name' => $name !== '' ? $name : (string) $profile->hostname,
                'hostname' => (string) $profile->hostname,
                'serving_status' => (string) $profile->serving_status,
                'indexing_status' => (string) $profile->indexing_status,
                'quality_status' => (string) $profile->quality_status,
            ];
        }

        return $sites;
    }

    /** @param array<string,mixed> $site @param list<array<string,mixed>> $errors */
    private function appendSiteStatusErrors(array $site, array &$errors): void
    {
        if (($site['type'] ?? null) !== CurrentSite::TYPE_HOSTED) {
            return;
        }

        $servingStatus = (string) ($site['serving_status'] ?? '');
        if ($servingStatus === HostedSiteProfile::SERVING_MAINTENANCE) {
            $errors[] = $this->previewError('site_in_maintenance', '该 Hosted Site 当前处于维护状态，线上访问会返回 503。', 'warning');
        } elseif ($servingStatus === HostedSiteProfile::SERVING_ARCHIVED) {
            $errors[] = $this->previewError('site_archived', '该 Hosted Site 已归档，线上访问不会提供内容。', 'error');
        }

        if (($site['indexing_status'] ?? null) !== HostedSiteProfile::INDEXING_INDEX) {
            $errors[] = $this->previewError('site_noindex', '该 Hosted Site 当前禁止搜索引擎索引。', 'warning');
        }
        if (($site['quality_status'] ?? null) === HostedSiteProfile::QUALITY_BLOCKED) {
            $errors[] = $this->previewError('site_quality_blocked', '该 Hosted Site 未通过质量门禁，不能作为已验收站点发布。', 'error');
        } elseif (($site['quality_status'] ?? null) === HostedSiteProfile::QUALITY_PENDING) {
            $errors[] = $this->previewError('site_quality_pending', '该 Hosted Site 尚未完成质量检查。', 'warning');
        }
        if (($site['channel_status'] ?? null) !== null
            && ($site['channel_status'] ?? null) !== DistributionChannel::STATUS_ACTIVE) {
            $errors[] = $this->previewError('channel_not_active', '关联分发渠道当前不是启用状态。', 'warning');
        }
    }

    /** @param list<array<string,mixed>> $errors @return array<string,mixed> */
    private function homeContent(int $limit, array &$errors): array
    {
        $query = $this->orderedArticles();
        $total = (clone $query)->count();
        $items = $query->limit($limit)->get();
        if ($total === 0) {
            $errors[] = $this->previewError(
                'no_published_articles',
                '当前站点还没有公开发布的文章。',
                'warning',
            );
        }

        return [
            'title' => '最新发布',
            'total' => $total,
            'items' => $items->map(fn (Article $article): array => $this->articleSummary($article))->all(),
        ];
    }

    /**
     * @param  Collection<int,Category>  $categories
     * @param  list<array<string,mixed>>  $errors
     * @return array<string,mixed>
     */
    private function categoryContent(Collection $categories, ?int $categoryId, int $limit, array &$errors): array
    {
        $category = $categoryId !== null
            ? $categories->firstWhere('id', $categoryId)
            : $categories->first();
        if (! $category instanceof Category) {
            $errors[] = $this->previewError(
                $categoryId === null ? 'no_published_categories' : 'category_not_available',
                $categoryId === null
                    ? '当前站点还没有包含公开文章的分类。'
                    : '所选分类不存在或没有公开文章。',
                $categoryId === null ? 'warning' : 'error',
            );

            return [
                'title' => '分类',
                'total' => 0,
                'category' => null,
                'items' => [],
            ];
        }

        $query = $this->orderedArticles()->where('category_id', (int) $category->id);
        $total = (clone $query)->count();

        return [
            'title' => (string) $category->name,
            'total' => $total,
            'category' => $this->categoryProjection($category),
            'items' => $query
                ->limit($limit)
                ->get()
                ->map(fn (Article $article): array => $this->articleSummary($article))
                ->all(),
        ];
    }

    /** @param list<array<string,mixed>> $errors @return array<string,mixed> */
    private function articleContent(?int $articleId, array &$errors): array
    {
        $query = $this->orderedArticles();
        if ($articleId !== null) {
            $query->whereKey($articleId);
        }
        $article = $query->first();
        if (! $article instanceof Article) {
            $errors[] = $this->previewError(
                $articleId === null ? 'no_published_articles' : 'article_not_available',
                $articleId === null
                    ? '当前站点还没有可预览的公开文章。'
                    : '所选文章不存在或尚未公开发布。',
                $articleId === null ? 'warning' : 'error',
            );

            return [
                'title' => '文章',
                'total' => 0,
                'article' => null,
                'related_items' => [],
            ];
        }

        $body = ArticleHtmlPresenter::stripLeadingTitleHeading(
            (string) $article->content,
            (string) $article->title,
        );
        // The SPA renders this as text. Strip embedded HTML tags as an
        // additional boundary so the API never transports executable markup.
        $body = trim(strip_tags($body));
        $bodyTruncated = mb_strlen($body) > self::MAX_BODY_CHARACTERS;
        if ($bodyTruncated) {
            $body = mb_substr($body, 0, self::MAX_BODY_CHARACTERS);
        }

        $related = $this->orderedArticles()
            ->where('category_id', (int) $article->category_id)
            ->whereKeyNot((int) $article->id)
            ->limit(6)
            ->get();

        return [
            'title' => (string) $article->title,
            'total' => 1,
            'article' => $this->articleSummary($article) + [
                'body' => $body,
                'body_format' => 'markdown_text',
                'body_truncated' => $bodyTruncated,
            ],
            'related_items' => $related
                ->map(fn (Article $relatedArticle): array => $this->articleSummary($relatedArticle))
                ->all(),
        ];
    }

    /** @return Builder<Article> */
    private function orderedArticles(): Builder
    {
        return $this->siteArticles->query()
            ->with(['category:id,name,slug', 'author:id,name'])
            ->orderByDesc('published_at')
            ->orderByDesc('id');
    }

    /** @return Collection<int,Category> */
    private function publishedCategories(): Collection
    {
        return Category::query()
            ->whereHas('articles', fn (Builder $query): Builder => $this->siteArticles->apply($query))
            ->withCount([
                'articles as published_article_count' => fn (Builder $query): Builder => $this->siteArticles->apply($query),
            ])
            ->orderBy('sort_order')
            ->orderBy('name')
            ->limit(50)
            ->get();
    }

    /** @return array<string,mixed> */
    private function categoryProjection(Category $category): array
    {
        return [
            'id' => (int) $category->id,
            'name' => (string) $category->name,
            'slug' => (string) $category->slug,
            'published_article_count' => (int) ($category->published_article_count ?? 0),
            'url' => $this->urls->category($category),
        ];
    }

    /** @return array<string,mixed> */
    private function articleSummary(Article $article): array
    {
        return [
            'id' => (int) $article->id,
            'title' => (string) $article->title,
            'slug' => (string) $article->slug,
            'summary' => ArticleHtmlPresenter::cardSummary($article, 200),
            'url' => $this->urls->article($article),
            'category' => $article->category ? [
                'id' => (int) $article->category->id,
                'name' => (string) $article->category->name,
                'slug' => (string) $article->category->slug,
            ] : null,
            'author' => $article->author ? [
                'id' => (int) $article->author->id,
                'name' => (string) $article->author->name,
            ] : null,
            'keywords' => $this->keywords((string) $article->keywords),
            'view_count' => max(0, (int) $article->view_count),
            'is_featured' => (bool) $article->is_featured,
            'is_hot' => (bool) $article->is_hot,
            'published_at' => $article->published_at?->toIso8601String(),
            'updated_at' => $article->updated_at?->toIso8601String(),
        ];
    }

    /** @return array{id:string,name:string,version:string} */
    private function themeProjection(): array
    {
        $themeId = SiteThemeViewResolver::activeThemeId();
        $theme = collect($this->themes->all())->firstWhere('id', $themeId);

        return [
            'id' => $themeId,
            'name' => is_array($theme) ? (string) ($theme['name'] ?? $themeId) : $themeId,
            'version' => is_array($theme) ? (string) ($theme['version'] ?? '') : '',
        ];
    }

    /** @return list<string> */
    private function keywords(string $raw): array
    {
        $parts = preg_split('/[,，、\n]+/u', $raw) ?: [];
        $keywords = [];
        foreach ($parts as $part) {
            $keyword = trim((string) $part);
            if ($keyword !== '' && ! in_array($keyword, $keywords, true)) {
                $keywords[] = $keyword;
            }
            if (count($keywords) >= 12) {
                break;
            }
        }

        return $keywords;
    }

    /** @return array{code:string,message:string,severity:string,retryable:bool} */
    private function previewError(string $code, string $message, string $severity): array
    {
        return [
            'code' => $code,
            'message' => $message,
            'severity' => $severity,
            'retryable' => false,
        ];
    }

    /** @param array<string,string> $settings */
    private function setting(array $settings, string $key, string $default = ''): string
    {
        $value = trim((string) ($settings[$key] ?? ''));

        return $value !== '' ? $value : $default;
    }

    private function dateString(mixed $value): ?string
    {
        $value = trim((string) ($value ?? ''));

        return $value !== '' ? $value : null;
    }

    private function settingsUpdatedAt(): ?string
    {
        if ($this->currentSite->isHosted()) {
            return $this->dateString($this->currentSite->profile()?->updated_at);
        }

        return $this->dateString(SiteSetting::query()->max('updated_at'));
    }
}
