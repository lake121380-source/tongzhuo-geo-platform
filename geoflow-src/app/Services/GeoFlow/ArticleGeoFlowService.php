<?php

namespace App\Services\GeoFlow;

use App\Exceptions\ApiException;
use App\Exceptions\ArticleAiQualityGateException;
use App\Exceptions\ArticleRiskGateException;
use App\Models\Admin;
use App\Models\Article;
use App\Models\ArticleAiQualityRollout;
use App\Models\ArticleImage;
use App\Models\ArticleReview;
use App\Models\Author;
use App\Models\Category;
use App\Models\DistributionChannel;
use App\Models\KnowledgeBase;
use App\Models\Task;
use App\Services\HostedSites\HostedSiteArticleFingerprintService;
use App\Support\Admin\ArticleAiQualityProgressPresenter;
use App\Support\GeoFlow\AiQualityRetrievalMode;
use App\Support\GeoFlow\ArticleWorkflow;
use Closure;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;
use Throwable;

class ArticleGeoFlowService
{
    public function __construct(
        private readonly ArticleRiskScanner $articleRiskScanner,
        private readonly ArticleWorkflowTransitionService $articleWorkflowTransitionService,
        private readonly ArticleAiQualityPolicyResolver $articleAiQualityPolicyResolver,
        private readonly ArticleAiQualityInspectionService $articleAiQualityInspectionService,
        private readonly ArticleAiQualityInvalidationService $articleAiQualityInvalidationService,
        private readonly ArticleAiQualityGate $articleAiQualityGate,
        private readonly ArticleCitationMarkerCleaner $articleCitationMarkerCleaner,
        private readonly ArticleAiQualityProgressPresenter $articleAiQualityProgressPresenter,
        private readonly ArticleAiOptimizationCoordinator $articleAiOptimizationCoordinator,
        private readonly ArticleAiQualityConfigurationService $articleAiQualityConfigurationService,
        private readonly AiQualityAuditService $aiQualityAuditService,
        private readonly HostedSiteArticleFingerprintService $hostedFingerprints,
    ) {}

    public function listArticles(int $page = 1, int $perPage = 20, array $filters = []): array
    {
        $page = max(1, $page);
        $perPage = max(1, min(100, $perPage));

        $query = Article::query();
        $trashFilter = trim(strtolower((string) ($filters['trash'] ?? '')));
        if ($trashFilter === 'only') {
            $query->onlyTrashed();
        } elseif ($trashFilter === 'with') {
            $query->withTrashed();
        }

        $qualityFilter = trim((string) ($filters['ai_quality_status'] ?? ''));
        if ($qualityFilter !== '') {
            $this->applyAiQualityFilter($query, $qualityFilter);
        }

        foreach (['task_id', 'status', 'review_status', 'author_id'] as $key) {
            if (! empty($filters[$key])) {
                $query->where($key, $filters[$key]);
            }
        }

        if (! empty($filters['search'])) {
            $s = '%'.$filters['search'].'%';
            $query->where(function ($q) use ($s) {
                $q->where('title', 'like', $s)->orWhere('content', 'like', $s);
            });
        }

        $total = (clone $query)->count();

        $items = $query
            ->with([
                'latestAiQualityCheck',
                // The list is consumed by the operator UI.  Keep the payload
                // light, but include display-only relation names so clients
                // do not have to invent “未分类/未署名” or issue N+1 calls.
                'task:id,name,ai_quality_enabled,ai_quality_retrieval_mode',
                'author:id,name',
                'category:id,name',
                'distributions.channel:id,name,domain',
            ])
            ->orderByDesc('created_at')
            ->forPage($page, $perPage)
            ->get([
                'id', 'title', 'slug', 'status', 'review_status',
                'excerpt', 'keywords', 'meta_description', 'view_count',
                'is_ai_generated', 'task_id', 'author_id', 'category_id', 'published_at',
                'ai_quality_required_at_creation',
                'ai_quality_retrieval_mode_override', 'ai_quality_policy_version',
                'created_at', 'updated_at', 'deleted_at',
            ])
            ->map(fn (Article $a) => array_replace($a->getAttributes(), [
                // Preserve the persisted workflow status separately from the
                // recycle-bin projection consumed by the React filter.
                'workflow_status' => (string) $a->status,
                'status' => $a->trashed() ? 'trash' : (string) $a->status,
                'task_name' => $a->task?->name,
                'author_name' => $a->author?->name,
                'category_name' => $a->category?->name,
                'distributed_to' => $a->distributions
                    ->filter(static fn ($distribution): bool => in_array((string) $distribution->status, ['queued', 'sending', 'synced'], true))
                    ->map(static fn ($distribution): string => (string) ($distribution->channel?->name ?: $distribution->channel?->domain ?: ''))
                    ->filter()
                    ->unique()
                    ->values()
                    ->all(),
                'ai_quality' => $this->aiQualitySummary($a),
            ]))
            ->all();

        return [
            'items' => $items,
            'pagination' => [
                'page' => $page,
                'per_page' => $perPage,
                'total' => $total,
                'total_pages' => (int) ceil($total / $perPage),
            ],
        ];
    }

    public function createArticle(array $data, int $auditAdminId): array
    {
        $normalized = $this->normalizeCreateInput($data);
        $workflowState = ArticleWorkflow::normalizeState(
            $normalized['status'],
            $normalized['review_status']
        );
        $slug = $normalized['slug'] ?: ArticleWorkflow::generateUniqueSlug($normalized['title']);
        $excerpt = $normalized['excerpt'] !== '' ? $normalized['excerpt'] : mb_substr(strip_tags($normalized['content']), 0, 200);

        $fallbackWorkflowState = ArticleWorkflow::normalizeState('draft', 'pending');
        $creation = DB::transaction(function () use (
            $normalized,
            $slug,
            $excerpt,
            $fallbackWorkflowState,
            $auditAdminId,
            $workflowState,
        ): array {
            $this->lockActiveTaskReference($normalized['task_id']);
            $article = Article::query()->create([
                'title' => $normalized['title'],
                'slug' => $slug,
                'content' => $normalized['content'],
                'excerpt' => $excerpt,
                'keywords' => $normalized['keywords'],
                'meta_description' => $normalized['meta_description'],
                'category_id' => $normalized['category_id'],
                'author_id' => $normalized['author_id'],
                'task_id' => $normalized['task_id'],
                'status' => $fallbackWorkflowState['status'],
                'review_status' => $fallbackWorkflowState['review_status'],
                'is_ai_generated' => $normalized['is_ai_generated'],
                'published_at' => $fallbackWorkflowState['published_at'],
            ]);
            $qualityPolicy = $this->articleAiQualityPolicyResolver->resolve($article);
            $article->forceFill([
                'ai_quality_required_at_creation' => (bool) ($qualityPolicy['required'] ?? false),
                'ai_quality_policy_snapshot' => $this->articleAiQualityPolicyResolver->snapshot($qualityPolicy),
            ])->save();

            $this->articleRiskScanner->record($article, 'api_save', $auditAdminId);

            $gateRejection = null;
            if (
                $workflowState['status'] === 'published'
                || in_array($workflowState['review_status'], ['approved', 'auto_approved'], true)
            ) {
                $isAutomaticApproval = $workflowState['review_status'] === 'auto_approved';

                try {
                    $this->articleWorkflowTransitionService->transition(
                        $article,
                        $workflowState,
                        'api_create',
                        $auditAdminId,
                        $isAutomaticApproval ? null : $normalized['risk_override_reason'],
                        ! $isAutomaticApproval,
                        $fallbackWorkflowState,
                    );
                } catch (ArticleRiskGateException|ArticleAiQualityGateException $exception) {
                    $gateRejection = $exception;
                }
            }

            return ['article' => $article, 'gate_rejection' => $gateRejection];
        });

        $article = $creation['article'];
        if ($creation['gate_rejection'] instanceof ArticleRiskGateException) {
            throw $this->riskBlockedException($article, $creation['gate_rejection']);
        }
        if ($creation['gate_rejection'] instanceof ArticleAiQualityGateException) {
            throw $this->qualityBlockedException($article, $creation['gate_rejection']);
        }
        if ($article->ai_quality_required_at_creation) {
            try {
                $this->articleAiQualityInspectionService->createOrReuse($article, trigger: 'api_create');
            } catch (\RuntimeException $exception) {
                // ⚠️ 质检配置不完整（缺提示词 / 模型 / 知识库）时，**不能把「建文章」也一起弄崩**：
                // 09-20 的 fail-closed 让 `required` 恒真，而这里无条件排队质检 → 解析器抛
                // `ai_quality_*` 异常 → 未捕获 → **建文章直接 500**（任何还没配齐质检的部署，
                // 连草稿都建不出来）。文章照建（草稿态），发布时门禁会给出可读的拦截理由
                // （「AI 质检配置不可用，文章已暂停发布」）——那才是该报错的地方。
                // 只吞解析器的这几个配置类错误，其它异常照旧往上抛。
                if (! str_starts_with(trim($exception->getMessage()), 'ai_quality_')) {
                    throw $exception;
                }
                report($exception);
            }
        }

        return $this->getArticle((int) $article->id);
    }

