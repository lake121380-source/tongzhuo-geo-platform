<?php

namespace Tests\Feature;

use App\Contracts\SystemUpdater\AgentClient;
use App\Models\Admin;
use App\Models\AdminActivityLog;
use App\Models\SystemUpdateBackup;
use App\Models\SystemUpdateRun;
use App\Services\Admin\SystemUpdaterBootstrapService;
use App\Services\Api\ApiTokenService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Illuminate\Testing\TestResponse;
use Mockery\MockInterface;
use Tests\TestCase;

final class SystemUpdateApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        config([
            'geoflow.update_center_enabled' => true,
            'geoflow.update_check_enabled' => false,
            'geoflow.updater_host_root' => '/srv/geoflow',
        ]);
    }

    public function test_dedicated_scopes_and_super_admin_role_protect_the_update_center(): void
    {
        $this->assertContains('system:read', app(ApiTokenService::class)->getCliLoginScopes());
        $this->assertContains('system:write', app(ApiTokenService::class)->getCliLoginScopes());
        $super = $this->admin('system-scope-super', 'super_admin');
        $regular = $this->admin('system-scope-regular', 'admin');

        $this->withToken($super->createToken('wrong', ['audit:read'])->plainTextToken)
            ->getJson('/api/v1/system-updates')
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'system:read');

        $this->withToken($regular->createToken('system', ['system:read', 'system:write'])->plainTextToken)
            ->getJson('/api/v1/system-updates')
            ->assertForbidden()
            ->assertJsonPath('error.details.required_role', 'super_admin');
    }

    public function test_summary_projects_real_agent_state_recovery_points_and_read_only_legacy_history(): void
    {
        $client = new SystemUpdateApiAgentStub;
        $client->points = [
            $client->recoveryPoint('20260909T110000Z-aabbccdd', 'update-to-3.1.0'),
            $client->recoveryPoint('20260908T110000Z-11223344', 'manual-backup'),
        ];
        $this->app->instance(AgentClient::class, $client);
        $admin = $this->admin('system-summary-super', 'super_admin');
        $run = SystemUpdateRun::query()->create([
            'run_uuid' => 'legacy-run-1',
            'action' => 'apply',
            'status' => 'succeeded',
            'target_version' => '3.0.0',
            'started_by_admin_id' => $admin->id,
        ]);
        SystemUpdateBackup::query()->create([
            'backup_uuid' => 'legacy-backup-1',
            'run_id' => $run->id,
            'backup_path' => '/private/legacy-backup-1',
            'manifest_path' => '/private/legacy-backup-1/manifest.json',
            'status' => 'available',
            'created_by_admin_id' => $admin->id,
        ]);

        $response = $this->withToken($this->token($admin, ['system:read']))
            ->getJson('/api/v1/system-updates')
            ->assertOk()
            ->assertJsonPath('data.updater.connection', 'connected')
            ->assertJsonPath('data.updater.readiness', 'ready')
            ->assertJsonPath('data.updater.recovery_points.0.rollback_allowed', true)
            ->assertJsonPath('data.updater.recovery_points.1.rollback_allowed', false)
            ->assertJsonPath('data.updater.actions.backup', true)
            ->assertJsonPath('data.history.runs.items.0.run_uuid', 'legacy-run-1')
            ->assertJsonPath('data.history.backups.items.0.backup_uuid', 'legacy-backup-1')
            ->assertJsonMissingPath('data.history.backups.items.0.backup_path');

        $this->assertSame([], $response->json('data.updater.install_commands'));
    }

    public function test_update_requires_idempotency_password_and_authorization_then_replays_once(): void
    {
        $client = new SystemUpdateApiAgentStub;
        $this->app->instance(AgentClient::class, $client);
        $admin = $this->admin('system-update-super', 'super_admin');
        $token = $this->token($admin, ['system:write']);
        $payload = [
            'current_admin_password' => 'secret-123',
            'updater_authorization_code' => '123456',
        ];

        $this->withToken($token)->postJson('/api/v1/system-updates/operations/update', $payload)
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'idempotency_key_required');

        $first = $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'system-update-1')
            ->postJson('/api/v1/system-updates/operations/update', $payload)
            ->assertStatus(202)
            ->assertJsonPath('data.operation.kind', 'update')
            ->json();
        $replayed = $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'system-update-1')
            ->postJson('/api/v1/system-updates/operations/update', $payload)
            ->assertStatus(202)
            ->json();

        $this->assertSame($first, $replayed);
        $this->assertSame(['123456'], $client->updates);
        $activity = AdminActivityLog::query()->where('action', 'api.system_update.operation_started')->firstOrFail();
        $this->assertStringNotContainsString('secret-123', (string) $activity->details);
        $auditDetails = json_decode((string) $activity->details, true, 16, JSON_THROW_ON_ERROR);
        $this->assertArrayNotHasKey('updater_authorization_code', $auditDetails);
        $this->assertArrayNotHasKey('current_admin_password', $auditDetails);
    }

    public function test_invalid_password_and_unapproved_recovery_point_never_reach_the_agent(): void
    {
        $client = new SystemUpdateApiAgentStub;
        $client->points = [$client->recoveryPoint('20260909T110000Z-aabbccdd', 'update-to-3.1.0')];
        $this->app->instance(AgentClient::class, $client);
        $admin = $this->admin('system-rollback-super', 'super_admin');
        $token = $this->token($admin, ['system:write']);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'system-password-wrong')
            ->postJson('/api/v1/system-updates/operations/backup', [
                'current_admin_password' => 'wrong',
                'updater_authorization_code' => '123456',
            ])
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'admin_password_invalid');

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'system-rollback-old')
            ->postJson('/api/v1/system-updates/operations/rollback', [
                'current_admin_password' => 'secret-123',
                'updater_authorization_code' => '654321',
                'recovery_point_id' => '20260908T110000Z-11223344',
            ])
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'system_updater_recovery_point_not_allowed');

        $this->assertSame([], $client->backups);
        $this->assertSame([], $client->rollbacks);
    }

    public function test_backup_rollback_and_verification_use_the_independent_agent(): void
    {
        $client = new SystemUpdateApiAgentStub;
        $allowedPoint = '20260909T110000Z-aabbccdd';
        $client->points = [$client->recoveryPoint($allowedPoint, 'update-to-3.1.0')];
        $this->app->instance(AgentClient::class, $client);
        $admin = $this->admin('system-operations-super', 'super_admin');
        $token = $this->token($admin, ['system:write']);

        $this->operation($token, 'backup', 'system-backup-1', [
            'current_admin_password' => 'secret-123',
            'updater_authorization_code' => '111111',
        ])->assertStatus(202)->assertJsonPath('data.operation.kind', 'backup');
        $this->operation($token, 'rollback', 'system-rollback-1', [
            'current_admin_password' => 'secret-123',
            'updater_authorization_code' => '222222',
            'recovery_point_id' => $allowedPoint,
        ])->assertStatus(202)->assertJsonPath('data.operation.kind', 'rollback');
        $this->operation($token, 'verify', 'system-verify-1', [])
            ->assertStatus(202)->assertJsonPath('data.operation.kind', 'verify');

        $this->assertSame(['111111'], $client->backups);
        $this->assertSame([[$allowedPoint, '222222']], $client->rollbacks);
        $this->assertSame(1, $client->verifications);
    }

    public function test_verified_bootstrap_package_can_be_prepared_replayed_and_downloaded(): void
    {
        Storage::fake('local');
        $path = 'system-updater/bootstrap/0.2.0/geoflow-updater_0.2.0_linux_amd64.tar.gz';
        Storage::disk('local')->put($path, 'verified archive');
        $this->mock(SystemUpdaterBootstrapService::class, function (MockInterface $mock) use ($path): void {
            $prepared = [
                'version' => '0.2.0',
                'filename' => basename($path),
                'path' => $path,
                'sha256' => hash('sha256', 'verified archive'),
                'size' => strlen('verified archive'),
                'platform' => 'linux-amd64',
            ];
            $mock->shouldReceive('prepare')->once()->andReturn($prepared);
            $mock->shouldReceive('download')->once()->andReturn($prepared);
        });
        $admin = $this->admin('system-package-super', 'super_admin');
        $token = $this->token($admin, ['system:read', 'system:write']);

        $payload = $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'system-prepare-package-1')
            ->postJson('/api/v1/system-updates/updater/prepare')
            ->assertStatus(202)
            ->assertJsonPath('data.prepared.filename', basename($path))
            ->assertJsonMissingPath('data.prepared.path')
            ->json();
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'system-prepare-package-1')
            ->postJson('/api/v1/system-updates/updater/prepare')
            ->assertStatus(202)
            ->assertExactJson($payload);

        $this->withToken($token)
            ->get('/api/v1/system-updates/updater/package')
            ->assertOk()
            ->assertDownload(basename($path));
        $this->assertDatabaseHas('admin_activity_logs', [
            'admin_id' => $admin->id,
            'action' => 'api.system_update.prepare',
        ]);
    }

    public function test_uncertain_agent_dispatch_is_not_sent_twice_with_the_same_key(): void
    {
        $client = new SystemUpdateApiAgentStub;
        $client->failUpdatesAfterAccept = true;
        $this->app->instance(AgentClient::class, $client);
        $admin = $this->admin('system-uncertain-super', 'super_admin');
        $token = $this->token($admin, ['system:write']);
        $payload = [
            'current_admin_password' => 'secret-123',
            'updater_authorization_code' => '333333',
        ];

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'system-update-uncertain-1')
            ->postJson('/api/v1/system-updates/operations/update', $payload)
            ->assertStatus(503)
            ->assertJsonPath('error.code', 'system_updater_operation_failed');
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'system-update-uncertain-1')
            ->postJson('/api/v1/system-updates/operations/update', $payload)
            ->assertConflict()
            ->assertJsonPath('error.code', 'idempotency_in_progress');

        $this->assertSame(['333333'], $client->updates);
    }

    private function operation(string $token, string $kind, string $key, array $payload): TestResponse
    {
        return $this->withToken($token)
            ->withHeader('X-Idempotency-Key', $key)
            ->postJson('/api/v1/system-updates/operations/'.$kind, $payload);
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

    /** @param list<string> $scopes */
    private function token(Admin $admin, array $scopes): string
    {
        return $admin->createToken('system-api', $scopes)->plainTextToken;
    }
}

