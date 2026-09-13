<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\Article;
use App\Models\ArticleDistribution;
use App\Models\Author;
use App\Models\Category;
use App\Models\DistributionChannel;
use App\Services\GeoFlow\DistributionArticleOperationService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * api/v1 的分发记录修正（改/删远端文章）与前端能力刷新。
 *
 * 这里锁的是**边界**：幂等键、渠道状态、Hosted Site 排除。真正的远端推送由编排器
 * 出站，不在本测试范围内——本地落库与指纹同步由
 * {@see DistributionArticleOperationService} 拥有并有架构守卫兜底。
 */
final class DistributionJobApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_job_update_requires_an_idempotency_key(): void
    {
        [$distribution] = $this->jobFixture();
        $token = $this->admin('job-update-idem')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->patchJson('/api/v1/distribution/jobs/'.$distribution->id, $this->articlePayload())
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');
    }

    public function test_job_update_reports_an_unknown_distribution(): void
    {
        $token = $this->admin('job-update-missing')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'job-update-missing')
            ->patchJson('/api/v1/distribution/jobs/99999', $this->articlePayload())
            ->assertStatus(404)
            ->assertJsonPath('error.code', 'distribution_job_not_found');
    }

    public function test_job_update_validates_the_article_payload(): void
    {
        [$distribution] = $this->jobFixture();
        $token = $this->admin('job-update-invalid')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'job-update-invalid')
            ->patchJson('/api/v1/distribution/jobs/'.$distribution->id, ['title' => ''])
            ->assertStatus(422)
            ->assertJsonStructure(['error' => ['details' => ['field_errors' => ['title', 'content']]]]);
    }

    public function test_job_update_refuses_a_hosted_site_channel(): void
    {
        [$distribution] = $this->jobFixture('hosted_site');
        $token = $this->admin('job-update-hosted')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'job-update-hosted')
            ->patchJson('/api/v1/distribution/jobs/'.$distribution->id, $this->articlePayload())
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'job_not_supported');
    }

    public function test_job_delete_refuses_a_channel_in_the_deleting_flow(): void
    {
        [$distribution] = $this->jobFixture('geoflow_agent', DistributionChannel::STATUS_DELETING);
        $token = $this->admin('job-delete-deleting')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'job-delete-deleting')
            ->deleteJson('/api/v1/distribution/jobs/'.$distribution->id)
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'distribution_channel_deleting');
    }

    public function test_job_delete_requires_an_idempotency_key(): void
    {
        [$distribution] = $this->jobFixture();
        $token = $this->admin('job-delete-idem')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->deleteJson('/api/v1/distribution/jobs/'.$distribution->id)
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');
    }

    public function test_frontend_capability_refresh_requires_an_idempotency_key(): void
    {
        $channel = $this->channel();
        $token = $this->admin('cap-idem')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->postJson('/api/v1/distribution/channels/'.$channel->id.'/frontend-capabilities/refresh', [])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');
    }

    public function test_frontend_capability_refresh_reports_an_unknown_channel(): void
    {
        $token = $this->admin('cap-missing')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'cap-missing')
            ->postJson('/api/v1/distribution/channels/99999/frontend-capabilities/refresh', [])
            ->assertStatus(404)
            ->assertJsonPath('error.code', 'channel_not_found');
    }

    public function test_frontend_capability_refresh_refuses_a_paused_channel(): void
    {
        $channel = $this->channel('paused');
        $token = $this->admin('cap-paused')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'cap-paused')
            ->postJson('/api/v1/distribution/channels/'.$channel->id.'/frontend-capabilities/refresh', [])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'channel_not_active');
    }

    /** @return array{ArticleDistribution,Article,DistributionChannel} */
    private function jobFixture(string $channelType = 'geoflow_agent', string $channelStatus = 'active'): array
    {
        $channel = $this->channel($channelStatus, $channelType);
        $category = Category::query()->create(['name' => '分类 '.uniqid(), 'slug' => 'cat-'.uniqid()]);
        $author = Author::query()->create(['name' => '作者 '.uniqid()]);
        $article = Article::query()->create([
            'title' => '远端文章',
            'slug' => 'remote-'.uniqid(),
            'content' => '原始正文。',
            'category_id' => $category->id,
            'author_id' => $author->id,
            'status' => 'draft',
            'review_status' => 'pending',
        ]);
        $distribution = ArticleDistribution::query()->create([
            'article_id' => $article->id,
            'distribution_channel_id' => $channel->id,
            'action' => 'publish',
            'status' => 'completed',
            'idempotency_key' => 'fixture-'.uniqid(),
            'remote_url' => 'https://remote.example.test/'.uniqid(),
        ]);

        return [$distribution, $article, $channel];
    }

    private function channel(string $status = 'active', string $type = 'geoflow_agent'): DistributionChannel
    {
        return DistributionChannel::query()->create([
            'name' => '渠道 '.uniqid(),
            'channel_type' => $type,
            'status' => $status,
            'domain' => 'job-'.uniqid().'.example.test',
            'endpoint_url' => 'https://job.example.test',
        ]);
    }

    /** @return array<string,string> */
    private function articlePayload(): array
    {
        return [
            'title' => '改后的标题',
            'excerpt' => '摘要',
            'content' => '改后的正文。',
            'keywords' => '关键词',
            'meta_description' => '描述',
        ];
    }

    /**
     * 这一族端点保留旧后台 `admin.super` 的边界：站点设置推到渠道前端改的是对外可见的
     * 站点表现，不该放宽给任意带 `distribution:write` 的管理员。
     */
    public function test_distribution_job_rejects_a_non_super_admin(): void
    {
        $token = $this->admin('distribution_job-nonsuper', 'admin')->createToken('api', ['distribution:write'])->plainTextToken;

        $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'distribution_job-nonsuper')
            ->deleteJson('/api/v1/distribution/jobs/1')
            ->assertStatus(403)
            ->assertJsonPath('error.details.required_role', 'super_admin');
    }

    private function admin(string $username, string $role = 'super_admin'): Admin
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
