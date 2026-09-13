<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\DistributionChannel;
use App\Models\Task;
use App\Models\TaskRun;
use App\Models\Title;
use App\Models\TitleLibrary;
use App\Models\WorkerHeartbeat;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class TaskMonitoringApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->ensureWorkerHeartbeatTable();
    }

    public function test_workers_require_tasks_read_scope(): void
    {
        $admin = $this->admin('worker-scope-admin');
        $token = $admin->createToken('without-tasks-read', ['catalog:read'])->plainTextToken;

        $this->withToken($token)
            ->getJson('/api/v1/tasks/workers')
            ->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden')
            ->assertJsonPath('error.details.required_scope', 'tasks:read');
    }

    public function test_workers_return_persisted_heartbeats_with_server_side_stale_state_and_pagination(): void
    {
        config()->set('geoflow.worker_stale_seconds', 120);
        $admin = $this->admin('worker-reader');
        $token = $admin->createToken('worker-reader', ['tasks:read'])->plainTextToken;

        WorkerHeartbeat::query()->create([
            'worker_id' => 'worker-fresh',
            'status' => 'idle',
            'last_seen_at' => now(),
            'meta' => ['memory_mb' => 18.5],
        ]);
        WorkerHeartbeat::query()->create([
            'worker_id' => 'worker-stale',
            'status' => 'running',
            'last_seen_at' => now()->subMinutes(5),
            'meta' => ['memory_mb' => 32.0],
        ]);

        $firstPage = $this->withToken($token)
            ->getJson('/api/v1/tasks/workers?per_page=1&page=1')
            ->assertOk()
            ->assertJsonPath('success', true)
            ->assertJsonPath('data.items.0.worker_id', 'worker-fresh')
            ->assertJsonPath('data.items.0.status', 'idle')
            ->assertJsonPath('data.items.0.is_stale', false)
            ->assertJsonPath('data.pagination.page', 1)
            ->assertJsonPath('data.pagination.per_page', 1)
            ->assertJsonPath('data.pagination.total', 2)
            ->assertJsonPath('data.pagination.total_pages', 2);

        $this->assertSame(18.5, (float) $firstPage->json('data.items.0.memory_mb'));

        $this->withToken($token)
            ->getJson('/api/v1/tasks/workers?per_page=1&page=2')
            ->assertOk()
            ->assertJsonPath('data.items.0.worker_id', 'worker-stale')
            ->assertJsonPath('data.items.0.status', 'stale')
            ->assertJsonPath('data.items.0.is_stale', true);
    }

    public function test_title_readiness_returns_the_existing_business_report_and_validates_query(): void
    {
        $admin = $this->admin('title-readiness-reader');
        $token = $admin->createToken('title-readiness-reader', ['tasks:read'])->plainTextToken;
        $library = $this->titleLibrary('Readiness API titles');
        Title::query()->create([
            'library_id' => $library->id,
            'title' => 'Available title',
            'used_count' => 0,
        ]);

        $this->withToken($token)
            ->getJson('/api/v1/tasks/title-readiness?'.http_build_query([
                'title_library_id' => $library->id,
                'article_limit' => 2,
                'is_loop' => 0,
                'status' => 'active',
            ]))
            ->assertOk()
            ->assertJsonPath('data.status', 'blocked')
            ->assertJsonPath('data.can_save', false)
            ->assertJsonPath('data.can_activate', false)
            ->assertJsonPath('data.library.total', 1)
            ->assertJsonPath('data.library.available', 1)
            ->assertJsonPath('data.shortage', 1)
            ->assertJsonPath('data.issues.0.code', 'title_library_shortage');

        $this->withToken($token)
            ->getJson('/api/v1/tasks/title-readiness')
            ->assertUnprocessable()
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonStructure(['error' => ['details' => ['field_errors']]]);
    }

    public function test_regular_admin_cannot_inspect_or_discover_hosted_task_details(): void
    {
        $admin = $this->admin('hosted-readiness-reader');
        $token = $admin->createToken('hosted-readiness-reader', ['tasks:read'])->plainTextToken;
        $library = $this->titleLibrary('Hosted readiness titles');
        Title::query()->create([
            'library_id' => $library->id,
            'title' => 'Hosted available title',
            'used_count' => 0,
        ]);
        $hostedTask = Task::query()->create([
            'name' => 'Protected hosted task name',
            'title_library_id' => $library->id,
            'status' => 'active',
            'schedule_enabled' => 1,
            'article_limit' => 2,
            'created_count' => 0,
            'is_loop' => false,
        ]);
        $channel = DistributionChannel::query()->create([
            'name' => 'Protected hosted channel',
            'domain' => 'protected-hosted.example.test',
            'endpoint_url' => 'https://protected-hosted.example.test',
            'channel_type' => DistributionChannel::TYPE_HOSTED_SITE,
            'status' => DistributionChannel::STATUS_ACTIVE,
        ]);
        $hostedTask->distributionChannels()->attach($channel->id);

        $this->withToken($token)
            ->getJson('/api/v1/tasks/title-readiness?'.http_build_query([
                'title_library_id' => $library->id,
                'article_limit' => 1,
                'is_loop' => 0,
                'status' => 'active',
                'task_id' => $hostedTask->id,
            ]))
            ->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden');

        $response = $this->withToken($token)
            ->getJson('/api/v1/tasks/title-readiness?'.http_build_query([
                'title_library_id' => $library->id,
                'article_limit' => 1,
                'is_loop' => 0,
                'status' => 'active',
            ]))
            ->assertOk()
            ->assertJsonPath('data.conflicts', [])
            ->assertJsonPath('data.redacted_conflict_count', 1);

        $this->assertStringNotContainsString('Protected hosted task name', $response->getContent());
    }

    /**
     * 全局健康快照。
     *
     * 旧后台的 `tasks/health-check` 本来就是个 JSON 接口；这里只回 JSON，
     * 不回那两段 Blade HTML（页面专用，随退役消失），也不回 `tasks` 列表
     * （它和 `GET tasks` 是同一份投影）。
     */
    public function test_health_reports_queue_workers_and_recent_runs(): void
    {
        $this->taskRun('health-a', 'completed');

        $response = $this->withToken($this->admin('health_admin')->createToken('api', ['tasks:read'])->plainTextToken)
            ->getJson('/api/v1/tasks/health')
            ->assertOk();

        foreach (['queue_overview', 'worker_overview', 'recent_runs', 'task_summary', 'pagination'] as $key) {
            $this->assertArrayHasKey($key, $response->json('data'), $key);
        }
        $this->assertArrayNotHasKey('tasks', $response->json('data'));
    }

    /** 这条正是它与 `GET tasks/{task}/jobs` 的区别：范围是**全部任务**。 */
    public function test_recent_runs_spans_every_task_not_just_one(): void
    {
        $first = $this->taskRun('runs-first', 'completed');
        $second = $this->taskRun('runs-second', 'failed');

        $items = $this->withToken($this->admin('runs_admin')->createToken('api', ['tasks:read'])->plainTextToken)
            ->getJson('/api/v1/tasks/jobs?per_page=50')
            ->assertOk()
            ->json('data.items');

        $taskIds = array_map(static fn (array $row): int => (int) $row['task_id'], $items);
        $this->assertContains($first->id, $taskIds);
        $this->assertContains($second->id, $taskIds);
    }

    public function test_recent_runs_can_be_focused_on_a_single_run(): void
    {
        $this->taskRun('focus-a', 'completed');
        $target = $this->taskRun('focus-b', 'failed');

        $items = $this->withToken($this->admin('focus_admin')->createToken('api', ['tasks:read'])->plainTextToken)
            ->getJson('/api/v1/tasks/jobs?run_id='.$target->id)
            ->assertOk()
            ->json('data.items');

        $this->assertCount(1, $items);
        $this->assertSame($target->id, (int) $items[0]['id']);
    }

    public function test_global_monitoring_requires_the_tasks_scope(): void
    {
        $token = $this->admin('scope_admin')->createToken('api', ['materials:read'])->plainTextToken;

        $this->withToken($token)->getJson('/api/v1/tasks/health')->assertStatus(403);
        $this->withToken($token)->getJson('/api/v1/tasks/jobs')->assertStatus(403);
    }

    private function admin(string $username): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'password',
            'email' => $username.'@example.test',
            'display_name' => $username,
            'role' => 'admin',
            'status' => 'active',
        ]);
    }

    private function taskRun(string $name, string $status): Task
    {
        $task = Task::query()->create(['name' => $name, 'status' => 'active']);
        TaskRun::query()->create([
            'task_id' => $task->id,
            'status' => $status,
            'started_at' => now()->subMinutes(5),
            'finished_at' => now(),
        ]);

        return $task;
    }

    private function titleLibrary(string $name): TitleLibrary
    {
        return TitleLibrary::query()->create([
            'name' => $name,
            'description' => '',
            'title_count' => 0,
        ]);
    }

    private function ensureWorkerHeartbeatTable(): void
    {
        if (Schema::hasTable('worker_heartbeats')) {
            return;
        }

        Schema::create('worker_heartbeats', function (Blueprint $table): void {
            $table->string('worker_id', 100)->primary();
            $table->string('status', 20)->default('idle');
            $table->timestamp('last_seen_at')->nullable();
            $table->text('meta')->nullable();
            $table->timestamps();
        });
    }
}
