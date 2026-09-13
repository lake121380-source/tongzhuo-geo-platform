<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\DistributionChannel;
use App\Models\DistributionChannelSecret;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class DistributionChannelApiTest extends TestCase
{
    use RefreshDatabase;

    private function admin(string $username = 'distribution_api_admin', string $role = 'admin'): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'secret',
            'email' => $username.'@example.test',
            'display_name' => 'Distribution API',
            'role' => $role,
            'status' => 'active',
        ]);
    }

    private function token(Admin $admin, array $scopes): string
    {
        return $admin->createToken('distribution-test', $scopes)->plainTextToken;
    }

    public function test_agent_channel_creation_returns_one_time_secret_and_only_ciphertext_is_persisted(): void
    {
        $token = $this->token($admin = $this->admin(), ['distribution:write']);

        $response = $this->withHeader('Authorization', 'Bearer '.$token)
            ->withHeader('X-Idempotency-Key', 'distribution-create-1')
            ->postJson('/api/v1/distribution/channels', [
                'name' => '官网 Agent',
                'endpoint_url' => 'https://site.example.test/agent',
                'description' => '测试节点',
            ]);

        $response->assertCreated()
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.channel.channel_type', 'geoflow_agent')
            ->assertJsonPath('data.channel.domain', 'site.example.test')
            ->assertJsonPath('data.one_time_secret.key_id', fn ($value) => is_string($value) && str_starts_with($value, 'gfk_'))
            ->assertJsonPath('data.one_time_secret.secret', fn ($value) => is_string($value) && str_starts_with($value, 'gfsec_'))
            ->assertJsonMissingPath('data.channel.channel_config');

        $channel = DistributionChannel::query()->firstOrFail();
        $secret = DistributionChannelSecret::query()->where('distribution_channel_id', $channel->id)->firstOrFail();
        $plainSecret = $response->json('data.one_time_secret.secret');
        $this->assertNotSame($plainSecret, $secret->secret_ciphertext);
        $this->assertStringStartsWith('enc:v1:', $secret->secret_ciphertext);
        $this->assertSame($admin->id, $channel->created_by_admin_id);
    }

    public function test_replaying_create_idempotency_key_does_not_reveal_secret_again_or_create_duplicate(): void
    {
        $token = $this->token($this->admin('distribution_replay_admin'), ['distribution:write']);
        $headers = [
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'distribution-create-replay',
        ];
        $payload = [
            'name' => 'Replay Agent',
            'endpoint_url' => 'https://replay.example.test/agent',
        ];

        $first = $this->withHeaders($headers)->postJson('/api/v1/distribution/channels', $payload)->assertCreated();
        $second = $this->withHeaders($headers)->postJson('/api/v1/distribution/channels', $payload)->assertCreated();

        $this->assertCount(1, DistributionChannel::query()->get());
        $this->assertCount(1, DistributionChannelSecret::query()->get());
        $this->assertNotNull($first->json('data.one_time_secret.secret'));
        $this->assertNull($second->json('data.one_time_secret'));
        $this->assertSame($first->json('data.channel.id'), $second->json('data.channel.id'));
    }

    public function test_channel_creation_requires_distribution_write_scope_and_idempotency_key(): void
    {
        $readToken = $this->token($this->admin('distribution_read_admin'), ['distribution:read']);
        $this->withHeader('Authorization', 'Bearer '.$readToken)
            ->withHeader('X-Idempotency-Key', 'distribution-forbidden')
            ->postJson('/api/v1/distribution/channels', [
                'name' => 'Forbidden',
                'endpoint_url' => 'https://forbidden.example.test/agent',
            ])
            ->assertForbidden();

        $this->flushHeaders();
        $writeToken = $this->token($this->admin('distribution_missing_key_admin'), ['distribution:write']);
        $this->withHeader('Authorization', 'Bearer '.$writeToken)
            ->postJson('/api/v1/distribution/channels', [
                'name' => 'Missing key',
                'endpoint_url' => 'https://missing-key.example.test/agent',
            ])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');
    }

    public function test_channel_update_pause_and_activate_are_persisted_and_audited(): void
    {
        $admin = $this->admin('distribution_lifecycle_admin');
        $token = $this->token($admin, ['distribution:read', 'distribution:write']);
        $headers = ['Authorization' => 'Bearer '.$token];

        $created = $this->withHeaders($headers)
            ->withHeader('X-Idempotency-Key', 'distribution-lifecycle-create')
            ->postJson('/api/v1/distribution/channels', [
                'name' => 'Lifecycle Agent',
                'endpoint_url' => 'https://lifecycle.example.test/agent',
            ])
            ->assertCreated();
        $channelId = (int) $created->json('data.channel.id');

        $this->withHeaders($headers)
            ->withHeader('X-Idempotency-Key', 'distribution-lifecycle-update')
            ->patchJson('/api/v1/distribution/channels/'.$channelId, [
                'name' => 'Lifecycle Agent Updated',
                'description' => 'updated through api',
            ])
            ->assertOk()
            ->assertJsonPath('data.channel.name', 'Lifecycle Agent Updated');

        $this->withHeaders($headers)
            ->withHeader('X-Idempotency-Key', 'distribution-lifecycle-pause')
            ->postJson('/api/v1/distribution/channels/'.$channelId.'/pause')
            ->assertOk()
            ->assertJsonPath('data.channel.status', 'paused');

        $this->withHeaders($headers)
            ->withHeader('X-Idempotency-Key', 'distribution-lifecycle-activate')
            ->postJson('/api/v1/distribution/channels/'.$channelId.'/activate')
            ->assertOk()
            ->assertJsonPath('data.channel.status', 'active');

        $this->assertDatabaseHas('distribution_channels', [
            'id' => $channelId,
            'name' => 'Lifecycle Agent Updated',
            'status' => 'active',
        ]);
        $this->assertDatabaseHas('distribution_logs', [
            'distribution_channel_id' => $channelId,
            'event' => 'channel.updated',
        ]);
        $this->assertDatabaseHas('distribution_logs', [
            'distribution_channel_id' => $channelId,
            'event' => 'channel.paused',
        ]);
        $this->assertDatabaseHas('distribution_logs', [
            'distribution_channel_id' => $channelId,
            'event' => 'channel.activated',
        ]);
    }

    public function test_secret_rotation_is_super_admin_only_and_plaintext_is_one_time(): void
    {
        $admin = $this->admin('distribution_rotate_admin', 'super_admin');
        $token = $this->token($admin, ['distribution:read', 'distribution:write']);
        $headers = ['Authorization' => 'Bearer '.$token];
        $created = $this->withHeaders($headers)
            ->withHeader('X-Idempotency-Key', 'distribution-rotate-create')
            ->postJson('/api/v1/distribution/channels', [
                'name' => 'Rotate Agent',
                'endpoint_url' => 'https://rotate.example.test/agent',
            ])
            ->assertCreated();
        $channelId = (int) $created->json('data.channel.id');
        $oldSecret = (string) $created->json('data.one_time_secret.secret');

        $first = $this->withHeaders($headers)
            ->withHeader('X-Idempotency-Key', 'distribution-rotate-once')
            ->postJson('/api/v1/distribution/channels/'.$channelId.'/rotate-secret')
            ->assertOk();
        $newSecret = (string) $first->json('data.one_time_secret.secret');
        $this->assertNotSame('', $newSecret);
        $this->assertNotSame($oldSecret, $newSecret);

        $this->withHeaders($headers)
            ->withHeader('X-Idempotency-Key', 'distribution-rotate-once')
            ->postJson('/api/v1/distribution/channels/'.$channelId.'/rotate-secret')
            ->assertOk()
            ->assertJsonMissingPath('data.one_time_secret');

        $this->assertSame(1, DistributionChannelSecret::query()
            ->where('distribution_channel_id', $channelId)
            ->where('status', 'active')
            ->count());
        $this->assertDatabaseHas('distribution_channel_secrets', [
            'distribution_channel_id' => $channelId,
            'status' => 'revoked',
        ]);
    }

    public function test_channel_delete_requires_preview_fingerprint_and_removes_dependencies(): void
    {
        $admin = $this->admin('distribution_delete_admin', 'super_admin');
        $token = $this->token($admin, ['distribution:read', 'distribution:write']);
        $headers = ['Authorization' => 'Bearer '.$token];
        $created = $this->withHeaders($headers)
            ->withHeader('X-Idempotency-Key', 'distribution-delete-create')
            ->postJson('/api/v1/distribution/channels', [
                'name' => 'Delete Agent',
                'endpoint_url' => 'https://delete.example.test/agent',
            ])
            ->assertCreated();
        $channelId = (int) $created->json('data.channel.id');

        $preview = $this->withHeaders($headers)
            ->getJson('/api/v1/distribution/channels/'.$channelId.'/deletion-preview')
            ->assertOk();
        $fingerprint = (string) $preview->json('data.impact.impact_fingerprint');
        $this->assertSame(64, strlen($fingerprint));

        $this->withHeaders($headers)
            ->withHeader('X-Idempotency-Key', 'distribution-delete-prepare')
            ->postJson('/api/v1/distribution/channels/'.$channelId.'/prepare-delete')
            ->assertOk()
            ->assertJsonPath('data.channel.status', 'deleting');

        $afterPrepare = $this->withHeaders($headers)
            ->getJson('/api/v1/distribution/channels/'.$channelId.'/deletion-preview')
            ->assertOk();
        $fingerprint = (string) $afterPrepare->json('data.impact.impact_fingerprint');

        $this->withHeaders($headers)
            ->withHeader('X-Idempotency-Key', 'distribution-delete-complete')
            ->postJson('/api/v1/distribution/channels/'.$channelId.'/delete', [
                'confirmation_name' => 'Delete Agent',
                'impact_fingerprint' => $fingerprint,
                'ack_credentials' => true,
                'ack_history' => true,
            ])
            ->assertOk()
            ->assertJsonPath('data.deleted', true)
            ->assertJsonPath('data.channel_id', $channelId);

        $this->assertDatabaseMissing('distribution_channels', ['id' => $channelId]);
        $this->assertDatabaseMissing('distribution_channel_secrets', ['distribution_channel_id' => $channelId]);
    }
}
