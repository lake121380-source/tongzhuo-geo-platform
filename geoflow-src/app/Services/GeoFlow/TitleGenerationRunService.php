<?php

namespace App\Services\GeoFlow;

use App\Exceptions\AiModelAccessException;
use App\Exceptions\TitleGenerationException;
use App\Http\Controllers\Admin\TitleLibraryController;
use App\Http\Controllers\Api\V1\TitleGenerationApiController;
use App\Models\Admin;
use App\Models\AiModel;
use App\Models\TitleGenerationRun;
use App\Models\TitleLibrary;
use App\Services\Admin\AdminAiModelAccessResolver;
use App\Support\TitleGenerationStatus;
use Closure;
use Illuminate\Support\Collection;
use Throwable;

/**
 * 标题库 AI 生成链路（提交 / 状态 / 重试 / 取消）。
 *
 * 旧 Blade 后台（{@see TitleLibraryController}）与 api/v1
 * （{@see TitleGenerationApiController}）共用这一份实现，
 * 真正的排队与执行仍在 {@see TitleGenerationCoordinator}。
 *
 * 这里承载两件**不能有两个版本**的东西：
 *
 * ① **作用域**。一个生成任务只对两件事负责：它以谁的身份访问了模型
 *    （`model_access_admin_id`），以及它是谁建的（`created_by_admin_id`，仅用于
 *    历史数据——那时还没有身份快照）。状态、重试、取消的可见范围就是这条规则；
 *    两个入口各写一遍，迟早会出现「后台看不到、API 看得到」这种越权读。
 * ② **失败原因 → 对外文案**。原因码由 {@see TitleGenerationCoordinator} 抛出，
 *    但「未配置关键词」「已有进行中的任务」这些是产品语言，必须只有一份。
 */
final class TitleGenerationRunService
{
    /** 关键词库一条词都没有（提交时与提交后各查一次）。 */
    public const REASON_NO_KEYWORDS = 'title_generation_no_keywords';

    /** 该标题库已有进行中的生成任务。 */
    public const REASON_ACTIVE = 'title_generation_active';

    /** 该任务当前状态不允许重试。 */
    public const REASON_NOT_RETRYABLE = 'title_generation_not_retryable';

    /** 该任务不是进行中，无从取消。 */
    public const REASON_NOT_CANCELLABLE = 'title_generation_not_cancellable';

    /** 队列不可用时不允许退化成同步生成。 */
    public const REASON_ASYNC_QUEUE_REQUIRED = 'title_generation_async_queue_required';

    /** 模型被删、被停用或不再是 chat 类型。 */
    public const REASON_MODEL_UNAVAILABLE = 'title_generation_ai_model_unavailable';

    /** 目标数量超过词数，未确认允许复用关键词。 */
    public const REASON_KEYWORD_REUSE_REQUIRED = 'title_generation_keyword_reuse_confirmation_required';

    /** 提交量超过该模型/该管理员允许的并发额度。 */
    public const REASON_CAPACITY_EXCEEDED = 'title_generation_capacity_exceeded';

    /** 提交人已停用。 */
    public const REASON_EXECUTION_ADMIN_INACTIVE = AiModelAccessException::AI_EXECUTION_ADMIN_INACTIVE;

    /** 提交人对模型的访问授权已被回收。 */
    public const REASON_CONFIG_ACCESS_REVOKED = AiModelAccessException::AI_CONFIG_ACCESS_REVOKED;

    /** 模型不属于提交人可访问的范围。 */
    public const REASON_MODEL_NOT_ACCESSIBLE = AiModelAccessException::AI_MODEL_NOT_ACCESSIBLE;

    /** 兜底：入队失败等未知原因。 */
    public const REASON_FAILED = 'title_generation_failed';

    public function __construct(
        private readonly TitleGenerationCoordinator $coordinator,
        private readonly AdminAiModelAccessResolver $modelAccessResolver,
    ) {}

