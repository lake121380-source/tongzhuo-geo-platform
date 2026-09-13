<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Models\TitleGenerationRun;
use App\Models\TitleLibrary;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\TitleGenerationRunService;
use App\Support\TitleGenerationRequestRules;
use App\Support\TitleGenerationStatus;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * Bearer 版的标题库 AI 生成链路。
 *
 * 与旧 Blade 后台是同一份实现：提交时的两道确认门禁取自
 * {@see TitleGenerationRequestRules}，作用域与失败文案取自
 * {@see TitleGenerationRunService}，状态投影取自 {@see TitleGenerationStatus}
 * ——后台的状态轮询端点返回的就是同一个数组，前端不必为两个入口写两套解析。
 *
 * **不要复用旧后台的 `GenerateTitlesWithAiRequest`**：它的 `authorize()` 读的是
 * `user('admin')`，在 Bearer 上下文里恒为 null，复用会一律 403 并把「未授权」
 * 报成参数错误。
 */
final class TitleGenerationApiController extends BaseApiController
{
    public function __construct(
        private readonly TitleGenerationRunService $runs,
    ) {}

    /** 提交一次生成。 */
    public function store(Request $request, int $library): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        $target = $this->library($library);
        $payload = $this->validated($request);

        return IdempotencyService::executeJson($request, 'POST /materials/title-libraries/{library}/ai-generation-runs', function () use ($request, $target, $payload, $admin): JsonResponse {
            $run = $this->submit($target, TitleGenerationRunService::payloadFromValidated($payload), $admin);

            return $this->success($request, ['run' => $this->serializeRun($run)], 202);
        });
    }

    /**
     * 该标题库对当前管理员的生成记录。
     *
     * `current` 与旧后台详情页同构（优先进行中的，否则最近一次），页面打开时
     * 靠它决定渲染进度条还是「尚无生成记录」。只返回属于当前管理员的记录。
     */
    public function index(Request $request, int $library): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $this->library($library);
        $adminId = (int) $admin->getKey();

        $current = $this->runs->currentForActor($library, $adminId);

        return $this->success($request, [
            'current' => $current instanceof TitleGenerationRun ? $this->serializeRun($current) : null,
            'runs' => $this->runs->historyForActor($library, $adminId)
                ->map(fn (TitleGenerationRun $run): array => $this->serializeRun($run))
                ->all(),
        ]);
    }

    /** 轮询一次生成进度。 */
    public function show(Request $request, int $library, int $run): JsonResponse
    {
        return $this->success($request, ['run' => $this->serializeRun($this->findRun($request, $library, $run))]);
    }

    public function retry(Request $request, int $library, int $run): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        $target = $this->findRun($request, $library, $run);

        return IdempotencyService::executeJson($request, 'POST /materials/title-libraries/{library}/ai-generation-runs/{run}/retry', function () use ($request, $target, $admin): JsonResponse {
            return $this->success($request, ['run' => $this->serializeRun($this->retried($target, $admin))], 202);
        });
    }

    public function cancel(Request $request, int $library, int $run): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        $target = $this->findRun($request, $library, $run);

        return IdempotencyService::executeJson($request, 'POST /materials/title-libraries/{library}/ai-generation-runs/{run}/cancel', function () use ($request, $target, $admin): JsonResponse {
            return $this->success($request, ['run' => $this->serializeRun($this->cancelled($target, $admin))], 202);
        });
    }

    private function submit(TitleLibrary $library, array $payload, Admin $admin): TitleGenerationRun
    {
        try {
            return $this->runs->submit($library, $payload, $admin, app()->getLocale());
        } catch (Throwable $exception) {
            throw $this->failure($exception);
        }
    }

    private function retried(TitleGenerationRun $run, Admin $admin): TitleGenerationRun
    {
        try {
            return $this->runs->retry($run, $admin);
        } catch (Throwable $exception) {
            throw $this->failure($exception);
        }
    }

    private function cancelled(TitleGenerationRun $run, Admin $admin): TitleGenerationRun
    {
        try {
            return $this->runs->cancel($run, $admin);
        } catch (Throwable $exception) {
            throw $this->failure($exception);
        }
    }

    /**
     * 已知原因码原样透出（前端按码分支），未知原因只报一句产品语言——
     * 不把「哪个类炸了」写进响应。
     */
    private function failure(Throwable $exception): ApiException
    {
        $reason = TitleGenerationRunService::reason($exception);
        if (! TitleGenerationRunService::isKnownReason($reason)) {
            report($exception);

            return new ApiException(
                TitleGenerationRunService::REASON_FAILED,
                TitleGenerationRunService::message(TitleGenerationRunService::REASON_FAILED),
                500,
            );
        }

        return new ApiException(
            $reason,
            TitleGenerationRunService::message($reason),
            TitleGenerationRunService::httpStatus($reason),
        );
    }

    /** @return array<string, mixed> */
    private function validated(Request $request): array
    {
        $validator = TitleGenerationRequestRules::validator($request->all());
        if ($validator->fails()) {
            throw new ValidationException($validator);
        }

        return $validator->validated();
    }

    private function library(int $libraryId): TitleLibrary
    {
        $library = TitleLibrary::query()->find($libraryId);
        if (! $library instanceof TitleLibrary) {
            throw new ApiException('title_library_not_found', '标题库不存在', 404);
        }

        return $library;
    }

    /**
     * 取一个属于当前管理员的任务。
     *
     * 不属于自己的任务返回 404 而不是 403：403 会泄露「这个 id 确实存在」。
     */
    private function findRun(Request $request, int $libraryId, int $runId): TitleGenerationRun
    {
        $admin = $this->executionAdmin($request);
        $this->library($libraryId);

        $found = $this->runs->findForActor($libraryId, $runId, (int) $admin->getKey());
        if (! $found instanceof TitleGenerationRun) {
            throw new ApiException('title_generation_run_not_found', '生成任务不存在', 404);
        }

        return $found;
    }

    /** @return array<string, mixed> */
    private function serializeRun(TitleGenerationRun $run): array
    {
        return TitleGenerationStatus::payload($run) + [
            'title_library_id' => (int) $run->title_library_id,
            'keyword_library_id' => (int) $run->keyword_library_id,
            'ai_model_id' => (int) $run->ai_model_id,
            'title_style' => (string) $run->title_style,
            'created_at' => $run->created_at?->toIso8601String(),
            'updated_at' => $run->updated_at?->toIso8601String(),
        ];
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }
}
