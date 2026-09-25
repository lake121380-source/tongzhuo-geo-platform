<?php

namespace App\Services\GeoFlow;

use App\Models\AiVisibilityRun;
use App\Models\AiVisibilitySource;
use App\Models\Keyword;
use App\Models\QueryRadarDraftEvidence;
use App\Support\Site\BrandIdentity;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Schema;

final class QueryRadarProjectionService
{
    /** @return array<string, mixed> */
    public function build(int $days = 30): array
    {
        $days = max(1, min(90, $days));
        $end = now();
        $start = $end->copy()->subDays($days - 1)->startOfDay();
        $keywords = Keyword::query()
            ->with('library:id,name')
            ->orderByDesc('usage_count')
            ->orderByDesc('used_count')
            ->orderBy('id')
            ->limit(100)
            ->get();
        $normalizedQueries = $keywords
            ->map(fn (Keyword $keyword): string => $this->normalizeQuery((string) $keyword->keyword))
            ->filter()
            ->unique()
            ->values();
        $runs = $this->runsFor($normalizedQueries, $start, $end);
        $runsByQuery = $runs->groupBy(fn (AiVisibilityRun $run): string => $this->normalizeQuery((string) $run->keyword));
        $evidenceByKeyword = $this->draftEvidenceFor($keywords);
        $ownedHosts = $this->ownedHosts();
        $brandNames = $this->brandNames();

        $items = $keywords->map(function (Keyword $keyword) use ($runsByQuery, $evidenceByKeyword, $ownedHosts, $brandNames): array {
            $query = trim((string) $keyword->keyword);
            /** @var Collection<int, AiVisibilityRun> $matching */
            $matching = $runsByQuery->get($this->normalizeQuery($query), collect());
            $completed = $matching->where('status', AiVisibilityRun::STATUS_COMPLETED)->values();
            $failed = $matching->where('status', AiVisibilityRun::STATUS_FAILED)->values();
            $pending = $matching->whereIn('status', [AiVisibilityRun::STATUS_QUEUED, AiVisibilityRun::STATUS_RUNNING])->values();
            $sources = $completed->flatMap(fn (AiVisibilityRun $run) => $run->sources)->values();
            $latest = $completed
                ->filter(fn (AiVisibilityRun $run): bool => trim((string) $run->answer_text) !== '')
                ->sortByDesc(fn (AiVisibilityRun $run): string => ($run->completed_at ?: $run->created_at)?->toISOString() ?? '')
                ->first();
            $ownedCount = $ownedHosts === []
                ? null
                : $sources->filter(fn (AiVisibilitySource $source): bool => $this->isOwnedSource($source, $ownedHosts))->count();
            $sourceCount = $sources->count();
            $draftEvidence = $evidenceByKeyword->get((int) $keyword->id);
            $article = $draftEvidence?->article;

            return [
                'id' => 'keyword-'.(int) $keyword->id,
                'keyword_id' => (int) $keyword->id,
                'query' => $query,
                'sample' => [
                    'source' => 'keyword_library',
                    'library_id' => $keyword->library_id !== null ? (int) $keyword->library_id : null,
                    'library_name' => (string) ($keyword->library?->name ?? ''),
                    'internal_usage_count' => (int) $keyword->usage_count,
                    'internal_used_count' => (int) $keyword->used_count,
                    'external_volume' => null,
                    'external_volume_status' => 'not_collected',
                ],
                'observations' => [
                    'run_count' => $matching->count(),
                    'completed_run_count' => $completed->count(),
                    'failed_run_count' => $failed->count(),
                    'pending_run_count' => $pending->count(),
                    'provider_count' => $matching
                        ->map(fn (AiVisibilityRun $run): string => $this->providerIdentity($run))
                        ->filter()
                        ->unique()
                        ->count(),
                    'latest_observed_at' => $matching
                        ->map(fn (AiVisibilityRun $run): ?Carbon => $run->completed_at ?: $run->created_at)
                        ->filter()
                        ->max()?->toISOString(),
                ],
                'providers' => $this->providerBreakdown($matching),
                'citations' => [
                    'observation_count' => $sourceCount,
                    'unique_source_count' => $sources
                        ->map(fn (AiVisibilitySource $source): string => $this->sourceIdentity($source))
                        ->filter()
                        ->unique()
                        ->count(),
                    'owned_observation_count' => $ownedCount,
                    'owned_share_percent' => $ownedCount !== null && $sourceCount > 0
                        ? round($ownedCount / $sourceCount * 100, 1)
                        : null,
                    'denominator' => $sourceCount,
                    'availability' => $this->citationAvailability($matching, $completed, $sourceCount, $ownedHosts),
                ],
                'mentions' => $this->mentionProjection($completed, $brandNames),
                'latest_answer' => $latest instanceof AiVisibilityRun ? $this->latestAnswer($latest, $ownedHosts) : null,
                'draft' => $article ? [
                    'article_id' => (int) $article->id,
                    'title' => (string) $article->title,
                    'status' => (string) $article->status,
                    'review_status' => (string) $article->review_status,
                    'evidence_created_at' => $draftEvidence?->created_at?->toISOString(),
                ] : null,
                'status' => $article && (string) $article->status === 'published'
                    ? 'published'
                    : ($article ? 'drafted' : ($matching->isEmpty() ? 'not_collected' : ($completed->isEmpty() ? 'collection_failed' : 'collected'))),
                'draft_ready' => $latest instanceof AiVisibilityRun && $sourceCount > 0,
            ];
        })->values();

        // 站点级提及率：把所有问题合起来算，而不是挑某一个问题的数当站点数。
        // 前端原先拿 `items[0].mentions.mention_rate_percent` 当「品牌提及率」——
        // 第一个问题恰好没跑出回答就整卡「不可计算」（哪怕其余 99 个问题都有数据），
        // 而且第一个问题换了、站点数字就跟着跳。分子分母这里本来就有，直接算出来给他们。
        $observedAnswers = (int) $items->sum('mentions.observed_answer_count');
        $mentionedAnswers = $brandNames === [] ? null : (int) $items->sum('mentions.mentioned_answer_count');

        return [
            'items' => $items->all(),
            'summary' => [
                'configured_query_count' => $items->count(),
                'observed_query_count' => $items->where('observations.run_count', '>', 0)->count(),
                'run_count' => $runs->count(),
                'completed_run_count' => $runs->where('status', AiVisibilityRun::STATUS_COMPLETED)->count(),
                'failed_run_count' => $runs->where('status', AiVisibilityRun::STATUS_FAILED)->count(),
                'citation_observation_count' => $items->sum('citations.observation_count'),
                'observed_answer_count' => $observedAnswers,
                'mentioned_answer_count' => $mentionedAnswers,
                'mention_rate_percent' => $mentionedAnswers !== null && $observedAnswers > 0
                    ? round($mentionedAnswers / $observedAnswers * 100, 1)
                    : null,
                'mention_availability' => match (true) {
                    $brandNames === [] => 'brand_not_configured',
                    $observedAnswers === 0 => 'no_completed_answers',
                    default => 'available',
                },
            ],
            'window' => [
                'days' => $days,
                'start' => $start->toISOString(),
                'end' => $end->toISOString(),
            ],
            'ownership' => [
                'method' => 'exact_or_subdomain_hostname_match',
                'configured' => $ownedHosts !== [],
                'owned_hosts' => $ownedHosts,
            ],
            'definitions' => [
                'query_sample' => '桐灼GEO 关键词库中的已配置问题，不代表外部用户搜索量。',
                'external_volume' => '当前没有接入可核验的外部问题量数据源，因此不可计算。',
                'owned_share_percent' => '时间窗内自有域名引用记录数 / 全部引用记录数；没有引用或自有域名时不可计算。',
                'brand_mention_rate_percent' => '时间窗内有非空回答的已完成运行中，回答文本出现已配置品牌名称的比例。回答是模型针对运营方提出的问题给出的，因此该比例表示「被问到这个问题时，AI 的回答里是否提到该品牌」——它衡量的是被提问后的提及，不是自发推荐；品牌名称未配置时不可计算。',
                'brand_names' => '品牌名称只取 `ai_brand_entity_config` 中运营方声明的组织名称、别名与法定名称；未配置时不做名称匹配，也不使用内置默认品牌名或站点默认名。',
                'opportunity_score' => '未定义可信模型和分母，当前不计算机会指数。',
            ],
            'brand' => [
                'configured' => $brandNames !== [],
                'names' => $brandNames,
            ],
            'source' => 'geoflow_database',
        ];
    }

