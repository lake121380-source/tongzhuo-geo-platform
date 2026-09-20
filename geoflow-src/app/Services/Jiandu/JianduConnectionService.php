<?php

namespace App\Services\Jiandu;

use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Models\JianduConnection;
use App\Support\GeoFlow\ApiKeyCrypto;
use Illuminate\Support\Carbon;

/**
 * 见度GEO 连接的生命周期：换取、加密保存、自动刷新、断开。
 *
 * 全局单连接（一企业一部署）：新连接生效时旧连接一律吊销——在见度侧尽力
 * `logout`（别让旧会话在被替换后还活着 30 天），在本地标 `revoked`。
 *
 * **错误语义在本类收口**：上游（见度）的失败一律翻译成 {@see ApiException}，
 * 且**绝不把见度的 401 原样透传**——本系统前端的 401 语义是「桐灼GEO 会话失效」，
 * 会清 token 把用户踢回登录页；见度的密码错误必须是 422。
 */
final class JianduConnectionService
{
    public function __construct(
        private readonly JianduApiClient $client,
        private readonly ApiKeyCrypto $crypto,
    ) {}

    /** 当前生效的连接；没有则 null。 */
    public function current(): ?JianduConnection
    {
        return JianduConnection::query()
            ->where('status', JianduConnection::STATUS_ACTIVE)
            ->orderByDesc('id')
            ->first();
    }

    /** @return array<string, mixed>|null 给前端的连接投影（无 token） */
    public function status(): ?array
    {
        return $this->current()?->projection();
    }

    /**
     * 用账号密码换取连接。三种正常结果：
     *  · 成功 → `{status:'connected', connection:{…}}`
     *  · 需要新设备验证码 → `{status:'verification_required', channel, message}`
     *  · 失败 → 抛 {@see ApiException}（已翻译）
     *
     * @return array<string, mixed>
     */
    public function connect(Admin $admin, string $account, string $password, ?string $verifyCode = null): array
    {
        $session = $this->guard(fn () => $this->client->createSession($account, $password, $verifyCode), 'auth');

        if (($session['requiresVerification'] ?? false) === true) {
            $channel = $session['channel'] ?? '';
            return [
                'status' => 'verification_required',
                'channel' => in_array($channel, ['sms', 'email'], true) ? $channel : 'email',
                'message' => is_string($session['message'] ?? null) && $session['message'] !== ''
                    ? $session['message']
                    : '这是一台新设备，请输入验证码',
            ];
        }

        [$token, $refreshToken, $expiresAt, $refreshExpiresAt] = $this->tokensFrom($session);
        $user = is_array($session['user'] ?? null) ? $session['user'] : [];

        $this->revokePrevious();

        $connection = JianduConnection::query()->create([
            'account' => $account,
            'organization_name' => (string) ($user['organizationName'] ?? ''),
            'user_name' => (string) ($user['name'] ?? ''),
            'access_token_ciphertext' => $this->crypto->encrypt($token),
            'refresh_token_ciphertext' => $this->crypto->encrypt($refreshToken),
            'access_expires_at' => $this->parseTime($expiresAt),
            'refresh_expires_at' => $this->parseTime($refreshExpiresAt),
            'status' => JianduConnection::STATUS_ACTIVE,
            'connected_by_admin_id' => $admin->id,
        ]);

        return ['status' => 'connected', 'connection' => $connection->projection()];
    }

    /**
     * 触发新设备验证码（转发到见度对应的发码端点）。
     *
     * @param  'sms'|'email'  $channel
     * @return array<string, mixed>
     */
    public function sendCode(string $channel, string $account): array
    {
        return $this->guard(fn () => $this->client->sendLoginCode($channel, $account), 'auth');
    }

    /** 断开连接：见度侧尽力吊销，本地必标 revoked（见度连不上也要能断开）。 */
    public function disconnect(): void
    {
        $connection = $this->current();
        if (! $connection instanceof JianduConnection) {
            return;
        }

        try {
            $this->client->revokeSession($this->decryptAccess($connection), $this->decryptRefresh($connection));
        } catch (\Throwable) {
            // 尽力而为：见度不可达不阻断本地断开，否则用户被困在坏连接上。
        }

        $connection->update(['status' => JianduConnection::STATUS_REVOKED]);
    }

