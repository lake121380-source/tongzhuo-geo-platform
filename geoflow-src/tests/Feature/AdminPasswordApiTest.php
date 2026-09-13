<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\AdminActivityLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

/**
 * Password mutation tests intentionally run against PHPUnit's isolated
 * SQLite database.  They never use the PostgreSQL instance served on 18080.
 */
final class AdminPasswordApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_password_change_updates_hash_revokes_all_credentials_and_requires_reauth(): void
    {
        $admin = $this->admin('password-success', 'old-password');
        $token = $admin->createToken('browser', ['account:write', 'account:read'])->plainTextToken;
        $otherToken = $admin->createToken('other-device', ['account:read'])->plainTextToken;
        $before = $admin->fresh();
        $beforeVersion = (int) $before->auth_version;
        $beforeRemember = (string) $before->getRawOriginal('remember_token');

        $response = $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'password-change-success-1',
        ])->patchJson('/api/v1/admin/password', [
            'current_password' => 'old-password',
            'password' => 'new-password-123',
            'password_confirmation' => 'new-password-123',
        ])->assertOk()
            ->assertJsonPath('data.password_updated', true)
            ->assertJsonPath('data.credentials_revoked', true)
            ->assertJsonPath('data.reauth_required', true);

        $fresh = $admin->fresh();
        $this->assertTrue(Hash::check('new-password-123', (string) $fresh->getRawOriginal('password')));
        $this->assertFalse(Hash::check('old-password', (string) $fresh->getRawOriginal('password')));
        $this->assertSame($beforeVersion + 1, (int) $fresh->auth_version);
        $this->assertNotSame($beforeRemember, (string) $fresh->getRawOriginal('remember_token'));
        $this->assertDatabaseCount('personal_access_tokens', 0);

        $this->withToken($otherToken)
            ->getJson('/api/v1/admin/profile')
            ->assertUnauthorized();

        $this->assertDatabaseHas('admin_activity_logs', [
            'admin_id' => $admin->id,
            'action' => 'api.admin.password.update',
            'page' => 'admin/account',
        ]);
        $details = (string) AdminActivityLog::query()
            ->where('admin_id', $admin->id)
            ->where('action', 'api.admin.password.update')
            ->latest('id')
            ->value('details');
        $this->assertStringContainsString('credentials_revoked', $details);
        $this->assertStringNotContainsString('old-password', $details);
        $this->assertStringNotContainsString('new-password-123', $details);
        $this->assertStringNotContainsString('Bearer '.$token, $details);
    }

    public function test_wrong_current_password_returns_validation_envelope_without_mutating_credentials(): void
    {
        $admin = $this->admin('password-wrong-current', 'old-password');
        $token = $admin->createToken('browser', ['account:write'])->plainTextToken;
        $before = $admin->fresh();
        $beforeHash = (string) $before->getRawOriginal('password');
        $beforeVersion = (int) $before->auth_version;

        $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'password-change-wrong-current-1',
        ])->patchJson('/api/v1/admin/password', [
            'current_password' => 'not-the-password',
            'password' => 'new-password-123',
            'password_confirmation' => 'new-password-123',
        ])->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonPath('error.details.field_errors.current_password', '当前密码不正确');

        $after = $admin->fresh();
        $this->assertSame($beforeHash, (string) $after->getRawOriginal('password'));
        $this->assertSame($beforeVersion, (int) $after->auth_version);
        $this->assertDatabaseCount('personal_access_tokens', 1);
    }

    public function test_password_request_validation_and_scope_boundary_use_api_envelopes(): void
    {
        $admin = $this->admin('password-validation', 'old-password');
        $readOnlyToken = $admin->createToken('read-only', ['account:read'])->plainTextToken;

        $this->patchJson('/api/v1/admin/password', [
            'current_password' => 'old-password',
            'password' => 'new-password-123',
            'password_confirmation' => 'new-password-123',
        ])->assertUnauthorized();

        $this->withToken($readOnlyToken)
            ->patchJson('/api/v1/admin/password', [
                'current_password' => 'old-password',
                'password' => 'new-password-123',
                'password_confirmation' => 'new-password-123',
            ])
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'account:write');

        $writeToken = $admin->createToken('write', ['account:write'])->plainTextToken;
        $this->withHeaders(['Authorization' => 'Bearer '.$writeToken])
            ->patchJson('/api/v1/admin/password', [
                'current_password' => 'old-password',
                'password' => 'short',
                'password_confirmation' => 'different',
            ])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonStructure(['error' => ['details' => ['field_errors' => ['password']]]]);

        $this->withHeaders([
            'Authorization' => 'Bearer '.$writeToken,
            'X-Idempotency-Key' => 'bad key with spaces',
        ])->patchJson('/api/v1/admin/password', [
            'current_password' => 'old-password',
            'password' => 'new-password-123',
            'password_confirmation' => 'new-password-123',
        ])->assertStatus(422)
            ->assertJsonPath('error.code', 'invalid_idempotency_key');
    }

    public function test_extra_account_fields_are_ignored_and_successful_change_is_not_replayable_by_old_token(): void
    {
        $admin = $this->admin('password-extra-fields', 'old-password');
        $token = $admin->createToken('browser', ['account:write'])->plainTextToken;

        $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'password-change-extra-fields-1',
        ])->patchJson('/api/v1/admin/password', [
            'current_password' => 'old-password',
            'password' => 'new-password-123',
            'password_confirmation' => 'new-password-123',
            'username' => 'hijacked',
            'role' => 'super_admin',
            'status' => 'disabled',
        ])->assertOk();

        $fresh = $admin->fresh();
        $this->assertSame('password-extra-fields', $fresh->username);
        $this->assertSame('admin', $fresh->role);
        $this->assertSame('active', $fresh->status);

        // The old bearer token is deleted as part of the successful mutation;
        // it cannot be used to replay the idempotent response.
        $this->withToken($token)
            ->getJson('/api/v1/admin/profile')
            ->assertUnauthorized();
    }

    private function admin(string $username, string $password, string $role = 'admin'): Admin
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
