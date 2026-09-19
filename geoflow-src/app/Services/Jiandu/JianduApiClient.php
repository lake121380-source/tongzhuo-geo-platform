<?php

namespace App\Services\Jiandu;

use App\Services\Outbound\SafeOutboundHttpClient;
use App\Services\Outbound\SafeOutboundRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;

/**
 * 见度GEO 开放 API 客户端（桐灼GEO 后端 → 见度系统）。
 *
 * 契约对齐见度仓库 `docs/API.md`「账号密码换服务端会话」一节：
 *  · `POST /api/v1/auth/token`       账号密码换 `api_usr_…` 会话（可能需要验证码挑战）
 *  · `POST /api/v1/auth/refresh`     refresh 轮换（旧对立即作废）
 *  · `POST /api/v1/auth/logout`      吊销
 *  · 数据接口一律 `Authorization: Bearer api_usr_…`（见度侧白名单 + 套餐门禁）
 *
 * 出站一律经 {@see SafeOutboundHttpClient}（SSRF 防线），URL 只由本系统配置给出、
 * 不含任何用户输入拼接。**字段映射在见度侧是 camelCase**（`verifyCode`、
 * `refreshToken`、`expiresAt`），本系统后端对外是 snake_case——映射集中在这里，
 * 别让两种风格漏到上层。
 *
 * 返回约定：2xx → 解析后的响应体数组；非 2xx → 抛 {@see JianduApiException}
 * （携带上游状态码与错误体，由上层翻译）。`requiresVerification` 是**200**，
 * 属于正常返回，不是异常。
 */
final class JianduApiClient
{
    public function __construct(
        private readonly SafeOutboundHttpClient $safeHttp,
    ) {}

    /**
     * 换取服务端会话。
     *
     * @return array<string, mixed> 成功:
     *   `{token, refreshToken, expiresAt, refreshExpiresAt, user}`；
     *   需要新设备验证时: `{requiresVerification: true, channel, message}`
     */
    public function createSession(string $account, string $password, ?string $verifyCode = null): array
    {
        $payload = ['account' => $account, 'password' => $password];
        if (is_string($verifyCode) && $verifyCode !== '') {
            $payload['verifyCode'] = $verifyCode;
        }

        return $this->result($this->json()->post($this->url('/api/v1/auth/token'), $payload), '连接见度系统');
    }

    /**
     * 轮换会话。成功返回新的一对 token（旧对即刻失效）。
     *
     * @return array<string, mixed> `{token, refreshToken, expiresAt, refreshExpiresAt}`
     */
    public function refreshSession(string $refreshToken): array
    {
        return $this->result($this->json()->post($this->url('/api/v1/auth/refresh'), ['refreshToken' => $refreshToken]), '刷新见度会话');
    }

    /** 吊销会话（尽力而为：断开连接时调用，失败不阻断本地吊销）。 */
    public function revokeSession(?string $accessToken, ?string $refreshToken): void
    {
        $payload = [];
        if (is_string($refreshToken) && $refreshToken !== '') {
            $payload['refreshToken'] = $refreshToken;
        }
        if ($payload === [] && (! is_string($accessToken) || $accessToken === '')) {
            return;
        }

        $request = $this->json();
        if (is_string($accessToken) && $accessToken !== '') {
            $request = $request->withHeaders(['Authorization' => 'Bearer '.$accessToken]);
        }

        $this->result($request->post($this->url('/api/v1/auth/logout'), $payload), '断开见度连接');
    }

    /**
     * 触发新设备验证码（见度侧 60 秒冷却、按账号+IP 限流）。
     *
     * @param  'sms'|'email'  $channel
     * @return array<string, mixed> `{ok:true, message}`（无论账号是否存在响应一致）
     */
    public function sendLoginCode(string $channel, string $account): array
    {
        $path = $channel === 'sms' ? '/api/v1/auth/sms/send-code' : '/api/v1/auth/email/send-code';
        $identifier = $channel === 'sms' ? ['phone' => $account] : ['email' => $account];

        return $this->result($this->json()->post($this->url($path), $identifier + ['purpose' => 'login']), '发送验证码');
    }