    /**
     * 用当前连接执行一次数据调用，token 临近过期时**先自动刷新**。
     *
     * 401 会做一次「强制刷新 + 重试」：覆盖 access 在两次请求之间过期的窗口
     * （时钟小偏差、或刷新调用与使用并发）。重试仍 401 → 翻译报错。
     *
     * @template T
     * @param  callable(string): T  $use
     * @return T
     */
    public function withFreshToken(callable $use): mixed
    {
        $connection = $this->current();
        if (! $connection instanceof JianduConnection) {
            throw new ApiException('jiandu_not_connected', '尚未连接见度系统，请先输入见度账号密码完成连接', 409);
        }

        $skew = max(60, (int) config('jiandu.refresh_skew_seconds'));
        $expiresAt = $connection->access_expires_at;
        if ($expiresAt !== null && $expiresAt->getTimestamp() - $skew <= now()->getTimestamp()) {
            $connection = $this->refresh($connection);
        }

        try {
            return $use($this->decryptAccess($connection));
        } catch (JianduApiException $exception) {
            if ($exception->upstreamStatus !== 401) {
                $this->translate($exception);
            }
            $connection = $this->refresh($connection);
            try {
                return $use($this->decryptAccess($connection));
            } catch (JianduApiException $retry) {
                $this->translate($retry);
                throw $retry; // 不可达：translate 总是抛
            }
        }
    }

    /** 轮换会话并把新的一对写回（密文）。refresh 被吊销 → 连接判死、引导重连。 */
    private function refresh(JianduConnection $connection): JianduConnection
    {
        try {
            $session = $this->client->refreshSession($this->decryptRefresh($connection));
        } catch (JianduApiException $exception) {
            // refresh 都失效了 = 这个连接彻底死了（改过密码、在见度侧退出、
            // 管理员吊销）。标记 expired，前端据此引导「重新连接」。
            if (in_array($exception->upstreamStatus, [401, 403], true)) {
                $connection->update(['status' => JianduConnection::STATUS_EXPIRED]);
                throw new ApiException('jiandu_reconnect_required', '见度连接已失效（可能是改了密码或在见度侧退出了登录），请重新输入账号密码连接', 409);
            }
            $this->translate($exception, 'auth');
            throw $exception; // 不可达
        }

        [$token, $refreshToken, $expiresAt, $refreshExpiresAt] = $this->tokensFrom($session);

        $connection->update([
            'access_token_ciphertext' => $this->crypto->encrypt($token),
            'refresh_token_ciphertext' => $this->crypto->encrypt($refreshToken),
            'access_expires_at' => $this->parseTime($expiresAt),
            'refresh_expires_at' => $this->parseTime($refreshExpiresAt),
            'last_refreshed_at' => now(),
            'status' => JianduConnection::STATUS_ACTIVE,
        ]);

        return $connection->refresh();
    }

    /**
     * 替换连接时吊销旧的：见度侧尽力 logout——旧会话不被吊销的话，它还可以
     * 在被替换后继续用 30 天，这是不必要的暴露面。
     */
    private function revokePrevious(): void
    {
        $previous = $this->current();
        if (! $previous instanceof JianduConnection) {
            return;
        }

        try {
            $this->client->revokeSession($this->decryptAccess($previous), $this->decryptRefresh($previous));
        } catch (\Throwable) {
            // 尽力而为。
        }

        $previous->update(['status' => JianduConnection::STATUS_REVOKED]);
    }

    /**
     * 执行一次上游调用，把 {@see JianduApiException} 翻译成 {@see ApiException}。
     *
     * `$context` 用来区分**同一状态码在不同语境下的不同含义**——目前只有 404 需要：
     * 换取会话时 404 = 见度还没有这个接口（版本过旧/未部署）；数据接口 404 = 资源不存在
     * （通常是 projectId 之类的参数指错了）。**两者给用户的下一步完全不同**，
     * 笼统翻成一句「见度系统拒绝了这次请求」会把人带偏——2026-09-19 我就被带偏过一次，
     * 一度以为是权限问题。
     *
     * @template T
     * @param  callable(): T  $call
     * @param  'auth'|'data'  $context  换取/刷新会话传 'auth'，其余默认 'data'
     * @return T
     */
    private function guard(callable $call, string $context = 'data'): mixed
    {
        try {
            return $call();
        } catch (JianduApiException $exception) {
            $this->translate($exception, $context);
            throw $exception; // 不可达
        }
    }

