<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Jobs\ProcessArticleDistributionJob;
use App\Models\Article;
use App\Models\ArticleDistribution;
use App\Models\DistributionChannel;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\DistributionOrchestrator;
use Illuminate\Database\DatabaseManager;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * API v1 文章分发：将已通过文章门禁的内容送入真实分发队列，并提供回执查询与失败重试。
 *
 * 这里不直接调用远端站点。所有远端副作用都由 DistributionOrchestrator + Worker 完成，
 * 因此 API 返回的是本地 ArticleDistribution 入队回执，而不是伪造的“已发布”。
 */
class DistributionArticleController extends BaseApiController
{
    public function index(Request $request): JsonResponse
    {
        $query = ArticleDistribution::query()
            ->with([
                'article:id,title,slug,status',
                'channel:id,name,domain,endpoint_url,status,channel_type',
            ])
            ->orderByDesc('id');

        $status = trim((string) $request->query('status', ''));
        if ($status !== '') {
            if (! in_array($status, ['queued', 'sending', 'synced', 'failed', 'outcome_unknown'], true)) {
                throw new ApiException('invalid_distribution_status', '分发任务状态无效', 422);
            }
            $query->where('status', $status);
        }

        $channelId = $request->integer('channel_id', 0);
        if ($channelId > 0) {
            $query->where('distribution_channel_id', $channelId);
        }
        $articleId = $request->integer('article_id', 0);
        if ($articleId > 0) {
            $query->where('article_id', $articleId);
        }

        $perPage = min(100, max(1, $request->integer('per_page', 20)));
        $page = $query->paginate($perPage, ['*'], 'page', max(1, $request->integer('page', 1)));

        return $this->success($request, [
            'items' => $page->getCollection()->map(fn (ArticleDistribution $item): array => $this->projection($item))->values()->all(),
            'pagination' => [
                'page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'total_pages' => $page->lastPage(),
            ],
        ]);
    }

    public function forArticle(Request $request, int $article): JsonResponse
    {
        $record = Article::query()->whereKey($article)->first();
        if (! $record) {
            throw new ApiException('article_not_found', '文章不存在', 404);
        }

        $items = ArticleDistribution::query()
            ->with(['article:id,title,slug,status', 'channel:id,name,domain,endpoint_url,status,channel_type'])
            ->where('article_id', $article)
            ->orderByDesc('id')
            ->get()
            ->map(fn (ArticleDistribution $item): array => $this->projection($item))
            ->values()
            ->all();

        return $this->success($request, [
            'article_id' => $article,
            'items' => $items,
        ]);
    }

    public function enqueue(Request $request, int $article, DistributionOrchestrator $orchestrator): JsonResponse
    {
        $auth = $this->auth($request);
        $record = Article::query()->with('task.distributionChannels')->whereKey($article)->first();
        if (! $record) {
            throw new ApiException('article_not_found', '文章不存在', 404);
        }

        $channelIds = $this->channelIds($request);
        if ($channelIds !== [] && $record->task_id === null) {
            throw new ApiException('article_distribution_task_required', '文章必须关联任务后才能分发', 409);
        }
        if ($channelIds !== []) {
            $attachedActiveChannelIds = $record->task?->distributionChannels
                ?->where('status', DistributionChannel::STATUS_ACTIVE)
                ->pluck('id')
                ->map(static fn ($id): int => (int) $id)
                ->all() ?? [];
            $unboundChannelIds = array_values(array_diff($channelIds, $attachedActiveChannelIds));
            if ($unboundChannelIds !== []) {
                throw new ApiException('distribution_channel_not_bound', '指定渠道必须先关联到文章所属任务且处于启用状态', 409, [
                    'channel_ids' => $unboundChannelIds,
                ]);
            }
        }

        return IdempotencyService::executeJson($request, 'POST /articles/{id}/distribute', function () use ($request, $record, $channelIds, $orchestrator, $auth): JsonResponse {
            try {
                $ids = $channelIds !== []
                    ? $orchestrator->enqueueForArticleTargets($record, $channelIds, [], 'publish')
                    : $orchestrator->enqueueForArticle($record, 'publish', [], true);
            } catch (ApiException $exception) {
                throw $exception;
            } catch (Throwable $exception) {
                report($exception);
                throw new ApiException('distribution_enqueue_failed', '文章分发入队失败，请检查文章门禁和渠道配置', 409, [
                    'article_id' => (int) $record->id,
                ]);
            }

            if ($ids === []) {
                throw new ApiException('distribution_target_missing', '没有可用的活动分发渠道，请先配置并关联渠道', 409, [
                    'article_id' => (int) $record->id,
                ]);
            }

            $items = ArticleDistribution::query()
                ->with(['article:id,title,slug,status', 'channel:id,name,domain,endpoint_url,status,channel_type'])
                ->whereIn('id', $ids)
                ->orderBy('id')
                ->get()
                ->map(fn (ArticleDistribution $item): array => $this->projection($item))
                ->values()
                ->all();

            return $this->success($request, [
                'article_id' => (int) $record->id,
                'action' => 'publish',
                'queued_distribution_ids' => array_values(array_map('intval', $ids)),
                'items' => $items,
                'requested_by_admin_id' => $auth->auditAdminId,
            ], 202);
        });
    }