    /** @param Collection<int, string> $normalizedQueries @return Collection<int, AiVisibilityRun> */
    private function runsFor(Collection $normalizedQueries, Carbon $start, Carbon $end): Collection
    {
        if ($normalizedQueries->isEmpty()) {
            return collect();
        }

        return AiVisibilityRun::query()
            ->with(['sources' => fn ($query) => $query
                ->select(['id', 'ai_visibility_run_id', 'title', 'url', 'domain', 'site_name', 'snippet', 'summary', 'rank'])
                ->orderByRaw('COALESCE(rank, 999999) asc')
                ->orderBy('id')])
            ->where(function (Builder $query) use ($start, $end): void {
                $query->whereBetween('completed_at', [$start, $end])
                    ->orWhere(function (Builder $query) use ($start, $end): void {
                        $query->whereNull('completed_at')->whereBetween('created_at', [$start, $end]);
                    });
            })
            ->where(function (Builder $query) use ($normalizedQueries): void {
                foreach ($normalizedQueries as $normalized) {
                    $query->orWhereRaw('LOWER(TRIM(keyword)) = ?', [$normalized]);
                }
            })
            ->select([
                'id', 'uuid', 'keyword', 'provider_type', 'provider_key', 'ai_model_id',
                'ai_source_provider_id', 'model_id', 'status', 'answer_text', 'error_message',
                'completed_at', 'created_at',
            ])
            ->orderBy('created_at')
            ->orderBy('id')
            ->get();
    }

