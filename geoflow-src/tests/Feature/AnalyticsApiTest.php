<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\AiVisibilityRun;
use App\Models\Article;
use App\Models\ArticleDistribution;
use App\Models\Author;
use App\Models\Category;
use App\Models\DistributionChannel;
use App\Models\Task;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Tests\TestCase;

class AnalyticsApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_analytics_requires_the_dedicated_read_scope(): void
    {
        $admin = $this->admin('analytics-scope-denied');
        $token = $admin->createToken('without-analytics', ['catalog:read'])->plainTextToken;

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson('/api/v1/analytics/overview')
            ->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden')
            ->assertJsonPath('error.details.required_scope', 'analytics:read');
    }

    public function test_analytics_overview_uses_persisted_services_and_declares_non_estimated_source(): void
    {
        $admin = $this->admin('analytics-reader');
        $token = $admin->createToken('analytics-reader', ['analytics:read'])->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson('/api/v1/analytics/overview?preset=7d')
            ->assertOk()
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.source.kind', 'geoflow_database')
            ->assertJsonPath('data.source.complete', true)
            ->assertJsonPath('data.source.estimated', false)
            ->assertJsonPath('data.range.preset', '7d')
            ->assertJsonStructure([
                'data' => [
                    'kpis',
                    'task_health',
                    'material_health',
                    'ai_health',
                    'url_import_health',
                    'traffic',
                    'ai_visibility',
                    'distribution',
                    'leads' => ['ready', 'kpis', 'trend', 'sources'],
                ],
                'meta' => ['request_id', 'timestamp'],
            ]);

        $this->assertSame('7d', $response->json('data.range.preset'));
    }

    public function test_analytics_content_and_crawler_projections_share_the_read_scope(): void
    {
        $admin = $this->admin('analytics-projections');
        $token = $admin->createToken('analytics-projections', ['analytics:read'])->plainTextToken;

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson('/api/v1/analytics/content?preset=7d')
            ->assertOk()
            ->assertJsonStructure(['data' => ['range', 'source', 'kpis', 'publication_trend', 'task_trend', 'content_funnel', 'top_content', 'ai_usage', 'category_distribution', 'performance', 'latest_articles']]);

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson('/api/v1/analytics/crawlers?preset=7d')
            ->assertOk()
            ->assertJsonStructure(['data' => ['range', 'source', 'summary']]);
    }

    public function test_visibility_distribution_and_lead_projections_keep_real_empty_states_and_redact_recent_leads(): void
    {
        $admin = $this->admin('analytics-domain-projections');
        $token = $admin->createToken('analytics-domain-projections', ['analytics:read'])->plainTextToken;
        $headers = ['Authorization' => 'Bearer '.$token];

        $this->withHeaders($headers)
            ->getJson('/api/v1/analytics/ai-visibility?preset=7d')
            ->assertOk()
            ->assertJsonPath('data.source.estimated', false)
            ->assertJsonStructure(['data' => ['range', 'source', 'overview' => ['ready', 'configured', 'kpis', 'trend', 'keywords', 'sources']]]);

        // 分发数据是**经营数据**：普通管理员读不到（与旧后台 `admin.super` 一致）。
        $this->withHeaders($headers)
            ->getJson('/api/v1/analytics/distribution?preset=7d&distribution_status=failed')
            ->assertStatus(403)
            ->assertJsonPath('error.details.required_role', 'super_admin');

        $superToken = $this->admin('analytics-domain-projections-super', 'password', 'super_admin')
            ->createToken('analytics-domain-projections-super', ['analytics:read'])->plainTextToken;
        $this->withHeaders(['Authorization' => 'Bearer '.$superToken])
            ->getJson('/api/v1/analytics/distribution?preset=7d&distribution_status=failed')
            ->assertOk()
            ->assertJsonPath('data.source.estimated', false)
            ->assertJsonPath('data.summary.status', 'failed')
            ->assertJsonStructure(['data' => ['range', 'source', 'summary' => ['ready', 'kpis', 'trend', 'channels', 'issues']]]);

        $this->withHeaders($headers)
            ->getJson('/api/v1/analytics/leads?preset=7d')
            ->assertOk()
            ->assertJsonPath('data.source.estimated', false)
            ->assertJsonMissingPath('data.summary.recent')
            ->assertJsonStructure(['data' => ['range', 'source', 'summary' => ['ready', 'kpis', 'trend', 'sources']]]);
    }

    public function test_login_scope_catalog_includes_analytics_read(): void
    {
        $admin = $this->admin('analytics-login-scope', 'correct-password');

        $this->postJson('/api/v1/auth/login', [
            'username' => $admin->username,
            'password' => 'correct-password',
        ])
            ->assertOk()
            ->assertJsonPath('success', true)
            ->assertJsonFragment(['analytics:read']);
    }

    /**
     * 分析页五个筛选控件的接口契约。判据不是「接口 200」，而是**参数必须收窄结果**：
     * 用一个绝不存在的 id 去筛，命中数必须掉到 0——若参数被静默忽略，数字会和
     * 不筛时一模一样（这正是批量 route diff 看不出来的那类缺口）。
     *
     * 注意 `channel_id` 的口径与另外三个不同：它筛的是**分发记录**，不是文章
     * （`AnalyticsOverviewService::filteredDistributions`），所以文章数不应随之变化。
     */
    public function test_analytics_filters_narrow_the_projection_instead_of_being_ignored(): void
    {
        $admin = $this->admin('analytics-filter-contract');
        $token = $admin->createToken('analytics-filter-contract', ['analytics:read'])->plainTextToken;
        $headers = ['Authorization' => 'Bearer '.$token];

        $author = Author::query()->create(['name' => '筛选用作者', 'slug' => 'filter-author', 'status' => 'active']);
        $categoryA = Category::query()->create(['name' => '筛选用甲分类', 'slug' => 'filter-cat-a', 'status' => 'active']);
        $categoryB = Category::query()->create(['name' => '筛选用乙分类', 'slug' => 'filter-cat-b', 'status' => 'active']);
        $taskA = Task::query()->create(['name' => '筛选用甲任务', 'status' => 'active']);
        $taskB = Task::query()->create(['name' => '筛选用乙任务', 'status' => 'active']);

        $articleA = $this->article($author, $categoryA, $taskA, '筛选用甲文章', 'filter-article-a');
        $articleB = $this->article($author, $categoryB, $taskB, '筛选用乙文章', 'filter-article-b');

        $channel = DistributionChannel::query()->create([
            'name' => '筛选用渠道',
            'domain' => 'filter.example.com',
            'endpoint_url' => 'https://filter.example.com',
            'status' => 'active',
        ]);
        ArticleDistribution::query()->create([
            'article_id' => (int) $articleA->id,
            'distribution_channel_id' => (int) $channel->id,
            'action' => 'publish',
            'status' => 'failed',
            'idempotency_key' => 'analytics-filter-failed',
            'created_at' => Carbon::now(),
        ]);

        // `ai_preset=30d` 是相对今天算的，采集时间必须落在窗口内。
        $this->completedRun('筛选用甲关键词', Carbon::now()->subDays(2)->toDateTimeString());
        $this->completedRun('筛选用乙关键词', Carbon::now()->subDays(2)->addMinutes(5)->toDateTimeString());

        $absent = 99999999;
        $baseline = $this->withHeaders($headers)
            ->getJson('/api/v1/analytics/overview?preset=30d')
            ->assertOk();
        $this->assertSame(2, $baseline->json('data.kpis.articles'));
        $this->assertSame(1, $baseline->json('data.kpis.distribution_failed'));

        foreach ([
            'task_id' => [$taskA->id, $taskB->id],
            'category_id' => [$categoryA->id, $categoryB->id],
            'article_id' => [$articleA->id, $articleB->id],
        ] as $parameter => [$keepId, $dropId]) {
            $kept = $this->withHeaders($headers)
                ->getJson("/api/v1/analytics/overview?preset=30d&{$parameter}={$keepId}")
                ->assertOk();
            $this->assertSame(1, $kept->json('data.kpis.articles'), "{$parameter} 应当只剩 1 篇");

            $this->withHeaders($headers)
                ->getJson("/api/v1/analytics/overview?preset=30d&{$parameter}={$dropId}")
                ->assertOk()
                ->assertJsonPath('data.kpis.articles', 1);

            $this->withHeaders($headers)
                ->getJson("/api/v1/analytics/overview?preset=30d&{$parameter}={$absent}")
                ->assertOk()
                ->assertJsonPath('data.kpis.articles', 0);
        }

        // 渠道筛选作用于分发记录：文章数不随之变化，分发失败数必须归零。
        $this->withHeaders($headers)
            ->getJson("/api/v1/analytics/overview?preset=30d&channel_id={$channel->id}")
            ->assertOk()
            ->assertJsonPath('data.kpis.distribution_failed', 1)
            ->assertJsonPath('data.kpis.articles', 2);
        $this->withHeaders($headers)
            ->getJson("/api/v1/analytics/overview?preset=30d&channel_id={$absent}")
            ->assertOk()
            ->assertJsonPath('data.kpis.distribution_failed', 0);

        // ai_keyword 是精确匹配（`where('keyword', ...)`，不是模糊搜索）。
        $unfiltered = $this->withHeaders($headers)
            ->getJson('/api/v1/analytics/ai-visibility?ai_preset=30d')
            ->assertOk();
        $this->assertEqualsCanonicalizing(
            ['筛选用甲关键词', '筛选用乙关键词'],
            array_column($unfiltered->json('data.overview.keywords'), 'keyword'),
        );

        $this->withHeaders($headers)
            ->getJson('/api/v1/analytics/ai-visibility?ai_preset=30d&ai_keyword='.rawurlencode('筛选用甲关键词'))
            ->assertOk()
            ->assertJsonCount(1, 'data.overview.keywords')
            ->assertJsonPath('data.overview.keywords.0.keyword', '筛选用甲关键词');

        // 精确匹配的负面样本：只差一个字也必须筛空，否则说明后端退回了模糊匹配。
        $this->withHeaders($headers)
            ->getJson('/api/v1/analytics/ai-visibility?ai_preset=30d&ai_keyword='.rawurlencode('筛选用甲'))
            ->assertOk()
            ->assertJsonCount(0, 'data.overview.keywords');
    }

    private function article(Author $author, Category $category, Task $task, string $title, string $slug): Article
    {
        return Article::query()->create([
            'title' => $title,
            'slug' => $slug,
            'excerpt' => '摘要',
            'content' => '正文',
            'category_id' => (int) $category->id,
            'author_id' => (int) $author->id,
            'task_id' => (int) $task->id,
            'status' => 'published',
            'review_status' => 'approved',
            'created_at' => Carbon::now(),
        ]);
    }

    private function completedRun(string $keyword, string $completedAt): void
    {
        AiVisibilityRun::query()->create([
            'keyword' => $keyword,
            'prompt' => '请分析 '.$keyword,
            'provider_type' => AiVisibilityRun::PROVIDER_DOUBAO_SEARCH_CUSTOM,
            'provider_key' => AiVisibilityRun::PROVIDER_DOUBAO_SEARCH_CUSTOM,
            'model_id' => 'test-model',
            'status' => AiVisibilityRun::STATUS_COMPLETED,
            'answer_text' => '回答',
            'analysis_json' => ['sentiment' => 'neutral'],
            'started_at' => Carbon::parse($completedAt)->subSeconds(20),
            'completed_at' => Carbon::parse($completedAt),
            'created_at' => Carbon::parse($completedAt),
            'updated_at' => Carbon::parse($completedAt),
        ]);
    }

    /**
     * 旧 Blade analytics 首页的「增长总览 + 下一步该做什么的告警条」。
     *
     * 退役时这个版面一度没有入口（服务还在、只被已删的 Blade 控制器引用），哥哥拍板补回。
     * 这条测试守两件事：**未声明品牌时品牌指标必须是 null 而不是 0**（不能把「无法测量」
     * 呈现成「品牌可见度为零」），以及**告警条的链接必须是 React 页签深链**——
     * 它原先指向 `route('admin.*')`，那批路由已删、`route()` 会抛异常。
     */
    public function test_growth_overview_reports_uncomputable_brand_metrics_and_links_to_admin_tabs(): void
    {
        $admin = $this->admin('growth-overview-reader');
        $token = $admin->createToken('growth-overview', ['analytics:read'])->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson('/api/v1/analytics/growth-overview')
            ->assertOk()
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.source.estimated', false)
            ->assertJsonStructure(['data' => ['metrics' => [
                'today_visits', 'published_7d', 'brand_visibility_60d', 'new_leads', 'pending_followups',
            ], 'cards', 'alert']]);

        // 未声明品牌实体 → 不可计算，必须是 null（不是 0.0）。
        self::assertNull($response->json('data.metrics.brand_visibility_60d'));

        $alert = $response->json('data.alert');
        self::assertIsArray($alert, '没有启用表单时应给出「去建表单」的告警');
        self::assertSame('no_forms', $alert['type']);
        self::assertStringStartsWith('/geo_admin?tab=', (string) $alert['href']);
        parse_str((string) parse_url((string) $alert['href'], PHP_URL_QUERY), $linkQuery);
        self::assertSame('leads', $linkQuery['tab'] ?? null);
    }

    public function test_growth_overview_requires_the_dedicated_read_scope(): void
    {
        $admin = $this->admin('growth-overview-denied');
        $token = $admin->createToken('without-analytics', ['catalog:read'])->plainTextToken;

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson('/api/v1/analytics/growth-overview')
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'analytics:read');
    }

    private function admin(string $username, string $password = 'password', string $role = 'admin'): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => $password,
            'email' => $username.'@example.test',
            'display_name' => $username,
            'role' => $role,
            'status' => 'active',
        ]);
    }
}
