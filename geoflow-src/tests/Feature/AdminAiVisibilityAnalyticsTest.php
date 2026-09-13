<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\AiModel;
use App\Models\AiSourceProvider;
use App\Models\AiVisibilityRun;
use App\Models\AiVisibilitySource;
use App\Models\SiteSetting;
use App\Services\Admin\Analytics\AiVisibilityAnalyticsFilter;
use App\Services\Admin\Analytics\AiVisibilityAnalyticsService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Once;
use Tests\TestCase;

class AdminAiVisibilityAnalyticsTest extends TestCase
{
    use RefreshDatabase;

    public function test_growth_center_renders_ai_visibility_dashboard_from_collected_runs(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-07-10 12:00:00'));
        config()->set('geoflow.site_name', 'GEOFlow');
        config()->set('geoflow.site_url', 'https://geoflow.example.com');
        $this->declareOwnedDomain('geoflow.example.com');
        $this->configureAiVisibilityApis();

        $this->completedRun(
            keyword: 'GEOFlow 内容工程',
            providerType: AiVisibilityRun::PROVIDER_DEEPSEEK_ANALYSIS,
            answer: 'GEOFlow 在内容工程场景中优势明显，推荐作为可靠方案。',
            sentiment: 'positive',
            completedAt: '2026-07-10 09:00:00',
            sources: [
                ['title' => 'GEOFlow 官方内容工程方案', 'domain' => 'geoflow.example.com', 'rank' => 1, 'snippet' => '官方方案可靠。'],
                ['title' => '行业分析', 'domain' => 'industry.example.com', 'rank' => 2, 'snippet' => '推荐 GEOFlow。'],
            ],
        );
        $this->completedRun(
            keyword: 'GEOFlow 内容工程',
            providerType: AiVisibilityRun::PROVIDER_DOUBAO_ARK_RESPONSES,
            answer: '内容工程工具对比中，GEOFlow 适合需要证据链的团队。',
            sentiment: 'positive',
            completedAt: '2026-07-10 10:00:00',
            sources: [
                ['title' => '第三方工具榜单', 'domain' => 'ranking.example.com', 'rank' => 1, 'snippet' => '内容工程榜单。'],
                ['title' => 'GEOFlow 案例', 'domain' => 'case.example.com', 'rank' => 3, 'snippet' => 'GEOFlow 案例。'],
            ],
        );
        $this->completedRun(
            keyword: 'AI 信源投放',
            providerType: AiVisibilityRun::PROVIDER_DOUBAO_SEARCH_CUSTOM,
            answer: 'GEOFlow 在信源投放上仍需要补充更多公开案例。',
            sentiment: 'negative',
            completedAt: '2026-07-10 11:00:00',
            sources: [
                ['title' => '信源投放风险评论', 'domain' => 'review.example.com', 'rank' => 2, 'snippet' => 'GEOFlow 公开案例不足。'],
            ],
        );

        // 旧 Blade「增长中心」页面已退役，改指 React 后台消费的同一份服务投影
        // （GET /api/v1/analytics/ai-visibility）。数据层断言原样保留；
        // 页面渲染类断言（data-* 标记、SVG、翻译文案）在 API 面上没有对应物。
        $overview = $this->withToken($this->analyticsToken())
            ->getJson('/api/v1/analytics/ai-visibility?ai_preset=14d')
            ->assertOk()
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.overview.ready', true)
            ->assertJsonPath('data.overview.configured', true)
            ->json('data.overview');

        $this->assertSame(3, $overview['polling']['sampled_runs']);
        $this->assertSame(2, $overview['polling']['today_keyword_count']);
        $this->assertEquals(25.0, $overview['kpis']['brand_visibility']);
        $this->assertEquals(25.0, $overview['kpis']['top1_rate']);
        $this->assertEquals(25.0, $overview['kpis']['top3_rate']);
        $this->assertContains('GEOFlow 内容工程', array_column($overview['keywords'], 'keyword'));
        $this->assertContains('AI 信源投放', array_column($overview['keywords'], 'keyword'));
        $this->assertContains('ranking.example.com', array_column($overview['sources'], 'domain'));
        // 旧页面按 data-analytics-series 渲染 visibility / top1 / top3 三条折线。
        foreach (['visibility', 'top1', 'top3'] as $series) {
            $this->assertArrayHasKey($series, $overview['trend'][0]);
        }
        // 旧页面渲染的 "100.0%" / "25.0%" 分别是 GEOFlow 关键词的正面率、
        // 自有域名的品牌覆盖率与总可见度。
        $this->assertEquals(100.0, collect($overview['keywords'])->firstWhere('keyword', 'GEOFlow 内容工程')['positive_rate']);
        $this->assertEquals(100.0, collect($overview['sources'])->firstWhere('domain', 'geoflow.example.com')['brand_coverage']);
        $this->assertContains('content_gap', array_column($overview['sources'], 'action'));

        Carbon::setTestNow();
    }