    /** @param Collection<int, Keyword> $keywords @return Collection<int, QueryRadarDraftEvidence> */
    private function draftEvidenceFor(Collection $keywords): Collection
    {
        $ids = $keywords->pluck('id')->map(fn ($id): int => (int) $id)->all();
        if ($ids === [] || ! Schema::hasTable('query_radar_draft_evidences')) {
            return collect();
        }

        return QueryRadarDraftEvidence::query()
            ->with('article:id,title,status,review_status')
            ->whereIn('keyword_id', $ids)
            ->latest('created_at')
            ->latest('id')
            ->get()
            ->unique('keyword_id')
            ->keyBy(fn (QueryRadarDraftEvidence $evidence): int => (int) $evidence->keyword_id);
    }

    /** @param Collection<int, AiVisibilityRun> $runs @return list<array<string, mixed>> */
    private function providerBreakdown(Collection $runs): array
    {
        return $runs
            ->groupBy(fn (AiVisibilityRun $run): string => $this->providerIdentity($run))
            ->map(function (Collection $providerRuns): array {
                /** @var AiVisibilityRun $latest */
                $latest = $providerRuns->sortByDesc('id')->first();

                return [
                    'provider_type' => (string) $latest->provider_type,
                    'provider_key' => (string) $latest->provider_key,
                    'model_id' => (string) $latest->model_id,
                    'run_count' => $providerRuns->count(),
                    'completed_run_count' => $providerRuns->where('status', AiVisibilityRun::STATUS_COMPLETED)->count(),
                    'failed_run_count' => $providerRuns->where('status', AiVisibilityRun::STATUS_FAILED)->count(),
                    'latest_observed_at' => $providerRuns
                        ->map(fn (AiVisibilityRun $run): ?Carbon => $run->completed_at ?: $run->created_at)
                        ->filter()
                        ->max()?->toISOString(),
                ];
            })
            ->sortBy('provider_key')
            ->values()
            ->all();
    }

    /** @param list<string> $ownedHosts @return array<string, mixed> */
    private function latestAnswer(AiVisibilityRun $run, array $ownedHosts): array
    {
        return [
            'run_id' => (int) $run->id,
            'run_uuid' => (string) $run->uuid,
            'provider_type' => (string) $run->provider_type,
            'provider_key' => (string) $run->provider_key,
            'model_id' => (string) $run->model_id,
            'status' => (string) $run->status,
            'answer_text' => (string) $run->answer_text,
            'completed_at' => ($run->completed_at ?: $run->created_at)?->toISOString(),
            'sources' => $run->sources->take(10)->map(fn (AiVisibilitySource $source): array => [
                'id' => (int) $source->id,
                'title' => (string) $source->title,
                'url' => (string) $source->url,
                'domain' => $this->sourceHost($source),
                'rank' => $source->rank !== null ? (int) $source->rank : null,
                'owned' => $ownedHosts === [] ? null : $this->isOwnedSource($source, $ownedHosts),
            ])->values()->all(),
        ];
    }

