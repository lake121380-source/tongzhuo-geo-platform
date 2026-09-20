<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\JianduConnection;
use App\Models\JianduDetectionSetting;
use App\Models\JianduQuestion;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as ClientRequest;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * 「见度检测」接入（/api/v1/jiandu/*）的契约测试。
 *
 * 上游（见度GEO）一律用 `Http::fake` 模拟——`preventStrayRequests` 兜底，
 * 任何没被显式 fake 的请求直接让测试失败，**绝不误打生产见度**。
 *
 * 重点关注两条容易做错的语义：
 *  · 见度的 401（账号密码错）必须翻译成 422，不能原样透传——本系统前端的
 *    401 会清会话把用户踢回登录页；
 *  · token 落库必须是密文（`enc:v1:`），投影里不能出现任何 token 字段。
 */
final class JianduApiTest extends TestCase
{
    use RefreshDatabase;

    private const BASE = 'https://geosensor.tongzhuo.ink';

    protected function setUp(): void
    {
        parent::setUp();
        Http::preventStrayRequests();
    }

    public function test_status_requires_authentication(): void
    {
        $this->getJson('/api/v1/jiandu/status')->assertUnauthorized();
    }

    public function test_status_requires_jiandu_scope(): void
    {
        $token = $this->admin()->createToken('analytics-only', ['analytics:read'])->plainTextToken;

        $this->withToken($token)->getJson('/api/v1/jiandu/status')
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'jiandu:read');
    }

    public function test_connect_exchanges_credentials_and_stores_encrypted_session(): void
    {
        $this->fakeSessionToken();

        $this->withHeaders($this->writeHeaders('jd-connect-1'))
            ->postJson('/api/v1/jiandu/session', ['account' => 'user@example.com', 'password' => 'secret-password'])
            ->assertCreated()
            ->assertJsonPath('data.connection.account', 'user@example.com')
            ->assertJsonPath('data.connection.organization_name', '验收组织')
            ->assertJsonPath('data.connection.user_name', '验收员');

        $connection = JianduConnection::query()->firstOrFail();
        $ciphertext = (string) $connection->getAttribute('access_token_ciphertext');
        $this->assertStringStartsWith('enc:v1:', $ciphertext);
        $this->assertStringNotContainsString('api_usr_test-token', $ciphertext);
        $this->assertArrayNotHasKey('access_token_ciphertext', $connection->toArray());
        $this->assertSame(JianduConnection::STATUS_ACTIVE, $connection->status);

        // 请求形状与见度契约一致（camelCase 字段是见度侧的口径）。
        Http::assertSent(fn (ClientRequest $request): bool => $request->url() === self::BASE.'/api/v1/auth/token'
            && $request['account'] === 'user@example.com'
            && $request['password'] === 'secret-password');
    }

    public function test_connect_surfaces_verification_challenge_without_connecting(): void
    {
        Http::fake([
            self::BASE.'/api/v1/auth/token' => Http::response([
                'requiresVerification' => true,
                'channel' => 'sms',
                'message' => '这是一台新设备，请输入短信验证码',
            ]),
        ]);

        $this->withHeaders($this->writeHeaders('jd-verify-1'))
            ->postJson('/api/v1/jiandu/session', ['account' => '13800138000', 'password' => 'secret-password'])
            ->assertOk()
            ->assertJsonPath('data.requires_verification', true)
            ->assertJsonPath('data.channel', 'sms')
            ->assertJsonPath('data.connection', null);

        $this->assertSame(0, JianduConnection::query()->count(), '验证码挑战阶段不能落任何连接');
    }

    public function test_connect_translates_wrong_password_to_422_not_401(): void
    {
        Http::fake([
            self::BASE.'/api/v1/auth/token' => Http::response(['error' => '邮箱或密码错误'], 401),
        ]);

        // 422 而不是 401：本系统前端的 401 语义是「桐灼GEO 会话失效」，
        // 原样透传会把用户踢回登录页——那是个会让人完全摸不着头脑的体验。
        $this->withHeaders($this->writeHeaders('jd-wrong-pw-1'))
            ->postJson('/api/v1/jiandu/session', ['account' => 'user@example.com', 'password' => 'nope'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'jiandu_credentials_invalid');
    }

    public function test_connect_requires_api_plan(): void
    {
        Http::fake([
            self::BASE.'/api/v1/auth/token' => Http::response(['error' => '当前套餐不包含开放 API', 'code' => 'api_not_in_plan'], 403),
        ]);

        $this->withHeaders($this->writeHeaders('jd-plan-1'))
            ->postJson('/api/v1/jiandu/session', ['account' => 'user@example.com', 'password' => 'secret-password'])
            ->assertForbidden()
            ->assertJsonPath('error.code', 'jiandu_plan_required');
    }

    public function test_data_endpoints_proxy_through_the_connection(): void
    {
        $this->fakeSessionToken();
        $this->connect('jd-data-connect');

        Http::fake([
            self::BASE.'/api/v1/projects' => Http::response([
                ['id' => 'proj_1', 'name' => '示例项目', 'brandName' => '示例品牌', 'industry' => '制造', 'profile' => ['secret' => 'x']],
            ]),
            self::BASE.'/api/v1/dashboard/overview*' => Http::response(['mentionRate' => 42.5, 'samples' => 120]),
            self::BASE.'/api/v1/detections*' => Http::response(['items' => [['id' => 'task_1', 'status' => 'completed']], 'total' => 1, 'page' => 1, 'pageSize' => 20]),
        ]);

        $headers = $this->readHeaders();

        $this->withHeaders($headers)->getJson('/api/v1/jiandu/projects')
            ->assertOk()
            ->assertJsonPath('data.projects.0.id', 'proj_1')
            ->assertJsonPath('data.source.kind', 'jiandu_api')
            // 投影只给白名单字段：见度项目的 profile 等内部资料不外泄。
            ->assertJsonMissingPath('data.projects.0.profile');

        $this->withHeaders($headers)->getJson('/api/v1/jiandu/overview?project_id=proj_1&range=30d')
            ->assertOk()
            ->assertJsonPath('data.overview.mentionRate', 42.5);

        $this->withHeaders($headers)->getJson('/api/v1/jiandu/detections?project_id=proj_1&page=1&page_size=20')
            ->assertOk()
            ->assertJsonPath('data.detections.items.0.id', 'task_1');

        // 数据请求必须带见度会话；projectId 按见度契约用 camelCase 的 query 传。
        Http::assertSent(fn (ClientRequest $request): bool => str_contains($request->url(), '/api/v1/dashboard/overview')
            && str_contains($request->url(), 'projectId=proj_1')
            && $request->hasHeader('Authorization', 'Bearer api_usr_test-token'));
    }

    public function test_reports_and_me_proxy_through_the_connection(): void
    {
        $this->fakeSessionToken();
        $this->connect('jd-reports-connect');

        Http::fake([
            self::BASE.'/api/v1/reports*' => Http::response([
                'items' => [[
                    'id' => 'report_task_1',
                    'title' => '示例品牌 · GEO 检测报告',
                    'geoScore' => 72.5,
                    'geoScoreStatus' => 'final',
                    'metrics' => ['total' => 40, 'mentionRate' => 55, 'recommendRate' => 30],
                ]],
                'total' => 1,
                'page' => 1,
                'pageSize' => 10,
            ]),
            self::BASE.'/api/v1/me' => Http::response([
                'organizationId' => 'org_1',
                'organizationName' => '验收组织',
                'projectCount' => 2,
                'key' => null,
                'plan' => ['code' => 'pro', 'name' => '专业版', 'apiEnabled' => true],
                'quota' => ['monthlyDetectionsUsed' => 3, 'monthlyDetectionsTotal' => 300, 'pointsBalance' => 1200],
            ]),
        ]);

        $headers = $this->readHeaders();

        $this->withHeaders($headers)->getJson('/api/v1/jiandu/reports?project_id=proj_1&page=1&page_size=10')
            ->assertOk()
            ->assertJsonPath('data.reports.items.0.id', 'report_task_1')
            ->assertJsonPath('data.reports.items.0.geoScore', 72.5)
            ->assertJsonPath('data.reports.items.0.metrics.mentionRate', 55);

        // me：透传套餐与额度，但 `key` 必须被剥掉——本页面永远不接触任何凭据字段，
        // 包括「本来就是空」的也不给。
        $this->withHeaders($headers)->getJson('/api/v1/jiandu/me')
            ->assertOk()
            ->assertJsonPath('data.account.plan.name', '专业版')
            ->assertJsonPath('data.account.quota.monthlyDetectionsTotal', 300)
            ->assertJsonMissingPath('data.account.key');
    }

    public function test_reports_feature_gate_keeps_upstream_wording(): void
    {
        $this->fakeSessionToken();
        $this->connect('jd-reports-gated-connect');

        // 见度侧特性级套餐门禁（reportsEnabled）：这不是故障，是能力边界——
        // 翻译后的文案要原样保留见度的人话提示，前端会把它放在报告卡片里。
        Http::fake([
            self::BASE.'/api/v1/reports*' => Http::response([
                'error' => '检测报告不在当前套餐里，升级后可用',
                'code' => 'feature_not_in_plan',
                'feature' => 'reports',
            ], 403),
        ]);

        $this->withHeaders($this->readHeaders())
            ->getJson('/api/v1/jiandu/reports?project_id=proj_1')
            ->assertForbidden()
            ->assertJsonPath('error.code', 'jiandu_feature_not_in_plan')
            ->assertJsonPath('error.message', '检测报告不在当前套餐里，升级后可用')
            ->assertJsonPath('error.details.feature', 'reports');
    }

    public function test_expiring_access_token_is_refreshed_before_use(): void
    {
        // access 60 秒后过期，早于 refresh_skew（默认 300 秒）→ 用之前必须先刷新。
        $this->fakeSessionToken(expiresInSeconds: 60, token: 'api_usr_soon-stale', refreshToken: 'api_refresh_rotation-old');
        $this->connect('jd-refresh-connect');

        Http::fake([
            self::BASE.'/api/v1/auth/refresh' => Http::response([
                'token' => 'api_usr_rotated-new',
                'refreshToken' => 'api_refresh_rotation-new',
                'expiresAt' => now()->addHours(24)->toIso8601String(),
                'refreshExpiresAt' => now()->addDays(30)->toIso8601String(),
            ]),
            self::BASE.'/api/v1/projects' => Http::response([]),
        ]);

        $this->withHeaders($this->readHeaders())->getJson('/api/v1/jiandu/projects')->assertOk();

        Http::assertSent(fn (ClientRequest $request): bool => $request->url() === self::BASE.'/api/v1/auth/refresh'
            && $request['refreshToken'] === 'api_refresh_rotation-old');
        Http::assertSent(fn (ClientRequest $request): bool => $request->url() === self::BASE.'/api/v1/projects'
            && $request->hasHeader('Authorization', 'Bearer api_usr_rotated-new'));

        // 轮换后的新对必须落回库里（下次再请求不用重新登录）。
        $connection = JianduConnection::query()->firstOrFail();
        $this->assertNotNull($connection->last_refreshed_at);
        $this->assertTrue(
            app(\App\Support\GeoFlow\ApiKeyCrypto::class)->decrypt((string) $connection->getAttribute('access_token_ciphertext')) === 'api_usr_rotated-new',
        );
    }

    public function test_data_request_without_connection_is_conflict_not_login_redirect(): void
    {
        $this->withHeaders($this->readHeaders())->getJson('/api/v1/jiandu/projects')
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'jiandu_not_connected');
    }

    public function test_disconnect_revokes_session_and_frees_the_connection(): void
    {
        $this->fakeSessionToken();
        $this->connect('jd-disconnect-connect');

        Http::fake([self::BASE.'/api/v1/auth/logout' => Http::response(['ok' => true])]);

        $this->withHeaders($this->writeHeaders('jd-disconnect-1'))
            ->deleteJson('/api/v1/jiandu/session')
            ->assertOk()
            ->assertJsonPath('data.connection', null);

        $connection = JianduConnection::query()->firstOrFail();
        $this->assertSame(JianduConnection::STATUS_REVOKED, $connection->status);
        Http::assertSent(fn (ClientRequest $request): bool => $request->url() === self::BASE.'/api/v1/auth/logout'
            && $request['refreshToken'] === 'api_refresh_test-token');

        // 断开之后状态接口回到「未连接」。
        $this->withHeaders($this->readHeaders())->getJson('/api/v1/jiandu/status')
            ->assertOk()
            ->assertJsonPath('data.connection', null);
    }

    public function test_write_endpoints_require_idempotency_key(): void
    {
        $this->withHeaders($this->readHeaders())
            ->postJson('/api/v1/jiandu/session', ['account' => 'user@example.com', 'password' => 'x'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');
    }

    public function test_visibility_column_maps_jiandu_data_when_connected(): void
    {
        $this->fakeSessionToken();
        $this->connect('jd-visibility-connect');

        Http::fake([
            self::BASE.'/api/v1/projects' => Http::response([['id' => 'proj_1', 'name' => '示例项目', 'brandName' => '示例品牌']]),
            self::BASE.'/api/v1/dashboard/overview*' => Http::response([
                'totalAnswers' => 12, 'mentionRate' => 41.7, 'recommendRate' => 25, 'positiveRate' => 66.7, 'geoScore' => 55.2,
                'trendData' => [['date' => '09-19', 'mentionRate' => 40, 'recommendRate' => 20, 'total' => 6]],
                'platformPerformance' => [['platformId' => 'deepseek', 'platform' => 'DeepSeek', 'mentionRate' => 50, 'totalCount' => 6]],
            ]),
            self::BASE.'/api/v1/detections*' => Http::response(['items' => [['id' => 'task_1', 'status' => 'completed', 'createdAt' => '2026-09-20T10:00:00+08:00', 'totalAnswers' => 6, 'mentionRate' => 50]], 'total' => 1]),
            self::BASE.'/api/v1/reports*' => Http::response(['items' => [['id' => 'report_task_1', 'title' => '示例报告', 'createdAt' => '2026-09-20T10:01:00+08:00', 'geoScore' => 55.2, 'geoScoreStatus' => 'final', 'metrics' => ['total' => 6, 'mentionRate' => 50, 'recommendRate' => 33]]], 'total' => 1]),
            self::BASE.'/api/v1/me' => Http::response(['plan' => ['name' => '专业版'], 'quota' => ['monthlyDetectionsUsed' => 3, 'monthlyDetectionsTotal' => 300, 'pointsBalance' => 1200]]),
        ]);

        $this->withToken($this->admin()->createToken('visibility', ['analytics:read'])->plainTextToken)
            ->getJson('/api/v1/analytics/ai-visibility?ai_preset=30d')
            ->assertOk()
            ->assertJsonPath('data.overview.connected', true)
            ->assertJsonPath('data.overview.kpis.mention_rate', 41.7)
            ->assertJsonPath('data.overview.kpis.sampled_answers', 12)
            ->assertJsonPath('data.overview.project.id', 'proj_1')
            ->assertJsonPath('data.overview.detections.0.id', 'task_1')
            ->assertJsonPath('data.overview.reports.0.title', '示例报告')
            ->assertJsonPath('data.overview.plan_name', '专业版');
    }

    public function test_visibility_zero_samples_are_null_not_zero(): void
    {
        $this->fakeSessionToken();
        $this->connect('jd-visibility-zero');

        // 零样本口径：见度在 totalAnswers=0 时比率返回字面的 0——映射层必须翻成 null
        //（「没测出来」不是「测出来是 0」，前端显示「—」）。
        Http::fake([
            self::BASE.'/api/v1/projects' => Http::response([['id' => 'proj_1', 'name' => '示例项目']]),
            self::BASE.'/api/v1/dashboard/overview*' => Http::response(['totalAnswers' => 0, 'mentionRate' => 0, 'recommendRate' => 0, 'positiveRate' => 0, 'geoScore' => 0, 'trendData' => [], 'platformPerformance' => []]),
            self::BASE.'/api/v1/detections*' => Http::response(['items' => []]),
            self::BASE.'/api/v1/reports*' => Http::response(['items' => []]),
            self::BASE.'/api/v1/me' => Http::response(['quota' => []]),
        ]);

        $this->withToken($this->admin()->createToken('visibility-zero', ['analytics:read'])->plainTextToken)
            ->getJson('/api/v1/analytics/ai-visibility')
            ->assertOk()
            ->assertJsonPath('data.overview.kpis.mention_rate', null)
            ->assertJsonPath('data.overview.kpis.sampled_answers', 0);
    }

    public function test_daily_detection_command_submits_only_active_questions(): void
    {
        $this->fakeSessionToken();
        $this->connect('jd-daily-connect');

        JianduQuestion::query()->create(['question' => '甲问题', 'is_active' => true, 'sort_order' => 1]);
        JianduQuestion::query()->create(['question' => '乙问题', 'is_active' => false, 'sort_order' => 2]);

        Http::fake([
            self::BASE.'/api/v1/projects' => Http::response([['id' => 'proj_1', 'name' => '示例项目']]),
            self::BASE.'/api/v1/detections' => Http::response(['id' => 'task_daily_1', 'status' => 'queued', 'totalJobs' => 2], 201),
        ]);

        $this->artisan('geoflow:jiandu-daily-detection')->assertSuccessful();
        Http::assertSent(fn (ClientRequest $request): bool => $request->url() === self::BASE.'/api/v1/detections'
            && $request['projectId'] === 'proj_1'
            && $request['questions'] === ['甲问题']);

        $settings = JianduDetectionSetting::current();
        $this->assertStringStartsWith('submitted:task_daily_1', (string) $settings->last_run_status);
    }

    public function test_questions_and_detection_settings_crud(): void
    {
        // 新建（顺带验证 trim）
        $first = $this->withHeaders($this->writeHeaders('jd-q-1'))
            ->postJson('/api/v1/jiandu/questions', ['question' => ' 甲问题 '])
            ->assertCreated()
            ->json('data.item');
        $second = $this->withHeaders($this->writeHeaders('jd-q-2'))
            ->postJson('/api/v1/jiandu/questions', ['question' => '乙问题'])
            ->assertCreated()
            ->json('data.item');

        $this->withHeaders($this->readHeaders())->getJson('/api/v1/jiandu/questions')
            ->assertOk()
            ->assertJsonPath('data.total', 2)
            ->assertJsonPath('data.items.0.question', '甲问题');

        // 停用第二条（每日检测只跑 is_active 的）
        $this->withHeaders($this->writeHeaders('jd-q-3'))
            ->patchJson('/api/v1/jiandu/questions/'.$second['id'], ['is_active' => false])
            ->assertOk()
            ->assertJsonPath('data.item.is_active', false);

        // 每日设置：平台入口 + 开关
        $this->withHeaders($this->writeHeaders('jd-s-1'))
            ->putJson('/api/v1/jiandu/detection-settings', ['platforms' => ['deepseek', 'doubao'], 'enabled' => false])
            ->assertOk()
            ->assertJsonPath('data.settings.platforms', ['deepseek', 'doubao'])
            ->assertJsonPath('data.settings.enabled', false);

        // 未知平台一律 422（白名单在服务端）
        $this->withHeaders($this->writeHeaders('jd-s-2'))
            ->putJson('/api/v1/jiandu/detection-settings', ['platforms' => ['nope']])
            ->assertStatus(422);

        // 删除
        $this->withHeaders($this->writeHeaders('jd-q-4'))
            ->deleteJson('/api/v1/jiandu/questions/'.$first['id'])
            ->assertOk();
        $this->withHeaders($this->readHeaders())->getJson('/api/v1/jiandu/questions')
            ->assertOk()
            ->assertJsonPath('data.total', 1);
    }

    // ---------------------------------------------------------------- helpers

    private function admin(): Admin
    {
        return Admin::query()->firstOrCreate(
            ['username' => 'jiandu-admin'],
            [
                'password' => 'secret-123',
                'email' => 'jiandu-admin@example.test',
                'display_name' => '见度验收',
                'role' => 'admin',
                'status' => 'active',
            ],
        );
    }

    private function adminToken(): string
    {
        return $this->admin()->createToken('jiandu-suite', ['jiandu:read', 'jiandu:write'])->plainTextToken;
    }

    /** @return array<string, string> */
    private function readHeaders(): array
    {
        return ['Authorization' => 'Bearer '.$this->adminToken()];
    }

    /** @return array<string, string> */
    private function writeHeaders(string $idempotencyKey): array
    {
        return [
            'Authorization' => 'Bearer '.$this->adminToken(),
            'X-Idempotency-Key' => $idempotencyKey,
        ];
    }

    private function fakeSessionToken(int $expiresInSeconds = 86400, string $token = 'api_usr_test-token', string $refreshToken = 'api_refresh_test-token'): void
    {
        Http::fake([
            self::BASE.'/api/v1/auth/token' => Http::response([
                'token' => $token,
                'refreshToken' => $refreshToken,
                'expiresAt' => now()->addSeconds($expiresInSeconds)->toIso8601String(),
                'refreshExpiresAt' => now()->addDays(30)->toIso8601String(),
                'user' => ['id' => 'usr_ext_1', 'name' => '验收员', 'organizationName' => '验收组织'],
            ]),
        ]);
    }

    private function connect(string $idempotencyKey): void
    {
        $this->withHeaders($this->writeHeaders($idempotencyKey))
            ->postJson('/api/v1/jiandu/session', ['account' => 'user@example.com', 'password' => 'secret-password'])
            ->assertCreated();
    }
}
