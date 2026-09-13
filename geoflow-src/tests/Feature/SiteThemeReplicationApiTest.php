<?php

namespace Tests\Feature;

use App\Jobs\RunSiteThemeReplicationJob;
use App\Models\Admin;
use App\Models\AiModel;
use App\Models\SiteThemeReplication;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

final class SiteThemeReplicationApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_theme_replication_api_requires_super_admin_even_with_seo_scope(): void
    {
        $admin = $this->admin('theme-api-editor', 'admin');
        $token = $admin->createToken('theme-api', ['seo:read', 'seo:write'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/site-settings/theme-replications')
            ->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden');
    }

    public function test_theme_replication_create_requires_idempotency_key(): void
    {
        $admin = $this->admin('theme-api-idempotency', 'super_admin');
        $token = $admin->createToken('theme-api', ['seo:write'])->plainTextToken;

        $this->withToken($token)
            ->postJson('/api/v1/site-settings/theme-replications', $this->payload())
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');

        $this->assertDatabaseMissing('site_theme_replications', ['theme_id' => 'api-theme-clone']);
    }

    public function test_super_admin_can_create_list_and_show_theme_replication_via_api(): void
    {
        Queue::fake();
        $admin = $this->admin('theme-api-root', 'super_admin');
        $token = $admin->createToken('theme-api', ['seo:read', 'seo:write'])->plainTextToken;
        $headers = ['Authorization' => 'Bearer '.$token, 'X-Idempotency-Key' => 'theme-api-create-1'];

        $response = $this->withHeaders($headers)
            ->postJson('/api/v1/site-settings/theme-replications', $this->payload())
            ->assertCreated()
            ->assertJsonPath('data.replication.name', 'API Theme Clone')
            ->assertJsonPath('data.replication.theme_id', 'api-theme-clone')
            ->assertJsonPath('data.replication.status', SiteThemeReplication::STATUS_QUEUED)
            ->assertJsonPath('data.replication.current_version', 0);

        $replicationId = (int) $response->json('data.replication.id');
        $this->assertDatabaseHas('site_theme_replications', [
            'id' => $replicationId,
            'created_by_admin_id' => $admin->id,
            'theme_id' => 'api-theme-clone',
            'status' => SiteThemeReplication::STATUS_QUEUED,
        ]);
        Queue::assertPushed(RunSiteThemeReplicationJob::class, fn (RunSiteThemeReplicationJob $job): bool => $job->replicationId === $replicationId);

        $this->withToken($token)
            ->getJson('/api/v1/site-settings/theme-replications')
            ->assertOk()
            ->assertJsonPath('data.items.0.id', $replicationId)
            ->assertJsonPath('data.items.0.theme_id', 'api-theme-clone')
            ->assertJsonPath('data.schema_ready', true);

        $this->withToken($token)
            ->getJson('/api/v1/site-settings/theme-replications/'.$replicationId)
            ->assertOk()
            ->assertJsonPath('data.replication.id', $replicationId)
            ->assertJsonPath('data.replication.progress.status', SiteThemeReplication::STATUS_QUEUED)
            ->assertJsonCount(2, 'data.replication.progress.logs');
    }

    public function test_create_is_idempotent_and_failed_replication_can_be_retried(): void
    {
        Queue::fake();
        $admin = $this->admin('theme-api-retry', 'super_admin');
        $token = $admin->createToken('theme-api', ['seo:read', 'seo:write'])->plainTextToken;
        $headers = ['Authorization' => 'Bearer '.$token, 'X-Idempotency-Key' => 'theme-api-replay-1'];
        $model = $this->activeChatModel();
        $payload = $this->payload('replay-theme', (int) $model->id);

        $first = $this->withHeaders($headers)
            ->postJson('/api/v1/site-settings/theme-replications', $payload)
            ->assertCreated();
        $firstId = (int) $first->json('data.replication.id');
        $this->withHeaders($headers)
            ->postJson('/api/v1/site-settings/theme-replications', $payload)
            ->assertCreated()
            ->assertJsonPath('data.replication.id', $firstId);
        $this->assertSame(1, SiteThemeReplication::query()->where('theme_id', 'replay-theme')->count());

        $failed = SiteThemeReplication::query()->create([
            'name' => 'Failed API Clone',
            'theme_id' => 'failed-api-clone',
            'ai_model_id' => $this->activeChatModel()->id,
            'status' => SiteThemeReplication::STATUS_FAILED,
            'home_url' => 'https://example.com/',
            'category_url' => 'https://example.com/blog',
            'article_url' => 'https://example.com/blog/demo',
            'style_preference' => 'content_site',
            'error_message' => 'temporary failure',
        ]);

        $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'theme-api-retry-1',
        ])->postJson('/api/v1/site-settings/theme-replications/'.$failed->id.'/retry')
            ->assertOk()
            ->assertJsonPath('data.replication.status', SiteThemeReplication::STATUS_QUEUED)
            ->assertJsonPath('data.replication.error_message', null);

        Queue::assertPushed(RunSiteThemeReplicationJob::class, fn (RunSiteThemeReplicationJob $job): bool => $job->replicationId === (int) $failed->id);
    }

    public function test_theme_replication_write_actions_require_idempotency_key_and_ready_state(): void
    {
        $admin = $this->admin('theme-api-actions', 'super_admin');
        $token = $admin->createToken('theme-api', ['seo:read', 'seo:write'])->plainTextToken;
        $replication = SiteThemeReplication::query()->create([
            'name' => 'Queued API Clone',
            'theme_id' => 'queued-api-clone',
            'ai_model_id' => $this->activeChatModel()->id,
            'status' => SiteThemeReplication::STATUS_QUEUED,
            'home_url' => 'https://example.com/',
            'category_url' => 'https://example.com/blog',
            'article_url' => 'https://example.com/blog/demo',
            'style_preference' => 'content_site',
        ]);

        $this->withToken($token)
            ->postJson('/api/v1/site-settings/theme-replications/'.$replication->id.'/iterate', ['feedback' => 'please refine'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');

        $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'theme-api-iterate-unavailable',
        ])->postJson('/api/v1/site-settings/theme-replications/'.$replication->id.'/iterate', ['feedback' => 'please refine'])
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'iteration_unavailable');
    }

    /** @return array<string, mixed> */
    private function payload(string $themeId = 'api-theme-clone', ?int $modelId = null): array
    {
        $modelId ??= (int) $this->activeChatModel()->id;

        return [
            'name' => 'API Theme Clone',
            'theme_id' => $themeId,
            'base_theme_id' => null,
            'ai_model_id' => $modelId,
            'home_url' => 'https://example.com/',
            'category_url' => 'https://example.com/blog',
            'article_url' => 'https://example.com/blog/demo',
            'style_preference' => 'content_site',
            'compliance_ack' => true,
        ];
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

    private function activeChatModel(): AiModel
    {
        return AiModel::query()->create([
            'name' => 'Theme API Chat',
            'model_id' => 'theme-api-chat-'.uniqid(),
            'model_type' => 'chat',
            'api_key' => 'secret',
            'api_url' => 'https://api.example.com',
            'status' => 'active',
        ]);
    }
}
