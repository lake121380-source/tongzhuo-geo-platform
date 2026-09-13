<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\AiModelAccessException;
use App\Exceptions\ApiException;
use App\Http\Controllers\Shared\ArticleEditorAssetController;
use App\Http\Requests\Api\ArticleAiOptimizationActionRequest;
use App\Http\Requests\Api\BatchArticleRequest;
use App\Http\Requests\Api\BatchReviewArticlesRequest;
use App\Http\Requests\Api\BatchUpdateArticleStatusRequest;
use App\Http\Requests\Api\StartArticleAiOptimizationRequest;
use App\Http\Requests\Api\UpdateArticleRequest;
use App\Models\Admin;
use App\Models\AiModel;
use App\Models\Article;
use App\Models\ArticleAiOptimizationRun;
use App\Services\Admin\AdminAiModelAccessResolver;
use App\Services\Api\ApiTokenService;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\AiQualityAuditService;
use App\Services\GeoFlow\ArticleAiOptimizationCoordinator;
use App\Services\GeoFlow\ArticleAiOptimizationException;
use App\Services\GeoFlow\ArticleGeoFlowService;
use App\Services\GeoFlow\ArticleMarkdownExportService;
use App\Services\GeoFlow\ArticleRiskScanner;
use App\Support\Admin\WeChatArticleHtmlExporter;
use App\Support\ApiResponse;
use App\Support\GeoFlow\ArticleWorkflow;
use DomainException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\URL;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * API v1 文章（articles）管理：列表、创建、详情、更新、审核、发布、软删除。
 *
 * 读：articles:read；写：articles:write；审核/发布：articles:publish。
 * 部分写操作支持幂等键，与遗留路由键一致。
 */
class ArticleController extends BaseApiController
{
    /**
     * 分页列表，支持多维筛选。
     *
     * 查询参数：page、per_page、task_id、status、review_status、author_id、search（标题/正文模糊）。
     */
    public function index(Request $request, ArticleGeoFlowService $articles): JsonResponse
    {
        $taskId = $request->integer('task_id', 0);
        $authorId = $request->integer('author_id', 0);

        $filters = [];
        if ($taskId > 0) {
            $filters['task_id'] = $taskId;
        }
        if ($authorId > 0) {
            $filters['author_id'] = $authorId;
        }
        $status = $request->query('status');
        if (is_string($status) && trim($status) !== '') {
            $filters['status'] = trim($status);
        }
        $reviewStatus = $request->query('review_status');
        if (is_string($reviewStatus) && trim($reviewStatus) !== '') {
            $filters['review_status'] = trim($reviewStatus);
        }
        $aiQualityStatus = $request->query('ai_quality_status');
        if (is_string($aiQualityStatus) && trim($aiQualityStatus) !== '') {
            $filters['ai_quality_status'] = trim($aiQualityStatus);
        }
        $search = $request->query('search');
        if (is_string($search) && trim($search) !== '') {
            $filters['search'] = trim($search);
        }
        $trash = trim(strtolower((string) $request->query('trash', '')));
        if (in_array($trash, ['only', 'with'], true)) {
            $filters['trash'] = $trash;
        }

        return $this->success($request, $articles->listArticles(
            $request->integer('page', 1),
            $request->integer('per_page', 20),
            $filters
        ));
    }

    /**
     * 创建文章；成功 HTTP 201。幂等键：POST /articles。
     */
    public function store(Request $request, ArticleGeoFlowService $articles, ApiTokenService $tokens): JsonResponse
    {
        $body = $request->all();
        $requestsPublication = in_array(trim((string) ($body['status'] ?? 'draft')), ['published', 'private'], true)
            || in_array(trim((string) ($body['review_status'] ?? 'pending')), ['approved', 'auto_approved'], true)
            || trim((string) ($body['risk_override_reason'] ?? '')) !== '';
        if ($requestsPublication && ! $tokens->tokenHasScope($this->auth($request)->token, 'articles:publish')) {
            throw new ApiException('forbidden', '当前 Token 没有发布或风险放行权限', 403, [
                'required_scope' => 'articles:publish',
            ]);
        }

        return IdempotencyService::executeJson($request, 'POST /articles', function () use ($request, $articles): JsonResponse {
            try {
                return $this->success($request, $articles->createArticle(
                    $request->all(),
                    $this->auth($request)->auditAdminId
                ), 201);
            } catch (ApiException $exception) {
                return $this->riskBlockedResponse($request, $exception);
            }
        });
    }

