<?php

namespace Tests\Feature;

use App\Models\Admin;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\App;
use RecursiveDirectoryIterator;
use RecursiveIteratorIterator;
use SplFileInfo;
use Tests\TestCase;

class AdminActionDialogTest extends TestCase
{
    use RefreshDatabase;

    public function test_structured_notice_keeps_only_safe_internal_action_urls(): void
    {
        $unsafe = $this->withSession([
            'admin_action_notice' => [
                'tone' => 'success',
                'title' => 'Done',
                'message' => 'Updated',
                'action_label' => 'Open',
                'action_url' => 'https://example.com/redirect',
            ],
        ])->view('components.admin.action-dialog');

        $unsafe->assertDontSee('https://example.com/redirect', false);

        $backslashUnsafe = $this->withSession([
            'admin_action_notice' => [
                'tone' => 'success',
                'title' => 'Done',
                'message' => 'Updated',
                'action_label' => 'Open',
                'action_url' => '/\\evil.test',
            ],
        ])->view('components.admin.action-dialog');

        $backslashUnsafe->assertDontSee('/\\evil.test', false);

        $safe = $this->withSession([
            'admin_action_notice' => [
                'tone' => 'success',
                'title' => 'Done',
                'message' => 'Updated',
                'action_label' => 'Open',
                'action_url' => '/geo_admin/tasks',
            ],
        ])->view('components.admin.action-dialog');

        $safe->assertSee('/geo_admin/tasks', false);
    }

    public function test_structured_notice_is_safe_inside_the_json_script_element(): void
    {
        $payload = '</script><script>window.noticeInjected=true</script>';

        $view = $this->withSession([
            'admin_action_notice' => [
                'tone' => 'error',
                'title' => 'Failed',
                'message' => $payload,
            ],
        ])->view('components.admin.action-dialog');

        $view->assertDontSee($payload, false);
        $view->assertSee('\\u003C/script\\u003E', false);
    }

    public function test_dialog_common_copy_exists_in_all_supported_locales(): void
    {
        foreach (['zh_CN', 'en', 'ja', 'es', 'ru', 'pt_BR'] as $locale) {
            App::setLocale($locale);
            foreach ([
                'cancel', 'close', 'confirm', 'success_title', 'error_title', 'error_guidance', 'target',
                'hosted_site.activate_title', 'hosted_site.pause_title', 'hosted_site.maintenance_title',
                'article_ai_optimization.start_title', 'article_ai_optimization.start_message',
                'article_ai_optimization.apply_title', 'article_ai_optimization.apply_message',
                'article_ai_optimization.cancel_title', 'article_ai_optimization.discard_title',
                'article_ai_optimization.rollback_title', 'article_ai_optimization.rollback_message',
                'article_ai_quality.run_title', 'article_ai_quality.run_message',
                'article_ai_quality.override_title', 'article_ai_quality.override_message',
            ] as $key) {
                self::assertNotSame('admin.action_dialog.'.$key, __('admin.action_dialog.'.$key), $locale.': '.$key);
            }
        }
    }

    public function test_admin_business_sources_do_not_use_native_browser_dialogs(): void
    {
        // 2026-09-12：Blade 后台退役，`resources/views/admin` 整个目录已删除，
        // 继续把它当扫描根会让 RecursiveDirectoryIterator 直接抛异常（而不是断言失败）。
        // 剩下的两个根目录仍然覆盖后台业务源码，扫描与断言口径不变。
        $roots = [
            resource_path('views/components/admin'),
            resource_path('js/admin'),
        ];
        $pattern = '/(?<![.\w])(?:window\.|globalThis\.)?(?:confirm|alert|prompt)\s*\(/u';
        $violations = [];
        $beforeUnloadCount = 0;

        foreach ($roots as $root) {
            $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root));
            foreach ($files as $file) {
                if (! $file instanceof SplFileInfo || ! $file->isFile()) {
                    continue;
                }
                if (! in_array($file->getExtension(), ['js', 'php'], true)) {
                    continue;
                }
                if ($file->getPathname() === resource_path('js/admin/action-dialog.js')) {
                    continue;
                }

                $source = (string) file_get_contents($file->getPathname());
                if (preg_match($pattern, $source) === 1) {
                    $violations[] = str_replace(base_path().'/', '', $file->getPathname());
                }
                $beforeUnloadCount += substr_count($source, "addEventListener('beforeunload'");
            }
        }

        self::assertSame([], $violations);
        self::assertSame(2, $beforeUnloadCount);
    }
}
