<?php

namespace Tests\Unit\GeoFlowCli;

use App\Console\GeoFlowCli\CommandSpec;
use App\Console\GeoFlowCli\OperationRegistry;
use Illuminate\Routing\Route;
use Illuminate\Support\Facades\Route as RouteFacade;
use PHPUnit\Framework\Attributes\Test;
use Tests\TestCase;

class OperationRegistryTest extends TestCase
{
    #[Test]
    public function every_cli_api_route_has_an_operation_and_browser_routes_remain_separate(): void
    {
        $v1Routes = collect(RouteFacade::getRoutes()->getRoutes())
            ->filter(fn (Route $route): bool => str_starts_with($route->uri(), 'api/v1/'))
            ->values();
        $signature = function (Route $route): string {
            $method = collect($route->methods())->first(fn (string $method): bool => $method !== 'HEAD');

            return $method.' '.substr($route->uri(), strlen('api/v1/'));
        };
        // 插件协议路由：浏览器插件自己调用的那批。按**控制器**判定，不按 URI 前缀——
        // `api/v1/manual-publications` 这个命名空间里大部分是后台自己的路由
        // （store/update/transition/export/settings…），按前缀匹配会把它们误判成插件侧，
        // 于是「新增后台路由」会表现成「插件路由变多」，守卫就废了。
        $browserRoutes = $v1Routes->filter(function (Route $route): bool {
            if (str_starts_with($route->uri(), 'api/v1/browser-operations')) {
                return true;
            }

            return str_contains((string) $route->getActionName(), 'BrowserManualPublicationController');
        });

        // 不能空：否则下面的「不得进入 CLI 矩阵」会变成一条永远通过的空断言。
        $this->assertGreaterThanOrEqual(10, $browserRoutes->count(), '插件协议路由集合意外变空，守卫会失去意义');
        $this->assertCount(36, OperationRegistry::routeSignatures());

        // 真正的方向是「注册表 → 路由」：CLI 公开的每条路由都必须真实存在。
        // 反向不成立——api/v1 下有 200+ 条路由（含仅 Web UI 使用、仅浏览器插件使用的部分），
        // 只有一部分作为 CLI 命令公开，所以不再断言两侧精确相等。
        $v1Signatures = $v1Routes->map($signature)->sort()->values()->all();
        foreach (OperationRegistry::routeSignatures() as $registrySignature) {
            $this->assertContains($registrySignature, $v1Signatures, 'CLI 注册表引用了不存在的 api/v1 路由：'.$registrySignature);
        }

        // 浏览器插件路由必须与 CLI 命令矩阵保持分离。
        foreach ($browserRoutes as $route) {
            $this->assertNotContains($signature($route), OperationRegistry::routeSignatures(), '浏览器插件路由不应进入 CLI 命令矩阵');
        }
    }

    #[Test]
    public function image_upload_reuses_the_item_create_route(): void
    {
        $create = OperationRegistry::get('material.item-create');
        $upload = OperationRegistry::get('material.item-upload');

        $this->assertSame($create['method'], $upload['method']);
        $this->assertSame($create['path'], $upload['path']);
    }

    #[Test]
    public function delete_operations_never_support_idempotency_keys(): void
    {
        foreach (OperationRegistry::all() as $operation) {
            if ($operation['method'] === 'DELETE') {
                $this->assertFalse($operation['idempotent'], $operation['name']);
            }
        }
    }

    #[Test]
    public function command_specs_and_api_operations_are_bidirectionally_reachable(): void
    {
        $registryOperations = array_keys(OperationRegistry::all());
        sort($registryOperations);
        $specOperations = CommandSpec::apiOperations();

        $this->assertSame($registryOperations, $specOperations);
    }
}
