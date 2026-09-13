<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\AiModel;
use App\Models\UrlImportJob;
use App\Services\GeoFlow\UrlImportAiExecutionGuard;
use App\Services\GeoFlow\UrlImportProcessingService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use RuntimeException;
use Tests\TestCase;

final class UrlImportApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_url_import_requires_material_read_or_write_scopes(): void
    {
        $admin = $this->admin('url-api-scope');
        $token = $admin->createToken('url-api-no-scope', ['catalog:read'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/url-imports')
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'materials:read');

        $this->withToken($token)
            ->postJson('/api/v1/url-imports', ['url' => 'https://example.test/page'])
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'materials:write');
    }

    public function test_create_is_a_persisted_owned_job_and_idempotent(): void
    {
        $admin = $this->admin('url-api-owner');
        $model = $this->model($admin);
        $this->mock(UrlImportProcessingService::class, function ($mock) use ($model): void {
            $mock->shouldReceive('normalizeInputUrl')->once()->andReturn([
                'url' => 'https://example.test/page',
                'host' => 'example.test',
            ]);
            $mock->shouldReceive('assertAnalysisModelReady')->once()->andReturn($model);
        });
        $this->mock(UrlImportAiExecutionGuard::class, function ($mock) use ($admin, $model): void {
            $mock->shouldReceive('snapshotForCreation')->once()->andReturn([
                'model_access_admin_id' => $admin->id,
                'model_access_admin_role' => 'admin',
                'ai_config_access_version' => 1,
                'requested_ai_model_id' => $model->id,
                'requested_ai_model_snapshot' => '{}',
                'resolver_policy_version' => 1,
            ]);
        });

        $token = $admin->createToken('url-api-write', ['materials:read', 'materials:write'])->plainTextToken;
        $headers = [
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'url-create-idempotent-1',
        ];
        $payload = [
            'url' => 'https://example.test/page',
            'project_name' => '真实页面',
            'outputs' => ['knowledge', 'titles'],
        ];

        $first = $this->withHeaders($headers)
            ->postJson('/api/v1/url-imports', $payload)
            ->assertCreated()
            ->assertJsonPath('data.job.status', 'queued')
            ->assertJsonPath('data.job.source_domain', 'example.test');
        $second = $this->withHeaders($headers)
            ->postJson('/api/v1/url-imports', $payload)
            ->assertCreated()
            ->assertJsonPath('data.job.id', $first->json('data.job.id'));

        $this->assertDatabaseCount((new UrlImportJob)->getTable(), 1);
        $this->assertSame($first->json('data.job.id'), $second->json('data.job.id'));
        $this->assertDatabaseHas((new UrlImportJob)->getTable(), [
            'model_access_admin_id' => $admin->id,
            'source_domain' => 'example.test',
        ]);
    }

    public function test_create_requires_an_idempotency_key(): void
    {
        $admin = $this->admin('url-api-key-required');
        $token = $admin->createToken('url-api-key-required-token', ['materials:read', 'materials:write'])->plainTextToken;

        $this->withToken($token)
            ->postJson('/api/v1/url-imports', ['url' => 'https://example.test/page'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');
    }

    public function test_create_rejects_an_explicitly_empty_output_selection(): void
    {
        $admin = $this->admin('url-api-empty-outputs');
        $token = $admin->createToken('url-api-empty-outputs-token', ['materials:read', 'materials:write'])->plainTextToken;

        $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'url-empty-outputs-1',
        ])->postJson('/api/v1/url-imports', [
            'url' => 'https://example.test/page',
            'outputs' => [],
        ])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonStructure(['error' => ['details' => ['field_errors' => ['outputs']]]]);
    }

    public function test_run_rejects_a_job_with_an_active_execution_lease(): void
    {
        Queue::fake();
        $admin = $this->admin('url-api-active-lease');
        $job = $this->ownedJob($admin, [
            'status' => 'running',
            'execution_lease_token' => '11111111-1111-4111-8111-111111111111',
            'lease_expires_at' => now()->addMinutes(5),
        ]);
        $token = $admin->createToken('url-api-active-lease-token', ['materials:write'])->plainTextToken;

        $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'url-run-active-lease-1',
        ])->postJson('/api/v1/url-imports/'.$job->id.'/run')
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'url_import_in_progress');

        Queue::assertNothingPushed();
        $this->assertSame('running', $job->refresh()->status);
    }

    public function test_run_rejects_an_unknown_job_state(): void
    {
        Queue::fake();
        $admin = $this->admin('url-api-invalid-state');
        $job = $this->ownedJob($admin, ['status' => 'provider_paused']);
        $token = $admin->createToken('url-api-invalid-state-token', ['materials:write'])->plainTextToken;

        $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'url-run-invalid-state-1',
        ])->postJson('/api/v1/url-imports/'.$job->id.'/run')
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'url_import_invalid_state');

        Queue::assertNothingPushed();
        $this->assertSame('provider_paused', $job->refresh()->status);
    }

    public function test_commit_does_not_expose_unexpected_exception_messages(): void
    {
        $admin = $this->admin('url-api-commit-error');
        $job = $this->ownedJob($admin, [
            'status' => 'completed',
            'result_json' => json_encode([
                'page' => ['title' => '页面'],
                'analysis' => ['knowledge_markdown' => '正文'],
            ], JSON_UNESCAPED_UNICODE),
        ]);
        $this->mock(UrlImportProcessingService::class, function ($mock): void {
            $mock->shouldReceive('commit')
                ->once()
                ->andThrow(new RuntimeException('DB password=secret-should-not-leak'));
        });
        $token = $admin->createToken('url-api-commit-error-token', ['materials:write'])->plainTextToken;

        $response = $this->withHeaders([
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'url-commit-error-1',
        ])->postJson('/api/v1/url-imports/'.$job->id.'/commit')
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'url_import_commit_failed');

        $this->assertStringNotContainsString('secret-should-not-leak', $response->getContent());
    }

    public function test_job_detail_is_owner_scoped_and_does_not_expose_execution_secrets(): void
    {
        $owner = $this->admin('url-api-detail-owner');
        $peer = $this->admin('url-api-detail-peer');
        $job = UrlImportJob::query()->create([
            'url' => 'https://example.test/detail',
            'normalized_url' => 'https://example.test/detail',
            'source_domain' => 'example.test',
            'page_title' => '详情页面',
            'status' => 'completed',
            'current_step' => 'preview',
            'progress_percent' => 100,
            'options_json' => json_encode(['outputs' => ['knowledge']]),
            'result_json' => json_encode(['page' => ['title' => '详情页面'], 'analysis' => ['knowledge_markdown' => '正文']]),
            'error_message' => '',
            'created_by' => $owner->username,
            'model_access_admin_id' => $owner->id,
            'model_access_admin_role' => 'admin',
            'ai_config_access_version' => 1,
            'requested_ai_model_snapshot' => '{}',
            'resolver_policy_version' => 1,
            'execution_lease_token' => 'must-not-leak',
        ]);
        $ownerToken = $owner->createToken('url-owner-read', ['materials:read'])->plainTextToken;
        $peerToken = $peer->createToken('url-peer-read', ['materials:read'])->plainTextToken;

        $response = $this->withToken($ownerToken)
            ->getJson('/api/v1/url-imports/'.$job->id)
            ->assertOk()
            ->assertJsonPath('data.job.status', 'completed')
            ->assertJsonPath('data.result.analysis.knowledge_markdown', '正文');
        $this->assertStringNotContainsString('must-not-leak', $response->getContent());

        $this->withToken($peerToken)
            ->getJson('/api/v1/url-imports/'.$job->id)
            ->assertNotFound();
    }

    private function admin(string $username): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'password',
            'email' => $username.'@example.test',
            'display_name' => $username,
            'role' => 'admin',
            'status' => 'active',
        ]);
    }

    private function model(Admin $owner): AiModel
    {
        $model = new AiModel;
        $model->forceFill([
            'owner_admin_id' => $owner->id,
            'name' => 'URL API Model',
            'version' => 'v1',
            'api_key' => 'url-api-secret',
            'model_id' => 'url-api-model',
            'model_type' => 'chat',
            'api_url' => 'https://provider.example/v1',
            'failover_priority' => 100,
            'access_scope' => AiModel::ACCESS_SCOPE_USER_CONTENT,
            'status' => 'active',
        ])->save();

        return $model->refresh();
    }

    /** @param array<string,mixed> $overrides */
    private function ownedJob(Admin $owner, array $overrides = []): UrlImportJob
    {
        return UrlImportJob::query()->create(array_merge([
            'url' => 'https://example.test/import',
            'normalized_url' => 'https://example.test/import',
            'source_domain' => 'example.test',
            'page_title' => 'URL 导入任务',
            'status' => 'queued',
            'current_step' => 'queued',
            'progress_percent' => 0,
            'options_json' => json_encode(['outputs' => ['knowledge']]),
            'result_json' => '',
            'error_message' => '',
            'created_by' => $owner->username,
            'model_access_admin_id' => $owner->id,
            'model_access_admin_role' => 'admin',
            'ai_config_access_version' => 1,
            'requested_ai_model_snapshot' => '{}',
            'resolver_policy_version' => 1,
        ], $overrides));
    }
}
