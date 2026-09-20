<?php

namespace App\Services\Jiandu;

use App\Exceptions\ApiException;
use App\Models\JianduDetectionSetting;

/**
 * 「数据分析 → AI 可见度」栏目的**见度数据层**。
 *
 * 该栏目已整体切换为见度数据（2026-09-20 哥哥拍板「替换」）：连接见度后展示
 * 见度的提及率/推荐率/平台/批次/报告；未连接时返回引导态。本站自研的那套
 * 采集（`ai_visibility_runs`）不再出现在这个栏目里。
 *
 * 本类只做「拉取 + 映射 + 降级」：上游失败（连接失效、见度不可达）不抛给页面，
 * 而是返回带 `error` 的降级载荷——栏目是只读面板，坏了要能说清楚坏在哪
 * （`needs_reconnect` 供前端引导重连）。
 */
final class JianduVisibilityService
{
    public function __construct(
        private readonly JianduConnectionService $connections,
        private readonly JianduApiClient $client,
    ) {}

    /** preset（7d/30d/90d…）→ 见度区间。见度只支持 30d/90d，取就近档。 */
    public static function rangeFromPreset(?string $preset): string
    {
        $value = strtolower(trim((string) $preset));
        if ($value === '') {
            return '30d';
        }

        return str_contains($value, '90') || str_contains($value, 'quarter') ? '90d' : '30d';
    }

    public function connected(): bool
    {
        return $this->connections->current() !== null;
    }

    /** @return array<string, mixed> 未连接时的栏目载荷 */
    public static function disconnectedPayload(): array
    {
        return [
            'ready' => false,
            'configured' => false,
            'connected' => false,
            'system' => '见度GEO',
        ];
    }

    /**
     * 栏目完整载荷（放在响应的 `data.overview`）。
     *
     * @return array<string, mixed>
     */
    public function overview(string $range = '30d'): array
    {
        if (! $this->connected()) {
            return self::disconnectedPayload();
        }

        try {
            return $this->connections->withFreshToken(function (string $token) use ($range): array {
                $project = $this->resolveProject($token);
                if ($project === null) {
                    return $this->degraded('见度账号下还没有项目——请先在见度系统里创建项目并完成一次检测。');
                }

                $projectId = (string) $project['id'];
                $overview = $this->client->fetchOverview($token, $projectId, $range);
                $detections = $this->client->fetchDetections($token, $projectId, 1, 20);
                // 报告有套餐特性门禁（feature_not_in_plan）：拿不到就静默为空，不打断整栏。
                $reports = [];
                try {
                    $reports = $this->client->fetchReports($token, $projectId, 1, 10);
                } catch (\Throwable) {
                }
                $me = [];
                try {
                    $me = $this->client->fetchMe($token);
                } catch (\Throwable) {
                }

                return $this->map($project, $range, $overview, $detections, $reports, $me);
            });
        } catch (ApiException $exception) {
            return $this->degraded($exception->getMessage(), $exception->getErrorCode() === 'jiandu_reconnect_required');
        }
    }

    /**
     * 总览页的「AI 可见度」小卡（沿用旧投影键 `brand_visibility`）。
     * 失败一律静默为空——总览页不该被一个子投影拖垮。
     *
     * @return array<string, mixed>
     */
    public function overviewCardKpis(): array
    {
        if (! $this->connected()) {
            return [];
        }

        try {
            $overview = $this->connections->withFreshToken(function (string $token): array {
                $project = $this->resolveProject($token);
                if ($project === null) {
                    return [];
                }

                return $this->client->fetchOverview($token, (string) $project['id'], '30d');
            });
        } catch (\Throwable) {
            return [];
        }

        $rate = $overview['mentionRate'] ?? null;

        return $rate === null ? [] : ['brand_visibility' => $rate];
    }

    /** @return array<string, mixed> */
    private function degraded(string $message, bool $needsReconnect = false): array
    {
        return [
            'ready' => true,
            'configured' => true,
            'connected' => true,
            'system' => '见度GEO',
            'error' => $message,
            'needs_reconnect' => $needsReconnect,
        ];
    }

    /**
     * 当前目标项目：设置里选过的优先，否则取见度侧第一个并记回设置
     * （让「每日自动检测」和栏目展示永远看同一个项目）。
     *
     * @return array<string, mixed>|null
     */
    private function resolveProject(string $token): ?array
    {
        $setting = JianduDetectionSetting::current();
        $projects = $this->client->fetchProjects($token);
        if ($projects === []) {
            return null;
        }

        $chosen = null;
        if ($setting->project_id !== null) {
            foreach ($projects as $project) {
                if ((string) ($project['id'] ?? '') === (string) $setting->project_id) {
                    $chosen = $project;
                    break;
                }
            }
        }
        $chosen ??= $projects[0];

        $id = (string) ($chosen['id'] ?? '');
        $name = (string) ($chosen['name'] ?? '');
        if ($setting->project_id !== $id || $setting->project_name !== $name) {
            $setting->update(['project_id' => $id, 'project_name' => $name]);
        }

        return $chosen;
    }