    public function getArticle(int $articleId): array
    {
        $article = Article::query()
            // 回收站里的文章也要能读：列表投影会显示它们（status 映射成 'trash'），
            // 运营点开却拿到 404「文章不存在」——看上去就像文章被彻底删了。
            // 详情与列表必须同一口径。
            ->withTrashed()
            ->with([
                'task:id,name,ai_quality_enabled,ai_quality_retrieval_mode',
                'author:id,name',
                'category:id,name',
                'latestAiQualityCheck.prompt:id,name',
                'latestAiQualityCheck.aiModel:id,name',
            ])
            ->find($articleId);
        if (! $article) {
            throw new ApiException('article_not_found', '文章不存在', 404);
        }

        $images = ArticleImage::query()
            ->where('article_id', $articleId)
            ->with('image:id,file_path,original_name')
            ->orderBy('position')
            ->orderBy('id')
            ->get()
            ->map(fn (ArticleImage $ai) => [
                'id' => $ai->id,
                'image_id' => $ai->image_id,
                'position' => $ai->position,
                'file_path' => $ai->image->file_path ?? null,
                'original_name' => $ai->image->original_name ?? null,
            ])
            ->all();

        return [
            'id' => (int) $article->id,
            'title' => $article->title,
            'slug' => $article->slug,
            'content' => $article->content,
            'excerpt' => $article->excerpt,
            'keywords' => $article->keywords,
            'meta_description' => $article->meta_description,
            'status' => $article->trashed() ? 'trash' : (string) $article->status,
            'review_status' => $article->review_status,
            // 与列表投影同一口径：`status` 给界面看（回收站 = 'trash'），
            // `workflow_status` 保留落库的真实状态，`trashed` 给界面判「该不该出现发布按钮」。
            'workflow_status' => (string) $article->status,
            'trashed' => $article->trashed(),
            'task_id' => $this->nullableInt($article->task_id),
            'task_name' => $article->task->name ?? null,
            'author_id' => $this->nullableInt($article->author_id),
            'author_name' => $article->author->name ?? null,
            'category_id' => $this->nullableInt($article->category_id),
            'category_name' => $article->category->name ?? null,
            'published_at' => $article->published_at?->format('Y-m-d H:i:s'),
            'created_at' => $article->created_at?->format('Y-m-d H:i:s'),
            'updated_at' => $article->updated_at?->format('Y-m-d H:i:s'),
            'images' => $images,
            'ai_quality' => $this->aiQualityDetail($article),
        ];
    }

    /** @return array<string, mixed> */
    public function getAiQualityStatus(int $articleId): array
    {
        // 与 `getArticle()` 同一口径：回收站里的文章详情能打开，质检面板就会来查它的
        // 质检状态——默认作用域取不到软删行，面板会拿到 404 并在控制台留下一条噪音。
        $article = Article::query()->withTrashed()->with('latestAiQualityCheck')->find($articleId);
        if (! $article) {
            throw new ApiException('article_not_found', '文章不存在', 404);
        }

        $snapshot = $this->articleAiQualityProgressPresenter->snapshot($article->latestAiQualityCheck);
        $snapshot['optimization'] = $this->articleAiOptimizationCoordinator->statusForArticle($article);

        return $snapshot;
    }

    public function recheckAiQuality(
        int $articleId,
        int $auditAdminId,
        int $apiTokenId,
        ?int $expectedPolicyVersion = null,
    ): array {
        $article = Article::query()->with('task')->whereKey($articleId)->first();
        if (! $article) {
            throw new ApiException('article_not_found', '文章不存在', 404);
        }

        try {
            $this->articleAiQualityInspectionService->requestManualInspection(
                $article,
                trigger: 'api_manual',
                auditAdminId: $auditAdminId,
                apiTokenId: $apiTokenId,
                rejectWhenOptimizationActive: true,
                expectedPolicyVersion: $expectedPolicyVersion,
            );
        } catch (ApiException $exception) {
            throw $exception;
        } catch (ArticleAiOptimizationException $exception) {
            throw new ApiException($exception->errorCode(), 'AI 内容优化正在进行，请先取消优化再重新质检', 409, [
                'article_id' => $articleId,
                'can_cancel_optimization' => true,
            ]);
        } catch (Throwable $exception) {
            report($exception);

            // 质检策略解析器抛的是**原因码**（`ai_quality_prompt_unavailable` /
            // `ai_quality_model_unavailable` / `ai_quality_knowledge_unavailable`），
            // 以前一律被吞成一句「AI 质检无法重新排队」——运营既不知道缺什么，也不知道去哪里补。
            // 注意：对照发布路径（`ArticleAiQualityGate`）那边是有像样说明的，这里对齐它。
            $reasonCode = trim($exception->getMessage());
            $actionable = [
                'ai_quality_prompt_unavailable' => '这条任务没有可用的质检提示词——去「AI 模型与提示词」新建/启用一个质检提示词，再到任务的编辑里选中它',
                'ai_quality_model_unavailable' => '没有可用的质检模型——去「AI 模型与提示词」确认有启用中的对话模型，且该任务的模型访问权限没有被收回',
                'ai_quality_knowledge_unavailable' => '质检要用的知识库不可用——检查任务挂载的知识库是否已同步完成（切片就绪）',
            ][$reasonCode] ?? null;

            throw new ApiException(
                $actionable !== null ? $reasonCode : 'article_ai_quality_failed',
                $actionable ?? 'AI 质检无法重新排队',
                409,
                array_filter([
                    'article_id' => $articleId,
                    'reason_code' => $reasonCode !== '' ? $reasonCode : null,
                ]),
            );
        }

        return $this->getArticle($articleId);
    }

