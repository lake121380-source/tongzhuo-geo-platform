<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\ManualPublication;
use App\Models\ManualPublicationAccount;
use App\Models\ManualPublicationPersona;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * api/v1 的发布账号/人设管理、工单导出与插件连接流程。
 *
 * 账号与人设是**超管专属**（旧后台的 FormRequest 就是这么限的），所以本文件重点锁
 * 「普通管理员一律被挡住」；导出锁「导出的就是筛出来的」；插件连接锁「没有待批请求时
 * 如实返回 null 而不是编一个空对象」。
 */
final class ManualPublicationAdminApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_settings_endpoints_reject_a_normal_admin(): void
    {
        $admin = $this->admin('mp-normal', 'admin');
        [$persona] = $this->identity($admin);
        $token = $admin->createToken('api', ['articles:read', 'articles:write'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/manual-publications/settings')
            ->assertForbidden()
            ->assertJsonPath('error.details.required_role', 'super_admin');

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'settings-normal-persona')
            ->postJson('/api/v1/manual-publications/settings/personas', ['name' => '越权人设'])
            ->assertForbidden();

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'settings-normal-persona-update')
            ->patchJson('/api/v1/manual-publications/settings/personas/'.$persona->id, ['name' => '越权改名'])
            ->assertForbidden();
    }

    public function test_a_super_admin_can_list_and_create_personas_and_accounts(): void
    {
        $admin = $this->admin('mp-super', 'super_admin');
        $token = $admin->createToken('api', ['articles:read', 'articles:write'])->plainTextToken;

        $created = $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'settings-persona-create')
            ->postJson('/api/v1/manual-publications/settings/personas', [
                'name' => '新专家人设',
                'disclosure_text' => '本账号代表团队。',
                'is_active' => true,
            ])
            ->assertCreated()
            ->json('data.persona_id');

        $this->assertIsInt($created);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'settings-account-create')
            ->postJson('/api/v1/manual-publications/settings/accounts', [
                'persona_id' => $created,
                'platform' => ManualPublicationAccount::PLATFORM_ZHIHU,
                'account_name' => '新账号',
            ])
            ->assertCreated();

        $this->withToken($token)
            ->getJson('/api/v1/manual-publications/settings')
            ->assertOk()
            ->assertJsonPath('data.personas.0.accounts_count', 1)
            ->assertJsonPath('data.accounts.0.account_name', '新账号');
    }

    public function test_account_creation_requires_an_existing_persona(): void
    {
        $token = $this->admin('mp-bad-persona', 'super_admin')->createToken('api', ['articles:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'settings-account-bad-persona')
            ->postJson('/api/v1/manual-publications/settings/accounts', [
                'persona_id' => 99999,
                'platform' => ManualPublicationAccount::PLATFORM_ZHIHU,
                'account_name' => '孤儿账号',
            ])
            ->assertStatus(422)
            ->assertJsonStructure(['error' => ['details' => ['field_errors' => ['persona_id']]]]);
    }

    public function test_updating_a_missing_persona_reports_not_found(): void
    {
        $token = $this->admin('mp-missing-persona', 'super_admin')->createToken('api', ['articles:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'settings-persona-missing')
            ->patchJson('/api/v1/manual-publications/settings/personas/99999', ['name' => '不存在'])
            ->assertStatus(404)
            ->assertJsonPath('error.code', 'persona_not_found');
    }

    public function test_settings_mutations_require_an_idempotency_key(): void
    {
        $token = $this->admin('mp-idem', 'super_admin')->createToken('api', ['articles:write'])->plainTextToken;

        $this->withToken($token)
            ->postJson('/api/v1/manual-publications/settings/personas', ['name' => '缺幂等键'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');
    }

    public function test_export_returns_only_the_filtered_work_orders(): void
    {
        $admin = $this->admin('mp-export', 'super_admin');
        [$persona, $account] = $this->identity($admin);
        $this->publication($admin, $persona, $account, ManualPublication::STATUS_READY, '待发布的正文');
        $this->publication($admin, $persona, $account, ManualPublication::STATUS_COMPLETED, '已完成的正文');

        $token = $admin->createToken('api', ['articles:read'])->plainTextToken;

        $csv = $this->withToken($token)
            ->get('/api/v1/manual-publications/export?status='.ManualPublication::STATUS_READY)
            ->assertOk()
            ->streamedContent();

        // 导出的必须是「筛选结果」，不是全量——否则运营方筛完再导出会拿到意外的数据。
        $this->assertStringContainsString('待发布的正文', $csv);
        $this->assertStringNotContainsString('已完成的正文', $csv);
        // Excel 打开不乱码：UTF-8 BOM。
        $this->assertStringStartsWith("\xEF\xBB\xBF", $csv);
        $this->assertStringContainsString('ID,类型', $csv);
    }

    public function test_browser_connect_reports_no_pending_authorization_as_null(): void
    {
        $token = $this->admin('mp-connect-none', 'super_admin')->createToken('api', ['articles:read'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/manual-publications/browser-connect?user_code=ZZZZ9999')
            ->assertOk()
            ->assertJsonPath('data.user_code', 'ZZZZ9999')
            // 没有待批请求就是 null，不能编一个空对象让前端以为「有一个请求」。
            ->assertJsonPath('data.authorization', null);
    }

    public function test_browser_connect_decision_rejects_an_unknown_code(): void
    {
        $token = $this->admin('mp-connect-bad', 'super_admin')->createToken('api', ['articles:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'connect-decision-bad')
            ->postJson('/api/v1/manual-publications/browser-connect/decision', [
                'user_code' => 'ZZZZ9999',
                'decision' => 'approve',
            ])
            ->assertStatus(400)
            ->assertJsonPath('error.code', 'expired_token');
    }

    public function test_browser_connect_decision_validates_the_payload(): void
    {
        $token = $this->admin('mp-connect-invalid', 'super_admin')->createToken('api', ['articles:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'connect-decision-invalid')
            ->postJson('/api/v1/manual-publications/browser-connect/decision', ['decision' => 'maybe'])
            ->assertStatus(422)
            ->assertJsonStructure(['error' => ['details' => ['field_errors' => ['user_code', 'decision']]]]);
    }

    /** @return array{ManualPublicationPersona,ManualPublicationAccount} */
    private function identity(Admin $admin): array
    {
        $persona = ManualPublicationPersona::query()->create([
            'name' => '人设 '.uniqid(),
            'disclosure_text' => '本账号代表团队。',
            'created_by_admin_id' => $admin->id,
        ]);
        $account = ManualPublicationAccount::query()->create([
            'persona_id' => $persona->id,
            'platform' => ManualPublicationAccount::PLATFORM_ZHIHU,
            'account_name' => '账号 '.uniqid(),
            'created_by_admin_id' => $admin->id,
        ]);

        return [$persona, $account];
    }

    private function publication(
        Admin $admin,
        ManualPublicationPersona $persona,
        ManualPublicationAccount $account,
        string $status,
        string $content,
    ): ManualPublication {
        return ManualPublication::query()->create([
            'type' => ManualPublication::TYPE_COMMENT,
            'persona_id' => $persona->id,
            'account_id' => $account->id,
            'assigned_admin_id' => $admin->id,
            'created_by_admin_id' => $admin->id,
            'platform' => ManualPublicationAccount::PLATFORM_ZHIHU,
            'target_url' => 'https://example.test/questions/'.uniqid(),
            'target_context' => '讨论上下文',
            'content' => $content,
            'content_fingerprint' => hash('sha256', $content),
            'identity_snapshot' => [],
            'status' => $status,
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
