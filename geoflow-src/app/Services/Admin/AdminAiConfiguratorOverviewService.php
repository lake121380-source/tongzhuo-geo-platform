<?php

namespace App\Services\Admin;

use App\Http\Controllers\Admin\LegacyController;
use App\Http\Controllers\Api\V1\AiConfigurationController;
use App\Models\Admin;
use App\Models\AiModel;
use App\Models\AiSourceProvider;
use App\Models\AiVisibilityRun;
use App\Models\Prompt;
use Illuminate\Support\Facades\Schema;

/**
 * AI 配置器的概览计数。
 *
 * 旧 Blade 后台（{@see LegacyController::aiConfigurator}）与
 * api/v1（{@see AiConfigurationController::overview}）共用这一份实现
 * ——「AI 配置现在什么状态」这件事只能有一个算法，否则两个界面会给出不同的数字。
 *
 * 七个计数分两类，**不要混在一起看**：
 * ① 与当前管理员有关的三项（可用模型数、本人模型的历史/今日用量）按 actor 作用域算；
 * ② 来源 Provider 与可见度失败数**只有超管能看**，非超管一律 0。调用方若要把它们
 *    展示给非超管，必须自己把「无权限」和「真的是 0」区分开——见 api/v1 侧的投影。
 */
final class AdminAiConfiguratorOverviewService
{
    public function __construct(
        private readonly AdminAiModelAccessResolver $modelAccess,
    ) {}

    /**
     * @return array{model_count:int,prompt_count:int,total_usage:int,today_usage:int,search_provider_count:int,search_provider_today_usage:int,visibility_failed_runs:int}
     */
    public function stats(Admin $actor): array
    {
        $isSuperAdmin = $actor->isSuperAdmin();
        $hasSourceProviderTable = Schema::hasTable('ai_source_providers');
        $hasSourceProviderUsageDate = $hasSourceProviderTable
            && Schema::hasColumn('ai_source_providers', 'usage_date');
        $ownedModels = AiModel::query()->ownedBy($actor);
        $configuredModels = $this->modelAccess->managementQuery($actor)->active()->unarchived();

        return [
            'model_count' => (clone $configuredModels)->count(),
            'prompt_count' => Prompt::query()->count(),
            'total_usage' => (int) ((clone $ownedModels)->sum('total_used') ?? 0),
            'today_usage' => (int) ((clone $ownedModels)
                ->forCurrentUsageDay()
                ->sum('used_today') ?? 0),
            'search_provider_count' => $isSuperAdmin && $hasSourceProviderTable
                ? AiSourceProvider::query()->where('status', 'active')->count()
                : 0,
            'search_provider_today_usage' => $isSuperAdmin && $hasSourceProviderUsageDate
                ? (int) (AiSourceProvider::query()
                    ->whereDate('usage_date', now()->toDateString())
                    ->sum('used_today') ?? 0)
                : 0,
            'visibility_failed_runs' => $isSuperAdmin && Schema::hasTable('ai_visibility_runs')
                ? AiVisibilityRun::query()->where('status', AiVisibilityRun::STATUS_FAILED)->count()
                : 0,
        ];
    }

    /**
     * 这三个计数非超管看不到，是权限边界不是数据为零。
     *
     * @return list<string>
     */
    public static function superAdminOnlyKeys(): array
    {
        return ['search_provider_count', 'search_provider_today_usage', 'visibility_failed_runs'];
    }
}
