<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\KnowledgeMediaAsset;
use App\Services\Admin\SystemUpdateManualCommandService;
use App\Services\AiWorkspace\AdminHelpFeatureRegistry;
use App\Services\AiWorkspace\AdminHelpMediaSelector;
use App\Services\AiWorkspace\AiConversationRepository;
use App\Services\AiWorkspace\SystemKnowledgeBaseManager;
use App\Services\AiWorkspace\SystemKnowledgeMediaManager;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Foundation\Testing\LazilyRefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

final class AiWorkspaceKnowledgeMediaTest extends TestCase
{
    use LazilyRefreshDatabase;

    /**
     * 出厂媒体目录（resources/knowledge/ai-workspace/media/）已于 2026-09-13 清空——
     * 原先 24 张帮助截图拍的是已退役的旧后台，会误导 AI 工作台的用户。
     *
     * 但本文件守着的是「出厂媒体导入 / 就绪度门禁 / 主版本复核标记」这套**机制**，
     * 与具体张数无关。于是需要出厂媒体的用例自建夹具：把一份临时 manifest 与几张
     * 临时图片挂在一个临时 app 根下，再走与出厂完全相同的导入路径。
     * 由于 resource_path() 是写死的，这里用 setBasePath() 把根指过去——不改仓库里的任何文件，
     * 其余目录（database / storage / lang / vendor …）用符号链接回真实目录。
     */
    private ?string $bundledMediaRoot = null;

    private string $originalBasePath = '';

    protected function setUp(): void
    {
        parent::setUp();

        config()->set('geoflow.admin_ui_v3_enabled', true);
    }

    protected function tearDown(): void
    {
        if ($this->bundledMediaRoot !== null) {
            $this->app->setBasePath($this->originalBasePath);
            File::deleteDirectory($this->bundledMediaRoot);
            $this->bundledMediaRoot = null;
        }

        parent::tearDown();
    }

    public function test_bundled_media_manifest_imports_all_verified_assets_idempotently(): void
    {
        Queue::fake();
        Storage::fake('local');
        $this->useBundledMediaFixture();
        $manager = app(SystemKnowledgeMediaManager::class);

        $this->artisan('geoflow:sync-system-knowledge', [
            '--key' => 'ai_workspace_manual',
            '--media' => true,
        ])->expectsOutputToContain('2 imported')->assertSuccessful();
        $second = $manager->syncBundled();

        self::assertSame(['imported' => 0, 'updated' => 0, 'unchanged' => 2, 'total' => 2], $second);
        self::assertSame(2, KnowledgeMediaAsset::query()->where('is_active', true)->count());
        self::assertSame(2, KnowledgeMediaAsset::query()->distinct()->count('content_hash'));
        self::assertTrue(KnowledgeMediaAsset::query()->get()->every(
            fn (KnowledgeMediaAsset $asset): bool => $manager->isReadable($asset),
        ));

        $selected = app(AdminHelpMediaSelector::class)->select(
            $this->admin('bundled-media-reader', 'super_admin'),
            [[
                'knowledge_base_id' => app(SystemKnowledgeBaseManager::class)->binding()?->knowledge_base_id,
                'feature_id' => 'tasks',
                'section_path' => '任务管理与内容生产 > 创建与编辑流程',
            ]],
            'zh_CN',
        );
        self::assertCount(1, $selected);
        self::assertSame(
            'tasks.create.basics',
            KnowledgeMediaAsset::query()->findOrFail($selected[0]['id'])->asset_key,
        );
    }

