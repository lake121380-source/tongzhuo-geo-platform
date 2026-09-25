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
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Once;
use Tests\TestCase;

class AdminAiVisibilityAnalyticsTest extends TestCase
{
    /** 见度 GEO 的上游基址（与 JianduApiTest 保持一致）。 */
    private const JIANDU_BASE = 'https://geosensor.tongzhuo.ink';

    use RefreshDatabase;

    /**
     * 没连接见度时：「不可计算」而不是 0%。
     *
     * ⚠️ 2026-09-20 起「AI 可见度」的数据源整体换成**见度检测**，旧的**自采集投影**
     * （`AiVisibilityAnalyticsService` 的 `overview.brand/kpis`）已退役——那些键现在根本不存在，
     * 所以这条用例原来断言的东西无从谈起。**断言口径不变**：没有数据不许输出 0%，
     * 只是「没有数据」的情形从「品牌没声明」变成了「没连接 / 没有样本」。
     */
    public function test_ai_visibility_reports_unavailable_instead_of_zero_when_not_connected(): void
    {
        $data = $this->withToken($this->analyticsToken())
            ->getJson('/api/v1/analytics/ai-visibility?ai_preset=14d')
            ->assertOk()
            ->json('data');

        $this->assertFalse((bool) ($data['overview']['connected'] ?? false), '没连接见度时 connected 必须是 false');
        // 关键：不给任何比率——不是 0，而是整段缺席（「没测到」≠「测到 0」）。
        foreach (['kpis', 'trend', 'platforms', 'detections', 'reports'] as $segment) {
            $this->assertArrayNotHasKey($segment, $data, "没连接时不该出现 {$segment}（那会把「没数据」渲染成 0）");
        }
    }

    /**
     * 连上见度后，KPI 直接取自见度的检测结果（上游用 `Http::fake` 模拟）。
     */
    public function test_ai_visibility_renders_kpis_from_the_jiandu_detection_source(): void
    {
        Http::fake([
            self::JIANDU_BASE.'/api/v1/auth/token' => Http::response([
                'token' => 'api_usr_test-token',
                'refreshToken' => 'api_refresh_test-token',
                'expiresAt' => now()->addDay()->toIso8601String(),
                'refreshExpiresAt' => now()->addDays(30)->toIso8601String(),
                'user' => ['id' => 'usr_ext_1', 'name' => '验收员', 'organizationName' => '验收组织'],
            ]),
            self::JIANDU_BASE.'/api/v1/projects' => Http::response([
                ['id' => 'proj_1', 'name' => '验收项目'],
            ]),
            self::JIANDU_BASE.'/api/v1/dashboard/overview*' => Http::response([
                'mentionRate' => 42.5,
                'recommendRate' => 30.0,
                'totalAnswers' => 120,
            ]),
            // 概览还会并行取「检测批次 / 报告 / 账号信息」；这些不影响本用例的断言，
            // 给一个空响应即可（**不能省略**：不给假的空响应会被当成解析失败，整栏 500）。
            '*' => Http::response([]),
        ]);

        // 走真实连接流程（凭据密文落库），而不是直接插一行连接记录。
        // ⚠️ 用**同一个** admin 实例拿两把 token：本文件的 `admin()` 是 create 语义，调两次会撞唯一键。
        $admin = $this->admin();
        $this->withHeaders([
            'Authorization' => 'Bearer '.$admin->createToken('jiandu-source', ['jiandu:write'])->plainTextToken,
            'X-Idempotency-Key' => 'jiandu-connect-for-kpis',
        ])->postJson('/api/v1/jiandu/session', ['account' => 'user@example.com', 'password' => 'secret-password'])
            ->assertCreated();

        $data = $this->withToken($admin->createToken('ai-visibility-analytics', ['analytics:read'])->plainTextToken)
            ->getJson('/api/v1/analytics/ai-visibility?ai_preset=30d')
            ->assertOk()
            ->json('data');

        $this->assertTrue((bool) ($data['overview']['connected'] ?? false));
        // 见度概览的 KPI 键是 `mention_rate`（`AnalyticsController::aiVisibility` → `JianduVisibilityService::map()`），
        // 与 `/analytics/overview` 上那张卡片的 `brand_visibility` 不是同一个投影。
        $this->assertSame(42.5, $data['overview']['kpis']['mention_rate'] ?? null, 'KPI 必须来自见度');
        $this->assertSame(120, $data['overview']['kpis']['sampled_answers'] ?? null);
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
