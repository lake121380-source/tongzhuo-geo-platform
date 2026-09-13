<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Models\DistributionChannel;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\DistributionSettingsSyncService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Validation\Rule;

/**
 * Bearer 版的「把站点设置同步到渠道前端」。
 *
 * 同步链路（租约、目标站点写入、审计日志、内容刷新入队）与前台体验预览/确认门禁
 * 全部由 {@see DistributionSettingsSyncService} 拥有——与旧 Blade 后台是同一份实现。
 * 这个控制器只做参数校验与 JSON 信封。
 */
final class DistributionSettingsSyncController extends BaseApiController
{
    public function __construct(
        private readonly DistributionSettingsSyncService $sync,
    ) {}

    /**
     * 同步预览：会同步哪些渠道、哪些需要运营方先确认前台体验风险。
     *
     * 与执行同步用的是同一个门禁（`requires_confirmation`），所以前端可以放心地
     * 「先预览、拿确认、再带 `frontend_sync_confirmed` 提交」。
     */
    public function preview(Request $request): JsonResponse
    {
        $this->superAdmin($request);
        $payload = $request->validate([
            'scope' => ['required', Rule::in(['single', 'all', 'selected'])],
            'channel_id' => ['nullable', 'integer', 'min:1'],
            'channel_ids' => ['nullable', 'array'],
            'channel_ids.*' => ['integer', 'min:1'],
        ]);

        $channels = $this->resolveChannels((string) $payload['scope'], $payload);

        return $this->success($request, [
            'scope' => (string) $payload['scope'],
            'report' => $this->sync->preview($channels),
        ]);
    }

    /** 把站点设置同步到单个渠道。 */
    public function syncAll(Request $request): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->superAdmin($request);
        $payload = $request->validate(['frontend_sync_confirmed' => ['sometimes', 'boolean']]);

        $channels = $this->sync->syncableChannels();
        if ($channels->isEmpty()) {
            throw new ApiException('no_syncable_channels', '当前没有可同步的渠道', 422);
        }
        $this->assertConfirmation($request, $channels, (bool) ($payload['frontend_sync_confirmed'] ?? false));

        return IdempotencyService::executeJson($request, 'POST /distribution/sync-settings/all', function () use ($request, $channels): JsonResponse {
            return $this->success($request, $this->sync->syncMany($channels));
        });
    }

    /** 把站点设置同步到指定的若干渠道。 */
    public function syncSelected(Request $request): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->superAdmin($request);
        $payload = $request->validate([
            'channel_ids' => ['required', 'array', 'min:1'],
            'channel_ids.*' => ['integer', 'min:1'],
            'frontend_sync_confirmed' => ['sometimes', 'boolean'],
        ]);

        $channels = $this->sync->syncableChannelsByIds($payload['channel_ids']);
        if ($channels->isEmpty()) {
            throw new ApiException('no_syncable_channels', '选中的渠道里没有可同步的', 422);
        }
        $this->assertConfirmation($request, $channels, (bool) ($payload['frontend_sync_confirmed'] ?? false));

        return IdempotencyService::executeJson($request, 'POST /distribution/sync-settings/selected', function () use ($request, $channels): JsonResponse {
            return $this->success($request, $this->sync->syncMany($channels));
        });
    }

    /** 刷新单个渠道的远端前端能力快照。 */
    public function refreshCapabilities(Request $request, int $channel): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->superAdmin($request);

        $row = DistributionChannel::query()->with('activeSecret')->whereKey($channel)->first();
        if (! $row instanceof DistributionChannel) {
            throw new ApiException('channel_not_found', '分发渠道不存在', 404);
        }
        $this->assertSyncable($row);

        return IdempotencyService::executeJson($request, 'POST /distribution/channels/{channel}/frontend-capabilities/refresh', function () use ($request, $row): JsonResponse {
            return $this->success($request, [
                'channel_id' => (int) $row->id,
                'capabilities' => $this->sync->refreshFrontendCapabilities($row),
            ]);
        });
    }

    /**
     * @param  array<string, mixed>  $payload
     * @return Collection<int, DistributionChannel>
     */
    private function resolveChannels(string $scope, array $payload)
    {
        if ($scope === 'single') {
            $row = DistributionChannel::query()
                ->with('activeSecret')
                ->whereKey((int) ($payload['channel_id'] ?? 0))
                ->first();
            if (! $row instanceof DistributionChannel) {
                throw new ApiException('channel_not_found', '分发渠道不存在', 404);
            }

            return collect([$row]);
        }

        if ($scope === 'selected') {
            $channels = $this->sync->syncableChannelsByIds($payload['channel_ids'] ?? []);
            if ($channels->isEmpty()) {
                throw new ApiException('no_syncable_channels', '选中的渠道里没有可同步的', 422);
            }

            return $channels;
        }

        $channels = $this->sync->syncableChannels();
        if ($channels->isEmpty()) {
            throw new ApiException('no_syncable_channels', '当前没有可同步的渠道', 422);
        }

        return $channels;
    }

    private function assertSyncable(DistributionChannel $channel): void
    {
        if ($channel->isHostedSite()) {
            throw new ApiException('channel_not_syncable', 'Hosted Site 渠道不需要同步站点设置', 422);
        }
        if ((string) $channel->status !== 'active') {
            throw new ApiException('channel_not_active', '渠道未启用，无法同步站点设置', 422);
        }
    }

    /**
     * 前台体验风险门禁：与旧后台一致——没有显式确认就打回，让运营方先看预览。
     *
     * @param  iterable<int, DistributionChannel>  $channels
     */
    private function assertConfirmation(Request $request, iterable $channels, bool $confirmed): void
    {
        if ($confirmed) {
            return;
        }
        if (! $this->sync->requiresConfirmation($channels)) {
            return;
        }

        throw new ApiException(
            'frontend_sync_confirmation_required',
            '同步前需要先确认前台体验风险，请先查看同步预览。',
            409,
            ['preview_endpoint' => '/api/v1/distribution/sync-settings/preview'],
        );
    }

    /**
     * 站点设置同步族保留旧后台的**超管边界**。
     *
     * 旧后台整个 `distribution` 路由组挂在 `admin.super` 下（`routes/web.php:239`），
     * 同域更早补齐的 rotate-secret / 删除 / 密钥查看也都保留了这一层；
     * 「把站点设置推到各渠道前端」改的是对外可见的站点表现，不该放宽给任意
     * 带 `distribution:write` 的管理员。
     */
    private function superAdmin(Request $request): Admin
    {
        $admin = $this->executionAdmin($request);
        if (! $admin->isSuperAdmin()) {
            throw new ApiException('forbidden', '只有超级管理员可以同步站点设置到渠道前端', 403, [
                'required_role' => 'super_admin',
            ]);
        }

        return $admin;
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }
}