    /** 上游失败 → 本系统语义。**401 绝不原样透传**（会误伤本系统登录态）。 */
    private function translate(JianduApiException $exception, string $context = 'data'): never
    {
        $status = $exception->upstreamStatus;

        if ($status === 0 || $status >= 500) {
            throw new ApiException('jiandu_upstream_unavailable', '暂时无法连接见度系统，请稍后重试', 502);
        }

        if ($status === 401) {
            throw new ApiException('jiandu_credentials_invalid', '见度账号或密码错误', 422);
        }

        if ($status === 429) {
            throw new ApiException('jiandu_rate_limited', '与见度系统的交互太频繁，请稍后再试', 429);
        }

        $upstreamCode = is_string($exception->payload['code'] ?? null) ? $exception->payload['code'] : '';
        if ($status === 403 && $upstreamCode === 'api_not_in_plan') {
            throw new ApiException('jiandu_plan_required', '该见度账号的套餐不包含开放 API（专业版能力），请先在见度系统升级套餐', 403);
        }
        if ($status === 403 && $upstreamCode === 'organization_inactive') {
            throw new ApiException('jiandu_organization_inactive', '该见度账号所属企业已被冻结或停用', 403);
        }
        if ($status === 403 && $upstreamCode === 'api_path_not_allowed') {
            // 拿到这个说明两边的接口契约漂移了——不是用户的问题，如实报 502 类错误。
            throw new ApiException('jiandu_contract_mismatch', '见度系统拒绝了该数据接口的调用（契约不匹配），请联系管理员', 502);
        }
        if ($status === 403 && $upstreamCode === 'feature_not_in_plan') {
            // 见度侧**特性级**套餐门禁（报告/导出/证据包等）。见度返回的 error 文案
            // 已经说人话（「检测报告不在当前套餐里，升级后可用」），优先原样用它。
            $upstreamMessage = is_string($exception->payload['error'] ?? null) && $exception->payload['error'] !== ''
                ? (string) $exception->payload['error']
                : '见度账号的当前套餐不包含这个功能';
            throw new ApiException('jiandu_feature_not_in_plan', $upstreamMessage, 403, [
                'feature' => is_string($exception->payload['feature'] ?? null) ? $exception->payload['feature'] : null,
            ]);
        }

        if ($status === 409) {
            // 见度侧的**业务拒绝**：额度用尽 / 积分不足 / 同日同入口重复——上游文案
            // 已经是人话，原样透出。调用方（如每日调度）按 409 当「没跑成但非故障」。
            $message409 = is_string($exception->payload['error'] ?? null) && $exception->payload['error'] !== ''
                ? (string) $exception->payload['error']
                : '见度拒绝了这次请求（额度、积分或同日重复）';
            throw new ApiException('jiandu_quota_or_duplicate', $message409, 409);
        }

        if ($status === 404) {
            // 404 在两种语境下含义完全不同，分开说——否则用户会照着错的方向去排查。
            if ($context === 'auth') {
                // 换取/刷新会话的接口根本不存在：见度侧版本过旧或还没部署。
                // 这不是用户能修的，也不是「密码错了」，如实报上游不可用。
                throw new ApiException(
                    'jiandu_endpoint_missing',
                    '见度系统还没有提供账号会话接口（版本过旧或尚未部署该能力），请联系管理员',
                    502,
                );
            }

            throw new ApiException(
                'jiandu_resource_missing',
                '见度系统里找不到这次请求的资源——通常是项目 ID 之类的参数不对，请核对后重试',
                404,
            );
        }

        throw new ApiException(
            'jiandu_request_failed',
            '见度系统拒绝了这次请求，请稍后重试',
            $status >= 400 && $status < 500 ? 422 : 502,
        );
    }

    /**
     * @param  array<string, mixed>  $session
     * @return array{0:string, 1:string, 2:mixed, 3:mixed}
     */
    private function tokensFrom(array $session): array
    {
        $token = (string) ($session['token'] ?? '');
        $refreshToken = (string) ($session['refreshToken'] ?? '');
        if ($token === '' || $refreshToken === '') {
            throw new ApiException('jiandu_invalid_response', '见度系统返回了不完整的凭证，请稍后重试', 502);
        }

        return [$token, $refreshToken, $session['expiresAt'] ?? null, $session['refreshExpiresAt'] ?? null];
    }

    private function parseTime(mixed $value): ?Carbon
    {
        if (! is_string($value) || trim($value) === '') {
            return null;
        }

        try {
            return Carbon::parse($value);
        } catch (\Throwable) {
            return null;
        }
    }

    private function decryptAccess(JianduConnection $connection): string
    {
        return $this->crypto->decrypt((string) $connection->getAttribute('access_token_ciphertext'));
    }

    private function decryptRefresh(JianduConnection $connection): string
    {
        return $this->crypto->decrypt((string) $connection->getAttribute('refresh_token_ciphertext'));
    }
}
