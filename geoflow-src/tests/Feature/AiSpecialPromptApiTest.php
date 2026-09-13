<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\Prompt;
use App\Services\Admin\AdminAiSpecialPromptService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * api/v1 的关键词 / 描述生成提示词。
 *
 * 这两类提示词被 URL 导入流水线真实消费（决定标题关键词与文章描述的口径），
 * 旧后台一直能改，api/v1 之前完全看不到它们——退役后会直接冻结在部署值。
 *
 * 这里锁的重点不是 CRUD，而是**保存语义**：按类型整体覆盖，而不是改某一条。
 * 另外锁一条边界：它们不能从通用 `prompts` CRUD 里被改到，否则「读最新一条」
 * 与「写全部记录」就会脱钩。
 */
final class AiSpecialPromptApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_lists_both_types_and_reports_what_is_not_configured_yet(): void
    {
        $this->withToken($this->token())
            ->getJson('/api/v1/prompts/special')
            ->assertOk()
            ->assertJsonCount(2, 'data.prompts')
            ->assertJsonPath('data.prompts.0.type', 'keyword')
            ->assertJsonPath('data.prompts.0.configured', false)
            ->assertJsonPath('data.prompts.0.content', '')
            ->assertJsonPath('data.prompts.1.type', 'description')
            ->assertJsonPath('data.prompts.1.configured', false);
    }

    public function test_it_returns_the_most_recently_updated_content_of_each_type(): void
    {
        $this->prompt('keyword', '旧的关键词提示词', '2026-01-01 00:00:00');
        $this->prompt('keyword', '新的关键词提示词', '2026-05-01 00:00:00');
        $this->prompt('description', '描述提示词', '2026-02-01 00:00:00');

        $response = $this->withToken($this->token())
            ->getJson('/api/v1/prompts/special')
            ->assertOk();

        $byType = collect($response->json('data.prompts'))->keyBy('type');
        $this->assertSame('新的关键词提示词', $byType['keyword']['content']);
        $this->assertTrue($byType['keyword']['configured']);
        $this->assertSame('描述提示词', $byType['description']['content']);
    }

    public function test_saving_overwrites_every_row_of_that_type(): void
    {
        $this->prompt('keyword', '分叉版本 A', '2026-01-01 00:00:00');
        $this->prompt('keyword', '分叉版本 B', '2026-02-01 00:00:00');
        $this->prompt('description', '不该被动的描述提示词', '2026-01-01 00:00:00');

        $this->withToken($this->token())
            ->withHeader('X-Idempotency-Key', 'special-keyword')
            ->postJson('/api/v1/prompts/special/keyword', ['content' => '  统一后的关键词提示词  '])
            ->assertOk()
            ->assertJsonPath('data.type', 'keyword')
            ->assertJsonPath('data.content', '统一后的关键词提示词')
            ->assertJsonPath('data.configured', true);

        // 两条历史记录都被覆盖（首尾空白也归一到 trim 后），没有新增第三条。
        $this->assertSame(
            ['统一后的关键词提示词'],
            Prompt::query()->where('type', 'keyword')->pluck('content')->unique()->values()->all(),
        );
        $this->assertSame(2, Prompt::query()->where('type', 'keyword')->count());
        // 另一类不受影响。
        $this->assertSame('不该被动的描述提示词', Prompt::query()->where('type', 'description')->value('content'));
    }

    public function test_saving_creates_the_prompt_when_the_type_has_none(): void
    {
        $this->withToken($this->token())
            ->withHeader('X-Idempotency-Key', 'special-description-first')
            ->postJson('/api/v1/prompts/special/description', ['content' => '第一版描述提示词'])
            ->assertOk()
            ->assertJsonPath('data.configured', true);

        $prompt = Prompt::query()->where('type', 'description')->sole();
        $this->assertSame('第一版描述提示词', $prompt->content);
        $this->assertSame(
            AdminAiSpecialPromptService::fallbackName('description'),
            $prompt->name,
        );
    }

    public function test_it_rejects_an_unknown_type(): void
    {
        $this->withToken($this->token())
            ->withHeader('X-Idempotency-Key', 'special-unknown')
            ->postJson('/api/v1/prompts/special/seo_title', ['content' => '内容'])
            ->assertStatus(404)
            ->assertJsonPath('error.code', 'special_prompt_type_unknown');

        // 库里本来就有系统内置的 content / quality_check 提示词，所以只看这个类型有没有被写进去。
        $this->assertSame(0, Prompt::query()->where('type', 'seo_title')->count());
    }

    public function test_saving_requires_content(): void
    {
        $this->withToken($this->token())
            ->withHeader('X-Idempotency-Key', 'special-empty')
            ->postJson('/api/v1/prompts/special/keyword', ['content' => ''])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed');

        $this->assertSame(0, Prompt::query()->where('type', 'keyword')->count());
    }

    /**
     * 通用 prompts CRUD 不能碰这两类。
     *
     * 它一次只改一条，而本组端点的读法（取最新一条）与写法（覆盖全部）必须成对。
     * 一旦同一个类型能被两套语义改写，就会出现「页面上显示 A、流水线用的是 B」。
     */
    public function test_the_special_types_stay_out_of_the_generic_prompt_crud(): void
    {
        $this->prompt('keyword', '关键词提示词', '2026-01-01 00:00:00');
        $this->prompt('content', '正文提示词', '2026-01-01 00:00:00');
        $this->prompt('quality_check', '质检提示词', '2026-01-01 00:00:00');
        $token = $this->token();

        $types = array_column($this->withToken($token)->getJson('/api/v1/prompts')->json('data.items'), 'type');
        $this->assertContains('content', $types);
        $this->assertContains('quality_check', $types);
        $this->assertNotContains('keyword', $types);
        $this->assertNotContains('description', $types);
    }

    public function test_reading_requires_the_models_scope(): void
    {
        $admin = $this->admin();
        $token = $admin->createToken('api', ['materials:read'])->plainTextToken;

        $this->withToken($token)->getJson('/api/v1/prompts/special')->assertStatus(403);
    }

    private function prompt(string $type, string $content, string $updatedAt): Prompt
    {
        $prompt = Prompt::query()->create([
            'name' => '测试提示词 '.$type,
            'type' => $type,
            'content' => $content,
            'variables' => '',
        ]);
        $prompt->forceFill(['created_at' => $updatedAt, 'updated_at' => $updatedAt])->save();

        return $prompt;
    }

    private function token(): string
    {
        return $this->admin()->createToken('api', ['models:read', 'models:write'])->plainTextToken;
    }

    private function admin(): Admin
    {
        return Admin::query()->firstOrCreate(
            ['username' => 'special_prompt_admin'],
            [
                'password' => 'Password123!',
                'email' => 'special-prompts@example.test',
                'display_name' => 'Special Prompt Admin',
                'role' => 'admin',
                'status' => 'active',
            ],
        );
    }
}