    public function test_configuration_status_rejects_a_search_provider_on_an_untrusted_endpoint(): void
    {
        AiSourceProvider::query()->create([
            'name' => 'Untrusted Search',
            'provider_key' => AiSourceProvider::PROVIDER_DOUBAO_SEARCH_CUSTOM,
            'endpoint_url' => 'https://attacker.example.com/search',
            'api_key' => 'stored-key',
            'daily_limit' => 10,
            'status' => 'active',
        ]);

        $overview = app(AiVisibilityAnalyticsService::class)->overview();

        $this->assertFalse($overview['configured']);
        $this->assertFalse($overview['configuration']['doubao_search_configured']);
    }

    public function test_visibility_filter_is_applied_before_daily_keyword_sampling(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-07-10 12:00:00'));
        $this->completedRun('目标关键词', AiVisibilityRun::PROVIDER_DEEPSEEK_ANALYSIS, 'GEOFlow 可见', 'positive', '2026-07-10 09:00:00', []);
        $this->completedRun('目标关键词', AiVisibilityRun::PROVIDER_DOUBAO_SEARCH_CUSTOM, '其它结果', 'neutral', '2026-07-10 10:00:00', []);
        $this->completedRun('其它关键词', AiVisibilityRun::PROVIDER_DEEPSEEK_ANALYSIS, '其它结果', 'neutral', '2026-07-10 11:00:00', []);

        $overview = app(AiVisibilityAnalyticsService::class)->overview(AiVisibilityAnalyticsFilter::fromRequest([
            'ai_preset' => 'custom',
            'ai_date_from' => '2026-07-10',
            'ai_date_to' => '2026-07-10',
            'ai_keyword' => '目标关键词',
            'ai_provider' => AiVisibilityRun::PROVIDER_DEEPSEEK_ANALYSIS,
        ]));

        $this->assertSame(1, $overview['polling']['runs']);
        $this->assertSame(1, $overview['polling']['sampled_runs']);
        $this->assertSame('目标关键词', $overview['keywords'][0]['keyword']);
        $this->assertSame([AiVisibilityRun::PROVIDER_DEEPSEEK_ANALYSIS], $overview['keywords'][0]['providers']);
    }

