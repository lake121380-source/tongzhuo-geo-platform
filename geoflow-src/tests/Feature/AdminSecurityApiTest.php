<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Support\AdminActivityLogger;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Tests\TestCase;

class AdminSecurityApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_current_admin_can_read_and_idempotently_update_own_profile_without_role_escalation(): void
    {
        $admin = $this->admin('profile-admin');
        $token = $admin->createToken('profile', ['account:read', 'account:write'])->plainTextToken;

        $profile = $this->withToken($token)
            ->getJson('/api/v1/admin/profile')
            ->assertOk()
            ->assertJsonPath('data.admin.username', 'profile-admin')
            ->assertJsonPath('data.admin.role', 'admin');
        $version = (string) $profile->json('data.profile_version');

        $headers = [
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'profile-update-1',
        ];
        $payload = [
            'profile_version' => $version,
            'display_name' => '运营管理员',
            'email' => 'operator@example.test',
            'role' => 'super_admin',
            'status' => 'disabled',
            'username' => 'hijacked',
        ];

        $this->withHeaders($headers)
            ->patchJson('/api/v1/admin/profile', $payload)
            ->assertOk()
            ->assertJsonPath('data.admin.display_name', '运营管理员');
        $this->withHeaders($headers)
            ->patchJson('/api/v1/admin/profile', $payload)
            ->assertOk()
            ->assertJsonPath('data.admin.display_name', '运营管理员');

        $fresh = $admin->fresh();
        $this->assertSame('运营管理员', $fresh->display_name);
        $this->assertSame('operator@example.test', $fresh->email);
        $this->assertSame('profile-admin', $fresh->username);
        $this->assertSame('admin', $fresh->role);
        $this->assertSame('active', $fresh->status);
    }

    public function test_profile_update_rejects_a_stale_profile_version(): void
    {
        $admin = $this->admin('profile-conflict');
        $token = $admin->createToken('profile', ['account:read', 'account:write'])->plainTextToken;
        $version = (string) $this->withToken($token)
            ->getJson('/api/v1/admin/profile')
            ->json('data.profile_version');
        $admin->forceFill(['display_name' => 'Changed elsewhere'])->save();

        $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'profile-update-conflict',
        ])->patchJson('/api/v1/admin/profile', [
            'profile_version' => $version,
            'display_name' => 'Stale value',
        ])->assertStatus(409)
            ->assertJsonPath('error.code', 'profile_conflict');
    }

    public function test_token_management_is_super_admin_only_and_plaintext_is_not_listed(): void
    {
        config()->set('cache.default', 'array');
        Cache::flush();
        $super = $this->admin('security-root', role: 'super_admin');
        $regular = $this->admin('security-operator');
        $superToken = $super->createToken('security', [
            'tokens:read',
            'tokens:write',
            'audit:read',
        ])->plainTextToken;
        $regularToken = $regular->createToken('security', ['tokens:read', 'tokens:write'])->plainTextToken;

        $this->withToken($regularToken)
            ->getJson('/api/v1/admin/tokens')
            ->assertForbidden()
            ->assertJsonPath('error.details.required_role', 'super_admin');

        $response = $this->withHeaders([
            'Authorization' => 'Bearer '.$superToken,
            'X-Idempotency-Key' => 'create-admin-token-1',
        ])->postJson('/api/v1/admin/tokens', [
            'name' => '部署 CLI',
            'scopes' => ['catalog:read', 'articles:read'],
        ])->assertCreated()
            ->assertJsonPath('data.one_time_plaintext', true);
        $plain = (string) $response->json('data.token');
        $this->assertNotSame('', $plain);

        $this->withHeaders([
            'Authorization' => 'Bearer '.$superToken,
            'X-Idempotency-Key' => 'create-admin-token-1',
        ])->postJson('/api/v1/admin/tokens', [
            'name' => '部署 CLI',
            'scopes' => ['articles:read', 'catalog:read'],
        ])->assertOk()
            ->assertJsonPath('data.token', $plain)
            ->assertJsonPath('data.replayed', true);

        $listed = $this->withToken($superToken)
            ->getJson('/api/v1/admin/tokens')
            ->assertOk();
        $this->assertStringNotContainsString($plain, $listed->getContent());
        $tokenId = (int) $response->json('data.record.id');

        $this->withHeaders([
            'Authorization' => 'Bearer '.$superToken,
            'X-Idempotency-Key' => 'revoke-admin-token-1',
        ])->postJson('/api/v1/admin/tokens/'.$tokenId.'/revoke')
            ->assertOk()
            ->assertJsonPath('data.status', 'revoked');
        $this->assertDatabaseMissing('personal_access_tokens', ['id' => $tokenId]);
    }

    public function test_activity_logs_are_super_admin_only_and_details_are_redacted(): void
    {
        $super = $this->admin('audit-root', role: 'super_admin');
        $regular = $this->admin('audit-reader');
        AdminActivityLogger::log($regular, 'api.audit.example', [
            'request_method' => 'POST',
            'page' => 'admin/test',
            'details' => [
                'password' => 'do-not-return',
                'api_key' => 'sk-secret-value-123456',
                'safe' => 'visible',
            ],
        ]);
        $token = $super->createToken('audit', ['audit:read'])->plainTextToken;

        $this->withToken($regular->createToken('audit', ['audit:read'])->plainTextToken)
            ->getJson('/api/v1/admin/activity-logs')
            ->assertForbidden();

        $response = $this->withToken($token)
            ->getJson('/api/v1/admin/activity-logs?action=api.audit.example')
            ->assertOk()
            ->assertJsonPath('data.items.0.details.password', '[redacted]')
            ->assertJsonPath('data.items.0.details.api_key', '[redacted]')
            ->assertJsonPath('data.items.0.details.safe', 'visible');
        $this->assertStringNotContainsString('do-not-return', $response->getContent());
        $this->assertStringNotContainsString('sk-secret-value', $response->getContent());
    }

    private function admin(string $username, string $role = 'admin'): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'secret-123',
            'email' => $username.'@example.test',
            'display_name' => $username,
            'role' => $role,
            'status' => 'active',
        ]);
    }
}
