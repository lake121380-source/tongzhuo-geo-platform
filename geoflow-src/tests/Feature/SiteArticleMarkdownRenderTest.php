<?php

namespace Tests\Feature;

use App\Models\Article;
use App\Models\Author;
use App\Models\Category;
use App\Models\SiteSetting;
use App\Support\Site\ArticleHtmlPresenter;
use App\Support\Site\SiteSettingsBag;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class SiteArticleMarkdownRenderTest extends TestCase
{
    use RefreshDatabase;

    public function test_article_markdown_renders_gfm_tables_and_normalizes_legacy_image_urls(): void
    {
        $html = ArticleHtmlPresenter::markdownToHtml(<<<'MD'
## 二级标题

### 三级标题

| 指标 | 说明 |
| --- | --- |
| API | 已配置 |

![333.png](/uploads/images/2026/04/demo.png)

- [x] 已完成
MD);

        $this->assertStringContainsString('<h2>二级标题</h2>', $html);
        $this->assertStringContainsString('<h3>三级标题</h3>', $html);
        $this->assertStringContainsString('<div class="article-table-wrap"><table class="article-table">', $html);
        $this->assertStringContainsString('src="/storage/uploads/images/2026/04/demo.png"', $html);
        $this->assertStringNotContainsString('333.png', $html);
        $this->assertStringContainsString('type="checkbox"', $html);
    }

    public function test_homepage_renders_before_lead_forms_table_is_migrated(): void
    {
        Schema::dropIfExists('lead_submissions');
        Schema::dropIfExists('lead_forms');

        // 首页主区块在**默认首页**上已从「最新文章」改为「最新观点」（2026-09-16）：
        // 首页不再铺全部文章的信息流，只留 3 条精选 + 「查看全部」入口。
        // 这条断言的本意是"首页能渲染出主内容区"，键名跟着新行为走。
        $this->get(route('site.home'))
            ->assertOk()
            ->assertSee(__('site.home_insights'));
    }

    public function test_published_article_page_outputs_normalized_image_url(): void
    {
        $category = Category::query()->create([
            'name' => '科技资讯',
            'slug' => 'tech',
        ]);
        $author = Author::query()->create([
            'name' => '桐灼GEO',
        ]);
        $article = Article::query()->create([
            'title' => 'Markdown 渲染测试',
            'slug' => 'markdown-render-test',
            'excerpt' => '',
            'content' => "## 小节\n\n![333.png](uploads/images/2026/04/demo.png)\n\n| A | B |\n| --- | --- |\n| 1 | 2 |",
            'category_id' => $category->id,
            'author_id' => $author->id,
            'status' => 'published',
            'review_status' => 'approved',
            'is_ai_generated' => 1,
            'published_at' => now(),
        ]);

        $this->get(route('site.article', $article->slug))
            ->assertOk()
            ->assertSee('src="/storage/uploads/images/2026/04/demo.png"', false)
            ->assertSee('<table class="article-table">', false)
            ->assertDontSee('333.png', false);
    }

    public function test_published_article_page_uses_article_seo_metadata(): void
    {
        SiteSetting::query()->updateOrCreate(
            ['setting_key' => 'site_name'],
            ['setting_value' => '桐灼GEO Support']
        );
        SiteSetting::query()->updateOrCreate(
            ['setting_key' => 'site_description'],
            ['setting_value' => 'Default site description']
        );
        SiteSetting::query()->updateOrCreate(
            ['setting_key' => 'site_keywords'],
            ['setting_value' => 'site,default']
        );
        SiteSettingsBag::forget();

        $category = Category::query()->create([
            'name' => '科技资讯',
            'slug' => 'tech-seo',
        ]);
        $author = Author::query()->create([
            'name' => '桐灼GEO',
        ]);
        $article = Article::query()->create([
            'title' => 'Article SEO Title',
            'slug' => 'article-seo-title',
            'excerpt' => 'Article SEO Description',
            'content' => '正文',
            'keywords' => 'alpha,beta',
            'category_id' => $category->id,
            'author_id' => $author->id,
            'status' => 'published',
            'review_status' => 'approved',
            'is_ai_generated' => 1,
            'published_at' => now(),
        ]);

        $this->get(route('site.article', $article->slug))
            ->assertOk()
            ->assertSee('<title>Article SEO Title</title>', false)
            ->assertDontSee('<title>Article SEO Title - 桐灼GEO Support</title>', false)
            ->assertSee('<meta name="description" content="Article SEO Description">', false)
            ->assertSee('<meta name="keywords" content="alpha,beta">', false)
            ->assertSee('<meta property="og:title" content="Article SEO Title">', false)
            ->assertSee('<meta property="og:description" content="Article SEO Description">', false)
            ->assertSee('<meta property="og:type" content="article">', false)
            ->assertSee('<meta property="og:site_name" content="桐灼GEO Support">', false);
    }

    public function test_homepage_uses_explicit_hot_and_featured_articles(): void
    {
        $category = Category::query()->create([
            'name' => '科技资讯',
            'slug' => 'tech',
        ]);
        $author = Author::query()->create([
            'name' => '桐灼GEO',
        ]);
        Article::query()->create([
            'title' => '首页热门文章',
            'slug' => 'homepage-hot-article',
            'excerpt' => '热门摘要',
            'content' => '热门正文',
            'category_id' => $category->id,
            'author_id' => $author->id,
            'status' => 'published',
            'review_status' => 'approved',
            'is_hot' => true,
            'published_at' => now(),
        ]);
        Article::query()->create([
            'title' => '首页精选文章',
            'slug' => 'homepage-featured-article',
            'excerpt' => '精选摘要',
            'content' => '精选正文',
            'category_id' => $category->id,
            'author_id' => $author->id,
            'status' => 'published',
            'review_status' => 'approved',
            'is_featured' => true,
            'published_at' => now()->subMinute(),
        ]);

        $this->get(route('site.home'))
            ->assertOk()
            ->assertSee('热点')
            ->assertSee('首页热门文章')
            ->assertSee('精选文章')
            ->assertSee('首页精选文章');
    }

    public function test_homepage_modules_partial_tolerates_missing_article_collection(): void
    {
        $html = view('site.partials.homepage-modules', [
            'homepageModules' => [],
            'homepageStyle' => [],
            'showHomepageModules' => false,
        ])->render();

        $this->assertSame('', trim($html));
    }

    public function test_theme_sidebar_tolerates_missing_article_collection(): void
    {
        $html = view('theme.apihot-recommend-20260623.partials.sidebar', [
            'siteTitle' => '桐灼GEO',
            'showFeedPanel' => false,
        ])->render();

        $this->assertStringContainsString(__('site.home_empty_title'), $html);
    }

    public function test_frontend_category_navigation_hides_categories_without_published_articles(): void
    {
        $visibleCategory = Category::query()->create([
            'name' => '可见分类',
            'slug' => 'visible-category',
        ]);
        Category::query()->create([
            'name' => '空分类',
            'slug' => 'empty-category',
        ]);
        $draftCategory = Category::query()->create([
            'name' => '草稿分类',
            'slug' => 'draft-category',
        ]);
        $author = Author::query()->create([
            'name' => '桐灼GEO',
        ]);
        Article::query()->create([
            'title' => '已发布文章',
            'slug' => 'published-category-article',
            'excerpt' => '摘要',
            'content' => '正文',
            'category_id' => $visibleCategory->id,
            'author_id' => $author->id,
            'status' => 'published',
            'review_status' => 'approved',
            'published_at' => now(),
        ]);
        Article::query()->create([
            'title' => '草稿文章',
            'slug' => 'draft-category-article',
            'excerpt' => '摘要',
            'content' => '正文',
            'category_id' => $draftCategory->id,
            'author_id' => $author->id,
            'status' => 'draft',
            'review_status' => 'pending',
        ]);

        $this->get(route('site.home'))
            ->assertOk()
            ->assertSee('可见分类')
            ->assertDontSee('空分类')
            ->assertDontSee('草稿分类');
    }

    public function test_frontend_theme_loads_external_assets_without_inline_css(): void
    {
        $this->get(route('site.home'))
            ->assertOk()
            // 2026-09-16：前台 Tailwind 从 Play CDN 改为构建期产物（见 resources/css/site.css），
            // 文件名带哈希，所以按入口名前缀断言。这条判据的本意不变：样式是**外部资源**，
            // 不是内联 <style>，也不是远端 CDN。
            ->assertSee('build/assets/site-', false)
            ->assertSee('js/lucide.min.js', false)
            ->assertSee('themes/toutiao-news-20260426/theme.css', false)
            ->assertSee('themes/toutiao-news-20260426/theme.js', false)
            ->assertSee('application/ld+json', false)
            ->assertDontSee('cdn.tailwindcss.com', false)
            ->assertDontSee('unpkg.com/lucide', false)
            ->assertDontSee('<style>', false)
            ->assertDontSee('data-hot-carousel]).forEach', false);
    }

    public function test_homepage_renders_configured_carousel_and_keeps_the_sidebar_off(): void
    {
        SiteSetting::query()->updateOrCreate(
            ['setting_key' => 'site_name'],
            ['setting_value' => '桐灼GEO Demo']
        );
        SiteSetting::query()->updateOrCreate(
            ['setting_key' => 'site_description'],
            ['setting_value' => 'Demo homepage description']
        );
        SiteSetting::query()->updateOrCreate(
            ['setting_key' => 'home_carousel_slides'],
            ['setting_value' => json_encode([
                [
                    'image_url' => 'https://example.com/banner-one.jpg',
                    'title' => 'Banner One',
                    'link_url' => '/article/demo',
                    'enabled' => true,
                ],
            ], JSON_UNESCAPED_UNICODE)]
        );
        SiteSettingsBag::forget();

        $this->get(route('site.home'))
            ->assertOk()
            ->assertSee('data-home-poster-carousel', false)
            ->assertSee('https://example.com/banner-one.jpg', false)
            ->assertSee('Banner One')
            ->assertSee('桐灼GEO Demo')
            ->assertSee('Demo homepage description')
            // 默认首页不再有侧栏（原「桐灼GEO Feed」面板已随侧栏一起移除）：
            // 它和 hero 讲同一段话，侧栏的「最新文章」又和主列表是同一批内容。
            ->assertDontSee('桐灼GEO Feed');
    }
}