    public function test_ai_visibility_query_count_is_constant_for_fourteen_and_ninety_days(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-08-02 12:00:00'));
        $this->completedRun(
            keyword: 'GEOFlow 查询性能',
            providerType: AiVisibilityRun::PROVIDER_DEEPSEEK_ANALYSIS,
            answer: 'GEOFlow 可见。',
            sentiment: 'positive',
            completedAt: '2026-08-02 09:00:00',
            sources: [],
        );
        $service = app(AiVisibilityAnalyticsService::class);

        // 每次测量前 flush 请求级 once() 记忆化：真实 HTTP 请求都是冷启动，
        // 只有冷值才代表单次请求的查询预算（否则量到的是同进程内被摊薄的热值）。
        Once::flush();
        $fourteenDays = $this->queryCount(fn () => $service->overview(AiVisibilityAnalyticsFilter::fromRequest(['ai_preset' => '14d'])));
        Once::flush();
        $ninetyDays = $this->queryCount(fn () => $service->overview(AiVisibilityAnalyticsFilter::fromRequest(['ai_preset' => '90d'])));

        // 这条断言守的是「查询数不随数据规模/时间窗增长」（下面 assertSame 是真正的 N+1 守卫）。
        // 它不是生产环境的绝对上限：本夹具没有绑定模型/Provider，真实实例的 configurationStatus
        // 会多出模型解析查询。这里只做本用例内的冷值基线。
        //
        // 20 → 23 的原因（已按 SQL 日志逐条核对）：品牌归属改为只认运营方显式声明的属性后，
        // 每个请求固定多出 3 次读取——site_settings 里的品牌配置 ×1、hosted_site_profiles
        // 的 Schema::hasTable ×1 与 hostname 查询 ×1（后两者已用请求级 once() 记忆化，
        // 同一请求内不再重复）。改动前该冷值为 18，留 2 次余量；这里保持同样的余量。
        $this->assertLessThanOrEqual(23, $fourteenDays);
        $this->assertSame($fourteenDays, $ninetyDays);
    }

    public function test_analytics_queries_do_not_hydrate_large_raw_ai_payload_columns(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-08-02 12:00:00'));
        $run = $this->completedRun(
            keyword: 'GEOFlow 精简字段',
            providerType: AiVisibilityRun::PROVIDER_DEEPSEEK_ANALYSIS,
            answer: 'GEOFlow 可见。',
            sentiment: 'positive',
            completedAt: '2026-08-02 09:00:00',
            sources: [
                ['title' => 'GEOFlow 精简信源', 'domain' => 'geoflow.example.com', 'rank' => 1, 'snippet' => '官方来源。'],
            ],
        );
        $run->forceFill([
            'raw_request_json' => ['large' => str_repeat('x', 1000)],
            'raw_response_json' => ['large' => str_repeat('y', 1000)],
        ])->saveQuietly();
        $run->sources()->firstOrFail()->forceFill([
            'metadata_json' => ['large' => str_repeat('z', 1000)],
        ])->saveQuietly();

        $runAttributes = [];
        $sourceAttributes = [];
        AiVisibilityRun::retrieved(function (AiVisibilityRun $retrieved) use (&$runAttributes): void {
            $runAttributes[] = array_keys($retrieved->getAttributes());
        });
        AiVisibilitySource::retrieved(function (AiVisibilitySource $retrieved) use (&$sourceAttributes): void {
            $sourceAttributes[] = array_keys($retrieved->getAttributes());
        });

        $service = app(AiVisibilityAnalyticsService::class);
        $service->snapshot(60);
        $service->overview(AiVisibilityAnalyticsFilter::fromRequest(['ai_preset' => '60d']));

        $this->assertNotEmpty($runAttributes);
        $this->assertNotEmpty($sourceAttributes);
        foreach ($runAttributes as $attributes) {
            $this->assertNotContains('raw_request_json', $attributes);
            $this->assertNotContains('raw_response_json', $attributes);
        }
        foreach ($sourceAttributes as $attributes) {
            $this->assertNotContains('metadata_json', $attributes);
        }
    }

