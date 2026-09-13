<?php

namespace App\Services\GeoFlow;

use App\Models\LeadSubmission;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * AI 引流归因漏斗投影。
 *
 * 只使用两类真实落库数据：
 *  · `view_logs.referer` —— 访问来源（由 RecordSiteViewLog 中间件记录 HTTP Referer）；
 *  · `lead_submissions` —— 线索及其处理状态（new/contacted/qualified/invalid/converted）。
 *
 * 访问与线索之间用 IP 关联（两张表都记录 ip_address），因此**会低估**：同一 IP 的
 * NAT/动态 IP、换设备提交都会漏。这是真实存在的限制，写进 `definitions` 里，不用
 * 任何推测或合成系数去补齐；没有数据时一律返回「不可计算」而不是 0。
 */
final class AttributionFunnelService
{
    /**
     * AI 引擎的来源主机名 → 引擎标识。
     *
     * 这是一份**固定映射**（不是测量结果），用于把 referer 归类；未命中的来源一律算「其他」，
     * 不做任何猜测性归类。新增引擎只需在此登记。
     *
     * @var array<string, string>
     */
    private const AI_REFERRER_HOSTS = [
        'perplexity.ai' => 'perplexity',
        'chatgpt.com' => 'chatgpt',
        'chat.openai.com' => 'chatgpt',
        'gemini.google.com' => 'gemini',
        'bard.google.com' => 'gemini',
        'copilot.microsoft.com' => 'copilot',
        'www.doubao.com' => 'doubao',
        'doubao.com' => 'doubao',
        'kimi.moonshot.cn' => 'kimi',
        'kimi.com' => 'kimi',
        'yuanbao.tencent.com' => 'yuanbao',
        'chat.qwen.ai' => 'qwen',
        'tongyi.aliyun.com' => 'qwen',
        'metaso.cn' => 'metaso',
        'chatglm.cn' => 'zhipu',
        'ai.com' => 'other_ai',
    ];

    /** @return array<string, mixed> */
    public function build(int $days = 30): array
    {
        $days = min(90, max(1, $days));
        $start = now()->subDays($days - 1)->startOfDay();
        $end = now()->endOfDay();

        if (! Schema::hasTable('view_logs') || ! Schema::hasTable('lead_submissions')) {
            return $this->emptyProjection($days, $start, $end, 'not_installed');
        }

        // 只查一次引荐访问：可用性判断与漏斗各阶段都基于同一批记录。
        $visits = $this->aiReferralVisits($start, $end);
        if ($visits->isEmpty()) {
            return $this->emptyProjection(
                $days,
                $start,
                $end,
                $this->viewCount($start, $end) === 0 ? 'no_view_logs' : 'no_ai_referrals',
            );
        }

        $ips = array_values(array_unique($visits->pluck('ip_address')->filter()->all()));
        $leads = $ips === [] ? collect() : $this->leadsForIps($ips, $start, $end);

        $leadCount = $leads->count();
        $convertedCount = $leads->where('status', LeadSubmission::STATUS_CONVERTED)->count();
        $visitCount = $visits->count();

        return [
            'window' => ['days' => $days, 'start' => $start->toISOString(), 'end' => $end->toISOString()],
            'availability' => 'available',
            'stages' => [
                [
                    'key' => 'ai_referral_visit',
                    'label' => 'AI 引荐访问',
                    'count' => $visitCount,
                    'denominator' => null,
                    'detail' => '时间窗内 referer 主机属于已登记 AI 引擎的站点访问记录数。',
                ],
                [
                    'key' => 'engaged_visit',
                    'label' => '多次浏览的引荐访客',
                    'count' => $this->engagedIpCount($visits),
                    // 分母同样是「访客数」而不是访问记录数：否则比值是 IP 除以记录，单位不一致。
                    'denominator' => $this->distinctIpCount($visits),
                    'detail' => '在引荐访客中，同一 IP 产生 2 条及以上访问记录的访客数（按 IP 去重）。',
                ],
                [
                    'key' => 'lead_submitted',
                    'label' => '提交线索',
                    'count' => $leadCount,
                    'denominator' => $this->distinctIpCount($visits),
                    'detail' => '线索 IP 与引荐访客 IP 相同的线索数；按 IP 关联，会低估。',
                ],
                [
                    'key' => 'lead_converted',
                    'label' => '已转化线索',
                    'count' => $convertedCount,
                    'denominator' => $leadCount,
                    'detail' => '上述线索中处理状态为 converted 的数量。',
                ],
            ],
            'engines' => $this->engineBreakdown($visits),
            'recent_referrals' => $visits
                ->sortByDesc('created_at')
                ->take(10)
                ->map(fn (object $row): array => [
                    'engine' => $this->engineFor((string) $row->referer),
                    'referer_host' => $this->hostOf((string) $row->referer),
                    'path' => (string) $row->path,
                    'occurred_at' => $row->created_at,
                ])
                ->values()
                ->all(),
            'totals' => [
                'distinct_referral_ip_count' => $this->distinctIpCount($visits),
                'referral_engine_count' => $this->engineBreakdown($visits)->count(),
                'lead_count_in_window' => $this->leadCountInWindow($start, $end),
            ],
            'definitions' => $this->definitions(),
            'source' => ['kind' => 'geoflow_database', 'estimated' => false],
        ];
    }

