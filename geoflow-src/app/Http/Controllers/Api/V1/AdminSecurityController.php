<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Http\Requests\Api\AdminActivityLogIndexRequest;
use App\Http\Requests\Api\CreateAdminApiTokenRequest;
use App\Http\Requests\Api\UpdateAdminPasswordRequest;
use App\Http\Requests\Api\UpdateAdminProfileRequest;
use App\Models\Admin;
use App\Models\AdminActivityLog;
use App\Services\Api\AdminApiTokenIssuanceService;
use App\Services\Api\ApiTokenService;
use App\Services\Api\IdempotencyService;
use App\Support\AdminAccountProfileVersion;
use App\Support\AdminActivityLogger;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

/**
 * 管理员账户、API Token 与活动审计的 React 后台 API。
 *
 * 这些接口保留 桐灼GEO 原后台的业务边界：个人资料可由当前管理员维护，
 * Token 与全量审计日志仅允许超级管理员读取或写入。
 */
final class AdminSecurityController extends BaseApiController
{
    public function __construct(
        private readonly ApiTokenService $tokenService,
        private readonly AdminApiTokenIssuanceService $tokenIssuance,
    ) {}

    public function profile(Request $request): JsonResponse
    {
        $admin = $this->executionAdmin($request);

        return $this->success($request, [
            'admin' => $this->profileProjection($admin),
            'profile_version' => AdminAccountProfileVersion::for($admin),
        ]);
    }

    public function updateProfile(UpdateAdminProfileRequest $request): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $payload = $request->validated();

