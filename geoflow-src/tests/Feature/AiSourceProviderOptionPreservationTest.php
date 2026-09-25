<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\AiSourceProvider;
use App\Support\GeoFlow\ApiKeyCrypto;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * 「保存只覆盖传上来的键」——来源 Provider 的检索选项不能被静默重置。
 *
 * 背景（2026-09-25 修）：后台面板只渲染了 `count` 一项，保存时也只回传
 * `name/endpoint_url/daily_limit/count/status`；而后端 `providerAttributes()` 对缺失键
 * 一律填默认 —— 于是每次「保存」都会把 `need_content` 抹成 **false**（可见度检索请求
 * 就不再要正文，二次分析的判断质量静默下降）、把 `sites`/`block_hosts`/`auth_info_level`
 * 清空。这些字段在界面上没有任何编辑入口，一旦被抹掉只能用裸 API 改回来。
 */
final class AiSourceProviderOptionPreservationTest extends TestCase
{
    use RefreshDatabase;

    public function test_updating_a_provider_keeps_options_it_did_not_send(): void
    {
        $provider = $this->provider();

        // 旧版面板保存时实际发出的载荷。
        $this->withToken($this->token())
            ->withHeader('X-Idempotency-Key', 'provider-options-1')
            ->patchJson('/api/v1/source-providers/'.$provider->id, [
                'name' => 'System Search',
                'endpoint_url' => 'https://open.feedcoopapi.com/search_api/web_search',
                'daily_limit' => 50,
                'count' => 12,
                'status' => 'active',
            ])
            ->assertOk();

        $metadata = $provider->fresh()->metadata_json;
        $this->assertTrue((bool) ($metadata['need_content'] ?? false), 'need_content 被静默重置（可见度检索将不再取正文）');
        $this->assertTrue((bool) ($metadata['need_summary'] ?? false), 'need_summary 被静默重置');
        $this->assertSame(['news.example.com'], $metadata['sites'] ?? null, 'sites 被清空');
        $this->assertSame(['spam.example.com'], $metadata['block_hosts'] ?? null, 'block_hosts 被清空');
        $this->assertSame('high', $metadata['auth_info_level'] ?? null);
        $this->assertSame(50, (int) $provider->fresh()->daily_limit);
    }

    public function test_explicitly_sent_values_still_win(): void
    {
        $provider = $this->provider();

        // 显式传了就要生效：关掉取正文、清空站点、改结果数与额度。
        $this->withToken($this->token())
            ->withHeader('X-Idempotency-Key', 'provider-options-2')
            ->patchJson('/api/v1/source-providers/'.$provider->id, [
                'name' => 'System Search',
                'endpoint_url' => 'https://open.feedcoopapi.com/search_api/web_search',
                'daily_limit' => 10,
                'count' => 5,
                'status' => 'active',
                'need_content' => false,
                'need_summary' => false,
                'sites' => '',
                'block_hosts' => 'other.example.com',
            ])
            ->assertOk();

        $metadata = $provider->fresh()->metadata_json;
        $this->assertFalse((bool) $metadata['need_content']);
        $this->assertSame([], $metadata['sites']);
        $this->assertSame(['other.example.com'], $metadata['block_hosts']);
        $this->assertSame(5, (int) $metadata['count']);
        $this->assertSame(10, (int) $provider->fresh()->daily_limit);
    }

    private function provider(): AiSourceProvider
    {
        return AiSourceProvider::query()->create([
            'name' => 'System Search',
            'provider_key' => AiSourceProvider::PROVIDER_DOUBAO_SEARCH_CUSTOM,
            'endpoint_url' => 'https://open.feedcoopapi.com/search_api/web_search',
            'api_key' => app(ApiKeyCrypto::class)->encrypt('provider-secret'),
            'status' => 'active',
            'daily_limit' => 50,
            'metadata_json' => [
                'count' => 12,
                'search_type' => 'web',
                'need_summary' => true,
                'need_content' => true,
                'need_url' => true,
                'content_formats' => 'Markdown',
                'auth_info_level' => 'high',
                'sites' => ['news.example.com'],
                'block_hosts' => ['spam.example.com'],
            ],
        ]);
    }

    private function token(): string
    {
        return $this->admin()->createToken('api', ['models:read', 'models:write'])->plainTextToken;
    }

    private function admin(): Admin
    {
        return Admin::query()->firstOrCreate(
            ['username' => 'provider_options_super'],
            [
                'password' => 'Password123!',
                'email' => 'provider_options_super@example.test',
                'display_name' => 'provider_options_super',
                'role' => 'super_admin',
                'status' => 'active',
            ],
        );
    }
}
