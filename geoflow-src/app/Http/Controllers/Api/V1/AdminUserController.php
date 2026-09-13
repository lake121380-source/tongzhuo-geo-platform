<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\AdminAiSharingException;
use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Services\Admin\AdminAiDependencyInspector;
use App\Services\Admin\AdminAiSharingService;
use App\Services\Api\IdempotencyService;
use App\Support\AdminActivityLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Validation\Rule;
use Throwable;

/**
 * 桐灼GEO 管理员账号管理的 React API。
 *
 * 旧 Blade 后台已经有完整的管理员业务服务；这里仅提供同一套业务规则
 * 的 JSON 入口，确保 -AI 不需要回到旧管理界面才能完成账号维护。
 */
final class AdminUserController extends BaseApiController
{
    public function __construct(
        private readonly AdminAiSharingService $sharingService,
        private readonly AdminAiDependencyInspector $dependencyInspector,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $actor = $this->executionAdmin($request);
        $this->assertSuperAdmin($actor);

        $query = Admin::query()
            ->select([
                'id', 'username', 'email', 'display_name', 'role', 'status',
                'last_login', 'created_at', 'created_by', 'shared_ai_config_owner_id',
                'ai_config_access_version',
            ])
            ->with([
                'creator:id,username',
                'sharedAiConfigOwner:id,username,display_name,status',
            ])
            ->orderByRaw("CASE WHEN LOWER(COALESCE(role, '')) IN ('super_admin', 'superadmin') THEN 0 ELSE 1 END")
            ->orderBy('created_at')
            ->orderBy('id');

        if (Schema::hasTable('admin_activity_logs')) {
            $query->withCount('activityLogs as activity_count');
        }

        $admins = $query->get()->map(fn (Admin $admin): array => $this->projection($admin))->values()->all();

        return $this->success($request, [
            'items' => $admins,
            'current_admin_id' => (int) $actor->getKey(),
            'stats' => [
                'total_admins' => count($admins),
                'active_admins' => count(array_filter($admins, static fn (array $admin): bool => $admin['status'] === 'active')),
                'super_admins' => count(array_filter($admins, static fn (array $admin): bool => $admin['is_super_admin'])),
            ],
        ]);
    }

    public function show(Request $request, int $admin): JsonResponse
    {
        $actor = $this->executionAdmin($request);
        $this->assertSuperAdmin($actor);
        $target = $this->findTarget($admin);
        $sharingImpact = $this->dependencyInspector->sharingImpact($target);

        return $this->success($request, [
            'admin' => $this->projection($target),
            'sharing_impact' => [
                'shared_default_model_ids' => $sharingImpact->sharedDefaultModelIds,
                'pending_task_counts' => $sharingImpact->pendingTaskCounts,
            ],
            'deletion_dependencies' => $this->dependencyInspector->deletionDependencies($target)->counts(),
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $actor = $this->executionAdmin($request);
        $this->assertSuperAdmin($actor);

        return IdempotencyService::executeJson($request, 'POST /admin/users', function () use ($request, $actor): JsonResponse {
            $payload = $this->validateStore($request);
            try {
                $created = $this->sharingService->createOrdinaryAdmin($actor, $payload, (string) $payload['ai_config_mode']);
            } catch (AdminAiSharingException $exception) {
                throw $this->mapSharingException($exception);
            }

            AdminActivityLogger::log($actor, 'api.admin.user.create', [
                'request_method' => 'POST',
                'page' => 'admin/users',
                'target_type' => 'admin',
                'target_id' => (int) $created->getKey(),
                'ip_address' => (string) ($request->ip() ?? ''),
                'details' => ['username' => (string) $created->username],
            ]);

            return $this->success($request, ['admin' => $this->projection($created->load(['creator:id,username', 'sharedAiConfigOwner:id,username,display_name,status']))], 201);
        });
    }

    public function update(Request $request, int $admin): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $actor = $this->executionAdmin($request);
        $this->assertSuperAdmin($actor);
        $target = $this->findTarget($admin);

        return IdempotencyService::executeJson($request, 'PATCH /admin/users/{admin}', function () use ($request, $actor, $target): JsonResponse {
            $payload = $this->validateUpdate($request, $target);
            try {
                $result = $this->sharingService->updateAdmin(
                    $actor,
                    $target,
                    $payload,
                    $target->isSuperAdmin() ? null : (string) $payload['ai_config_mode'],
                    $target->isSuperAdmin() ? null : (int) $payload['expected_ai_config_access_version'],
                    $target->isSuperAdmin() || blank($payload['expected_shared_ai_config_owner_id'] ?? null)
                        ? null
                        : (int) $payload['expected_shared_ai_config_owner_id'],
                    ! $target->isSuperAdmin() && (bool) ($payload['switch_shared_provider'] ?? false),
                );
            } catch (AdminAiSharingException $exception) {
                throw $this->mapSharingException($exception);
            }

            $updated = $result->admin->load(['creator:id,username', 'sharedAiConfigOwner:id,username,display_name,status']);
            AdminActivityLogger::log($actor, 'api.admin.user.update', [
                'request_method' => 'PATCH',
                'page' => 'admin/users',
                'target_type' => 'admin',
                'target_id' => (int) $updated->getKey(),
                'ip_address' => (string) ($request->ip() ?? ''),
                'details' => [
                    'changed_fields' => array_values(array_intersect(array_keys($payload), ['username', 'display_name', 'email', 'status', 'ai_config_mode'])),
                    'sharing_change' => $result->toArray(),
                ],
            ]);

            return $this->success($request, [
                'admin' => $this->projection($updated),
                'sharing_change' => $result->toArray(),
            ]);
        });
    }

    public function toggleStatus(Request $request, int $admin): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $actor = $this->executionAdmin($request);
        $this->assertSuperAdmin($actor);
        $target = $this->findTarget($admin);

        return IdempotencyService::executeJson($request, 'POST /admin/users/{admin}/status', function () use ($request, $actor, $target): JsonResponse {
            $payload = $request->validate(['next_status' => ['required', Rule::in(['active', 'inactive'])]]);
            try {
                $result = $this->sharingService->changeOrdinaryStatus($actor, $target, (string) $payload['next_status']);
            } catch (AdminAiSharingException $exception) {
                throw $this->mapSharingException($exception);
            }

            $updated = $result->admin->load(['creator:id,username', 'sharedAiConfigOwner:id,username,display_name,status']);
            AdminActivityLogger::log($actor, 'api.admin.user.status', [
                'request_method' => 'POST',
                'page' => 'admin/users',
                'target_type' => 'admin',
                'target_id' => (int) $updated->getKey(),
                'ip_address' => (string) ($request->ip() ?? ''),
                'details' => ['status' => (string) $updated->status],
            ]);

            return $this->success($request, ['admin' => $this->projection($updated), 'sharing_change' => $result->toArray()]);
        });
    }

