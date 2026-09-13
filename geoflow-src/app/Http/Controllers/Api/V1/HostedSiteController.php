<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Models\Article;
use App\Models\DistributionChannel;
use App\Models\HostedSiteAllocationRequest;
use App\Models\HostedSiteArticleAssignment;
use App\Models\HostedSiteProfile;
use App\Models\LeadForm;
use App\Models\LeadSubmission;
use App\Services\Api\IdempotencyService;
use App\Services\HostedSites\HostedSiteAllocationRequestService;
use App\Services\HostedSites\HostedSiteAllocator;
use App\Services\HostedSites\HostedSiteLifecycleService;
use App\Services\HostedSites\HostedSiteQualityService;
use App\Services\Site\HostedSiteResolver;
use App\Support\AdminWeb;
use App\Support\Site\SiteThemeCatalog;
use DomainException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

final class HostedSiteController extends BaseApiController
{
    public function index(Request $request): JsonResponse
    {
        $this->requireSuperAdmin($request);
        $perPage = min(100, max(1, $request->integer('per_page', 20)));
        $page = DistributionChannel::query()
            ->with('hostedSiteProfile')
            ->where('channel_type', DistributionChannel::TYPE_HOSTED_SITE)
            ->withCount([
                'articleDistributions as pending_count' => fn ($query) => $query->whereIn('status', ['queued', 'sending']),
                'articleDistributions as failed_count' => fn ($query) => $query->whereIn('status', ['failed', 'outcome_unknown']),
                'articleDistributions as articles_count',
            ])
            ->orderByDesc('id')
            ->paginate($perPage, ['*'], 'page', max(1, $request->integer('page', 1)));

        return $this->success($request, [
            'items' => $page->getCollection()->map(fn (DistributionChannel $channel): array => $this->projection($channel))->values()->all(),
            'pagination' => [
                'page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'total_pages' => $page->lastPage(),
            ],
            'themes' => app(SiteThemeCatalog::class)->hostedCompatible(),
        ]);
    }

    public function show(Request $request, int $hostedSite): JsonResponse
    {
        $this->requireSuperAdmin($request);
        $channel = $this->findHosted($hostedSite);

        return $this->success($request, ['hosted_site' => $this->detailProjection($channel)]);
    }

    public function store(Request $request, HostedSiteLifecycleService $lifecycle): JsonResponse
    {
        $admin = $this->requireSuperAdmin($request);
        $this->requireIdempotencyKey($request);

        return IdempotencyService::executeJson($request, 'POST /distribution/hosted-sites', function () use ($request, $lifecycle, $admin): JsonResponse {
            $payload = $this->validatedPayload($request);
            try {
                $channel = $lifecycle->create($payload, (int) $admin->id);
            } catch (DomainException $exception) {
                throw new ApiException('hosted_site_create_failed', $exception->getMessage(), 409);
            }

            return $this->success($request, ['hosted_site' => $this->detailProjection($channel->fresh('hostedSiteProfile'))], 201);
        });
    }

    public function update(Request $request, int $hostedSite, HostedSiteLifecycleService $lifecycle): JsonResponse
    {
        $this->requireSuperAdmin($request);
        $this->requireIdempotencyKey($request);
        $channel = $this->findHosted($hostedSite);
        $payload = $this->validatedPayload($request, $channel);

        return IdempotencyService::executeJson($request, 'PATCH /distribution/hosted-sites/{id}', function () use ($request, $lifecycle, $payload, $channel): JsonResponse {
            try {
                $updated = $lifecycle->update($channel, $payload);
            } catch (DomainException $exception) {
                throw new ApiException('hosted_site_update_failed', $exception->getMessage(), 409);
            }

            return $this->success($request, ['hosted_site' => $this->detailProjection($updated)]);
        });
    }

    public function preflight(Request $request, int $hostedSite, HostedSiteQualityService $quality): JsonResponse
    {
        $this->requireSuperAdmin($request);
        $this->requireIdempotencyKey($request);
        $channel = $this->findHosted($hostedSite);

        return IdempotencyService::executeJson($request, 'POST /distribution/hosted-sites/{id}/preflight', function () use ($request, $quality, $channel): JsonResponse {
            $result = $quality->preflight($channel);

            return $this->success($request, [
                'hosted_site' => $this->detailProjection($channel->fresh('hostedSiteProfile')),
                'preflight' => $result,
            ]);
        });
    }

    public function activate(Request $request, int $hostedSite, HostedSiteLifecycleService $lifecycle): JsonResponse
    {
        return $this->lifecycleAction($request, $hostedSite, 'activate', $lifecycle);
    }

    public function pause(Request $request, int $hostedSite, HostedSiteLifecycleService $lifecycle): JsonResponse
    {
        return $this->lifecycleAction($request, $hostedSite, 'pause', $lifecycle);
    }