    public function test_ai_visibility_analytics_caps_daily_keyword_samples_at_five(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-07-10 12:00:00'));
        config()->set('geoflow.site_name', 'GEOFlow');
        config()->set('geoflow.site_url', 'https://geoflow.example.com');
        $this->declareOwnedDomain('geoflow.example.com');

        foreach (range(1, 6) as $index) {
            $this->completedRun(
                keyword: 'GEOFlow 推荐',
                providerType: AiVisibilityRun::PROVIDER_DEEPSEEK_ANALYSIS,
                answer: $index === 6 ? 'GEOFlow 是推荐方案。' : '推荐方案暂未覆盖指定品牌。',
                sentiment: 'neutral',
                completedAt: sprintf('2026-07-10 09:%02d:00', $index),
                sources: [
                    [
                        'title' => $index === 6 ? 'GEOFlow 官方说明' : '通用工具说明',
                        'domain' => $index === 6 ? 'geoflow.example.com' : 'neutral.example.com',
                        'rank' => 1,
                        'snippet' => $index === 6 ? 'GEOFlow 官方。' : '通用内容。',
                    ],
                ],
            );
        }

        $retrievedRunIds = [];
        AiVisibilityRun::retrieved(function (AiVisibilityRun $run) use (&$retrievedRunIds): void {
            $retrievedRunIds[] = (int) $run->id;
        });

        $overview = app(AiVisibilityAnalyticsService::class)->overview();

        $this->assertSame(6, $overview['polling']['completed_runs']);
        $this->assertSame(5, $overview['polling']['sampled_runs']);
        $this->assertCount(5, array_unique($retrievedRunIds));
        $this->assertSame(0.0, $overview['kpis']['brand_visibility']);
        $this->assertSame(0.0, $overview['kpis']['top1_rate']);

        Carbon::setTestNow();
    }

    public function test_ai_visibility_kpis_average_daily_keyword_metrics_not_raw_sample_volume(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-07-10 12:00:00'));
        config()->set('geoflow.site_name', 'GEOFlow');
        config()->set('geoflow.site_url', 'https://geoflow.example.com');
        $this->declareOwnedDomain('geoflow.example.com');

        foreach (range(1, 5) as $index) {
            $this->completedRun(
                keyword: 'GEOFlow 内容工程',
                providerType: AiVisibilityRun::PROVIDER_DEEPSEEK_ANALYSIS,
                answer: 'GEOFlow 是可靠的内容工程方案。',
                sentiment: 'positive',
                completedAt: sprintf('2026-07-10 09:%02d:00', $index),
                sources: [
                    ['title' => 'GEOFlow 官方方案', 'domain' => 'geoflow.example.com', 'rank' => 1, 'snippet' => 'GEOFlow 官方。'],
                ],
            );
        }
        $this->completedRun(
            keyword: 'AI 营销工具',
            providerType: AiVisibilityRun::PROVIDER_DEEPSEEK_ANALYSIS,
            answer: '这个关键词下没有出现指定品牌。',
            sentiment: 'neutral',
            completedAt: '2026-07-10 10:00:00',
            sources: [
                ['title' => '通用工具介绍', 'domain' => 'neutral.example.com', 'rank' => 1, 'snippet' => '通用内容。'],
            ],
        );

        $overview = app(AiVisibilityAnalyticsService::class)->overview();

        $this->assertSame(6, $overview['polling']['sampled_runs']);
        $this->assertSame(50.0, $overview['kpis']['brand_visibility']);
        $this->assertSame(50.0, $overview['kpis']['top1_rate']);

        Carbon::setTestNow();
    }

    public function test_ai_visibility_ignores_default_laravel_app_name_as_brand_alias(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-07-10 12:00:00'));
        config()->set('app.name', 'Laravel');
        config()->set('geoflow.site_name', 'GEOFlow');
        config()->set('geoflow.site_url', 'https://geoflow.example.com');
        $this->declareOwnedDomain('geoflow.example.com');

        $this->completedRun(
            keyword: 'PHP 内容系统',
            providerType: AiVisibilityRun::PROVIDER_DEEPSEEK_ANALYSIS,
            answer: 'Laravel 是一个可靠的 PHP 框架。',
            sentiment: 'positive',
            completedAt: '2026-07-10 10:00:00',
            sources: [
                ['title' => 'Laravel 官方文档', 'domain' => 'laravel.com', 'rank' => 1, 'snippet' => 'Laravel 框架文档。'],
            ],
        );

        $overview = app(AiVisibilityAnalyticsService::class)->overview();

        $this->assertSame(0.0, $overview['kpis']['brand_visibility']);
        $this->assertSame(0.0, $overview['kpis']['top1_rate']);

        Carbon::setTestNow();
    }

