<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Route;
use Laravel\Reverb\Application;
use Laravel\Reverb\Connection;
use Laravel\Reverb\Contracts\WebSocketConnection;
use Laravel\Reverb\Protocols\Pusher\Exceptions\InvalidOrigin;
use Laravel\Reverb\Protocols\Pusher\Server;
use ReflectionClass;
use ReflectionMethod;
use Symfony\Component\HttpFoundation\Exception\SuspiciousOperationException;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;
use Tests\TestCase;

class TrustedProxyConfigurationTest extends TestCase
{
    use RefreshDatabase;

    /**
     * 旧后台登录页（`admin.login`）已随 Blade 后台退役，`route('admin.login')` 返回 null，
     * `$loginPath` 会退化成 `/`。这里改用**仍然存在**的公网站点首页来验证同一意图：
     * 可信代理下由 `route()` / `asset()` 生成的 URL 必须采用转发头里的
     * scheme / host / port / prefix，而不是回落到内网地址。
     *
     * 首页会渲染站点布局（含 route() 生成的站内链接与 asset() 生成的绝对资源地址），
     * 因此需要数据库准备（RefreshDatabase）才能渲染，与旧登录页的需求一致。
     */
    public function test_admin_login_urls_respect_forwarded_prefix_from_trusted_proxy(): void
    {
        config(['trustedproxy.proxies' => '*']);
        config(['session.driver' => 'array']);
        config(['geoflow.hosted_sites.primary_hosts' => ['geo.example.com']]);

        $expectedHomeUrl = 'https://geo.example.com/docs';

        $this->get('/', [
            'HTTP_X_FORWARDED_PROTO' => 'https',
            'HTTP_X_FORWARDED_HOST' => 'geo.example.com',
            'HTTP_X_FORWARDED_PREFIX' => '/docs',
        ])
            ->assertOk()
            ->assertSee('href="'.$expectedHomeUrl.'"', false)
            // 样板资源换成仍在渲染的 lucide（原样板 js/tailwindcss.play-cdn.js 已随
            // 前台 Tailwind 改为构建期产物而删除，2026-09-16）。这里验证的是**代理头下
            // 资源 URL 的主机/前缀拼接**，与具体是哪个资源无关。
            ->assertSee('src="https://geo.example.com/docs/js/lucide.min.js"', false);
    }

    public function test_trusted_public_scheme_and_port_generate_canonical_https_urls(): void
    {
        config(['trustedproxy.proxies' => '*']);
        config(['session.driver' => 'array']);
        config(['geoflow.hosted_sites.primary_hosts' => ['geo.example.com']]);

        $assetPath = '/js/lucide.min.js';

        $this->get('/', [
            'HTTP_X_FORWARDED_PROTO' => 'https',
            'HTTP_X_FORWARDED_HOST' => 'geo.example.com',
            'HTTP_X_FORWARDED_PORT' => '443',
        ])
            ->assertOk()
            ->assertSee('src="https://geo.example.com'.$assetPath.'"', false)
            ->assertDontSee('https://geo.example.com:80', false);

        $this->get('/', [
            'HTTP_X_FORWARDED_PROTO' => 'https',
            'HTTP_X_FORWARDED_HOST' => 'geo.example.com',
            'HTTP_X_FORWARDED_PORT' => '8443',
        ])->assertSee('src="https://geo.example.com:8443'.$assetPath.'"', false);
    }

    public function test_wrapped_untrusted_host_exception_is_a_quiet_api_not_found(): void
    {
        config(['geoflow.hosted_sites.primary_hosts' => ['primary.test']]);
        Log::spy();
        Route::get('/api/_wrapped-host-rejection', static function (): never {
            throw new BadRequestHttpException(
                'Untrusted Host',
                new SuspiciousOperationException('Untrusted Host')
            );
        });

        $this->getJson('http://primary.test/api/_wrapped-host-rejection')
            ->assertNotFound()
            ->assertJsonPath('error.code', 'not_found');
        Log::shouldNotHaveReceived('error');
    }

    public function test_wrapped_untrusted_host_exception_is_a_quiet_web_not_found(): void
    {
        config(['geoflow.hosted_sites.primary_hosts' => ['localhost']]);
        Log::spy();
        Route::get('/_wrapped-host-rejection', static function (): never {
            throw new BadRequestHttpException(
                'Untrusted Host',
                new SuspiciousOperationException('Untrusted Host')
            );
        });

        $this->get('http://localhost/_wrapped-host-rejection')
            ->assertNotFound()
            ->assertHeader('X-Robots-Tag', 'noindex, nofollow');
        Log::shouldNotHaveReceived('error');
    }

    public function test_reverb_allowed_origins_are_normalized_to_hostnames(): void
    {
        foreach ((array) config('reverb.apps.apps.0.allowed_origins') as $origin) {
            $this->assertStringNotContainsString('://', (string) $origin);
            $this->assertStringNotContainsString('/', (string) $origin);
        }
    }

    public function test_reverb_origin_gate_accepts_the_primary_host_and_rejects_a_hosted_site(): void
    {
        $application = new Application(
            'app-id',
            'app-key',
            'app-secret',
            60,
            30,
            ['geo.example.com'],
            10_000,
        );
        $socket = new class implements WebSocketConnection
        {
            public function id(): int|string
            {
                return 1;
            }

            public function send(mixed $message): void {}

            public function close(mixed $message = null): void {}
        };
        $server = (new ReflectionClass(Server::class))->newInstanceWithoutConstructor();
        $verifyOrigin = new ReflectionMethod(Server::class, 'verifyOrigin');
        $verifyOrigin->invoke($server, new Connection($socket, $application, 'https://geo.example.com'));
        $this->assertTrue(true);

        $this->expectException(InvalidOrigin::class);
        $verifyOrigin->invoke($server, new Connection($socket, $application, 'https://alpha.sites.example.com'));
    }
}
