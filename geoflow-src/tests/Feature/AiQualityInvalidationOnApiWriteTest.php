<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\AiModel;
use App\Models\Article;
use App\Models\ArticleAiQualityCheck;
use App\Models\Author;
use App\Models\Category;
use App\Models\KnowledgeBase;
use App\Models\Prompt;
use App\Models\Task;
use App\Services\GeoFlow\ArticleAiQualityInspectionService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * 经 api/v1 改模型或质检提示词，必须让已有的 AI 质检结论失效。
 *
 * 这不是新功能，是补一条两条写路径之间的不一致：旧 Blade 后台一直会失效，
 * api/v1 这条路径漏了，导致文章带着「用旧模型/旧方案得出的结论」继续流转。
 */
final class AiQualityInvalidationOnApiWriteTest extends TestCase
{
    use RefreshDatabase;

    public function test_updating_a_quality_prompt_through_the_api_invalidates_existing_checks(): void
    {
        $fixture = $this->qualityFixture();
        $check = $this->completedCheck($fixture['article']);
        $this->assertSame('completed', $check->fresh()->status);

        $token = $this->admin('prompt-invalidation')->createToken('api', ['models:write'])->plainTextToken;
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'prompt-update-invalidates')
            ->patchJson('/api/v1/prompts/'.$fixture['prompt']->id, [
                'name' => '质检方案（已调整）',
                'content' => '请检查 {{ article_title }} 的合规性并给出结论。',
            ])
            ->assertOk();

        $this->assertSame('stale', $check->fresh()->status, 'API 改质检提示词后，已有质检结论必须失效');
    }

    public function test_updating_a_chat_model_through_the_api_invalidates_existing_checks(): void
    {
        // 模型必须归当前管理员所有，否则 updateModel 会以 model_not_found 拒绝。
        $admin = $this->admin('model-invalidation');
        $fixture = $this->qualityFixture(owner: $admin);
        $check = $this->completedCheck($fixture['article']);
        $this->assertSame('completed', $check->fresh()->status);

        $token = $admin->createToken('api', ['models:write'])->plainTextToken;
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'model-update-invalidates')
            ->patchJson('/api/v1/models/'.$fixture['model']->id, ['name' => '质检模型（改名）'])
            ->assertOk();

        $this->assertSame('stale', $check->fresh()->status, 'API 改模型后，已有质检结论必须失效');
    }

    public function test_creating_a_chat_model_through_the_api_invalidates_smart_failover_checks(): void
    {
        // 新增模型只影响「智能切换」的任务：候选集变了，之前选中的模型可能不再是同一批。
        $fixture = $this->qualityFixture(modelSelectionMode: 'smart_failover');
        $check = $this->completedCheck($fixture['article']);
        $this->assertSame('completed', $check->fresh()->status);

        $token = $this->admin('model-create-invalidation')->createToken('api', ['models:write'])->plainTextToken;
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'model-create-invalidates')
            ->postJson('/api/v1/models', [
                'name' => '新增候选质检模型',
                'model_id' => 'new-quality-candidate',
                'model_type' => 'chat',
                'api_url' => 'https://example.test/v1',
                'api_key' => 'sk-test-key',
            ])
            ->assertCreated();

        $this->assertSame('stale', $check->fresh()->status, '新增 chat 模型会改变智能切换候选集，已有结论必须失效');
    }

    public function test_updating_an_embedding_only_model_does_not_touch_quality_checks(): void
    {
        // 反向断言：不是所有模型写操作都该作废质检结论，只有质检用得上的才会。
        $fixture = $this->qualityFixture();
        $check = $this->completedCheck($fixture['article']);
        $embedding = AiModel::query()->create([
            'name' => '向量模型 '.uniqid(),
            'version' => '1',
            'api_key' => 'test',
            'model_id' => 'embedding-model',
            'model_type' => 'embedding',
            'api_url' => 'https://example.test',
            'status' => 'active',
        ]);

        $token = $this->admin('embedding-invalidation')->createToken('api', ['models:write'])->plainTextToken;
        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'embedding-create')
            ->postJson('/api/v1/models', [
                'name' => '新增向量模型',
                'model_id' => 'embedding-model-2',
                'model_type' => 'embedding',
                'api_url' => 'https://example.test/v1',
                'api_key' => 'sk-test-key',
            ])
            ->assertCreated();

        $this->assertSame('completed', $check->fresh()->status, '新增 embedding 模型不该动质检结论');
        $this->assertNotNull($embedding->id);
    }

    /** 非系统内置的质检提示词：系统内置的经 API 是只读的，测不了更新路径。 */
    private function qualityPrompt(): Prompt
    {
        return Prompt::query()->create([
            'name' => '质检方案 '.uniqid(),
            'type' => 'quality_check',
            'content' => '请检查 {{ article_title }} 的合规性。',
        ]);
    }

    /**
     * @return array{prompt:Prompt,model:AiModel,article:Article,task:Task}
     */
    private function qualityFixture(string $modelSelectionMode = 'fixed', ?Admin $owner = null): array
    {
        $prompt = $this->qualityPrompt();
        // AiModel 是显式 $fillable 白名单，owner_admin_id/access_scope 不在其中，
        // create() 会静默丢弃它们——必须 forceFill，否则非超管根本编辑不到这条模型。
        $model = AiModel::query()->create([
            'name' => '质检模型 '.uniqid(),
            'version' => '1',
            'api_key' => 'test',
            'model_id' => 'quality-model',
            'model_type' => 'chat',
            'api_url' => 'https://example.test',
            'status' => 'active',
        ]);
        $model->forceFill([
            'owner_admin_id' => $owner?->id,
            'access_scope' => AiModel::ACCESS_SCOPE_USER_CONTENT,
        ])->save();
        $task = Task::query()->create([
            'name' => '质检任务 '.uniqid(),
            'ai_model_id' => $model->id,
            'ai_quality_enabled' => true,
            'ai_quality_prompt_id' => $prompt->id,
            'ai_quality_model_id' => $model->id,
            'model_selection_mode' => $modelSelectionMode,
            'ai_quality_pass_score' => 85,
            'ai_quality_manual_override_min_score' => 70,
        ]);
        $knowledgeBase = KnowledgeBase::query()->create([
            'name' => '质检知识库 '.uniqid(),
            'content' => '待检查正文的核验依据。',
        ]);
        $task->knowledgeBases()->sync([$knowledgeBase->id => ['sort_order' => 0]]);
        $category = Category::query()->create(['name' => '分类 '.uniqid(), 'slug' => 'category-'.uniqid()]);
        $author = Author::query()->create(['name' => '作者 '.uniqid()]);

        $article = Article::query()->create([
            'title' => '待发布文章',
            'slug' => 'quality-invalidation-'.uniqid(),
            'content' => '待检查正文。',
            'category_id' => $category->id,
            'author_id' => $author->id,
            'task_id' => $task->id,
            'status' => 'draft',
            'review_status' => 'pending',
        ]);

        return ['prompt' => $prompt, 'model' => $model, 'article' => $article, 'task' => $task];
    }

    private function completedCheck(Article $article): ArticleAiQualityCheck
    {
        $check = app(ArticleAiQualityInspectionService::class)->createOrReuse($article, dispatch: false);
        $check->forceFill([
            'status' => 'completed',
            'decision' => 'passed',
            'score' => 96,
            'active_dedupe_key' => null,
            'finished_at' => now(),
        ])->save();

        return $check;
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
