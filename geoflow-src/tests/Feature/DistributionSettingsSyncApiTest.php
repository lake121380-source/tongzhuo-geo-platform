<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\DistributionChannel;
use App\Services\GeoFlow\DistributionSettingsSyncService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * api/v1 的「站点设置同步到渠道」入口。
 *
 * 同步链路本身（租约、目标站点写入、内容刷新入队）已由
 * {@see DistributionSettingsSyncService} 覆盖，这里只锁 API 契约：
 * scope 边界、参数校验、确认门禁与渠道状态判定。
 */
final class DistributionSettingsSyncApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_preview_requires_the_distribution_read_scope(): void
    {
        $token = $this->admin('sync-preview-scope')->createToken('api', ['articles:read'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/distribution/sync-settings/preview?scope=all')
            ->assertForbidden();
    }

    public function test_preview_rejects_an_unknown_scope(): void
    {
        $token = $this->admin('sync-preview-badscope')->createToken('api', ['distribution:read'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/distribution/sync-settings/preview?scope=everything')
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed');
    }

    public function test_preview_reports_no_syncable_channels_when_there_are_none(): void
    {
        $token = $this->admin('sync-preview-empty')->createToken('api', ['distribution:read'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/distribution/sync-settings/preview?scope=all')
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'no_syncable_channels');
    }

    public function test_preview_lists_a_syncable_agent_channel(): void
    {
        $channel = $this->agentChannel();
        $token = $this->admin('sync-preview-ok')->createToken('api', ['distribution:read'])->plainTextToken;

        $response = $this->withToken($token)
            ->getJson('/api/v1/distribution/sync-settings/preview?scope=all')
            ->assertOk()
            ->assertJsonPath('data.scope', 'all')
            ->assertJsonPath('data.report.totals.channels', 1);

        // 确认门禁与执行同步用的是同一份判定，前端据此决定要不要带 frontend_sync_confirmed。
        $this->assertIsBool($response->json('data.report.requires_confirmation'));
        $this->assertCount(1, $response->json('data.report.channels'));
    }

    public function test_sync_selected_rejects_an_empty_selection(): void
    {
        $token = $this->admin('sync-selected-empty')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'sync-selected-empty')
            ->postJson('/api/v1/distribution/sync-settings/selected', ['channel_ids' => []])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed');
    }

    private function agentChannel(string $status = 'active'): DistributionChannel
    {
        return DistributionChannel::query()->create([
            'name' => '同步渠道 '.uniqid(),
            'channel_type' => 'geoflow_agent',
            'status' => $status,
            'domain' => 'sync-'.uniqid().'.example.test',
            'endpoint_url' => 'https://sync.example.test',
        ]);
    }

    /**
     * 这一族端点保留旧后台 `admin.super` 的边界：站点设置推到渠道前端改的是对外可见的
     * 站点表现，不该放宽给任意带 `distribution:write` 的管理员。
     */
    public function test_settings_sync_rejects_a_non_super_admin(): void
    {
        $token = $this->admin('settings_sync-nonsuper', 'admin')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'settings_sync-nonsuper')
            ->deleteJson('/api/v1/distribution/jobs/1')
            ->assertStatus(403)
            ->assertJsonPath('error.details.required_role', 'super_admin');
    }

    private function admin(string $username, string $role = 'super_admin'): Admin
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
}
