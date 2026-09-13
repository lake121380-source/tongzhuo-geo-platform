<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\AiModel;
use App\Models\AiSourceProvider;
use App\Support\GeoFlow\ApiKeyCrypto;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * `GET ai-configuration/overview` —— AI 配置器概览计数。
 *
 * 这些数字旧后台一直有（`Admin\LegacyController::aiConfigurator` 顶部），退役后不该消失，
 * 所以这里锁的是**口径与可见性**，不是新指标：
 * ① 按 actor 作用域算的三项（可用模型数、本人模型的历史/今日用量）任何管理员都能看；
 * ② 来源 Provider 与可见度失败数只有超管能看——非超管拿到的是 **null 而不是 0**，
 *    因为 0 会被读成「没有可用的搜索来源 / 没有失败的运行」，而真相是「你没权限看」。
 */
final class AiConfiguratorOverviewApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_a_super_admin_sees_every_counter(): void
    {
        $superAdmin = $this->admin('overview_super', 'super_admin');
        $this->model($superAdmin, '概览用模型', usedToday: 7, totalUsed: 42);
        AiSourceProvider::query()->create([
            'name' => '豆包搜索',
            'provider_key' => 'doubao',
            'endpoint_url' => 'https://search.test/v1',
            'api_key' => 'test-key',
            'status' => 'active',
            'daily_limit' => 1000,
            'used_today' => 0,
            'usage_date' => now()->toDateString(),
            'total_used' => 0,
        ]);

        $response = $this->withToken($this->token($superAdmin))
            ->getJson('/api/v1/ai-configuration/overview')
            ->assertOk();

        $stats = $response->json('data.stats');
        $this->assertSame(1, $stats['model_count']);
        $this->assertSame(42, $stats['total_usage']);
        $this->assertSame(7, $stats['today_usage']);
        $this->assertSame(1, $stats['search_provider_count']);
        $this->assertIsInt($stats['visibility_failed_runs']);
        // 系统内置提示词本来就有一批，这里只要求是真实计数而不是 null。
        $this->assertIsInt($stats['prompt_count']);
    }

    public function test_a_regular_admin_gets_null_for_the_super_admin_only_counters(): void
    {
        $admin = $this->admin('overview_regular', 'admin');
        $this->model($admin, '普通管理员的模型', usedToday: 3, totalUsed: 9);

        $stats = $this->withToken($this->token($admin))
            ->getJson('/api/v1/ai-configuration/overview')
            ->assertOk()
            ->json('data.stats');

        // 「你没权限看」必须与「真的是零」分开。
        $this->assertNull($stats['search_provider_count']);
        $this->assertNull($stats['search_provider_today_usage']);
        $this->assertNull($stats['visibility_failed_runs']);

        // 自己那份仍然是真实数字。
        $this->assertSame(1, $stats['model_count']);
        $this->assertSame(9, $stats['total_usage']);
        $this->assertSame(3, $stats['today_usage']);
    }

    public function test_it_requires_the_models_scope(): void
    {
        $admin = $this->admin('overview_scope', 'admin');
        $token = $admin->createToken('api', ['materials:read'])->plainTextToken;

        $this->withToken($token)->getJson('/api/v1/ai-configuration/overview')->assertStatus(403);
    }

    private function token(Admin $admin): string
    {
        return $admin->createToken('api', ['models:read', 'models:write'])->plainTextToken;
    }

    private function admin(string $username, string $role): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'Password123!',
            'email' => $username.'@example.test',
            'display_name' => $username,
            'role' => $role,
            'status' => 'active',
        ]);
    }

    private function model(Admin $owner, string $name, int $usedToday, int $totalUsed): AiModel
    {
        $model = new AiModel([
            'name' => $name,
            'version' => 'test',
            'api_key' => app(ApiKeyCrypto::class)->encrypt('overview-test-key'),
            'model_id' => $name,
            'model_type' => 'chat',
            'api_url' => 'https://ai.test/v1',
            'daily_limit' => 100_000,
            'used_today' => $usedToday,
            'usage_date' => now()->toDateString(),
            'total_used' => $totalUsed,
            'status' => 'active',
        ]);
        $model->forceFill([
            'owner_admin_id' => $owner->id,
            'access_scope' => AiModel::ACCESS_SCOPE_USER_CONTENT,
        ])->save();

        return $model;
    }
}