    public function test_system_update_readiness_requires_every_bundled_media_identity(): void
    {
        Queue::fake();
        Storage::fake('local');
        $this->useBundledMediaFixture();
        $manager = app(SystemKnowledgeMediaManager::class);
        $knowledgeBase = app(SystemKnowledgeBaseManager::class)->sync()['knowledge_base'];
        $manager->syncBundled();
        $admin = $this->admin('readiness-owner', 'super_admin');
        $missing = KnowledgeMediaAsset::query()->where('asset_key', 'tasks.index')->firstOrFail();
        $manager->setActive($missing, $admin, false);
        $manager->replace(
            $knowledgeBase,
            $admin,
            $this->image('extra.png', $this->pngOne()),
            [...$this->metadata(), 'asset_key' => 'custom.extra'],
        );

        self::assertSame(2, KnowledgeMediaAsset::query()->where('is_active', true)->count());
        $pendingCommand = app(SystemUpdateManualCommandService::class)->manualCommands()[0];
        self::assertSame('pending', $pendingCommand['status']);
        self::assertSame(
            __('admin.system_updates.manual_commands.sync_system_knowledge_pending_desc'),
            $pendingCommand['status_description'],
        );

        $manager->setActive($missing, $admin, true);

        $completeCommand = app(SystemUpdateManualCommandService::class)->manualCommands()[0];
        self::assertSame('complete', $completeCommand['status']);
        self::assertSame(
            __('admin.system_updates.manual_commands.sync_system_knowledge_complete_desc'),
            $completeCommand['status_description'],
        );
    }

    public function test_system_update_readiness_rejects_stale_knowledge_and_media_content(): void
    {
        Queue::fake();
        Storage::fake('local');
        $this->useBundledMediaFixture();
        $knowledgeManager = app(SystemKnowledgeBaseManager::class);
        $mediaManager = app(SystemKnowledgeMediaManager::class);
        $binding = $knowledgeManager->sync()['binding'];
        $mediaManager->syncBundled();

        self::assertSame('complete', app(SystemUpdateManualCommandService::class)->manualCommands()[0]['status']);

        $binding->forceFill(['official_content_hash' => str_repeat('0', 64)])->save();
        self::assertSame('pending', app(SystemUpdateManualCommandService::class)->manualCommands()[0]['status']);

        $knowledgeManager->sync();
        $asset = KnowledgeMediaAsset::query()->where('asset_key', 'tasks.index')->firstOrFail();
        $asset->forceFill(['content_hash' => str_repeat('f', 64)])->save();

        self::assertSame('pending', app(SystemUpdateManualCommandService::class)->manualCommands()[0]['status']);
    }

    public function test_private_media_requires_login_and_keeps_inactive_versions_available_to_history(): void
    {
        config()->set('geoflow.admin_ui_v3_enabled', true);
        Queue::fake();
        Storage::fake('local');
        $knowledgeBase = app(SystemKnowledgeBaseManager::class)->sync()['knowledge_base'];
        $superAdmin = $this->admin('media-owner', 'super_admin');
        $asset = app(SystemKnowledgeMediaManager::class)->replace(
            $knowledgeBase,
            $superAdmin,
            $this->image('tasks.png', $this->pngOne()),
            $this->metadata(),
        );

        $this->get($this->mediaUri((int) $asset->getKey()))
            ->assertUnauthorized();

        self::assertTrue(app(SystemKnowledgeMediaManager::class)->isReadable($asset));
        self::assertTrue(app(AdminHelpFeatureRegistry::class)->canAccessPath($superAdmin, '/geo_admin?tab=tasks'));
        self::assertTrue($asset->knowledgeBase->isSystemManaged());

        $response = $this->withToken($this->workspaceToken($superAdmin))
            ->get($this->mediaUri((int) $asset->getKey()))
            ->assertOk()
            ->assertHeader('Content-Type', 'image/png')
            ->assertHeader('X-Content-Type-Options', 'nosniff')
            ->assertHeader('Cross-Origin-Resource-Policy', 'same-origin');
        $this->withToken($this->workspaceToken($superAdmin))
            ->withHeader('If-None-Match', (string) $response->headers->get('ETag'))
            ->get($this->mediaUri((int) $asset->getKey()))
            ->assertStatus(304);
        $this->withToken($this->workspaceToken($superAdmin))
            ->withHeader('If-None-Match', '')
            ->get($this->mediaUri((int) $asset->getKey(), '?variant=thumbnail'))
            ->assertOk()
            ->assertHeader('Content-Type', function_exists('imagewebp') ? 'image/webp' : 'image/png');

        app(SystemKnowledgeMediaManager::class)->setActive($asset, $superAdmin, false);
        $this->withToken($this->workspaceToken($superAdmin))
            ->withHeader('If-None-Match', '')
            ->get($this->mediaUri((int) $asset->getKey()))
            ->assertOk();
    }

