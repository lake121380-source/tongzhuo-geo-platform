<?php

namespace Tests\Feature;

use App\Models\Admin;
use App\Models\AiSourceProvider;
use App\Support\GeoFlow\ApiKeyCrypto;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * `POST source-providers/{provider}/test` —— 来源 Provider 的真实出站探活。
 *
 * 这是运营方**唯一**能在跑可见度之前确认搜索 Provider 还能用的手段（旧后台的「测试连接」
 * 按钮）。它同时是一次真实出站 + 一次额度记账，所以这里锁的不只是「返回了 source_count」：
 * ① 成功要真的把额度记上（used_today / total_used）；
 * ② 失败要收敛成固定的错误码，**不能把上游响应体、密钥或 URL 漏进响应**；
 * ③ 幂等键要真的挡住重复扣费；
 * ④ 超管边界保留。
 */
final class AiSourceProviderProbeApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_probes_the_provider_and_records_the_usage(): void
    {
        Http::fake([
            'https://open.feedcoopapi.com/search_api/web_search' => Http::response([
                'LogId' => 'log_test',
                'Result' => [
                    'WebResults' => [[
                        'Title' => 'GEOFlow Source',
                        'Url' => 'https://example.com/geoflow',
                        'Snippet' => 'GEOFlow source result',
                    ]],
                ],
            ]),
        ]);
        $provider = $this->provider();

        $response = $this->withToken($this->token())
            ->withHeader('X-Idempotency-Key', 'probe-1')
            ->postJson('/api/v1/source-providers/'.$provider->id.'/test', ['query' => 'GEOFlow'])
            ->assertOk()
            ->assertJsonPath('data.source_count', 1);

        $this->assertIsInt($response->json('data.latency_ms'));
        // 探活是真的花了额度的一次调用，账必须记上。
        $provider->refresh();
        $this->assertSame(1, (int) $provider->used_today);
        $this->assertSame(1, (int) $provider->total_used);
    }

    public function test_it_uses_the_default_query_when_none_is_given(): void
    {
        Http::fake([
            'https://open.feedcoopapi.com/search_api/web_search' => Http::response([
                'LogId' => 'log_default',
                'Result' => ['WebResults' => []],
            ]),
        ]);
        $provider = $this->provider();

        $this->withToken($this->token())
            ->withHeader('X-Idempotency-Key', 'probe-default-query')
            ->postJson('/api/v1/source-providers/'.$provider->id.'/test')
            ->assertOk()
            ->assertJsonPath('data.source_count', 0);

        // 留空不等于「用一个空串去搜」——与旧后台一样回落到默认词。
        Http::assertSent(fn ($request): bool => str_contains($request->url(), 'web_search'));
    }

    public function test_a_failing_provider_reports_a_stable_code_without_leaking_details(): void
    {
        Http::fake([
            'https://open.feedcoopapi.com/search_api/web_search' => Http::response('Provider unavailable', 503),
        ]);
        $provider = $this->provider();

        $response = $this->withToken($this->token())
            ->withHeader('X-Idempotency-Key', 'probe-fail')
            ->postJson('/api/v1/source-providers/'.$provider->id.'/test')
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'ai_model_unavailable');

        $response
            ->assertDontSee('provider-secret', false)
            ->assertDontSee('Provider unavailable', false)
            ->assertDontSee('feedcoopapi.com', false);
    }

    public function test_a_regular_admin_cannot_probe(): void
    {
        Http::fake();
        $provider = $this->provider();
        $ordinary = $this->admin('probe_ordinary', 'admin');

        // 与同组其它 source-providers 端点同一个边界与同一个码（控制器前置的
        // superAdmin() 检查），不是探活服务里那条「请求飞行途中被降权」的码。
        $this->withToken($this->tokenFor($ordinary))
            ->withHeader('X-Idempotency-Key', 'probe-forbidden')
            ->postJson('/api/v1/source-providers/'.$provider->id.'/test')
            ->assertStatus(403)
            ->assertJsonPath('error.code', 'forbidden');

        Http::assertNothingSent();
        $this->assertSame(0, (int) $provider->fresh()->used_today);
    }

    public function test_a_replayed_key_does_not_probe_or_charge_twice(): void
    {
        Http::fake([
            'https://open.feedcoopapi.com/search_api/web_search' => Http::response([
                'LogId' => 'log_replay',
                'Result' => ['WebResults' => []],
            ]),
        ]);
        $provider = $this->provider();
        // 同一个 token：幂等指纹绑定了 token，换一个 token 就是另一个幂等域。
        $token = $this->token();

        foreach ([1, 2] as $attempt) {
            $this->withToken($token)
                ->withHeader('X-Idempotency-Key', 'probe-replay')
                ->postJson('/api/v1/source-providers/'.$provider->id.'/test')
                ->assertOk();
        }

        // 回放命中缓存，不会真的再发一次请求、也不会再扣一次额度。
        Http::assertSentCount(1);
        $this->assertSame(1, (int) $provider->fresh()->used_today);
    }

    public function test_writes_require_an_idempotency_key(): void
    {
        Http::fake();
        $provider = $this->provider();

        $this->withToken($this->token())
            ->postJson('/api/v1/source-providers/'.$provider->id.'/test')
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'idempotency_key_required');

        Http::assertNothingSent();
    }

    public function test_it_reports_a_missing_provider(): void
    {
        Http::fake();

        $this->withToken($this->token())
            ->withHeader('X-Idempotency-Key', 'probe-404')
            ->postJson('/api/v1/source-providers/99999/test')
            ->assertStatus(404)
            ->assertJsonPath('error.code', 'source_provider_not_found');
    }

    private function token(): string
    {
        return $this->tokenFor($this->admin('probe_super', 'super_admin'));
    }

    private function tokenFor(Admin $admin): string
    {
        return $admin->createToken('api', ['models:read', 'models:write'])->plainTextToken;
    }

    private function admin(string $username, string $role): Admin
    {
        return Admin::query()->firstOrCreate(
            ['username' => $username],
            [
                'password' => 'Password123!',
                'email' => $username.'@example.test',
                'display_name' => $username,
                'role' => $role,
                'status' => 'active',
            ],
        );
    }

    private function provider(): AiSourceProvider
    {
        return AiSourceProvider::query()->create([
            'name' => 'System Search',
            'provider_key' => AiSourceProvider::PROVIDER_DOUBAO_SEARCH_CUSTOM,
            'endpoint_url' => 'https://open.feedcoopapi.com/search_api/web_search',
            'api_key' => app(ApiKeyCrypto::class)->encrypt('provider-secret'),
            'status' => 'active',
        ]);
    }
}
