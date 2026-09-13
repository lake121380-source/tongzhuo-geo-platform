<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Services\BrowserOperations\DeviceAuthorizationService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

final class BrowserDeviceAuthorizationController extends BaseApiController
{
    public function store(Request $request, DeviceAuthorizationService $authorizations): JsonResponse
    {
        $this->ensureTrustedInstance($request);
        $clientName = trim((string) $request->input('client_name', '桐灼GEO Chrome'));
        if ($clientName === '' || mb_strlen($clientName) > 80) {
            throw new ApiException('validation_failed', '客户端名称格式无效', 422);
        }

        $authorization = $authorizations->create($clientName);
        // 2026-09-12 退役改指：原先指向旧后台的 `admin.manual-publications.browser-connect.show`，
        // 那条 Blade 路由已删除——`route()` 会抛 `RouteNotFoundException`，整个设备授权接口直接 500，
        // 插件的配对流程走不通。现在指向 React 后台的人工发布页签（该页签里有配对审批面板，
        // 面板会读走 `user_code` 并自动查询，所以 `verification_uri_complete` 仍然是一键可用的）。
        $verificationUri = url('/geo_admin').'?tab=manual-publications';
        $authorization['verification_uri'] = $verificationUri;
        $authorization['verification_uri_complete'] = $verificationUri.'&'.http_build_query([
            'user_code' => $authorization['user_code'],
        ]);

        return $this->success($request, $authorization);
    }

    public function token(Request $request, DeviceAuthorizationService $authorizations): JsonResponse
    {
        $this->ensureTrustedInstance($request);
        $deviceCode = trim((string) $request->input('device_code'));
        if ($deviceCode === '' || strlen($deviceCode) > 128) {
            throw new ApiException('validation_failed', '设备码格式无效', 422);
        }

        return $this->success($request, $authorizations->exchange(
            $deviceCode,
            (string) $request->attributes->get('browser_client_version'),
        ));
    }

    private function ensureTrustedInstance(Request $request): void
    {
        $host = strtolower($request->getHost());
        if (! $request->isSecure() && ! in_array($host, ['localhost', '127.0.0.1', '::1'], true)) {
            throw new ApiException('insecure_instance', '远程 桐灼GEO 实例必须使用 HTTPS', 400);
        }
    }
}