    public function test_major_app_version_change_marks_bundled_media_for_review_until_admin_clears_it(): void
    {
        Queue::fake();
        Storage::fake('local');
        // 先把夹具里的 captured_app_version 落成当前版本，再把运行版本抬一个大版本，
        // 这样每张出厂图都会因「主版本不一致」被标记复核——与版本号具体是几无关。
        $this->useBundledMediaFixture();
        $capturedMajor = (int) strtok((string) config('geoflow.app_version'), '.');
        config()->set('geoflow.app_version', ($capturedMajor + 1).'.0.0');
        $knowledgeBase = app(SystemKnowledgeBaseManager::class)->sync()['knowledge_base'];
        $manager = app(SystemKnowledgeMediaManager::class);

        $manager->syncBundled();

        self::assertSame(2, KnowledgeMediaAsset::query()->where('needs_review', true)->count());
        $asset = KnowledgeMediaAsset::query()->firstOrFail();
        $superAdmin = $this->admin('media-reviewer', 'super_admin');
        $manager->updateMetadata($asset, $superAdmin, ['needs_review' => false]);
        self::assertFalse($asset->fresh()->needs_review);
    }

    public function test_replacement_creates_an_immutable_version_and_selector_returns_structured_media(): void
    {
        Queue::fake();
        Storage::fake('local');
        $knowledgeBase = app(SystemKnowledgeBaseManager::class)->sync()['knowledge_base'];
        $superAdmin = $this->admin('media-replacer', 'super_admin');
        $manager = app(SystemKnowledgeMediaManager::class);
        $first = $manager->replace(
            $knowledgeBase,
            $superAdmin,
            $this->image('tasks.png', $this->pngOne()),
            $this->metadata(),
        );
        $second = $manager->replace(
            $knowledgeBase,
            $superAdmin,
            $this->image('tasks-new.png', $this->pngTwo()),
            $this->metadata(),
        );

        self::assertSame(1, $first->asset_version);
        self::assertSame(2, $second->asset_version);
        self::assertSame($first->getKey(), $second->supersedes_id);
        self::assertFalse($first->fresh()->is_active);
        self::assertTrue($second->is_active);
        self::assertSame(2, KnowledgeMediaAsset::query()->count());

        $selected = app(AdminHelpMediaSelector::class)->select($superAdmin, [[
            'knowledge_base_id' => $knowledgeBase->getKey(),
            'feature_id' => 'tasks',
            'section_path' => '内容生产与任务 > 任务创建',
        ]], 'zh_CN');

        self::assertCount(1, $selected);
        self::assertSame($second->getKey(), $selected[0]['id']);
        self::assertSame(2, $selected[0]['version']);
        self::assertStringContainsString('/ai-workspace/media/', $selected[0]['url']);
        self::assertStringContainsString('variant=thumbnail', $selected[0]['thumbnail_url']);
        self::assertSame([], app(AdminHelpMediaSelector::class)->select($superAdmin, [[
            'knowledge_base_id' => $knowledgeBase->getKey(),
            'feature_id' => 'tasks',
            'section_path' => '任务创建',
        ]], 'en'));
        self::assertSame([], app(AdminHelpMediaSelector::class)->select($superAdmin, [[
            'knowledge_base_id' => $knowledgeBase->getKey(),
            'feature_id' => 'articles',
            'section_path' => '文章管理 > 文章审核',
        ]], 'zh_CN'));

        $manager->replace(
            $knowledgeBase,
            $superAdmin,
            $this->image('system-update.png', $this->pngOne()),
            [
                'asset_key' => 'system.updates',
                'section_key' => '系统更新',
                'tab_path' => '/geo_admin?tab=system-updates',
                'title' => '系统更新中心',
                'alt_text' => '系统更新中心页面',
                'keywords' => ['系统更新'],
                'locale' => 'zh_CN',
            ],
        );
        $regularAdmin = $this->admin('media-reader', 'admin');
        self::assertSame([], app(AdminHelpMediaSelector::class)->select($regularAdmin, [[
            'knowledge_base_id' => $knowledgeBase->getKey(),
            'feature_id' => 'system-updates',
            'section_path' => '系统更新',
        ]], 'zh_CN'));
    }

