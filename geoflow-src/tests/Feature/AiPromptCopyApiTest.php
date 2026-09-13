<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\Prompt;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * `POST prompts/{prompt}/copy` —— 把提示词复制成可编辑副本。
 *
 * 这条不是可有可无的便利：系统内置提示词带 `system_key`，`PATCH`/`DELETE` 都按只读
 * 拒绝（409），**复制是改它们的唯一途径**。所以这里锁两件事：
 * ① 副本真的可编辑（复制完还能 PATCH 成功）；② 副本必须掉 system_key，
 * 否则它会继续被当成系统托管条目，又改不动、又可能被同步覆盖。
 */
final class AiPromptCopyApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_copies_a_system_prompt_into_an_editable_duplicate(): void
    {
        $source = $this->prompt('系统质检方案', 'quality_check', '原始质检内容');
        $token = $this->token();

        $response = $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'copy-1')
            ->postJson('/api/v1/prompts/'.$source->id.'/copy')
            ->assertCreated();

        $copyId = (int) $response->json('data.prompt.id');
        $this->assertNotSame((int) $source->id, $copyId);
        $this->assertSame('系统质检方案（副本）', $response->json('data.prompt.name'));
        $this->assertSame('quality_check', $response->json('data.prompt.type'));

        $copy = Prompt::query()->whereKey($copyId)->sole();
        $this->assertSame('原始质检内容', (string) $copy->content);
        $this->assertNull($copy->system_key);
        $this->assertNull($copy->system_version);
        // 原条目没被改动。
        $this->assertSame('系统质检方案', (string) $source->fresh()->name);
        $this->assertNotNull($source->fresh()->system_key);

        // 副本可编辑——这才是复制的目的。
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'copy-edit')
            ->patchJson('/api/v1/prompts/'.$copyId, ['name' => '我的质检方案', 'content' => '改过的质检内容'])
            ->assertOk()
            ->assertJsonPath('data.prompt.name', '我的质检方案');
    }

    public function test_the_source_prompt_stays_read_only(): void
    {
        $source = $this->prompt('系统正文方案', 'content', '正文内容');
        $token = $this->token();

        // 对照组：没有复制这一步，直接改源条目是被拒的。
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'copy-direct-edit')
            ->patchJson('/api/v1/prompts/'.$source->id, ['name' => '直接改', 'content' => '直接改'])
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'prompt_read_only');
    }

    public function test_it_does_not_copy_prompts_of_other_types(): void
    {
        $special = $this->prompt('关键词提示词', 'keyword', '关键词内容');

        $this->withToken($this->token())
            ->withHeader('X-Idempotency-Key', 'copy-special')
            ->postJson('/api/v1/prompts/'.$special->id.'/copy')
            ->assertStatus(404)
            ->assertJsonPath('error.code', 'prompt_not_found');

        $this->assertSame(1, Prompt::query()->where('type', 'keyword')->count());
    }

    public function test_a_replayed_key_does_not_create_a_second_copy(): void
    {
        $source = $this->prompt('系统正文方案', 'content', '正文内容');
        $token = $this->token();

        foreach ([1, 2] as $attempt) {
            $this->withToken($token)
                ->withHeader('X-Idempotency-Key', 'copy-replay')
                ->postJson('/api/v1/prompts/'.$source->id.'/copy')
                ->assertCreated();
        }

        // 库里本来就有若干系统内置的 content 提示词，所以按副本名计数，不数全表。
        $this->assertSame(
            1,
            Prompt::query()->where('name', '系统正文方案（副本）')->count(),
        );
    }

    private function prompt(string $name, string $type, string $content): Prompt
    {
        return Prompt::query()->create([
            'name' => $name,
            'type' => $type,
            'content' => $content,
            'variables' => '',
            // 系统托管条目：带 system_key，因而是只读的。
            'system_key' => 'system.'.md5($name),
            'system_version' => 1,
        ]);
    }

    private function token(): string
    {
        $admin = Admin::query()->firstOrCreate(
            ['username' => 'prompt_copy_admin'],
            [
                'password' => 'Password123!',
                'email' => 'prompt-copy@example.test',
                'display_name' => 'Prompt Copy Admin',
                'role' => 'admin',
                'status' => 'active',
            ],
        );

        return $admin->createToken('api', ['models:read', 'models:write'])->plainTextToken;
    }
}
