<?php

namespace App\Services\Api;

use App\Exceptions\ApiException;
use App\Models\Admin;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Laravel\Sanctum\PersonalAccessToken;

class ApiTokenService
{
    /**
     * 拉取 Token 列表（按创建时间倒序）。
     *
     * @return list<array<string,mixed>>
     */
    public function listTokens(): array
    {
        /** @var Collection<int, PersonalAccessToken> $rows */
        $rows = PersonalAccessToken::query()
            ->where('tokenable_type', Admin::class)
            ->with('tokenable:id,username')
            ->orderByDesc('created_at')
            ->orderByDesc('id')
            ->get();

        return $rows
            ->map(function (PersonalAccessToken $row): array {
                $data = $this->hydrate($row);
                $data['created_by_username'] = (string) ($row->tokenable?->username ?? '');

                return $data;
            })
            ->all();
    }

    /** @return list<array<string,mixed>> */
    public function listBrowserTokens(Admin $viewer): array
    {
        /** @var Collection<int, PersonalAccessToken> $rows */
        $rows = PersonalAccessToken::query()
            ->where('tokenable_type', Admin::class)
            ->with('tokenable:id,username')
            ->when(! $viewer->isSuperAdmin(), fn ($query) => $query->where('tokenable_id', $viewer->getKey()))
            ->orderByDesc('created_at')
            ->orderByDesc('id')
            ->get();

        return $rows
            ->filter(fn (PersonalAccessToken $row): bool => in_array('browser-operations:read', (array) $row->abilities, true))
            ->map(function (PersonalAccessToken $row): array {
                $data = $this->hydrate($row);
                $data['created_by_username'] = (string) ($row->tokenable?->username ?? '');

                return $data;
            })
            ->values()
            ->all();
    }

    public function revokeBrowserToken(int $tokenId, Admin $viewer): void
    {
        $row = PersonalAccessToken::query()
            ->where('tokenable_type', Admin::class)
            ->whereKey($tokenId)
            ->first();
        if (! $row instanceof PersonalAccessToken
            || ! in_array('browser-operations:read', (array) $row->abilities, true)
            || (! $viewer->isSuperAdmin() && (int) $row->tokenable_id !== (int) $viewer->getKey())) {
            throw new ApiException('token_not_found', '浏览器连接不存在', 404);
        }

        $row->delete();
    }

    /**
     * 撤销指定 Token（Sanctum 语义为物理删除）。
     */
    public function revokeToken(int $tokenId): void
    {
        $affected = PersonalAccessToken::query()
            ->where('tokenable_type', Admin::class)
            ->whereKey($tokenId)
            ->delete();

        if ($affected !== 1) {
            throw new ApiException('token_not_found', 'Token 不存在', 404);
        }
    }

    /**
     * @return array<string, mixed>|null
     */
    public function getActiveTokenByPlaintext(string $plainToken): ?array
    {
        $row = PersonalAccessToken::findToken($plainToken);

        if (! $row || $row->tokenable_type !== Admin::class) {
            return null;
        }

        $row->loadMissing('tokenable:id,status');
        if (! $row->tokenable instanceof Admin || $row->tokenable->status !== 'active') {
            return null;
        }

        if ($row->expires_at && $row->expires_at->isPast()) {
            return null;
        }

        return $this->hydrate($row);
    }

    public function touchToken(int $tokenId): void
    {
        PersonalAccessToken::query()
            ->where('tokenable_type', Admin::class)
            ->whereKey($tokenId)
            ->update([
                'last_used_at' => now(),
                'updated_at' => now(),
            ]);
    }

    public function defaultExpiresAt(): Carbon
    {
        $days = max(1, (int) config('geoflow.api_token_default_ttl_days', 30));

        return now()->addDays($days);
    }

    public function defaultExpiresAtInputValue(): string
    {
        return $this->defaultExpiresAt()->format('Y-m-d\TH:i');
    }

    /**
     * @param  array<string, mixed>  $token
     */
    public function tokenHasScope(array $token, string $scope): bool
    {
        $scopes = $token['scopes'] ?? [];

        return in_array('*', $scopes, true) || in_array($scope, $scopes, true);
    }

    public function resolveAuditAdminId(?int $preferredAdminId): int
    {
        if ($preferredAdminId === null || $preferredAdminId <= 0) {
            throw new ApiException('admin_not_found', '系统中不存在可用的管理员账号', 500);
        }

        $activeAdminId = (int) Admin::query()
            ->whereKey($preferredAdminId)
            ->where('status', 'active')
            ->value('id');
        if ($activeAdminId <= 0) {
            throw new ApiException('admin_not_found', '系统中不存在可用的管理员账号', 500);
        }

        return $activeAdminId;
    }