    /**
     * 提交一次 AI 生成。
     *
     * 模型访问边界必须先于排队检查：一个够不着模型的提交人应当收到 403，
     * 而不是「该库已有进行中的任务」这种会误导他去等待的 409。
     *
     * @param  array{keyword_library_id:int,ai_model_id:int,title_count:int,title_style:string,custom_prompt?:string|null,confirmed_keyword_reuse?:bool}  $payload
     */
    public function submit(TitleLibrary $library, array $payload, Admin $actor, string $locale): TitleGenerationRun
    {
        $model = AiModel::query()->find((int) $payload['ai_model_id']);
        if (! $model instanceof AiModel) {
            throw new TitleGenerationException(self::REASON_MODEL_UNAVAILABLE);
        }
        $this->modelAccessResolver->assertUsable($actor, $model);

        return $this->coordinator->start($library, $payload, (int) $actor->getKey(), $locale);
    }

    public function retry(TitleGenerationRun $run, Admin $actor): TitleGenerationRun
    {
        return $this->coordinator->retry($run, $actor);
    }

    public function cancel(TitleGenerationRun $run, Admin $actor): TitleGenerationRun
    {
        return $this->coordinator->cancel($run, $actor);
    }

    /**
     * 任务对某个管理员可见的判据（状态、重试、取消共用）。
     *
     * `model_access_admin_id` 为空的是身份快照上线前的历史数据，此时退回创建人。
     */
    public function actorScope(int $adminId): Closure
    {
        return static function ($query) use ($adminId): void {
            $query->where('model_access_admin_id', $adminId)
                ->orWhere(static function ($legacy) use ($adminId): void {
                    $legacy->whereNull('model_access_admin_id')
                        ->where('created_by_admin_id', $adminId);
                });
        };
    }

    /**
     * 取该标题库下属于该管理员的最近一次生成任务：优先进行中的，其次任意最近一次。
     *
     * 与旧后台详情页的取法一致——页面打开时先看到「还在跑的那一次」，
     * 没有在跑的就显示最后一次结果。
     */
    public function currentForActor(int $libraryId, int $adminId): ?TitleGenerationRun
    {
        $scope = $this->actorScope($adminId);

        $active = TitleGenerationRun::query()
            ->where('title_library_id', $libraryId)
            ->where($scope)
            ->whereIn('status', [TitleGenerationRun::STATUS_QUEUED, TitleGenerationRun::STATUS_RUNNING])
            ->latest('id')
            ->first();

        return $active ?? TitleGenerationRun::query()
            ->where('title_library_id', $libraryId)
            ->where($scope)
            ->latest('id')
            ->first();
    }

    /**
     * 取一个确定的任务；不属于该管理员时返回 null（调用方转 404，不泄露任务是否存在）。
     */
    public function findForActor(int $libraryId, int $runId, int $adminId): ?TitleGenerationRun
    {
        return TitleGenerationRun::query()
            ->where('title_library_id', $libraryId)
            ->where($this->actorScope($adminId))
            ->whereKey($runId)
            ->first();
    }

    /**
     * 枚举该标题库下属于该管理员的生成任务，最近的在前。
     *
     * @return Collection<int, TitleGenerationRun>
     */
    public function historyForActor(int $libraryId, int $adminId, int $limit = 20): Collection
    {
        return TitleGenerationRun::query()
            ->where('title_library_id', $libraryId)
            ->where($this->actorScope($adminId))
            ->latest('id')
            ->limit(max(1, min($limit, 100)))
            ->get();
    }

    public function status(TitleGenerationRun $run): array
    {
        return TitleGenerationStatus::payload($run);
    }

    /**
     * 把链路上抛出的异常收敛成一组固定的原因码。
     *
     * 未知异常一律折成 {@see self::REASON_FAILED}：对外只暴露产品语言，
     * 不把「哪个类炸了」这种实现细节写进响应。
     */
    public static function reason(Throwable $exception): string
    {
        if ($exception instanceof TitleGenerationException) {
            return $exception->reason;
        }

        if ($exception instanceof AiModelAccessException) {
            return $exception->getErrorCode();
        }

        return self::REASON_FAILED;
    }

