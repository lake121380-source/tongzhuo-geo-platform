<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\Keyword;
use App\Models\KeywordLibrary;
use App\Models\Title;
use App\Models\TitleLibrary;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * api/v1 的关键词库 / 标题库批量导入。
 *
 * 这是运营方手上已有的词表进库的唯一入口（旧后台的粘贴导入）。锁的是：切分与去重规则、
 * 计数回写、以及「重复条目算 skipped 而不是假装导入成功」。
 */
final class LibraryImportApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_keyword_import_splits_dedupes_and_reports_skipped(): void
    {
        $library = KeywordLibrary::query()->create(['name' => '关键词库']);
        // 已存在的词：导入时必须算 skipped，不能重复入库。
        Keyword::query()->create(['library_id' => $library->id, 'keyword' => '已有词', 'used_count' => 0, 'usage_count' => 0]);
        $token = $this->admin('import-keywords')->createToken('api', ['materials:write'])->plainTextToken;

        // 换行与逗号都是分隔符；重复项只算一次。
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'import-keywords-1')
            ->postJson('/api/v1/materials/keyword-libraries/'.$library->id.'/import', [
                'keywords_text' => "新词甲\n新词乙,新词甲\n已有词",
            ])
            ->assertOk()
            ->assertJsonPath('data.imported', 2)
            ->assertJsonPath('data.skipped', 2);

        // 直接验语义：新词各一条，原本已存在的词仍然只有一条（没被重复插入）。
        $this->assertSame(1, Keyword::query()->where('library_id', $library->id)->where('keyword', '新词甲')->count());
        $this->assertSame(1, Keyword::query()->where('library_id', $library->id)->where('keyword', '新词乙')->count());
        $this->assertSame(1, Keyword::query()->where('library_id', $library->id)->where('keyword', '已有词')->count());
        // 计数回写只加真正插进去的两条。
        $this->assertSame(2, (int) $library->fresh()->keyword_count);
    }

    public function test_title_import_accepts_title_and_keyword_pairs(): void
    {
        $library = TitleLibrary::query()->create(['name' => '标题库']);
        $token = $this->admin('import-titles')->createToken('api', ['materials:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'import-titles-1')
            ->postJson('/api/v1/materials/title-libraries/'.$library->id.'/import', [
                'titles_text' => "带关键词的标题|品牌词\n只有标题\n带关键词的标题|另一个词",
            ])
            ->assertOk()
            // 第三行与第一行标题相同 → 标题级去重，算 skipped。
            ->assertJsonPath('data.imported', 2)
            ->assertJsonPath('data.skipped', 1);

        $pair = Title::query()->where('library_id', $library->id)->where('title', '带关键词的标题')->first();
        $this->assertNotNull($pair);
        $this->assertSame('品牌词', (string) $pair->keyword);
    }

    public function test_import_reports_an_unknown_library(): void
    {
        $token = $this->admin('import-missing')->createToken('api', ['materials:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'import-missing-keywords')
            ->postJson('/api/v1/materials/keyword-libraries/99999/import', ['keywords_text' => '新词'])
            ->assertStatus(404)
            ->assertJsonPath('error.code', 'library_not_found');
    }

    public function test_import_rejects_a_submission_that_splits_to_nothing(): void
    {
        $library = KeywordLibrary::query()->create(['name' => '空导入库']);
        $token = $this->admin('import-empty')->createToken('api', ['materials:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'import-empty-keywords')
            ->postJson('/api/v1/materials/keyword-libraries/'.$library->id.'/import', ['keywords_text' => ', ,'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'library_import_required');
    }

    public function test_import_rejects_more_entries_than_the_policy_allows(): void
    {
        $library = KeywordLibrary::query()->create(['name' => '超量库']);
        $text = implode("\n", array_map(static fn (int $i): string => '词'.$i, range(1, 1001)));
        $token = $this->admin('import-too-many')->createToken('api', ['materials:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'import-too-many')
            ->postJson('/api/v1/materials/keyword-libraries/'.$library->id.'/import', ['keywords_text' => $text])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'library_import_too_many');

        $this->assertSame(0, Keyword::query()->count());
    }

    public function test_import_requires_an_idempotency_key(): void
    {
        $library = KeywordLibrary::query()->create(['name' => '幂等库']);
        $token = $this->admin('import-idem')->createToken('api', ['materials:write'])->plainTextToken;

        $this->withToken($token)
            ->postJson('/api/v1/materials/keyword-libraries/'.$library->id.'/import', ['keywords_text' => '新词'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');
    }

    private function admin(string $username): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'Password123!',
            'email' => $username.'@example.test',
            'display_name' => $username,
            'role' => 'admin',
            'status' => 'active',
        ]);
    }
}
