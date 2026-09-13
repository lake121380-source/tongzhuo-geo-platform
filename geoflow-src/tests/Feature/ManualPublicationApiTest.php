<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\ManualPublication;
use App\Models\ManualPublicationAccount;
use App\Models\ManualPublicationPersona;
use App\Services\GeoFlow\ManualPublicationService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class ManualPublicationApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_read_scope_lists_work_orders_and_options_but_wrong_scope_is_rejected(): void
    {
        $admin = $this->admin('manual-reader', 'super_admin');
        [$persona, $account] = $this->identity($admin);
        $publication = ManualPublication::query()->create([
            'type' => ManualPublication::TYPE_COMMENT,
            'persona_id' => $persona->id,
            'account_id' => $account->id,
            'assigned_admin_id' => $admin->id,
            'created_by_admin_id' => $admin->id,
            'platform' => ManualPublicationAccount::PLATFORM_ZHIHU,
            'target_url' => 'https://example.test/questions/1',
            'target_context' => '测试讨论上下文',
            'content' => '测试发布内容',
            'content_fingerprint' => hash('sha256', '测试发布内容'),
            'identity_snapshot' => [],
        ]);

        $wrongToken = $admin->createToken('manual-wrong-scope', ['materials:read'])->plainTextToken;
        $this->withToken($wrongToken)
            ->getJson('/api/v1/manual-publications/management')
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'articles:read');

        $token = $admin->createToken('manual-reader-scope', ['articles:read'])->plainTextToken;
        $this->withToken($token)
            ->getJson('/api/v1/manual-publications/management')
            ->assertOk()
            ->assertJsonPath('data.items.0.id', (int) $publication->id)
            ->assertJsonPath('data.options.personas.0.id', (int) $persona->id)
            ->assertJsonPath('data.options.accounts.0.id', (int) $account->id)
            ->assertJsonPath('data.pagination.total', 1);
    }

    public function test_create_is_idempotent_and_update_rejects_stale_revision(): void
    {
        $admin = $this->admin('manual-writer', 'super_admin');
        [$persona, $account] = $this->identity($admin);
        $token = $admin->createToken('manual-writer-token', ['articles:read', 'articles:write'])->plainTextToken;
        $payload = $this->payload($persona, $account, $admin);

        $first = $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'manual-create-replay')
            ->postJson('/api/v1/manual-publications', $payload)
            ->assertCreated()
            ->assertJsonPath('data.publication.status', ManualPublication::STATUS_DRAFT);
        $second = $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'manual-create-replay')
            ->postJson('/api/v1/manual-publications', $payload)
            ->assertCreated();

        $this->assertSame($first->json('data.publication.id'), $second->json('data.publication.id'));
        $this->assertDatabaseCount('manual_publications', 1);

        $id = (int) $first->json('data.publication.id');
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'manual-update-ok')
            ->patchJson('/api/v1/manual-publications/'.$id, [
                ...$payload,
                'content' => '更新后的发布内容',
                'revision' => 1,
            ])
            ->assertOk()
            ->assertJsonPath('data.publication.revision', 2)
            ->assertJsonPath('data.publication.content', '更新后的发布内容');

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'manual-update-stale')
            ->patchJson('/api/v1/manual-publications/'.$id, [
                ...$payload,
                'revision' => 1,
            ])
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'manual_publication_update_failed');
    }

    public function test_transition_requires_current_revision_and_completion_url(): void
    {
        $admin = $this->admin('manual-transition', 'super_admin');
        [$persona, $account] = $this->identity($admin);
        $token = $admin->createToken('manual-transition-token', ['articles:read', 'articles:write'])->plainTextToken;
        $created = $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'manual-transition-create')
            ->postJson('/api/v1/manual-publications', $this->payload($persona, $account, $admin))
            ->assertCreated();
        $id = (int) $created->json('data.publication.id');

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'manual-transition-ready')
            ->postJson('/api/v1/manual-publications/'.$id.'/transition', [
                'target_status' => ManualPublication::STATUS_READY,
                'revision' => 1,
            ])
            ->assertOk()
            ->assertJsonPath('data.publication.status', ManualPublication::STATUS_READY)
            ->assertJsonPath('data.publication.revision', 2);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'manual-transition-stale')
            ->postJson('/api/v1/manual-publications/'.$id.'/transition', [
                'target_status' => ManualPublication::STATUS_IN_PROGRESS,
                'revision' => 1,
            ])
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'manual_publication_transition_failed');

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'manual-transition-progress')
            ->postJson('/api/v1/manual-publications/'.$id.'/transition', [
                'target_status' => ManualPublication::STATUS_IN_PROGRESS,
                'revision' => 2,
            ])
            ->assertOk();

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'manual-transition-no-url')
            ->postJson('/api/v1/manual-publications/'.$id.'/transition', [
                'target_status' => ManualPublication::STATUS_COMPLETED,
                'revision' => 3,
            ])
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'manual_publication_transition_failed');

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'manual-transition-complete')
            ->postJson('/api/v1/manual-publications/'.$id.'/transition', [
                'target_status' => ManualPublication::STATUS_COMPLETED,
                'revision' => 3,
                'completion_url' => 'https://example.test/published/1',
                'result_note' => '执行完成',
            ])
            ->assertOk()
            ->assertJsonPath('data.publication.status', ManualPublication::STATUS_COMPLETED)
            ->assertJsonPath('data.publication.completion_url', 'https://example.test/published/1')
            ->assertJsonPath('data.publication.revision', 4);
    }

    public function test_regular_admin_can_read_assigned_work_but_cannot_create_or_read_other_work(): void
    {
        $superAdmin = $this->admin('manual-super', 'super_admin');
        $worker = $this->admin('manual-worker', 'admin');
        $otherWorker = $this->admin('manual-other-worker', 'admin');
        [$persona, $account] = $this->identity($superAdmin);
        $assigned = app(ManualPublicationService::class)->create(
            $this->payload($persona, $account, $worker, ['content' => 'worker-visible']),
            $superAdmin,
        );
        $other = app(ManualPublicationService::class)->create(
            $this->payload($persona, $account, $otherWorker, ['content' => 'other-hidden']),
            $superAdmin,
        );

        $token = $worker->createToken('manual-worker-token', ['articles:read', 'articles:write'])->plainTextToken;
        $this->withToken($token)
            ->getJson('/api/v1/manual-publications/management')
            ->assertOk()
            ->assertJsonPath('data.items.0.id', (int) $assigned->id)
            ->assertJsonPath('data.items.0.content', 'worker-visible')
            ->assertJsonCount(1, 'data.items');

        $this->withToken($token)
            ->getJson('/api/v1/manual-publications/'.$other->id.'/management')
            ->assertForbidden();

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'manual-worker-create')
            ->postJson('/api/v1/manual-publications', $this->payload($persona, $account, $worker))
            ->assertForbidden();
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

    /** @return array{ManualPublicationPersona,ManualPublicationAccount} */
    private function identity(Admin $admin): array
    {
        $persona = ManualPublicationPersona::query()->create([
            'name' => 'GEOFlow 专家',
            'disclosure_text' => '本账号代表 GEOFlow 团队。',
            'created_by_admin_id' => $admin->id,
        ]);
        $account = ManualPublicationAccount::query()->create([
            'persona_id' => $persona->id,
            'platform' => ManualPublicationAccount::PLATFORM_ZHIHU,
            'account_name' => 'GEOFlow 知乎账号',
            'created_by_admin_id' => $admin->id,
        ]);

        return [$persona, $account];
    }

    /** @return array<string,mixed> */
    private function payload(ManualPublicationPersona $persona, ManualPublicationAccount $account, Admin $assignee, array $overrides = []): array
    {
        return array_replace([
            'type' => ManualPublication::TYPE_COMMENT,
            'persona_id' => $persona->id,
            'account_id' => $account->id,
            'assigned_admin_id' => $assignee->id,
            'platform' => ManualPublicationAccount::PLATFORM_ZHIHU,
            'target_url' => 'https://example.test/questions/1',
            'target_context' => '测试讨论上下文',
            'content' => '测试发布内容',
            'status' => ManualPublication::STATUS_DRAFT,
        ], $overrides);
    }
}