    public function test_media_selection_does_not_read_image_files_before_the_text_answer(): void
    {
        Queue::fake();
        Storage::fake('local');
        $knowledgeBase = app(SystemKnowledgeBaseManager::class)->sync()['knowledge_base'];
        $superAdmin = $this->admin('media-latency-reviewer', 'super_admin');
        $manager = app(SystemKnowledgeMediaManager::class);
        $asset = $manager->replace(
            $knowledgeBase,
            $superAdmin,
            $this->image('tasks.png', $this->pngOne()),
            $this->metadata(),
        );
        Storage::disk('local')->delete([$asset->storage_path, $asset->thumbnail_path]);

        $selected = app(AdminHelpMediaSelector::class)->select($superAdmin, [[
            'knowledge_base_id' => $knowledgeBase->getKey(),
            'feature_id' => 'tasks',
            'section_path' => '内容生产与任务 > 任务创建',
        ]], 'zh_CN');

        self::assertSame($asset->getKey(), $selected[0]['id']);
        $this->withToken($this->workspaceToken($superAdmin))
            ->get($this->mediaUri((int) $asset->getKey()))
            ->assertNotFound();
    }

    public function test_prune_keeps_media_referenced_by_live_history_and_removes_unreferenced_old_media(): void
    {
        Queue::fake();
        Storage::fake('local');
        $knowledgeBase = app(SystemKnowledgeBaseManager::class)->sync()['knowledge_base'];
        $superAdmin = $this->admin('media-pruner', 'super_admin');
        $manager = app(SystemKnowledgeMediaManager::class);
        $referenced = $manager->replace(
            $knowledgeBase,
            $superAdmin,
            $this->image('referenced.png', $this->pngOne()),
            $this->metadata(),
        );
        $unreferenced = $manager->replace(
            $knowledgeBase,
            $superAdmin,
            $this->image('unreferenced.png', $this->pngTwo()),
            ['asset_key' => 'tasks.create.unreferenced'] + $this->metadata(),
        );
        $manager->setActive($referenced, $superAdmin, false);
        $manager->setActive($unreferenced, $superAdmin, false);
        KnowledgeMediaAsset::query()->whereKey([$referenced->getKey(), $unreferenced->getKey()])->update([
            'created_at' => now()->subDays(100),
            'updated_at' => now()->subDays(100),
        ]);

        $conversation = app(AiConversationRepository::class)->create($superAdmin, '媒体历史');
        app(AiConversationRepository::class)->append($conversation, 'assistant', '带图回答', [
            'related_media' => [['id' => $referenced->getKey()]],
        ]);

        $this->artisan('geoflow:prune-ai-workspace', ['--days' => 90, '--dry-run' => true])
            ->expectsOutputToContain('1 inactive knowledge media assets are eligible')
            ->assertSuccessful();
        self::assertTrue(KnowledgeMediaAsset::query()->whereKey($unreferenced->getKey())->exists());

        $this->artisan('geoflow:prune-ai-workspace', ['--days' => 90])->assertSuccessful();

        self::assertTrue(KnowledgeMediaAsset::query()->whereKey($referenced->getKey())->exists());
        self::assertFalse(KnowledgeMediaAsset::query()->whereKey($unreferenced->getKey())->exists());
        Storage::disk('local')->assertExists((string) $referenced->storage_path);
        Storage::disk('local')->assertMissing((string) $unreferenced->storage_path);
        Storage::disk('local')->assertMissing((string) $unreferenced->thumbnail_path);
    }

