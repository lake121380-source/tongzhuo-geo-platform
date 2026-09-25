<?php

namespace Tests\Feature;

use App\Ai\Agents\AdminHelpAssistant;
use App\Models\Admin;
use App\Models\AiModel;
use App\Services\GeoFlow\AiVisibility\AiVisibilityConfigurationResolver;
use App\Support\GeoFlow\ApiKeyCrypto;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * api/v1 的可见度分析模型绑定（ark / deepseek）。
 *
 * 这两条绑定决定「AI 可见度运行用哪条模型做联网检索与二次分析」。旧后台能改、能看、
 * 能探活；api/v1 之前三者都没有，退役后就只能停在部署时的绑定——所以这是能力而非便利。
 *
 * 锁四件事：① 读法（绑定 / 候选 / API 配置三者一致）；② 写绑定要过「超管自己拥有的
 * 系统 chat 模型 + 端点域名策略」；③ **响应里连掩码密钥都不能有**——api/v1 对外的口径
 * 是只给 `api_key_configured` 布尔；④ 探活要落就绪度并记额度。
 */
final class AiSourceProviderBindingApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_reports_bindings_candidates_and_api_config_without_leaking_keys(): void
    {
        $super = $this->superAdmin();
        $model = $this->systemModel($super, 'DeepSeek 二次分析', 'https://api.deepseek.com');
        $this->bind('deepseek', $model->id);

        $response = $this->withToken($this->tokenFor($super))
            ->getJson('/api/v1/source-providers/model-bindings')
            ->assertOk()
            ->assertJsonPath('data.bindings.deepseek', $model->id)
            // 没绑过 ark 就是 0——不要用别的值表示「没绑」。
            ->assertJsonPath('data.bindings.ark', 0)
            ->assertJsonPath('data.api.deepseek.bound', true)
            ->assertJsonPath('data.api.deepseek.api_key_configured', true)
            ->assertJsonPath('data.api.ark.bound', false);

        $candidateIds = array_column($response->json('data.candidates'), 'id');
        $this->assertContains($model->id, $candidateIds);

        // 掩码密钥也不行：白名单投影里根本没有这个字段。
        $response->assertJsonMissingPath('data.api.deepseek.masked_api_key');
        $response
            ->assertDontSee('model-secret', false)
            ->assertDontSee('****', false);
    }

    public function test_it_switches_the_binding_to_another_system_model(): void
    {
        $super = $this->superAdmin();
        $first = $this->systemModel($super, '第一版分析模型', 'https://api.deepseek.com');
        $second = $this->systemModel($super, '第二版分析模型', 'https://api.deepseek.com');

        $this->withToken($this->tokenFor($super))
            ->withHeader('X-Idempotency-Key', 'bind-deepseek-1')
            ->postJson('/api/v1/source-providers/model-bindings', ['deepseek_model_id' => $first->id])
            ->assertOk()
            ->assertJsonPath('data.bindings.deepseek', $first->id);

        $this->withToken($this->tokenFor($super))
            ->withHeader('X-Idempotency-Key', 'bind-deepseek-2')
            ->postJson('/api/v1/source-providers/model-bindings', ['deepseek_model_id' => $second->id])
            ->assertOk()
            ->assertJsonPath('data.bindings.deepseek', $second->id);

        $this->assertSame(
            (string) $second->id,
            $this->setting(AiVisibilityConfigurationResolver::DEEPSEEK_MODEL_SETTING_KEY),
        );
    }

    public function test_it_rejects_a_model_that_is_not_a_usable_system_chat_model(): void
    {
        $super = $this->superAdmin();
        // 个人模型（access_scope = user_content）不能当可见度分析模型。
        $personal = $this->systemModel($super, '个人模型', 'https://api.deepseek.com', AiModel::ACCESS_SCOPE_USER_CONTENT);

        $this->withToken($this->tokenFor($super))
            ->withHeader('X-Idempotency-Key', 'bind-personal')
            ->postJson('/api/v1/source-providers/model-bindings', ['deepseek_model_id' => $personal->id])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonStructure(['error' => ['details' => ['field_errors' => ['deepseek_model_id']]]]);

        $this->assertNull($this->setting(AiVisibilityConfigurationResolver::DEEPSEEK_MODEL_SETTING_KEY));
    }

    public function test_it_saves_the_binding_api_config(): void
    {
        $super = $this->superAdmin();

        $response = $this->withToken($this->tokenFor($super))
            ->withHeader('X-Idempotency-Key', 'binding-api-1')
            ->postJson('/api/v1/source-providers/model-api', [
                'binding_type' => 'deepseek',
                'name' => 'DeepSeek 二次分析',
                'model_id' => 'deepseek-v4-flash',
                'api_url' => 'https://api.deepseek.com',
                'api_key' => 'binding-secret-key',
            ])
            ->assertOk()
            ->assertJsonPath('data.binding_type', 'deepseek')
            ->assertJsonPath('data.api.bound', true)
            ->assertJsonPath('data.api.name', 'DeepSeek 二次分析')
            ->assertJsonPath('data.api.api_key_configured', true);

        $response
            ->assertDontSee('binding-secret-key', false)
            ->assertDontSee('masked_api_key', false);

        // 配置写进去了，而且绑定也指向这条模型。
        $this->assertSame(
            (string) $response->json('data.model_row_id'),
            $this->setting(AiVisibilityConfigurationResolver::DEEPSEEK_MODEL_SETTING_KEY),
        );
    }

    public function test_it_rejects_an_api_url_outside_the_binding_policy(): void
    {
        $super = $this->superAdmin();

        $this->withToken($this->tokenFor($super))
            ->withHeader('X-Idempotency-Key', 'binding-api-bad-host')
            ->postJson('/api/v1/source-providers/model-api', [
                'binding_type' => 'deepseek',
                'name' => '借道模型',
                'model_id' => 'deepseek-v4-flash',
                'api_url' => 'https://evil.example.com',
                'api_key' => 'binding-secret-key',
            ])
            ->assertStatus(422);

        $this->assertNull($this->setting(AiVisibilityConfigurationResolver::DEEPSEEK_MODEL_SETTING_KEY));
    }

    public function test_the_binding_probe_reports_workspace_readiness_and_records_usage(): void
    {
        AdminHelpAssistant::fake(['workspace ready'])->preventStrayPrompts();
        $super = $this->superAdmin();
        $model = $this->systemModel($super, 'DeepSeek 探活模型', 'https://api.deepseek.com');

        $this->withToken($this->tokenFor($super))
            ->withHeader('X-Idempotency-Key', 'binding-probe-1')
            ->postJson('/api/v1/source-providers/model-bindings/test', [
                'binding_type' => 'deepseek',
                'model_id' => $model->id,
            ])
            ->assertOk()
            ->assertJsonPath('data.workspace_readiness.configuration.status', 'ready');

        // 探活是一次真实出站，额度要记上。
        $model->refresh();
        $this->assertSame(1, (int) $model->used_today);
        $this->assertSame(1, (int) $model->total_used);
    }

    public function test_a_regular_admin_cannot_read_or_write_bindings(): void
    {
        $ordinary = $this->admin('binding_ordinary', 'admin');
        $model = $this->systemModel($ordinary, '普通管理员的模型', 'https://api.deepseek.com');
        $token = $this->tokenFor($ordinary);

        $this->withToken($token)
            ->getJson('/api/v1/source-providers/model-bindings')
            ->assertStatus(403)
            ->assertJsonPath('error.code', 'forbidden');

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'binding-forbidden')
            ->postJson('/api/v1/source-providers/model-bindings', ['deepseek_model_id' => $model->id])
            ->assertStatus(403);

        $this->assertNull($this->setting(AiVisibilityConfigurationResolver::DEEPSEEK_MODEL_SETTING_KEY));
    }

    public function test_writes_require_an_idempotency_key(): void
    {
        $super = $this->superAdmin();

        $this->withToken($this->tokenFor($super))
            ->postJson('/api/v1/source-providers/model-bindings', ['ark_model_id' => 0])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');
    }

    private function bind(string $bindingType, int $modelId): void
    {
        DB::table('site_settings')->updateOrInsert(
            ['setting_key' => $bindingType === 'ark'
                ? AiVisibilityConfigurationResolver::ARK_MODEL_SETTING_KEY
                : AiVisibilityConfigurationResolver::DEEPSEEK_MODEL_SETTING_KEY],
            ['setting_value' => (string) $modelId],
        );
    }

    /**
     * 保存 API 配置时，**没有传上来的额度字段必须保留原值**。
     *
     * 面板以前只回传 binding_type/name/model_id/api_url(/api_key)，而后端对缺失键一律
     * `daily_limit ?? 0`、`normalizeMaxTokens($payload['max_tokens'] ?? null)`——而
     * `daily_limit > 0` 才限流（**0 等于不限量**），于是「点一次保存」就把给模型设的
     * 日额度抹掉了，界面上还看不出来。
     */
    public function test_saving_the_binding_api_config_keeps_quota_fields_it_did_not_send(): void
    {
        $super = $this->superAdmin();

        $this->withToken($this->tokenFor($super))
            ->withHeader('X-Idempotency-Key', 'binding-quota-1')
            ->postJson('/api/v1/source-providers/model-api', [
                'binding_type' => 'deepseek',
                'name' => 'DeepSeek 二次分析',
                'model_id' => 'deepseek-v4-flash',
                'api_url' => 'https://api.deepseek.com',
                'api_key' => 'binding-secret-key',
                'daily_limit' => 200,
                'max_tokens' => 8192,
            ])
            ->assertOk();

        $modelId = (int) $this->setting(AiVisibilityConfigurationResolver::DEEPSEEK_MODEL_SETTING_KEY);
        $this->assertGreaterThan(0, $modelId);
        $this->assertSame(200, (int) AiModel::query()->whereKey($modelId)->value('daily_limit'));

        // 再保存一次，但**不带**这两个字段——旧版面板就是这么发的。
        $this->withToken($this->tokenFor($super))
            ->withHeader('X-Idempotency-Key', 'binding-quota-2')
            ->postJson('/api/v1/source-providers/model-api', [
                'binding_type' => 'deepseek',
                'name' => 'DeepSeek 二次分析',
                'model_id' => 'deepseek-v4-flash',
                'api_url' => 'https://api.deepseek.com',
            ])
            ->assertOk();

        $row = AiModel::query()->whereKey($modelId)->firstOrFail();
        $this->assertSame(200, (int) $row->daily_limit, '日额度被一次不带该字段的保存抹成了 0（0 = 不限量）');
        $this->assertSame(8192, (int) $row->max_tokens, 'max_tokens 被一次不带该字段的保存抹成了 null');
    }

    private function setting(string $key): ?string
    {
        $value = DB::table('site_settings')->where('setting_key', $key)->value('setting_value');

        return $value === null ? null : (string) $value;
    }

    private function tokenFor(Admin $admin): string
    {
        return $admin->createToken('api', ['models:read', 'models:write'])->plainTextToken;
    }

    private function superAdmin(): Admin
    {
        return $this->admin('binding_super', 'super_admin');
    }

    private function admin(string $username, string $role): Admin
    {
        return Admin::query()->firstOrCreate(
            ['username' => $username],
            [
                'password' => 'Password123!',
                'email' => $username.'@example.test',
                'display_name' => $username,
                'role' => $role,
                'status' => 'active',
            ],
        );
    }

    private function systemModel(
        Admin $owner,
        string $name,
        string $apiUrl,
        string $scope = AiModel::ACCESS_SCOPE_SYSTEM_ONLY,
    ): AiModel {
        $model = new AiModel([
            'name' => $name,
            'version' => 'test',
            'api_key' => app(ApiKeyCrypto::class)->encrypt('model-secret'),
            'model_id' => 'deepseek-v4-flash',
            'model_type' => 'chat',
            'api_url' => $apiUrl,
            'failover_priority' => 100,
            'daily_limit' => 0,
            'used_today' => 0,
            'total_used' => 0,
            'status' => 'active',
        ]);
        $model->forceFill(['owner_admin_id' => $owner->id, 'access_scope' => $scope])->save();

        return $model;
    }
}