    /** @return array<string,mixed> */
    public function aiQualityIdempotencyContext(int $articleId, int $auditAdminId): array
    {
        $article = Article::withTrashed()
            ->with(['task' => fn ($query) => $query->withTrashed()->select([
                'id', 'ai_quality_policy_version', 'ai_quality_retrieval_mode', 'ai_quality_enabled', 'deleted_at',
            ])])
            ->whereKey($articleId)
            ->first([
                'id', 'task_id', 'ai_quality_policy_version', 'ai_quality_retrieval_mode_override', 'deleted_at',
            ]);
        $admin = Admin::query()->whereKey($auditAdminId)->first(['id', 'role', 'status', 'auth_version']);
        if (! $article) {
            return ['article_id' => $articleId, 'resource_state' => 'missing', 'admin' => $this->adminAuthorizationContext($admin)];
        }

        $knowledgeBaseIds = $article->trashed()
            ? []
            : $this->articleAiQualityConfigurationService->effectiveKnowledgeBaseIds($article);
        $knowledgeSources = KnowledgeBase::query()
            ->whereIn('id', $knowledgeBaseIds)
            ->with('factLibrary:id,knowledge_base_id,serving_status,active_revision_id,active_hash,source_hash,updated_at')
            ->get([
                'id', 'chunk_sync_status', 'chunk_source_hash', 'chunk_serving_generation',
                'chunk_serving_source_hash', 'chunk_manifest_hash', 'ai_quality_content_hash',
                'review_status',
            ])
            ->sortBy(static fn (KnowledgeBase $base): int => array_search((int) $base->id, $knowledgeBaseIds, true))
            ->values()
            ->map(static fn (KnowledgeBase $base): array => [
                'id' => (int) $base->id,
                'content_hash' => (string) $base->ai_quality_content_hash,
                'review_status' => (string) $base->review_status,
                'chunk_sync_status' => (string) $base->chunk_sync_status,
                'chunk_source_hash' => (string) $base->chunk_source_hash,
                'chunk_serving_generation' => (string) $base->chunk_serving_generation,
                'chunk_serving_source_hash' => (string) $base->chunk_serving_source_hash,
                'chunk_manifest_hash' => (string) $base->chunk_manifest_hash,
                'fact_library' => $base->factLibrary ? [
                    'serving_status' => (string) $base->factLibrary->serving_status,
                    'active_revision_id' => (int) $base->factLibrary->active_revision_id,
                    'active_hash' => (string) $base->factLibrary->active_hash,
                    'source_hash' => (string) $base->factLibrary->source_hash,
                ] : null,
            ])->all();

        return [
            'article_id' => (int) $article->id,
            'resource_state' => $article->trashed() ? 'deleted' : 'active',
            'task_id' => $article->task_id ? (int) $article->task_id : null,
            'article_policy_version' => max(1, (int) $article->ai_quality_policy_version),
            'article_retrieval_mode' => (string) ($article->ai_quality_retrieval_mode_override ?? ''),
            'rollout_epoch' => max(1, (int) (ArticleAiQualityRollout::query()->whereKey(1)->value('epoch') ?? 1)),
            'task' => $article->task ? [
                'id' => (int) $article->task->id,
                'state' => $article->task->trashed() ? 'deleted' : 'active',
                'policy_version' => max(1, (int) $article->task->ai_quality_policy_version),
                'retrieval_mode' => (string) $article->task->ai_quality_retrieval_mode,
                'quality_enabled' => (bool) $article->task->ai_quality_enabled,
            ] : null,
            'knowledge_sources' => $knowledgeSources,
            'admin' => $this->adminAuthorizationContext($admin),
        ];
    }

    /** @return array<string,mixed> */
    private function adminAuthorizationContext(?Admin $admin): array
    {
        return [
            'id' => $admin?->id,
            'role' => (string) ($admin?->role ?? ''),
            'status' => (string) ($admin?->status ?? ''),
            'auth_version' => (int) ($admin?->auth_version ?? 0),
            'protected_workflows' => $admin?->canManageProtectedWorkflows() === true,
        ];
    }

    public function overrideAiQuality(
        int $articleId,
        string $reason,
        int $auditAdminId,
        int $apiTokenId = 0,
    ): array {
        $reason = trim($reason);
        if (mb_strlen($reason, 'UTF-8') < 4 || mb_strlen($reason, 'UTF-8') > 1000) {
            throw new ApiException('validation_failed', '参数校验失败', 422, [
                'field_errors' => ['reason' => '人工放行依据需要填写 4 至 1000 个字符'],
            ]);
        }

        DB::transaction(function () use ($articleId, $reason, $auditAdminId, $apiTokenId): void {
            $article = Article::query()->whereKey($articleId)->lockForUpdate()->first();
            if (! $article) {
                throw new ApiException('article_not_found', '文章不存在', 404);
            }
            $admin = Admin::query()->whereKey($auditAdminId)->first();
            if (! $admin) {
                throw new ApiException('forbidden', '当前账号无权执行人工质检放行', 403, [
                    'reason_code' => 'quality_decision_permission_required',
                ]);
            }
            $hostedTask = (int) $article->task_id > 0 && Task::query()
                ->whereKey((int) $article->task_id)
                ->whereHas('distributionChannels', static fn ($query) => $query->where(
                    'channel_type',
                    DistributionChannel::TYPE_HOSTED_SITE,
                ))
                ->exists();
            if ($hostedTask && ! $admin->canManageProtectedWorkflows()) {
                throw new ApiException('forbidden', '当前账号无权放行托管任务文章', 403, [
                    'reason_code' => 'hosted_quality_decision_permission_required',
                ]);
            }

            $beforeCheck = $article->latestAiQualityCheck()->first();
            try {
                $check = $this->articleAiQualityGate->check(
                    $article,
                    'api_ai_quality_override',
                    $auditAdminId,
                    $reason,
                    true,
                );
            } catch (ArticleAiQualityGateException $exception) {
                throw $this->qualityBlockedException($article, $exception);
            }
            $this->aiQualityAuditService->record('article_quality_decision_overridden', [
                'article_id' => $articleId,
                'task_id' => $article->task_id ? (int) $article->task_id : null,
                'article_ai_quality_check_id' => (int) $check->id,
                'admin_id' => $auditAdminId,
                'api_token_id' => $apiTokenId > 0 ? $apiTokenId : null,
                'authorization_result' => 'allowed',
                'policy_version' => max(1, (int) $article->ai_quality_policy_version),
                'before_hash' => hash('sha256', json_encode([
                    'check_id' => $beforeCheck?->id,
                    'is_overridden' => (bool) ($beforeCheck?->is_overridden ?? false),
                ], JSON_THROW_ON_ERROR)),
                'after_hash' => hash('sha256', json_encode([
                    'check_id' => $check->id,
                    'is_overridden' => (bool) $check->is_overridden,
                ], JSON_THROW_ON_ERROR)),
                'basis_hash' => (string) ($check->retrieval_basis_hash ?? ''),
                'reason_code' => 'manual_quality_decision_override',
            ]);
        });

        return $this->getArticle($articleId);
    }