    public function maintenance(Request $request, int $hostedSite, HostedSiteLifecycleService $lifecycle): JsonResponse
    {
        return $this->lifecycleAction($request, $hostedSite, 'maintenance', $lifecycle);
    }

    public function indexing(Request $request, int $hostedSite, HostedSiteLifecycleService $lifecycle): JsonResponse
    {
        $this->requireSuperAdmin($request);
        $this->requireIdempotencyKey($request);
        $payload = $request->validate([
            'indexing_status' => ['required', Rule::in([HostedSiteProfile::INDEXING_INDEX, HostedSiteProfile::INDEXING_NOINDEX])],
            'quality_confirmed' => ['nullable', 'boolean'],
        ]);
        $channel = $this->findHosted($hostedSite);

        return IdempotencyService::executeJson($request, 'POST /distribution/hosted-sites/{id}/indexing', function () use ($request, $lifecycle, $channel, $payload): JsonResponse {
            try {
                $updated = $lifecycle->setIndexing($channel, (string) $payload['indexing_status'], (bool) ($payload['quality_confirmed'] ?? false));
            } catch (DomainException $exception) {
                throw new ApiException('hosted_site_indexing_failed', $exception->getMessage(), 409);
            }

            return $this->success($request, ['hosted_site' => $this->detailProjection($updated)]);
        });
    }

    public function archive(Request $request, int $hostedSite, HostedSiteLifecycleService $lifecycle): JsonResponse
    {
        $this->requireSuperAdmin($request);
        $this->requireIdempotencyKey($request);
        $payload = $request->validate(['hostname' => ['required', 'string', 'max:253']]);
        $channel = $this->findHosted($hostedSite);

        return IdempotencyService::executeJson($request, 'POST /distribution/hosted-sites/{id}/archive', function () use ($request, $lifecycle, $channel, $payload): JsonResponse {
            try {
                $lifecycle->archive($channel, (string) $payload['hostname']);
            } catch (DomainException $exception) {
                throw new ApiException('hosted_site_archive_failed', $exception->getMessage(), 409);
            }

            return $this->success($request, ['hosted_site' => $this->detailProjection($channel->fresh('hostedSiteProfile'))]);
        });
    }

    public function assignArticle(Request $request, int $hostedSite, HostedSiteAllocationRequestService $requests, HostedSiteAllocator $allocator): JsonResponse
    {
        $this->requireSuperAdmin($request);
        $this->requireIdempotencyKey($request);
        $payload = $request->validate(['article_id' => ['required', 'integer', 'exists:articles,id']]);
        $channel = $this->findHosted($hostedSite);
        $article = Article::query()->with('task.distributionChannels')->findOrFail((int) $payload['article_id']);

        return IdempotencyService::executeJson($request, 'POST /distribution/hosted-sites/{id}/articles', function () use ($request, $requests, $allocator, $channel, $article): JsonResponse {
            try {
                $allocationRequest = $requests->request($article);
                if ((int) $allocationRequest->hosted_site_profile_id !== (int) $channel->hostedSiteProfile?->id) {
                    throw new DomainException('文章任务没有精确绑定当前托管站点。');
                }
                $assignment = $allocator->allocate($allocationRequest);
            } catch (DomainException $exception) {
                throw new ApiException('hosted_site_allocation_failed', $exception->getMessage(), 409);
            }
            if (! $assignment instanceof HostedSiteArticleAssignment) {
                $failed = HostedSiteAllocationRequest::query()->where('article_id', (int) $article->id)->first();
                throw new ApiException('hosted_site_allocation_deferred', (string) ($failed?->last_error_message ?: '当前无法分配托管站点容量'), 409, [
                    'allocation_request' => $failed ? $this->allocationProjection($failed) : null,
                ]);
            }

            return $this->success($request, [
                'assignment' => $this->assignmentProjection($assignment->fresh('article')),
                'allocation_request' => $this->allocationProjection($assignment->allocationRequest()->first()),
            ], 202);
        });
    }

    private function lifecycleAction(Request $request, int $id, string $action, HostedSiteLifecycleService $lifecycle): JsonResponse
    {
        $this->requireSuperAdmin($request);
        $this->requireIdempotencyKey($request);
        $channel = $this->findHosted($id);

        return IdempotencyService::executeJson($request, 'POST /distribution/hosted-sites/{id}/'.$action, function () use ($request, $lifecycle, $channel, $action): JsonResponse {
            try {
                $updated = $lifecycle->{$action}($channel);
            } catch (DomainException $exception) {
                throw new ApiException('hosted_site_'.$action.'_failed', $exception->getMessage(), 409);
            }

            return $this->success($request, ['hosted_site' => $this->detailProjection($updated)]);
        });
    }

