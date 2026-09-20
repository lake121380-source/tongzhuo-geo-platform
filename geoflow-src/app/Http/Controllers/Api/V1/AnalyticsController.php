<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Services\Admin\Analytics\AiVisibilityAnalyticsFilter;
use App\Services\Admin\Analytics\AnalyticsFilter;
use App\Services\Admin\Analytics\AnalyticsLogFilter;
use App\Services\Admin\Analytics\AnalyticsLogQueryService;
use App\Services\Admin\Analytics\AnalyticsOverviewService;
use App\Services\Admin\Analytics\DistributionAnalyticsService;
use App\Services\Admin\Analytics\GrowthOverviewService;
use App\Services\Admin\Analytics\LeadAnalyticsFilter;
use App\Services\Admin\Analytics\LeadAnalyticsService;
use App\Services\Jiandu\JianduVisibilityService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * 桐灼GEO analytics projection for the React admin UI.
 *
 * The controller deliberately delegates all calculations to the existing
 * analytics services used by the legacy admin. It only translates the API
 * query contract and adds a stable source/range envelope; it never invents
 * estimated percentages or reads the old Express demo store.
 */
class AnalyticsController extends BaseApiController
{
    public function overview(
        Request $request,
        AnalyticsOverviewService $analytics,
        AnalyticsLogQueryService $traffic,
        JianduVisibilityService $jiandu,
        DistributionAnalyticsService $distribution,
        LeadAnalyticsService $leads,
    ): JsonResponse {
        $this->executionAdmin($request);
        $filter = $this->contentFilter($request);
        $logFilter = $this->logFilter($request);
        $leadFilter = $this->leadFilter($request);
        $distributionStatus = $this->status($request);

        $leadSummary = $leads->summary($leadFilter);

        return $this->success($request, [
            'range' => $filter->toArray(),
            'source' => $this->sourceMeta(),
            'kpis' => $analytics->kpis($filter),
            'task_health' => $analytics->taskHealth($filter),
            'material_health' => $analytics->materialHealth(),
            'ai_health' => $analytics->aiHealth(),
            'url_import_health' => $analytics->urlImportHealth($filter),
            'traffic' => $traffic->summary($logFilter, $filter),
            // AI 可见度已整体切换为见度数据（2026-09-20 拍板「替换」）：总览卡片用
            // 见度的提及率喂旧投影键 `brand_visibility`；未连接/取数失败为空数组，
            // 前端显示「—」。完整栏目见 aiVisibility()。
            'ai_visibility' => ['kpis' => $jiandu->overviewCardKpis()],
            'distribution' => $distribution->summary($filter, $distributionStatus),
            'leads' => [
                'ready' => (bool) ($leadSummary['ready'] ?? false),
                'kpis' => $leadSummary['kpis'] ?? [],
                'trend' => $leadSummary['trend'] ?? [],
                'sources' => $leadSummary['sources'] ?? [],
            ],
        ]);
    }

    /**
     * 旧 Blade analytics 首页的「增长总览 + 下一步该做什么的告警条」。
     *
     * 与旧面同一条边界：分发那一段只在受保护工作流权限下才计算
     * （旧控制器也是把 `canManageProtectedWorkflows` 当 `$includeDistribution` 传进去的）。
     */
    public function growthOverview(Request $request, GrowthOverviewService $overview): JsonResponse
    {
        $admin = $this->executionAdmin($request);

        return $this->success($request, [
            'source' => $this->sourceMeta(),
            ...$overview->snapshot($admin->canManageProtectedWorkflows()),
        ]);
    }

    public function content(Request $request, AnalyticsOverviewService $analytics): JsonResponse
    {
        $this->executionAdmin($request);
        $filter = $this->contentFilter($request);

        return $this->success($request, [
            'range' => $filter->toArray(),
            'source' => $this->sourceMeta(),
            'kpis' => $analytics->kpis($filter),
            'publication_trend' => $analytics->publicationTrend($filter),
            'task_trend' => $analytics->taskTrend($filter),
            'content_funnel' => $analytics->contentFunnel($filter),
            'top_content' => $analytics->topContent($filter),
            'ai_usage' => $analytics->aiUsageSummary($filter),
            'category_distribution' => $analytics->categoryDistribution($filter),
            'performance' => $analytics->performanceStats($filter),
            'latest_articles' => $analytics->latestArticles($filter),
        ]);
    }

    public function traffic(Request $request, AnalyticsLogQueryService $traffic): JsonResponse
    {
        $this->executionAdmin($request);
        $contentFilter = $this->contentFilter($request);
        $logFilter = $this->logFilter($request);

        return $this->success($request, [
            'range' => $logFilter->toArray(),
            'source' => $this->sourceMeta(),
            'summary' => $traffic->summary($logFilter, $contentFilter),
        ]);
    }

    public function crawlers(Request $request, AnalyticsLogQueryService $traffic): JsonResponse
    {
        return $this->traffic($request, $traffic);
    }

