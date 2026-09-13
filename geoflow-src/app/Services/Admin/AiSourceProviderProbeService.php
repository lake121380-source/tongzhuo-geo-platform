<?php

namespace App\Services\Admin;

use App\Exceptions\AiModelAccessException;
use App\Exceptions\AiSourceProviderProbeException;
use App\Http\Controllers\Admin\AiSourceProviderController;
use App\Models\Admin;
use App\Services\AiWorkspace\AiWorkspaceModelCapabilityProbe;
use App\Services\GeoFlow\AiUsageQuotaService;
use App\Services\GeoFlow\AiUsageReservation;
use App\Services\GeoFlow\AiVisibility\DoubaoSearchCustomClient;
use App\Services\Outbound\SafeOutboundHttpClient;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Throwable;

/**
 * AI 来源 Provider 与可见度分析模型的**真实出站探活**。
 *
 * 旧 Blade 后台（{@see AiSourceProviderController::testProvider} /
 * ::testModelBinding）与 api/v1 共用这一份实现。这段编排不能有第二份，因为它管的不是
 * 「发个请求试试」，而是**一次出站前后必须成对完成的账**：
 *
 * - 额度：出站前预留，成功记 `recordProviderSuccess/recordModelSuccess`，失败按
 *   **是否真的发出过请求**决定记 attempt 还是 release——记错了就是白扣或漏扣运营方的额度；
 * - 身份：出站前后各重校验一次（超管身份/模型归属可能在请求飞行途中被回收），
 *   并在中途被回收时撤销待定用量；
 * - 就绪度：模型探活的结果/失败码要落 `workspace_readiness`，`-AI` 的可见度页面靠它判断能不能跑。
 *
 * 失败一律以异常抛出，由调用方翻译成自己的响应形状（旧后台是 422 + `success:false`，
 * api/v1 是 `ApiException` 信封）。**不要在这里返回 JsonResponse**，否则两个入口又得各写一遍。
 */
final class AiSourceProviderProbeService
{
    public function __construct(
        private readonly DoubaoSearchCustomClient $doubaoSearchCustomClient,
        private readonly AiUsageQuotaService $usageQuota,
        private readonly AdminAiModelTestBoundaryHook $modelTestBoundaryHook,
        private readonly AdminAiModelTestPreparationService $modelTestPreparation,
        private readonly AdminAiSourceProviderService $sourceProviderService,
        private readonly AdminAiSystemConfigurationBoundaryHook $boundaryHook,
        private readonly GovernanceAiModelUsageSessionFactory $usageSessions,
        private readonly AiWorkspaceModelCapabilityProbe $aiWorkspaceModelProbe,
        private readonly SafeOutboundHttpClient $safeHttp,
    ) {}

    /**
     * 探活一个来源 Provider（真实调用搜索接口）。
     *
     * @return array{source_count:int,latency_ms:int}
     */
    public function probeProvider(Admin $actor, int $providerId, string $query): array
    {
        $query = self::normalizeQuery($query);
        $reservation = null;
        $outboundAttempted = false;

        try {
            $snapshot = $this->sourceProviderService->prepareProviderTest($actor, $providerId);
            $reservation = $snapshot->reservation;
            if ($reservation === null) {
                throw AiSourceProviderProbeException::unavailable();
            }
            $this->boundaryHook->beforeProviderOutbound($snapshot);
            $this->sourceProviderService->revalidateProviderBeforeOutbound($snapshot);
            $outboundAttempted = true;
            $result = $this->doubaoSearchCustomClient->search(
                $snapshot->providerForProbe(),
                $query,
                $snapshot->probeOptions(),
            );
            $this->boundaryHook->afterProviderOutbound($snapshot);
            $this->sourceProviderService->revalidateProviderAfterOutbound($snapshot);
            $this->usageQuota->recordProviderSuccess($reservation);
            $reservation = null;

            return [
                'source_count' => count($result->sources),
                'latency_ms' => (int) $result->latencyMs,
            ];
        } catch (ModelNotFoundException $exception) {
            // 保留 404 语义：Provider 不存在不该被折成「探活失败」。
            throw $exception;
        } catch (Throwable $exception) {
            if ($reservation instanceof AiUsageReservation && $outboundAttempted) {
                $this->usageQuota->recordProviderAttempt($reservation);
            } elseif ($reservation instanceof AiUsageReservation) {
                $this->usageQuota->releaseProvider($reservation);
            }

            throw $exception;
        }
    }

