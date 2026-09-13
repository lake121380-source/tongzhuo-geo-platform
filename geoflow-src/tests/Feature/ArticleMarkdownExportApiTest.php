<?php

namespace Tests\Feature;

use App\Services\GeoFlow\ArticleMarkdownExportService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * markdown 导出**准备接口**的请求体大小守卫。
 *
 * 2026-09-12 退役改指向时补的：这条守卫原先守的是旧 Blade 后台的
 * `<admin 前缀>/articles/batch/export-markdown/prepare`，而 React 客户端走的是
 * `/api/v1/articles/markdown-export/prepare`——**路径形状不同，原先两者都不匹配**，
 * 也就是这条新接口此前只有全局 64m 限制。旧后台退役后若不同步改指向，
 * 这层保护就会静默变成空守（旧路径没了、新路径也没被守），所以补上这条测试锁住它。
 */
class ArticleMarkdownExportApiTest extends TestCase
{
    use RefreshDatabase;

    /**
     * 守卫必须在**鉴权之前**生效：未带 token 也应拿到 413，而不是 401。
     * 这正是「在 PHP 解析请求体之前就限流」这条防护性质的可测形式。
     */
    public function test_prepare_body_limit_guards_the_new_api_path_before_auth(): void
    {
        $this->withServerVariables([
            'CONTENT_LENGTH' => (string) (ArticleMarkdownExportService::MAX_PREPARE_REQUEST_BYTES + 1),
        ])->postJson(
            '/api/v1/articles/markdown-export/prepare',
            ['article_ids' => [1]],
        )
            ->assertStatus(413)
            ->assertJsonPath('code', 'article_export_request_too_large');
    }

    /** 没超限时不该被这条守卫拦住——它只做大小判断，不接管鉴权。 */
    public function test_prepare_body_limit_does_not_intercept_requests_within_the_limit(): void
    {
        $this->postJson('/api/v1/articles/markdown-export/prepare', ['article_ids' => [1]])
            ->assertUnauthorized();
    }
}
