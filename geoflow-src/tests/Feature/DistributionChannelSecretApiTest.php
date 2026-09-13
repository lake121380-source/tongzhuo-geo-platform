<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\DistributionChannel;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * api/v1 的渠道密钥查看与接入包下载。
 *
 * 这两件事把已有密钥明文交出去，比轮换密钥更敏感，所以这里锁的是**门禁**：
 * 非超管必须被挡住、必须带二次密码、密码错了必须拒绝——而不是「能拿到密钥」。
 */
final class DistributionChannelSecretApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_reveal_secret_rejects_a_non_super_admin(): void
    {
        $channel = $this->agentChannel();
        $token = $this->admin('reveal-nonsuper', 'admin')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'reveal-nonsuper')
            ->postJson('/api/v1/distribution/channels/'.$channel->id.'/reveal-secret', ['password' => 'Password123!'])
            ->assertForbidden()
            ->assertJsonPath('error.details.required_role', 'super_admin');
    }

    public function test_package_download_rejects_a_non_super_admin(): void
    {
        $channel = $this->agentChannel();
        $token = $this->admin('package-nonsuper', 'admin')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'package-nonsuper')
            ->postJson('/api/v1/distribution/channels/'.$channel->id.'/package', ['package_password' => 'Password123!'])
            ->assertForbidden()
            ->assertJsonPath('error.details.required_role', 'super_admin');
    }

    public function test_reveal_secret_rejects_a_wrong_password_even_for_a_super_admin(): void
    {
        $channel = $this->agentChannel();
        $token = $this->admin('reveal-badpass', 'super_admin')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'reveal-badpass')
            ->postJson('/api/v1/distribution/channels/'.$channel->id.'/reveal-secret', ['password' => 'not-my-password'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'secret_reveal_password_invalid');
    }

    public function test_reveal_secret_requires_an_idempotency_key(): void
    {
        $channel = $this->agentChannel();
        $token = $this->admin('reveal-idem', 'super_admin')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->postJson('/api/v1/distribution/channels/'.$channel->id.'/reveal-secret', ['password' => 'Password123!'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');
    }

    public function test_reveal_secret_validates_the_password_field(): void
    {
        $channel = $this->agentChannel();
        $token = $this->admin('reveal-nopass', 'super_admin')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'reveal-nopass')
            ->postJson('/api/v1/distribution/channels/'.$channel->id.'/reveal-secret', [])
            ->assertStatus(422)
            ->assertJsonStructure(['error' => ['details' => ['field_errors' => ['password']]]]);
    }

    public function test_reveal_secret_reports_an_unknown_channel(): void
    {
        $token = $this->admin('reveal-missing', 'super_admin')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'reveal-missing')
            ->postJson('/api/v1/distribution/channels/99999/reveal-secret', ['password' => 'Password123!'])
            ->assertStatus(404)
            ->assertJsonPath('error.code', 'distribution_channel_not_found');
    }

    public function test_reveal_secret_refuses_a_channel_without_an_active_secret(): void
    {
        // 渠道存在、是 GEOFlow Agent、也在启用中，但从未配置过密钥。
        $channel = $this->agentChannel();
        $token = $this->admin('reveal-nosecret', 'super_admin')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'reveal-nosecret')
            ->postJson('/api/v1/distribution/channels/'.$channel->id.'/reveal-secret', ['password' => 'Password123!'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'active_secret_not_found');
    }

    private function agentChannel(): DistributionChannel
    {
        return DistributionChannel::query()->create([
            'name' => '密钥渠道 '.uniqid(),
            'channel_type' => 'geoflow_agent',
            'status' => 'active',
            'domain' => 'secret-'.uniqid().'.example.test',
            'endpoint_url' => 'https://secret.example.test',
        ]);
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
}