    /**
     * 探活一个可见度分析模型的绑定（Ark / DeepSeek）。
     *
     * @return array{workspace_readiness:mixed,workspace_readiness_expires_at:string}
     */
    public function probeModelBinding(Admin $actor, int $modelId, string $bindingType): array
    {
        $reservation = null;
        $outboundAttempted = false;
        $workspaceFailurePersisted = false;
        $usageSession = null;
        $snapshot = null;

        try {
            $snapshot = $this->modelTestPreparation->prepareSystemBinding($actor, $modelId, $bindingType);
            $reservation = $snapshot->reservation;
            $usageSession = $this->usageSessions->create($snapshot);
            if ($reservation === null) {
                throw AiSourceProviderProbeException::unavailable();
            }
            $model = $snapshot->modelForWorkspaceProbe();
            $this->modelTestBoundaryHook->beforeRevalidation($snapshot);
            $this->modelTestPreparation->revalidateImmediatelyBeforeOutbound($snapshot);
            $this->safeHttp->resolveTarget($snapshot->endpoint);
            $probeAttempt = $this->aiWorkspaceModelProbe->start($model, $usageSession);
            $outboundAttempted = $usageSession->hasStartedProviderAttempt();
            $this->modelTestBoundaryHook->afterOutboundBeforePersist($snapshot);
            $this->modelTestPreparation->revalidateWorkspaceAfterOutbound($snapshot);
            $usageSession->finalizePendingOutcomes();
            if ($probeAttempt->requiresPlainTextFallback()) {
                $this->modelTestBoundaryHook->beforeRevalidation($snapshot);
                $this->modelTestPreparation->revalidateImmediatelyBeforeOutbound($snapshot);
                $this->safeHttp->resolveTarget($snapshot->endpoint);
            }
            try {
                $probeResult = $this->aiWorkspaceModelProbe->finish($model, $probeAttempt, $usageSession);
            } catch (Throwable $exception) {
                if ($probeAttempt->requiresPlainTextFallback()) {
                    $this->modelTestBoundaryHook->afterOutboundBeforePersist($snapshot);
                    $this->modelTestPreparation->revalidateWorkspaceAfterOutbound($snapshot);
                }
                $this->modelTestPreparation->persistWorkspaceFailure(
                    $snapshot,
                    $this->aiWorkspaceModelProbe->failureCode($exception),
                );
                $workspaceFailurePersisted = true;
                $usageSession->finalizePendingOutcomes();

                throw $exception;
            }
            if ($probeAttempt->requiresPlainTextFallback()) {
                $this->modelTestBoundaryHook->afterOutboundBeforePersist($snapshot);
            }
            $this->modelTestPreparation->persistWorkspaceReadiness($snapshot, $probeResult);
            $usageSession->succeededPending();
            $this->usageQuota->recordModelSuccess($reservation);
            $reservation = null;

            return [
                'workspace_readiness' => $probeResult->profile,
                'workspace_readiness_expires_at' => $probeResult->expiresAt->toISOString(),
            ];
        } catch (ModelNotFoundException $exception) {
            throw $exception;
        } catch (Throwable $exception) {
            $outboundAttempted = $outboundAttempted
                || ($usageSession instanceof GovernanceAiModelUsageSession
                    && $usageSession->hasStartedProviderAttempt());
            if ($usageSession instanceof GovernanceAiModelUsageSession) {
                if ($exception instanceof AiModelAccessException) {
                    $usageSession->revokedPending();
                } else {
                    $usageSession->discardedPending();
                }
            }
            if ($outboundAttempted
                && ! $workspaceFailurePersisted
                && ! $exception instanceof AiModelAccessException
                && $snapshot !== null
            ) {
                try {
                    $this->modelTestPreparation->persistWorkspaceFailure(
                        $snapshot,
                        $this->aiWorkspaceModelProbe->failureCode($exception),
                    );
                } catch (AiModelAccessException $accessException) {
                    $exception = $accessException;
                } catch (Throwable $persistenceException) {
                    report($persistenceException);
                }
            }
            if ($reservation instanceof AiUsageReservation && $outboundAttempted) {
                $this->usageQuota->recordModelAttempt($reservation);
            } elseif ($reservation instanceof AiUsageReservation) {
                $this->usageQuota->releaseModel($reservation);
            }

            throw $exception;
        }
    }

    /**
     * 探活用的查询词：留空时给一个默认词，并截到 200 字。
     *
     * 两个入口共用，避免「页面探活用默认词、API 探活用空串」这种差异。
     */
    public static function normalizeQuery(string $query): string
    {
        $query = trim($query);

        return $query !== '' ? mb_substr($query, 0, 200, 'UTF-8') : '桐灼GEO';
    }

    /**
     * 把探活异常收敛成对外错误码。
     *
     * 只暴露这几种：身份/权限类原样透出，其余一律 `ai_model_unavailable`——
     * 这里最容易犯的错是把底层异常消息（可能带 URL、密钥片段）当错误码发出去。
     */
    public static function errorCode(Throwable $exception): string
    {
        if ($exception instanceof AiSourceProviderProbeException) {
            return $exception->errorCode;
        }
        if ($exception instanceof AiModelAccessException) {
            return $exception->getErrorCode();
        }
        if ($exception instanceof AuthorizationException) {
            return 'ai_system_config_super_admin_only';
        }

        return AiSourceProviderProbeException::UNAVAILABLE;
    }
}