    public function updateArticle(int $articleId, array $data, int $auditAdminId): array
    {
        $existing = $this->getArticleRecord($articleId);
        $normalized = $this->normalizeUpdateInput($data, $existing);
        if (empty($normalized)) {
            throw new ApiException('validation_failed', '没有可更新的字段', 422);
        }

        foreach ($normalized as $field => $value) {
            if ((string) ($existing[$field] ?? '') === (string) ($value ?? '')) {
                unset($normalized[$field]);
            }
        }

        if ($normalized === []) {
            return $this->getArticle($articleId);
        }

        $riskRelevantFields = ['title', 'excerpt', 'content', 'keywords', 'meta_description'];
        $qualityRelevantFields = [...$riskRelevantFields, 'task_id'];
        $hasQualityRelevantChanges = array_intersect($qualityRelevantFields, array_keys($normalized)) !== [];
        $hasRiskRelevantChanges = array_intersect($riskRelevantFields, array_keys($normalized)) !== [];

        if ($hasRiskRelevantChanges && (string) ($existing['status'] ?? '') === 'published') {
            $article = Article::query()->whereKey($articleId)->firstOrFail();
            try {
                $this->articleAiQualityGate->check($article, 'api_published_content_update');
            } catch (ArticleAiQualityGateException $exception) {
                throw $this->qualityBlockedException($article, $exception);
            }
        }

        if ($hasRiskRelevantChanges) {
            $fallbackWorkflowState = ArticleWorkflow::normalizeState('draft', 'pending');
            $normalized = array_merge($normalized, $fallbackWorkflowState);
        }

        $normalized['updated_at'] = now();

        DB::transaction(function () use ($articleId, $normalized, $auditAdminId, $hasRiskRelevantChanges, $hasQualityRelevantChanges): void {
            $lockedArticle = Article::query()
                ->whereKey($articleId)
                ->lockForUpdate()
                ->firstOrFail();
            $nextPolicyVersion = max(1, (int) $lockedArticle->ai_quality_policy_version);
            if ($hasQualityRelevantChanges) {
                $nextPolicyVersion++;
                $normalized['ai_quality_policy_version'] = $nextPolicyVersion;
            }
            if (array_key_exists('task_id', $normalized)) {
                $this->rebindArticleTask(
                    $lockedArticle,
                    $normalized['task_id'],
                    $nextPolicyVersion,
                );
                unset($normalized['task_id'], $normalized['ai_quality_policy_version']);
            }
            if ($normalized !== []) {
                Article::query()->whereKey($articleId)->update($normalized);
            }
            if ($hasRiskRelevantChanges) {
                $article = Article::query()->findOrFail($articleId);
                $this->articleRiskScanner->record($article, 'api_save', $auditAdminId);
            }

            // 2026-09-12 退役补齐：旧 Blade 后台的保存路径在事务末尾会同步托管文章指纹
            // （`Admin\ArticleController` 里那句 `synchronizeLockedArticle`）。这条 API 保存路径
            // 从来没调过它，于是**通过新后台改文章可以绕过 `hosted_assignments_content_fingerprint_unique`**：
            // 既不会更新已托管文章的内容指纹，也不会拦住「改成与另一篇托管文章一模一样」。
            // 注意必须先 `refresh()`：上面用的是查询构造器 update，模型实例上的属性还是旧的，
            // 而指纹取自 `title`/`content`。
            $lockedArticle->refresh();
            $this->hostedFingerprints->synchronizeLockedArticle($lockedArticle);
        });

        if ($hasQualityRelevantChanges) {
            $this->articleAiQualityInvalidationService->invalidateArticle($articleId, '文章内容或任务关联已更新');
        }

        return $this->getArticle($articleId);
    }

    private function rebindArticleTask(Article $article, ?int $targetTaskId, int $nextPolicyVersion): void
    {
        $currentTaskId = $article->task_id ? (int) $article->task_id : null;
        if ($currentTaskId === $targetTaskId) {
            return;
        }

        $currentTask = $currentTaskId === null
            ? null
            : Task::withTrashed()->whereKey($currentTaskId)->lockForUpdate()->first();
        if ($currentTask instanceof Task) {
            $currentTask->load(['qualityPrompt', 'qualityModel', 'aiModel', 'knowledgeBases']);
            $article->setRelation('task', $currentTask);
        }

        if ($targetTaskId === null) {
            $policy = $currentTask instanceof Task
                ? $this->articleAiQualityPolicyResolver->fromTaskForDetachment($currentTask, $article)
                : $this->articleAiQualityPolicyResolver->resolve($article);
            $policy['policy_version'] = $nextPolicyVersion;
            $knowledgeBaseIds = array_values(array_unique(array_map(
                'intval',
                (array) ($policy['knowledge_base_ids'] ?? []),
            )));
            $article->aiQualityKnowledgeBases()->sync(collect($knowledgeBaseIds)->mapWithKeys(
                static fn (int $id, int $index): array => [$id => ['sort_order' => $index]],
            )->all());
            $article->forceFill([
                'task_id' => null,
                'ai_quality_retrieval_mode_override' => (string) (
                    $policy['retrieval_mode'] ?? AiQualityRetrievalMode::legacyDefault()
                ),
                'ai_quality_required_at_creation' => (bool) ($policy['required'] ?? false),
                'ai_quality_policy_version' => $nextPolicyVersion,
                'ai_quality_policy_snapshot' => $this->articleAiQualityPolicyResolver->snapshot($policy),
            ])->save();

            return;
        }

        $targetTask = Task::query()
            ->whereKey($targetTaskId)
            ->lockForUpdate()
            ->first();
        if (! $targetTask) {
            throw new ApiException('validation_failed', '参数校验失败', 422, [
                'field_errors' => ['task_id' => 'task_id 对应资源不存在或任务已删除'],
            ]);
        }
        $targetTask->load(['qualityPrompt', 'qualityModel', 'aiModel', 'knowledgeBases']);
        $article->aiQualityKnowledgeBases()->detach();
        $article->forceFill([
            'task_id' => $targetTaskId,
            'ai_quality_retrieval_mode_override' => null,
            'ai_quality_policy_version' => $nextPolicyVersion,
        ]);
        $article->setRelation('task', $targetTask);
        $policy = $this->articleAiQualityPolicyResolver->fromTask($targetTask, $article);
        $policy['policy_version'] = $nextPolicyVersion;
        try {
            $this->articleAiQualityPolicyResolver->assertExecutable($policy);
        } catch (\RuntimeException $exception) {
            throw new ApiException('validation_failed', '目标任务的 AI 质检配置当前不可用', 422, [
                'field_errors' => ['task_id' => '目标任务的 AI 质检配置当前不可用'],
                'reason_code' => $exception->getMessage(),
            ]);
        }
        $article->forceFill([
            'ai_quality_required_at_creation' => (bool) ($policy['required'] ?? false),
            'ai_quality_policy_snapshot' => $this->articleAiQualityPolicyResolver->snapshot($policy),
        ])->save();
    }

    /**
     * @param  list<int>|null  $knowledgeBaseIds
     * @return array<string,mixed>
     */
    public function updateAiQualityConfiguration(
        int $articleId,
        mixed $requestedMode,
        bool $modeProvided,
        ?array $knowledgeBaseIds,
        int $expectedVersion,
        int $auditAdminId,
        int $apiTokenId,
    ): array {
        DB::transaction(function () use (
            $articleId,
            $requestedMode,
            $modeProvided,
            $knowledgeBaseIds,
            $expectedVersion,
            $auditAdminId,
            $apiTokenId,
        ): void {
            $article = Article::query()
                ->with('task')
                ->whereKey($articleId)
                ->lockForUpdate()
                ->first();
            if (! $article) {
                throw new ApiException('article_not_found', '文章不存在', 404);
            }
            $this->assertAiQualityConfigurationVersion($article, $expectedVersion);
            $this->assertCanManageArticleQualityPolicy($article, $auditAdminId);

            $beforeHash = $this->qualityConfigurationHash($article);
            try {
                $changed = $this->articleAiQualityConfigurationService->apply(
                    $article,
                    $modeProvided ? $requestedMode : $article->ai_quality_retrieval_mode_override,
                    $knowledgeBaseIds,
                );
            } catch (ValidationException $exception) {
                throw new ApiException('validation_failed', '参数校验失败', 422, [
                    'field_errors' => collect($exception->errors())
                        ->map(static fn (array $messages): string => (string) ($messages[0] ?? 'Invalid value.'))
                        ->all(),
                ]);
            }
            if (! $changed) {
                return;
            }

            $article->refresh();
            $this->aiQualityAuditService->record('article_quality_configuration_changed', [
                'article_id' => $articleId,
                'task_id' => $article->task_id ? (int) $article->task_id : null,
                'admin_id' => $auditAdminId,
                'api_token_id' => $apiTokenId > 0 ? $apiTokenId : null,
                'policy_version' => (int) $article->ai_quality_policy_version,
                'before_hash' => $beforeHash,
                'after_hash' => $this->qualityConfigurationHash($article),
                'metadata' => [
                    'trigger' => 'api_patch',
                    'retrieval_mode' => (string) ($article->ai_quality_retrieval_mode_override ?? ''),
                ],
            ]);
            $this->articleAiQualityInvalidationService->invalidateArticle(
                $article,
                'article_quality_configuration_changed',
            );
        });

        return $this->getArticle($articleId);
    }

