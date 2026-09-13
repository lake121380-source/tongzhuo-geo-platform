<?php

namespace Tests\Feature;

use App\Jobs\ProcessArticleDistributionJob;
use App\Models\Admin;
use App\Models\Article;
use App\Models\ArticleDistribution;
use App\Models\Author;
use App\Models\Category;
use App\Models\DistributionChannel;
use App\Models\Task;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

class DistributionArticleApiTest extends TestCase
{
    use RefreshDatabase;

    private function admin(string $username = 'distribution_article_api_admin'): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'secret',
            'email' => $username.'@example.test',
            'display_name' => 'Distribution Article API',
            'role' => 'admin',
            'status' => 'active',
        ]);
    }

    private function article(string $slug = 'distribution-api-article'): Article
    {
        $category = Category::query()->create(['name' => 'API 分类', 'slug' => $slug.'-category']);
        $author = Author::query()->create(['name' => 'API 作者']);
        $task = Task::query()->create([
            'name' => 'API 分发任务 '.$slug,
            'status' => 'paused',
            'publish_scope' => 'local_and_distribution',
        ]);

        return Article::query()->create([
            'title' => 'API 分发文章',
            'slug' => $slug,
            'content' => 'Approved article body.',
            'category_id' => $category->id,
            'author_id' => $author->id,
            'task_id' => $task->id,
            'status' => 'published',
            'review_status' => 'approved',
            'published_at' => now(),
        ]);
    }

    private function channel(string $name, string $domain): DistributionChannel
    {
        return DistributionChannel::query()->create([
            'name' => $name,
            'domain' => $domain,
            'endpoint_url' => 'https://'.$domain.'/agent',
            'channel_type' => DistributionChannel::TYPE_GEOFLOW_AGENT,
            'status' => DistributionChannel::STATUS_ACTIVE,
        ]);
    }

    public function test_explicit_channel_must_be_bound_to_the_article_task(): void
    {
        $admin = $this->admin();
        $token = $admin->createToken('distribution-article-test', [
            'articles:publish',
            'distribution:write',
        ])->plainTextToken;
        $article = $this->article();
        $unbound = $this->channel('未关联渠道', 'unbound.example.test');

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->withHeader('X-Idempotency-Key', 'distribution-unbound-channel')
            ->postJson('/api/v1/articles/'.$article->id.'/distribute', [
                'channel_ids' => [$unbound->id],
            ])
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'distribution_channel_not_bound');

        $this->assertDatabaseCount('article_distributions', 0);
    }

    public function test_listing_and_retry_return_real_distribution_state(): void
    {
        Queue::fake();
        $admin = $this->admin('distribution_article_retry_admin');
        $readToken = $admin->createToken('distribution-read-test', ['distribution:read'])->plainTextToken;
        $writeToken = $admin->createToken('distribution-write-test', [
            'articles:publish',
            'distribution:write',
        ])->plainTextToken;
        $article = $this->article('distribution-api-retry-article');
        $channel = $this->channel('重试渠道', 'retry.example.test');
        $article->task->distributionChannels()->attach($channel->id);
        $distribution = ArticleDistribution::query()->create([
            'article_id' => $article->id,
            'distribution_channel_id' => $channel->id,
            'action' => 'publish',
            'status' => 'failed',
            'idempotency_key' => 'fixture-distribution-retry-1',
            'last_error_message' => '远端超时',
            'attempt_count' => 2,
        ]);

        $this->withHeader('Authorization', 'Bearer '.$readToken)
            ->getJson('/api/v1/distribution/jobs?status=failed')
            ->assertOk()
            ->assertJsonPath('data.items.0.id', $distribution->id)
            ->assertJsonPath('data.items.0.status', 'failed')
            ->assertJsonPath('data.items.0.last_error_message', '远端超时');

        $this->withHeader('Authorization', 'Bearer '.$writeToken)
            ->withHeader('X-Idempotency-Key', 'distribution-retry-1')
            ->postJson('/api/v1/distribution/jobs/'.$distribution->id.'/retry')
            ->assertStatus(202)
            ->assertJsonPath('data.job.id', $distribution->id)
            ->assertJsonPath('data.job.status', 'queued');

        $this->assertDatabaseHas('article_distributions', [
            'id' => $distribution->id,
            'status' => 'queued',
            'last_error_message' => null,
        ]);
        Queue::assertPushed(ProcessArticleDistributionJob::class);
    }
}