    /** @return array<string,mixed> */
    private function validatedPayload(Request $request, ?DistributionChannel $channel = null): array
    {
        $payload = $request->all();
        $payload['hostname'] = strtolower(rtrim(trim((string) ($payload['hostname'] ?? '')), '.'));
        $payload['lead_form_slugs'] = collect((array) ($payload['lead_form_slugs'] ?? []))
            ->map(static fn (mixed $slug): string => trim((string) $slug))
            ->filter()
            ->unique()
            ->values()
            ->all();

        $validator = Validator::make($payload, [
            'name' => ['required', 'string', 'max:120'],
            'hostname' => [
                'required', 'string', 'max:253',
                'regex:/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/',
                Rule::unique('hosted_site_profiles', 'hostname')->ignore($channel?->hostedSiteProfile?->id),
            ],
            'topic' => ['required', 'string', 'max:160'],
            'locale' => ['required', 'string', Rule::in(array_keys(AdminWeb::supportedLocales()))],
            'timezone' => ['required', 'timezone:all'],
            'daily_publish_limit' => ['required', 'integer', 'min:1', 'max:1000'],
            'publish_weight' => ['nullable', 'integer', 'min:1', 'max:1000'],
            'min_publish_interval_minutes' => ['required', 'integer', 'min:0', 'max:525600'],
            'min_articles_before_index' => ['required', 'integer', 'min:1', 'max:50000'],
            'template_key' => [
                'required', 'string', 'regex:/^[a-zA-Z0-9_-]+$/', 'max:120',
                Rule::in(app(SiteThemeCatalog::class)->hostedCompatibleIds()),
            ],
            'site_description' => ['nullable', 'string', 'max:1000'],
            'site_keywords' => ['nullable', 'string', 'max:500'],
            'about_title' => ['nullable', 'string', 'max:160'],
            'about_content' => ['nullable', 'string', 'max:20000'],
            'contact_email' => ['nullable', 'email', 'max:254'],
            'lead_form_slugs' => ['nullable', 'array', 'max:20'],
            'lead_form_slugs.*' => [
                'string', 'max:120', 'distinct',
                Rule::exists('lead_forms', 'slug')->where('status', LeadForm::STATUS_ACTIVE),
            ],
        ]);
        $validator->after(function ($validator) use ($payload): void {
            if (! app(HostedSiteResolver::class)->isSingleLabelHostedHostname((string) ($payload['hostname'] ?? ''))) {
                $validator->errors()->add('hostname', '域名必须是已配置根域下的单层、非保留二级域名。');
            }
        });

        if ($validator->fails()) {
            throw new ValidationException($validator);
        }

        return $validator->validated();
    }

    private function requireSuperAdmin(Request $request): Admin
    {
        $admin = $this->executionAdmin($request);
        if (! $admin->isSuperAdmin()) {
            throw new ApiException('forbidden', 'Hosted Site 管理仅限超级管理员', 403, ['required_role' => 'super_admin']);
        }

        return $admin;
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }

    private function findHosted(int $id): DistributionChannel
    {
        $channel = DistributionChannel::query()->with('hostedSiteProfile')->whereKey($id)->first();
        if (! $channel || ! $channel->isHostedSite() || ! $channel->hostedSiteProfile) {
            throw new ApiException('hosted_site_not_found', '托管站点不存在', 404);
        }

        return $channel;
    }

    /** @return array<string,mixed> */
    private function projection(DistributionChannel $channel): array
    {
        $profile = $channel->hostedSiteProfile;
        $today = $profile ? now($profile->timezone)->toDateString() : now()->toDateString();
        $todayUsed = $profile?->assignments()->whereDate('capacity_date', $today)->whereIn('status', [HostedSiteArticleAssignment::STATUS_RESERVED, HostedSiteArticleAssignment::STATUS_PUBLISHED])->count() ?? 0;

        return [
            'id' => (int) $channel->id,
            'name' => (string) $channel->name,
            'domain' => (string) $channel->domain,
            'endpoint_url' => (string) $channel->endpoint_url,
            'channel_type' => (string) $channel->channel_type,
            'status' => (string) $channel->status,
            'profile' => $profile ? $this->profileProjection($profile, $todayUsed) : null,
            'pending_count' => (int) ($channel->pending_count ?? 0),
            'failed_count' => (int) ($channel->failed_count ?? 0),
            'articles_count' => (int) ($channel->articles_count ?? 0),
            'last_health_status' => (string) ($channel->last_health_status ?? 'not_checked'),
            'last_health_checked_at' => $channel->last_health_checked_at?->toIso8601String(),
            'last_error_message' => $channel->last_error_message,
        ];
    }

