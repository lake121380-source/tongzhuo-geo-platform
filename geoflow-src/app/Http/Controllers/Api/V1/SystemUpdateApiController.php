<?php

namespace App\Http\Controllers\Api\V1;

use App\Contracts\SystemUpdater\AgentClient;
use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Models\SystemUpdateBackup;
use App\Models\SystemUpdateRun;
use App\Services\Admin\AdminUpdateMetadataService;
use App\Services\Admin\SystemUpdateOperationGuard;
use App\Services\Admin\SystemUpdaterBootstrapService;
use App\Services\Admin\SystemUpdaterBridgeService;
use App\Services\Admin\SystemUpdaterMutationPolicy;
use App\Services\Admin\SystemUpdateStateService;
use App\Services\Api\IdempotencyService;
use App\Support\AdminActivityLogger;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Throwable;

/**
 * Bearer API for 桐灼GEO's independent, host-level updater.
 *
 * This controller deliberately does not revive the retired Laravel update
 * jobs. Every host mutation is accepted and serialized by AgentClient.
 */
class SystemUpdateApiController extends BaseApiController
{
    public function show(
        Request $request,
        SystemUpdateStateService $stateService,
        SystemUpdaterBridgeService $bridgeService,
    ): JsonResponse {
        $this->superAdmin($request);
        $this->ensureEnabled();
        $historyScope = $request->query('history') === 'archived' ? 'archived' : 'recent';
        $summary = $stateService->summary($historyScope);
        $bridge = $bridgeService->summary();

        return $this->success($request, $this->projection($summary, $bridge));
    }

    public function check(Request $request, AdminUpdateMetadataService $metadata): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->superAdmin($request);
        $this->ensureEnabled();

