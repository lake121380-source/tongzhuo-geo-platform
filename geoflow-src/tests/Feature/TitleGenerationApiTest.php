<?php

namespace Tests\Feature;

use App\Jobs\ProcessTitleGenerationBatchJob;
use App\Models\Admin;
use App\Models\AiModel;
use App\Models\Keyword;
use App\Models\KeywordLibrary;
use App\Models\TitleGenerationRun;
use App\Models\TitleLibrary;
use App\Services\GeoFlow\TitleGenerationRunService;
use App\Support\GeoFlow\ApiKeyCrypto;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Tests\TestCase;

/**
 * api/v1 的标题库 AI 生成链路（提交 / 记录 / 进度 / 重试 / 取消）。
 *
 * 锁住四件事：
 * ① 提交要走真实队列（`ProcessTitleGenerationBatchJob`），不是同步生成；
 * ② 两道确认门禁（超量确认、关键词复用确认）与旧后台**共用同一份规则**，
 *    api/v1 不能因为「不是 FormRequest」就漏掉；
 * ③ 作用域：任务只对「以谁的身份访问模型」的那个人可见，别人的 id 一律 404；
 * ④ 失败原因是有限集合，且每个都有对外文案与状态码（不静默降级成 500）。
 */
final class TitleGenerationApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_queues_a_generation_run_and_returns_the_progress_projection(): void
    {
        Queue::fake();
        [$admin, $keywords, $library, $model] = $this->fixtures();
        $token = $this->token($admin);

        $response = $this->withToken($token)
            ->withHeader('X-Idempotency-Key', 'gen-1')
            ->postJson($this->base($library), $this->payload($keywords, $model, 1));
        $response->assertStatus(202);

        $response->assertJsonPath('data.run.status', TitleGenerationRun::STATUS_QUEUED);
        $response->assertJsonPath('data.run.requested_count', 1);
        $response->assertJsonPath('data.run.title_library_id', $library->id);
        $response->assertJsonPath('data.run.active', true);
        // 状态投影与旧后台轮询端点同构：前端不必为两个入口写两套解析。
        $this->assertArrayHasKey('progress_percent', $response->json('data.run'));
        $this->assertArrayHasKey('next_poll_ms', $response->json('data.run'));

        $run = TitleGenerationRun::query()->sole();
        // 身份快照落在提交人身上——这是后续可见性与重试的判据。
        $this->assertSame($admin->id, (int) $run->model_access_admin_id);
        $this->assertSame($admin->id, (int) $run->created_by_admin_id);

        Queue::assertPushed(ProcessTitleGenerationBatchJob::class);
    }

    public function test_the_same_idempotency_key_does_not_create_a_second_run(): void
    {
        Queue::fake();
        [$admin, $keywords, $library, $model] = $this->fixtures();
        $token = $this->token($admin);
        $payload = $this->payload($keywords, $model, 1);

        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-same')
            ->postJson($this->base($library), $payload)->assertStatus(202);
        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-same')
            ->postJson($this->base($library), $payload)->assertStatus(202);

        // 回放而不是再建一次：否则第二次会撞「已有进行中的任务」。
        $this->assertSame(1, TitleGenerationRun::query()->count());
    }

    public function test_a_second_submission_is_rejected_while_one_run_is_active(): void
    {
        Queue::fake();
        [$admin, $keywords, $library, $model] = $this->fixtures();
        $token = $this->token($admin);

        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-a')
            ->postJson($this->base($library), $this->payload($keywords, $model, 1))->assertStatus(202);

        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-b')
            ->postJson($this->base($library), $this->payload($keywords, $model, 1))
            ->assertStatus(409)
            ->assertJsonPath('error.code', TitleGenerationRunService::REASON_ACTIVE);
    }

    public function test_it_requires_confirmation_when_the_target_count_exceeds_the_keyword_count(): void
    {
        Queue::fake();
        [$admin, $keywords, $library, $model] = $this->fixtures();
        $token = $this->token($admin);
        $payload = $this->payload($keywords, $model, 2);
        unset($payload['confirmed_keyword_reuse']);

        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-reuse')
            ->postJson($this->base($library), $payload)
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonPath(
                'error.details.field_errors.confirmed_keyword_reuse',
                __('admin.title_ai_generate.error.keyword_reuse_confirmation_required'),
            );

        $this->assertSame(0, TitleGenerationRun::query()->count());
        Queue::assertNothingPushed();
    }

    public function test_it_requires_confirmation_for_a_run_above_the_threshold(): void
    {
        Queue::fake();
        config(['geoflow.title_ai_confirmation_threshold' => 2]);
        [$admin, $keywords, $library, $model] = $this->fixtures();
        $this->addKeywords($keywords, 4);
        $token = $this->token($admin);
        $payload = $this->payload($keywords, $model, 3);
        unset($payload['confirmed_large_run']);

        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-large')
            ->postJson($this->base($library), $payload)
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonPath(
                'error.details.field_errors.confirmed_large_run',
                __('admin.title_ai_generate.error.large_run_confirmation_required'),
            );

        $this->assertSame(0, TitleGenerationRun::query()->count());
    }

    public function test_it_rejects_a_keyword_library_without_keywords(): void
    {
        Queue::fake();
        [$admin, , $library, $model] = $this->fixtures();
        $empty = KeywordLibrary::query()->create(['name' => '空词库', 'description' => '', 'keyword_count' => 0]);
        $token = $this->token($admin);

        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-empty')
            ->postJson($this->base($library), $this->payload($empty, $model, 1))
            ->assertStatus(422)
            ->assertJsonPath('error.code', TitleGenerationRunService::REASON_NO_KEYWORDS);
    }

    public function test_it_refuses_a_model_the_admin_cannot_reach(): void
    {
        Queue::fake();
        [$admin, $keywords, $library] = $this->fixtures();
        // 别人的模型：访问范围是 user_content，但所有者不是提交人。
        $foreign = $this->model($this->admin('other_owner'), 'foreign-model');
        $token = $this->token($admin);

        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-foreign')
            ->postJson($this->base($library), $this->payload($keywords, $foreign, 1))
            ->assertStatus(403)
            ->assertJsonPath('error.code', TitleGenerationRunService::REASON_MODEL_NOT_ACCESSIBLE);

        $this->assertSame(0, TitleGenerationRun::query()->count());
    }

    public function test_a_run_is_invisible_to_another_admin(): void
    {
        Queue::fake();
        [$admin, $keywords, $library, $model] = $this->fixtures();
        $other = $this->admin('bystander');

        $this->withToken($this->token($admin))->withHeader('X-Idempotency-Key', 'gen-owner')
            ->postJson($this->base($library), $this->payload($keywords, $model, 1))->assertStatus(202);
        $run = TitleGenerationRun::query()->sole();

        $otherToken = $this->token($other);
        $url = $this->base($library).'/'.$run->id;

        // 404 而不是 403：403 会泄露「这个 id 确实存在」。
        $this->withToken($otherToken)->getJson($url)->assertStatus(404);
        $this->withToken($otherToken)->withHeader('X-Idempotency-Key', 'gen-other-retry')
            ->postJson($url.'/retry')->assertStatus(404);
        $this->withToken($otherToken)->withHeader('X-Idempotency-Key', 'gen-other-cancel')
            ->postJson($url.'/cancel')->assertStatus(404);

        // 记录列表里也看不到别人的任务。
        $this->withToken($otherToken)->getJson($this->base($library))
            ->assertOk()
            ->assertJsonPath('data.current', null)
            ->assertJsonPath('data.runs', []);
    }

    public function test_index_returns_the_run_the_page_should_resume(): void
    {
        Queue::fake();
        [$admin, $keywords, $library, $model] = $this->fixtures();
        $token = $this->token($admin);

        $this->withToken($token)->getJson($this->base($library))
            ->assertOk()
            ->assertJsonPath('data.current', null);

        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-resume')
            ->postJson($this->base($library), $this->payload($keywords, $model, 1))->assertStatus(202);

        $this->withToken($token)->getJson($this->base($library))
            ->assertOk()
            ->assertJsonPath('data.current.status', TitleGenerationRun::STATUS_QUEUED)
            ->assertJsonCount(1, 'data.runs');
    }

    public function test_cancel_then_retry_walks_the_state_machine(): void
    {
        Queue::fake();
        [$admin, $keywords, $library, $model] = $this->fixtures();
        $token = $this->token($admin);

        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-life-1')
            ->postJson($this->base($library), $this->payload($keywords, $model, 1))->assertStatus(202);
        $run = TitleGenerationRun::query()->sole();
        $url = $this->base($library).'/'.$run->id;

        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-life-cancel')
            ->postJson($url.'/cancel')
            ->assertStatus(202)
            ->assertJsonPath('data.run.status', TitleGenerationRun::STATUS_CANCELLED)
            ->assertJsonPath('data.run.active', false);

        // 已取消的任务再取消一次 → 状态机拒绝。
        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-life-cancel-2')
            ->postJson($url.'/cancel')
            ->assertStatus(409)
            ->assertJsonPath('error.code', TitleGenerationRunService::REASON_NOT_CANCELLABLE);

        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-life-retry')
            ->postJson($url.'/retry')
            ->assertStatus(202)
            ->assertJsonPath('data.run.status', TitleGenerationRun::STATUS_QUEUED)
            ->assertJsonPath('data.run.active', true);

        $this->assertSame(1, (int) $run->fresh()->manual_retry_count);
    }

    public function test_a_run_that_never_started_cannot_be_retried(): void
    {
        Queue::fake();
        [$admin, $keywords, $library, $model] = $this->fixtures();
        $token = $this->token($admin);

        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-nr-1')
            ->postJson($this->base($library), $this->payload($keywords, $model, 1))->assertStatus(202);
        $run = TitleGenerationRun::query()->sole();
        // 还在排队，不是可重试的失败终态。
        $this->assertFalse($run->isRetryable());

        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-nr-2')
            ->postJson($this->base($library).'/'.$run->id.'/retry')
            ->assertStatus(409)
            ->assertJsonPath('error.code', TitleGenerationRunService::REASON_NOT_RETRYABLE);
    }

    public function test_it_reports_capacity_exhaustion_instead_of_queueing_forever(): void
    {
        Queue::fake();
        config(['geoflow.title_ai_max_active_runs_per_admin' => 1]);
        [$admin, $keywords, $library, $model] = $this->fixtures();
        $secondLibrary = TitleLibrary::query()->create(['name' => '第二个标题库', 'description' => '']);
        $token = $this->token($admin);

        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-cap-1')
            ->postJson($this->base($library), $this->payload($keywords, $model, 1))->assertStatus(202);

        $this->withToken($token)->withHeader('X-Idempotency-Key', 'gen-cap-2')
            ->postJson($this->base($secondLibrary), $this->payload($keywords, $model, 1))
            ->assertStatus(409)
            ->assertJsonPath('error.code', TitleGenerationRunService::REASON_CAPACITY_EXCEEDED);

        $this->assertSame(1, TitleGenerationRun::query()->count());
    }

    public function test_writes_require_an_idempotency_key(): void
    {
        Queue::fake();
        [$admin, $keywords, $library, $model] = $this->fixtures();

        $this->withToken($this->token($admin))
            ->postJson($this->base($library), $this->payload($keywords, $model, 1))
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');

        $this->assertSame(0, TitleGenerationRun::query()->count());
    }

    public function test_it_reports_a_missing_title_library(): void
    {
        Queue::fake();
        [$admin, $keywords, , $model] = $this->fixtures();

        $this->withToken($this->token($admin))->withHeader('X-Idempotency-Key', 'gen-404')
            ->postJson('/api/v1/materials/title-libraries/99999/ai-generation-runs', $this->payload($keywords, $model, 1))
            ->assertStatus(404)
            ->assertJsonPath('error.code', 'title_library_not_found');
    }

    /**
     * 每个已知原因码都必须有对外文案与状态码。
     *
     * 这条防的是：往链路里新增一个原因码，两个入口都忘了处理，于是运营方
     * 收到一句「AI 标题生成暂时不可用」加 500——排查时完全看不出发生了什么。
     */
    public function test_every_known_reason_has_a_message_and_status(): void
    {
        $reasons = [
            TitleGenerationRunService::REASON_NO_KEYWORDS,
            TitleGenerationRunService::REASON_ACTIVE,
            TitleGenerationRunService::REASON_NOT_RETRYABLE,
            TitleGenerationRunService::REASON_NOT_CANCELLABLE,
            TitleGenerationRunService::REASON_ASYNC_QUEUE_REQUIRED,
            TitleGenerationRunService::REASON_MODEL_UNAVAILABLE,
            TitleGenerationRunService::REASON_KEYWORD_REUSE_REQUIRED,
            TitleGenerationRunService::REASON_CAPACITY_EXCEEDED,
            TitleGenerationRunService::REASON_EXECUTION_ADMIN_INACTIVE,
            TitleGenerationRunService::REASON_CONFIG_ACCESS_REVOKED,
            TitleGenerationRunService::REASON_MODEL_NOT_ACCESSIBLE,
        ];

        foreach ($reasons as $reason) {
            $this->assertTrue(TitleGenerationRunService::isKnownReason($reason), $reason);
            $this->assertNotSame(
                TitleGenerationRunService::message(TitleGenerationRunService::REASON_FAILED),
                TitleGenerationRunService::message($reason),
                $reason.' 落到了兜底文案',
            );
            $this->assertNotSame(500, TitleGenerationRunService::httpStatus($reason), $reason.' 落到了 500');
        }

        // 兜底那条本身也必须可解释。
        $this->assertSame(500, TitleGenerationRunService::httpStatus(TitleGenerationRunService::REASON_FAILED));
        $this->assertFalse(TitleGenerationRunService::isKnownReason(TitleGenerationRunService::REASON_FAILED));
    }

    private function base(TitleLibrary $library): string
    {
        return '/api/v1/materials/title-libraries/'.$library->id.'/ai-generation-runs';
    }

    /** @return array<string, mixed> */
    private function payload(KeywordLibrary $keywords, AiModel $model, int $count): array
    {
        return [
            'keyword_library_id' => (int) $keywords->id,
            'ai_model_id' => (int) $model->id,
            'title_count' => $count,
            'title_style' => 'professional',
            'custom_prompt' => '',
            'confirmed_large_run' => 1,
            'confirmed_keyword_reuse' => 1,
        ];
    }

    private function token(Admin $admin): string
    {
        return $admin->createToken('api', ['materials:read', 'materials:write'])->plainTextToken;
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
            'ai_config_access_version' => 1,
        ]);
    }

    private function model(Admin $owner, string $name): AiModel
    {
        $model = new AiModel([
            'name' => $name,
            'version' => 'test',
            'api_key' => app(ApiKeyCrypto::class)->encrypt('title-api-test-key'),
            'model_id' => $name,
            'model_type' => 'chat',
            'api_url' => 'https://ai.test/v1',
            'daily_limit' => 100_000,
            'used_today' => 0,
            'total_used' => 0,
            'status' => 'active',
        ]);
        $model->forceFill([
            'owner_admin_id' => $owner->id,
            'access_scope' => AiModel::ACCESS_SCOPE_USER_CONTENT,
        ])->save();

        return $model;
    }

    private function addKeywords(KeywordLibrary $library, int $count): void
    {
        $existing = (int) $library->keywords()->count();
        foreach (range(1, $count) as $index) {
            Keyword::query()->create([
                'library_id' => $library->id,
                'keyword' => $library->name.' 词 '.($existing + $index),
                'used_count' => 0,
                'usage_count' => 0,
            ]);
        }
    }

    /** @return array{0:Admin,1:KeywordLibrary,2:TitleLibrary,3:AiModel} */
    private function fixtures(): array
    {
        $admin = $this->admin('title_api_admin');
        $keywords = KeywordLibrary::query()->create([
            'name' => 'GEO 关键词库',
            'description' => '',
            'keyword_count' => 1,
        ]);
        Keyword::query()->create([
            'library_id' => $keywords->id,
            'keyword' => 'GEO 内容工程',
            'used_count' => 0,
            'usage_count' => 0,
        ]);
        $library = TitleLibrary::query()->create([
            'name' => 'GEO 标题库',
            'description' => '',
            'title_count' => 0,
            'generation_type' => 'manual',
            'generation_rounds' => 1,
            'is_ai_generated' => 0,
        ]);

        return [$admin, $keywords, $library, $this->model($admin, 'title-api-model')];
    }
}
