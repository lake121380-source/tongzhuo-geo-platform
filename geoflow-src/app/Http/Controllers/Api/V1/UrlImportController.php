<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\AiModelAccessException;
use App\Exceptions\ApiException;
use App\Http\Requests\Api\StoreUrlImportRequest;
use App\Jobs\ProcessUrlImportJob;
use App\Models\AiModel;
use App\Models\UrlImportJob;
use App\Models\UrlImportJobLog;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\UrlImportAiExecutionGuard;
use App\Services\GeoFlow\UrlImportProcessingService;
use Closure;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Throwable;

/**
 * Authenticated API projection for 桐灼GEO's URL-to-knowledge importer.
 *
 * The legacy controller returns Blade redirects and is intentionally not used
 * by the React admin.  This controller keeps the same processing service,
 * execution identity and outbound URL safety policy while exposing a stable
 * JSON contract with owner checks and idempotent mutations.
 */
final class UrlImportController extends BaseApiController
{
    public function __construct(
        private readonly UrlImportProcessingService $processing,
        private readonly UrlImportAiExecutionGuard $executionGuard,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $query = UrlImportJob::query()->latest('id');
        if (! $admin->isSuperAdmin()) {
            $query->where('model_access_admin_id', $admin->getKey());
        }

        $page = max(1, $request->integer('page', 1));
        $perPage = max(1, min(50, $request->integer('per_page', 20)));
        $jobs = $query->paginate($perPage, ['*'], 'page', $page);

        return $this->success($request, [
            'items' => $jobs->getCollection()->map(fn (UrlImportJob $job): array => $this->summary($job))->values()->all(),
            'pagination' => [
                'page' => (int) $jobs->currentPage(),
                'per_page' => (int) $jobs->perPage(),
                'total' => (int) $jobs->total(),
                'total_pages' => (int) $jobs->lastPage(),
            ],
        ]);
    }

    public function store(StoreUrlImportRequest $request): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        $validated = $request->validated();

        $data = array_replace([
            'project_name' => '',
            'source_label' => '',
            'content_language' => '',
            'notes' => '',
            'outputs' => ['knowledge', 'keywords', 'titles'],
        ], $validated);

        // These values are populated by operationGuard only after the
        // idempotency service has checked for a replay.  Keeping outbound DNS
        // resolution and model discovery in the guard means a replay returns
        // the original response even if the URL or model is no longer usable.
        $normalized = null;
        $analysisModel = null;

