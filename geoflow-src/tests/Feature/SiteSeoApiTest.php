<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\Article;
use App\Models\Author;
use App\Models\Category;
use App\Models\SiteSetting;
use App\Support\Site\SiteSettingsBag;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class SiteSeoApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config()->set('geoflow.site_url', 'https://primary.example.test');
        SiteSettingsBag::forget();
    }

    public function test_seo_draft_does_not_change_public_outputs_until_published(): void
    {
        SiteSetting::query()->create([
            'setting_key' => 'site_name',
            'setting_value' => '原站点',
        ]);
        $admin = $this->admin('seo-publisher');
        $token = $admin->createToken('seo-api', ['seo:read', 'seo:write'])->plainTextToken;

        $this->get('/robots.txt')
            ->assertOk()
            ->assertSeeText('Allow: /')
            // 2026-09-12 退役：旧后台那条 `Disallow: /legacy-admin` 已随 `admin_base_path` 机制一并移除，
            // 保护路径默认值现在只剩 `/geo_admin`（React 后台，nginx 硬编码）+ `/api` + `/storage`。
            ->assertSeeText('Disallow: /geo_admin')
            ->assertDontSeeText('Disallow: /legacy-admin');

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'seo-draft-1')
            ->patchJson('/api/v1/site/seo-config', [
                'site_title' => '新站点',
                'summary' => '仅在发布后公开',
                'allow_all_by_default' => false,
                'protected_paths' => ['/private'],
            ])
            ->assertOk()
            ->assertJsonPath('data.config.site_title', '新站点')
            ->assertJsonPath('data.config.protected_paths.0', '/geo_admin')
            ->assertJsonPath('data.config.protected_paths', fn (array $paths): bool => in_array('/private', $paths, true));

        $this->get('/robots.txt')
            ->assertOk()
            ->assertSeeText('Allow: /')
            ->assertDontSeeText('Disallow: /private');
        $this->get('/llms.txt')
            ->assertOk()
            ->assertSeeText('# 原站点')
            ->assertDontSeeText('# 新站点');

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'seo-publish-1')
            ->postJson('/api/v1/site/llms-txt/publish')
            ->assertOk()
            ->assertJsonPath('data.version', 1)
            ->assertJsonPath('data.content', fn (string $content): bool => str_contains($content, '# 新站点'))
            ->assertJsonPath('data.robots', fn (string $content): bool => str_contains($content, "Disallow: /\n") && str_contains($content, 'Disallow: /private'));

        $this->get('/robots.txt')
            ->assertOk()
            ->assertSeeText('Disallow: /')
            ->assertSeeText('Disallow: /geo_admin')
            ->assertSeeText('Disallow: /private');
        $this->get('/llms.txt')
            ->assertOk()
            ->assertSeeText('# 新站点');
    }

    public function test_seo_mutations_require_write_scope_and_idempotency_key(): void
    {
        $admin = $this->admin('seo-reader');
        $readToken = $admin->createToken('seo-read', ['seo:read'])->plainTextToken;
        $writeToken = $admin->createToken('seo-write', ['seo:read', 'seo:write'])->plainTextToken;

        $this->withToken($readToken)
            ->patchJson('/api/v1/site/seo-config', ['summary' => 'forbidden'])
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'seo:write');

        $this->withToken($writeToken)
            ->patchJson('/api/v1/site/seo-config', ['summary' => 'missing key'])
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'idempotency_key_required');

        $this->withToken($writeToken)
            ->postJson('/api/v1/site/llms-txt/publish')
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'idempotency_key_required');
    }

    private function admin(string $username): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'Password123!',
            'email' => $username.'@example.test',
            'display_name' => $username,
            'role' => 'admin',
            'status' => 'active',
        ]);
    }

    public function test_seo_audit_treats_declared_ai_crawlers_as_allowed_by_default(): void
    {
        $admin = $this->admin('seo-audit-default');
        $token = $admin->createToken('seo-api', ['seo:read'])->plainTextToken;
        $this->publishedArticle();

        $response = $this->withToken($token)->getJson('/api/v1/site/seo-audit')->assertOk();

        $policies = collect($response->json('data.robots.bot_policies'))->keyBy('user_agent');
        // 豆包的爬虫必须默认放行：挡了它就不可能被豆包引用。
        $this->assertSame('allow', $policies['Bytespider']['action']);
        $this->assertTrue($policies['Bytespider']['is_ai_crawler']);
        $this->assertSame('allow', $policies['GPTBot']['action']);
        $this->assertSame([], $response->json('data.robots.blocked_ai_crawlers'));
        $this->assertNotContains('ai_crawler_blocked', array_column($response->json('data.findings'), 'key'));
        $this->assertFalse($response->json('data.source.estimated'));
    }

    public function test_seo_audit_reports_an_ai_crawler_blocked_by_the_published_config(): void
    {
        $admin = $this->admin('seo-audit-blocked');
        $token = $admin->createToken('seo-api', ['seo:read', 'seo:write'])->plainTextToken;
        $this->publishedArticle();

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'seo-audit-block-1')
            ->patchJson('/api/v1/site/seo-config', [
                'bot_policies' => [['id' => 'bytespider', 'action' => 'disallow']],
            ])
            ->assertOk();
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'seo-audit-block-publish')
            ->postJson('/api/v1/site/llms-txt/publish')
            ->assertOk();

        $response = $this->withToken($token)->getJson('/api/v1/site/seo-audit')->assertOk();

        $blocked = $response->json('data.robots.blocked_ai_crawlers');
        $this->assertCount(1, $blocked);
        $this->assertSame('Bytespider', $blocked[0]['user_agent']);
        $this->assertSame('disallow', $blocked[0]['action']);
        $findings = collect($response->json('data.findings'))->keyBy('key');
        $this->assertTrue($findings->has('ai_crawler_blocked'));
        $this->assertStringContainsString('Bytespider', $findings['ai_crawler_blocked']['detail']);
    }

    public function test_seo_audit_requires_the_seo_read_scope(): void
    {
        $admin = $this->admin('seo-audit-scope');
        $token = $admin->createToken('wrong-scope', ['articles:read'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/site/seo-audit')
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'seo:read');
    }

    private function publishedArticle(): void
    {
        $category = Category::query()->create(['name' => '审计分类', 'slug' => 'seo-audit-category']);
        $author = Author::query()->create(['name' => '审计作者']);
        Article::query()->create([
            'title' => '审计用已发布文章',
            'slug' => 'seo-audit-article',
            'content' => '正文',
            'category_id' => $category->id,
            'author_id' => $author->id,
            'status' => 'published',
            'review_status' => 'approved',
        ]);
    }
}
