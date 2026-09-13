<?php

namespace Tests\Feature;

use App\Models\Admin;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class AdminUsersApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_super_admin_can_manage_ordinary_admins_through_the_api(): void
    {
        $root = $this->admin('api-root', 'super_admin');
        $editor = $this->admin('api-editor', 'admin');
        $token = $root->createToken('admin-users', ['account:read', 'account:write'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/admin/users')
            ->assertOk()
            ->assertJsonPath('data.current_admin_id', $root->id)
            ->assertJsonPath('data.stats.total_admins', 2)
            ->assertJsonPath('data.items.0.username', 'api-root');

        $detail = $this->withToken($token)
            ->getJson('/api/v1/admin/users/'.$editor->id)
            ->assertOk()
            ->assertJsonPath('data.admin.username', 'api-editor');

        $createHeaders = ['Authorization' => 'Bearer '.$token, 'X-Idempotency-Key' => 'admin-create-api-1'];
        $createdResponse = $this->withHeaders($createHeaders)
            ->postJson('/api/v1/admin/users', [
                'username' => 'api-created',
                'display_name' => 'API Created',
                'email' => 'api-created@example.test',
                'password' => 'safe-password-123',
                'confirm_password' => 'safe-password-123',
                'ai_config_mode' => 'independent',
            ])
            ->assertCreated()
            ->assertJsonPath('data.admin.username', 'api-created');
        $createdId = (int) $createdResponse->json('data.admin.id');

        $this->withHeaders($createHeaders)
            ->postJson('/api/v1/admin/users', [
                'username' => 'api-created',
                'display_name' => 'API Created',
                'email' => 'api-created@example.test',
                'password' => 'safe-password-123',
                'confirm_password' => 'safe-password-123',
                'ai_config_mode' => 'independent',
            ])
            ->assertStatus(201)
            ->assertJsonPath('data.admin.id', $createdId);
        $this->assertSame(1, Admin::query()->where('username', 'api-created')->count());

        $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'admin-update-api-1',
        ])->patchJson('/api/v1/admin/users/'.$editor->id, [
            'username' => 'api-editor',
            'display_name' => '内容编辑',
            'email' => 'api-editor@example.test',
            'status' => 'active',
            'ai_config_mode' => 'independent',
            'expected_ai_config_access_version' => 1,
            'expected_shared_ai_config_owner_id' => null,
        ])->assertOk()
            ->assertJsonPath('data.admin.display_name', '内容编辑');

        $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'admin-status-api-1',
        ])->postJson('/api/v1/admin/users/'.$createdId.'/status', ['next_status' => 'inactive'])
            ->assertOk()
            ->assertJsonPath('data.admin.status', 'inactive');

        $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'admin-delete-api-1',
        ])->deleteJson('/api/v1/admin/users/'.$createdId)
            ->assertOk()
            ->assertJsonPath('data.deleted', true);
        $this->assertDatabaseMissing('admins', ['id' => $createdId]);
    }

    public function test_ordinary_admins_cannot_use_admin_user_management_endpoints(): void
    {
        $editor = $this->admin('api-editor-only', 'admin');
        $token = $editor->createToken('admin-users', ['account:read', 'account:write'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/admin/users')
            ->assertForbidden()
            ->assertJsonPath('error.details.required_role', 'super_admin');
    }

    private function admin(string $username, string $role): Admin
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