    public function assertCanManageArticleQualityPolicy(
        Article|int $article,
        int $adminId,
        mixed $targetTaskId = null,
        bool $targetTaskProvided = false,
    ): void {
        $model = $article instanceof Article
            ? $article
            : Article::query()->whereKey($article)->first();
        if (! $model) {
            throw new ApiException('article_not_found', '文章不存在', 404);
        }
        $admin = Admin::query()->whereKey($adminId)->first();
        if (! $admin) {
            throw new ApiException('forbidden', '当前账号无权修改文章质检策略', 403, [
                'reason_code' => 'quality_policy_permission_required',
            ]);
        }

        $taskIds = array_values(array_unique(array_filter([
            (int) $model->task_id,
            $targetTaskProvided ? (int) $targetTaskId : 0,
        ])));
        $hasHostedTask = $taskIds !== [] && Task::withTrashed()
            ->whereIn('id', $taskIds)
            ->whereHas('distributionChannels', static fn ($query) => $query->where(
                'channel_type',
                DistributionChannel::TYPE_HOSTED_SITE,
            ))
            ->exists();
        if ($hasHostedTask && ! $admin->canManageProtectedWorkflows()) {
            throw new ApiException('forbidden', '当前账号无权修改托管任务文章的质检策略', 403, [
                'reason_code' => 'hosted_task_permission_required',
            ]);
        }
    }

    public function assertAiQualityConfigurationVersion(Article|int $article, int $expectedVersion): void
    {
        $model = $article instanceof Article
            ? $article
            : Article::query()->whereKey($article)->first();
        if (! $model) {
            throw new ApiException('article_not_found', '文章不存在', 404);
        }
        $currentVersion = max(1, (int) $model->ai_quality_policy_version);
        if ($currentVersion !== $expectedVersion) {
            throw new ApiException(
                'article_ai_quality_config_version_conflict',
                'AI 质检配置已更新，请刷新后重试',
                409,
                [
                    'expected_config_version' => $expectedVersion,
                    'current_config_version' => $currentVersion,
                ],
            );
        }
    }

    public function reviewArticle(
        int $articleId,
        string $reviewStatus,
        string $reviewNote,
        string $riskOverrideReason,
        int $auditAdminId,
    ): array {
        $article = $this->getArticleRecord($articleId);
        $reviewStatus = trim($reviewStatus);
        $riskOverrideReason = trim($riskOverrideReason);
        if (! in_array($reviewStatus, ['pending', 'approved', 'rejected', 'auto_approved'], true)) {
            throw new ApiException('validation_failed', '审核状态无效', 422, [
                'field_errors' => ['review_status' => '审核状态无效'],
            ]);
        }
        if (mb_strlen($riskOverrideReason, 'UTF-8') > 1000) {
            throw new ApiException('validation_failed', '参数校验失败', 422, [
                'field_errors' => ['risk_override_reason' => '风险放行原因不能超过 1000 个字符'],
            ]);
        }

        $desiredStatus = $article['status'] ?? 'draft';
        if (in_array($reviewStatus, ['approved', 'auto_approved'], true)) {
            $taskNeedReview = 1;
            if (! empty($article['task_id'])) {
                $taskNeedReview = (int) (Task::query()
                    ->whereKey((int) $article['task_id'])
                    ->value('need_review') ?? 1);
            }

            if ($reviewStatus === 'auto_approved' || $taskNeedReview === 0) {
                $desiredStatus = 'published';
            }
        }

        $workflowState = ArticleWorkflow::normalizeState($desiredStatus, $reviewStatus, $article['published_at'] ?? null);

        if (in_array($reviewStatus, ['approved', 'auto_approved'], true)) {
            $fallbackWorkflowState = ArticleWorkflow::normalizeState('draft', 'pending');
            $isAutomaticApproval = $reviewStatus === 'auto_approved';

            $gateRejection = DB::transaction(function () use (
                $articleId,
                $workflowState,
                $auditAdminId,
                $isAutomaticApproval,
                $reviewNote,
                $riskOverrideReason,
                $fallbackWorkflowState,
                $reviewStatus,
            ): ArticleRiskGateException|ArticleAiQualityGateException|null {
                try {
                    $this->articleWorkflowTransitionService->transition(
                        Article::query()->findOrFail($articleId),
                        $workflowState,
                        'api_review',
                        $auditAdminId,
                        $isAutomaticApproval ? null : $riskOverrideReason,
                        ! $isAutomaticApproval,
                        $fallbackWorkflowState,
                    );
                } catch (ArticleRiskGateException|ArticleAiQualityGateException $exception) {
                    return $exception;
                }

                ArticleReview::query()->create([
                    'article_id' => $articleId,
                    'admin_id' => $auditAdminId,
                    'review_status' => $reviewStatus,
                    'review_note' => trim($reviewNote),
                ]);

                return null;
            });

            if ($gateRejection instanceof ArticleRiskGateException) {
                throw $this->riskBlockedException(Article::query()->findOrFail($articleId), $gateRejection);
            }
            if ($gateRejection instanceof ArticleAiQualityGateException) {
                throw $this->qualityBlockedException(Article::query()->findOrFail($articleId), $gateRejection);
            }
        } else {
            DB::transaction(function () use ($articleId, $workflowState, $reviewStatus, $reviewNote, $auditAdminId) {
                Article::query()->whereKey($articleId)->update([
                    'status' => $workflowState['status'],
                    'review_status' => $workflowState['review_status'],
                    'published_at' => $workflowState['published_at'],
                    'updated_at' => now(),
                ]);

                ArticleReview::query()->create([
                    'article_id' => $articleId,
                    'admin_id' => $auditAdminId,
                    'review_status' => $reviewStatus,
                    'review_note' => trim($reviewNote),
                ]);
            });
        }

        return $this->getArticle($articleId);
    }

    public function publishArticle(int $articleId, int $auditAdminId): array
    {
        $article = Article::query()->whereKey($articleId)->first();
        if ($article === null) {
            throw new ApiException('article_not_found', '文章不存在', 404);
        }

        $reviewStatus = (string) ($article->review_status ?? 'pending');
        if (! in_array($reviewStatus, ['approved', 'auto_approved'], true)) {
            throw new ApiException('article_not_publishable', '当前文章状态不允许直接发布', 409);
        }

        try {
            $this->articleWorkflowTransitionService->transition(
                $article,
                ArticleWorkflow::normalizeState('published', $reviewStatus, $article->published_at),
                'api_publish',
                $auditAdminId,
                null,
                $reviewStatus === 'approved',
                ArticleWorkflow::normalizeState('draft', 'pending'),
                static function (Article $lockedArticle) use ($reviewStatus): void {
                    if ((string) $lockedArticle->review_status !== $reviewStatus) {
                        throw new ApiException('article_not_publishable', '当前文章状态不允许直接发布', 409);
                    }
                },
            );
        } catch (ArticleRiskGateException $exception) {
            throw $this->riskBlockedException(Article::query()->findOrFail($articleId), $exception);
        } catch (ArticleAiQualityGateException $exception) {
            throw $this->qualityBlockedException(Article::query()->findOrFail($articleId), $exception);
        }

        return $this->getArticle($articleId);
    }

    public function trashArticle(int $articleId, ?int $auditAdminId = null, ?int $apiTokenId = null): array
    {
        DB::transaction(function () use ($articleId, $auditAdminId, $apiTokenId): void {
            $article = Article::query()->whereKey($articleId)->lockForUpdate()->first();
            if (! $article) {
                throw new ApiException('article_not_found', '文章不存在', 404);
            }
            $article->forceFill([
                'ai_quality_policy_version' => max(1, (int) $article->ai_quality_policy_version) + 1,
            ])->save();
            $this->aiQualityAuditService->record('article_deleted', [
                'article_id' => $articleId,
                'task_id' => $article->task_id ? (int) $article->task_id : null,
                'admin_id' => $auditAdminId,
                'api_token_id' => $apiTokenId !== null && $apiTokenId > 0 ? $apiTokenId : null,
                'policy_version' => (int) $article->ai_quality_policy_version,
                'reason_code' => 'article_soft_deleted',
            ]);
            $article->delete();
            $this->articleAiQualityInvalidationService->cancelArticle($article);
        });

        return [
            'id' => $articleId,
            'trashed' => true,
        ];
    }