    /**
     * AI 可见度栏目——**已整体切换为见度数据**（2026-09-20 拍板「替换」）。
     *
     * 未连接见度 → 引导态（`connected:false`，前端提示去「AI 模型与提示词」页
     * 完成一次性连接）；连接后 → 实时拉取见度的提及率/平台/批次/报告。
     * 上游故障不抛页：降级载荷带 `error` 与 `needs_reconnect` 标志。
     */
    public function aiVisibility(Request $request, JianduVisibilityService $jiandu): JsonResponse
    {
        $this->executionAdmin($request);
        $filter = $this->visibilityFilter($request);
        $range = JianduVisibilityService::rangeFromPreset((string) $request->query('ai_preset', $request->query('preset', '30d')));

        return $this->success($request, [
            'range' => $filter->toArray(),
            'source' => ['kind' => 'jiandu_api', 'system' => '见度GEO', 'complete' => true, 'estimated' => false],
            'overview' => $jiandu->overview($range),
        ]);
    }

    /**
     * 分发数据是**经营数据**：旧后台整个 `distribution` 路由组挂在 `admin.super` 下，
     * 同域的渠道/同步/密钥端点也都保留了超管边界。这里此前只判 `analytics:read`，
     * 等于把经营数据放宽给任意带该 scope 的管理员——已收回（2026-09-12 拍板）。
     */
    public function distribution(Request $request, DistributionAnalyticsService $distribution): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        if (! $admin->isSuperAdmin()) {
            throw new ApiException('forbidden', '只有超级管理员可以查看分发分析', 403, [
                'required_role' => 'super_admin',
            ]);
        }
        $filter = $this->contentFilter($request);

        return $this->success($request, [
            'range' => $filter->toArray(),
            'source' => $this->sourceMeta(),
            'summary' => $distribution->summary($filter, $this->status($request)),
        ]);
    }

    public function leads(Request $request, LeadAnalyticsService $leads): JsonResponse
    {
        $this->executionAdmin($request);
        $summary = $leads->summary($this->leadFilter($request));
        // Lead payloads may contain contact details; the API projection only
        // returns aggregate/trend/source data until a dedicated redacted lead
        // management contract is approved.
        unset($summary['recent']);

        return $this->success($request, [
            'range' => $this->leadFilter($request)->toArray(),
            'source' => $this->sourceMeta(),
            'summary' => $summary,
        ]);
    }

    /** @return array<string,mixed> */
    private function query(Request $request): array
    {
        return $request->query();
    }

    private function contentFilter(Request $request): AnalyticsFilter
    {
        return AnalyticsFilter::fromRequest($this->query($request));
    }

    private function logFilter(Request $request): AnalyticsLogFilter
    {
        $query = $this->query($request);
        if (! isset($query['log_preset']) && isset($query['preset'])) {
            $query['log_preset'] = $query['preset'];
        }
        if (! isset($query['log_date_from']) && isset($query['date_from'])) {
            $query['log_date_from'] = $query['date_from'];
        }
        if (! isset($query['log_date_to']) && isset($query['date_to'])) {
            $query['log_date_to'] = $query['date_to'];
        }

        return AnalyticsLogFilter::fromRequest($query);
    }

    private function visibilityFilter(Request $request): AiVisibilityAnalyticsFilter
    {
        $query = $this->query($request);
        if (! isset($query['ai_preset']) && isset($query['preset'])) {
            $query['ai_preset'] = $query['preset'] === '7d' ? '14d' : $query['preset'];
        }
        if (! isset($query['ai_date_from']) && isset($query['date_from'])) {
            $query['ai_date_from'] = $query['date_from'];
        }
        if (! isset($query['ai_date_to']) && isset($query['date_to'])) {
            $query['ai_date_to'] = $query['date_to'];
        }

        return AiVisibilityAnalyticsFilter::fromRequest($query);
    }

    private function leadFilter(Request $request): LeadAnalyticsFilter
    {
        $query = $this->query($request);
        if (! isset($query['lead_preset']) && isset($query['preset'])) {
            $query['lead_preset'] = in_array($query['preset'], ['7d', '30d', '90d'], true)
                ? $query['preset']
                : '30d';
        }
        if (! isset($query['lead_date_from']) && isset($query['date_from'])) {
            $query['lead_date_from'] = $query['date_from'];
        }
        if (! isset($query['lead_date_to']) && isset($query['date_to'])) {
            $query['lead_date_to'] = $query['date_to'];
        }

        return LeadAnalyticsFilter::fromRequest($query);
    }

    private function status(Request $request): string
    {
        $status = trim((string) $request->query('distribution_status', 'all'));

        return in_array($status, ['all', 'synced', 'failed', 'pending'], true) ? $status : 'all';
    }

    /** @return array<string,mixed> */
    private function sourceMeta(): array
    {
        return [
            'kind' => 'geoflow_database',
            'complete' => true,
            'estimated' => false,
        ];
    }
}