    /**
     * @param  list<string>  $scopes
     * @return array{token: string, record: array<string, mixed>}
     */
    public function createToken(string $name, array $scopes, ?int $adminId, ?string $expiresAt = null): array
    {
        $name = trim($name);
        if ($name === '') {
            throw new ApiException('validation_failed', 'Token 名称不能为空', 422, [
                'field_errors' => ['name' => 'Token 名称不能为空'],
            ]);
        }

        $scopes = $this->validateScopes($scopes);

        $expires = $this->normalizeExpiresAt($expiresAt);
        $creatorId = $this->resolveAuditAdminId($adminId);
        $admin = Admin::query()->whereKey($creatorId)->first();
        if (! $admin) {
            throw new ApiException('admin_not_found', '系统中不存在可用的管理员账号', 500);
        }

        $tokenResult = $admin->createToken(
            $name,
            array_values($scopes),
            Carbon::parse($expires)
        );
        $model = $tokenResult->accessToken->fresh();
        if (! $model instanceof PersonalAccessToken) {
            throw new ApiException('token_create_failed', 'Token 创建失败', 500);
        }

        $record = $this->hydrate($model);

        return [
            'token' => $tokenResult->plainTextToken,
            'record' => $record,
        ];
    }

    /**
     * @return list<string>
     */
    public function getAvailableScopes(): array
    {
        return array_values(array_unique(array_merge(
            $this->getCliLoginScopes(),
            $this->getBrowserClientScopes(),
        )));
    }

    /**
     * 规范化并校验客户端请求的 scope；未知 scope 一律拒绝，避免调用方误以为
     * 已获得权限而实际拿到一个权限更窄的 Token。
     *
     * @param  list<string>  $scopes
     * @return list<string>
     */
    public function validateScopes(array $scopes): array
    {
        $allowed = $this->getAvailableScopes();
        $normalized = [];
        $unknown = [];
        foreach ($scopes as $scope) {
            $scope = trim((string) $scope);
            if ($scope === '') {
                continue;
            }
            if (! in_array($scope, $allowed, true)) {
                $unknown[] = $scope;

                continue;
            }
            $normalized[] = $scope;
        }

        $normalized = array_values(array_unique($normalized));
        if ($unknown !== []) {
            throw new ApiException('validation_failed', '包含不支持的 scope', 422, [
                'field_errors' => ['scopes' => '不支持的 scope: '.implode(', ', array_values(array_unique($unknown)))],
                'unknown_scopes' => array_values(array_unique($unknown)),
            ]);
        }
        if ($normalized === []) {
            throw new ApiException('validation_failed', '至少选择一个 scope', 422, [
                'field_errors' => ['scopes' => '至少选择一个 scope'],
            ]);
        }

        return $normalized;
    }

    /**
     * @return list<string>
     */
    public function getCliLoginScopes(): array
    {
        return [
            'catalog:read',
            'models:read',
            'models:write',
            'seo:read',
            'seo:write',
            'tasks:read',
            'tasks:write',
            'jobs:read',
            'articles:read',
            'articles:write',
            'articles:publish',
            'materials:read',
            'materials:write',
            'distribution:read',
            'distribution:write',
            'analytics:read',
            'analytics:collect',
            'jiandu:read',
            'jiandu:write',
            'leads:read',
            'leads:write',
            'workspace:read',
            'workspace:write',
            'system:read',
            'system:write',
            'account:read',
            'account:write',
            'tokens:read',
            'tokens:write',
            'audit:read',
        ];
    }

    /**
     * @return list<string>
     */
    public function getBrowserClientScopes(): array
    {
        return [
            'browser-operations:read',
            'browser-operations:execute',
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function hydrate(PersonalAccessToken $row): array
    {
        $scopes = $row->abilities;
        if (! is_array($scopes)) {
            $scopes = [];
        }

        return [
            'id' => (int) $row->id,
            'name' => $row->name,
            'token_hash' => '',
            'scopes' => $scopes,
            // 以前这里写死 `active`：为外部脚本签发的 30 天令牌早就过期了，列表里照样显示
            // 为有效凭据（撤销走的是物理删除，所以「已撤销」这个值永远不会出现）。
            // 现在按 `expires_at` 如实给出 expired —— 运营盘点凭据时才有得看。
            'status' => $row->expires_at !== null && $row->expires_at->isPast() ? 'expired' : 'active',
            'created_by_admin_id' => $row->tokenable_id !== null ? (int) $row->tokenable_id : null,
            'last_used_at' => $row->last_used_at?->format('Y-m-d H:i:s'),
            'expires_at' => $row->expires_at?->format('Y-m-d H:i:s'),
            'created_at' => $row->created_at?->format('Y-m-d H:i:s'),
            'updated_at' => $row->updated_at?->format('Y-m-d H:i:s'),
        ];
    }

    /**
     * @return list<string>
     */
    private function normalizeExpiresAt(?string $expiresAt): string
    {
        $expiresAt = $expiresAt !== null ? trim($expiresAt) : null;
        if ($expiresAt === null || $expiresAt === '') {
            return $this->defaultExpiresAt()->format('Y-m-d H:i:s');
        }

        $timestamp = strtotime($expiresAt);
        if ($timestamp === false) {
            throw new ApiException('validation_failed', '过期时间格式无效', 422, [
                'field_errors' => ['expires_at' => '过期时间格式无效'],
            ]);
        }

        return date('Y-m-d H:i:s', $timestamp);
    }
}