    public function test_ai_visibility_leaves_brand_metrics_uncomputable_until_the_brand_is_declared(): void
    {
        // 没有任何可核验的品牌依据（既未声明品牌名，也未声明自有域名）时，
        // 归属判定恒为 false：输出 0% 会把「无法测量」呈现成「品牌可见度为零」这一确定结论。
        Carbon::setTestNow(Carbon::parse('2026-07-10 12:00:00'));
        config()->set('app.name', 'Laravel');
        config()->set('geoflow.site_name', 'GEOFlow');
        config()->set('geoflow.site_url', 'https://geoflow.example.com');

        $this->completedRun(
            keyword: 'GEOFlow 内容工程',
            providerType: AiVisibilityRun::PROVIDER_DEEPSEEK_ANALYSIS,
            answer: 'GEOFlow 是可靠的内容工程方案。',
            sentiment: 'positive',
            completedAt: '2026-07-10 10:00:00',
            sources: [
                ['title' => 'GEOFlow 官方方案', 'domain' => 'geoflow.example.com', 'rank' => 1, 'snippet' => 'GEOFlow 官方。'],
            ],
        );

        $overview = app(AiVisibilityAnalyticsService::class)->overview();

        $this->assertFalse($overview['brand']['brand_basis']);
        $this->assertSame([], $overview['brand']['owned_hosts']);
        $this->assertNull($overview['kpis']['brand_visibility']);
        // 位次指标同样由品牌归属派生（品牌信源的位次），因此一并不可计算，
        // 而不是输出「Top1 0%」这一确定的位次结论。
        $this->assertNull($overview['kpis']['top1_rate']);
        $this->assertNull($overview['kpis']['top3_rate']);
        // 与品牌无关的情感指标仍照常计算。
        $this->assertSame(100.0, $overview['kpis']['positive_rate']);

        Carbon::setTestNow();
    }

    public function test_ai_visibility_counts_declared_owned_domain_as_brand_visibility(): void
    {
        // 显式声明 officialDomain 之后，引用该域名才计入品牌可见度。
        Carbon::setTestNow(Carbon::parse('2026-07-10 12:00:00'));
        config()->set('geoflow.site_name', 'GEOFlow');
        config()->set('geoflow.site_url', 'https://geoflow.example.com');
        $this->declareOwnedDomain('geoflow.example.com');

        $this->completedRun(
            keyword: 'GEOFlow 内容工程',
            providerType: AiVisibilityRun::PROVIDER_DEEPSEEK_ANALYSIS,
            answer: 'GEOFlow 是可靠的内容工程方案。',
            sentiment: 'positive',
            completedAt: '2026-07-10 10:00:00',
            sources: [
                ['title' => 'GEOFlow 官方方案', 'domain' => 'geoflow.example.com', 'rank' => 1, 'snippet' => 'GEOFlow 官方。'],
            ],
        );

        $overview = app(AiVisibilityAnalyticsService::class)->overview();

        $this->assertTrue($overview['brand']['brand_basis']);
        $this->assertSame(['geoflow.example.com'], $overview['brand']['owned_hosts']);
        $this->assertSame(100.0, $overview['kpis']['brand_visibility']);

        Carbon::setTestNow();
    }