    public function test_media_management_api_requires_protected_admin_and_writes_activity_logs(): void
    {
        Queue::fake();
        Storage::fake('local');
        if (! Schema::hasTable('admin_activity_logs')) {
            Schema::create('admin_activity_logs', function (Blueprint $table): void {
                $table->id();
                $table->unsignedBigInteger('admin_id');
                $table->string('admin_username');
                $table->string('admin_role');
                $table->string('action');
                $table->string('request_method');
                $table->string('page')->nullable();
                $table->string('target_type')->nullable();
                $table->unsignedBigInteger('target_id')->nullable();
                $table->string('ip_address')->nullable();
                $table->text('details')->nullable();
                $table->timestamps();
            });
        }
        $knowledgeBase = app(SystemKnowledgeBaseManager::class)->sync()['knowledge_base'];
        $regularAdmin = $this->admin('media-regular', 'admin');
        $superAdmin = $this->admin('media-super', 'super_admin');
        $payload = [
            'image' => $this->image('tasks.png', $this->pngOne()),
            ...$this->metadata(),
            'keywords' => '任务, 创建, 模型',
        ];

        // 系统知识库的媒体改动要受保护工作流权限——旧后台给 403，这里保持 403，
        // 不能因为管理器内部抛的是 RuntimeException 就被报成 422「操作失败」。
        $this->withToken($this->materialsToken($regularAdmin))
            ->post($this->knowledgeMediaUri((int) $knowledgeBase->getKey()), $payload)
            ->assertForbidden()
            ->assertJsonPath('error.code', 'protected_knowledge_read_only');

        $payload['image'] = $this->image('tasks.png', $this->pngOne());
        $this->withToken($this->materialsToken($superAdmin))
            ->post($this->knowledgeMediaUri((int) $knowledgeBase->getKey()), $payload)
            ->assertCreated();

        $asset = KnowledgeMediaAsset::query()->firstOrFail();
        $this->withToken($this->materialsToken($superAdmin))
            ->patchJson($this->knowledgeMediaUri((int) $knowledgeBase->getKey(), (int) $asset->getKey()), [
                'section_key' => '任务创建',
                'tab_path' => '/geo_admin?tab=tasks',
                'title' => '更新后的任务表单',
                'alt_text' => '更新后的任务创建配置表单',
                'caption' => '更新后的说明',
                'keywords' => '任务, 表单',
                'sort_order' => 9,
            ])->assertOk();

        $this->withToken($this->materialsToken($superAdmin))
            ->post($this->knowledgeMediaUri((int) $knowledgeBase->getKey(), (int) $asset->getKey(), '/replace'), [
                'image' => $this->image('tasks-new.png', $this->pngTwo()),
            ])->assertCreated();
        $replacement = KnowledgeMediaAsset::query()->latest('asset_version')->firstOrFail();

        $this->withToken($this->materialsToken($superAdmin))
            ->postJson($this->knowledgeMediaUri((int) $knowledgeBase->getKey(), (int) $replacement->getKey(), '/toggle'), ['active' => false])
            ->assertOk();

        self::assertSame('更新后的任务表单', $replacement->fresh()->title);
        self::assertFalse($replacement->fresh()->is_active);
        foreach ([
            'knowledge_base.media_imported',
            'knowledge_base.media_updated',
            'knowledge_base.media_replaced',
            'knowledge_base.media_status_changed',
        ] as $action) {
            $this->assertDatabaseHas('admin_activity_logs', ['action' => $action]);
        }

        // 旧后台这条断言打的是 Blade 详情页里的缩略图地址。React 后台的详情页改吃
        // `/api/v1/knowledge-bases/{id}`，缩略图地址由前端按媒体 id 拼（见 geoflowClient），
        // 所以这里断言 API 确实把该资产列了出来——链路的这一段是它负责的。
        $detail = $this->withToken($this->materialsToken($superAdmin))
            ->getJson('/api/v1/knowledge-bases/'.$knowledgeBase->getKey())
            ->assertOk();
        self::assertContains(
            (int) $replacement->getKey(),
            array_map('intval', array_column((array) $detail->json('data.media'), 'id')),
        );
    }

    public function test_enabling_a_historical_version_makes_it_the_only_active_asset_version(): void
    {
        Queue::fake();
        Storage::fake('local');
        $knowledgeBase = app(SystemKnowledgeBaseManager::class)->sync()['knowledge_base'];
        $superAdmin = $this->admin('media-version-owner', 'super_admin');
        $manager = app(SystemKnowledgeMediaManager::class);
        $first = $manager->replace(
            $knowledgeBase,
            $superAdmin,
            $this->image('first.png', $this->pngOne()),
            $this->metadata(),
        );
        $second = $manager->replace(
            $knowledgeBase,
            $superAdmin,
            $this->image('second.png', $this->pngTwo()),
            $this->metadata(),
        );

        $manager->setActive($first, $superAdmin, true);

        self::assertTrue($first->fresh()->is_active);
        self::assertFalse($second->fresh()->is_active);
        self::assertSame(1, KnowledgeMediaAsset::query()
            ->where('asset_key', $first->asset_key)
            ->where('locale', $first->locale)
            ->where('is_active', true)
            ->count());
    }