    /** @param Collection<int, AiVisibilityRun> $all @param Collection<int, AiVisibilityRun> $completed @param list<string> $ownedHosts */
    private function citationAvailability(Collection $all, Collection $completed, int $sourceCount, array $ownedHosts): string
    {
        if ($all->isEmpty()) {
            return 'not_collected';
        }
        if ($completed->isEmpty()) {
            return 'no_completed_runs';
        }
        if ($sourceCount === 0) {
            return 'no_citation_records';
        }
        if ($ownedHosts === []) {
            return 'owned_domains_not_configured';
        }

        return 'available';
    }

    /** 自有域名统一走 {@see BrandIdentity}：只认运营方显式声明的官方域名与已开通 Hosted Site。 @return list<string> */
    private function ownedHosts(): array
    {
        return BrandIdentity::ownedHosts();
    }

    /**
     * 品牌名统一走 {@see BrandIdentity}，避免查询雷达与 admin AI 可见性看板出现两套口径。
     *
     * @return list<string>
     */
    private function brandNames(): array
    {
        return BrandIdentity::names();
    }

    /**
     * @param  Collection<int, AiVisibilityRun>  $completed
     * @param  list<string>  $brandNames
     * @return array<string, mixed>
     */
    private function mentionProjection(Collection $completed, array $brandNames): array
    {
        $answered = $completed->filter(
            fn (AiVisibilityRun $run): bool => trim((string) $run->answer_text) !== '',
        )->values();
        $observed = $answered->count();
        $mentioned = $brandNames === []
            ? null
            : $answered->filter(
                fn (AiVisibilityRun $run): bool => $this->mentionsAnyName((string) $run->answer_text, $brandNames),
            )->count();

        return [
            'observed_answer_count' => $observed,
            'mentioned_answer_count' => $mentioned,
            'mention_rate_percent' => $mentioned !== null && $observed > 0
                ? round($mentioned / $observed * 100, 1)
                : null,
            'denominator' => $observed,
            'availability' => match (true) {
                $brandNames === [] => 'brand_not_configured',
                $observed === 0 => 'no_completed_answers',
                default => 'available',
            },
        ];
    }

    /** @param list<string> $names */
    private function mentionsAnyName(string $text, array $names): bool
    {
        foreach ($names as $name) {
            if (mb_stripos($text, $name) !== false) {
                return true;
            }
        }

        return false;
    }

    private function providerIdentity(AiVisibilityRun $run): string
    {
        return implode('|', [
            trim((string) $run->provider_type),
            trim((string) $run->provider_key),
            trim((string) $run->model_id),
        ]);
    }

    private function sourceIdentity(AiVisibilitySource $source): string
    {
        return trim((string) $source->url) ?: implode('|', [
            $this->sourceHost($source),
            trim((string) $source->title),
        ]);
    }

    /** @param list<string> $ownedHosts */
    private function isOwnedSource(AiVisibilitySource $source, array $ownedHosts): bool
    {
        $sourceHost = $this->sourceHost($source);
        foreach ($ownedHosts as $ownedHost) {
            if ($sourceHost === $ownedHost || str_ends_with($sourceHost, '.'.$ownedHost)) {
                return true;
            }
        }

        return false;
    }

    private function sourceHost(AiVisibilitySource $source): string
    {
        return $this->normalizeHost((string) ($source->domain ?: $source->url ?: $source->site_name));
    }

    private function normalizeHost(string $value): string
    {
        $value = trim(mb_strtolower($value));
        if ($value === '') {
            return '';
        }
        $host = parse_url(str_contains($value, '://') ? $value : 'https://'.$value, PHP_URL_HOST);
        $host = trim(mb_strtolower(is_string($host) ? $host : ''));

        return preg_replace('/^www\./', '', $host) ?? $host;
    }

    private function normalizeQuery(string $query): string
    {
        return mb_strtolower(trim($query));
    }
}