    /**
     * 单篇详情（含关联任务名、作者名、分类名与配图列表）。
     */
    public function show(Request $request, int $article, ArticleGeoFlowService $articles): JsonResponse
    {
        return $this->success($request, $articles->getArticle($article));
    }

    /**
     * 返回轻量 AI 质检进度，不包含文章正文、证据正文或供应商错误。
     */
    public function aiQualityStatus(Request $request, int $article, ArticleGeoFlowService $articles): JsonResponse
    {
        return $this->success($request, $articles->getAiQualityStatus($article));
    }

    /**
     * 部分更新文章。幂等键：PATCH /articles/{id}。
     */
    public function update(
        UpdateArticleRequest $request,
        int $article,
        ArticleGeoFlowService $articles,
        ApiTokenService $tokens,
        AiQualityAuditService $audit,
    ): JsonResponse {
        $qualityConfigurationFields = [
            'ai_quality_retrieval_mode_override',
            'ai_quality_knowledge_base_ids',
        ];
        $hasQualityConfiguration = collect($qualityConfigurationFields)
            ->contains(static fn (string $field): bool => $request->exists($field));
        $hasProtectedQualityPolicyChange = $hasQualityConfiguration || $request->exists('task_id');
        $auth = $this->auth($request);
        if ($hasProtectedQualityPolicyChange && ! $tokens->tokenHasScope($auth->token, 'articles:publish')) {
            $audit->record('article_quality_configuration_authorization_denied', [
                'article_id' => $article,
                'admin_id' => $auth->auditAdminId,
                'api_token_id' => (int) ($auth->token['id'] ?? 0) ?: null,
                'authorization_result' => 'denied',
                'reason_code' => 'articles_publish_scope_required',
            ]);

            throw new ApiException('forbidden', '当前 Token 没有修改 AI 质检配置的权限', 403, [
                'required_scope' => 'articles:publish',
            ]);
        }

        try {
            return IdempotencyService::executeJson($request, 'PATCH /articles/{id}', function () use (
                $request,
                $article,
                $articles,
                $auth,
                $hasQualityConfiguration,
                $hasProtectedQualityPolicyChange,
                $qualityConfigurationFields,
            ): JsonResponse {
                $result = DB::transaction(function () use (
                    $request,
                    $article,
                    $articles,
                    $auth,
                    $hasQualityConfiguration,
                    $hasProtectedQualityPolicyChange,
                    $qualityConfigurationFields,
                ): array {
                    $configurationVersion = null;
                    if ($hasProtectedQualityPolicyChange) {
                        $expectedVersion = $this->requestedConfigurationVersion($request);
                        $lockedArticle = Article::query()
                            ->whereKey($article)
                            ->lockForUpdate()
                            ->first();
                        $articles->assertAiQualityConfigurationVersion($lockedArticle ?? $article, $expectedVersion);
                        $articles->assertCanManageArticleQualityPolicy(
                            $lockedArticle ?? $article,
                            $auth->auditAdminId,
                            $request->input('task_id'),
                            $request->exists('task_id'),
                        );
                        $configurationVersion = $expectedVersion;
                    }

                    $articleFields = Arr::except($request->all(), [...$qualityConfigurationFields, 'config_version']);
                    if ($articleFields !== []) {
                        $articles->updateArticle($article, $articleFields, $auth->auditAdminId);
                    }

                    if ($hasQualityConfiguration) {
                        $configurationVersion = max(1, (int) Article::query()
                            ->whereKey($article)
                            ->value('ai_quality_policy_version'));

                        return $articles->updateAiQualityConfiguration(
                            articleId: $article,
                            requestedMode: $request->exists('ai_quality_retrieval_mode_override')
                                ? $request->input('ai_quality_retrieval_mode_override')
                                : null,
                            modeProvided: $request->exists('ai_quality_retrieval_mode_override'),
                            knowledgeBaseIds: $request->exists('ai_quality_knowledge_base_ids')
                                ? (array) $request->input('ai_quality_knowledge_base_ids', [])
                                : null,
                            expectedVersion: $configurationVersion,
                            auditAdminId: $auth->auditAdminId,
                            apiTokenId: (int) ($auth->token['id'] ?? 0),
                        );
                    }

                    if ($articleFields === []) {
                        throw new ApiException('validation_failed', '没有可更新的字段', 422);
                    }

                    return $articles->getArticle($article);
                });

                return $this->success($request, $result);
            });
        } catch (ApiException $exception) {
            if ($exception->getErrorCode() === 'forbidden' && $hasProtectedQualityPolicyChange) {
                $audit->record('article_quality_configuration_authorization_denied', [
                    'article_id' => $article,
                    'admin_id' => $auth->auditAdminId,
                    'api_token_id' => (int) ($auth->token['id'] ?? 0) ?: null,
                    'authorization_result' => 'denied',
                    'reason_code' => (string) ($exception->getDetails()['reason_code'] ?? 'quality_policy_permission_required'),
                ]);
            }

            throw $exception;
        } catch (DomainException $exception) {
            // 托管文章指纹冲突。旧 Blade 后台把它翻成「回表单 + 会话错误」，API 面给 422 稳定错误码。
            throw new ApiException('hosted_article_fingerprint_conflict', $exception->getMessage(), 422);
        }
    }

