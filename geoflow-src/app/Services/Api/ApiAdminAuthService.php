<?php

namespace App\Services\Api;

use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Support\GeoFlow\AdminLoginLockService;
use Illuminate\Support\Facades\DB;

class ApiAdminAuthService
{
    public function __construct(
        private ApiTokenService $tokenService,
        private AdminLoginLockService $loginLockService
    ) {}

    /**
     * @return array<string, mixed>
     */
    public function login(string $username, string $password, string $ipAddress = '', string $userAgent = ''): array
    {
        $username = trim($username);
        if ($username === '' || $password === '') {
            $fieldErrors = [];
            if ($username === '') {
                $fieldErrors['username'] = '用户名不能为空';
            }
            if ($password === '') {
                $fieldErrors['password'] = '密码不能为空';
            }
            throw new ApiException('validation_failed', '用户名和密码不能为空', 422, [
                'field_errors' => $fieldErrors,
            ]);
        }

        if ($this->loginLockService->tooManyAttempts($username, $ipAddress)) {
            throw new ApiException('too_many_attempts', '登录尝试过于频繁，请稍后再试', 429, [
                'retry_after' => $this->loginLockService->availableIn($username, $ipAddress),
            ]);
        }

        $loginResult = DB::transaction(function () use ($username, $password, $ipAddress): array {
            $admin = Admin::query()
                ->where('username', $username)
                ->lockForUpdate()
                ->first();
            if ($admin && $this->loginLockService->isLocked($admin)) {
                return ['error' => 'account_locked'];
            }

            $status = (string) ($admin?->status ?? 'active');
            $passwordMatches = $admin ? password_verify($password, (string) $admin->password) : false;
            if (! $admin || $status !== 'active' || ! $passwordMatches) {
                return ['error' => 'invalid_credentials'];
            }

            $admin->forceFill(['last_login' => now()])->save();
            $this->loginLockService->clearFailedAttempts($username, $ipAddress);

            $token = $this->tokenService->createToken(
                ApiTokenService::LOGIN_TOKEN_PREFIX.$username.' '.date('Y-m-d H:i:s'),
                $this->tokenService->getCliLoginScopes(),
                (int) $admin->id
            );

            /*
             * 回收这个管理员的旧登录令牌。
             *
             * 每次登录都铸一个新的全权限令牌，此前**没有任何回收**——实测半个月积到 130+ 条，
             * 「系统设置 → API Token」那页被撑到 33,007px。策略是「保留最近的若干个」，
             * 只碰自动铸的 `CLI Login *`，运营手工建的具名令牌一条都不动；
             * 正在用的会话是最近登录的，不会被打断。条数由
             * `geoflow.api_login_token_keep` 配（默认 5）。
             */
            $this->tokenService->pruneLoginTokens(
                (int) $admin->id,
                max(1, (int) config('geoflow.api_login_token_keep', 5)),
            );

            return [
                'admin' => $admin,
                'token' => $token,
            ];
        });
        if (($loginResult['error'] ?? null) === 'account_locked') {
            throw new ApiException('account_locked', '账号已被锁定，请联系超级管理员处理', 423);
        }
        if (($loginResult['error'] ?? null) === 'invalid_credentials') {
            if ($this->loginLockService->recordFailedAttempt($username, $ipAddress)) {
                throw new ApiException('too_many_attempts', '登录尝试过于频繁，请稍后再试', 429, [
                    'retry_after' => $this->loginLockService->availableIn($username, $ipAddress),
                ]);
            }

            throw new ApiException('invalid_credentials', '用户名或密码错误，或账号已被停用', 401);
        }

        /** @var Admin $admin */
        $admin = $loginResult['admin'];
        /** @var array<string, mixed> $tokenResult */
        $tokenResult = $loginResult['token'];

        return [
            'token' => $tokenResult['token'],
            'scopes' => $tokenResult['record']['scopes'] ?? [],
            'expires_at' => $tokenResult['record']['expires_at'] ?? null,
            'admin' => [
                'id' => (int) $admin->id,
                'username' => $admin->username,
                'display_name' => $admin->display_name ?? '',
                'role' => $admin->role ?? 'admin',
                'status' => $admin->status ?? 'active',
            ],
        ];
    }
}
