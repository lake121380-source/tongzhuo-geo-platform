<?php

namespace App\Services\GeoFlow;

use App\Http\Controllers\Admin\DistributionController;
use App\Http\Controllers\Api\V1\DistributionSettingsSyncController;
use App\Models\DistributionChannel;
use Illuminate\Support\Collection;
use Throwable;

/**
 * 把站点设置同步到渠道前端。
 *
 * 旧 Blade 后台（{@see DistributionController}）与
 * api/v1（{@see DistributionSettingsSyncController}）
 * 共用这一份实现：可同步渠道的判定、前台体验预览与「需要确认」门禁、
 * 同步执行（含渠道操作租约与审计日志）、以及同步后的内容刷新入队。
 */
final class DistributionSettingsSyncService
{
    public function __construct(
        private readonly DistributionOrchestrator $distributionOrchestrator,
        private readonly DistributionPublisherManager $publisherManager,
        private readonly FrontendExperienceInspector $frontendExperienceInspector,
        private readonly DistributionChannelOperationLeaseService $channelOperationLeaseService,
    ) {}

    /**
     * 可同步的渠道：启用中、且是（或未标注类型的）GEOFlow Agent。
     *
     * @return Collection<int, DistributionChannel>
     */
    public function syncableChannels(): Collection
    {
        return DistributionChannel::query()
            ->with('activeSecret')
            ->where('status', 'active')
            ->where(function ($query): void {
                $query->whereNull('channel_type')
                    ->orWhere('channel_type', 'geoflow_agent');
            })
            ->orderBy('id')
            ->get();
    }

    /** 把渠道 id 列表收敛成有效的、去重的、仍可同步的渠道。 */
    public function syncableChannelsByIds(iterable $channelIds): Collection
    {
        $ids = collect($channelIds)
            ->map(static fn ($id): int => (int) $id)
            ->filter(static fn (int $id): bool => $id > 0)
            ->unique()
            ->values();

        if ($ids->isEmpty()) {
            return collect();
        }

        return $this->syncableChannels()->whereIn('id', $ids->all())->values();
    }

    /**
     * 前台体验同步预览。
     *
     * @param  iterable<int, DistributionChannel>  $channels
     * @return array<string, mixed>
     */
    public function preview(iterable $channels): array
    {
        return $this->frontendExperienceInspector->syncPreviewForChannels($channels);
    }

    /**
     * 是否存在需要运营方先确认的前台体验风险。
     *
     * @param  iterable<int, DistributionChannel>  $channels
     */
    public function requiresConfirmation(iterable $channels): bool
    {
        return (bool) ($this->preview($channels)['requires_confirmation'] ?? false);
    }

    /**
     * 同步单个渠道：索取操作租约、写入目标站点、记审计日志，最后入队内容刷新。
     *
     * @return array{result:array<string,mixed>,refresh_count:int}
     */
    public function syncChannel(DistributionChannel $channel): array
    {
        $result = $this->channelOperationLeaseService->run(
            $channel,
            'site_settings_sync',
            function (DistributionChannel $lockedChannel): array {
                try {
                    $result = $this->publisherManager->forChannel($lockedChannel)->syncSiteSettings($lockedChannel);
                    $this->distributionOrchestrator->log(
                        'info',
                        '目标站点设置已同步',
                        (int) $lockedChannel->id,
                        null,
                        null,
                        [
                            'event' => 'site.settings.synced',
                            'remote_result' => $result,
                            'sync_summary' => $this->frontendExperienceInspector->syncSummary($lockedChannel),
                        ]
                    );

                    return $result;
                } catch (Throwable $e) {
                    $this->distributionOrchestrator->log(
                        'error',
                        '目标站点设置同步失败：'.$e->getMessage(),
                        (int) $lockedChannel->id,
                        null,
                        null,
                        ['event' => 'site.settings.sync_failed']
                    );

                    throw $e;
                }
            }
        );

        return [
            'result' => is_array($result) ? $result : [],
            'refresh_count' => $this->distributionOrchestrator->enqueueChannelContentRefresh($channel),
        ];
    }

    /**
     * 刷新远端渠道的前端能力快照。
     *
     * @return array<string, mixed>
     */
    public function refreshFrontendCapabilities(DistributionChannel $channel): array
    {
        $result = $this->channelOperationLeaseService->run(
            $channel,
            'frontend_capabilities_refresh',
            fn (DistributionChannel $lockedChannel): array => $this->frontendExperienceInspector
                ->refreshRemoteCapabilities($lockedChannel),
        );

        return is_array($result) ? $result : [];
    }

    /**
     * 批量同步：单个渠道失败不影响其余渠道，失败数如实回传。
     *
     * @param  iterable<int, DistributionChannel>  $channels
     * @return array{synced:int,failed:int,refresh_count:int}
     */
    public function syncMany(iterable $channels): array
    {
        $synced = 0;
        $failed = 0;
        $refreshCount = 0;

        foreach ($channels as $channel) {
            try {
                $outcome = $this->syncChannel($channel);
                $refreshCount += $outcome['refresh_count'];
                $synced++;
            } catch (Throwable) {
                $failed++;
            }
        }

        return ['synced' => $synced, 'failed' => $failed, 'refresh_count' => $refreshCount];
    }
}
