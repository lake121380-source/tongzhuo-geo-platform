<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\AdminAiSetting;
use App\Models\AiModel;
use App\Models\SiteSetting;
use App\Services\Admin\AdminAiSystemSettingsService;
use App\Support\GeoFlow\ApiKeyCrypto;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * api/v1 的系统级 AI 配置（默认 embedding、知识库切片策略）与个人默认模型。
 *
 * 这两组是旧后台最能「悄悄改变口径」的两个开关：切片策略与默认 embedding 决定
 * 知识库怎么切、用哪条模型向量化；个人默认决定不带模型参数的生成用哪条。
 * api/v1 之前都没有入口，退役后只能停在部署值。
 *
 * 锁三件事：① 系统级配置**保留超管边界**（读也不行）；② 切片策略与模型的合法性
 * 由服务的既有校验兜底（semantic_llm 必须给模型、模型必须是系统 chat 模型）；
 * ③ 个人默认「缺省 = 保持现状、显式 0 = 清空」。
 */
final class AiSystemSettingsApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_reports_the_current_system_ai_settings(): void
    {
        $superAdmin = $this->admin('system_settings_super', 'super_admin');
        $systemChat = $this->systemModel($superAdmin, '系统对话模型', 'chat');
        $systemEmbedding = $this->systemModel($superAdmin, '系统向量模型', 'embedding');

        $response = $this->withToken($this->token($superAdmin))
            ->getJson('/api/v1/ai-system-settings')
            ->assertOk()
            // 没配过就是 rule / 0，不是 null 也不是猜一个。
            ->assertJsonPath('data.chunking.strategy', 'rule')
            ->assertJsonPath('data.chunking.model_id', 0)
            ->assertJsonPath('data.default_embedding_model_id', 0);

        // 下拉候选只列系统模型，且按类型分开——放错类型会被写接口拒掉，不如一开始就不给。
        $this->assertSame([$systemChat->id], array_column($response->json('data.options.chat'), 'id'));
        $this->assertSame([$systemEmbedding->id], array_column($response->json('data.options.embedding'), 'id'));
        $this->assertSame(
            ['rule', 'auto', 'semantic_llm'],
            $response->json('data.strategies'),
        );
    }

    public function test_a_super_admin_can_switch_the_chunking_strategy_and_model(): void
    {
        $superAdmin = $this->admin('chunking_super', 'super_admin');
        $systemChat = $this->systemModel($superAdmin, '切片用对话模型', 'chat');

        $this->withToken($this->token($superAdmin))
            ->withHeader('X-Idempotency-Key', 'chunking-1')
            ->postJson('/api/v1/ai-system-settings/chunking', [
                'knowledge_chunk_strategy' => 'semantic_llm',
                'knowledge_chunking_model_id' => $systemChat->id,
            ])
            ->assertOk()
            ->assertJsonPath('data.chunking.strategy', 'semantic_llm')
            ->assertJsonPath('data.chunking.model_id', $systemChat->id);

        $this->assertSame('semantic_llm', $this->setting(AdminAiSystemSettingsService::SETTING_CHUNK_STRATEGY));
        $this->assertSame((string) $systemChat->id, $this->setting(AdminAiSystemSettingsService::SETTING_CHUNKING_MODEL_ID));
    }

    public function test_semantic_chunking_requires_a_model(): void
    {
        $superAdmin = $this->admin('chunking_super_2', 'super_admin');

        $this->withToken($this->token($superAdmin))
            ->withHeader('X-Idempotency-Key', 'chunking-2')
            ->postJson('/api/v1/ai-system-settings/chunking', [
                'knowledge_chunk_strategy' => 'semantic_llm',
                'knowledge_chunking_model_id' => 0,
            ])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed');

        $this->assertNull($this->setting(AdminAiSystemSettingsService::SETTING_CHUNK_STRATEGY));
    }

    public function test_the_chunking_model_must_be_a_system_chat_model(): void
    {
        $superAdmin = $this->admin('chunking_super_3', 'super_admin');
        $embedding = $this->systemModel($superAdmin, '系统向量模型', 'embedding');
        // 个人模型不能当系统切片模型。
        $personal = $this->personalModel($superAdmin, '个人对话模型', 'chat');
        $token = $this->token($superAdmin);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'chunking-embedding')
            ->postJson('/api/v1/ai-system-settings/chunking', [
                'knowledge_chunk_strategy' => 'auto',
                'knowledge_chunking_model_id' => $embedding->id,
            ])
            ->assertStatus(422);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'chunking-personal')
            ->postJson('/api/v1/ai-system-settings/chunking', [
                'knowledge_chunk_strategy' => 'auto',
                'knowledge_chunking_model_id' => $personal->id,
            ])
            ->assertStatus(422);

        $this->assertNull($this->setting(AdminAiSystemSettingsService::SETTING_CHUNK_STRATEGY));
    }

    public function test_a_super_admin_can_change_and_clear_the_default_embedding_model(): void
    {
        $superAdmin = $this->admin('embedding_super', 'super_admin');
        $embedding = $this->systemModel($superAdmin, '系统向量模型', 'embedding');
        $token = $this->token($superAdmin);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'embedding-set')
            ->postJson('/api/v1/ai-system-settings/default-embedding', [
                'default_embedding_model_id' => $embedding->id,
            ])
            ->assertOk()
            ->assertJsonPath('data.default_embedding_model_id', $embedding->id);

        $this->assertSame((string) $embedding->id, $this->setting(AdminAiSystemSettingsService::SETTING_DEFAULT_EMBEDDING));

        // 0 = 清空，回读确认真的落到库里。
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'embedding-clear')
            ->postJson('/api/v1/ai-system-settings/default-embedding', ['default_embedding_model_id' => 0])
            ->assertOk()
            ->assertJsonPath('data.default_embedding_model_id', 0);

        $this->assertSame('0', $this->setting(AdminAiSystemSettingsService::SETTING_DEFAULT_EMBEDDING));
    }

    public function test_a_regular_admin_cannot_read_or_write_system_ai_settings(): void
    {
        $regular = $this->admin('system_settings_regular', 'admin');
        $token = $this->token($regular);

        $this->withToken($token)
            ->getJson('/api/v1/ai-system-settings')
            ->assertStatus(403)
            ->assertJsonPath('error.code', 'ai_system_config_super_admin_only');

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'chunking-forbidden')
            ->postJson('/api/v1/ai-system-settings/chunking', ['knowledge_chunk_strategy' => 'auto'])
            ->assertStatus(403)
            ->assertJsonPath('error.code', 'ai_system_config_super_admin_only');

        $this->assertNull($this->setting(AdminAiSystemSettingsService::SETTING_CHUNK_STRATEGY));
    }

    public function test_personal_defaults_set_both_slots_at_once(): void
    {
        $admin = $this->admin('personal_defaults_admin', 'admin');
        $chat = $this->personalModel($admin, '个人对话模型', 'chat');
        $embedding = $this->personalModel($admin, '个人向量模型', 'embedding');

        $this->withToken($this->token($admin))
            ->withHeader('X-Idempotency-Key', 'defaults-both')
            ->postJson('/api/v1/models/defaults', [
                'default_chat_model_id' => $chat->id,
                'default_embedding_model_id' => $embedding->id,
            ])
            ->assertOk()
            ->assertJsonPath('data.default_chat_model_id', $chat->id)
            ->assertJsonPath('data.default_embedding_model_id', $embedding->id);

        $settings = AdminAiSetting::query()->where('admin_id', $admin->id)->sole();
        $this->assertSame($chat->id, (int) $settings->default_chat_model_id);
        $this->assertSame($embedding->id, (int) $settings->default_embedding_model_id);
    }

    public function test_an_omitted_personal_default_slot_keeps_its_current_value(): void
    {
        $admin = $this->admin('personal_defaults_keep', 'admin');
        $chat = $this->personalModel($admin, '个人对话模型', 'chat');
        $embedding = $this->personalModel($admin, '个人向量模型', 'embedding');
        $token = $this->token($admin);

        $this->withToken($token)->withHeader('X-Idempotency-Key', 'defaults-init')
            ->postJson('/api/v1/models/defaults', [
                'default_chat_model_id' => $chat->id,
                'default_embedding_model_id' => $embedding->id,
            ])->assertOk();

        // 只提交 chat：embedding 必须原样保留，不能被悄悄清掉。
        $this->withToken($token)->withHeader('X-Idempotency-Key', 'defaults-chat-only')
            ->postJson('/api/v1/models/defaults', ['default_chat_model_id' => $chat->id])
            ->assertOk()
            ->assertJsonPath('data.default_embedding_model_id', $embedding->id);

        // 显式传 0 才是清空。
        $this->withToken($token)->withHeader('X-Idempotency-Key', 'defaults-clear-embedding')
            ->postJson('/api/v1/models/defaults', ['default_embedding_model_id' => 0])
            ->assertOk()
            ->assertJsonPath('data.default_chat_model_id', $chat->id)
            ->assertJsonPath('data.default_embedding_model_id', null);
    }

    public function test_personal_defaults_reject_a_model_of_the_wrong_type(): void
    {
        $admin = $this->admin('personal_defaults_type', 'admin');
        $embedding = $this->personalModel($admin, '个人向量模型', 'embedding');

        $this->withToken($this->token($admin))
            ->withHeader('X-Idempotency-Key', 'defaults-wrong-type')
            ->postJson('/api/v1/models/defaults', ['default_chat_model_id' => $embedding->id])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'model_type_not_allowed');

        $this->assertSame(0, AdminAiSetting::query()->where('admin_id', $admin->id)->count());
    }

    private function setting(string $key): ?string
    {
        $value = SiteSetting::query()->where('setting_key', $key)->value('setting_value');

        return $value === null ? null : (string) $value;
    }

    private function token(Admin $admin): string
    {
        return $admin->createToken('api', ['models:read', 'models:write'])->plainTextToken;
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

    private function systemModel(Admin $owner, string $name, string $type): AiModel
    {
        return $this->model($owner, $name, $type, AiModel::ACCESS_SCOPE_SYSTEM_ONLY);
    }

    private function personalModel(Admin $owner, string $name, string $type): AiModel
    {
        return $this->model($owner, $name, $type, AiModel::ACCESS_SCOPE_USER_CONTENT);
    }

    private function model(Admin $owner, string $name, string $type, string $scope): AiModel
    {
        $model = new AiModel([
            'name' => $name,
            'version' => 'test',
            'api_key' => app(ApiKeyCrypto::class)->encrypt('system-settings-test-key'),
            'model_id' => $name,
            'model_type' => $type,
            'api_url' => 'https://ai.test/v1',
            'daily_limit' => 100_000,
            'used_today' => 0,
            'total_used' => 0,
            'status' => 'active',
        ]);
        $model->forceFill([
            'owner_admin_id' => $owner->id,
            'access_scope' => $scope,
        ])->save();

        return $model;
    }
}
