<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\SensitiveWord;
use App\Services\GeoFlow\ArticleRiskScanner;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * api/v1 的敏感词规则管理。
 *
 * 敏感词表是**文章质量门禁的真实输入**（`ArticleRiskScanner` 直接读它），所以这里锁的是
 * 超管边界与写入约束：非超管一律被挡、单次条数与词长上限、重复词不重复入库。
 */
final class SiteSensitiveWordApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_listing_requires_the_seo_read_scope(): void
    {
        $token = $this->admin('words-list-scope', 'super_admin')->createToken('api', ['articles:read'])->plainTextToken;

        $this->withToken($token)->getJson('/api/v1/site-settings/sensitive-words')->assertForbidden();
    }

    public function test_mutations_reject_a_non_super_admin(): void
    {
        $rule = $this->rule('越权词');
        $token = $this->admin('words-nonsuper', 'admin')->createToken('api', ['seo:read', 'seo:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'words-nonsuper-store')
            ->postJson('/api/v1/site-settings/sensitive-words', ['words' => '新词'])
            ->assertForbidden()
            ->assertJsonPath('error.details.required_role', 'super_admin');

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'words-nonsuper-update')
            ->patchJson('/api/v1/site-settings/sensitive-words/'.$rule->id, $this->updatePayload())
            ->assertForbidden();

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'words-nonsuper-delete')
            ->deleteJson('/api/v1/site-settings/sensitive-words/'.$rule->id)
            ->assertForbidden();
    }

    public function test_batch_store_splits_dedupes_and_reports_the_inserted_count(): void
    {
        $this->rule('已存在词');
        $token = $this->admin('words-store', 'super_admin')->createToken('api', ['seo:write'])->plainTextToken;

        // 换行与逗号都是分隔符；重复项（含与库里已有项重复）只算一次。
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'words-store-1')
            ->postJson('/api/v1/site-settings/sensitive-words', [
                'words' => "新词甲\n新词乙,新词甲\n已存在词",
                'severity' => 'blocked',
                'category' => '广告法',
                'applies_to' => ['title', 'content'],
            ])
            ->assertCreated()
            ->assertJsonPath('data.inserted', 2);

        $this->assertSame(2, SensitiveWord::query()->where('severity', 'blocked')->count());
        $this->assertDatabaseHas('sensitive_words', ['word' => '新词甲', 'category' => '广告法']);
    }

    public function test_batch_store_rejects_more_than_the_per_submission_cap(): void
    {
        $words = implode("\n", array_map(static fn (int $i): string => '词'.$i, range(1, 201)));
        $token = $this->admin('words-too-many', 'super_admin')->createToken('api', ['seo:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'words-too-many')
            ->postJson('/api/v1/site-settings/sensitive-words', ['words' => $words])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'sensitive_words_too_many');

        $this->assertSame(0, SensitiveWord::query()->count());
    }

    public function test_batch_store_rejects_an_overlong_word(): void
    {
        $token = $this->admin('words-too-long', 'super_admin')->createToken('api', ['seo:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'words-too-long')
            ->postJson('/api/v1/site-settings/sensitive-words', ['words' => str_repeat('长', 256)])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'sensitive_words_too_long');
    }

    public function test_batch_store_rejects_a_submission_that_splits_to_nothing(): void
    {
        $token = $this->admin('words-empty', 'super_admin')->createToken('api', ['seo:write'])->plainTextToken;

        // 只有分隔符、没有实际词：能过 required，但在服务里切分后为空。
        // （纯空白输入更早就会被 TrimStrings + required 拦下，那是另一层，不是这里要测的。）
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'words-empty')
            ->postJson('/api/v1/site-settings/sensitive-words', ['words' => ', ,'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'sensitive_words_required');
    }

    public function test_batch_store_rejects_a_blank_submission_at_the_validation_layer(): void
    {
        $token = $this->admin('words-blank', 'super_admin')->createToken('api', ['seo:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'words-blank')
            ->postJson('/api/v1/site-settings/sensitive-words', ['words' => "  \n \n"])
            ->assertStatus(422)
            ->assertJsonStructure(['error' => ['details' => ['field_errors' => ['words']]]]);
    }

    public function test_update_changes_a_rule_and_reports_a_missing_one(): void
    {
        $rule = $this->rule('待改词');
        $token = $this->admin('words-update', 'super_admin')->createToken('api', ['seo:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'words-update-ok')
            ->patchJson('/api/v1/site-settings/sensitive-words/'.$rule->id, $this->updatePayload())
            ->assertOk()
            ->assertJsonPath('data.rule.severity', 'blocked')
            ->assertJsonPath('data.rule.applies_to', ['content']);

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'words-update-missing')
            ->patchJson('/api/v1/site-settings/sensitive-words/99999', $this->updatePayload())
            ->assertStatus(404)
            ->assertJsonPath('error.code', 'sensitive_word_not_found');
    }

    public function test_delete_removes_a_rule(): void
    {
        $rule = $this->rule('待删词');
        $token = $this->admin('words-delete', 'super_admin')->createToken('api', ['seo:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'words-delete-ok')
            ->deleteJson('/api/v1/site-settings/sensitive-words/'.$rule->id)
            ->assertOk()
            ->assertJsonPath('data.deleted_word_id', $rule->id);

        $this->assertDatabaseMissing('sensitive_words', ['id' => $rule->id]);
    }

    public function test_mutations_require_an_idempotency_key(): void
    {
        $token = $this->admin('words-idem', 'super_admin')->createToken('api', ['seo:write'])->plainTextToken;

        $this->withToken($token)
            ->postJson('/api/v1/site-settings/sensitive-words', ['words' => '缺幂等键'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');
    }

    public function test_listing_reports_the_total_and_the_rule_limit(): void
    {
        $this->rule('列一个词');
        $token = $this->admin('words-list', 'super_admin')->createToken('api', ['seo:read'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/site-settings/sensitive-words')
            ->assertOk()
            ->assertJsonPath('data.total', 1)
            ->assertJsonPath('data.items.0.word', '列一个词')
            ->assertJsonPath('data.limit', ArticleRiskScanner::MAX_RULE_COUNT);
    }

    private function rule(string $word): SensitiveWord
    {
        return SensitiveWord::query()->create([
            // 用精确词面：批量导入的「已存在则不重复入库」判定按词面比对，
            // 夹具加后缀会把这个判定悄悄测没了。
            'word' => $word,
            'severity' => 'warning',
            'category' => 'sensitive',
            'is_enabled' => true,
            'applies_to' => ['content'],
        ]);
    }

    /** @return array<string,mixed> */
    private function updatePayload(): array
    {
        return [
            'word' => '改后的词-'.uniqid(),
            'severity' => 'blocked',
            'category' => '广告法',
            'is_enabled' => true,
            'applies_to' => ['content'],
        ];
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