    public function test_growth_center_renders_unavailable_instead_of_zero_when_brand_is_not_declared(): void
    {
        // 未声明品牌名与自有域名时，服务端页面必须显示「不可计算」，而不是渲染成 0%。
        Carbon::setTestNow(Carbon::parse('2026-07-10 12:00:00'));
        config()->set('geoflow.site_name', 'GEOFlow');
        config()->set('geoflow.site_url', 'https://geoflow.example.com');
        $this->configureAiVisibilityApis();

        $this->completedRun(
            keyword: 'GEOFlow 内容工程',
            providerType: AiVisibilityRun::PROVIDER_DEEPSEEK_ANALYSIS,
            answer: 'GEOFlow 是可靠的内容工程方案。',
            sentiment: 'positive',
            completedAt: '2026-07-10 09:00:00',
            sources: [
                ['title' => 'GEOFlow 官方方案', 'domain' => 'geoflow.example.com', 'rank' => 1, 'snippet' => 'GEOFlow 官方。'],
            ],
        );

        // 旧 Blade「增长中心」页面已退役，改指 React 后台消费的同一份服务投影。
        // 断言口径不变：无品牌依据时三项品牌指标与信源品牌覆盖必须「不可计算」(null)，
        // 而不是被渲染/输出成 0% 这一确定结论；与品牌无关的情感指标照常计算。
        $overview = $this->withToken($this->analyticsToken())
            ->getJson('/api/v1/analytics/ai-visibility?ai_preset=14d')
            ->assertOk()
            ->json('data.overview');

        $this->assertFalse($overview['brand']['brand_basis']);
        $this->assertSame([], $overview['brand']['owned_hosts']);
        $this->assertNull($overview['kpis']['brand_visibility']);
        $this->assertNull($overview['kpis']['top1_rate']);
        $this->assertNull($overview['kpis']['top3_rate']);
        // 与品牌无关的情感指标仍照常计算。
        $this->assertEquals(100.0, $overview['kpis']['positive_rate']);
        // 信源偏好卡片的「品牌覆盖」同口径不可计算，也不再给出归属结论。
        $this->assertNotSame([], $overview['sources']);
        foreach ($overview['sources'] as $source) {
            $this->assertNull($source['brand_coverage']);
            $this->assertNull($source['brand_mentions']);
            $this->assertSame('unavailable', $source['action']);
        }
        $this->assertSame([], $overview['attention_sources']);
        // 最近样本卡片的可见性不得把「无法测量」呈现成「未见」。
        $this->assertNotSame([], $overview['latest_runs']);
        foreach ($overview['latest_runs'] as $run) {
            $this->assertNull($run['brand_visible']);
            $this->assertNull($run['top1']);
            $this->assertNull($run['top3']);
        }

        Carbon::setTestNow();
    }

    public function test_ai_visibility_term_cloud_excludes_source_domain_fragments(): void
    {
        Carbon::setTestNow(Carbon::parse('2026-07-10 12:00:00'));
        config()->set('geoflow.site_name', 'GEOFlow');
        config()->set('geoflow.site_url', 'https://geoflow.example.com');

        $this->completedRun(
            keyword: 'AI 搜索品牌可见度',
            providerType: AiVisibilityRun::PROVIDER_DOUBAO_SEARCH_CUSTOM,
            answer: '内容工程和 AI 搜索需要结合知识库与信源投放。',
            sentiment: 'positive',
            completedAt: '2026-07-10 10:00:00',
            sources: [
                ['title' => 'InfoQ DeepSeek 内容工程知识库实践', 'domain' => 'juejin.cn', 'rank' => 1, 'snippet' => 'AI 搜索场景需要知识库和信源投放。'],
                ['title' => '行业语境分析', 'domain' => 'cloud.tencent.com', 'rank' => 2, 'snippet' => '内容工程覆盖品牌可见度。'],
            ],
        );

        $terms = collect(app(AiVisibilityAnalyticsService::class)->overview()['terms'])
            ->pluck('term')
            ->all();

        $this->assertContains('内容工程', $terms);
        $this->assertContains('AI 搜索', $terms);
        $this->assertNotContains('juejin', $terms);
        $this->assertNotContains('infoq', $terms);
        $this->assertNotContains('deepseek', $terms);
        $this->assertNotContains('cloud', $terms);
        $this->assertNotContains('tencent', $terms);

        Carbon::setTestNow();
    }

