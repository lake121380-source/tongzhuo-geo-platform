<?php

namespace Tests\Feature;

use App\Jobs\ProcessArticleAiQualityJob;
use App\Models\Admin;
use App\Models\AiModel;
use App\Models\Article;
use App\Models\ArticleAiQualityCheck;
use App\Models\Author;
use App\Models\Category;
use App\Models\KnowledgeBase;
use App\Models\Prompt;
use App\Models\SensitiveWord;
use App\Models\Task;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class ArticleBatchOperationsApiTest extends TestCase
{
    use RefreshDatabase;

    private Admin $admin;

    private Author $author;

    private Category $category;

    protected function setUp(): void
    {
        parent::setUp();

        Cache::flush();
        Queue::fake();
        if (! Schema::hasTable('article_reviews')) {
            Schema::create('article_reviews', function (Blueprint $table): void {
                $table->id();
                $table->foreignId('article_id')->constrained('articles')->cascadeOnDelete();
                $table->foreignId('admin_id')->constrained('admins');
                $table->string('review_status', 20);
                $table->text('review_note')->default('');
                $table->timestamp('created_at')->nullable();
            });
        }
        $this->admin = Admin::query()->create([
            'username' => 'article-batch-admin',
            'password' => 'password',
            'email' => 'article-batch@example.test',
            'display_name' => 'Article Batch Admin',
            'role' => 'admin',
            'status' => 'active',
        ]);
        $this->author = Author::query()->create(['name' => 'Batch Author']);
        $this->category = Category::query()->create([
            'name' => 'Batch Category',
            'slug' => 'batch-category',
        ]);
    }

    public function test_batch_publish_requires_publish_scope(): void
    {
        $article = $this->article(['review_status' => 'approved']);
        $token = $this->token(['articles:write']);

        $this->withHeaders($this->headers($token, 'batch-publish-scope'))
            ->postJson('/api/v1/articles/batch/publish', ['article_ids' => [$article->id]])
            ->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden');

        $this->assertSame('draft', $article->refresh()->status);
    }

    public function test_batch_mutation_requires_a_valid_idempotency_key(): void
    {
        $article = $this->article();
        $token = $this->token(['articles:write']);

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->postJson('/api/v1/articles/batch/trash', ['article_ids' => [$article->id]])
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'idempotency_key_required');

        $this->withHeaders($this->headers($token, 'invalid key'))
            ->postJson('/api/v1/articles/batch/trash', ['article_ids' => [$article->id]])
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'invalid_idempotency_key');

        $this->assertFalse($article->refresh()->trashed());
    }

    public function test_batch_request_rejects_duplicate_and_oversized_article_lists(): void
    {
        $token = $this->token(['articles:write']);

        $duplicateResponse = $this->withHeaders($this->headers($token, 'batch-duplicate-ids'))
            ->postJson('/api/v1/articles/batch/trash', ['article_ids' => [1, 1]])
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'validation_failed');
        $this->assertSame(
            '文章 ID 不能重复',
            $duplicateResponse->json('error.details.field_errors')['article_ids.1'] ?? null,
        );

        $this->withHeaders($this->headers($token, 'batch-too-many-ids'))
            ->postJson('/api/v1/articles/batch/trash', [
                'article_ids' => range(1, 101),
            ])
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonPath('error.details.field_errors.article_ids', '单次最多处理 100 篇文章');
    }

    public function test_batch_request_rejects_associative_article_id_payloads(): void
    {
        $token = $this->token(['articles:write']);

        $this->withHeaders($this->headers($token, 'batch-associative-ids'))
            ->postJson('/api/v1/articles/batch/trash', ['article_ids' => ['first' => 1]])
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonPath('error.details.field_errors.article_ids', 'article_ids 必须是从 0 开始的 ID 列表');
    }

    public function test_batch_review_returns_independent_success_and_risk_failure(): void
    {
        SensitiveWord::query()->create([
            'word' => 'forbidden claim',
            'severity' => 'blocked',
        ]);
        $clean = $this->article(['title' => 'Clean batch review']);
        $blocked = $this->article([
            'title' => 'Blocked batch review',
            'content' => 'This contains a forbidden claim.',
        ]);
        $token = $this->token(['articles:publish']);

        $this->withHeaders($this->headers($token, 'batch-review-mixed'))
            ->postJson('/api/v1/articles/batch/review', [
                'article_ids' => [$clean->id, $blocked->id],
                'review_status' => 'approved',
                'review_note' => 'Batch editorial review.',
            ])
            ->assertOk()
            ->assertJsonPath('data.action', 'review')
            ->assertJsonPath('data.requested_count', 2)
            ->assertJsonPath('data.succeeded_count', 1)
            ->assertJsonPath('data.failed_count', 1)
            ->assertJsonPath('data.succeeded.0.article_id', $clean->id)
            ->assertJsonPath('data.succeeded.0.result.review_status', 'approved')
            ->assertJsonPath('data.failed.0.article_id', $blocked->id)
            ->assertJsonPath('data.failed.0.error.code', 'article_risk_blocked')
            ->assertJsonPath('data.failed.0.error.http_status', 409);

        $this->assertSame('approved', $clean->refresh()->review_status);
        $this->assertSame('pending', $blocked->refresh()->review_status);
        $this->assertDatabaseHas('article_reviews', [
            'article_id' => $clean->id,
            'admin_id' => $this->admin->id,
            'review_status' => 'approved',
        ]);
        $this->assertDatabaseMissing('article_reviews', ['article_id' => $blocked->id]);
        $this->assertSame(1, $blocked->riskScans()->count());
    }

    public function test_batch_publish_returns_success_and_per_article_state_errors(): void
    {
        $approved = $this->article([
            'title' => 'Approved batch publish',
            'review_status' => 'approved',
        ]);
        $pending = $this->article(['title' => 'Pending batch publish']);
        $token = $this->token(['articles:publish']);

        $this->withHeaders($this->headers($token, 'batch-publish-mixed'))
            ->postJson('/api/v1/articles/batch/publish', [
                'article_ids' => [$approved->id, $pending->id, 999999],
            ])
            ->assertOk()
            ->assertJsonPath('data.succeeded_count', 1)
            ->assertJsonPath('data.failed_count', 2)
            ->assertJsonPath('data.succeeded.0.article_id', $approved->id)
            ->assertJsonPath('data.succeeded.0.result.status', 'published')
            ->assertJsonPath('data.failed.0.article_id', $pending->id)
            ->assertJsonPath('data.failed.0.error.code', 'article_not_publishable')
            ->assertJsonPath('data.failed.1.article_id', 999999)
            ->assertJsonPath('data.failed.1.error.code', 'article_not_found');

        $this->assertSame('published', $approved->refresh()->status);
        $this->assertSame('draft', $pending->refresh()->status);
    }

    public function test_batch_publish_does_not_bypass_ai_quality_gate(): void
    {
        $model = AiModel::query()->create([
            'name' => 'Batch quality model',
            'version' => '1',
            'api_key' => 'test',
            'model_id' => 'batch-quality-model',
            'api_url' => 'https://example.test',
            'model_type' => 'chat',
            'status' => 'active',
        ]);
        $prompt = Prompt::query()
            ->where('system_key', 'article_quality.cn_ads_knowledge.v1')
            ->firstOrFail();
        $knowledgeBase = KnowledgeBase::query()->create([
            'name' => 'Batch quality knowledge',
            'content' => 'Verified enterprise content.',
        ]);
        $task = Task::query()->create([
            'name' => 'Batch quality task',
            'ai_model_id' => $model->id,
            'ai_quality_enabled' => true,
            'ai_quality_prompt_id' => $prompt->id,
            'ai_quality_pass_score' => 85,
            'ai_quality_manual_override_min_score' => 70,
            'need_review' => false,
        ]);
        $task->knowledgeBases()->sync([$knowledgeBase->id => ['sort_order' => 0]]);
        $article = $this->article([
            'title' => 'Quality-gated batch publish',
            'task_id' => $task->id,
            'review_status' => 'approved',
        ]);
        $token = $this->token(['articles:publish']);

        $this->withHeaders($this->headers($token, 'batch-quality-gate'))
            ->postJson('/api/v1/articles/batch/publish', ['article_ids' => [$article->id]])
            ->assertOk()
            ->assertJsonPath('data.succeeded_count', 0)
            ->assertJsonPath('data.failed_count', 1)
            ->assertJsonPath('data.failed.0.error.code', 'article_ai_quality_pending');

        $this->assertSame('draft', $article->refresh()->status);
        $this->assertSame(1, ArticleAiQualityCheck::query()->where('article_id', $article->id)->count());
        Queue::assertPushed(ProcessArticleAiQualityJob::class, 1);
    }

    public function test_batch_trash_replays_the_same_result_for_the_same_key(): void
    {
        $article = $this->article();
        $token = $this->token(['articles:write']);
        $headers = $this->headers($token, 'batch-trash-replay');
        $payload = ['article_ids' => [$article->id]];

        $first = $this->withHeaders($headers)->postJson('/api/v1/articles/batch/trash', $payload);
        $second = $this->withHeaders($headers)->postJson('/api/v1/articles/batch/trash', $payload);

        $first->assertOk()
            ->assertJsonPath('data.succeeded_count', 1)
            ->assertJsonPath('data.succeeded.0.result.trashed', true);
        $second->assertOk()->assertExactJson($first->json());
        $this->assertSoftDeleted('articles', ['id' => $article->id]);
    }

    public function test_batch_restore_returns_restored_projection_and_state_errors(): void
    {
        $trashed = $this->article(['title' => 'Trashed article']);
        $trashed->delete();
        $active = $this->article(['title' => 'Active article']);
        $token = $this->token(['articles:write']);

        $this->withHeaders($this->headers($token, 'batch-restore-mixed'))
            ->postJson('/api/v1/articles/batch/restore', [
                'article_ids' => [$trashed->id, $active->id, 999999],
            ])
            ->assertOk()
            ->assertJsonPath('data.succeeded_count', 1)
            ->assertJsonPath('data.failed_count', 2)
            ->assertJsonPath('data.succeeded.0.article_id', $trashed->id)
            ->assertJsonPath('data.succeeded.0.result.id', $trashed->id)
            ->assertJsonPath('data.failed.0.article_id', $active->id)
            ->assertJsonPath('data.failed.0.error.code', 'article_not_trashed')
            ->assertJsonPath('data.failed.1.article_id', 999999)
            ->assertJsonPath('data.failed.1.error.code', 'article_not_found');

        $this->assertDatabaseHas('articles', [
            'id' => $trashed->id,
            'deleted_at' => null,
        ]);
        $this->assertGreaterThan(1, (int) $trashed->refresh()->ai_quality_policy_version);
    }

    /** @param array<string,mixed> $overrides */
    /**
     * 退役核验时发现「撤回已发布文章」只存在于旧后台（`articles/batch/update-status`），
     * 新接口没有等价端点。这条测试锁定补齐后的语义。
     */
    public function test_batch_status_retracts_a_published_article(): void
    {
        $article = $this->article([
            'status' => 'published',
            'review_status' => 'approved',
            'published_at' => now(),
        ]);
        $token = $this->token(['articles:publish']);

        $this->withHeaders($this->headers($token, 'batch-status-retract'))
            ->postJson('/api/v1/articles/batch/status', [
                'article_ids' => [$article->id],
                'new_status' => 'draft',
            ])
            ->assertOk();

        $fresh = $article->refresh();
        // 撤回不过门禁：这是安全操作，任何时候都该允许——否则质检不通过的文章就永远撤不回来。
        $this->assertSame('draft', $fresh->status);
        // 撤回**保留** review_status：曾经审核通过是事实，不该被撤回抹掉（`normalizeState` 只清 published_at）。
        $this->assertSame('approved', $fresh->review_status);
        $this->assertNull($fresh->published_at);
    }

    public function test_batch_status_cannot_publish_an_unapproved_article(): void
    {
        $article = $this->article(['status' => 'draft', 'review_status' => 'pending']);
        $token = $this->token(['articles:publish']);

        $this->withHeaders($this->headers($token, 'batch-status-bypass'))
            ->postJson('/api/v1/articles/batch/status', [
                'article_ids' => [$article->id],
                'new_status' => 'published',
            ])
            ->assertOk();

        // `ArticleWorkflow::normalizeState` 把未审核通过的文章归一到草稿，
        // 所以这条端点**不是绕过审核的后门**——它只是等价于撤回。
        $fresh = $article->refresh();
        $this->assertSame('draft', $fresh->status);
        $this->assertNotSame('published', $fresh->status);
    }

    public function test_batch_status_rejects_an_unknown_target_status(): void
    {
        $article = $this->article();
        $token = $this->token(['articles:publish']);

        $this->withHeaders($this->headers($token, 'batch-status-bad-target'))
            ->postJson('/api/v1/articles/batch/status', [
                'article_ids' => [$article->id],
                'new_status' => 'archived',
            ])
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'validation_failed');

        $this->assertSame('draft', $article->refresh()->status);
    }

    public function test_batch_status_requires_the_publish_scope(): void
    {
        $article = $this->article(['status' => 'published', 'review_status' => 'approved', 'published_at' => now()]);
        $token = $this->token(['articles:write']);

        // 这条端点能发布，所以按 articles:publish 收边界；只有 articles:write 不该够用。
        $this->withHeaders($this->headers($token, 'batch-status-scope'))
            ->postJson('/api/v1/articles/batch/status', [
                'article_ids' => [$article->id],
                'new_status' => 'draft',
            ])
            ->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden');

        $this->assertSame('published', $article->refresh()->status);
    }

    private function article(array $overrides = []): Article
    {
        return Article::query()->create(array_merge([
            'title' => 'Batch article '.uniqid(),
            'slug' => 'batch-article-'.uniqid(),
            'content' => 'Safe batch article content.',
            'excerpt' => 'Safe batch article excerpt.',
            'category_id' => $this->category->id,
            'author_id' => $this->author->id,
            'status' => 'draft',
            'review_status' => 'pending',
        ], $overrides));
    }

    /** @param list<string> $scopes */
    private function token(array $scopes): string
    {
        return $this->admin
            ->createToken('article-batch-'.uniqid(), $scopes)
            ->plainTextToken;
    }

    /** @return array<string,string> */
    private function headers(string $token, string $idempotencyKey): array
    {
        return [
            'Authorization' => 'Bearer '.$token,
            'X-Idempotency-Key' => $idempotencyKey,
        ];
    }
}