    public function retry(Request $request, int $distribution, DatabaseManager $database): JsonResponse
    {
        $auth = $this->auth($request);

        return IdempotencyService::executeJson($request, 'POST /distribution/jobs/{id}/retry', function () use ($request, $distribution, $database, $auth): JsonResponse {
            $record = $database->transaction(function () use ($distribution, $auth): ArticleDistribution {
                $job = ArticleDistribution::query()->whereKey($distribution)->lockForUpdate()->first();
                if (! $job) {
                    throw new ApiException('distribution_job_not_found', '分发任务不存在', 404);
                }
                if ((string) $job->status === 'sending') {
                    throw new ApiException('distribution_retry_in_progress', '分发任务正在发送中，不能重复重试', 409);
                }
                if ((string) $job->status === 'outcome_unknown') {
                    throw new ApiException('distribution_outcome_unknown', '远端结果未确认，请先完成人工对账', 409);
                }
                if (! in_array((string) $job->status, ['failed', 'queued'], true)) {
                    throw new ApiException('distribution_retry_not_allowed', '当前分发任务状态不允许重试', 409);
                }

                $channel = DistributionChannel::query()->whereKey((int) $job->distribution_channel_id)->lockForUpdate()->first();
                if (! $channel || (string) $channel->status !== DistributionChannel::STATUS_ACTIVE) {
                    throw new ApiException('distribution_channel_unavailable', '分发渠道当前不可用', 409);
                }

                $article = Article::query()->whereKey((int) $job->article_id)->lockForUpdate()->first();
                if (! $article) {
                    throw new ApiException('article_not_found', '文章不存在', 404);
                }
                if (! in_array((string) $article->status, ['published', 'private'], true)) {
                    throw new ApiException('article_not_publishable', '文章当前状态不允许重试分发', 409);
                }

                $job->forceFill([
                    'status' => 'queued',
                    'last_error_message' => null,
                    'next_retry_at' => now(),
                ])->save();

                DB::table('distribution_logs')->insert([
                    'distribution_channel_id' => (int) $job->distribution_channel_id,
                    'article_distribution_id' => (int) $job->id,
                    'article_id' => (int) $job->article_id,
                    'level' => 'info',
                    'event' => 'distribution.retry_queued',
                    'message' => 'API 请求已将文章分发任务重新入队。',
                    'context' => json_encode(['admin_id' => $auth->auditAdminId], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                    'created_at' => now(),
                ]);

                ProcessArticleDistributionJob::dispatch((int) $job->id)
                    ->onQueue('distribution')
                    ->afterCommit();

                return $job->fresh(['article:id,title,slug,status', 'channel:id,name,domain,endpoint_url,status,channel_type']);
            });

            return $this->success($request, [
                'job' => $this->projection($record),
            ], 202);
        });
    }

    /** @return list<int> */
    private function channelIds(Request $request): array
    {
        $raw = $request->input('channel_ids', $request->input('channelIds', []));
        if ($raw === null || $raw === '') {
            return [];
        }
        if (! is_array($raw)) {
            throw new ApiException('invalid_distribution_channels', 'channel_ids 必须是数组', 422);
        }

        $ids = collect($raw)->map(static function (mixed $value): int {
            if (! is_numeric($value) || (int) $value <= 0 || (string) (int) $value !== (string) $value && ! is_int($value)) {
                throw new ApiException('invalid_distribution_channels', 'channel_ids 包含无效渠道 ID', 422);
            }

            return (int) $value;
        })->unique()->values()->all();

        if (count($ids) > 50) {
            throw new ApiException('invalid_distribution_channels', '单次最多选择 50 个分发渠道', 422);
        }

        return array_values(array_map('intval', $ids));
    }

    /** @return array<string,mixed> */
    private function projection(ArticleDistribution $item): array
    {
        return [
            'id' => (int) $item->id,
            'article_id' => (int) $item->article_id,
            'article' => $item->article ? [
                'id' => (int) $item->article->id,
                'title' => (string) $item->article->title,
                'slug' => (string) ($item->article->slug ?? ''),
                'status' => (string) $item->article->status,
            ] : null,
            'channel_id' => (int) $item->distribution_channel_id,
            'channel' => $item->channel ? [
                'id' => (int) $item->channel->id,
                'name' => (string) $item->channel->name,
                'domain' => (string) ($item->channel->domain ?? ''),
                'endpoint_url' => (string) ($item->channel->endpoint_url ?? ''),
                'status' => (string) $item->channel->status,
                'channel_type' => (string) $item->channel->channel_type,
            ] : null,
            'action' => (string) $item->action,
            'status' => (string) $item->status,
            'remote_id' => $item->remote_id,
            'remote_url' => $item->remote_url,
            'attempt_count' => (int) $item->attempt_count,
            'next_retry_at' => $item->next_retry_at?->toIso8601String(),
            'last_attempt_at' => $item->last_attempt_at?->toIso8601String(),
            'last_error_message' => $item->last_error_message,
            'created_at' => $item->created_at?->toIso8601String(),
            'updated_at' => $item->updated_at?->toIso8601String(),
        ];
    }
}