    /**
     * 提交审核结果。请求体：review_status、review_note，风险放行时显式传 risk_override_reason。
     *
     * audit 管理员 ID 来自 Token 解析的 auditAdminId。幂等键：POST /articles/{id}/review。
     */
    public function review(Request $request, int $article, ArticleGeoFlowService $articles): JsonResponse
    {
        $body = $request->all();

        return IdempotencyService::executeJson($request, 'POST /articles/{id}/review', function () use ($request, $article, $articles, $body): JsonResponse {
            try {
                return $this->success($request, $articles->reviewArticle(
                    $article,
                    trim((string) ($body['review_status'] ?? '')),
                    trim((string) ($body['review_note'] ?? '')),
                    trim((string) ($body['risk_override_reason'] ?? '')),
                    $this->auth($request)->auditAdminId
                ));
            } catch (ApiException $exception) {
                return $this->riskBlockedResponse($request, $exception);
            }
        });
    }

    /**
     * 在审核已通过的前提下将文章置为发布状态。幂等键：POST /articles/{id}/publish。
     */
    public function publish(Request $request, int $article, ArticleGeoFlowService $articles): JsonResponse
    {
        return IdempotencyService::executeJson($request, 'POST /articles/{id}/publish', function () use ($request, $article, $articles): JsonResponse {
            try {
                return $this->success($request, $articles->publishArticle(
                    $article,
                    $this->auth($request)->auditAdminId
                ));
            } catch (ApiException $exception) {
                return $this->riskBlockedResponse($request, $exception);
            }
        });
    }

    public function batchReview(
        BatchReviewArticlesRequest $request,
        ArticleGeoFlowService $articles,
    ): JsonResponse {
        $auth = $this->auth($request);

        return IdempotencyService::executeJson(
            $request,
            'POST /articles/batch/review',
            fn (): JsonResponse => $this->success($request, $articles->batchReviewArticles(
                array_map('intval', $request->validated('article_ids')),
                trim((string) $request->validated('review_status')),
                trim((string) ($request->validated('review_note') ?? '')),
                trim((string) ($request->validated('risk_override_reason') ?? '')),
                $auth->auditAdminId,
            )),
        );
    }