    /** @return array<string,mixed> */
    private function detailProjection(DistributionChannel $channel): array
    {
        $profile = $channel->hostedSiteProfile;
        $today = $profile ? now($profile->timezone)->toDateString() : now()->toDateString();
        $todayUsed = $profile?->assignments()->whereDate('capacity_date', $today)->whereIn('status', [HostedSiteArticleAssignment::STATUS_RESERVED, HostedSiteArticleAssignment::STATUS_PUBLISHED])->count() ?? 0;
        $assignments = $profile?->assignments()->with('article:id,title,slug,status')->latest('id')->limit(20)->get() ?? collect();
        $allocationRequests = HostedSiteAllocationRequest::query()->with('article:id,title,slug')->where('hosted_site_profile_id', $profile?->id)->latest('id')->limit(20)->get();
        $boundTasks = $channel->tasks()->select(['tasks.id', 'tasks.name', 'tasks.status', 'tasks.publish_scope'])->orderBy('tasks.id')->get();

        return $this->projection($channel) + [
            'site_settings' => is_array($channel->site_settings) ? $channel->site_settings : [],
            'preflight' => data_get($channel->channel_config, 'hosted_site_preflight'),
            'assignments' => $assignments->map(fn (HostedSiteArticleAssignment $assignment): array => $this->assignmentProjection($assignment))->values()->all(),
            'allocation_requests' => $allocationRequests->map(fn (HostedSiteAllocationRequest $allocation): array => $this->allocationProjection($allocation))->values()->all(),
            'bound_tasks' => $boundTasks->map(fn ($task): array => ['id' => (int) $task->id, 'name' => (string) $task->name, 'status' => (string) $task->status, 'publish_scope' => (string) $task->publish_scope])->values()->all(),
            'view_count' => Schema::hasColumn('view_logs', 'hosted_site_profile_id') ? DB::table('view_logs')->where('hosted_site_profile_id', $profile?->id)->count() : 0,
            'lead_count' => Schema::hasTable('lead_submissions') ? LeadSubmission::query()->where('hosted_site_profile_id', $profile?->id)->count() : 0,
        ];
    }

    /** @return array<string,mixed> */
    private function profileProjection(HostedSiteProfile $profile, int $todayUsed): array
    {
        return [
            'id' => (int) $profile->id,
            'hostname' => (string) $profile->hostname,
            'root_domain' => (string) $profile->root_domain,
            'topic' => (string) $profile->topic,
            'locale' => (string) $profile->locale,
            'timezone' => (string) $profile->timezone,
            'daily_publish_limit' => (int) $profile->daily_publish_limit,
            'today_used_count' => $todayUsed,
            'publish_weight' => (int) $profile->publish_weight,
            'min_publish_interval_minutes' => (int) $profile->min_publish_interval_minutes,
            'min_articles_before_index' => (int) $profile->min_articles_before_index,
            'serving_status' => (string) $profile->serving_status,
            'indexing_status' => (string) $profile->indexing_status,
            'quality_status' => (string) $profile->quality_status,
            'settings_version' => (int) $profile->settings_version,
            'last_published_at' => $profile->last_published_at?->toIso8601String(),
            'activated_at' => $profile->activated_at?->toIso8601String(),
            'indexed_at' => $profile->indexed_at?->toIso8601String(),
            'archived_at' => $profile->archived_at?->toIso8601String(),
        ];
    }

    /** @return array<string,mixed> */
    private function assignmentProjection(?HostedSiteArticleAssignment $assignment): array
    {
        if (! $assignment) {
            return [];
        }

        return [
            'id' => (int) $assignment->id,
            'article_id' => (int) $assignment->article_id,
            'article' => $assignment->article ? ['id' => (int) $assignment->article->id, 'title' => (string) $assignment->article->title, 'slug' => (string) $assignment->article->slug, 'status' => (string) $assignment->article->status] : null,
            'status' => (string) $assignment->status,
            'capacity_date' => (string) $assignment->capacity_date,
            'reservation_expires_at' => $assignment->reservation_expires_at?->toIso8601String(),
            'assigned_at' => $assignment->assigned_at?->toIso8601String(),
            'published_at' => $assignment->published_at?->toIso8601String(),
            'last_error_message' => $assignment->last_error_message,
        ];
    }

    /** @return array<string,mixed> */
    private function allocationProjection(?HostedSiteAllocationRequest $allocation): array
    {
        if (! $allocation) {
            return [];
        }

        return [
            'id' => (int) $allocation->id,
            'article_id' => (int) $allocation->article_id,
            'article' => $allocation->article ? ['id' => (int) $allocation->article->id, 'title' => (string) $allocation->article->title, 'slug' => (string) $allocation->article->slug] : null,
            'status' => (string) $allocation->status,
            'attempt_count' => (int) $allocation->attempt_count,
            'next_attempt_at' => $allocation->next_attempt_at?->toIso8601String(),
            'last_error_code' => $allocation->last_error_code,
            'last_error_message' => $allocation->last_error_message,
        ];
    }
}
