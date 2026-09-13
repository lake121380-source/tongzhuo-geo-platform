<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\Article;
use App\Models\Author;
use App\Models\Category;
use App\Models\DistributionChannel;
use App\Models\HostedSiteArticleAssignment;
use App\Models\HostedSiteProfile;
use App\Models\SiteSetting;
use App\Models\Task;
use App\Support\Site\SiteSettingsBag;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class SitePreviewApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config()->set('geoflow.hosted_sites.primary_hosts', ['localhost']);
        config()->set('geoflow.hosted_sites.enabled', true);
        config()->set('geoflow.hosted_sites.root_domains', ['sites.test']);
        config()->set('geoflow.site_url', 'https://primary.example.test');
        SiteSettingsBag::forget();
    }

    public function test_preview_requires_existing_seo_read_scope(): void
    {
        $admin = $this->admin('preview_scope_admin');
        $wrongScope = $admin->createToken('wrong-scope', ['articles:read'])->plainTextToken;

        $this->getJson('/api/v1/site/preview')
            ->assertUnauthorized();
        $this->withToken($wrongScope)
            ->getJson('/api/v1/site/preview')
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'seo:read');
    }

    public function test_home_preview_is_a_versioned_read_only_projection_of_published_content(): void
    {
        $admin = $this->admin('preview_home_admin');
        $token = $admin->createToken('preview-read', ['seo:read'])->plainTextToken;
        SiteSetting::query()->updateOrCreate(['setting_key' => 'site_name'], ['setting_value' => '真实企业站']);
        SiteSetting::query()->updateOrCreate([
            'setting_key' => 'active_theme',
        ], ['setting_value' => 'geoflow-template-01-ink-editorial']);
        [$published, $category] = $this->article('公开文章', 'published-article', 'published', '<script>alert(1)</script>\n公开正文');
        $this->article('内部草稿', 'draft-article', 'draft', '草稿正文', $category);

        $response = $this->withToken($token)
            ->getJson('/api/v1/site/preview?page=home&limit=6')
            ->assertOk()
            ->assertJsonPath('data.preview.schema_version', 1)
            ->assertJsonPath('data.preview.dataset', 'published')
            ->assertJsonPath('data.preview.read_only', true)
            ->assertJsonPath('data.page.type', 'home')
            ->assertJsonPath('data.site.name', '真实企业站')
            ->assertJsonPath('data.site.theme.id', 'geoflow-template-01-ink-editorial')
            ->assertJsonPath('data.content.total', 1)
            ->assertJsonPath('data.content.items.0.id', (int) $published->id)
            ->assertJsonMissing(['内部草稿', 'draft-article'])
            ->assertJsonStructure([
                'data' => [
                    'preview' => [
                        'source_version',
                        'generated_at',
                        'settings_updated_at',
                        'content_updated_at',
                        'errors',
                    ],
                    'site' => ['type', 'name', 'base_url', 'home_url', 'theme'],
                    'navigation' => ['categories'],
                    'content' => ['title', 'total', 'items'],
                ],
                'meta' => ['request_id', 'timestamp'],
            ]);

        $this->assertMatchesRegularExpression('/^[a-f0-9]{64}$/', (string) $response->json('data.preview.source_version'));
        $this->assertSame(7, (int) $published->fresh()->view_count);
    }

    public function test_category_and_article_preview_use_published_records_without_returning_html(): void
    {
        $admin = $this->admin('preview_detail_admin');
        $token = $admin->createToken('preview-read', ['seo:read'])->plainTextToken;
        [$article, $category] = $this->article(
            '安全预览文章',
            'safe-preview-article',
            'published',
            "# 安全预览文章\n\n<script>alert('x')</script>\n正文段落",
        );
        [$related] = $this->article('同类相关文章', 'related-preview-article', 'published', '同类正文', $category);
        $otherCategory = Category::query()->create(['name' => '其他分类', 'slug' => 'other-category']);
        $this->article('其他文章', 'other-article', 'published', '其他正文', $otherCategory);

        $this->withToken($token)
            ->getJson('/api/v1/site/preview?page=category&category_id='.$category->id)
            ->assertOk()
            ->assertJsonPath('data.content.category.id', (int) $category->id)
            ->assertJsonPath('data.content.total', 2)
            ->assertJsonCount(2, 'data.content.items')
            ->assertJsonMissing(['其他文章']);

        $response = $this->withToken($token)
            ->getJson('/api/v1/site/preview?page=article&article_id='.$article->id)
            ->assertOk()
            ->assertJsonPath('data.content.article.id', (int) $article->id)
            ->assertJsonPath('data.content.article.body_format', 'markdown_text')
            ->assertJsonPath('data.content.article.body_truncated', false)
            ->assertJsonPath('data.content.related_items.0.id', (int) $related->id);

        $body = (string) $response->json('data.content.article.body');
        $this->assertStringContainsString('正文段落', $body);
        $this->assertStringNotContainsString('<script', $body);
        $this->assertStringNotContainsString('<html', strtolower($response->getContent()));
        $this->assertSame(7, (int) $article->fresh()->view_count);
    }

    public function test_empty_and_unavailable_selections_return_explicit_preview_errors(): void
    {
        $admin = $this->admin('preview_empty_admin');
        $token = $admin->createToken('preview-read', ['seo:read'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/site/preview?page=home')
            ->assertOk()
            ->assertJsonPath('data.content.total', 0)
            ->assertJsonPath('data.preview.errors.0.code', 'no_published_articles');

        $this->withToken($token)
            ->getJson('/api/v1/site/preview?page=article&article_id=999999')
            ->assertOk()
            ->assertJsonPath('data.content.article', null)
            ->assertJsonPath('data.preview.errors.0.code', 'article_not_available');

        $this->withToken($token)
            ->getJson('/api/v1/site/preview?page=unsupported')
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'validation_failed');
    }

    public function test_hosted_site_preview_uses_only_assigned_public_content_and_exposes_lifecycle_state(): void
    {
        $admin = $this->admin('preview_hosted_admin');
        $token = $admin->createToken('preview-read', ['seo:read'])->plainTextToken;
        $channel = DistributionChannel::query()->create([
            'name' => 'Hosted Alpha',
            'domain' => 'alpha.sites.test',
            'endpoint_url' => 'https://alpha.sites.test',
            'channel_type' => DistributionChannel::TYPE_HOSTED_SITE,
            'status' => DistributionChannel::STATUS_PAUSED,
            'template_key' => 'geoflow-template-01-ink-editorial',
            'site_settings' => ['site_name' => 'Alpha 真实站点'],
        ]);
        $profile = HostedSiteProfile::query()->create([
            'distribution_channel_id' => $channel->id,
            'hostname' => 'alpha.sites.test',
            'root_domain' => 'sites.test',
            'topic' => '企业 GEO',
            'serving_status' => HostedSiteProfile::SERVING_ONLINE,
            'indexing_status' => HostedSiteProfile::INDEXING_NOINDEX,
            'quality_status' => HostedSiteProfile::QUALITY_PENDING,
        ]);
        $task = Task::query()->create([
            'name' => 'Hosted preview task',
            'status' => 'active',
            'publish_scope' => 'distribution_only',
        ]);
        [$assigned] = $this->article('Alpha 公开文章', 'alpha-public', 'private', 'Alpha 正文');
        $assigned->forceFill([
            'task_id' => $task->id,
            'review_status' => 'approved',
            'published_at' => now(),
        ])->save();
        HostedSiteArticleAssignment::query()->create([
            'article_id' => $assigned->id,
            'hosted_site_profile_id' => $profile->id,
            'status' => HostedSiteArticleAssignment::STATUS_PUBLISHED,
            'content_fingerprint' => hash('sha256', 'alpha-public'),
            'capacity_date' => now()->toDateString(),
            'assigned_at' => now(),
            'published_at' => now(),
        ]);
        $this->article('主站公开文章', 'primary-only', 'published', '主站正文');

        $this->withToken($token)
            ->getJson('/api/v1/site/preview?page=home&hosted_site_id='.$profile->id)
            ->assertOk()
            ->assertJsonPath('data.selected_hosted_site_id', (int) $profile->id)
            ->assertJsonPath('data.site.id', (int) $profile->id)
            ->assertJsonPath('data.site.type', 'hosted')
            ->assertJsonPath('data.site.name', 'Alpha 真实站点')
            ->assertJsonPath('data.site.base_url', 'https://alpha.sites.test')
            ->assertJsonPath('data.site.theme.id', 'geoflow-template-01-ink-editorial')
            ->assertJsonPath('data.site.serving_status', 'online')
            ->assertJsonPath('data.site.indexing_status', 'noindex')
            ->assertJsonPath('data.site.channel_status', 'paused')
            ->assertJsonPath('data.content.total', 1)
            ->assertJsonPath('data.content.items.0.id', (int) $assigned->id)
            ->assertJsonPath('data.preview.errors.0.code', 'site_noindex')
            ->assertJsonPath('data.preview.errors.1.code', 'site_quality_pending')
            ->assertJsonPath('data.preview.errors.2.code', 'channel_not_active')
            ->assertJsonPath('data.available_sites.1.id', (int) $profile->id)
            ->assertJsonMissing(['主站公开文章', 'primary-only']);

        $this->withToken($token)
            ->getJson('/api/v1/site/preview?hosted_site_id=999999')
            ->assertNotFound()
            ->assertJsonPath('error.code', 'hosted_site_not_found');
    }

    private function admin(string $username): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'Password123!',
            'email' => $username.'@example.test',
            'display_name' => 'Preview Admin',
            'role' => 'admin',
            'status' => 'active',
        ]);
    }

    /** @return array{Article,Category} */
    private function article(
        string $title,
        string $slug,
        string $status,
        string $content,
        ?Category $category = null,
    ): array {
        $category ??= Category::query()->create([
            'name' => '预览分类',
            'slug' => 'preview-category-'.strtolower(substr(hash('sha256', $slug), 0, 8)),
        ]);
        $author = Author::query()->firstOrCreate(
            ['email' => 'preview-author@example.test'],
            ['name' => '预览作者'],
        );
        $article = Article::query()->create([
            'title' => $title,
            'slug' => $slug,
            'excerpt' => $title.'摘要',
            'content' => $content,
            'category_id' => $category->id,
            'author_id' => $author->id,
            'keywords' => 'GEO,企业内容',
            'status' => $status,
            'review_status' => $status === 'published' ? 'approved' : 'pending',
            'view_count' => 7,
            'published_at' => $status === 'published' ? now() : null,
        ]);

        return [$article, $category];
    }
}