    public function restoreArticle(int $articleId, ?int $auditAdminId = null, ?int $apiTokenId = null): array
    {
        DB::transaction(function () use ($articleId, $auditAdminId, $apiTokenId): void {
            $article = Article::withTrashed()
                ->whereKey($articleId)
                ->lockForUpdate()
                ->first();
            if (! $article) {
                throw new ApiException('article_not_found', '文章不存在', 404);
            }
            if (! $article->trashed()) {
                throw new ApiException('article_not_trashed', '文章不在垃圾箱中，无法恢复', 409);
            }

            $article->restore();
            $article->forceFill([
                'ai_quality_policy_version' => max(1, (int) $article->ai_quality_policy_version) + 1,
            ])->save();
            $this->aiQualityAuditService->record('article_restored', [
                'article_id' => $articleId,
                'task_id' => $article->task_id ? (int) $article->task_id : null,
                'admin_id' => $auditAdminId,
                'api_token_id' => $apiTokenId !== null && $apiTokenId > 0 ? $apiTokenId : null,
                'policy_version' => (int) $article->ai_quality_policy_version,
                'reason_code' => 'article_soft_restored',
            ]);
            $this->articleAiQualityInvalidationService->invalidateArticle($article, 'article_restored');
        });

        return $this->getArticle($articleId);
    }

    /**
     * @param  list<int>  $articleIds
     * @return array<string,mixed>
     */
    public function batchReviewArticles(
        array $articleIds,
        string $reviewStatus,
        string $reviewNote,
        string $riskOverrideReason,
        int $auditAdminId,
    ): array {
        return $this->executeBatch(
            'review',
            $articleIds,
            fn (int $articleId): array => $this->reviewArticle(
                $articleId,
                $reviewStatus,
                $reviewNote,
                $riskOverrideReason,
                $auditAdminId,
            ),
        );
    }

    /**
     * @param  list<int>  $articleIds
     * @return array<string,mixed>
     */
    public function batchPublishArticles(array $articleIds, int $auditAdminId): array
    {
        return $this->executeBatch(
            'publish',
            $articleIds,
            fn (int $articleId): array => $this->publishArticle($articleId, $auditAdminId),
        );
    }

    /**
     * 改一篇文章的状态——旧后台 `articles/batch/update-status` 的 API 等价物。
     *
     * 语义与旧后台逐条对齐：
     *  - 目标状态只接受 `draft` / `published` / `private`；
     *  - **撤回成草稿不过门禁**（直接落库）。撤回是安全操作，任何时候都该允许——
     *    如果连撤回都要过质检，一篇质检不通过的文章就永远撤不回来了；
     *  - `published` / `private` 必须过**风险门禁**与**质检门禁**，且只有
     *    `review_status === 'approved'` 时才允许带理由越权；
     *  - `ArticleWorkflow::normalizeState` 会把「未审核通过」的文章归一到草稿，
     *    所以对未审核文章请求 `published` **不会绕过审核**，只是等价于撤回。
     *
     * @return array<string,mixed>
     */
    public function updateArticleStatus(int $articleId, string $newStatus, string $riskOverrideReason, int $auditAdminId): array
    {
        if (! in_array($newStatus, ['draft', 'published', 'private'], true)) {
            throw new ApiException('invalid_status', '不支持的目标状态', 422, [
                'allowed' => ['draft', 'published', 'private'],
            ]);
        }

        $article = Article::query()->whereKey($articleId)->first();
        if ($article === null) {
            throw new ApiException('article_not_found', '文章不存在', 404);
        }

        $state = ArticleWorkflow::normalizeState(
            $newStatus,
            (string) ($article->review_status ?? 'pending'),
            $article->published_at?->format('Y-m-d H:i:s'),
        );

        if ($state['status'] === 'draft') {
            Article::query()->whereKey($articleId)->update([
                'status' => $state['status'],
                'review_status' => $state['review_status'],
                'published_at' => $state['published_at'],
            ]);

            return $this->getArticle($articleId);
        }

        $allowsOverride = $state['review_status'] === 'approved';

        try {
            $this->articleWorkflowTransitionService->transition(
                $article,
                $state,
                'api_batch_status',
                $allowsOverride ? $auditAdminId : null,
                $allowsOverride && $riskOverrideReason !== '' ? $riskOverrideReason : null,
                $allowsOverride,
                ArticleWorkflow::normalizeState('draft', 'pending'),
            );
        } catch (ArticleRiskGateException $exception) {
            throw $this->riskBlockedException(Article::query()->findOrFail($articleId), $exception);
        } catch (ArticleAiQualityGateException $exception) {
            throw $this->qualityBlockedException(Article::query()->findOrFail($articleId), $exception);
        }

        return $this->getArticle($articleId);
    }

    /**
     * @param  list<int>  $articleIds
     * @return array<string,mixed>
     */
    public function batchUpdateStatusArticles(array $articleIds, string $newStatus, string $riskOverrideReason, int $auditAdminId): array
    {
        return $this->executeBatch(
            'update-status',
            $articleIds,
            fn (int $articleId): array => $this->updateArticleStatus(
                $articleId,
                $newStatus,
                $riskOverrideReason,
                $auditAdminId,
            ),
        );
    }

    /**
     * @param  list<int>  $articleIds
     * @return array<string,mixed>
     */
    public function batchTrashArticles(array $articleIds, int $auditAdminId, int $apiTokenId): array
    {
        return $this->executeBatch(
            'trash',
            $articleIds,
            fn (int $articleId): array => $this->trashArticle($articleId, $auditAdminId, $apiTokenId),
        );
    }

    /**
     * @param  list<int>  $articleIds
     * @return array<string,mixed>
     */
    public function batchRestoreArticles(array $articleIds, int $auditAdminId, int $apiTokenId): array
    {
        return $this->executeBatch(
            'restore',
            $articleIds,
            fn (int $articleId): array => $this->restoreArticle($articleId, $auditAdminId, $apiTokenId),
        );
    }

    /**
     * Each item uses a savepoint. Business rejections are committed so risk/quality
     * inspection evidence is retained, while unexpected failures roll back that item.
     *
     * @param  list<int>  $articleIds
     * @param  Closure(int):array<string,mixed>  $operation
     * @return array<string,mixed>
     */
    private function executeBatch(string $action, array $articleIds, Closure $operation): array
    {
        $succeeded = [];
        $failed = [];

        foreach ($articleIds as $articleId) {
            $articleId = (int) $articleId;
            try {
                $outcome = DB::transaction(function () use ($articleId, $operation): array {
                    try {
                        return ['result' => $operation($articleId), 'error' => null];
                    } catch (ApiException $exception) {
                        if ($exception->getHttpStatus() >= 500) {
                            throw $exception;
                        }

                        return ['result' => null, 'error' => $this->batchFailure($exception)];
                    }
                });
            } catch (Throwable $exception) {
                report($exception);
                $outcome = [
                    'result' => null,
                    'error' => [
                        'code' => 'article_batch_item_failed',
                        'message' => '文章处理失败，请稍后重试',
                        'http_status' => 500,
                        'details' => [],
                    ],
                ];
            }

            if (is_array($outcome['error'])) {
                $failed[] = [
                    'article_id' => $articleId,
                    'error' => $outcome['error'],
                ];

                continue;
            }

            $succeeded[] = [
                'article_id' => $articleId,
                'result' => $outcome['result'],
            ];
        }

        return [
            'action' => $action,
            'requested_count' => count($articleIds),
            'succeeded_count' => count($succeeded),
            'failed_count' => count($failed),
            'succeeded_ids' => array_values(array_map(
                static fn (array $item): int => (int) $item['article_id'],
                $succeeded,
            )),
            'failed_ids' => array_values(array_map(
                static fn (array $item): int => (int) $item['article_id'],
                $failed,
            )),
            'succeeded' => $succeeded,
            'failed' => $failed,
        ];
    }