    /**
     * 见度数据 → 栏目载荷。键名 snake_case（前端内联渲染）。
     *
     * 零样本口径：见度在 `totalAnswers === 0` 时各比率返回字面的 0——这里统一
     * 翻成 `null`（前端显示「—」），因为「没测出来」不是「测出来是 0」。
     *
     * @param  array<string, mixed>  $project
     * @param  array<string, mixed>  $overview
     * @param  array<string, mixed>  $detections
     * @param  array<string, mixed>  $reports
     * @param  array<string, mixed>  $me
     * @return array<string, mixed>
     */
    private function map(array $project, string $range, array $overview, array $detections, array $reports, array $me): array
    {
        $total = $overview['totalAnswers'] ?? null;
        $hasSamples = is_numeric($total) && (int) $total > 0;

        $kpis = [
            'mention_rate' => $hasSamples ? ($overview['mentionRate'] ?? null) : null,
            'recommend_rate' => $hasSamples ? ($overview['recommendRate'] ?? null) : null,
            'positive_rate' => $hasSamples ? ($overview['positiveRate'] ?? null) : null,
            'geo_score' => $hasSamples ? ($overview['geoScore'] ?? null) : null,
            'sampled_answers' => is_numeric($total) ? (int) $total : null,
        ];

        $trend = [];
        foreach ((array) ($overview['trendData'] ?? []) as $row) {
            if (! is_array($row)) {
                continue;
            }
            $trend[] = [
                'date' => (string) ($row['date'] ?? ''),
                'mention_rate' => $row['mentionRate'] ?? null,
                'recommend_rate' => $row['recommendRate'] ?? null,
                'sampled' => $row['total'] ?? null,
            ];
        }

        $platforms = [];
        foreach ((array) ($overview['platformPerformance'] ?? []) as $row) {
            if (! is_array($row)) {
                continue;
            }
            $platforms[] = [
                'name' => (string) ($row['platform'] ?? $row['platformId'] ?? ''),
                'mention_rate' => $row['mentionRate'] ?? null,
                'sampled' => $row['totalCount'] ?? null,
            ];
        }

        $detectionRows = [];
        foreach ((array) ($detections['items'] ?? []) as $row) {
            if (! is_array($row)) {
                continue;
            }
            $detectionRows[] = [
                'id' => (string) ($row['id'] ?? ''),
                'name' => (string) ($row['name'] ?? ''),
                'status' => (string) ($row['status'] ?? ''),
                'created_at' => (string) ($row['createdAt'] ?? ''),
                'sampled' => $row['totalAnswers'] ?? null,
                'mention_rate' => $row['mentionRate'] ?? null,
                'recommend_rate' => $row['recommendRate'] ?? null,
            ];
        }

        $reportRows = [];
        foreach ((array) ($reports['items'] ?? []) as $row) {
            if (! is_array($row)) {
                continue;
            }
            $metrics = is_array($row['metrics'] ?? null) ? $row['metrics'] : [];
            $reportRows[] = [
                'id' => (string) ($row['id'] ?? ''),
                'title' => (string) ($row['title'] ?? ''),
                'created_at' => (string) ($row['createdAt'] ?? ''),
                'geo_score' => $row['geoScore'] ?? null,
                'geo_score_status' => (string) ($row['geoScoreStatus'] ?? ''),
                'mention_rate' => $metrics['mentionRate'] ?? null,
                'recommend_rate' => $metrics['recommendRate'] ?? null,
                'sampled' => $metrics['total'] ?? null,
            ];
        }

        $quota = [];
        if (is_array($me['quota'] ?? null)) {
            $quota = [
                'used' => $me['quota']['monthlyDetectionsUsed'] ?? null,
                'total' => $me['quota']['monthlyDetectionsTotal'] ?? null,
                'points' => $me['quota']['pointsBalance'] ?? null,
            ];
        }

        return [
            'ready' => true,
            'configured' => true,
            'connected' => true,
            'system' => '见度GEO',
            'project' => [
                'id' => (string) ($project['id'] ?? ''),
                'name' => (string) ($project['name'] ?? ''),
                'brand_name' => (string) ($project['brandName'] ?? ''),
            ],
            'range' => $range,
            'has_samples' => $hasSamples,
            'fetched_at' => now()->toIso8601String(),
            'kpis' => $kpis,
            'trend' => $trend,
            'platforms' => $platforms,
            'detections' => $detectionRows,
            'reports' => $reportRows,
            'quota' => $quota,
            'plan_name' => is_array($me['plan'] ?? null) ? (string) ($me['plan']['name'] ?? '') : '',
        ];
    }
}