    public function test_regular_admin_cannot_read_media_for_a_protected_tab_entry(): void
    {
        Queue::fake();
        Storage::fake('local');
        $knowledgeBase = app(SystemKnowledgeBaseManager::class)->sync()['knowledge_base'];
        $superAdmin = $this->admin('protected-media-owner', 'super_admin');
        $regularAdmin = $this->admin('protected-media-reader', 'admin');
        $asset = app(SystemKnowledgeMediaManager::class)->replace(
            $knowledgeBase,
            $superAdmin,
            $this->image('url-import.png', $this->pngOne()),
            [
                ...$this->metadata(),
                'asset_key' => 'url-import.index',
                'section_key' => 'URL 导入',
                // 系统更新是 `protected` 条目——普通管理员既取不到图，也不该在列表里看到它。
                'tab_path' => '/geo_admin?tab=system-updates',
                'title' => 'URL 导入',
                'alt_text' => 'URL 导入管理页面',
            ],
        );

        $this->withToken($this->workspaceToken($regularAdmin))
            ->get($this->mediaUri((int) $asset->getKey()))
            ->assertNotFound();
        $detail = $this->withToken($this->materialsToken($regularAdmin))
            ->getJson('/api/v1/knowledge-bases/'.$knowledgeBase->getKey())
            ->assertOk();
        self::assertNotContains(
            (int) $asset->getKey(),
            array_map('intval', array_column((array) $detail->json('data.media'), 'id')),
        );

        $this->withToken($this->workspaceToken($superAdmin))
            ->get($this->mediaUri((int) $asset->getKey()))
            ->assertOk();
    }

    public function test_replacement_keeps_the_asset_identity_even_when_the_request_is_tampered(): void
    {
        Queue::fake();
        Storage::fake('local');
        $knowledgeBase = app(SystemKnowledgeBaseManager::class)->sync()['knowledge_base'];
        $superAdmin = $this->admin('media-identity-owner', 'super_admin');
        $asset = app(SystemKnowledgeMediaManager::class)->replace(
            $knowledgeBase,
            $superAdmin,
            $this->image('original.png', $this->pngOne()),
            $this->metadata(),
        );

        $this->withToken($this->materialsToken($superAdmin))
            ->post($this->knowledgeMediaUri((int) $knowledgeBase->getKey(), (int) $asset->getKey(), '/replace'), [
                'image' => $this->image('replacement.png', $this->pngTwo()),
                'asset_key' => 'system.updates',
                'locale' => 'zh_CN',
            ])->assertCreated();

        $replacement = KnowledgeMediaAsset::query()->orderByDesc('asset_version')->firstOrFail();
        self::assertSame($asset->asset_key, $replacement->asset_key);
        self::assertSame($asset->locale, $replacement->locale);
        self::assertSame($asset->getKey(), $replacement->supersedes_id);
    }

    /** @return array<string, mixed> */
    private function metadata(): array
    {
        return [
            'asset_key' => 'tasks.create.form',
            'section_key' => '任务创建',
            'tab_path' => '/geo_admin?tab=tasks',
            'title' => '任务创建表单',
            'alt_text' => '桐灼GEO 任务创建页的配置表单',
            'caption' => '在这里选择模型、标题库和知识库。',
            'keywords' => ['任务', '创建', '模型'],
            'locale' => 'zh_CN',
            'sort_order' => 1,
        ];
    }

