<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\Task;
use App\Models\Title;
use App\Models\TitleLibrary;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class TaskOperationsApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_workers_projection_requires_tasks_read_and_returns_pagination(): void
    {
        $admin = $this->admin('workers-reader');
        $token = $admin->createToken('workers-reader', ['tasks:read'])->plainTextToken;

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson('/api/v1/tasks/workers?page=1&per_page=10')
            ->assertOk()
            ->assertJsonPath('data.pagination.page', 1)
            ->assertJsonPath('data.pagination.per_page', 10)
            ->assertJsonPath('data.pagination.total', 0)
            ->assertJsonStructure(['data' => ['items', 'pagination']]);
    }

    public function test_title_readiness_reports_blockers_and_is_read_only(): void
    {
        $admin = $this->admin('title-readiness-reader');
        $token = $admin->createToken('title-readiness-reader', ['tasks:read'])->plainTextToken;
        $library = TitleLibrary::query()->create([
            'name' => 'Readiness library',
            'description' => '',
            'title_count' => 0,
        ]);
        $task = Task::query()->create([
            'name' => 'Readiness task',
            'status' => 'paused',
            'title_library_id' => $library->id,
            'article_limit' => 2,
            'created_count' => 0,
            'is_loop' => false,
        ]);

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson('/api/v1/tasks/title-readiness?title_library_id='.$library->id.'&article_limit=2&is_loop=0&status=paused&task_id='.$task->id)
            ->assertOk()
            ->assertJsonPath('data.status', 'blocked')
            ->assertJsonPath('data.can_activate', false)
            ->assertJsonPath('data.library.available', 0)
            ->assertJsonPath('data.task.id', $task->id);

        $this->assertDatabaseHas('tasks', [
            'id' => $task->id,
            'created_count' => 0,
            'status' => 'paused',
        ]);
        $this->assertDatabaseCount('titles', 0);
    }

    public function test_task_trash_projection_requires_tasks_read_and_returns_snapshot_pagination(): void
    {
        $admin = $this->admin('task-trash-reader');
        $token = $admin->createToken('task-trash-reader', ['tasks:read'])->plainTextToken;

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson('/api/v1/tasks/trash?page=1&per_page=10')
            ->assertOk()
            ->assertJsonPath('data.items', [])
            ->assertJsonPath('data.pagination.page', 1)
            ->assertJsonPath('data.pagination.per_page', 10)
            ->assertJsonPath('data.pagination.total', 0)
            ->assertJsonPath('data.pagination.snapshot_id', 0);
    }

    public function test_title_readiness_becomes_ready_when_available_titles_cover_limit(): void
    {
        $admin = $this->admin('title-readiness-ready');
        $token = $admin->createToken('title-readiness-ready', ['tasks:read'])->plainTextToken;
        $library = TitleLibrary::query()->create([
            'name' => 'Ready library',
            'description' => '',
            'title_count' => 2,
        ]);
        Title::query()->create(['library_id' => $library->id, 'title' => '第一标题', 'used_count' => 0, 'usage_count' => 0]);
        Title::query()->create(['library_id' => $library->id, 'title' => '第二标题', 'used_count' => 0, 'usage_count' => 0]);

        $this->withHeader('Authorization', 'Bearer '.$token)
            ->getJson('/api/v1/tasks/title-readiness?title_library_id='.$library->id.'&article_limit=2&is_loop=0&status=active')
            ->assertOk()
            ->assertJsonPath('data.status', 'ready')
            ->assertJsonPath('data.can_activate', true)
            ->assertJsonPath('data.library.available', 2);
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
}
