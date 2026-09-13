<?php

namespace Tests\Feature;

use App\Models\Admin;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class PwaInstallTest extends TestCase
{
    use RefreshDatabase;

    public function test_manifest_and_service_worker_define_a_safe_installable_workspace(): void
    {
        $manifest = json_decode(
            (string) file_get_contents(public_path('manifest.webmanifest')),
            true,
            flags: JSON_THROW_ON_ERROR,
        );

        self::assertSame('./', $manifest['id']);
        self::assertSame('app', $manifest['start_url']);
        self::assertSame('./', $manifest['scope']);
        self::assertSame('standalone', $manifest['display']);
        self::assertSame('GEOFlow', $manifest['name']);
        self::assertContains('192x192', array_column($manifest['icons'], 'sizes'));
        self::assertContains('512x512', array_column($manifest['icons'], 'sizes'));
        self::assertContains('maskable', array_column($manifest['icons'], 'purpose'));

        foreach ([192, 512] as $size) {
            $path = public_path("icons/geoflow-app-{$size}.png");
            self::assertFileExists($path);
            self::assertSame([$size, $size], array_slice((array) getimagesize($path), 0, 2));
        }

        $maskableIcon = public_path('icons/geoflow-app-maskable-512.png');
        self::assertFileExists($maskableIcon);
        self::assertSame([512, 512], array_slice((array) getimagesize($maskableIcon), 0, 2));

        $serviceWorker = (string) file_get_contents(public_path('service-worker.js'));
        self::assertStringContainsString("self.addEventListener('install'", $serviceWorker);
        self::assertStringContainsString("self.addEventListener('activate'", $serviceWorker);
        self::assertStringContainsString("self.addEventListener('fetch'", $serviceWorker);
        self::assertStringContainsString("event.request.mode !== 'navigate'", $serviceWorker);
        self::assertStringContainsString('event.respondWith(fetch(event.request));', $serviceWorker);
        self::assertStringNotContainsString('caches.', $serviceWorker);
    }

    public function test_pwa_launch_route_opens_the_admin_workspace(): void
    {
        // /app 是历史 PWA 入口：现在恒定指向 React 后台外壳（/geo_admin），
        // 由前端自己处理登录，不再按服务端会话分流到 Blade 后台（后者暂留 /legacy-admin）。
        // Location 必须是相对地址，否则非默认端口（如 :18080）会在跳转时丢掉端口。
        $guest = $this->get(route('pwa.launch'));
        $guest->assertRedirect('/geo_admin');
        $this->assertSame('/geo_admin', $guest->headers->get('Location'));

        $admin = Admin::query()->create([
            'username' => 'pwa_launch_admin',
            'password' => 'secret-123',
            'email' => 'pwa-launch-admin@example.com',
            'display_name' => 'PWA Launch Admin',
            'role' => 'super_admin',
            'status' => 'active',
        ]);

        $this->actingAs($admin, 'admin')
            ->get(route('pwa.launch'))
            ->assertRedirect('/geo_admin');
    }

    public function test_primary_site_and_admin_pages_advertise_the_pwa(): void
    {
        // 旧 Blade 管理后台的 admin.login / admin.dashboard 页面已随后台退役删除；
        // 现在后台外壳是 nginx 直出的 React 静态站点 `/geo_admin`，不经过 Laravel
        // 路由，PHP 测试面里没有等价页面可断言。仍然可测的只有 Laravel 前台页面。
        $this->get(route('site.home'))
            ->assertOk()
            ->assertSee('rel="manifest"', false)
            ->assertSee('/manifest.webmanifest', false)
            ->assertSee('/icons/geoflow-app-192.png', false);
    }
}