    /**
     * 在临时 app 根下写一份临时帮助媒体 manifest + 几张临时图片，并把 base path 指过去，
     * 让 resource_path('knowledge/ai-workspace/media/...') 命中夹具，而不是（2026-09-13 已清空的）出厂目录。
     * 导入路径本身不变——仍是 syncBundled() / `geoflow:sync-system-knowledge --media`。
     */
    private function useBundledMediaFixture(): void
    {
        $basePath = $this->app->basePath();
        $root = rtrim(sys_get_temp_dir(), '/\\').'/geoflow-bundled-media-'.bin2hex(random_bytes(6));
        if (! is_dir($root) && ! mkdir($root, 0o777, true) && ! is_dir($root)) {
            self::fail('Unable to create the temporary bundled media root.');
        }

        // 除 resources 外的一切目录/文件链接回真实路径（database / storage / lang / vendor …），
        // 保证只有「出厂帮助媒体」这一处被替换，迁移、日志、翻译等行为不受影响。
        foreach (array_diff(scandir($basePath) ?: [], ['.', '..', 'resources']) as $entry) {
            @symlink($basePath.DIRECTORY_SEPARATOR.$entry, $root.DIRECTORY_SEPARATOR.$entry);
        }
        File::copyDirectory($basePath.'/resources', $root.'/resources');

        $mediaDir = $root.'/resources/knowledge/ai-workspace/media';
        File::ensureDirectoryExists($mediaDir);

        $manifest = [
            'manifest_version' => '1.0.0',
            'knowledge_key' => 'ai_workspace_manual',
            'captured_app_version' => (string) config('geoflow.app_version', '3.0.0'),
            'assets' => [],
        ];

        foreach ($this->bundledMediaAssets() as $asset) {
            $bytes = (string) $asset['bytes'];
            unset($asset['bytes']);
            File::put($mediaDir.'/'.$asset['file'], $bytes);
            $manifest['assets'][] = $asset + [
                'locale' => 'zh_CN',
                'content_hash' => 'sha256:'.hash('sha256', $bytes),
                'captured_at' => now()->toIso8601String(),
            ];
        }

        File::put(
            $mediaDir.'/manifest.json',
            json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
        );

        $this->originalBasePath = $basePath;
        $this->bundledMediaRoot = $root;
        $this->app->setBasePath($root);
    }

    /**
     * 夹具资产：都落在 `tasks` 页签、同一 section，够验证「导入幂等 / 就绪度门禁 / 主版本复核」三条机制即可。
     * sort_order 越大越靠后——`tasks.create.basics` 必须先于 `tasks.index` 被选中。
     *
     * @return list<array<string, mixed>>
     */
    private function bundledMediaAssets(): array
    {
        return [
            [
                'file' => 'tasks-create-basics.png',
                'asset_key' => 'tasks.create.basics',
                'section_key' => '任务管理与内容生产',
                'tab_path' => '/geo_admin?tab=tasks',
                'title' => '任务创建基础设置',
                'alt_text' => '任务创建页的基础设置表单',
                'caption' => '在这里填写任务的基础信息。',
                'keywords' => ['任务', '创建'],
                'sort_order' => 1,
                'bytes' => $this->pngOne(),
            ],
            [
                'file' => 'tasks-index.png',
                'asset_key' => 'tasks.index',
                'section_key' => '任务管理与内容生产',
                'tab_path' => '/geo_admin?tab=tasks',
                'title' => '任务列表页',
                'alt_text' => '任务管理列表页',
                'caption' => '在这里查看全部任务及其状态。',
                'keywords' => ['任务', '列表'],
                'sort_order' => 2,
                'bytes' => $this->pngTwo(),
            ],
        ];
    }

    /** AI 工作台的私有媒体走 Bearer token（旧后台是会话）。 */
    private function workspaceToken(Admin $admin): string
    {
        return $admin->createToken('media-reader', ['workspace:read'])->plainTextToken;
    }

    /** 媒体管理走 API v1 的 materials scope（旧后台是表单 POST + 重定向）。 */
    private function materialsToken(Admin $admin): string
    {
        return $admin->createToken('media-manager', ['materials:read', 'materials:write'])->plainTextToken;
    }

    private function mediaUri(int $assetId, string $query = ''): string
    {
        return '/api/v1/ai-workspace/media/'.$assetId.$query;
    }

    private function knowledgeMediaUri(int $knowledgeBaseId, ?int $assetId = null, string $suffix = ''): string
    {
        $uri = '/api/v1/knowledge-bases/'.$knowledgeBaseId.'/media';
        if ($assetId !== null) {
            $uri .= '/'.$assetId;
        }

        return $uri.$suffix;
    }

    private function image(string $name, string $bytes): UploadedFile
    {
        return UploadedFile::fake()->createWithContent($name, $bytes);
    }

    private function pngOne(): string
    {
        return (string) base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', true);
    }

    private function pngTwo(): string
    {
        return (string) base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==', true);
    }

    private function admin(string $username, string $role): Admin
    {
        return Admin::query()->create([
            'username' => $username,
            'password' => 'secret-123',
            'email' => $username.'@example.com',
            'display_name' => $username,
            'role' => $role,
            'status' => 'active',
        ]);
    }
}
