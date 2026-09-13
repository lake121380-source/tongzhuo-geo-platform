<?php

namespace Tests\Feature;

use App\Contracts\AiWorkspace\AdminHelpResponder;
use App\Data\Ai\AiWorkspaceExecutionContext;
use App\Models\Admin;
use App\Models\AiConversation;
use App\Models\AiConversationMessage;
use App\Models\AiModel;
use App\Models\KnowledgeMediaAsset;
use App\Services\AiWorkspace\AiConversationRepository;
use App\Services\AiWorkspace\SystemKnowledgeBaseManager;
use App\Services\AiWorkspace\SystemKnowledgeMediaManager;
use App\Services\Api\ApiTokenService;
use Generator;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

final class AiWorkspaceApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_workspace_scopes_protect_read_and_write_surfaces(): void
    {
        $this->assertContains('workspace:read', app(ApiTokenService::class)->getCliLoginScopes());
        $this->assertContains('workspace:write', app(ApiTokenService::class)->getCliLoginScopes());
        $admin = $this->admin('workspace-scope');
        $wrong = $admin->createToken('wrong', ['analytics:read'])->plainTextToken;
        $read = $admin->createToken('read', ['workspace:read'])->plainTextToken;

        $this->withToken($wrong)->getJson('/api/v1/ai-workspace/status')
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'workspace:read');

        $this->withToken($read)->getJson('/api/v1/ai-workspace/status')
            ->assertOk()
            ->assertJsonPath('data.runtime_enabled', false)
            ->assertJsonPath('data.ready', false)
            ->assertJsonStructure(['data' => ['starter_actions']]);

        $this->withToken($read)
            ->withHeader('X-Idempotency-Key', 'workspace-denied-create')
            ->postJson('/api/v1/ai-workspace/conversations', ['title' => 'Denied'])
            ->assertForbidden()
            ->assertJsonPath('error.details.required_scope', 'workspace:write');
    }

    public function test_conversation_crud_is_owned_idempotent_persisted_and_audited(): void
    {
        $owner = $this->admin('workspace-owner');
        $other = $this->admin('workspace-other');
        $ownerToken = $owner->createToken('owner', ['workspace:read', 'workspace:write'])->plainTextToken;
        $otherToken = $other->createToken('other', ['workspace:read', 'workspace:write'])->plainTextToken;

        $created = $this->withToken($ownerToken)
            ->withHeader('X-Idempotency-Key', 'workspace-create-1')
            ->postJson('/api/v1/ai-workspace/conversations', ['title' => '运营帮助'])
            ->assertCreated()
            ->assertJsonPath('data.conversation.title', '运营帮助')
            ->json('data.conversation');

        $this->withToken($ownerToken)
            ->withHeader('X-Idempotency-Key', 'workspace-create-1')
            ->postJson('/api/v1/ai-workspace/conversations', ['title' => '运营帮助'])
            ->assertCreated()
            ->assertJsonPath('data.conversation.id', $created['id']);
        $this->assertSame(1, AiConversation::query()->count());

        $this->withToken($otherToken)
            ->getJson('/api/v1/ai-workspace/conversations/'.$created['id'])
            ->assertNotFound()
            ->assertJsonPath('error.code', 'workspace_conversation_not_found');

        $renamed = $this->withToken($ownerToken)
            ->withHeader('X-Idempotency-Key', 'workspace-rename-1')
            ->patchJson('/api/v1/ai-workspace/conversations/'.$created['id'], ['title' => '任务操作帮助'])
            ->assertOk()
            ->assertJsonPath('data.conversation.title', '任务操作帮助')
            ->json('data.conversation');
        $this->assertSame($created['id'], $renamed['id']);

        $this->withToken($ownerToken)->getJson('/api/v1/ai-workspace/conversations')
            ->assertOk()
            ->assertJsonCount(1, 'data.items')
            ->assertJsonPath('data.items.0.title', '任务操作帮助');

        $this->withToken($ownerToken)
            ->withHeader('X-Idempotency-Key', 'workspace-archive-1')
            ->postJson('/api/v1/ai-workspace/conversations/'.$created['id'].'/archive')
            ->assertOk()
            ->assertJsonPath('data.archived', true);
        $this->assertNotNull(AiConversation::query()->findOrFail($created['id'])->archived_at);

        $this->assertDatabaseHas('admin_activity_logs', [
            'admin_id' => $owner->id,
            'action' => 'api.ai_workspace.conversation.create',
        ]);
        $this->assertDatabaseHas('admin_activity_logs', [
            'admin_id' => $owner->id,
            'action' => 'api.ai_workspace.conversation.archive',
        ]);
    }

    public function test_message_endpoint_reuses_native_sse_generation_and_persists_answer(): void
    {
        config()->set('ai-workspace.runtime_enabled', true);
        config()->set('ai-workspace.require_verified_model', false);
        $admin = $this->readyAdmin('workspace-stream');
        $token = $admin->createToken('workspace', ['workspace:read', 'workspace:write'])->plainTextToken;
        $conversation = app(AiConversationRepository::class)->create($admin);
        $fake = new ApiWorkspaceFakeResponder(['先打开', '任务管理。']);
        $this->app->instance(AdminHelpResponder::class, $fake);

        $response = $this->withToken($token)
            ->postJson('/api/v1/ai-workspace/conversations/'.$conversation->id.'/messages', [
                'prompt' => '如何创建任务？',
            ]);

        $response->assertOk()->assertHeader('content-type', 'text/event-stream; charset=UTF-8');
        $stream = $response->streamedContent();
        $this->assertStringContainsString('event: status', $stream);
        $this->assertStringContainsString('event: delta', $stream);
        $this->assertStringContainsString('event: done', $stream);
        $this->assertSame(['user', 'assistant'], AiConversationMessage::query()
            ->where('conversation_id', $conversation->id)
            ->oldest('created_at')
            ->oldest('id')
            ->pluck('role')
            ->all());
        $this->assertSame('先打开任务管理。', AiConversationMessage::query()
            ->where('conversation_id', $conversation->id)
            ->where('role', 'assistant')
            ->value('content'));
        $this->assertSame(1, $fake->streamCalls);

        $this->withToken($token)->getJson('/api/v1/ai-workspace/conversations/'.$conversation->id)
            ->assertOk()
            ->assertJsonCount(2, 'data.conversation.messages')
            ->assertJsonPath('data.conversation.messages.1.content', '先打开任务管理。');

        $this->assertDatabaseHas('admin_activity_logs', [
            'admin_id' => $admin->id,
            'action' => 'api.ai_workspace.message.ask',
        ]);
    }

    public function test_workspace_media_is_private_and_available_through_bearer_auth(): void
    {
        config()->set('geoflow.admin_ui_v3_enabled', true);
        Queue::fake();
        Storage::fake('local');
        app(SystemKnowledgeBaseManager::class)->sync();
        app(SystemKnowledgeMediaManager::class)->syncBundled();
        $asset = KnowledgeMediaAsset::query()->where('asset_key', 'tasks.index')->firstOrFail();
        $admin = $this->admin('workspace-media');
        $admin->forceFill(['role' => 'super_admin'])->save();
        $token = $admin->createToken('workspace-media', ['workspace:read'])->plainTextToken;

        $this->get('/api/v1/ai-workspace/media/'.$asset->id)->assertUnauthorized();
        $response = $this->withToken($token)
            ->get('/api/v1/ai-workspace/media/'.$asset->id.'?variant=thumbnail')
            ->assertOk()
            ->assertHeader('X-Content-Type-Options', 'nosniff')
            ->assertHeader('Cross-Origin-Resource-Policy', 'same-origin');
        $this->assertStringStartsWith('image/', (string) $response->headers->get('Content-Type'));

        $this->withToken($token)
            ->withHeader('If-None-Match', (string) $response->headers->get('ETag'))
            ->get('/api/v1/ai-workspace/media/'.$asset->id.'?variant=thumbnail')
            ->assertStatus(304);
    }

    private function readyAdmin(string $username): Admin
    {
        $admin = $this->admin($username);
        $model = AiModel::query()->create([
            'name' => 'Workspace API Test',
            'version' => '1',
            'api_key' => 'unused',
            'model_id' => 'workspace-api-test',
            'model_type' => 'chat',
            'api_url' => 'https://example.invalid/v1',
            'status' => 'active',
        ]);
        $model->forceFill([
            'owner_admin_id' => $admin->id,
            'access_scope' => AiModel::ACCESS_SCOPE_USER_CONTENT,
        ])->save();

        return $admin;
    }

    private function admin(string $username): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'secret-123',
            'email' => $username.'@example.test',
            'display_name' => $username,
            'role' => 'admin',
            'status' => 'active',
        ]);
    }
}

final class ApiWorkspaceFakeResponder implements AdminHelpResponder
{
    public int $streamCalls = 0;

    /** @param list<string> $deltas */
    public function __construct(private readonly array $deltas) {}

    public function stream(
        string $prompt,
        string $knowledgeContext,
        iterable $messages = [],
        Admin|AiWorkspaceExecutionContext|int|null $actor = null,
    ): Generator {
        $this->streamCalls++;
        $answer = '';
        foreach ($this->deltas as $delta) {
            $answer .= $delta;
            yield ['type' => 'delta', 'content' => $delta];
        }

        return [
            'answer' => $answer,
            'meta' => ['provider' => 'fake', 'model' => 'fake'],
            'usage' => ['prompt_tokens' => 3, 'completion_tokens' => 2],
        ];
    }

    public function answer(
        string $prompt,
        string $knowledgeContext,
        iterable $messages = [],
        Admin|AiWorkspaceExecutionContext|int|null $actor = null,
    ): string {
        return implode('', $this->deltas);
    }
}