    /** @return array{code:string,message:string,http_status:int,details:array<string,mixed>} */
    private function batchFailure(ApiException $exception): array
    {
        return [
            'code' => $exception->getErrorCode(),
            'message' => $exception->getMessage(),
            'http_status' => $exception->getHttpStatus(),
            'details' => $exception->getDetails(),
        ];
    }

    private function normalizeCreateInput(array $data): array
    {
        $title = trim((string) ($data['title'] ?? ''));
        $content = trim((string) ($data['content'] ?? ''));
        $excerpt = trim((string) ($data['excerpt'] ?? ''));
        $keywords = trim((string) ($data['keywords'] ?? ''));
        $metaDescription = trim((string) ($data['meta_description'] ?? ''));
        $riskOverrideReason = trim((string) ($data['risk_override_reason'] ?? ''));
        $errors = [];
        if ($title === '') {
            $errors['title'] = '文章标题不能为空';
        } elseif (mb_strlen($title, 'UTF-8') > 255) {
            $errors['title'] = '文章标题不能超过 255 个字符';
        }
        if ($content === '') {
            $errors['content'] = '文章内容不能为空';
        } elseif (mb_strlen($content, 'UTF-8') > ArticleRiskScanner::MAX_CONTENT_CHARACTERS) {
            $errors['content'] = '文章内容超过扫描长度上限';
        }
        if (mb_strlen($excerpt, 'UTF-8') > ArticleRiskScanner::MAX_EXCERPT_CHARACTERS) {
            $errors['excerpt'] = '文章摘要超过扫描长度上限';
        }
        if (mb_strlen($keywords, 'UTF-8') > 500) {
            $errors['keywords'] = '关键词不能超过 500 个字符';
        }
        if (mb_strlen($metaDescription, 'UTF-8') > 500) {
            $errors['meta_description'] = 'Meta 描述不能超过 500 个字符';
        }
        if (mb_strlen($riskOverrideReason, 'UTF-8') > 1000) {
            $errors['risk_override_reason'] = '风险放行原因不能超过 1000 个字符';
        }
        if ($errors !== []) {
            throw new ApiException('validation_failed', '参数校验失败', 422, ['field_errors' => $errors]);
        }

        $normalized = [
            'title' => $title,
            'content' => $content,
            'excerpt' => $excerpt,
            'keywords' => $keywords,
            'meta_description' => $metaDescription,
            'status' => trim((string) ($data['status'] ?? 'draft')),
            'review_status' => trim((string) ($data['review_status'] ?? 'pending')),
            'is_ai_generated' => $this->toFlag($data['is_ai_generated'] ?? 0),
            'risk_override_reason' => $riskOverrideReason,
        ];

        $normalized['slug'] = null;
        if (! empty($data['slug'])) {
            $slug = trim((string) $data['slug']);
            $this->ensureSlugAvailable($slug);
            $normalized['slug'] = $slug;
        }

        $normalized['category_id'] = $this->normalizeReference(Category::class, $data['category_id'] ?? null, 'category_id', true);
        $normalized['author_id'] = $this->normalizeReference(Author::class, $data['author_id'] ?? null, 'author_id', true);
        $normalized['task_id'] = $this->normalizeNullableReference(Task::class, $data['task_id'] ?? null, 'task_id');

        if ($normalized['is_ai_generated']) {
            $normalized = $this->articleCitationMarkerCleaner->cleanArticleFields($normalized);
            if (trim((string) $normalized['content']) === '') {
                throw new ApiException('validation_failed', '参数校验失败', 422, [
                    'field_errors' => ['content' => '文章内容不能为空'],
                ]);
            }
        }

        return $normalized;
    }

    /**
     * @param  array<string, mixed>  $existing
     */
    private function normalizeUpdateInput(array $data, array $existing): array
    {
        $normalized = [];
        $fieldErrors = [];

        if (array_key_exists('title', $data)) {
            $title = trim((string) $data['title']);
            if ($title === '') {
                $fieldErrors['title'] = '文章标题不能为空';
            } elseif (mb_strlen($title, 'UTF-8') > 255) {
                $fieldErrors['title'] = '文章标题不能超过 255 个字符';
            } else {
                $normalized['title'] = $title;
            }
        }

        if (array_key_exists('content', $data)) {
            $content = trim((string) $data['content']);
            if ($content === '') {
                $fieldErrors['content'] = '文章内容不能为空';
            } elseif (mb_strlen($content, 'UTF-8') > ArticleRiskScanner::MAX_CONTENT_CHARACTERS) {
                $fieldErrors['content'] = '文章内容超过扫描长度上限';
            } else {
                $normalized['content'] = $content;
            }
        }

        foreach (['excerpt', 'keywords', 'meta_description'] as $field) {
            if (array_key_exists($field, $data)) {
                $normalized[$field] = trim((string) $data[$field]);
            }
        }
        if (isset($normalized['excerpt']) && mb_strlen($normalized['excerpt'], 'UTF-8') > ArticleRiskScanner::MAX_EXCERPT_CHARACTERS) {
            $fieldErrors['excerpt'] = '文章摘要超过扫描长度上限';
        }
        foreach (['keywords', 'meta_description'] as $field) {
            if (isset($normalized[$field]) && mb_strlen($normalized[$field], 'UTF-8') > 500) {
                $fieldErrors[$field] = "{$field} 不能超过 500 个字符";
            }
        }

        if (array_key_exists('category_id', $data)) {
            $normalized['category_id'] = $this->normalizeReference(Category::class, $data['category_id'], 'category_id', true);
        }

        if (array_key_exists('author_id', $data)) {
            $normalized['author_id'] = $this->normalizeReference(Author::class, $data['author_id'], 'author_id', true);
        }

        if (array_key_exists('task_id', $data)) {
            $normalized['task_id'] = $this->normalizeNullableReference(Task::class, $data['task_id'], 'task_id');
        }

        if (array_key_exists('slug', $data)) {
            $slug = trim((string) $data['slug']);
            if ($slug === '') {
                $fieldErrors['slug'] = 'slug 不能为空';
            } else {
                $this->ensureSlugAvailable($slug, (int) $existing['id']);
                $normalized['slug'] = $slug;
            }
        } elseif (isset($normalized['title']) && $normalized['title'] !== $existing['title']) {
            $normalized['slug'] = ArticleWorkflow::generateUniqueSlug($normalized['title'], (int) $existing['id']);
        }

        if ((bool) ($existing['is_ai_generated'] ?? false)) {
            $normalized = $this->articleCitationMarkerCleaner->cleanArticleFields($normalized);
            if (array_key_exists('content', $normalized) && trim((string) $normalized['content']) === '') {
                $fieldErrors['content'] = '文章内容不能为空';
            }
        }

        if (! empty($fieldErrors)) {
            throw new ApiException('validation_failed', '参数校验失败', 422, ['field_errors' => $fieldErrors]);
        }

        return $normalized;
    }

    /**
     * @return array<string, mixed>
     */
    private function getArticleRecord(int $articleId): array
    {
        $article = Article::query()->whereKey($articleId)->first();
        if (! $article) {
            throw new ApiException('article_not_found', '文章不存在', 404);
        }

        return $article->getAttributes();
    }

    private function normalizeNullableReference(string $modelClass, mixed $value, string $field): ?int
    {
        return $this->normalizeReference($modelClass, $value, $field, false);
    }

    private function lockActiveTaskReference(?int $taskId): void
    {
        if ($taskId === null) {
            return;
        }

        $task = Task::query()
            ->whereKey($taskId)
            ->lockForUpdate()
            ->first(['id']);
        if (! $task) {
            throw new ApiException('validation_failed', '参数校验失败', 422, [
                'field_errors' => ['task_id' => 'task_id 对应资源不存在或任务已删除'],
            ]);
        }
    }