    public function batchPublish(
        BatchArticleRequest $request,
        ArticleGeoFlowService $articles,
    ): JsonResponse {
        $auth = $this->auth($request);

        return IdempotencyService::executeJson(
            $request,
            'POST /articles/batch/publish',
            fn (): JsonResponse => $this->success($request, $articles->batchPublishArticles(
                array_map('intval', $request->validated('article_ids')),
                $auth->auditAdminId,
            )),
        );
    }

    /**
     * 批量改文章状态——旧后台 `articles/batch/update-status` 的 API 等价物。
     *
     * 退役核验时发现这条操作**只存在于旧后台**：`articles/batch/*` 原先只有
     * review / publish / trash / restore / force-delete，而 `PATCH articles/{id}`
     * 不接受 `status` 字段，于是「把已发布的文章撤回成草稿」在新后台做不了
     * （撤回 ≠ 删除：删除进回收站，撤回是留在列表里改状态）。这里补齐。
     */
    public function batchUpdateStatus(
        BatchUpdateArticleStatusRequest $request,
        ArticleGeoFlowService $articles,
    ): JsonResponse {
        $auth = $this->auth($request);

        return IdempotencyService::executeJson(
            $request,
            'POST /articles/batch/status',
            fn (): JsonResponse => $this->success($request, $articles->batchUpdateStatusArticles(
                array_map('intval', $request->validated('article_ids')),
                trim((string) $request->validated('new_status')),
                trim((string) ($request->validated('risk_override_reason') ?? '')),
                $auth->auditAdminId,
            )),
        );
    }

    public function batchTrash(
        BatchArticleRequest $request,
        ArticleGeoFlowService $articles,
    ): JsonResponse {
        $auth = $this->auth($request);

        return IdempotencyService::executeJson(
            $request,
            'POST /articles/batch/trash',
            fn (): JsonResponse => $this->success($request, $articles->batchTrashArticles(
                array_map('intval', $request->validated('article_ids')),
                $auth->auditAdminId,
                (int) ($auth->token['id'] ?? 0),
            )),
        );
    }

    public function batchRestore(
        BatchArticleRequest $request,
        ArticleGeoFlowService $articles,
    ): JsonResponse {
        $auth = $this->auth($request);

        return IdempotencyService::executeJson(
            $request,
            'POST /articles/batch/restore',
            fn (): JsonResponse => $this->success($request, $articles->batchRestoreArticles(
                array_map('intval', $request->validated('article_ids')),
                $auth->auditAdminId,
                (int) ($auth->token['id'] ?? 0),
            )),
        );
    }

    /** Restore one article from the recycle bin. */
    public function restore(Request $request, int $article, ArticleGeoFlowService $articles): JsonResponse
    {
        $auth = $this->auth($request);

        return IdempotencyService::executeJson(
            $request,
            'POST /articles/{id}/restore',
            fn (): JsonResponse => $this->success($request, $articles->restoreArticle(
                $article,
                $auth->auditAdminId,
                (int) ($auth->token['id'] ?? 0),
            )),
        );
    }

    /** Permanently remove selected trashed articles. Super-admin only. */
    public function batchForceDelete(Request $request, AiQualityAuditService $audit): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $this->assertSuperAdmin($admin);
        $payload = $request->validate([
            'article_ids' => ['required', 'array', 'min:1', 'max:500'],
            'article_ids.*' => ['bail', 'integer', 'min:1', 'distinct'],
        ]);