    public function destroy(Request $request, int $admin): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $actor = $this->executionAdmin($request);
        $this->assertSuperAdmin($actor);
        $target = $this->findTarget($admin);

        return IdempotencyService::executeJson($request, 'DELETE /admin/users/{admin}', function () use ($request, $actor, $target): JsonResponse {
            if ($target->is($actor)) {
                throw new ApiException('admin_delete_self', '不能删除当前登录管理员', 422);
            }
            if ($target->isSuperAdmin()) {
                throw new ApiException('admin_delete_super_admin', '不能删除超级管理员', 422);
            }

            try {
                DB::transaction(function () use ($target, $actor): void {
                    $locked = Admin::query()->whereKey($target->getKey())->lockForUpdate()->firstOrFail();
                    $dependencies = $this->dependencyInspector->deletionDependencies($locked);
                    if ($dependencies->blocksDeletion()) {
                        throw AdminAiSharingException::deleteBlocked((int) $locked->getKey(), $dependencies->counts());
                    }
                    DB::table('admins')->where('created_by', $locked->getKey())->update(['created_by' => null]);
                    if (Schema::hasTable('article_reviews')) {
                        DB::table('article_reviews')->where('admin_id', $locked->getKey())->update(['admin_id' => $actor->getKey()]);
                    }
                    $locked->revokeAuthenticationCredentials();
                    $locked->delete();
                });
            } catch (AdminAiSharingException $exception) {
                throw $this->mapSharingException($exception);
            } catch (Throwable $exception) {
                report($exception);
                throw new ApiException('admin_delete_failed', '管理员删除失败', 500);
            }

            AdminActivityLogger::log($actor, 'api.admin.user.delete', [
                'request_method' => 'DELETE',
                'page' => 'admin/users',
                'target_type' => 'admin',
                'target_id' => (int) $target->getKey(),
                'ip_address' => (string) ($request->ip() ?? ''),
                'details' => ['deleted' => true],
            ]);

            return $this->success($request, ['deleted' => true, 'admin_id' => (int) $target->getKey()]);
        });
    }

    private function findTarget(int $id): Admin
    {
        if ($id <= 0) {
            throw new ApiException('admin_not_found', '管理员不存在', 404);
        }
        $target = Admin::query()
            ->with(['creator:id,username', 'sharedAiConfigOwner:id,username,display_name,status'])
            ->whereKey($id)
            ->first();
        if (! $target instanceof Admin) {
            throw new ApiException('admin_not_found', '管理员不存在', 404);
        }

        return $target;
    }

    /** @return array<string,mixed> */
    private function validateStore(Request $request): array
    {
        $payload = $request->validate([
            'username' => ['required', 'string', 'regex:/^[A-Za-z0-9_.-]{3,50}$/', Rule::unique('admins', 'username')],
            'display_name' => ['nullable', 'string', 'max:100'],
            'email' => ['nullable', 'email', 'max:191'],
            'password' => ['required', 'string', 'min:8', 'same:confirm_password'],
            'confirm_password' => ['required', 'string', 'min:8'],
            'ai_config_mode' => ['required', Rule::in(['independent', 'shared_current_super'])],
        ]);
        foreach (['username', 'display_name', 'email'] as $field) {
            if (array_key_exists($field, $payload) && is_string($payload[$field])) {
                $payload[$field] = trim($payload[$field]);
            }
        }

        return $payload;
    }

    /** @return array<string,mixed> */
    private function validateUpdate(Request $request, Admin $target): array
    {
        $rules = [
            'username' => ['required', 'string', 'regex:/^[A-Za-z0-9_.-]{3,50}$/', Rule::unique('admins', 'username')->ignore($target->getKey())],
            'display_name' => ['nullable', 'string', 'max:100'],
            'email' => ['nullable', 'email', 'max:191'],
            'status' => ['required', Rule::in(['active', 'inactive'])],
            'password' => ['nullable', 'string', 'min:8', 'same:confirm_password'],
            'confirm_password' => ['nullable', 'string', 'min:8'],
            'ai_config_mode' => $target->isSuperAdmin() ? ['prohibited'] : ['required', Rule::in(['independent', 'shared_current_super'])],
            'expected_ai_config_access_version' => $target->isSuperAdmin() ? ['prohibited'] : ['required', 'integer', 'min:1'],
            'expected_shared_ai_config_owner_id' => $target->isSuperAdmin() ? ['prohibited'] : ['present', 'nullable', 'integer', 'min:1'],
            'switch_shared_provider' => $target->isSuperAdmin() ? ['prohibited'] : ['sometimes', 'boolean'],
        ];
        $payload = $request->validate($rules);
        foreach (['username', 'display_name', 'email'] as $field) {
            if (array_key_exists($field, $payload) && is_string($payload[$field])) {
                $payload[$field] = trim($payload[$field]);
            }
        }

        return $payload;
    }

    /** @return array<string,mixed> */
    private function projection(Admin $admin): array
    {
        return [
            'id' => (int) $admin->getKey(),
            'username' => (string) ($admin->username ?? ''),
            'email' => (string) ($admin->email ?? ''),
            'display_name' => (string) ($admin->display_name ?? ''),
            'role' => (string) ($admin->role ?? 'admin'),
            'status' => (string) ($admin->status ?? 'active'),
            'is_super_admin' => $admin->isSuperAdmin(),
            'last_login' => $admin->last_login?->toIso8601String(),
            'created_at' => $admin->created_at?->toIso8601String(),
            'creator_username' => (string) ($admin->creator?->username ?? ''),
            'activity_count' => (int) ($admin->activity_count ?? 0),
            'ai_config_mode' => $admin->isSuperAdmin()
                ? 'super_self'
                : ($admin->shared_ai_config_owner_id === null ? 'independent' : 'shared'),
            'shared_ai_config_owner_id' => $admin->shared_ai_config_owner_id !== null ? (int) $admin->shared_ai_config_owner_id : null,
            'shared_provider_name' => (string) ($admin->sharedAiConfigOwner?->name ?? ''),
            'shared_provider_status' => (string) ($admin->sharedAiConfigOwner?->status ?? ''),
            'ai_config_access_version' => max(1, (int) ($admin->ai_config_access_version ?? 1)),
        ];
    }

    private function assertSuperAdmin(Admin $admin): void
    {
        if (! $admin->isSuperAdmin()) {
            throw new ApiException('forbidden', '仅超级管理员可管理管理员账号', 403, ['required_role' => 'super_admin']);
        }
    }

    private function requireIdempotencyKey(Request $request): void
    {
        $key = trim((string) $request->header('X-Idempotency-Key'));
        if ($key === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
        if (strlen($key) > 120 || preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]*$/D', $key) !== 1) {
            throw new ApiException('invalid_idempotency_key', 'X-Idempotency-Key 格式无效', 422);
        }
    }

    private function mapSharingException(AdminAiSharingException $exception): ApiException
    {
        $context = $exception->context();

        return match ($exception->getErrorCode()) {
            AdminAiSharingException::ACCESS_CONFLICT => new ApiException('admin_access_conflict', '管理员 AI 配置访问关系已变化，请刷新后重试', 409, $context),
            AdminAiSharingException::DELETE_BLOCKED => new ApiException('admin_delete_blocked', '管理员仍存在业务依赖，不能删除', 409, $context),
            AdminAiSharingException::TARGET_INVALID => new ApiException('admin_target_invalid', '管理员目标无效或不允许执行此操作', 422, $context),
            default => new ApiException('admin_mutation_failed', '管理员操作失败', 422, $context),
        };
    }
}
