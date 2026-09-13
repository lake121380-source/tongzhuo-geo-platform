<?php

namespace App\Services\Api;

use App\Exceptions\ApiException;
use App\Models\Admin;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Crypt;
use Laravel\Sanctum\PersonalAccessToken;
use Throwable;

/**
 * 为管理 API 创建 Token，并在短期加密缓存中保留一次性明文以处理网络重试。
 *
 * 明文绝不写入 personal_access_tokens、api_idempotency_keys 或活动日志。
 */
final class AdminApiTokenIssuanceService
{
    private const IDEMPOTENCY_TTL_SECONDS = 600;

    public function __construct(
        private readonly ApiTokenService $tokenService,
    ) {}

    /**
     * @param  list<string>  $scopes
     * @return array{token:string,record:array<string,mixed>,replayed:bool}
     */
    public function issue(
        Admin $admin,
        string $name,
        array $scopes,
        ?string $expiresAt,
        string $idempotencyKey,
    ): array {
        $normalizedScopes = $this->tokenService->validateScopes($scopes);
        sort($normalizedScopes);
        $fingerprint = hash('sha256', json_encode([
            'admin_id' => (int) $admin->getKey(),
            'name' => trim($name),
            'scopes' => $normalizedScopes,
            'expires_at' => $expiresAt,
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR));
        $cacheKey = 'geoflow:admin-api-token:'.(int) $admin->getKey().':'.hash('sha256', $idempotencyKey);

        if (! Cache::add($cacheKey, [
            'state' => 'pending',
            'request_hash' => $fingerprint,
        ], self::IDEMPOTENCY_TTL_SECONDS)) {
            return $this->replay($cacheKey, $fingerprint);
        }

        $created = null;
        try {
            $created = $this->tokenService->createToken(
                $name,
                $normalizedScopes,
                (int) $admin->getKey(),
                $expiresAt,
            );
            $record = (array) ($created['record'] ?? []);
            $record['created_by_username'] = (string) $admin->username;
            $encryptedToken = Crypt::encryptString((string) ($created['token'] ?? ''));
            $stored = Cache::put($cacheKey, [
                'state' => 'completed',
                'request_hash' => $fingerprint,
                'record' => $record,
                'token' => $encryptedToken,
            ], self::IDEMPOTENCY_TTL_SECONDS);
            if (! $stored) {
                throw new \RuntimeException('Token replay record could not be persisted.');
            }

            return [
                'token' => (string) $created['token'],
                'record' => $record,
                'replayed' => false,
            ];
        } catch (Throwable $exception) {
            $recordId = (int) data_get($created, 'record.id', 0);
            if ($recordId > 0) {
                try {
                    $this->tokenService->revokeToken($recordId);
                } catch (Throwable) {
                    // Preserve the original exception; the orphan is visible to the super-admin token list.
                }
            }
            Cache::forget($cacheKey);

            throw $exception;
        }
    }

    /**
     * @return array{token:string,record:array<string,mixed>,replayed:bool}
     */
    private function replay(string $cacheKey, string $fingerprint): array
    {
        $existing = Cache::get($cacheKey);
        if (! is_array($existing) || ($existing['request_hash'] ?? null) !== $fingerprint) {
            throw new ApiException('idempotency_conflict', '同一个幂等键对应了不同的 Token 请求内容', 409);
        }
        if (($existing['state'] ?? null) !== 'completed') {
            throw new ApiException('idempotency_in_progress', '相同幂等键的 Token 请求正在处理中', 409);
        }

        $record = is_array($existing['record'] ?? null) ? $existing['record'] : [];
        $recordId = (int) ($record['id'] ?? 0);
        $encryptedToken = $existing['token'] ?? null;
        if ($recordId <= 0 || ! is_string($encryptedToken) || $encryptedToken === '') {
            Cache::forget($cacheKey);

            throw new ApiException('idempotency_replay_unavailable', 'Token 明文重放记录不可用，请使用新的幂等键', 409);
        }
        if (! PersonalAccessToken::query()->whereKey($recordId)->exists()) {
            Cache::forget($cacheKey);

            throw new ApiException('token_already_revoked', 'Token 已被撤销，请使用新的幂等键', 409);
        }

        try {
            $plainToken = Crypt::decryptString($encryptedToken);
        } catch (Throwable $exception) {
            Cache::forget($cacheKey);
            try {
                $this->tokenService->revokeToken($recordId);
            } catch (Throwable) {
                // Do not replace the deterministic replay error with cleanup failure.
            }

            throw new ApiException('idempotency_replay_unavailable', 'Token 明文重放记录不可用，请使用新的幂等键', 409, [
                'exception' => $exception::class,
            ]);
        }

        return [
            'token' => $plainToken,
            'record' => $record,
            'replayed' => true,
        ];
    }
}