        $operation = function () use ($request, $data, &$normalized, &$analysisModel, $admin): JsonResponse {
            if (! is_array($normalized) || ! isset($normalized['url'], $normalized['host']) || ! ($analysisModel instanceof AiModel)) {
                // This should only be reachable if the idempotency contract is
                // changed incorrectly; avoid creating a partially populated
                // job if a future caller bypasses the guard.
                throw new ApiException('url_import_preflight_failed', 'URL 导入预检未完成，请稍后重试', 422);
            }

            return $this->success($request, DB::transaction(function () use ($data, $normalized, $analysisModel, $admin): array {
                $identity = $this->executionGuard->snapshotForCreation($admin, $analysisModel);
                $job = UrlImportJob::query()->create(array_merge([
                    'url' => (string) $data['url'],
                    'normalized_url' => (string) $normalized['url'],
                    'source_domain' => (string) $normalized['host'],
                    'page_title' => (string) ($data['project_name'] ?? ''),
                    'status' => 'queued',
                    'current_step' => 'queued',
                    'progress_percent' => 0,
                    'options_json' => json_encode([
                        'project_name' => (string) ($data['project_name'] ?? ''),
                        'source_label' => (string) ($data['source_label'] ?? ''),
                        'content_language' => (string) ($data['content_language'] ?? ''),
                        'notes' => (string) ($data['notes'] ?? ''),
                        'outputs' => array_values((array) ($data['outputs'] ?? [])),
                    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                    'result_json' => '',
                    'error_message' => '',
                    'created_by' => (string) $admin->username,
                ], $identity));

                UrlImportJobLog::query()->create([
                    'job_id' => $job->getKey(),
                    'step' => 'queued',
                    'level' => 'info',
                    'message' => 'URL 导入任务已创建，等待 Worker 处理。',
                ]);

                return [
                    'job' => $this->summary($job),
                ];
            }), 201);
        };

        return IdempotencyService::executeJson(
            $request,
            'POST /url-imports',
            $operation,
            operationGuard: function (Closure $callback) use (&$normalized, &$analysisModel, $validated, $admin): JsonResponse {
                try {
                    $normalized = $this->processing->normalizeInputUrl((string) $validated['url']);
                } catch (\InvalidArgumentException $exception) {
                    throw new ApiException('invalid_url', $exception->getMessage() ?: 'URL 无效', 422);
                } catch (Throwable $exception) {
                    report($exception);
                    throw new ApiException('invalid_url', 'URL 预检失败，请检查地址后重试', 422);
                }

                try {
                    $analysisModel = $this->processing->assertAnalysisModelReady($admin);
                } catch (Throwable $exception) {
                    report($exception);
                    throw new ApiException('ai_model_required', '当前没有可用的分析模型，请先配置聊天模型', 422);
                }

                return $callback();
            },
        );
    }

    public function show(Request $request, int $urlImport): JsonResponse
    {
        $job = $this->findVisibleJob($request, $urlImport);

        return $this->success($request, $this->detail($job));
    }

    /** Start or retry a queued URL import. */
    public function run(Request $request, int $urlImport): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $job = $this->findOwnedJob($request, $urlImport);

        return IdempotencyService::executeJson(
            $request,
            'POST /url-imports/{id}/run',
            function () use ($request, $job): JsonResponse {
                $current = $job->refresh();
                if (in_array((string) $current->status, ['completed', 'imported'], true)) {
                    return $this->success($request, $this->detail($current));
                }
                if ((string) $current->status === 'failed' && ! (bool) $current->retryable_failure) {
                    throw new ApiException('url_import_not_retryable', '该导入失败不可重试', 422);
                }

                $status = (string) $current->status;
                if (! in_array($status, ['queued', 'failed', 'running'], true)) {
                    throw new ApiException('url_import_invalid_state', '该导入任务当前状态不支持执行', 409);
                }

                if ($status === 'running') {
                    $lease = trim((string) ($current->execution_lease_token ?? ''));
                    $leaseExpired = $current->lease_expires_at === null
                        || $current->lease_expires_at->isPast();
                    if ($lease !== '' && ! $leaseExpired) {
                        throw new ApiException('url_import_in_progress', '该导入任务正在处理中', 409);
                    }

                    // A stale running row can be left behind by a worker or
                    // process crash. Normalize it back to queued so the next
                    // worker can claim a fresh lease; otherwise a non-empty
                    // token with a missing expiry would be accepted by this
                    // endpoint but ignored by claimExecution().
                    $current->forceFill([
                        'status' => 'queued',
                        'current_step' => 'queued',
                        'progress_percent' => 0,
                        'error_message' => '',
                        'error_code' => null,
                        'execution_lease_token' => null,
                        'lease_expires_at' => null,
                        'finished_at' => null,
                    ])->save();
                    $status = 'queued';
                }

                if ($status === 'failed') {
                    $current->forceFill([
                        'status' => 'queued',
                        'current_step' => 'queued',
                        'progress_percent' => 0,
                        'error_message' => '',
                        'error_code' => null,
                        'execution_lease_token' => null,
                        'lease_expires_at' => null,
                        'finished_at' => null,
                    ])->save();
                }

                if (app()->runningUnitTests()) {
                    $current = $this->processing->process($current->refresh());
                } else {
                    // The job claims the execution lease itself.  Dispatching
                    // after the response keeps HTTP latency independent of AI
                    // provider time and lets Horizon expose progress/errors.
                    ProcessUrlImportJob::dispatch((int) $current->getKey())->afterCommit();
                    $current->refresh();
                }

                return $this->success($request, $this->detail($current), 202);
            },
        );
    }

    /** Commit a completed preview into knowledge/keyword/title libraries. */
    public function commit(Request $request, int $urlImport): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $job = $this->findOwnedJob($request, $urlImport);