    /**
     * @param  list<array{title: string, domain: string, rank: int, snippet: string}>  $sources
     */
    /**
     * 自有域名必须由运营方显式声明：在品牌实体里填写 officialDomain。
     *
     * 此前这些用例靠 `geoflow.site_url` 隐式充当自有域名，于是「没做过任何声明」也会被算成
     * 自有引用、并让品牌可见度输出一个确定的百分比而不是「不可计算」。
     */
    private function declareOwnedDomain(string $host): void
    {
        SiteSetting::query()->create([
            'setting_key' => 'ai_brand_entity_config',
            'setting_value' => json_encode(['officialDomain' => $host], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        ]);
    }

    private function completedRun(
        string $keyword,
        string $providerType,
        string $answer,
        string $sentiment,
        string $completedAt,
        array $sources,
    ): AiVisibilityRun {
        $run = AiVisibilityRun::query()->create([
            'keyword' => $keyword,
            'prompt' => '请分析 '.$keyword,
            'provider_type' => $providerType,
            'provider_key' => $providerType,
            'model_id' => 'test-model',
            'status' => AiVisibilityRun::STATUS_COMPLETED,
            'answer_text' => $answer,
            'analysis_json' => ['sentiment' => $sentiment],
            'started_at' => Carbon::parse($completedAt)->subSeconds(20),
            'completed_at' => Carbon::parse($completedAt),
            'created_at' => Carbon::parse($completedAt),
            'updated_at' => Carbon::parse($completedAt),
        ]);

        foreach ($sources as $source) {
            AiVisibilitySource::query()->create([
                'ai_visibility_run_id' => (int) $run->id,
                'source_type' => 'web',
                'title' => $source['title'],
                'domain' => $source['domain'],
                'url' => 'https://'.$source['domain'].'/article',
                'snippet' => $source['snippet'],
                'rank' => $source['rank'],
            ]);
        }

        return $run;
    }

    private function configureAiVisibilityApis(): void
    {
        AiSourceProvider::query()->create([
            'name' => 'Doubao Search Custom',
            'provider_key' => AiSourceProvider::PROVIDER_DOUBAO_SEARCH_CUSTOM,
            'endpoint_url' => 'https://open.feedcoopapi.com/search_api/web_search',
            'api_key' => 'encrypted-doubao-key',
            'status' => 'active',
            'daily_limit' => 0,
            'used_today' => 0,
            'total_used' => 0,
            'metadata_json' => [
                'count' => 10,
                'search_type' => 'web',
                'need_summary' => true,
                'need_content' => true,
                'need_url' => true,
                'content_formats' => 'Markdown',
                'sites' => [],
                'block_hosts' => [],
            ],
        ]);

        $deepSeekModel = AiModel::query()->create([
            'name' => 'DeepSeek Analysis',
            'version' => 'test',
            'api_key' => 'encrypted-deepseek-key',
            'model_id' => 'deepseek-v4-flash',
            'model_type' => 'chat',
            'api_url' => 'https://api.deepseek.com',
            'failover_priority' => 45,
            'daily_limit' => 0,
            'used_today' => 0,
            'total_used' => 0,
            'status' => 'active',
        ]);

        SiteSetting::query()->updateOrCreate(
            ['setting_key' => 'ai_visibility_deepseek_analysis_model_id'],
            ['setting_value' => (string) $deepSeekModel->id],
        );
    }

    private function queryCount(callable $callback): int
    {
        DB::flushQueryLog();
        DB::enableQueryLog();
        $callback();
        $count = count(DB::getQueryLog());
        DB::disableQueryLog();

        return $count;
    }

    private function admin(): Admin
    {
        return Admin::query()->create([
            'username' => 'ai_visibility_admin',
            'password' => 'secret-123',
            'email' => 'ai-visibility-admin@example.com',
            'display_name' => 'AI Visibility Admin',
            'role' => 'super_admin',
            'status' => 'active',
        ]);
    }

    /**
     * `GET /api/v1/analytics/ai-visibility` 需要 Bearer Token + analytics:read scope。
     */
    private function analyticsToken(): string
    {
        return $this->admin()->createToken('ai-visibility-analytics', ['analytics:read'])->plainTextToken;
    }
}
