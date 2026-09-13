<?php

namespace App\Http\Controllers\Api\V1;

use App\Contracts\GeoFlow\AiVisibilityCollector;
use App\Data\Ai\SystemAiIdentity;
use App\Exceptions\ApiException;
use App\Models\AiVisibilityRun;
use App\Models\AiVisibilitySource;
use App\Models\Article;
use App\Models\Author;
use App\Models\Category;
use App\Models\Keyword;
use App\Models\QueryRadarDraftEvidence;
use App\Models\SiteSetting;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\ArticleGeoFlowService;
use App\Services\GeoFlow\AttributionFunnelService;
use App\Services\GeoFlow\QueryRadarProjectionService;
use App\Support\AdminActivityLogger;
use App\Support\Site\BrandIdentity;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * Real API projection for the -AI research surfaces.
 *
 * These views intentionally consume 桐灼GEO's persisted visibility runs and
 * keyword/article tables. They do not recreate the old Express demo store.
 */
final class AiResearchController extends BaseApiController
{
    private const BRAND_SETTING = 'ai_brand_entity_config';

    private const COMPETITOR_SETTING = 'ai_competitor_radar_config';

    public function queryRadar(Request $request, QueryRadarProjectionService $projection): JsonResponse
    {
        $this->executionAdmin($request);
        $validated = $request->validate(['days' => ['nullable', 'integer', 'min:1', 'max:90']]);

        return $this->success($request, $projection->build((int) ($validated['days'] ?? 30)));
    }

    public function collectQuery(Request $request, AiVisibilityCollector $collection): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $validated = $request->validate([
            'query' => ['required', 'string', 'max:255'],
            'keyword_id' => ['nullable', 'integer', 'exists:keywords,id'],
        ]);
        $query = trim((string) $validated['query']);
        $keyword = $this->resolveKeyword($validated['keyword_id'] ?? null, $query);

