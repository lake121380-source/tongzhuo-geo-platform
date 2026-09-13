<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\SiteSetting;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class SiteSettingsApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_regular_admin_gets_explicit_forbidden_when_updating_analytics_code(): void
    {
        SiteSetting::query()->create([
            'setting_key' => 'analytics_code',
            'setting_value' => '<script>original()</script>',
        ]);
        $admin = $this->admin('site-settings-editor', 'admin');
        $token = $admin->createToken('site-settings-api', ['seo:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'site-settings-analytics-denied')
            ->patchJson('/api/v1/site-settings', [
                'site_name' => 'Should not change',
                'analytics_code' => '<script>changed()</script>',
            ])
            ->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden')
            ->assertJsonPath('error.details.required_role', 'super_admin')
            ->assertJsonPath('error.details.field', 'analytics_code');

        $this->assertDatabaseHas('site_settings', [
            'setting_key' => 'analytics_code',
            'setting_value' => '<script>original()</script>',
        ]);
        $this->assertDatabaseMissing('site_settings', [
            'setting_key' => 'site_name',
            'setting_value' => 'Should not change',
        ]);
    }

    public function test_super_admin_can_update_analytics_code(): void
    {
        $admin = $this->admin('site-settings-root', 'super_admin');
        $token = $admin->createToken('site-settings-api', ['seo:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'site-settings-analytics-allowed')
            ->patchJson('/api/v1/site-settings', [
                'analytics_code' => '<script>trusted()</script>',
            ])
            ->assertOk()
            ->assertJsonPath('data.settings.analytics_code', '<script>trusted()</script>');

        $this->assertDatabaseHas('site_settings', [
            'setting_key' => 'analytics_code',
            'setting_value' => '<script>trusted()</script>',
        ]);
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