    private function normalizeReference(string $modelClass, mixed $value, string $field, bool $required = false): ?int
    {
        if ($value === null || $value === '' || (int) $value <= 0) {
            if ($required) {
                throw new ApiException('validation_failed', '参数校验失败', 422, [
                    'field_errors' => [$field => $this->requiredReferenceMessage($field)],
                ]);
            }

            return null;
        }

        $id = (int) $value;
        if (! $modelClass::query()->whereKey($id)->exists()) {
            throw new ApiException('validation_failed', '参数校验失败', 422, [
                'field_errors' => [$field => "{$field} 对应资源不存在"],
            ]);
        }

        return $id;
    }

    private function requiredReferenceMessage(string $field): string
    {
        return match ($field) {
            'category_id' => '请选择文章分类',
            'author_id' => '请选择文章作者',
            default => "{$field} 不能为空"
        };
    }

    private function ensureSlugAvailable(string $slug, ?int $excludeId = null): void
    {
        if (! $this->isSlugAvailable($slug, $excludeId)) {
            throw new ApiException('validation_failed', '参数校验失败', 422, [
                'field_errors' => ['slug' => 'slug 已存在'],
            ]);
        }
    }

    private function isSlugAvailable(string $slug, ?int $excludeId = null): bool
    {
        $q = Article::withTrashed()->where('slug', $slug);
        if ($excludeId !== null) {
            $q->where('id', '!=', $excludeId);
        }

        return ! $q->exists();
    }

    private function nullableInt(mixed $value): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }

        return (int) $value;
    }

    private function toFlag(mixed $value): int
    {
        if (is_bool($value)) {
            return $value ? 1 : 0;
        }
        if (is_numeric($value)) {
            return (int) $value > 0 ? 1 : 0;
        }

        return in_array(strtolower(trim((string) $value)), ['1', 'true', 'yes', 'on'], true) ? 1 : 0;
    }

    private function riskBlockedException(Article $article, ArticleRiskGateException $exception): ApiException
    {
        return new ApiException('article_risk_blocked', '文章风险检查未通过', 409, [
            'article_id' => (int) $article->getKey(),
            'risk_status' => $exception->riskStatus,
            'match_count' => (int) $exception->scan->match_count,
            'matches' => $exception->scan->matches ?? [],
        ]);
    }

    private function qualityBlockedException(Article $article, ArticleAiQualityGateException $exception): ApiException
    {
        return new ApiException($exception->getErrorCode(), $exception->getMessage(), 409, [
            'article_id' => (int) $article->getKey(),
            'ai_quality' => $this->aiQualitySummary($article->fresh('latestAiQualityCheck')),
        ]);
    }

    /** @return array<string, mixed> */
    private function aiQualitySummary(Article $article): array
    {
        $check = $article->latestAiQualityCheck;
        $progress = $this->articleAiQualityProgressPresenter->snapshot($check);
        $enabled = (bool) $article->ai_quality_required_at_creation
            || (bool) ($article->task?->ai_quality_enabled ?? false);
        $configuredMode = $article->ai_quality_retrieval_mode_override
            ?: $article->task?->ai_quality_retrieval_mode
            ?: AiQualityRetrievalMode::legacyDefault();

        return [
            'enabled' => $enabled,
            'config_version' => max(1, (int) $article->ai_quality_policy_version),
            'requested_retrieval_mode' => $configuredMode,
            'last_check_requested_retrieval_mode' => $check?->requested_retrieval_mode,
            'effective_retrieval_mode' => $check?->effective_retrieval_mode,
            'retrieval_strategy_version' => $check?->retrieval_strategy_version,
            'retrieval_failure_code' => $check?->retrieval_failure_code,
            'status' => $check?->status,
            'decision' => $check?->decision,
            'score' => $check?->score,
            'score_label' => $progress['score_label'] ?? null,
            'result_label' => $progress['result_label'] ?? null,
            'inspection_scope' => $progress['inspection_scope'] ?? 'full',
            'degraded' => (bool) ($progress['degraded'] ?? false),
            'primary_deadline_at' => $progress['primary_deadline_at'] ?? null,
            'sampled_deadline_at' => $progress['sampled_deadline_at'] ?? null,
            'deadline_at' => $progress['deadline_at'] ?? null,
            'coverage' => $progress['coverage'] ?? [],
            'fallback' => $progress['fallback'] ?? [],
            'pass_score' => $check?->pass_score,
            'manual_override_min_score' => $check?->manual_override_min_score,
            'knowledge_coverage' => $check?->knowledge_coverage,
            'evidence_coverage' => $check?->knowledge_coverage,
            'confidence' => $check?->confidence,
            'gate_reasons' => $check?->gate_reasons ?? [],
            'scoring_version' => $check?->scoring_version,
            'summary' => $check?->summary,
            'issues_count' => is_array($check?->issues) ? count($check->issues) : 0,
            'critical_issues_count' => collect($check?->issues ?? [])->where('severity', 'critical')->count(),
            'is_stale' => $check?->status === 'stale',
            'is_overridden' => (bool) ($check?->is_overridden ?? false),
            'checked_at' => $check?->finished_at?->toAtomString(),
        ];
    }

    /** @return array<string, mixed> */
    private function aiQualityDetail(Article $article): array
    {
        $check = $article->latestAiQualityCheck;

        return array_replace($this->aiQualitySummary($article), [
            'check_id' => $check?->id,
            'prompt_id' => $check?->prompt_id,
            'prompt_name' => $check?->prompt?->name,
            'ai_model_id' => $check?->ai_model_id,
            'ai_model_name' => $check?->aiModel?->name,
            'dimension_scores' => $check?->dimension_scores ?? [],
            'issues' => $check?->issues ?? [],
            'uncertainties' => $check?->uncertainties ?? [],
            'is_overridden' => (bool) ($check?->is_overridden ?? false),
            'override_reason' => $check?->override_reason,
            'overridden_by_name' => $check?->overridden_by_name,
            'overridden_at' => $check?->overridden_at?->toAtomString(),
            'error_code' => $check?->error_code,
            'error_message' => $check?->error_message,
            'input_fingerprint' => $check?->input_fingerprint,
        ]);
    }

    private function qualityConfigurationHash(Article $article): string
    {
        return hash('sha256', json_encode([
            'mode' => $article->ai_quality_retrieval_mode_override,
            'knowledge_base_ids' => $this->articleAiQualityConfigurationService
                ->effectiveKnowledgeBaseIds($article),
            'policy_version' => max(1, (int) $article->ai_quality_policy_version),
        ], JSON_THROW_ON_ERROR));
    }

    private function applyAiQualityFilter($query, string $filter): void
    {
        match ($filter) {
            'passed' => $query->whereHas('latestAiQualityCheck', fn ($check) => $check->where('status', 'completed')->where('decision', 'passed')),
            'needs_review', 'blocked' => $query->whereHas(
                'latestAiQualityCheck',
                fn ($check) => $check->where('status', 'completed')->where('decision', $filter),
            ),
            'pending' => $query
                ->where(function ($enabled): void {
                    $enabled->where('ai_quality_required_at_creation', true)
                        ->orWhereHas('task', fn ($task) => $task->where('ai_quality_enabled', true));
                })
                ->where(function ($pending): void {
                    $pending->whereDoesntHave('latestAiQualityCheck')
                        ->orWhereHas('latestAiQualityCheck', fn ($check) => $check->whereIn('status', ['queued', 'running']));
                }),
            'failed', 'error' => $query->whereHas(
                'latestAiQualityCheck',
                fn ($check) => $check->where('status', 'failed')->orWhere('decision', 'error'),
            ),
            'stale' => $query->whereHas('latestAiQualityCheck', fn ($check) => $check->where('status', 'stale')),
            'disabled' => $query->where('ai_quality_required_at_creation', false)
                ->whereDoesntHave('task', fn ($task) => $task->where('ai_quality_enabled', true)),
            default => null,
        };
    }
}