        return IdempotencyService::executeExternalJson($request, 'POST /ai-research/query-radar/collect', function () use ($request, $collection, $admin, $query, $keyword): JsonResponse {
            try {
                $runs = $collection->collect(SystemAiIdentity::forVisibilityCollection(), $query);
            } catch (Throwable $exception) {
                throw new ApiException('ai_visibility_collection_failed', '问题采集失败：'.$this->publicFailure($exception), 422, [
                    'retryable' => true,
                ]);
            }
            $projected = collect($runs)
                ->filter(fn (mixed $run): bool => $run instanceof AiVisibilityRun)
                ->map(fn (AiVisibilityRun $run): array => $this->collectedRunProjection($run))
                ->values()
                ->all();
            if ($projected === []) {
                throw new ApiException('ai_visibility_empty_result', 'AI 可见性服务没有返回运行记录', 422);
            }
            AdminActivityLogger::logFromRequest($request, $admin, 'api.query_radar.collected', [
                'query' => $query,
                'keyword_id' => $keyword?->id,
                'run_ids' => array_column($projected, 'id'),
            ]);

            return $this->success($request, ['query' => $query, 'runs' => $projected], 201);
        });
    }

    public function generateQueryDraft(Request $request, ArticleGeoFlowService $articles): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $validated = $request->validate([
            'query' => ['required', 'string', 'max:255'],
            'keyword_id' => ['nullable', 'integer', 'exists:keywords,id'],
            'category_id' => ['nullable', 'integer'],
            'author_id' => ['nullable', 'integer'],
            'days' => ['nullable', 'integer', 'min:1', 'max:90'],
        ]);
        $query = trim((string) $validated['query']);
        $keyword = $this->resolveKeyword($validated['keyword_id'] ?? null, $query);
        $categoryId = isset($validated['category_id']) ? (int) $validated['category_id'] : null;
        $authorId = isset($validated['author_id']) ? (int) $validated['author_id'] : null;
        $days = (int) ($validated['days'] ?? 30);

        return IdempotencyService::executeJson($request, 'POST /ai-research/query-radar/draft', function () use ($request, $articles, $admin, $query, $keyword, $categoryId, $authorId, $days): JsonResponse {
            $start = now()->subDays($days - 1)->startOfDay();
            $runs = AiVisibilityRun::query()
                ->with(['sources' => fn ($builder) => $builder->orderByRaw('COALESCE(rank, 999999) asc')->orderBy('id')])
                ->whereRaw('LOWER(TRIM(keyword)) = ?', [mb_strtolower($query)])
                ->where('status', AiVisibilityRun::STATUS_COMPLETED)
                ->whereRaw("TRIM(COALESCE(answer_text, '')) <> ''")
                ->where(function ($builder) use ($start): void {
                    $builder->where('completed_at', '>=', $start)
                        ->orWhere(function ($builder) use ($start): void {
                            $builder->whereNull('completed_at')->where('created_at', '>=', $start);
                        });
                })
                ->latest('completed_at')
                ->latest('id')
                ->limit(5)
                ->get();
            $sourceCount = $runs->sum(fn (AiVisibilityRun $run): int => $run->sources->count());
            if ($runs->isEmpty() || $sourceCount === 0) {
                throw new ApiException('query_radar_evidence_required', '缺少时间窗内已完成回答及引用证据，不能生成可追溯草稿', 422, [
                    'days' => $days,
                    'completed_run_count' => $runs->count(),
                    'citation_count' => $sourceCount,
                ]);
            }
            if ($categoryId === null || $categoryId <= 0 || ! Category::query()->whereKey($categoryId)->exists()) {
                throw new ApiException('validation_failed', '参数校验失败', 422, [
                    'field_errors' => ['category_id' => '请选择有效的文章分类'],
                ]);
            }
            if ($authorId === null || $authorId <= 0 || ! Author::query()->whereKey($authorId)->exists()) {
                throw new ApiException('validation_failed', '参数校验失败', 422, [
                    'field_errors' => ['author_id' => '请选择有效的文章作者'],
                ]);
            }
            $snapshot = $this->draftEvidenceSnapshot($runs);
            $article = DB::transaction(function () use ($articles, $admin, $query, $keyword, $categoryId, $authorId, $snapshot, $runs, $sourceCount): array {
                $created = $articles->createArticle([
                    'title' => $query,
                    'content' => $this->draftContent($query, $runs),
                    'excerpt' => "基于 {$runs->count()} 次已采集回答和 {$sourceCount} 条引用记录生成的待审核草稿。",
                    'keywords' => $query,
                    'is_ai_generated' => true,
                    'status' => 'draft',
                    'review_status' => 'pending',
                    'category_id' => $categoryId,
                    'author_id' => $authorId,
                ], (int) $admin->id);
                $articleId = (int) ($created['id'] ?? 0);
                Article::query()->whereKey($articleId)->update(['original_keyword' => $query]);
                QueryRadarDraftEvidence::query()->create([
                    'article_id' => $articleId,
                    'keyword_id' => $keyword?->id,
                    'created_by_admin_id' => (int) $admin->id,
                    'query' => $query,
                    'run_ids' => $runs->pluck('id')->map(fn ($id): int => (int) $id)->values()->all(),
                    'evidence_snapshot' => $snapshot,
                ]);

                return $articles->getArticle($articleId);
            });
            AdminActivityLogger::logFromRequest($request, $admin, 'api.query_radar.draft_created', [
                'query' => $query,
                'keyword_id' => $keyword?->id,
                'article_id' => (int) ($article['id'] ?? 0),
                'run_ids' => $runs->pluck('id')->map(fn ($id): int => (int) $id)->values()->all(),
            ]);

            return $this->success($request, [
                'article' => $article,
                'query' => $query,
                'evidence' => [
                    'run_count' => $runs->count(),
                    'citation_count' => $sourceCount,
                    'window_days' => $days,
                ],
            ], 201);
        });
    }

    public function competitor(Request $request): JsonResponse
    {
        $this->executionAdmin($request);
        $validated = $request->validate(['days' => ['nullable', 'integer', 'min:1', 'max:90']]);

        return $this->success($request, $this->competitorProjection((int) ($validated['days'] ?? 30)));
    }

    public function saveCompetitorConfig(Request $request): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $validated = $request->validate([
            'industry' => ['nullable', 'string', 'max:255'],
            'competitors' => ['array', 'max:50'],
            'competitors.*.name' => ['required', 'string', 'max:255'],
            'competitors.*.domains' => ['required', 'array', 'min:1', 'max:20'],
            'competitors.*.domains.*' => ['required', 'string', 'max:255'],
        ]);
        $config = $this->normalizeCompetitorConfig($validated);
        foreach ($config['competitors'] as $competitor) {
            if ($competitor['domains'] === []) {
                throw new ApiException('validation_failed', '每个竞品必须至少配置一个可核验域名', 422, [
                    'field_errors' => ['competitors' => '请填写竞品官网域名或信源域名'],
                ]);
            }
        }

        return IdempotencyService::executeJson($request, 'POST /ai-research/competitor/config', function () use ($request, $admin, $config): JsonResponse {
            SiteSetting::query()->updateOrCreate(
                ['setting_key' => self::COMPETITOR_SETTING],
                ['setting_value' => json_encode($config, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)],
            );
            AdminActivityLogger::logFromRequest($request, $admin, 'api.competitor.config_saved', [
                'competitor_count' => count($config['competitors']),
            ]);

            return $this->success($request, $this->competitorProjection(30));
        });
    }

    public function benchmarkCompetitor(Request $request, AiVisibilityCollector $collection): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $validated = $request->validate([
            'query' => ['required', 'string', 'max:255'],
            'days' => ['nullable', 'integer', 'min:1', 'max:90'],
        ]);
        $keyword = trim((string) $validated['query']);
        // 此前 days 通过校验后被丢弃，投影恒用 30 天窗口，与请求的时间窗不符。
        $days = (int) ($validated['days'] ?? 30);

        return IdempotencyService::executeExternalJson($request, 'POST /ai-research/competitor/benchmark', function () use ($request, $collection, $admin, $keyword, $days): JsonResponse {
            try {
                $runs = $collection->collect(SystemAiIdentity::forVisibilityCollection(), $keyword);
            } catch (Throwable $e) {
                throw new ApiException('ai_visibility_collection_failed', '竞品扫描失败：'.$this->publicFailure($e), 422);
            }
            $projected = collect($runs)->filter(fn (mixed $run): bool => $run instanceof AiVisibilityRun)->values();
            if ($projected->isEmpty()) {
                throw new ApiException('ai_visibility_empty_result', 'AI 可见性服务没有返回运行记录', 422);
            }
            AdminActivityLogger::logFromRequest($request, $admin, 'api.competitor.benchmarked', [
                'query' => $keyword,
                'run_ids' => $projected->pluck('id')->map(fn ($id): int => (int) $id)->all(),
            ]);

            return $this->success($request, array_replace($this->competitorProjection($days), [
                'scan' => [
                    'query' => $keyword,
                    'run_ids' => $projected->pluck('id')->map(fn ($id): int => (int) $id)->values()->all(),
                    'status' => 'persisted',
                ],
            ]));
        });
    }

    public function brandEntity(Request $request): JsonResponse
    {
        $this->executionAdmin($request);

        return $this->success($request, $this->brandProjection());
    }

    public function attribution(Request $request, AttributionFunnelService $funnel): JsonResponse
    {
        $this->executionAdmin($request);
        $validated = $request->validate(['days' => ['nullable', 'integer', 'min:1', 'max:90']]);

        return $this->success($request, $funnel->build((int) ($validated['days'] ?? 30)));
    }

    public function saveBrandEntity(Request $request): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        // 品牌配置同时被 visible 投影、竞品归属判定和查询雷达的品牌名匹配消费，
        // 所以逐字段约束类型：畸形结构以往会穿透到投影层抛 TypeError（500）或
        // 被强转成字面量 "Array" 当作品牌名参与匹配。
        $validated = $request->validate([
            'config' => ['required', 'array'],
            'config.organizationName' => ['nullable', 'string', 'max:160'],
            'config.alternateName' => ['nullable', 'string', 'max:160'],
            'config.legalName' => ['nullable', 'string', 'max:160'],
            'config.foundingDate' => ['nullable', 'string', 'max:40'],
            'config.officialDomain' => ['nullable', 'string', 'max:255'],
            'config.logoUrl' => ['nullable', 'string', 'max:500'],
            'config.description' => ['nullable', 'string', 'max:1000'],
            'config.contactEmail' => ['nullable', 'string', 'max:160'],
            'config.sameAsLinks' => ['nullable', 'array', 'max:50'],
            'config.sameAsLinks.*' => ['array'],
            'config.sameAsLinks.*.url' => ['nullable', 'string', 'max:500'],
            'config.founders' => ['nullable', 'array', 'max:50'],
            'config.founders.*' => ['nullable', 'string', 'max:160'],
            'config.awardsAndCertifications' => ['nullable', 'array', 'max:50'],
            'config.awardsAndCertifications.*' => ['nullable', 'string', 'max:255'],
        ]);
        $config = $this->normalizeBrandConfig($validated['config']);

        return IdempotencyService::executeJson($request, 'POST /ai-research/brand-entity', function () use ($request, $admin, $config): JsonResponse {
            SiteSetting::query()->updateOrCreate(['setting_key' => self::BRAND_SETTING], ['setting_value' => json_encode($config, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)]);
            // 同一请求随后要读回投影，必须让请求级缓存对齐刚写入的值，否则会返回写入前的旧配置。
            $this->brandConfigCache = $config;
            AdminActivityLogger::logFromRequest($request, $admin, 'api.brand_entity.saved', [
                'organization_name' => (string) ($config['organizationName'] ?? ''),
            ]);

            return $this->success($request, $this->brandProjection());
        });
    }

    public function sandbox(Request $request, AiVisibilityCollector $collection): JsonResponse
    {
        $admin = $this->executionAdmin($request);

        return IdempotencyService::executeExternalJson($request, 'POST /ai-research/sandbox', function () use ($request, $collection, $admin): JsonResponse {
            $query = trim((string) $request->input('query'));
            if ($query === '') {
                throw new ApiException('validation_failed', 'query 不能为空', 422, ['field_errors' => ['query' => '请输入自然语言问题']]);
            }
            try {
                $runs = $collection->collect(SystemAiIdentity::forVisibilityCollection(), $query);
            } catch (Throwable $e) {
                throw new ApiException('ai_visibility_collection_failed', 'AI 可见性采集失败：'.$this->publicFailure($e), 422);
            }
            /** @var AiVisibilityRun|null $run */
            $run = collect($runs)->last();
            if (! $run instanceof AiVisibilityRun) {
                throw new ApiException('ai_visibility_empty_result', 'AI 可见性服务没有返回运行记录', 422);
            }
            $run->load('sources');
            $sources = $run->sources->values();
            $answer = trim((string) $run->answer_text);

            // 两类归属分开测量，各自都要有可核验依据：
            //  · 品牌提及 = 回答正文里是否出现被测量品牌名。未声明品牌名则不可计算：
            //    brandName() 为空串会让判定恒为 false，把「无法测量」呈现成
            //    「模型没有推荐你」这一确定的负面结论。
            //  · 信源归属 = 引用主机是否属于自有域名（与竞品投影同口径的域名匹配）。
            //    此前按品牌名对 title/url/snippet 做子串匹配，第三方站点只要标题或路径
            //    带品牌名就会被算成自有信源并抬高信源占有率。
            $brandName = $this->brandName();
            $brandConfigured = $brandName !== '';
            $ownedDomains = $this->ownedBrandDomains();
            $ownedConfigured = $ownedDomains !== [];
            $owned = $ownedConfigured
                ? $sources->filter(fn (AiVisibilitySource $source): bool => $this->sourceMatchesDomains($source, $ownedDomains))
                : collect();
            $brandMentioned = $brandConfigured ? $this->containsBrand($answer) : null;

            $advice = is_array($run->analysis_json) ? array_values(array_filter(array_map('strval', (array) ($run->analysis_json['recommendations'] ?? $run->analysis_json['advice'] ?? [])))) : [];
            if ($advice === []) {
                $advice = match (true) {
                    ! $brandConfigured => ['尚未配置被测量品牌名称，无法判断回答是否提及你的品牌；请先在品牌实体中填写组织名称。'],
                    $brandMentioned === true => ['继续维护已被引用的页面并补充可核验事实。'],
                    default => ['补充与该问题直接相关的公开事实页面，并加入可追溯引用。'],
                };
            }
            // 沙盘和 collectQuery/benchmarkCompetitor 一样会真实发起 Provider 出站，
            // 此前是文件内唯一出站却无审计的操作，合规上无法追溯「谁在何时问了什么」。
            AdminActivityLogger::logFromRequest($request, $admin, 'api.sandbox.evaluated', [
                'query' => $query,
                'run_id' => (int) $run->id,
                'citation_count' => $sources->count(),
            ]);

            return $this->success($request, [
                'query' => $query,
                'targetEngine' => (string) ($request->input('targetEngine') ?: $run->provider_key ?: $run->provider_type),
                'simulatedAnswer' => $answer,
                'citations' => $sources->map(fn (AiVisibilitySource $source): array => [
                    'id' => (int) $source->rank ?: (int) $source->id,
                    'title' => (string) $source->title,
                    'url' => (string) $source->url,
                    'snippet' => (string) ($source->snippet ?: $source->summary),
                    'brandMatch' => $ownedConfigured ? $this->sourceMatchesDomains($source, $ownedDomains) : null,
                ])->all(),
                // 品牌名回传供前端标注信源归属：产品品牌（桐灼GEO）不是被测量品牌，不能硬编码。
                'brandConfigured' => $brandConfigured,
                'brandName' => $brandName,
                'brandMentioned' => $brandMentioned,
                // 情感判断需要可核验的标注数据源，当前未接入：按项目统一口径标为未采集，
                // 不给固定值冒充测量结果（此前硬编码 'neutral' 会让任何回答都显示「中性」）。
                'brandSentiment' => null,
                'brandSentimentStatus' => 'not_collected',
                'brandRecommendationGrade' => $brandMentioned === null ? null : ($brandMentioned ? '客观列举' : '未上榜'),
                'ownedDomains' => $ownedDomains,
                // 未声明自有域名或无引用记录时分母不可用：返回 0% 会被读成「占有率为零」
                // 这一测量结论，与竞品投影的 citation_share_percent 口径统一改为不可计算。
                'citationSharePercent' => $ownedConfigured && $sources->count() > 0
                    ? (int) round($owned->count() / $sources->count() * 100)
                    : null,
                'citationShareDenominator' => $sources->count(),
                'citationShareStatus' => ! $ownedConfigured
                    ? 'owned_domains_not_configured'
                    : ($sources->count() > 0 ? 'measured' : 'no_citation_records'),
                'actionableAdvice' => $advice,
                'timestamp' => $run->completed_at?->toISOString() ?: $run->created_at?->toISOString(),
                'run_id' => (int) $run->id,
                'status' => (string) $run->status,
            ]);
        });
    }

    /** @return array<string,mixed> */
    private function competitorProjection(int $days): array
    {
        $days = min(90, max(1, $days));
        $start = now()->subDays($days - 1)->startOfDay();
        $end = now()->endOfDay();
        $config = $this->normalizeCompetitorConfig($this->competitorConfig());
        $runs = AiVisibilityRun::query()
            ->with(['sources' => fn ($query) => $query
                ->select(['id', 'ai_visibility_run_id', 'title', 'url', 'domain', 'site_name', 'rank'])
                ->orderByRaw('COALESCE(rank, 999999) asc')
                ->orderBy('id')])
            ->where('status', AiVisibilityRun::STATUS_COMPLETED)
            ->where(function ($query) use ($start, $end): void {
                $query->whereBetween('completed_at', [$start, $end])
                    ->orWhere(function ($query) use ($start, $end): void {
                        $query->whereNull('completed_at')->whereBetween('created_at', [$start, $end]);
                    });
            })
            ->select(['id', 'uuid', 'keyword', 'provider_type', 'provider_key', 'model_id', 'status', 'completed_at', 'created_at'])
            ->orderBy('created_at')
            ->orderBy('id')
            ->get();
        $sources = $runs->flatMap(fn (AiVisibilityRun $run): Collection => $run->sources);
        $ownDomains = $this->ownedBrandDomains();
        $entities = collect([[
            'name' => $this->brandName(),
            'domains' => $ownDomains,
            'is_own_brand' => true,
        ]])->merge(collect($config['competitors'])->map(fn (array $competitor): array => [
            'name' => $competitor['name'],
            'domains' => $competitor['domains'],
            'is_own_brand' => false,
        ]));
        $totalCitations = $sources->count();
        $competitors = $entities->map(function (array $entity) use ($sources, $runs, $totalCitations): array {
            $domains = $entity['domains'];
            $matched = $domains === []
                ? collect()
                : $sources->filter(fn (AiVisibilitySource $source): bool => $this->sourceMatchesDomains($source, $domains));
            $ranked = $matched->filter(fn (AiVisibilitySource $source): bool => (int) $source->rank > 0);
            $queryCount = $runs->filter(fn (AiVisibilityRun $run): bool => $run->sources->contains(
                fn (AiVisibilitySource $source): bool => $domains !== [] && $this->sourceMatchesDomains($source, $domains),
            ))->map(fn (AiVisibilityRun $run): string => mb_strtolower(trim((string) $run->keyword)))->filter()->unique()->count();

            return [
                'brand_name' => $entity['name'],
                'is_own_brand' => $entity['is_own_brand'],
                'domains' => $domains,
                'configured' => $domains !== [],
                'citation_observation_count' => $matched->count(),
                'citation_share_percent' => $domains !== [] && $totalCitations > 0
                    ? round($matched->count() / $totalCitations * 100, 1)
                    : null,
                'citation_share_denominator' => $totalCitations,
                'top3_citation_rate_percent' => $ranked->isNotEmpty()
                    ? round($ranked->where('rank', '<=', 3)->count() / $ranked->count() * 100, 1)
                    : null,
                'top3_citation_rate_denominator' => $ranked->count(),
                'average_citation_rank' => $ranked->isNotEmpty() ? round((float) $ranked->avg('rank'), 1) : null,
                'observed_query_count' => $queryCount,
                'sentiment' => null,
                'sentiment_status' => 'not_collected',
                'evidence' => $matched->take(10)->map(fn (AiVisibilitySource $source): array => [
                    'source_id' => (int) $source->id,
                    'run_id' => (int) $source->ai_visibility_run_id,
                    'title' => (string) $source->title,
                    'url' => (string) $source->url,
                    'domain' => $this->sourceHost($source),
                    'rank' => $source->rank !== null ? (int) $source->rank : null,
                ])->values()->all(),
                'availability' => $domains === []
                    ? 'domains_not_configured'
                    : ($totalCitations === 0 ? 'no_citation_records' : 'available'),
            ];
        })->values();
        $own = $competitors->firstWhere('is_own_brand', true);
        $rivals = $competitors->where('is_own_brand', false)->values();
        $blindspots = $runs->groupBy(fn (AiVisibilityRun $run): string => trim((string) $run->keyword))
            ->map(function (Collection $queryRuns, string $query) use ($ownDomains, $config): ?array {
                $querySources = $queryRuns->flatMap(fn (AiVisibilityRun $run): Collection => $run->sources);
                $ownCount = $ownDomains === [] ? 0 : $querySources->filter(
                    fn (AiVisibilitySource $source): bool => $this->sourceMatchesDomains($source, $ownDomains),
                )->count();
                $rivals = collect($config['competitors'])->map(function (array $competitor) use ($querySources): array {
                    $matched = $querySources->filter(
                        fn (AiVisibilitySource $source): bool => $this->sourceMatchesDomains($source, $competitor['domains']),
                    );

                    return ['name' => $competitor['name'], 'count' => $matched->count()];
                })->filter(fn (array $rival): bool => $rival['count'] > 0)->sortByDesc('count')->values();
                if ($query === '' || $ownDomains === [] || $ownCount > 0 || $rivals->isEmpty()) {
                    return null;
                }
                $leader = $rivals->first();

                return [
                    'query' => $query,
                    'winner_brand' => $leader['name'],
                    'competitor_citation_count' => $leader['count'],
                    'own_citation_count' => 0,
                    'run_ids' => $queryRuns->pluck('id')->map(fn ($id): int => (int) $id)->values()->all(),
                    'status' => 'own_brand_not_cited',
                    'impact_score' => null,
                ];
            })->filter()->values();

        return [
            'industry' => $config['industry'],
            'config' => [
                'industry' => $config['industry'],
                'own_brand' => ['name' => $this->brandName(), 'domains' => $ownDomains],
                'competitors' => $config['competitors'],
            ],
            'window' => ['days' => $days, 'start' => $start->toISOString(), 'end' => $end->toISOString()],
            'summary' => [
                'completed_run_count' => $runs->count(),
                'citation_observation_count' => $totalCitations,
                'configured_competitor_count' => count($config['competitors']),
                'blindspot_query_count' => $blindspots->count(),
                'own_brand_configured' => $ownDomains !== [],
                'own_citation_share_percent' => $own['citation_share_percent'] ?? null,
                'observed_provider_count' => $runs->map(fn (AiVisibilityRun $run): string => (string) ($run->provider_key ?: $run->provider_type))->filter()->unique()->count(),
            ],
            'evaluated_engines' => $runs->map(fn (AiVisibilityRun $run): string => (string) ($run->provider_key ?: $run->provider_type))->filter()->unique()->values()->all(),
            'competitors' => $competitors->all(),
            'blindspots' => $blindspots->all(),
            'observed_at' => $runs->map(fn (AiVisibilityRun $run) => $run->completed_at ?: $run->created_at)->filter()->max()?->toISOString(),
            'definitions' => [
                'citation_share_percent' => '该品牌配置域名匹配的引用记录数 / 时间窗内全部引用记录数。',
                'top3_citation_rate_percent' => '该品牌有有效位次的引用中，rank 小于等于 3 的记录数 / 该品牌全部有效位次引用数。',
                'average_citation_rank' => '该品牌引用记录中所有有效 rank 的算术平均值。',
                'sentiment' => '当前未接入可核验的品牌情感标注数据源，因此不可计算。',
                'impact_score' => '当前未定义可信权重、外部问题量或业务影响分母，因此不计算影响指数。',
            ],
            'source' => ['kind' => 'geoflow_database', 'estimated' => false],
        ];
    }

    /** @return array<string,mixed> */
    private function brandProjection(): array
    {
        $config = $this->normalizeBrandConfig($this->brandConfig());
        $json = ['@context' => 'https://schema.org', '@type' => 'Organization', 'name' => $config['organizationName'], 'alternateName' => $config['alternateName'], 'legalName' => $config['legalName'], 'url' => $config['officialDomain'], 'logo' => $config['logoUrl'], 'description' => $config['description'], 'sameAs' => array_values(array_filter(array_map(fn ($link) => is_array($link) ? ($link['url'] ?? null) : null, $config['sameAsLinks']))), 'founder' => $config['founders'], 'email' => $config['contactEmail']];
        $publishedArticleCount = Article::query()->whereIn('status', ['published', 'private'])->count();
        $sameAsCount = count($config['sameAsLinks']);

        // E-E-A-T 没有可核验的评分模型与统计分母，所以既不输出品牌总分，也不给维度打分——
        // 之前按「文章数×5 + 创始人×10」这类固定公式算分并取平均，是把编造的数字标成真实测量。
        // 这里只呈现两类可核验事实：运营方配置了什么、真实计数是多少；缺什么直接列出来。
        $configuredFields = [
            'organizationName' => $config['organizationName'] !== '',
            'legalName' => $config['legalName'] !== '',
            'officialDomain' => $config['officialDomain'] !== '',
            'contactEmail' => $config['contactEmail'] !== '',
            'logoUrl' => $config['logoUrl'] !== '',
            'description' => $config['description'] !== '',
            'sameAsLinks' => $sameAsCount > 0,
            'founders' => count($config['founders']) > 0,
        ];

        return ['config' => $config, 'eeatReport' => [
            'brandOverallScore' => null,
            'score_status' => 'not_computable',
            'score_reason' => '当前没有可核验的 E-E-A-T 评分模型与统计分母，因此不输出品牌总分与各维度分数。以下为可核验的配置完整度与真实计数。',
            'configured_fields' => $configuredFields,
            'missing_fields' => array_keys(array_filter($configuredFields, static fn (bool $ok): bool => ! $ok)),
            'counts' => [
                'published_article_count' => $publishedArticleCount,
                'same_as_link_count' => $sameAsCount,
                'founder_count' => count($config['founders']),
            ],
            'jsonLdScriptPreview' => json_encode($json, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        ], 'jsonLdScript' => json_encode($json, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), 'source' => ['kind' => 'geoflow_database', 'estimated' => false]];
    }

    private function resolveKeyword(mixed $keywordId, string $query): ?Keyword
    {
        $keyword = $keywordId !== null
            ? Keyword::query()->find((int) $keywordId)
            : Keyword::query()->whereRaw('LOWER(TRIM(keyword)) = ?', [mb_strtolower($query)])->first();
        if ($keywordId !== null && (! $keyword || mb_strtolower(trim((string) $keyword->keyword)) !== mb_strtolower($query))) {
            throw new ApiException('query_radar_keyword_mismatch', 'keyword_id 与 query 不匹配', 422, [
                'keyword_id' => (int) $keywordId,
            ]);
        }

        return $keyword;
    }

    /** @return array<string, mixed> */
    private function collectedRunProjection(AiVisibilityRun $run): array
    {
        return [
            'id' => (int) $run->id,
            'uuid' => (string) $run->uuid,
            'provider_type' => (string) $run->provider_type,
            'provider_key' => (string) $run->provider_key,
            'model_id' => (string) $run->model_id,
            'status' => (string) $run->status,
            'completed_at' => ($run->completed_at ?: $run->created_at)?->toISOString(),
        ];
    }

    /** @param Collection<int, AiVisibilityRun> $runs @return array<string, mixed> */
    private function draftEvidenceSnapshot(Collection $runs): array
    {
        return [
            'version' => 1,
            'captured_at' => now()->toISOString(),
            'runs' => $runs->map(fn (AiVisibilityRun $run): array => [
                'run_id' => (int) $run->id,
                'run_uuid' => (string) $run->uuid,
                'provider_type' => (string) $run->provider_type,
                'provider_key' => (string) $run->provider_key,
                'model_id' => (string) $run->model_id,
                'completed_at' => ($run->completed_at ?: $run->created_at)?->toISOString(),
                'answer_sha256' => hash('sha256', (string) $run->answer_text),
                'sources' => $run->sources->take(20)->map(fn (AiVisibilitySource $source): array => [
                    'source_id' => (int) $source->id,
                    'title' => (string) $source->title,
                    'url' => (string) $source->url,
                    'domain' => (string) $source->domain,
                    'rank' => $source->rank !== null ? (int) $source->rank : null,
                ])->values()->all(),
            ])->values()->all(),
        ];
    }

    /** @param Collection<int, AiVisibilityRun> $runs */
    private function draftContent(string $query, Collection $runs): string
    {
        $lines = [
            '# '.$query,
            '',
            '> 证据草稿：内容来自 桐灼GEO 已持久化的 AI 可见性回答与引用记录，仍需人工核验和质量审核后才能发布。',
        ];
        foreach ($runs as $index => $run) {
            $provider = trim((string) ($run->provider_key ?: $run->provider_type)) ?: 'unknown-provider';
            $model = trim((string) $run->model_id);
            $observedAt = ($run->completed_at ?: $run->created_at)?->toISOString() ?: 'unknown-time';
            $lines[] = '';
            $lines[] = '## 已采集回答 '.($index + 1);
            $lines[] = '';
            $lines[] = '- Provider：'.$provider;
            $lines[] = '- 模型版本：'.($model !== '' ? $model : '未记录');
            $lines[] = '- 采集时间：'.$observedAt;
            $lines[] = '- 运行记录：#'.(int) $run->id;
            $lines[] = '';
            $lines[] = trim((string) $run->answer_text);
            $lines[] = '';
            $lines[] = '### 引用记录';
            foreach ($run->sources->take(20) as $source) {
                $lines[] = '- '.$this->markdownSource($source);
            }
        }

        return implode("\n", $lines)."\n";
    }

    private function markdownSource(AiVisibilitySource $source): string
    {
        $title = trim((string) ($source->title ?: $source->domain ?: $source->url)) ?: '未命名信源';
        $title = str_replace(['[', ']'], ['(', ')'], $title);
        $url = trim((string) $source->url);
        $scheme = mb_strtolower((string) parse_url($url, PHP_URL_SCHEME));

        return in_array($scheme, ['http', 'https'], true) ? '['.$title.']('.$url.')' : $title;
    }

    /** 请求级缓存：brandConfig() 被沙盘逐条引用、竞品投影多处调用，避免同请求内重复读同一 setting。 */
    private ?array $brandConfigCache = null;

    /** @return array<string, mixed> */
    private function brandConfig(): array
    {
        if ($this->brandConfigCache === null) {
            $raw = SiteSetting::query()->where('setting_key', self::BRAND_SETTING)->value('setting_value');
            $decoded = is_string($raw) ? json_decode($raw, true) : [];
            $this->brandConfigCache = is_array($decoded) ? $decoded : [];
        }

        return $this->brandConfigCache;
    }

    /** @return array<string,mixed> */
    private function competitorConfig(): array
    {
        $raw = SiteSetting::query()->where('setting_key', self::COMPETITOR_SETTING)->value('setting_value');
        $decoded = is_string($raw) ? json_decode($raw, true) : [];

        return is_array($decoded) ? $decoded : [];
    }

    /** @return array{industry:string,competitors:list<array{name:string,domains:list<string>>}>} */
    private function normalizeCompetitorConfig(array $config): array
    {
        $competitors = collect((array) ($config['competitors'] ?? []))
            ->map(function (mixed $item): ?array {
                if (is_string($item)) {
                    $name = trim($item);

                    return $name === '' ? null : ['name' => $name, 'domains' => []];
                }
                if (! is_array($item)) {
                    return null;
                }
                $name = trim((string) ($item['name'] ?? $item['brandName'] ?? ''));
                $domains = collect((array) ($item['domains'] ?? ($item['domain'] ?? [])))
                    ->map(fn (mixed $domain): string => $this->normalizeHost((string) $domain))
                    ->filter()
                    ->unique()
                    ->values()
                    ->all();

                return $name === '' ? null : ['name' => $name, 'domains' => $domains];
            })
            ->filter()
            ->unique(fn (array $item): string => mb_strtolower($item['name']))
            ->values()
            ->all();

        return [
            'industry' => trim((string) ($config['industry'] ?? '')),
            'competitors' => $competitors,
        ];
    }

    /** 自有品牌域名统一走 {@see BrandIdentity}：与查询雷达、沙盘同口径。 @return list<string> */
    private function ownedBrandDomains(): array
    {
        // 曾经这里无条件并入 geoflow.site_url / app.url，未配置任何品牌时也会得到非空域名，
        // 于是 own_brand 被报成「已配置」、`domains_not_configured` 永远不会出现，
        // 并且用站点默认地址冒充被测量的客户品牌去匹配引用。
        return BrandIdentity::ownedHosts();
    }

    /** @param list<string> $domains */
    private function sourceMatchesDomains(AiVisibilitySource $source, array $domains): bool
    {
        $host = $this->sourceHost($source);
        foreach ($domains as $domain) {
            if ($host === $domain || str_ends_with($host, '.'.$domain)) {
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

    /** @return array<string,mixed> */
    private function normalizeBrandConfig(array $config): array
    {
        return array_replace(['organizationName' => '', 'alternateName' => '', 'legalName' => '', 'foundingDate' => '', 'officialDomain' => '', 'logoUrl' => '', 'description' => '', 'sameAsLinks' => [], 'founders' => [], 'awardsAndCertifications' => [], 'contactEmail' => ''], $config);
    }

    /** 展示用的主品牌名；未声明组织名时回落到别名/法定名。 */
    private function brandName(): string
    {
        return BrandIdentity::names()[0] ?? '';
    }

    /**
     * 提及判定必须用全部已声明的名称（组织名/别名/法定名）。
     * 只认 organizationName 会把「只命中了别名」漏判成未被提及，进而输出确定的负面结论。
     */
    private function containsBrand(string $text): bool
    {
        foreach (BrandIdentity::names() as $name) {
            if (mb_stripos($text, $name) !== false) {
                return true;
            }
        }

        return false;
    }

    private function publicFailure(Throwable $e): string
    {
        $message = trim($e->getMessage());

        return preg_match('/\A[a-z0-9_.:-]{1,100}\z/', $message) === 1 ? $message : 'provider_request_failed';
    }
}
