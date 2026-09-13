<?php

namespace Tests\Feature;

use App\Contracts\GeoFlow\AiVisibilityCollector;
use App\Models\Admin;
use App\Models\AiVisibilityRun;
use App\Models\AiVisibilitySource;
use App\Models\Article;
use App\Models\Author;
use App\Models\Category;
use App\Models\DistributionChannel;
use App\Models\HostedSiteProfile;
use App\Models\Keyword;
use App\Models\KeywordLibrary;
use App\Models\LeadSubmission;
use App\Models\QueryRadarDraftEvidence;
use App\Models\SiteSetting;
use App\Support\Site\BrandIdentity;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Mockery;
use RuntimeException;
use Tests\TestCase;

class AiResearchApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_research_reads_require_analytics_scope(): void
    {
        $admin = $this->admin('research-scope-reader');
        $token = $admin->createToken('wrong-scope', ['articles:read'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/ai-research/query-radar')
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'analytics:read');
    }

    public function test_query_radar_projects_persisted_keywords_and_visibility_sources(): void
    {
        // 自有域名只认运营方显式声明的 officialDomain：站点默认地址不再算作自有域名。
        SiteSetting::query()->create([
            'setting_key' => 'ai_brand_entity_config',
            'setting_value' => json_encode(['organizationName' => '桐灼GEO', 'officialDomain' => 'brand.example.test'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        ]);
        // 站点默认地址设成一条真实存在的引用主机：若它被重新当作自有域名，下面的
        // owned_observation_count / owned_share_percent 会立刻改变，断言才具备证伪能力。
        config()->set('geoflow.site_url', 'https://deployment-default.example.test');
        $admin = $this->admin('research-query-reader');
        $token = $admin->createToken('analytics-reader', ['analytics:read'])->plainTextToken;
        $library = KeywordLibrary::query()->create(['name' => '研究词库', 'description' => '', 'keyword_count' => 1]);
        $keyword = Keyword::query()->create([
            'library_id' => $library->id,
            'keyword' => '企业 GEO 平台',
            'usage_count' => 40,
            'used_count' => 2,
        ]);
        $run = $this->visibilityRun('企业 GEO 平台', '已完成回答');
        AiVisibilitySource::query()->create([
            'ai_visibility_run_id' => $run->id,
            'title' => '竞品指南',
            'url' => 'https://competitor.example.test/guide',
            'domain' => 'competitor.example.test',
            'site_name' => '竞品站',
            'snippet' => '证据摘要',
            'rank' => 1,
        ]);
        AiVisibilitySource::query()->create([
            'ai_visibility_run_id' => $run->id,
            'title' => '品牌官方指南',
            'url' => 'https://docs.brand.example.test/guide',
            'domain' => 'docs.brand.example.test',
            'site_name' => '品牌官网',
            'snippet' => '官方事实',
            'rank' => 2,
        ]);
        AiVisibilitySource::query()->create([
            'ai_visibility_run_id' => $run->id,
            'title' => '部署默认域名上的页面',
            'url' => 'https://deployment-default.example.test/page',
            'domain' => 'deployment-default.example.test',
            'site_name' => '部署默认站',
            'snippet' => '非声明域名',
            'rank' => 3,
        ]);

        $this->withToken($token)
            ->getJson('/api/v1/ai-research/query-radar?days=30')
            ->assertOk()
            ->assertJsonPath('data.source', 'geoflow_database')
            ->assertJsonPath('data.items.0.keyword_id', (int) $keyword->id)
            ->assertJsonPath('data.items.0.query', '企业 GEO 平台')
            ->assertJsonPath('data.items.0.sample.external_volume', null)
            ->assertJsonPath('data.items.0.sample.external_volume_status', 'not_collected')
            ->assertJsonPath('data.items.0.observations.run_count', 1)
            ->assertJsonPath('data.items.0.observations.completed_run_count', 1)
            ->assertJsonPath('data.items.0.citations.observation_count', 3)
            // 只有 officialDomain（含子域）算自有：部署默认地址那条不算。
            ->assertJsonPath('data.items.0.citations.owned_observation_count', 1)
            ->assertJsonPath('data.items.0.citations.owned_share_percent', 33.3)
            ->assertJsonPath('data.items.0.citations.denominator', 3)
            ->assertJsonPath('data.ownership.owned_hosts', ['brand.example.test'])
            ->assertJsonPath('data.items.0.latest_answer.run_id', (int) $run->id)
            ->assertJsonPath('data.items.0.latest_answer.sources.1.owned', true)
            ->assertJsonPath('data.items.0.latest_answer.sources.2.owned', false)
            ->assertJsonPath('data.definitions.opportunity_score', '未定义可信模型和分母，当前不计算机会指数。')
            ->assertJsonMissingPath('data.items.0.searchVolumeScore')
            ->assertJsonMissingPath('data.items.0.geoOpportunityScore');
    }

    public function test_query_radar_leaves_uncollected_metrics_unavailable_instead_of_inventing_scores(): void
    {
        // 未声明品牌实体时自有域名不可计算——即便部署本身有站点地址（此前会被当作自有域名）。
        config()->set('geoflow.site_url', 'http://localhost:18080');
        config()->set('app.url', 'http://localhost:18080');
        $admin = $this->admin('research-query-empty');
        $token = $admin->createToken('analytics-reader', ['analytics:read'])->plainTextToken;
        $library = KeywordLibrary::query()->create(['name' => '待采集问题', 'description' => '', 'keyword_count' => 1]);
        Keyword::query()->create(['library_id' => $library->id, 'keyword' => '尚未采集的问题', 'usage_count' => 99, 'used_count' => 12]);

        $this->withToken($token)
            ->getJson('/api/v1/ai-research/query-radar')
            ->assertOk()
            ->assertJsonPath('data.ownership.configured', false)
            ->assertJsonPath('data.items.0.sample.internal_usage_count', 99)
            ->assertJsonPath('data.items.0.sample.external_volume', null)
            ->assertJsonPath('data.items.0.status', 'not_collected')
            ->assertJsonPath('data.items.0.citations.owned_share_percent', null)
            ->assertJsonPath('data.items.0.citations.availability', 'not_collected')
            ->assertJsonPath('data.items.0.draft_ready', false);
    }

    public function test_query_radar_measures_brand_mention_only_from_configured_brand_names(): void
    {
        $admin = $this->admin('research-mention-configured');
        $token = $admin->createToken('analytics-reader', ['analytics:read'])->plainTextToken;
        SiteSetting::query()->create([
            'setting_key' => 'ai_brand_entity_config',
            'setting_value' => json_encode(['organizationName' => '桐灼GEO'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        ]);
        $library = KeywordLibrary::query()->create(['name' => '品牌提及词库', 'description' => '', 'keyword_count' => 1]);
        Keyword::query()->create(['library_id' => $library->id, 'keyword' => '国内做 GEO 的公司有哪些', 'usage_count' => 0, 'used_count' => 0]);
        $this->visibilityRun('国内做 GEO 的公司有哪些', '推荐桐灼GEO，另有其他服务商可供比较。');
        $this->visibilityRun('国内做 GEO 的公司有哪些', '回答中没有出现被测量的品牌。');

        $this->withToken($token)
            ->getJson('/api/v1/ai-research/query-radar')
            ->assertOk()
            ->assertJsonPath('data.brand.configured', true)
            ->assertJsonPath('data.brand.names.0', '桐灼GEO')
            ->assertJsonPath('data.items.0.mentions.observed_answer_count', 2)
            ->assertJsonPath('data.items.0.mentions.mentioned_answer_count', 1)
            ->assertJsonPath('data.items.0.mentions.mention_rate_percent', 50)
            ->assertJsonPath('data.items.0.mentions.denominator', 2)
            ->assertJsonPath('data.items.0.mentions.availability', 'available')
            ->assertJsonPath('data.summary.mentioned_answer_count', 1);
    }

    public function test_owned_hosts_come_from_declared_properties_only(): void
    {
        // 自有域名 = 运营方声明的 officialDomain + 其主动开通的 Hosted Site。
        // 部署默认地址（site_url / app.url）不算：否则未做任何声明也会报「已配置」，
        // 同一条引用还会在不同看板里得到互相矛盾的归属。
        config()->set('geoflow.site_url', 'https://deployment-default.example.test');
        config()->set('app.url', 'https://deployment-default.example.test');
        $channel = DistributionChannel::query()->create([
            'name' => 'Acme hosted site',
            'domain' => 'acme.sites.test',
            'endpoint_url' => 'https://acme.sites.test',
            'channel_type' => DistributionChannel::TYPE_HOSTED_SITE,
            'status' => DistributionChannel::STATUS_PAUSED,
            'template_key' => 'default',
            'site_settings' => [
                'site_name' => 'Acme site',
                'site_description' => 'Description',
                'about_title' => 'About Acme',
                'about_content' => 'Acme site information.',
                'contact_email' => 'acme@example.test',
            ],
        ]);
        HostedSiteProfile::query()->create([
            'distribution_channel_id' => $channel->id,
            'hostname' => 'acme.sites.test',
            'root_domain' => 'sites.test',
            'topic' => 'AI',
            'min_publish_interval_minutes' => 0,
        ]);
        SiteSetting::query()->create([
            'setting_key' => 'ai_brand_entity_config',
            'setting_value' => json_encode(['organizationName' => 'Acme', 'officialDomain' => 'acme.example.test'], JSON_UNESCAPED_UNICODE),
        ]);

        $this->assertSame(['acme.example.test', 'acme.sites.test'], BrandIdentity::ownedHosts());

        // 查询雷达与竞品雷达必须看到同一份自有域名清单。
        $admin = $this->admin('research-owned-hosts');
        $token = $admin->createToken('analytics-reader', ['analytics:read'])->plainTextToken;
        $this->withToken($token)
            ->getJson('/api/v1/ai-research/query-radar')
            ->assertOk()
            ->assertJsonPath('data.ownership.configured', true)
            ->assertJsonPath('data.ownership.owned_hosts', ['acme.example.test', 'acme.sites.test']);
        $this->withToken($token)
            ->getJson('/api/v1/ai-research/competitor')
            ->assertOk()
            ->assertJsonPath('data.summary.own_brand_configured', true)
            ->assertJsonPath('data.config.own_brand.domains', ['acme.example.test', 'acme.sites.test']);
    }

    public function test_query_radar_treats_missing_brand_configuration_as_uncomputable(): void
    {
        $admin = $this->admin('research-mention-unconfigured');
        $token = $admin->createToken('analytics-reader', ['analytics:read'])->plainTextToken;
        $library = KeywordLibrary::query()->create(['name' => '未配置品牌词库', 'description' => '', 'keyword_count' => 1]);
        Keyword::query()->create(['library_id' => $library->id, 'keyword' => '未配置品牌的问题', 'usage_count' => 0, 'used_count' => 0]);
        $this->visibilityRun('未配置品牌的问题', '这段回答提到了 GEOFlow 这个内置默认名。');

        $this->withToken($token)
            ->getJson('/api/v1/ai-research/query-radar')
            ->assertOk()
            ->assertJsonPath('data.brand.configured', false)
            ->assertJsonPath('data.brand.names', [])
            ->assertJsonPath('data.items.0.mentions.observed_answer_count', 1)
            ->assertJsonPath('data.items.0.mentions.mentioned_answer_count', null)
            ->assertJsonPath('data.items.0.mentions.mention_rate_percent', null)
            ->assertJsonPath('data.items.0.mentions.availability', 'brand_not_configured')
            ->assertJsonPath('data.summary.mentioned_answer_count', null);
    }

    public function test_query_collection_requires_dedicated_scope_and_replays_persisted_run(): void
    {
        $admin = $this->admin('research-query-collector');
        $readToken = $admin->createToken('analytics-reader', ['analytics:read'])->plainTextToken;
        $collectToken = $admin->createToken('analytics-collector', ['analytics:collect'])->plainTextToken;
        $library = KeywordLibrary::query()->create(['name' => '采集问题', 'description' => '', 'keyword_count' => 1]);
        $keyword = Keyword::query()->create(['library_id' => $library->id, 'keyword' => '真实采集问题', 'usage_count' => 0, 'used_count' => 0]);
        $run = $this->visibilityRun('真实采集问题', '已持久化回答');
        $collector = Mockery::mock(AiVisibilityCollector::class);
        $collector->shouldReceive('collect')->once()->andReturn(['search_run' => $run]);
        $this->app->instance(AiVisibilityCollector::class, $collector);
        $payload = ['query' => '真实采集问题', 'keyword_id' => (int) $keyword->id];

        $this->withToken($readToken)
            ->withHeader('X-Idempotency-Key', 'query-collect-wrong-scope')
            ->postJson('/api/v1/ai-research/query-radar/collect', $payload)
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'analytics:collect');
        $first = $this->withToken($collectToken)
            ->withHeader('X-Idempotency-Key', 'query-collect-replay')
            ->postJson('/api/v1/ai-research/query-radar/collect', $payload)
            ->assertCreated()
            ->assertJsonPath('data.runs.0.id', (int) $run->id);
        $second = $this->withToken($collectToken)
            ->withHeader('X-Idempotency-Key', 'query-collect-replay')
            ->postJson('/api/v1/ai-research/query-radar/collect', $payload)
            ->assertCreated()
            ->assertJsonPath('data.runs.0.id', (int) $run->id);

        $this->assertSame($first->json('data.runs.0.id'), $second->json('data.runs.0.id'));
    }

    public function test_query_draft_requires_real_citations_and_persists_traceable_evidence(): void
    {
        $admin = $this->admin('research-draft-writer');
        $token = $admin->createToken('article-writer', ['articles:write'])->plainTextToken;
        $library = KeywordLibrary::query()->create(['name' => '研究词库', 'description' => '', 'keyword_count' => 1]);
        $keyword = Keyword::query()->create(['library_id' => $library->id, 'keyword' => 'GEO 平台', 'usage_count' => 0, 'used_count' => 0]);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'query-draft-without-evidence')
            ->postJson('/api/v1/ai-research/query-radar/draft', ['query' => 'GEO 平台', 'keyword_id' => $keyword->id])
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'query_radar_evidence_required');

        $run = $this->visibilityRun('GEO 平台', '真实模型返回的回答。');
        $source = AiVisibilitySource::query()->create([
            'ai_visibility_run_id' => $run->id,
            'title' => '真实引用',
            'url' => 'https://evidence.example.test/source',
            'domain' => 'evidence.example.test',
            'rank' => 1,
        ]);
        $category = Category::query()->create(['name' => '研究分类', 'slug' => 'research']);
        $author = Author::query()->create(['name' => '研究作者']);
        $payload = ['query' => 'GEO 平台', 'keyword_id' => $keyword->id, 'category_id' => $category->id, 'author_id' => $author->id, 'days' => 30];
        $first = $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'query-draft-replay')
            ->postJson('/api/v1/ai-research/query-radar/draft', $payload)
            ->assertCreated()
            ->assertJsonPath('data.evidence.run_count', 1)
            ->assertJsonPath('data.evidence.citation_count', 1);
        $articleId = (int) $first->json('data.article.id');
        $second = $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'query-draft-replay')
            ->postJson('/api/v1/ai-research/query-radar/draft', $payload)
            ->assertCreated()
            ->assertJsonPath('data.article.id', $articleId);

        $article = Article::query()->findOrFail($articleId);
        $this->assertSame('GEO 平台', $article->title);
        $this->assertSame('GEO 平台', $article->keywords);
        $this->assertSame('GEO 平台', $article->original_keyword);
        $this->assertSame('pending', $article->review_status);
        $this->assertStringContainsString('真实模型返回的回答。', (string) $article->content);
        $this->assertStringContainsString('https://evidence.example.test/source', (string) $article->content);
        $evidence = QueryRadarDraftEvidence::query()->where('article_id', $articleId)->firstOrFail();
        $this->assertSame([(int) $run->id], $evidence->run_ids);
        $this->assertSame((int) $source->id, $evidence->evidence_snapshot['runs'][0]['sources'][0]['source_id']);
    }

    public function test_brand_entity_save_persists_config_and_replays(): void
    {
        $admin = $this->admin('research-brand-writer');
        $token = $admin->createToken('seo-writer', ['seo:write'])->plainTextToken;
        $payload = [
            'config' => [
                'organizationName' => '桐灼GEO',
                'legalName' => '桐灼科技有限公司',
                'officialDomain' => 'https://geo.example.test',
                'contactEmail' => 'hello@geo.example.test',
                'sameAsLinks' => [['url' => 'https://www.linkedin.com/company/tongzhuo']],
                'founders' => ['张三'],
            ],
        ];

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'brand-config-replay')
            ->postJson('/api/v1/ai-research/brand-entity', $payload)
            ->assertOk()
            ->assertJsonPath('data.config.organizationName', '桐灼GEO')
            ->assertJsonPath('data.eeatReport.brandOverallScore', null)
            ->assertJsonPath('data.eeatReport.score_status', 'not_computable')
            ->assertJsonPath('data.eeatReport.configured_fields.officialDomain', true)
            ->assertJsonPath('data.eeatReport.configured_fields.legalName', true)
            ->assertJsonPath('data.eeatReport.counts.same_as_link_count', 1)
            ->assertJsonPath('data.eeatReport.counts.founder_count', 1);
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'brand-config-replay')
            ->postJson('/api/v1/ai-research/brand-entity', $payload)
            ->assertOk();

        $stored = json_decode((string) SiteSetting::query()
            ->where('setting_key', 'ai_brand_entity_config')
            ->value('setting_value'), true);
        $this->assertIsArray($stored);
        $this->assertSame('桐灼GEO', $stored['organizationName']);
        $this->assertSame('桐灼科技有限公司', $stored['legalName']);
        $this->assertSame('https://geo.example.test', $stored['officialDomain']);
    }

    public function test_brand_entity_save_rejects_malformed_config_as_validation_error(): void
    {
        $admin = $this->admin('research-brand-invalid');
        $token = $admin->createToken('seo-writer', ['seo:write'])->plainTextToken;

        $malformed = [
            'sameAsLinks-string' => ['sameAsLinks' => 'abc'],
            'founders-string' => ['founders' => 'abc'],
            'alternateName-array' => ['alternateName' => ['桐灼GEO']],
            'organizationName-array' => ['organizationName' => ['桐灼GEO']],
        ];
        foreach ($malformed as $label => $config) {
            $this->withToken($token)
                ->withHeader('X-Idempotency-Key', 'brand-invalid-'.$label)
                ->postJson('/api/v1/ai-research/brand-entity', ['config' => $config])
                ->assertStatus(422);
        }

        $this->assertDatabaseMissing('site_settings', ['setting_key' => 'ai_brand_entity_config']);
    }

    public function test_brand_entity_save_writes_an_audit_entry(): void
    {
        $admin = $this->admin('research-brand-audited');
        $token = $admin->createToken('seo-writer', ['seo:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'brand-audit')
            ->postJson('/api/v1/ai-research/brand-entity', ['config' => ['organizationName' => '桐灼GEO']])
            ->assertOk()
            ->assertJsonPath('data.config.organizationName', '桐灼GEO');

        $this->assertDatabaseHas('admin_activity_logs', [
            'admin_id' => (int) $admin->id,
            'action' => 'api.brand_entity.saved',
        ]);
    }

    public function test_competitor_failure_does_not_persist_new_configuration(): void
    {
        $admin = $this->admin('research-competitor-failure');
        $token = $admin->createToken('analytics-collector', ['analytics:collect'])->plainTextToken;
        $collection = Mockery::mock(AiVisibilityCollector::class);
        $collection->shouldReceive('collect')->once()->andThrow(new RuntimeException('provider request failed'));
        $this->app->instance(AiVisibilityCollector::class, $collection);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'competitor-failure')
            ->postJson('/api/v1/ai-research/competitor/benchmark', [
                'query' => '企业 GEO',
            ])
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'ai_visibility_collection_failed');

        $this->assertDatabaseMissing('site_settings', ['setting_key' => 'ai_competitor_radar_config']);
        // 失败路径不得在审计里留下「已扫描」的成功记录：这才是可追溯性真正要防的。
        $this->assertDatabaseMissing('admin_activity_logs', ['action' => 'api.competitor.benchmarked']);
    }

    public function test_competitor_benchmark_uses_the_configuration_persisted_before_the_scan(): void
    {
        $admin = $this->admin('research-competitor-success');
        $token = $admin->createToken('analytics-collector', ['analytics:collect'])->plainTextToken;
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'competitor-config')
            ->postJson('/api/v1/ai-research/competitor/config', [
                'industry' => '企业软件',
                'competitors' => [[
                    'name' => '竞品 A',
                    'domains' => ['competitor.example.test'],
                ]],
            ])
            ->assertOk()
            ->assertJsonPath('data.config.competitors.0.name', '竞品 A');
        $run = $this->visibilityRun('企业 GEO', '竞品扫描回答');
        $collection = Mockery::mock(AiVisibilityCollector::class);
        $collection->shouldReceive('collect')->once()->andReturn(['search_run' => $run]);
        $this->app->instance(AiVisibilityCollector::class, $collection);

        // 扫描结果必须真的读到了先落库的配置：若配置写入或读取失效，这里会退化成「未配置」。
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'competitor-success')
            ->postJson('/api/v1/ai-research/competitor/benchmark', [
                'query' => '企业 GEO',
            ])
            ->assertOk()
            ->assertJsonPath('data.scan.query', '企业 GEO')
            ->assertJsonPath('data.scan.run_ids.0', (int) $run->id)
            ->assertJsonPath('data.config.industry', '企业软件')
            ->assertJsonPath('data.config.competitors.0.name', '竞品 A')
            ->assertJsonPath('data.config.competitors.0.domains.0', 'competitor.example.test')
            ->assertJsonPath('data.summary.configured_competitor_count', 1);

        $this->assertDatabaseHas('site_settings', [
            'setting_key' => 'ai_competitor_radar_config',
            'setting_value' => json_encode(['industry' => '企业软件', 'competitors' => [['name' => '竞品 A', 'domains' => ['competitor.example.test']]]], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        ]);
    }

    public function test_competitor_projection_uses_configured_domains_and_time_window(): void
    {
        $admin = $this->admin('research-competitor-projection');
        $token = $admin->createToken('analytics-reader', ['analytics:read'])->plainTextToken;
        SiteSetting::query()->create([
            'setting_key' => 'ai_brand_entity_config',
            'setting_value' => json_encode([
                'organizationName' => '桐灼GEO',
                'officialDomain' => 'https://brand.example.test',
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        ]);
        SiteSetting::query()->create([
            'setting_key' => 'ai_competitor_radar_config',
            'setting_value' => json_encode([
                'industry' => '企业软件',
                'competitors' => [['name' => '竞品 A', 'domains' => ['competitor.example.test']]],
            ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        ]);
        $run = $this->visibilityRun('真实问题', '回答');
        foreach ([
            ['url' => 'https://competitor.example.test/guide', 'domain' => 'competitor.example.test', 'rank' => 1],
            ['url' => 'https://docs.competitor.example.test/deep', 'domain' => 'docs.competitor.example.test', 'rank' => 4],
            ['url' => 'https://other.example.test/competitor-a', 'domain' => 'other.example.test', 'rank' => 2, 'title' => '竞品 A'],
            ['url' => 'https://brand.example.test/official', 'domain' => 'brand.example.test', 'rank' => 2],
        ] as $source) {
            AiVisibilitySource::query()->create([
                'ai_visibility_run_id' => $run->id,
                'title' => $source['title'] ?? '来源',
                'url' => $source['url'],
                'domain' => $source['domain'],
                'rank' => $source['rank'],
            ]);
        }
        $oldRun = $this->visibilityRun('过期问题', '过期回答');
        $oldRun->update(['completed_at' => now()->subDays(40), 'created_at' => now()->subDays(40)]);
        AiVisibilitySource::query()->create(['ai_visibility_run_id' => $oldRun->id, 'url' => 'https://competitor.example.test/old', 'domain' => 'competitor.example.test', 'rank' => 1]);

        $response = $this->withToken($token)->getJson('/api/v1/ai-research/competitor?days=30')->assertOk();
        $competitor = collect($response->json('data.competitors'))->firstWhere('brand_name', '竞品 A');
        $this->assertSame(2, $competitor['citation_observation_count']);
        $this->assertEquals(50, $competitor['citation_share_percent']);
        $this->assertEquals(50, $competitor['top3_citation_rate_percent']);
        $this->assertEquals(2.5, $competitor['average_citation_rank']);
        $this->assertSame(1, $competitor['observed_query_count']);
        $this->assertSame(4, $response->json('data.summary.citation_observation_count'));
        $own = collect($response->json('data.competitors'))->firstWhere('is_own_brand', true);
        $this->assertSame(['brand.example.test'], $own['domains']);
        $this->assertTrue($own['configured']);
        $this->assertEquals(25, $own['citation_share_percent']);
        $this->assertTrue($response->json('data.summary.own_brand_configured'));
    }

    public function test_competitor_projection_does_not_treat_the_site_url_as_a_configured_own_brand(): void
    {
        // 站点地址是部署默认值，不是运营方声明的被测量品牌：未配置品牌时 own_brand 必须
        // 如实报「未配置」，而不是拿站点 URL 冒充自有域名并报 configured=true。
        config()->set('geoflow.site_url', 'https://brand.example.test');
        config()->set('app.url', 'https://brand.example.test');
        $admin = $this->admin('research-competitor-unconfigured-own');
        $token = $admin->createToken('analytics-reader', ['analytics:read'])->plainTextToken;
        $run = $this->visibilityRun('真实问题', '回答');
        AiVisibilitySource::query()->create([
            'ai_visibility_run_id' => $run->id,
            'title' => '官方页面',
            'url' => 'https://brand.example.test/official',
            'domain' => 'brand.example.test',
            'rank' => 1,
        ]);

        $response = $this->withToken($token)->getJson('/api/v1/ai-research/competitor')->assertOk();
        $own = collect($response->json('data.competitors'))->firstWhere('is_own_brand', true);
        $this->assertSame([], $own['domains']);
        $this->assertFalse($own['configured']);
        $this->assertNull($own['citation_share_percent']);
        $this->assertSame(0, $own['citation_observation_count']);
        $this->assertSame('domains_not_configured', $own['availability']);
        $this->assertFalse($response->json('data.summary.own_brand_configured'));
        $this->assertSame(1, $response->json('data.summary.citation_observation_count'));
    }

    public function test_competitor_benchmark_honours_the_requested_time_window(): void
    {
        // days 曾通过校验后被静默丢弃、投影恒用 30 天窗口。
        $admin = $this->admin('research-competitor-window');
        $token = $admin->createToken('analytics-collector', ['analytics:collect'])->plainTextToken;
        $run = $this->visibilityRun('企业 GEO', '竞品扫描回答');
        $collection = Mockery::mock(AiVisibilityCollector::class);
        $collection->shouldReceive('collect')->once()->andReturn(['search_run' => $run]);
        $this->app->instance(AiVisibilityCollector::class, $collection);

        $response = $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'competitor-window-7')
            ->postJson('/api/v1/ai-research/competitor/benchmark', [
                'query' => '企业 GEO',
                'days' => 7,
            ])
            ->assertOk()
            ->assertJsonPath('data.window.days', 7);

        $this->assertSame(
            now()->subDays(6)->startOfDay()->toISOString(),
            $response->json('data.window.start'),
        );
    }

    public function test_sandbox_returns_persisted_answer_and_citations(): void
    {
        $admin = $this->admin('research-sandbox');
        $token = $admin->createToken('model-writer', ['models:write'])->plainTextToken;
        SiteSetting::query()->create([
            'setting_key' => 'ai_brand_entity_config',
            'setting_value' => json_encode(['organizationName' => '桐灼GEO', 'officialDomain' => 'geo.example.test'], JSON_UNESCAPED_UNICODE),
        ]);
        $run = $this->visibilityRun('如何做 GEO', '桐灼GEO 是一个可选平台。');
        AiVisibilitySource::query()->create([
            'ai_visibility_run_id' => $run->id,
            'title' => '桐灼GEO 官方指南',
            'url' => 'https://geo.example.test/guide',
            'domain' => 'geo.example.test',
            'snippet' => '官方事实',
            'rank' => 1,
        ]);
        $collection = Mockery::mock(AiVisibilityCollector::class);
        $collection->shouldReceive('collect')->once()->andReturn(['search_run' => $run]);
        $this->app->instance(AiVisibilityCollector::class, $collection);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'sandbox-run')
            ->postJson('/api/v1/ai-research/sandbox', ['query' => '如何做 GEO', 'targetEngine' => 'perplexity'])
            ->assertOk()
            ->assertJsonPath('data.simulatedAnswer', '桐灼GEO 是一个可选平台。')
            ->assertJsonPath('data.brandMentioned', true)
            ->assertJsonPath('data.citations.0.brandMatch', true)
            ->assertJsonPath('data.citationSharePercent', 100)
            ->assertJsonPath('data.citationShareDenominator', 1)
            ->assertJsonPath('data.citationShareStatus', 'measured')
            ->assertJsonPath('data.run_id', (int) $run->id);

        // 沙盘会真实发起 Provider 出站，必须和 collectQuery/benchmarkCompetitor 一样留审计。
        $this->assertDatabaseHas('admin_activity_logs', [
            'admin_id' => (int) $admin->id,
            'action' => 'api.sandbox.evaluated',
        ]);
    }

    public function test_sandbox_leaves_citation_share_uncomputable_without_citations(): void
    {
        // 分母为 0 时返回 0% 会被读成「占有率为零」这一测量结论，应标为不可计算。
        $admin = $this->admin('research-sandbox-no-citations');
        $token = $admin->createToken('model-writer', ['models:write'])->plainTextToken;
        SiteSetting::query()->create([
            'setting_key' => 'ai_brand_entity_config',
            'setting_value' => json_encode(['organizationName' => '桐灼GEO', 'officialDomain' => 'geo.example.test'], JSON_UNESCAPED_UNICODE),
        ]);
        $run = $this->visibilityRun('没有引用的提问', '这段回答没有任何引用来源。');
        $collection = Mockery::mock(AiVisibilityCollector::class);
        $collection->shouldReceive('collect')->once()->andReturn(['search_run' => $run]);
        $this->app->instance(AiVisibilityCollector::class, $collection);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'sandbox-no-citations')
            ->postJson('/api/v1/ai-research/sandbox', ['query' => '没有引用的提问'])
            ->assertOk()
            ->assertJsonPath('data.citations', [])
            ->assertJsonPath('data.citationSharePercent', null)
            ->assertJsonPath('data.citationShareDenominator', 0)
            ->assertJsonPath('data.citationShareStatus', 'no_citation_records')
            ->assertJsonPath('data.brandSentiment', null)
            ->assertJsonPath('data.brandSentimentStatus', 'not_collected');
    }

    public function test_sandbox_leaves_brand_attribution_uncomputable_until_the_brand_is_configured(): void
    {
        // 未配置被测量品牌时 brandName() 为空串，提及判定恒为 false：若照常输出，
        // 「无法测量」会变成「模型没有推荐你」这一确定的负面结论。
        $admin = $this->admin('research-sandbox-brand-unconfigured');
        $token = $admin->createToken('model-writer', ['models:write'])->plainTextToken;
        $run = $this->visibilityRun('未配置品牌的问题', '回答里没有出现任何品牌名。');
        AiVisibilitySource::query()->create([
            'ai_visibility_run_id' => $run->id,
            'title' => '某个信源',
            'url' => 'https://example.test/page',
            'domain' => 'example.test',
            'rank' => 1,
        ]);
        $collection = Mockery::mock(AiVisibilityCollector::class);
        $collection->shouldReceive('collect')->once()->andReturn(['search_run' => $run]);
        $this->app->instance(AiVisibilityCollector::class, $collection);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'sandbox-brand-unconfigured')
            ->postJson('/api/v1/ai-research/sandbox', ['query' => '未配置品牌的问题'])
            ->assertOk()
            ->assertJsonPath('data.brandConfigured', false)
            ->assertJsonPath('data.brandName', '')
            ->assertJsonPath('data.brandMentioned', null)
            ->assertJsonPath('data.brandRecommendationGrade', null)
            ->assertJsonPath('data.citations.0.brandMatch', null)
            ->assertJsonPath('data.ownedDomains', [])
            ->assertJsonPath('data.citationSharePercent', null)
            // 信源归属未声明自有域名、品牌提及未声明品牌名，两者各自给出原因。
            ->assertJsonPath('data.citationShareStatus', 'owned_domains_not_configured');
    }

    public function test_sandbox_attributes_citations_by_declared_domain_not_by_brand_name(): void
    {
        // 自有信源按域名归属（与竞品投影同口径）：标题或路径里带品牌名的第三方页面
        // 不得被算成自有信源并抬高信源占有率；产品品牌名也不得参与归属判定。
        $admin = $this->admin('research-sandbox-customer-brand');
        $token = $admin->createToken('model-writer', ['models:write'])->plainTextToken;
        SiteSetting::query()->create([
            'setting_key' => 'ai_brand_entity_config',
            'setting_value' => json_encode(['organizationName' => 'Acme', 'officialDomain' => 'acme.example.test'], JSON_UNESCAPED_UNICODE),
        ]);
        $run = $this->visibilityRun('客户品牌提问', '回答里只出现了 桐灼GEO 这个产品名。');
        foreach ([
            ['title' => 'Acme 官方页面', 'url' => 'https://acme.example.test/page', 'domain' => 'acme.example.test', 'rank' => 1],
            ['title' => '桐灼GEO 产品文档', 'url' => 'https://geo.example.test/doc', 'domain' => 'geo.example.test', 'rank' => 2],
            // 第三方域名，但标题与路径都含品牌名：按名称匹配会被误判成自有信源。
            ['title' => 'Acme 第三方评测', 'url' => 'https://review.example.test/acme-review', 'domain' => 'review.example.test', 'rank' => 3],
        ] as $source) {
            AiVisibilitySource::query()->create([
                'ai_visibility_run_id' => $run->id,
                'title' => $source['title'],
                'url' => $source['url'],
                'domain' => $source['domain'],
                'rank' => $source['rank'],
            ]);
        }
        $collection = Mockery::mock(AiVisibilityCollector::class);
        $collection->shouldReceive('collect')->once()->andReturn(['search_run' => $run]);
        $this->app->instance(AiVisibilityCollector::class, $collection);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'sandbox-customer-brand')
            ->postJson('/api/v1/ai-research/sandbox', ['query' => '客户品牌提问'])
            ->assertOk()
            ->assertJsonPath('data.brandConfigured', true)
            // 回传的是运营方声明的客户品牌，前端不得把它换成产品品牌名。
            ->assertJsonPath('data.brandName', 'Acme')
            // 回答正文里没有出现被测量的客户品牌名，只有产品品牌名。
            ->assertJsonPath('data.brandMentioned', false)
            ->assertJsonPath('data.brandRecommendationGrade', '未上榜')
            ->assertJsonPath('data.ownedDomains', ['acme.example.test'])
            ->assertJsonPath('data.citations.0.brandMatch', true)
            ->assertJsonPath('data.citations.1.brandMatch', false)
            // 标题/路径含品牌名但域名属第三方：不是自有信源。
            ->assertJsonPath('data.citations.2.brandMatch', false)
            ->assertJsonPath('data.citationSharePercent', 33)
            ->assertJsonPath('data.citationShareDenominator', 3);
    }

    public function test_sandbox_matches_brand_mentions_across_all_declared_names(): void
    {
        // 只认 organizationName 会把「回答只命中了别名」漏判成未被提及，
        // 并据此输出「未上榜」这一确定的负面结论。
        $admin = $this->admin('research-sandbox-alias');
        $token = $admin->createToken('model-writer', ['models:write'])->plainTextToken;
        SiteSetting::query()->create([
            'setting_key' => 'ai_brand_entity_config',
            'setting_value' => json_encode([
                'organizationName' => '桐灼科技',
                'alternateName' => 'Acme',
                'officialDomain' => 'acme.example.test',
            ], JSON_UNESCAPED_UNICODE),
        ]);
        $run = $this->visibilityRun('别名提问', '推荐 Acme，它在这个领域做得不错。');
        $collection = Mockery::mock(AiVisibilityCollector::class);
        $collection->shouldReceive('collect')->once()->andReturn(['search_run' => $run]);
        $this->app->instance(AiVisibilityCollector::class, $collection);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'sandbox-alias')
            ->postJson('/api/v1/ai-research/sandbox', ['query' => '别名提问'])
            ->assertOk()
            ->assertJsonPath('data.brandConfigured', true)
            ->assertJsonPath('data.brandName', '桐灼科技')
            ->assertJsonPath('data.brandMentioned', true)
            ->assertJsonPath('data.brandRecommendationGrade', '客观列举');
    }

    public function test_sandbox_does_not_treat_the_product_brand_name_as_the_measured_brand(): void
    {
        // 产品品牌（桐灼GEO）与被测量的客户品牌是两个主体：回答里只出现产品品牌时，
        // 不能算作客户品牌被模型推荐。
        $admin = $this->admin('research-sandbox-product-brand');
        $token = $admin->createToken('model-writer', ['models:write'])->plainTextToken;
        SiteSetting::query()->create([
            'setting_key' => 'ai_brand_entity_config',
            'setting_value' => json_encode(['organizationName' => 'Acme'], JSON_UNESCAPED_UNICODE),
        ]);
        $run = $this->visibilityRun('产品品牌提问', '这个回答里只出现了 桐灼GEO 这个产品名。');
        $collection = Mockery::mock(AiVisibilityCollector::class);
        $collection->shouldReceive('collect')->once()->andReturn(['search_run' => $run]);
        $this->app->instance(AiVisibilityCollector::class, $collection);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'sandbox-product-brand')
            ->postJson('/api/v1/ai-research/sandbox', ['query' => '产品品牌提问'])
            ->assertOk()
            ->assertJsonPath('data.brandConfigured', true)
            ->assertJsonPath('data.brandName', 'Acme')
            ->assertJsonPath('data.brandMentioned', false)
            ->assertJsonPath('data.brandRecommendationGrade', '未上榜');
    }

    public function test_sandbox_exposes_provider_failure_as_public_api_error(): void
    {
        $admin = $this->admin('research-sandbox-failure');
        $token = $admin->createToken('model-writer', ['models:write'])->plainTextToken;
        $collection = Mockery::mock(AiVisibilityCollector::class);
        $collection->shouldReceive('collect')->once()->andThrow(new RuntimeException('provider request failed'));
        $this->app->instance(AiVisibilityCollector::class, $collection);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'sandbox-failure')
            ->postJson('/api/v1/ai-research/sandbox', ['query' => '失败测试'])
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'ai_visibility_collection_failed');
    }

    private function admin(string $username): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'password',
            'email' => $username.'@example.test',
            'display_name' => $username,
            'role' => 'admin',
            'status' => 'active',
        ]);
    }

    private function visibilityRun(string $keyword, string $answer): AiVisibilityRun
    {
        return AiVisibilityRun::query()->create([
            'keyword' => $keyword,
            'prompt' => $keyword,
            'provider_type' => 'search',
            'provider_key' => 'doubao_search_custom',
            'status' => AiVisibilityRun::STATUS_COMPLETED,
            'answer_text' => $answer,
            'analysis_json' => ['recommendations' => ['补充真实证据']],
            'completed_at' => now(),
        ]);
    }

    public function test_attribution_leaves_the_funnel_uncomputable_without_view_logs(): void
    {
        $admin = $this->admin('research-attribution-empty');
        $token = $admin->createToken('analytics-reader', ['analytics:read'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/ai-research/attribution?days=30')
            ->assertOk()
            ->assertJsonPath('data.availability', 'no_view_logs')
            ->assertJsonPath('data.stages', [])
            ->assertJsonPath('data.engines', [])
            ->assertJsonPath('data.totals', null)
            ->assertJsonPath('data.source.estimated', false);
    }

    public function test_attribution_distinguishes_no_ai_referrals_from_no_traffic(): void
    {
        $admin = $this->admin('research-attribution-organic');
        $token = $admin->createToken('analytics-reader', ['analytics:read'])->plainTextToken;
        // 有站点访问，但来源不是已登记的 AI 引擎。
        DB::table('view_logs')->insert([
            'source' => 'local',
            'method' => 'GET',
            'path' => '/articles/geo',
            'status_code' => 200,
            'ip_address' => '203.0.113.7',
            'referer' => 'https://www.baidu.com/s?wd=geo',
            'created_at' => now(),
        ]);

        $this->withToken($token)
            ->getJson('/api/v1/ai-research/attribution')
            ->assertOk()
            ->assertJsonPath('data.availability', 'no_ai_referrals')
            ->assertJsonPath('data.stages', []);
    }

    public function test_attribution_projects_the_funnel_from_referrers_and_leads(): void
    {
        $admin = $this->admin('research-attribution-full');
        $token = $admin->createToken('analytics-reader', ['analytics:read'])->plainTextToken;

        // 两个来自 Perplexity 的访客：其中一个看了两页；一个 ChatGPT 访客；一个百度访客（不计入）。
        foreach ([
            ['ip' => '198.51.100.1', 'referer' => 'https://www.perplexity.ai/search/geo'],
            ['ip' => '198.51.100.1', 'referer' => 'https://www.perplexity.ai/search/geo'],
            ['ip' => '198.51.100.2', 'referer' => 'https://chatgpt.com/c/abc'],
            ['ip' => '198.51.100.9', 'referer' => 'https://www.baidu.com/s?wd=geo'],
        ] as $row) {
            DB::table('view_logs')->insert([
                'source' => 'local',
                'method' => 'GET',
                'path' => '/articles/geo',
                'status_code' => 200,
                'ip_address' => $row['ip'],
                'referer' => $row['referer'],
                'created_at' => now(),
            ]);
        }

        // 只有 198.51.100.1 提交了线索，且已转化。
        LeadSubmission::query()->create([
            'status' => LeadSubmission::STATUS_CONVERTED,
            'payload' => ['name' => '访客'],
            'source_url' => '/contact',
            'ip_address' => '198.51.100.1',
        ]);

        $response = $this->withToken($token)->getJson('/api/v1/ai-research/attribution?days=30')->assertOk();
        $stages = collect($response->json('data.stages'))->keyBy('key');

        $this->assertSame('available', $response->json('data.availability'));
        // 三条 AI 引荐访问（百度那条不算）。
        $this->assertSame(3, $stages['ai_referral_visit']['count']);
        // 漏斗首阶段没有分母（它就是基准），去重访客数在 totals 里。
        $this->assertNull($stages['ai_referral_visit']['denominator']);
        $this->assertSame(2, $response->json('data.totals.distinct_referral_ip_count'));
        // 两个不同 IP，其中 198.51.100.1 看了两页。
        $this->assertSame(2, $stages['engaged_visit']['denominator']);
        $this->assertSame(1, $stages['engaged_visit']['count']);
        $this->assertSame(1, $stages['lead_submitted']['count']);
        $this->assertSame(1, $stages['lead_converted']['count']);

        $engines = collect($response->json('data.engines'))->keyBy('engine');
        $this->assertSame(2, $engines['perplexity']['visit_count']);
        $this->assertSame(1, $engines['chatgpt']['visit_count']);
        $this->assertArrayNotHasKey('other', $engines->all(), '未登记的百度来源不应出现在 AI 引擎分组里');
        $this->assertSame(2, $response->json('data.totals.distinct_referral_ip_count'));
        // 线索阶段是 IP 关联的下界，必须显式声明。
        $this->assertStringContainsString('下界', $response->json('data.definitions.ip_join'));
    }

    public function test_attribution_requires_analytics_read_scope(): void
    {
        $admin = $this->admin('research-attribution-scope');
        $token = $admin->createToken('wrong-scope', ['articles:read'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/ai-research/attribution')
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'analytics:read');
    }
}