        return IdempotencyService::executeJson(
            $request,
            'PATCH /admin/profile',
            function () use ($request, $admin, $payload): JsonResponse {
                $result = DB::transaction(function () use ($admin, $payload): array {
                    /** @var Admin $locked */
                    $locked = Admin::query()->whereKey($admin->getKey())->lockForUpdate()->firstOrFail();
                    $currentVersion = AdminAccountProfileVersion::for($locked);
                    if (! hash_equals($currentVersion, (string) $payload['profile_version'])) {
                        throw new ApiException('profile_conflict', '管理员资料已被其他请求更新，请刷新后重试', 409, [
                            'current_profile_version' => $currentVersion,
                        ]);
                    }

                    $updates = [];
                    $changedFields = [];
                    foreach (['display_name', 'email'] as $field) {
                        if (! array_key_exists($field, $payload)) {
                            continue;
                        }
                        $value = $payload[$field] !== null ? trim((string) $payload[$field]) : null;
                        if ((string) ($locked->{$field} ?? '') !== (string) ($value ?? '')) {
                            $changedFields[] = $field;
                        }
                        $updates[$field] = $value;
                    }
                    if ($updates !== []) {
                        $locked->forceFill($updates)->save();
                    }

                    return [
                        'admin' => $locked->refresh(),
                        'changed_fields' => $changedFields,
                    ];
                });

                /** @var Admin $updated */
                $updated = $result['admin'];
                AdminActivityLogger::log($updated, 'api.admin.profile.update', [
                    'request_method' => 'PATCH',
                    'page' => 'admin/profile',
                    'target_type' => 'admin',
                    'target_id' => (int) $updated->getKey(),
                    'ip_address' => (string) ($request->ip() ?? ''),
                    'details' => [
                        'changed_fields' => $result['changed_fields'],
                    ],
                ]);

                return $this->success($request, [
                    'admin' => $this->profileProjection($updated),
                    'profile_version' => AdminAccountProfileVersion::for($updated),
                ]);
            },
        );
    }

    /**
     * Change the authenticated administrator's password and revoke every
     * credential issued to that account.  The old bearer token is therefore
     * intentionally unusable as soon as the successful response is returned;
     * the client must sign in again.
     */
    public function updatePassword(UpdateAdminPasswordRequest $request): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $payload = $request->validated();

        return IdempotencyService::executeJson(
            $request,
            'PATCH /admin/password',
            function () use ($request, $admin, $payload): JsonResponse {
                /** @var Admin $updated */
                $updated = DB::transaction(function () use ($admin, $payload): Admin {
                    /** @var Admin $locked */
                    $locked = Admin::query()
                        ->whereKey($admin->getKey())
                        ->lockForUpdate()
                        ->firstOrFail();

                    $storedHash = (string) $locked->getRawOriginal('password');
                    if ($storedHash === '' || ! Hash::check((string) $payload['current_password'], $storedHash)) {
                        throw new ApiException('validation_failed', '参数校验失败', 422, [
                            'field_errors' => [
                                'current_password' => '当前密码不正确',
                            ],
                        ]);
                    }

                    // The Admin `hashed` cast hashes the plain value exactly
                    // once when the model is persisted.
                    $locked->forceFill([
                        'password' => (string) $payload['password'],
                    ])->save();

                    // This method takes its own row lock, increments
                    // auth_version, rotates remember_token and removes every
                    // Sanctum token.  It is deliberately reused so web and API
                    // sessions share the same revocation semantics.
                    $locked->revokeAuthenticationCredentials();

                    return $locked->refresh();
                });

                AdminActivityLogger::log($updated, 'api.admin.password.update', [
                    'request_method' => 'PATCH',
                    'page' => 'admin/account',
                    'target_type' => 'admin',
                    'target_id' => (int) $updated->getKey(),
                    'ip_address' => (string) ($request->ip() ?? ''),
                    // Never include either password, its hash, or a token in
                    // the audit payload.
                    'details' => [
                        'credentials_revoked' => true,
                    ],
                ]);

                return $this->success($request, [
                    'password_updated' => true,
                    'credentials_revoked' => true,
                    'reauth_required' => true,
                ]);
            },
        );
    }

    public function tokens(Request $request): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $this->assertSuperAdmin($admin);

        return $this->success($request, [
            'items' => $this->tokenService->listTokens(),
            'available_scopes' => $this->tokenService->getAvailableScopes(),
            'default_expires_at' => $this->tokenService->defaultExpiresAt()->toIso8601String(),
        ]);
    }

    /**
     * 已授权的浏览器客户端（插件的设备授权）。
     *
     * **与 `admin/tokens` 的个人 API Token 不是一回事**：这些是浏览器插件走设备授权
     * 流程拿到的凭据，运营方要能在这里看到并撤销，否则只能回旧后台处理。
     * `browser-operations/*` 是插件自己调的协议路由，不是管理入口——两者不要混。
     *
     * 只列**当前管理员自己的**客户端（与旧后台同口径），不额外加超管门禁。
     */
    public function browserClients(Request $request): JsonResponse
    {
        $admin = $this->executionAdmin($request);

        return $this->success($request, [
            'items' => $this->tokenService->listBrowserTokens($admin),
        ]);
    }

    public function revokeBrowserClient(Request $request, int $token): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);

        return IdempotencyService::executeJson(
            $request,
            'DELETE /admin/browser-clients/{token}',
            function () use ($request, $admin, $token): JsonResponse {
                try {
                    $this->tokenService->revokeBrowserToken($token, $admin);
                } catch (ApiException $exception) {
                    if ($exception->getHttpStatus() === 404) {
                        // 别人的客户端也走这条：不区分「不存在」与「不属于你」。
                        throw new ApiException('browser_client_not_found', '浏览器客户端授权不存在', 404);
                    }

                    throw $exception;
                }

                AdminActivityLogger::log($admin, 'api.browser_client.revoke', [
                    'request_method' => 'DELETE',
                    'page' => 'admin/browser-clients',
                    'target_type' => 'browser_client_token',
                    'target_id' => $token,
                    'ip_address' => (string) ($request->ip() ?? ''),
                    'details' => ['token_id' => $token],
                ]);

                return $this->success($request, ['token_id' => $token, 'status' => 'revoked']);
            },
        );
    }

    public function storeToken(CreateAdminApiTokenRequest $request): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $this->assertSuperAdmin($admin);
        $payload = $request->validated();
        $result = $this->tokenIssuance->issue(
            $admin,
            (string) $payload['name'],
            array_values((array) $payload['scopes']),
            isset($payload['expires_at']) ? (string) $payload['expires_at'] : null,
            (string) $request->header('X-Idempotency-Key'),
        );

        if (! $result['replayed']) {
            AdminActivityLogger::log($admin, 'api.admin.token.create', [
                'request_method' => 'POST',
                'page' => 'admin/tokens',
                'target_type' => 'personal_access_token',
                'target_id' => (int) ($result['record']['id'] ?? 0),
                'ip_address' => (string) ($request->ip() ?? ''),
                'details' => [
                    'name' => (string) ($result['record']['name'] ?? $payload['name']),
                    'scopes' => $result['record']['scopes'] ?? [],
                    'expires_at' => $result['record']['expires_at'] ?? null,
                ],
            ]);
        }

        return $this->success($request, [
            'token' => $result['token'],
            'record' => $result['record'],
            'one_time_plaintext' => true,
            'replayed' => $result['replayed'],
        ], $result['replayed'] ? 200 : 201);
    }

    public function revokeToken(Request $request, int $token): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        $this->assertSuperAdmin($admin);

        return IdempotencyService::executeJson(
            $request,
            'POST /admin/tokens/{token}/revoke',
            function () use ($request, $admin, $token): JsonResponse {
                $this->tokenService->revokeToken($token);
                AdminActivityLogger::log($admin, 'api.admin.token.revoke', [
                    'request_method' => 'POST',
                    'page' => 'admin/tokens',
                    'target_type' => 'personal_access_token',
                    'target_id' => $token,
                    'ip_address' => (string) ($request->ip() ?? ''),
                    'details' => ['token_id' => $token],
                ]);

                return $this->success($request, [
                    'token_id' => $token,
                    'status' => 'revoked',
                ]);
            },
        );
    }

    public function activityLogs(AdminActivityLogIndexRequest $request): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $this->assertSuperAdmin($admin);
        $filters = $request->validated();
        $query = AdminActivityLog::query()
            ->select([
                'id',
                'admin_id',
                'admin_username',
                'admin_role',
                'action',
                'request_method',
                'page',
                'target_type',
                'target_id',
                'ip_address',
                'details',
                'created_at',
            ])
            ->with(['admin:id,username,display_name,role'])
            ->orderByDesc('created_at')
            ->orderByDesc('id');

        $this->applyActivityFilters($query, $filters);
        $page = $query->paginate(
            max(1, min(100, (int) ($filters['per_page'] ?? 50))),
            ['*'],
            'page',
            max(1, (int) ($filters['page'] ?? 1)),
        );

        return $this->success($request, [
            'items' => $page->getCollection()
                ->map(fn (AdminActivityLog $log): array => $this->activityProjection($log))
                ->values()
                ->all(),
            'pagination' => [
                'page' => (int) $page->currentPage(),
                'per_page' => (int) $page->perPage(),
                'total' => (int) $page->total(),
                'total_pages' => (int) $page->lastPage(),
            ],
            'stats' => [
                'total_logs' => (int) AdminActivityLog::query()->count(),
                'today_logs' => (int) AdminActivityLog::query()->whereDate('created_at', Carbon::today())->count(),
                'active_admins' => (int) AdminActivityLog::query()
                    ->where('created_at', '>=', Carbon::now()->subDays(7))
                    ->distinct('admin_id')
                    ->count('admin_id'),
            ],
        ]);
    }

    /** @return array<string,mixed> */
    private function profileProjection(Admin $admin): array
    {
        return [
            'id' => (int) $admin->getKey(),
            'username' => (string) $admin->username,
            'display_name' => (string) ($admin->display_name ?? ''),
            'email' => (string) ($admin->email ?? ''),
            'role' => (string) ($admin->role ?? 'admin'),
            'status' => (string) ($admin->status ?? 'active'),
            'last_login' => $admin->last_login?->toIso8601String(),
            'created_at' => $admin->created_at?->toIso8601String(),
            'is_super_admin' => $admin->isSuperAdmin(),
        ];
    }

    private function assertSuperAdmin(Admin $admin): void
    {
        if (! $admin->isSuperAdmin()) {
            throw new ApiException('forbidden', '仅超级管理员可访问此接口', 403, [
                'required_role' => 'super_admin',
            ]);
        }
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

    /** @param  array<string,mixed>  $filters */
    private function applyActivityFilters(Builder $query, array $filters): void
    {
        if ((int) ($filters['admin_id'] ?? 0) > 0) {
            $query->where('admin_id', (int) $filters['admin_id']);
        }
        if (trim((string) ($filters['action'] ?? '')) !== '') {
            $query->where('action', trim((string) $filters['action']));
        }
        if (trim((string) ($filters['search'] ?? '')) !== '') {
            $keyword = '%'.trim((string) $filters['search']).'%';
            $query->where(static function (Builder $builder) use ($keyword): void {
                $builder
                    ->where('admin_username', 'like', $keyword)
                    ->orWhere('action', 'like', $keyword)
                    ->orWhere('page', 'like', $keyword)
                    ->orWhere('details', 'like', $keyword);
            });
        }
        if (is_string($filters['date_from'] ?? null) && $filters['date_from'] !== '') {
            $query->where('created_at', '>=', Carbon::parse($filters['date_from'])->startOfDay());
        }
        if (is_string($filters['date_to'] ?? null) && $filters['date_to'] !== '') {
            $query->where('created_at', '<=', Carbon::parse($filters['date_to'])->endOfDay());
        }
    }

    /** @return array<string,mixed> */
    private function activityProjection(AdminActivityLog $log): array
    {
        $decoded = json_decode((string) $log->details, true);
        $details = is_array($decoded) ? $this->redactDetails($decoded) : $this->redactDetails((string) $log->details);

        return [
            'id' => (int) $log->getKey(),
            'admin_id' => $log->admin_id !== null ? (int) $log->admin_id : null,
            'admin' => $log->admin ? [
                'id' => (int) $log->admin->getKey(),
                'username' => (string) $log->admin->username,
                'display_name' => (string) ($log->admin->display_name ?? ''),
                'role' => (string) ($log->admin->role ?? ''),
            ] : null,
            'admin_username' => (string) $log->admin_username,
            'admin_role' => (string) $log->admin_role,
            'action' => (string) $log->action,
            'request_method' => (string) $log->request_method,
            'page' => (string) $log->page,
            'target_type' => (string) $log->target_type,
            'target_id' => $log->target_id !== null ? (int) $log->target_id : null,
            'ip_address' => (string) $log->ip_address,
            'details' => $details,
            'created_at' => $log->created_at?->toIso8601String(),
        ];
    }

    private function redactDetails(mixed $value, ?string $key = null): mixed
    {
        if ($key !== null && preg_match('/password|secret|credential|api[_-]?key|(?:^|_)(?:access_|refresh_|bearer_|oauth_)?token(?:$|_value$)/i', $key) === 1) {
            return '[redacted]';
        }
        if (is_array($value)) {
            $redacted = [];
            foreach ($value as $childKey => $childValue) {
                $redacted[$childKey] = $this->redactDetails($childValue, is_string($childKey) ? $childKey : null);
            }

            return $redacted;
        }
        if (! is_string($value)) {
            return $value;
        }

        $value = preg_replace('/Bearer\s+[A-Za-z0-9._~+\/-]+/i', 'Bearer [redacted]', $value) ?? $value;
        $value = preg_replace('/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/i', '[redacted]', $value) ?? $value;

        return mb_strlen($value) > 1000 ? mb_substr($value, 0, 1000).'...' : $value;
    }
}