final class SystemUpdateApiAgentStub implements AgentClient
{
    public bool $failUpdatesAfterAccept = false;

    /** @var list<string> */
    public array $updates = [];

    /** @var list<string> */
    public array $backups = [];

    /** @var list<array{0:string,1:string}> */
    public array $rollbacks = [];

    public int $verifications = 0;

    /** @var list<array<string, mixed>> */
    public array $points = [];

    public function status(): array
    {
        return [
            'schema_version' => 1,
            'status' => 'pass',
            'updater_version' => '0.2.0',
            'instance' => ['id' => 'primary', 'version' => '3.0.0', 'release_sequence' => 18],
            'checks' => [
                ['id' => 'mutation-authorization', 'status' => 'pass', 'message' => 'ready'],
                ['id' => 'retired-update-worker', 'status' => 'pass', 'message' => 'absent'],
            ],
        ];
    }

    public function startUpdate(string $authorizationCode): array
    {
        $this->updates[] = $authorizationCode;
        if ($this->failUpdatesAfterAccept) {
            throw new \RuntimeException('connection closed after updater accepted the operation');
        }

        return $this->operation('update');
    }

    public function startBackup(string $authorizationCode): array
    {
        $this->backups[] = $authorizationCode;

        return $this->operation('backup');
    }

    public function startRollback(string $recoveryPointId, string $authorizationCode): array
    {
        $this->rollbacks[] = [$recoveryPointId, $authorizationCode];

        return $this->operation('rollback');
    }

    public function startVerify(): array
    {
        $this->verifications++;

        return $this->operation('verify');
    }

    public function currentOperation(): ?array
    {
        return null;
    }

    public function recoveryPoints(): array
    {
        return $this->points;
    }

    /** @return array<string, mixed> */
    public function recoveryPoint(string $id, string $reason): array
    {
        return [
            'schema_version' => 1,
            'id' => $id,
            'instance_id' => 'primary',
            'reason' => $reason,
            'created_at' => '2026-09-09T11:00:00Z',
            'version' => '3.0.0',
            'release_sequence' => 18,
        ];
    }

    /** @return array<string, mixed> */
    private function operation(string $kind): array
    {
        return [
            'schema_version' => 1,
            'id' => '20260909T123456.000000000Z-0011223344556677',
            'instance_id' => 'primary',
            'kind' => $kind,
            'status' => 'queued',
            'stages' => [],
            'started_at' => '2026-09-09T12:34:56Z',
        ];
    }
}