    /** @return array<string, string> */
    private function definitions(): array
    {
        return [
            'engine_matching' => 'AI 引擎按 referer 主机名的固定映射归类；未登记的来源计入「其他」，不做推测。',
            'ip_join' => '访问与线索按 IP 关联。NAT、动态 IP、换设备提交都会导致漏配，因此线索阶段是**下界**，不是全量。',
            'availability' => '缺少访问日志或线索数据时返回「不可计算」，不以 0 冒充。',
        ];
    }

    private function viewCount(Carbon $start, Carbon $end): int
    {
        return (int) DB::table('view_logs')->whereBetween('created_at', [$start, $end])->count();
    }

    private function leadCountInWindow(Carbon $start, Carbon $end): int
    {
        return (int) LeadSubmission::query()->whereBetween('created_at', [$start, $end])->count();
    }

    /** @return Collection<int, object> */
    private function aiReferralVisits(Carbon $start, Carbon $end)
    {
        $hosts = array_keys(self::AI_REFERRER_HOSTS);

        return DB::table('view_logs')
            ->select(['referer', 'ip_address', 'path', 'created_at'])
            ->whereBetween('created_at', [$start, $end])
            ->whereNotNull('referer')
            ->where('referer', '!=', '')
            ->where(function ($query) use ($hosts): void {
                foreach ($hosts as $host) {
                    // 只匹配主机名边界：避免 notperplexity.ai 这类包含关系误判。
                    $query->orWhere('referer', 'like', 'http://'.$host.'/%')
                        ->orWhere('referer', 'like', 'https://'.$host.'/%')
                        ->orWhere('referer', 'like', 'http://www.'.$host.'/%')
                        ->orWhere('referer', 'like', 'https://www.'.$host.'/%');
                }
            })
            ->orderBy('created_at')
            ->get();
    }

    /** @param list<string> $ips @return \Illuminate\Support\Collection<int, LeadSubmission> */
    private function leadsForIps(array $ips, Carbon $start, Carbon $end)
    {
        return LeadSubmission::query()
            ->whereIn('ip_address', $ips)
            ->whereBetween('created_at', [$start, $end])
            ->get();
    }

    /** @param Collection<int, object> $visits */
    private function distinctIpCount($visits): int
    {
        return $visits->pluck('ip_address')->filter()->unique()->count();
    }

    /** @param Collection<int, object> $visits */
    private function engagedIpCount($visits): int
    {
        return $visits->groupBy('ip_address')
            ->filter(fn ($rows, $ip): bool => $ip !== '' && $rows->count() >= 2)
            ->count();
    }

    /** @param Collection<int, object> $visits @return \Illuminate\Support\Collection<int, array<string, mixed>> */
    private function engineBreakdown($visits)
    {
        return $visits
            ->groupBy(fn (object $row): string => $this->engineFor((string) $row->referer))
            ->map(fn ($rows, string $engine): array => [
                'engine' => $engine,
                'visit_count' => $rows->count(),
                'distinct_ip_count' => $rows->pluck('ip_address')->filter()->unique()->count(),
            ])
            ->sortByDesc('visit_count')
            ->values();
    }

    private function engineFor(string $referer): string
    {
        $host = $this->hostOf($referer);
        if ($host === '') {
            return 'unknown';
        }

        return self::AI_REFERRER_HOSTS[$host]
            ?? self::AI_REFERRER_HOSTS[preg_replace('/^www\./', '', $host) ?? $host]
            ?? 'other';
    }

    private function hostOf(string $referer): string
    {
        $host = parse_url(trim($referer), PHP_URL_HOST);

        return is_string($host) ? mb_strtolower($host) : '';
    }

    /** @return array<string, mixed> */
    private function emptyProjection(int $days, Carbon $start, Carbon $end, string $availability): array
    {
        return [
            'window' => ['days' => $days, 'start' => $start->toISOString(), 'end' => $end->toISOString()],
            'availability' => $availability,
            'stages' => [],
            'engines' => [],
            'recent_referrals' => [],
            'totals' => null,
            'definitions' => $this->definitions(),
            'source' => ['kind' => 'geoflow_database', 'estimated' => false],
        ];
    }
}