    /** 原因码 → 运营方能看懂的一句话。 */
    public static function message(string $reason): string
    {
        return match ($reason) {
            self::REASON_NO_KEYWORDS => '所选关键词库里没有关键词，无法生成标题',
            self::REASON_ACTIVE => '该标题库已有正在进行的生成任务',
            self::REASON_NOT_RETRYABLE => '该生成任务当前状态不支持重试',
            self::REASON_NOT_CANCELLABLE => '该生成任务已经结束，无法取消',
            self::REASON_ASYNC_QUEUE_REQUIRED => '当前队列不可用，AI 生成需要队列支持',
            self::REASON_MODEL_UNAVAILABLE => '所选 AI 模型不可用',
            self::REASON_KEYWORD_REUSE_REQUIRED => '目标数量超过关键词数量，需要确认允许复用关键词',
            self::REASON_CAPACITY_EXCEEDED => '超出该模型当前允许的提交量，请稍后再试',
            self::REASON_EXECUTION_ADMIN_INACTIVE => '提交账号当前不可用',
            self::REASON_CONFIG_ACCESS_REVOKED => '你对所选模型的访问授权已被回收',
            self::REASON_MODEL_NOT_ACCESSIBLE => '所选 AI 模型不在你的可用范围内',
            default => 'AI 标题生成暂时不可用',
        };
    }

    /** 原因码 → HTTP 状态。 */
    public static function httpStatus(string $reason): int
    {
        return match ($reason) {
            self::REASON_EXECUTION_ADMIN_INACTIVE,
            self::REASON_CONFIG_ACCESS_REVOKED,
            self::REASON_MODEL_NOT_ACCESSIBLE => 403,
            self::REASON_ACTIVE,
            self::REASON_NOT_RETRYABLE,
            self::REASON_NOT_CANCELLABLE,
            self::REASON_CAPACITY_EXCEEDED => 409,
            self::REASON_NO_KEYWORDS,
            self::REASON_ASYNC_QUEUE_REQUIRED,
            self::REASON_MODEL_UNAVAILABLE,
            self::REASON_KEYWORD_REUSE_REQUIRED => 422,
            default => 500,
        };
    }

    /**
     * 该原因码是否已知。
     *
     * 用于防止新增原因码时被静默降级成 500「未知错误」——见
     * `TitleGenerationApiTest::test_every_known_reason_has_a_message_and_status`。
     */
    public static function isKnownReason(string $reason): bool
    {
        return in_array($reason, [
            self::REASON_NO_KEYWORDS,
            self::REASON_ACTIVE,
            self::REASON_NOT_RETRYABLE,
            self::REASON_NOT_CANCELLABLE,
            self::REASON_ASYNC_QUEUE_REQUIRED,
            self::REASON_MODEL_UNAVAILABLE,
            self::REASON_KEYWORD_REUSE_REQUIRED,
            self::REASON_CAPACITY_EXCEEDED,
            self::REASON_EXECUTION_ADMIN_INACTIVE,
            self::REASON_CONFIG_ACCESS_REVOKED,
            self::REASON_MODEL_NOT_ACCESSIBLE,
        ], true);
    }

    /** 提交入参的规范化（与旧后台一致）。 */
    public static function payloadFromValidated(array $validated): array
    {
        return [
            'keyword_library_id' => (int) $validated['keyword_library_id'],
            'ai_model_id' => (int) $validated['ai_model_id'],
            'title_count' => (int) $validated['title_count'],
            'title_style' => (string) $validated['title_style'],
            'custom_prompt' => trim((string) ($validated['custom_prompt'] ?? '')),
            'confirmed_keyword_reuse' => (bool) ((int) ($validated['confirmed_keyword_reuse'] ?? 0)),
        ];
    }
}