        return IdempotencyService::executeJson(
            $request,
            'POST /url-imports/{id}/commit',
            function () use ($request, $job): JsonResponse {
                try {
                    $summary = $this->processing->commit($job->refresh());
                } catch (ApiException $exception) {
                    throw $exception;
                } catch (AiModelAccessException $exception) {
                    report($exception);
                    throw new ApiException($exception->getErrorCode(), 'URL 导入使用的 AI 配置已不可用，请重新创建任务', 409);
                } catch (QueryException $exception) {
                    // 2026-09-12 退役补齐：旧 Blade 的 `Admin\UrlImportController::reportCommitFailure()`
                    // 对 QueryException 只上报脱敏串。这条 API 直接 `report($exception)`，而
                    // `QueryException::getMessage()` **带着 SQL 与绑定值**——导入内容（可能是客户资料）
                    // 会原样进日志。把那条脱敏处理搬过来。
                    $this->reportCommitFailure($exception, (int) $job->getKey());
                    throw new ApiException('url_import_commit_failed', '导入结果写入数据库失败', 422);
                } catch (Throwable $exception) {
                    report($exception);
                    throw new ApiException('url_import_commit_failed', '导入结果提交失败，请稍后重试', 422);
                }

                return $this->success($request, [
                    'summary' => $summary,
                    'job' => $this->detail($job->refresh()),
                ]);
            },
        );
    }

    /**
     * `QueryException` 的 message 含 SQL 与绑定值，不能原样进日志。
     * 只上报作业号 + SQLSTATE（与已退役的 Blade 控制器同一处理）。
     */
    private function reportCommitFailure(Throwable $exception, int $jobId): void
    {
        if ($exception instanceof QueryException) {
            $sqlState = preg_match('/^[A-Z0-9]{5}$/', (string) $exception->getCode()) === 1
                ? (string) $exception->getCode()
                : 'unknown';
            report(new RuntimeException(
                "URL import database commit failed for job {$jobId} (SQLSTATE {$sqlState})."
            ));

            return;
        }

        report($exception);
    }

    /** @return array<string,mixed> */
    private function detail(UrlImportJob $job): array
    {
        $logs = UrlImportJobLog::query()
            ->where('job_id', $job->getKey())
            ->oldest()
            ->limit(120)
            ->get()
            ->map(static fn (UrlImportJobLog $log): array => [
                'step' => (string) ($log->step ?: ''),
                'level' => (string) $log->level,
                'message' => (string) $log->message,
                'created_at' => optional($log->created_at)->toIso8601String(),
            ])
            ->values()
            ->all();

        return [
            'job' => $this->summary($job),
            'options' => $this->decode((string) $job->options_json),
            'result' => $this->processing->decodeResult($job),
            'logs' => $logs,
        ];
    }

    /** @return array<string,mixed> */
    private function summary(UrlImportJob $job): array
    {
        return [
            'id' => (int) $job->getKey(),
            'url' => (string) $job->url,
            'normalized_url' => (string) $job->normalized_url,
            'source_domain' => (string) $job->source_domain,
            'page_title' => (string) $job->page_title,
            'status' => (string) $job->status,
            'current_step' => (string) $job->current_step,
            'progress_percent' => (int) $job->progress_percent,
            'error_message' => (string) ($job->error_message ?? ''),
            'error_code' => (string) ($job->error_code ?? ''),
            'retryable_failure' => (bool) $job->retryable_failure,
            'result_ready' => trim((string) $job->result_json) !== '',
            'created_at' => optional($job->created_at)->toIso8601String(),
            'started_at' => optional($job->started_at)->toIso8601String(),
            'finished_at' => optional($job->finished_at)->toIso8601String(),
        ];
    }

    private function findVisibleJob(Request $request, int $id): UrlImportJob
    {
        $admin = $this->executionAdmin($request);
        $query = UrlImportJob::query()->whereKey($id);
        if (! $admin->isSuperAdmin()) {
            $query->where('model_access_admin_id', $admin->getKey());
        }

        $job = $query->first();
        if (! $job instanceof UrlImportJob) {
            throw new ApiException('not_found', 'URL 导入任务不存在', 404);
        }

        return $job;
    }

    private function findOwnedJob(Request $request, int $id): UrlImportJob
    {
        $admin = $this->executionAdmin($request);
        $job = UrlImportJob::query()
            ->whereKey($id)
            ->where('model_access_admin_id', $admin->getKey())
            ->first();
        if (! $job instanceof UrlImportJob) {
            throw new ApiException('not_found', 'URL 导入任务不存在或无权操作', 404);
        }

        return $job;
    }

    private function requireIdempotencyKey(Request $request): void
    {
        $key = $request->header('X-Idempotency-Key');
        if (! is_string($key) || trim($key) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
        if (strlen($key) > 120 || preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]*$/D', $key) !== 1) {
            throw new ApiException('invalid_idempotency_key', 'X-Idempotency-Key 格式无效', 422);
        }
    }

    /** @return array<string,mixed> */
    private function decode(string $value): array
    {
        $decoded = json_decode($value, true);

        return is_array($decoded) ? $decoded : [];
    }
}