        return IdempotencyService::executeJson($request, 'POST /articles/batch/force-delete', function () use ($request, $payload, $admin, $audit): JsonResponse {
            $ids = array_map('intval', array_values($payload['article_ids']));
            $deleted = DB::transaction(function () use ($ids, $admin, $audit): int {
                $models = Article::onlyTrashed()->whereIn('id', $ids)->orderBy('id')->lockForUpdate()->get();
                foreach ($models as $model) {
                    $audit->record('article_force_deleted', [
                        'article_id' => (int) $model->id,
                        'admin_id' => (int) $admin->id,
                        'reason_code' => 'article_trash_force_delete',
                    ]);
                    $model->forceDelete();
                }

                return $models->count();
            });

            return $this->success($request, ['deleted_count' => $deleted, 'requested_count' => count($ids)]);
        });
    }

    /** Empty the article recycle bin. Super-admin only. */
    public function emptyTrash(Request $request, AiQualityAuditService $audit): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $this->assertSuperAdmin($admin);

        return IdempotencyService::executeJson($request, 'POST /articles/trash/empty', function () use ($request, $admin, $audit): JsonResponse {
            $deleted = DB::transaction(function () use ($admin, $audit): int {
                $models = Article::onlyTrashed()->orderBy('id')->lockForUpdate()->get();
                foreach ($models as $model) {
                    $audit->record('article_force_deleted', [
                        'article_id' => (int) $model->id,
                        'admin_id' => (int) $admin->id,
                        'reason_code' => 'article_trash_empty',
                    ]);
                    $model->forceDelete();
                }

                return $models->count();
            });

            return $this->success($request, ['deleted_count' => $deleted]);
        });
    }

    /** Re-run the deterministic sensitive-word scan and downgrade unsafe published state. */
    public function recheckRisk(Request $request, int $article, ArticleRiskScanner $scanner): JsonResponse
    {
        $auth = $this->auth($request);

        return IdempotencyService::executeJson($request, 'POST /articles/{id}/risk-scan', function () use ($request, $article, $scanner, $auth): JsonResponse {
            $result = DB::transaction(function () use ($article, $scanner, $auth): array {
                $model = Article::query()->whereKey($article)->lockForUpdate()->first();
                if (! $model) {
                    throw new ApiException('article_not_found', '文章不存在', 404);
                }
                $scan = $model->latestRiskScan()->first();
                if ($scan === null || ! $scanner->isFresh($model, $scan)) {
                    $scan = $scanner->record($model, 'api_recheck', $auth->auditAdminId);
                }
                $downgraded = $scan->status !== 'clean'
                    && ! ($scan->status === 'warning' && $scan->is_overridden)
                    && (in_array((string) $model->status, ['published', 'private'], true)
                        || in_array((string) $model->review_status, ['approved', 'auto_approved'], true));
                if ($downgraded) {
                    $model->update(ArticleWorkflow::normalizeState('draft', 'pending'));
                }

                return [
                    'article_id' => (int) $model->id,
                    'scan' => [
                        'status' => (string) $scan->status,
                        'match_count' => (int) $scan->match_count,
                        'matches' => (array) $scan->matches,
                        'scanned_at' => $scan->scanned_at?->toIso8601String(),
                    ],
                    'downgraded' => $downgraded,
                    'article' => [
                        'id' => (int) $model->id,
                        'status' => (string) $model->status,
                        'review_status' => (string) $model->review_status,
                    ],
                ];
            });

            return $this->success($request, $result);
        });
    }

    /** Prepare a governed Markdown ZIP export and return a short-lived signed URL. */
    public function prepareMarkdownExport(Request $request, ArticleMarkdownExportService $exporter): JsonResponse
    {
        $auth = $this->auth($request);
        $payload = $request->validate([
            'article_ids' => ['required', 'array', 'min:1', 'max:'.ArticleMarkdownExportService::MAX_ARTICLES],
            'article_ids.*' => ['bail', 'integer', 'min:1', 'distinct'],
        ]);
        $adminId = $auth->auditAdminId;

        return IdempotencyService::executeJson($request, 'POST /articles/markdown-export/prepare', function () use ($request, $exporter, $payload, $adminId): JsonResponse {
            $export = $exporter->prepare($adminId, array_map('intval', array_values($payload['article_ids'])));
            $expiresAt = now()->addMinutes(ArticleMarkdownExportService::DOWNLOAD_TTL_MINUTES);
            $downloadUrl = URL::temporarySignedRoute('api.v1.articles.markdown-export.download', $expiresAt, [
                'exportToken' => $export['token'],
                'owner' => $adminId,
                'filename' => $export['filename'],
            ], absolute: false);

            return $this->success($request, [
                'count' => $export['count'],
                'filename' => $export['filename'],
                'download_url' => $downloadUrl,
                'expires_at' => $expiresAt->toIso8601String(),
            ]);
        });
    }

    /** Download a prepared Markdown ZIP; signature and owner are both enforced. */
    public function downloadMarkdownExport(Request $request, string $exportToken, ArticleMarkdownExportService $exporter): BinaryFileResponse
    {
        $adminId = $this->auth($request)->auditAdminId;
        $owner = filter_var($request->query('owner'), FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => PHP_INT_MAX]]);
        $filename = (string) $request->query('filename', '');
        abort_unless(is_int($owner) && $owner === $adminId, 404);
        abort_unless(preg_match('/\Ageoflow-articles-\d{8}-\d{6}\.zip\z/D', $filename) === 1, 404);
        $path = $exporter->resolveDownload($adminId, $exportToken);
        abort_if($path === null, 404);

        return response()->download($path, $filename, [
            'Content-Type' => 'application/zip',
            'Cache-Control' => 'private, no-store, max-age=0',
        ]);
    }

    /** Convert Markdown content to copy-ready WeChat HTML. */
    public function exportWeChatHtml(Request $request, WeChatArticleHtmlExporter $exporter): JsonResponse
    {
        $payload = $request->validate(['content' => ['required', 'string', 'max:1000000']]);
        $html = $exporter->toHtml((string) $payload['content']);
        if ($html === '') {
            throw new ApiException('validation_failed', '正文不能为空', 422);
        }

        return $this->success($request, ['html' => $html, 'plain' => $exporter->toPlainText($html)]);
    }

    /** Reuse the existing managed-image workflow under the API envelope. */
    public function uploadEditorImage(Request $request, int $article, ArticleEditorAssetController $assets): JsonResponse
    {
        $response = $assets->uploadImage($request, $article);
        $data = $response->getData(true);
        if ($response->getStatusCode() >= 400) {
            throw new ApiException('article_editor_image_upload_failed', (string) ($data['message'] ?? '图片上传失败'), $response->getStatusCode());
        }

        return $this->success($request, is_array($data) ? $data : []);
    }

    private function assertSuperAdmin(Admin $admin): void
    {
        if (! $admin->isSuperAdmin()) {
            throw new ApiException('forbidden', '仅超级管理员可执行此操作', 403, ['required_role' => 'super_admin']);
        }
    }

    /**
     * 按最新文章、知识库、提示词、模型和规则重新执行 AI 质检。
     */
    public function recheckAiQuality(Request $request, int $article, ArticleGeoFlowService $articles): JsonResponse
    {
        $auth = $this->auth($request);
        $expectedVersion = $this->requestedConfigurationVersion($request);

        return IdempotencyService::executeJson(
            $request,
            'POST /articles/{id}/ai-quality/recheck',
            function () use ($request, $article, $articles, $auth, $expectedVersion): JsonResponse {
                return $this->success($request, $articles->recheckAiQuality(
                    $article,
                    $auth->auditAdminId,
                    (int) ($auth->token['id'] ?? 0),
                    $expectedVersion,
                ));
            },
            fingerprintContext: fn (): array => $articles->aiQualityIdempotencyContext(
                $article,
                $auth->auditAdminId,
            ),
        );
    }

    private function requestedConfigurationVersion(Request $request): int
    {
        $value = $request->input('config_version');
        if ($value === null) {
            $ifMatch = trim((string) $request->header('If-Match', ''));
            if (preg_match('/\A(?:W\/)?"?(\d+)"?\z/', $ifMatch, $matches) === 1) {
                $value = $matches[1];
            }
        }
        if (! is_numeric($value) || (int) $value < 1) {
            throw new ApiException(
                'article_ai_quality_config_version_required',
                '请提供当前 AI 质检配置版本',
                409,
                ['required_field' => 'config_version'],
            );
        }

        return (int) $value;
    }

    /**
     * 对达到人工审核最低分的 needs_review 结果记录依据并放行。
     */
    public function overrideAiQuality(
        Request $request,
        int $article,
        ArticleGeoFlowService $articles,
        AiQualityAuditService $audit,
    ): JsonResponse {
        $auth = $this->auth($request);
        try {
            return IdempotencyService::executeJson(
                $request,
                'POST /articles/{id}/ai-quality/override',
                fn (): JsonResponse => $this->success($request, $articles->overrideAiQuality(
                    $article,
                    trim((string) $request->input('reason', '')),
                    $auth->auditAdminId,
                    (int) ($auth->token['id'] ?? 0),
                )),
                fingerprintContext: fn (): array => $articles->aiQualityIdempotencyContext(
                    $article,
                    $auth->auditAdminId,
                ),
            );
        } catch (ApiException $exception) {
            if ($exception->getErrorCode() === 'forbidden') {
                $audit->record('article_quality_decision_authorization_denied', [
                    'article_id' => $article,
                    'admin_id' => $auth->auditAdminId,
                    'api_token_id' => (int) ($auth->token['id'] ?? 0) ?: null,
                    'authorization_result' => 'denied',
                    'reason_code' => (string) ($exception->getDetails()['reason_code'] ?? 'quality_decision_permission_required'),
                ]);
            }

            throw $exception;
        }
    }

    public function startAiOptimization(
        StartArticleAiOptimizationRequest $request,
        int $article,
        ArticleAiOptimizationCoordinator $coordinator,
        AdminAiModelAccessResolver $modelAccessResolver,
    ): JsonResponse {
        return IdempotencyService::executeJson($request, 'POST /articles/{id}/ai-quality/optimization', function () use ($request, $article, $coordinator, $modelAccessResolver): JsonResponse {
            $modelArticle = Article::query()->with('task.aiModel')->find($article);
            if (! $modelArticle) {
                throw new ApiException('article_not_found', '文章不存在', 404);
            }
            $model = $request->integer('optimization_model_id') > 0
                ? AiModel::query()->find($request->integer('optimization_model_id'))
                : $modelArticle->task?->aiModel;
            if (! $model instanceof AiModel) {
                throw new ApiException('article_ai_optimization_model_required', '请选择有效的内容模型', 422);
            }
            $actor = Admin::query()->find($this->auth($request)->auditAdminId);
            if (! $actor instanceof Admin) {
                throw new ApiException('unauthorized', '未认证', 401);
            }
            try {
                $modelAccessResolver->assertUsable($actor, $model);
            } catch (AiModelAccessException $exception) {
                $status = $exception->getErrorCode() === AiModelAccessException::AI_MODEL_NOT_ACCESSIBLE
                    ? 404
                    : 409;

                throw new ApiException($exception->getErrorCode(), '选择的 AI 模型当前不可用', $status);
            }
            try {
                $coordinator->start(
                    $modelArticle,
                    (string) $request->validated('strategy'),
                    $model,
                    ArticleAiOptimizationRun::TRIGGER_API_MANUAL,
                    $this->auth($request)->auditAdminId,
                );
            } catch (ArticleAiOptimizationException $exception) {
                throw $this->optimizationException($exception);
            }

            return $this->success($request, (array) $coordinator->statusForArticle($article), 202);
        });
    }

    public function aiOptimizationCandidate(
        Request $request,
        int $article,
        int $run,
        ArticleAiOptimizationCoordinator $coordinator,
    ): JsonResponse {
        $this->assertOwnedOptimizationRun($article, $run);
        try {
            return $this->success($request, $coordinator->candidate($run));
        } catch (ArticleAiOptimizationException $exception) {
            throw $this->optimizationException($exception);
        }
    }

    public function latestAiOptimizationCandidate(
        Request $request,
        int $article,
        ArticleAiOptimizationCoordinator $coordinator,
    ): JsonResponse {
        $run = ArticleAiOptimizationRun::query()
            ->where('article_id', $article)
            ->whereNotNull('best_check_id')
            ->latest('id')
            ->first();
        if (! $run) {
            throw new ApiException('article_ai_optimization_not_found', 'AI 优化候选不存在', 404);
        }
        try {
            return $this->success($request, $coordinator->candidate((int) $run->id));
        } catch (ArticleAiOptimizationException $exception) {
            throw $this->optimizationException($exception);
        }
    }

    public function applyAiOptimization(
        ArticleAiOptimizationActionRequest $request,
        int $article,
        int $run,
        ArticleAiOptimizationCoordinator $coordinator,
    ): JsonResponse {
        return IdempotencyService::executeJson($request, 'POST /articles/{id}/ai-quality/optimization/{run}/apply', function () use ($request, $article, $run, $coordinator): JsonResponse {
            $this->assertOwnedOptimizationRun($article, $run);
            try {
                $coordinator->apply($run, (string) $request->validated('candidate_hash'), $this->auth($request)->auditAdminId);
            } catch (ArticleAiOptimizationException $exception) {
                throw $this->optimizationException($exception);
            }

            return $this->success($request, (array) $coordinator->statusForArticle($article));
        });
    }

    public function cancelAiOptimization(
        ArticleAiOptimizationActionRequest $request,
        int $article,
        int $run,
        ArticleAiOptimizationCoordinator $coordinator,
    ): JsonResponse {
        return IdempotencyService::executeJson($request, 'POST /articles/{id}/ai-quality/optimization/{run}/cancel', function () use ($request, $article, $run, $coordinator): JsonResponse {
            $this->assertOwnedOptimizationRun($article, $run);
            $coordinator->cancel(
                $run,
                adminId: $this->auth($request)->auditAdminId,
            );

            return $this->success($request, (array) $coordinator->statusForArticle($article));
        });
    }

    public function rollbackAiOptimization(
        ArticleAiOptimizationActionRequest $request,
        int $article,
        int $run,
        ArticleAiOptimizationCoordinator $coordinator,
    ): JsonResponse {
        return IdempotencyService::executeJson($request, 'POST /articles/{id}/ai-quality/optimization/{run}/rollback', function () use ($request, $article, $run, $coordinator): JsonResponse {
            $this->assertOwnedOptimizationRun($article, $run);
            try {
                $coordinator->rollback($run, $this->auth($request)->auditAdminId);
            } catch (ArticleAiOptimizationException $exception) {
                throw $this->optimizationException($exception);
            }

            return $this->success($request, (array) $coordinator->statusForArticle($article));
        });
    }

    /**
     * 软删除文章（写入 deleted_at）。幂等键：POST /articles/{id}/trash。
     */
    public function trash(Request $request, int $article, ArticleGeoFlowService $articles): JsonResponse
    {
        $auth = $this->auth($request);

        return IdempotencyService::executeJson(
            $request,
            'POST /articles/{id}/trash',
            fn (): JsonResponse => $this->success($request, $articles->trashArticle(
                $article,
                $auth->auditAdminId,
                (int) ($auth->token['id'] ?? 0),
            )),
        );
    }

    private function riskBlockedResponse(Request $request, ApiException $exception): JsonResponse
    {
        if ($exception->getErrorCode() !== 'article_risk_blocked'
            && ! str_starts_with($exception->getErrorCode(), 'article_ai_quality_')) {
            throw $exception;
        }

        $requestId = $this->requestId($request);
        $response = ApiResponse::error(
            $exception->getErrorCode(),
            $exception->getMessage(),
            $requestId,
            $exception->getHttpStatus(),
            $exception->getDetails(),
        )->withHeaders(['X-Request-Id' => $requestId]);

        return $response;
    }

    private function assertOwnedOptimizationRun(int $articleId, int $runId): ArticleAiOptimizationRun
    {
        $run = ArticleAiOptimizationRun::query()
            ->whereKey($runId)
            ->where('article_id', $articleId)
            ->first();
        if (! $run) {
            throw new ApiException('article_ai_optimization_not_found', 'AI 优化运行不存在', 404);
        }

        return $run;
    }

    private function optimizationException(ArticleAiOptimizationException $exception): ApiException
    {
        return new ApiException(
            $exception->errorCode(),
            $exception->getMessage(),
            $exception->httpStatus(),
        );
    }
}