        return IdempotencyService::executeJson($request, 'POST /system-updates/check', function () use ($request, $metadata, $admin): JsonResponse {
            $metadata->forgetCachedMetadata();
            $state = $metadata->fetchState();
            $this->audit($request, $admin, 'api.system_update.check', ['status' => (string) ($state['status'] ?? '')]);

            return $this->success($request, ['state' => $state]);
        });
    }

    public function prepare(Request $request, SystemUpdaterBootstrapService $bootstrap): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->superAdmin($request);
        $this->ensureEnabled();

        return IdempotencyService::executeJson($request, 'POST /system-updates/updater/prepare', function () use ($request, $bootstrap, $admin): JsonResponse {
            try {
                $prepared = $bootstrap->prepare();
            } catch (Throwable $exception) {
                report($exception);
                throw new ApiException('system_updater_prepare_failed', 'Updater 安装包准备失败', 503, [
                    'retryable' => true,
                ]);
            }
            $projected = $this->preparedProjection($prepared);
            $this->audit($request, $admin, 'api.system_update.prepare', [
                'version' => (string) ($projected['version'] ?? ''),
                'sha256' => (string) ($projected['sha256'] ?? ''),
            ]);

            return $this->success($request, ['prepared' => $projected], 202);
        });
    }

    public function download(Request $request, SystemUpdaterBootstrapService $bootstrap): StreamedResponse
    {
        $this->superAdmin($request);
        $this->ensureEnabled();
        try {
            $prepared = $bootstrap->download();
        } catch (Throwable $exception) {
            report($exception);
            throw new ApiException('system_updater_package_unavailable', '已验证的 Updater 安装包不可用', 404);
        }

        return Storage::disk('local')->download(
            (string) $prepared['path'],
            (string) $prepared['filename'],
            ['Content-Type' => 'application/gzip', 'X-Content-Type-Options' => 'nosniff'],
        );
    }

    public function startOperation(
        Request $request,
        string $kind,
        AgentClient $agent,
        SystemUpdaterMutationPolicy $policy,
        SystemUpdateOperationGuard $guard,
    ): JsonResponse {
        $this->requireIdempotencyKey($request);
        $admin = $this->superAdmin($request);
        $this->ensureEnabled();
        $validated = $this->operationPayload($request, $kind, $admin);

        $dispatch = function () use ($request, $kind, $agent, $validated, $admin): JsonResponse {
            $operation = $this->dispatchOperation($agent, $kind, $validated);
            $this->audit($request, $admin, 'api.system_update.operation_started', [
                'operation' => $kind,
                'operation_id' => (string) ($operation['id'] ?? ''),
                'recovery_point_id' => $kind === 'rollback' ? (string) ($validated['recovery_point_id'] ?? '') : '',
            ]);

            return $this->success($request, ['operation' => $operation], 202);
        };

        if ($kind === 'verify') {
            return IdempotencyService::executeExternalJson(
                $request,
                'POST /system-updates/operations/'.$kind,
                fn (): JsonResponse => $this->wrapAgentDispatch($kind, $dispatch),
            );
        }

        try {
            $status = $agent->status();
            if (! $policy->allows($status, $kind)) {
                throw new ApiException('system_updater_precondition_failed', 'Updater 操作前置检查未通过', 409, [
                    'operation' => $kind,
                ]);
            }
            if ($kind === 'rollback') {
                $this->assertRollbackAllowed($agent, (string) $validated['recovery_point_id']);
            }

            return $guard->run(
                fn (): JsonResponse => IdempotencyService::executeExternalJson(
                    $request,
                    'POST /system-updates/operations/'.$kind,
                    fn (): JsonResponse => $this->wrapAgentDispatch($kind, $dispatch),
                ),
                $status,
            );
        } catch (ApiException $exception) {
            throw $exception;
        } catch (Throwable $exception) {
            report($exception);
            throw new ApiException('system_updater_precondition_unavailable', '无法确认 Updater 操作前置状态', 503, [
                'operation' => $kind,
                'retryable' => true,
            ]);
        }
    }

    /** @param array<string, mixed> $validated @return array<string, mixed> */
    private function dispatchOperation(AgentClient $agent, string $kind, array $validated): array
    {
        if ($kind === 'verify') {
            return $agent->startVerify();
        }
        $authorization = (string) $validated['updater_authorization_code'];

        return match ($kind) {
            'update' => $agent->startUpdate($authorization),
            'backup' => $agent->startBackup($authorization),
            'rollback' => $agent->startRollback((string) $validated['recovery_point_id'], $authorization),
        };
    }

    /** @param \Closure(): JsonResponse $dispatch */
    private function wrapAgentDispatch(string $kind, \Closure $dispatch): JsonResponse
    {
        try {
            return $dispatch();
        } catch (Throwable $exception) {
            report($exception);
            throw new ApiException('system_updater_operation_failed', 'Updater 拒绝或无法启动该操作；请先刷新状态确认结果', 503, [
                'operation' => $kind,
                'retryable' => false,
            ]);
        }
    }

    /** @return array<string, mixed> */
    private function operationPayload(Request $request, string $kind, Admin $admin): array
    {
        if ($kind === 'verify') {
            return [];
        }
        $validated = $request->validate([
            'current_admin_password' => (bool) config('geoflow.update_require_admin_password', true)
                ? ['required', 'string', 'max:500']
                : ['nullable', 'string', 'max:500'],
            'updater_authorization_code' => ['required', 'regex:/\A[0-9]{6}\z/'],
            'recovery_point_id' => $kind === 'rollback'
                ? ['required', 'regex:/\A[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}\z/']
                : ['prohibited'],
        ]);
        if ((bool) config('geoflow.update_require_admin_password', true)
            && ! Hash::check((string) ($validated['current_admin_password'] ?? ''), (string) $admin->password)) {
            throw new ApiException('admin_password_invalid', '当前管理员密码不正确', 422, [
                'field_errors' => ['current_admin_password' => '当前管理员密码不正确'],
            ]);
        }

        return $validated;
    }

    /** @param array<string, mixed> $summary @param array<string, mixed> $bridge */
    private function projection(array $summary, array $bridge): array
    {
        $prepared = is_array($bridge['prepared'] ?? null) ? $this->preparedProjection($bridge['prepared']) : null;
        $operation = is_array($bridge['current_operation'] ?? null) ? $bridge['current_operation'] : null;
        $operationStatus = (string) ($operation['status'] ?? '');
        $operationBlocks = in_array($operationStatus, ['queued', 'running', 'recovery_required'], true);
        $legacyCutoverBlocked = ! empty($summary['has_legacy_active_run']) && empty($bridge['legacy_worker_absent']);
        $recoveryPoints = is_array($bridge['recovery_points'] ?? null)
            ? array_values(array_filter($bridge['recovery_points'], 'is_array'))
            : [];
        $recommendedRollbackId = null;
        foreach ($recoveryPoints as $point) {
            if (str_starts_with((string) ($point['reason'] ?? ''), 'update-to-')) {
                $recommendedRollbackId = (string) ($point['id'] ?? '');
                break;
            }
        }

        $bridge['prepared'] = $prepared;
        $bridge['recovery_points'] = array_map(static function (array $point) use ($recommendedRollbackId): array {
            $point['rollback_allowed'] = $recommendedRollbackId !== null
                && hash_equals($recommendedRollbackId, (string) ($point['id'] ?? ''));

            return $point;
        }, $recoveryPoints);
        $bridge['readiness'] = $this->readiness($bridge, $prepared !== null);
        $bridge['actions'] = [
            'prepare' => ($bridge['connection'] ?? 'disconnected') === 'disconnected',
            'download' => $prepared !== null,
            'verify' => ! $operationBlocks && ! empty($bridge['operations_available']),
            'backup' => ! $operationBlocks && ! $legacyCutoverBlocked
                && ($bridge['connection'] ?? '') === 'connected'
                && ! empty($bridge['mutation_authorization_ready']),
            'update' => ! $operationBlocks && ! $legacyCutoverBlocked
                && (($bridge['connection'] ?? '') === 'connected' || ! empty($bridge['phase_b_handover_ready']))
                && ! empty($bridge['mutation_authorization_ready']),
            'rollback' => ! $operationBlocks && ! $legacyCutoverBlocked
                && ($bridge['connection'] ?? '') === 'connected'
                && ! empty($bridge['mutation_authorization_ready'])
                && $recommendedRollbackId !== null,
        ];

        return [
            'release' => [
                'state' => is_array($summary['state'] ?? null) ? $summary['state'] : [],
                'notice' => is_array($summary['release_notice'] ?? null) ? $summary['release_notice'] : [],
                'links' => is_array($summary['links'] ?? null) ? $summary['links'] : [],
            ],
            'updater' => $bridge,
            'history' => [
                'scope' => (string) ($summary['history_scope'] ?? 'recent'),
                'days' => (int) ($summary['history_days'] ?? 90),
                'archived_run_count' => (int) ($summary['archived_run_count'] ?? 0),
                'archived_backup_count' => (int) ($summary['archived_backup_count'] ?? 0),
                'has_legacy_active_run' => ! empty($summary['has_legacy_active_run']),
                'runs' => $this->historyPage($summary['recent_runs'] ?? collect(), fn (SystemUpdateRun $run): array => $this->runProjection($run)),
                'backups' => $this->historyPage($summary['recent_backups'] ?? collect(), fn (SystemUpdateBackup $backup): array => $this->backupProjection($backup)),
            ],
            'admin_password_required' => ! empty($summary['admin_password_required']),
            'manual_commands' => is_array($summary['manual_commands'] ?? null) ? $summary['manual_commands'] : [],
        ];
    }

    /** @param LengthAwarePaginator<int, mixed>|Collection<int, mixed> $value */
    private function historyPage(LengthAwarePaginator|Collection $value, callable $project): array
    {
        $items = $value instanceof LengthAwarePaginator ? $value->items() : $value->all();

        return [
            'items' => array_map($project, $items),
            'pagination' => $value instanceof LengthAwarePaginator ? [
                'page' => $value->currentPage(),
                'per_page' => $value->perPage(),
                'total' => $value->total(),
                'total_pages' => $value->lastPage(),
            ] : ['page' => 1, 'per_page' => count($items), 'total' => count($items), 'total_pages' => count($items) > 0 ? 1 : 0],
        ];
    }

    private function runProjection(SystemUpdateRun $run): array
    {
        return [
            'id' => (int) $run->id,
            'run_uuid' => (string) $run->run_uuid,
            'action' => (string) $run->action,
            'status' => (string) $run->status,
            'current_version' => $run->current_version,
            'target_version' => $run->target_version,
            'deployment_mode' => $run->deployment_mode,
            'risk_level' => $run->risk_level,
            'error_message' => $run->error_message,
            'started_by' => $run->startedBy ? ['id' => (int) $run->startedBy->id, 'username' => (string) $run->startedBy->username] : null,
            'started_at' => $run->started_at?->toIso8601String(),
            'finished_at' => $run->finished_at?->toIso8601String(),
            'created_at' => $run->created_at?->toIso8601String(),
        ];
    }

    private function backupProjection(SystemUpdateBackup $backup): array
    {
        return [
            'id' => (int) $backup->id,
            'backup_uuid' => (string) $backup->backup_uuid,
            'from_version' => $backup->from_version,
            'to_version' => $backup->to_version,
            'file_count' => (int) $backup->file_count,
            'total_bytes' => (int) $backup->total_bytes,
            'status' => (string) $backup->status,
            'created_by' => $backup->createdBy ? ['id' => (int) $backup->createdBy->id, 'username' => (string) $backup->createdBy->username] : null,
            'created_at' => $backup->created_at?->toIso8601String(),
        ];
    }

    /** @param array<string, mixed> $prepared */
    private function preparedProjection(array $prepared): array
    {
        return array_filter([
            'version' => $prepared['version'] ?? null,
            'filename' => $prepared['filename'] ?? null,
            'sha256' => $prepared['sha256'] ?? null,
            'size' => $prepared['size'] ?? null,
            'platform' => $prepared['platform'] ?? null,
            'release_sequence' => $prepared['release_sequence'] ?? null,
            'expires' => $prepared['expires'] ?? null,
            'prepared_at' => $prepared['prepared_at'] ?? null,
        ], static fn (mixed $value): bool => $value !== null && $value !== '');
    }

    /** @param array<string, mixed> $bridge */
    private function readiness(array $bridge, bool $prepared): string
    {
        if (($bridge['connection'] ?? 'disconnected') === 'disconnected') {
            return $prepared ? 'installation_pending' : 'not_installed';
        }
        if (($bridge['connection'] ?? '') === 'degraded' || empty($bridge['operations_available'])) {
            return 'attention_required';
        }
        if (empty($bridge['mutation_authorization_ready'])) {
            return 'authorization_pending';
        }

        return 'ready';
    }

    private function superAdmin(Request $request): Admin
    {
        $admin = $this->executionAdmin($request);
        if (! $admin->isSuperAdmin()) {
            throw new ApiException('forbidden', '仅超级管理员可管理系统更新与恢复', 403, [
                'required_role' => 'super_admin',
            ]);
        }

        return $admin;
    }

    private function assertRollbackAllowed(AgentClient $agent, string $requestedId): void
    {
        $allowedId = null;
        foreach ($agent->recoveryPoints() as $point) {
            if (str_starts_with((string) ($point['reason'] ?? ''), 'update-to-')) {
                $allowedId = (string) ($point['id'] ?? '');
                break;
            }
        }
        if ($allowedId === null || ! hash_equals($allowedId, $requestedId)) {
            throw new ApiException('system_updater_recovery_point_not_allowed', '只能回滚到 Updater 当前提供的最新更新恢复点', 422, [
                'recovery_point_id' => $requestedId,
            ]);
        }
    }

    private function ensureEnabled(): void
    {
        if (! (bool) config('geoflow.update_center_enabled', true)) {
            throw new ApiException('system_update_center_disabled', '系统更新中心未启用', 404);
        }
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key', '')) === '') {
            throw new ApiException('idempotency_key_required', '该操作必须提供 X-Idempotency-Key', 422);
        }
    }

    /** @param array<string, mixed> $details */
    private function audit(Request $request, Admin $admin, string $action, array $details): void
    {
        AdminActivityLogger::logFromRequest($request, $admin, $action, $details);
    }
}
