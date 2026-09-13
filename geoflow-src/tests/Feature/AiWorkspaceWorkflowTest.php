<?php

namespace Tests\Feature;

use App\Contracts\AiWorkspace\AdminHelpResponder;
use App\Models\Admin;
use App\Models\AiConversationMessage;
use App\Services\AiWorkspace\AiConversationRepository;
use App\Services\AiWorkspace\AiWorkspaceModelRuntime;
use Illuminate\Foundation\Testing\LazilyRefreshDatabase;
use Tests\TestCase;

final class AiWorkspaceWorkflowTest extends TestCase
{
    use LazilyRefreshDatabase;

    public function test_workspace_exposes_only_conversations_and_streaming_messages(): void
    {
        // 2026-09-12 退役改指：原先枚举的是 Blade 后台那组 `admin.ai-workspace.*` 路由名，
        // 旧后台删除后它们不存在了。AI 工作台只剩 React 走的那组 API 路由，这里断言那组的形状。
        // **要守的不变量没变**：对外只暴露「会话 CRUD + 流式提问 + 私有媒体」，
        // 没有 runs / metrics / approvals 这些旧工作流面。
        $routes = collect(app('router')->getRoutes())
            ->filter(static fn ($route): bool => str_starts_with((string) $route->uri(), 'api/v1/ai-workspace'))
            ->map(static fn ($route): string => implode('|', array_values(array_diff($route->methods(), ['HEAD']))).' '.$route->uri())
            ->sort()
            ->values()
            ->all();

        self::assertSame([
            'GET api/v1/ai-workspace/conversations',
            'GET api/v1/ai-workspace/conversations/{conversation}',
            'GET api/v1/ai-workspace/media/{mediaAsset}',
            'GET api/v1/ai-workspace/status',
            'PATCH api/v1/ai-workspace/conversations/{conversation}',
            'POST api/v1/ai-workspace/conversations',
            'POST api/v1/ai-workspace/conversations/{conversation}/archive',
            'POST api/v1/ai-workspace/conversations/{conversation}/messages',
        ], $routes);
    }

    public function test_help_responder_is_the_only_workspace_runtime_binding(): void
    {
        self::assertInstanceOf(AiWorkspaceModelRuntime::class, app(AdminHelpResponder::class));
        self::assertSame(app(AiWorkspaceModelRuntime::class), app(AdminHelpResponder::class));

        $provider = (string) file_get_contents(app_path('Providers/AppServiceProvider.php'));
        self::assertStringNotContainsString('AiCapabilityRegistry', $provider);
        self::assertStringNotContainsString('AiCapabilityExecutor', $provider);
        self::assertStringNotContainsString('AiWorkspaceCoordinator', $provider);
        self::assertStringNotContainsString('AiWorkflowEngine', $provider);
    }

    public function test_recovery_command_reports_when_no_workspace_runs_are_stale(): void
    {
        $this->artisan('geoflow:recover-ai-workspace')
            ->expectsOutputToContain('Recovered AI workspace runs: 0')
            ->assertSuccessful();
    }

    public function test_no_active_code_dispatches_legacy_workspace_jobs(): void
    {
        $paths = [
            base_path('routes'),
            app_path('Http'),
            app_path('Providers'),
            app_path('Console/Commands/RecoverAiWorkspaceRunsCommand.php'),
        ];
        $source = '';

        foreach ($paths as $path) {
            if (is_file($path)) {
                $source .= (string) file_get_contents($path);

                continue;
            }
            $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($path));
            foreach ($iterator as $file) {
                if ($file->isFile() && $file->getExtension() === 'php') {
                    $source .= (string) file_get_contents($file->getPathname());
                }
            }
        }

        self::assertStringNotContainsString('ProcessAiWorkspaceRunJob::dispatch', $source);
        self::assertStringNotContainsString('ResolveAiWorkspaceRunJob::dispatch', $source);
    }

    public function test_pruning_includes_help_conversations_that_have_no_legacy_runs(): void
    {
        $admin = Admin::query()->create([
            'username' => 'help-prune-owner',
            'password' => 'secret-123',
            'email' => 'help-prune-owner@example.com',
            'display_name' => 'Admin',
            'role' => 'super_admin',
            'status' => 'active',
        ]);
        $conversation = app(AiConversationRepository::class)->create($admin, '旧帮助会话');
        $message = app(AiConversationRepository::class)->append($conversation, 'user', '旧问题');
        AiConversationMessage::query()->whereKey($message->id)->update([
            'created_at' => now()->subDays(100),
            'updated_at' => now()->subDays(100),
        ]);
        $conversation->forceFill(['updated_at' => now()->subDays(100)])->saveQuietly();

        $this->artisan('geoflow:prune-ai-workspace', ['--days' => 90])->assertSuccessful();

        self::assertFalse(AiConversationMessage::query()->whereKey($message->id)->exists());
        self::assertSame('已清理会话', $conversation->fresh()->title);
    }
}