    /**
     * 当前账号/组织/额度（见度 `/api/v1/me`）。
     *
     * @return array<string, mixed>
     */
    public function fetchMe(string $accessToken): array
    {
        return $this->result($this->authorized($accessToken)->get($this->url('/api/v1/me')), '读取见度账号信息');
    }

    /**
     * 项目列表（见度侧返回**裸数组**，无 items 包装）。
     *
     * @return list<array<string, mixed>>
     */
    public function fetchProjects(string $accessToken): array
    {
        $body = $this->result($this->authorized($accessToken)->get($this->url('/api/v1/projects')), '读取见度项目列表');

        return array_values(array_filter($body, 'is_array'));
    }

    /**
     * 概览指标（见度 `/api/v1/dashboard/overview`，projectId 必填）。
     *
     * @return array<string, mixed>
     */
    public function fetchOverview(string $accessToken, string $projectId, string $range = '30d'): array
    {
        return $this->result(
            $this->authorized($accessToken)->get($this->url('/api/v1/dashboard/overview'), [
                'projectId' => $projectId,
                'range' => $range,
            ]),
            '读取见度概览',
        );
    }

    /**
     * 检测批次列表（见度 `/api/v1/detections`，projectId 必填）。
     *
     * @return array<string, mixed> `{items, total, page, pageSize}`
     */
    public function fetchDetections(string $accessToken, string $projectId, int $page = 1, int $pageSize = 20): array
    {
        return $this->result(
            $this->authorized($accessToken)->get($this->url('/api/v1/detections'), [
                'projectId' => $projectId,
                'page' => $page,
                'pageSize' => $pageSize,
            ]),
            '读取见度检测批次',
        );
    }

    /**
     * 检测报告列表（见度 `/api/v1/reports`，projectId 必填、分页）。
     *
     * 注意：见度侧「报告」有**套餐特性门禁**（`reportsEnabled`）——套餐不含时
     * 该接口回 403 `feature_not_in_plan`。这是正常的能力边界：调用方要把它
     * 呈现为「该套餐不含报告」，而不是把页面打成故障。
     *
     * @return array<string, mixed> `{items, total, page, pageSize}`
     */
    public function fetchReports(string $accessToken, string $projectId, int $page = 1, int $pageSize = 10): array
    {
        return $this->result(
            $this->authorized($accessToken)->get($this->url('/api/v1/reports'), [
                'projectId' => $projectId,
                'page' => $page,
                'pageSize' => $pageSize,
            ]),
            '读取见度报告列表',
        );
    }

    private function url(string $path): string
    {
        return (string) config('jiandu.base_url').$path;
    }

    private function json(): SafeOutboundRequest
    {
        $request = Http::acceptJson()
            ->asJson()
            ->timeout((int) config('jiandu.timeout_seconds'))
            ->connectTimeout((int) config('jiandu.connect_timeout_seconds'))
            ->retry(
                max(1, (int) config('jiandu.retry_attempts')),
                max(0, (int) config('jiandu.retry_sleep_ms')),
                throw: false,
            );

        return new SafeOutboundRequest(
            $this->safeHttp,
            $request,
            (int) config('jiandu.max_response_bytes'),
        );
    }

    private function authorized(string $accessToken): SafeOutboundRequest
    {
        return $this->json()->withHeaders(['Authorization' => 'Bearer '.$accessToken]);
    }

    /**
     * 把响应归一成「成功返回体 / 失败抛异常」。
     *
     * @return array<string, mixed>
     */
    private function result(Response $response, string $what): array
    {
        $payload = $response->json();
        $payload = is_array($payload) ? $payload : [];

        if ($response->successful()) {
            return $payload;
        }

        $message = is_string($payload['error'] ?? null) && $payload['error'] !== ''
            ? (string) $payload['error']
            : $what.'失败（见度返回 '.$response->status().'）';

        throw new JianduApiException($message, $response->status(), $payload);
    }
}
