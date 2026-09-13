<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\KnowledgeBase;
use App\Models\Prompt;
use App\Models\Title;
use App\Models\TitleLibrary;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;
use Tests\Unit\AdminAiDirectEntryAccessArchitectureTest;

/**
 * api/v1 的文章编辑器助手入口。
 *
 * 这里只覆盖「流开始之前」的契约：scope 边界、校验、以及领域异常到 api/v1 信封的映射。
 * 真正的生成流由 {@see AdminAiDirectEntryAccessArchitectureTest} 守卫其顺序，
 * 端到端跑通需要真实 Provider，不在本测试范围内。
 */
final class ArticleEditorAssistantApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_titles_requires_the_articles_read_scope(): void
    {
        $token = $this->admin('editor-titles-scope')->createToken('editor-api', ['materials:read'])->plainTextToken;

        $this->withToken($token)->getJson('/api/v1/articles/editor/titles')->assertForbidden();
    }

    public function test_titles_returns_candidate_titles_with_pagination(): void
    {
        $library = TitleLibrary::query()->create(['name' => '主标题库']);
        Title::query()->create(['library_id' => $library->id, 'title' => '候选标题一', 'keyword' => '关键词甲']);
        Title::query()->create(['library_id' => $library->id, 'title' => '候选标题二', 'keyword' => '关键词乙', 'used_count' => 3]);

        $token = $this->admin('editor-titles-read')->createToken('editor-api', ['articles:read'])->plainTextToken;

        $response = $this->withToken($token)
            ->getJson('/api/v1/articles/editor/titles?usage=all')
            ->assertOk()
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.pagination.total', 2);

        $titles = array_column($response->json('data.items'), 'title');
        $this->assertContains('候选标题一', $titles);
        $this->assertContains('候选标题二', $titles);
    }

    public function test_titles_defaults_to_unused_candidates(): void
    {
        $library = TitleLibrary::query()->create(['name' => '默认筛选库']);
        Title::query()->create(['library_id' => $library->id, 'title' => '未使用', 'used_count' => 0]);
        Title::query()->create(['library_id' => $library->id, 'title' => '已使用', 'used_count' => 1]);

        $token = $this->admin('editor-titles-default')->createToken('editor-api', ['articles:read'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/articles/editor/titles')
            ->assertOk()
            ->assertJsonPath('data.pagination.total', 1)
            ->assertJsonPath('data.items.0.title', '未使用');
    }

    public function test_generate_requires_the_articles_write_scope(): void
    {
        $token = $this->admin('editor-generate-scope')->createToken('editor-api', ['articles:read'])->plainTextToken;

        $this->withToken($token)
            ->postJson('/api/v1/articles/editor/generate', [])
            ->assertForbidden();
    }

    public function test_generate_validates_the_editor_payload(): void
    {
        $token = $this->admin('editor-generate-validate')->createToken('editor-api', ['articles:write'])->plainTextToken;

        $this->withToken($token)
            ->postJson('/api/v1/articles/editor/generate', ['title' => ''])
            ->assertStatus(422)
            ->assertJsonPath('success', false)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonStructure(['error' => ['details' => ['field_errors' => ['title', 'knowledge_base_id', 'prompt_id']]]]);
    }

    public function test_generate_rejects_a_prompt_that_is_not_a_content_prompt(): void
    {
        $knowledgeBase = KnowledgeBase::query()->create(['name' => '编辑器知识库', 'content' => '正文']);
        $qualityPrompt = Prompt::query()->create([
            'name' => '质检方案',
            'type' => 'quality_check',
            'content' => '检查一下',
        ]);
        $token = $this->admin('editor-generate-prompt')->createToken('editor-api', ['articles:write'])->plainTextToken;

        $this->withToken($token)
            ->postJson('/api/v1/articles/editor/generate', [
                'title' => '标题',
                'knowledge_base_id' => $knowledgeBase->id,
                'prompt_id' => $qualityPrompt->id,
            ])
            ->assertStatus(422)
            ->assertJsonStructure(['error' => ['details' => ['field_errors' => ['prompt_id']]]]);
    }

    public function test_generate_reports_an_api_error_envelope_when_no_model_is_available(): void
    {
        $knowledgeBase = KnowledgeBase::query()->create(['name' => '无模型知识库', 'content' => '正文']);
        $prompt = Prompt::query()->create(['name' => '内容方案', 'type' => 'content', 'content' => '写一段']);
        $token = $this->admin('editor-generate-nomodel')->createToken('editor-api', ['articles:write'])->plainTextToken;

        $response = $this->withToken($token)
            ->postJson('/api/v1/articles/editor/generate', [
                'title' => '标题',
                'knowledge_base_id' => $knowledgeBase->id,
                'prompt_id' => $prompt->id,
            ]);

        // 没有可用模型时必须在流开始前失败，并且仍然是普通信封（不是 200 的流）。
        $this->assertContains($response->status(), [404, 422], '未配置模型时应返回 404/422 的信封而不是流');
        $response->assertJsonPath('success', false);
        $this->assertIsString($response->json('error.code'));
        $this->assertNotSame('', (string) $response->json('error.code'));
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
