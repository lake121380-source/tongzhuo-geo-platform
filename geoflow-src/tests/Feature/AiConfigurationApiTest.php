<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\AdminAiSetting;
use App\Models\AiModel;
use App\Models\AiSourceProvider;
use App\Models\Prompt;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class AiConfigurationApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_model_projection_is_scoped_and_never_exposes_credentials(): void
    {
        $admin = $this->admin('model-api-reader');
        $model = $this->model($admin, '可用聊天模型', 'chat');
        Prompt::query()->create([
            'name' => '正文模板',
            'type' => 'content',
            'content' => '只允许引用企业知识库。',
        ]);
        $token = $admin->createToken('models-read', ['models:read'])->plainTextToken;

        $response = $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson('/api/v1/models')
            ->assertOk()
            ->assertJsonPath('data.items.0.id', $model->id)
            ->assertJsonPath('data.items.0.model_type', 'chat')
            ->assertJsonPath('data.items.0.is_available', true);

        $this->assertStringNotContainsString('model-api-secret', $response->getContent());

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson('/api/v1/prompts')
            ->assertOk()
            ->assertJsonPath('data.items.0.content', '只允许引用企业知识库。');
    }

    public function test_default_chat_model_switch_is_idempotent_and_preserves_embedding_default(): void
    {
        $admin = $this->admin('model-api-writer');
        $first = $this->model($admin, '旧聊天模型', 'chat');
        $second = $this->model($admin, '新聊天模型', 'chat');
        $embedding = $this->model($admin, '向量模型', 'embedding');
        AdminAiSetting::query()->create([
            'admin_id' => $admin->id,
            'default_chat_model_id' => $first->id,
            'default_embedding_model_id' => $embedding->id,
            'updated_by_admin_id' => $admin->id,
        ]);
        $token = $admin->createToken('models-write', ['models:read', 'models:write'])->plainTextToken;
        $headers = [
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => 'model-default-switch-1',
        ];

        $this->withHeaders($headers)
            ->postJson('/api/v1/models/'.$second->id.'/default')
            ->assertOk()
            ->assertJsonPath('data.model.id', $second->id);
        $this->withHeaders($headers)
            ->postJson('/api/v1/models/'.$second->id.'/default')
            ->assertOk()
            ->assertJsonPath('data.model.id', $second->id);

        $settings = AdminAiSetting::query()->where('admin_id', $admin->id)->firstOrFail();
        $this->assertSame((int) $second->id, (int) $settings->default_chat_model_id);
        $this->assertSame((int) $embedding->id, (int) $settings->default_embedding_model_id);
    }

    public function test_embedding_model_cannot_become_default_chat_model(): void
    {
        $admin = $this->admin('model-api-type-boundary');
        $embedding = $this->model($admin, '边界向量模型', 'embedding');
        $token = $admin->createToken('models-write', ['models:write'])->plainTextToken;

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->withHeader('X-Idempotency-Key', 'model-type-boundary')
            ->postJson('/api/v1/models/'.$embedding->id.'/default')
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'model_type_not_allowed');
    }

    public function test_source_providers_are_super_admin_only_and_never_expose_credentials(): void
    {
        $super = $this->admin('source-provider-super');
        $super->forceFill(['role' => 'super_admin'])->save();
        $token = $super->createToken('source-provider-write', ['models:read', 'models:write'])->plainTextToken;
        $headers = ['Authorization' => 'Bearer '.$token, 'X-Idempotency-Key' => 'source-provider-create'];
        $payload = [
            'name' => '可见度搜索',
            'endpoint_url' => 'https://open.feedcoopapi.com/search_api/web_search',
            'api_key' => 'source-provider-api-key',
            'daily_limit' => 50,
            'count' => 5,
        ];

        $response = $this->withHeaders($headers)
            ->postJson('/api/v1/source-providers', $payload)
            ->assertCreated()
            ->assertJsonPath('data.provider.provider_key', AiSourceProvider::PROVIDER_DOUBAO_SEARCH_CUSTOM)
            ->assertJsonPath('data.provider.api_key_configured', true)
            ->assertJsonMissingPath('data.provider.api_key');

        $this->assertStringNotContainsString('source-provider-api-key', $response->getContent());
        $provider = AiSourceProvider::query()->firstOrFail();
        $this->assertNotSame('source-provider-api-key', (string) $provider->getRawOriginal('api_key'));

        $this->withHeaders($headers)
            ->postJson('/api/v1/source-providers', $payload)
            ->assertCreated()
            ->assertJsonPath('data.provider.id', $provider->id);
        $this->assertDatabaseCount('ai_source_providers', 1);

        $ordinary = $this->admin('source-provider-ordinary');
        $ordinaryToken = $ordinary->createToken('source-provider-read', ['models:read'])->plainTextToken;
        $this->withHeader('Authorization', 'Bearer '.$ordinaryToken)
            ->getJson('/api/v1/source-providers')
            ->assertForbidden();
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

    private function model(Admin $owner, string $name, string $type): AiModel
    {
        $model = new AiModel;
        $model->forceFill([
            'owner_admin_id' => $owner->id,
            'name' => $name,
            'version' => 'v1',
            'api_key' => 'model-api-secret',
            'model_id' => strtolower(str_replace(' ', '-', $name)),
            'model_type' => $type,
            'api_url' => 'https://provider.example/v1',
            'failover_priority' => 100,
            'access_scope' => AiModel::ACCESS_SCOPE_USER_CONTENT,
            'status' => 'active',
        ])->save();

        return $model->refresh();
    }
}
