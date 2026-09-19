<?php

/**
 * 「见度GEO」检测系统的接入配置（桐灼GEO 后台 → 见度开放 API）。
 *
 * 契约见见度仓库 `docs/API.md` 的「账号密码换服务端会话」一节：
 * `POST /api/v1/auth/token` 换取 `api_usr_…` 会话 → Bearer 调白名单接口 →
 * `POST /api/v1/auth/refresh` 轮换（30 天）→ `POST /api/v1/auth/logout` 吊销。
 *
 * base_url 默认指向生产站；本地联调可用 JIANDU_BASE_URL 覆盖（注意出站经过
 * SafeOutboundHttpClient，私网地址会被 SSRF 防线拦下——联调走公网域名或测试 fake）。
 */
return [
    'base_url' => rtrim((string) env('JIANDU_BASE_URL', 'https://geosensor.tongzhuo.ink'), '/'),

    'timeout_seconds' => max(5, (int) env('JIANDU_TIMEOUT_SECONDS', 15)),

    'connect_timeout_seconds' => max(1, (int) env('JIANDU_CONNECT_TIMEOUT_SECONDS', 5)),

    /**
     * 出站重试：**只对网络层失败重试一次**。登录/换取凭证这类请求带凭据，
     * 多发一次没有意义反而放大限流压力；重试主要救瞬断。
     */
    'retry_attempts' => max(1, (int) env('JIANDU_RETRY_ATTEMPTS', 2)),
    'retry_sleep_ms' => max(0, (int) env('JIANDU_RETRY_SLEEP_MS', 300)),

    'max_response_bytes' => max(64 * 1024, (int) env('JIANDU_MAX_RESPONSE_BYTES', 2 * 1024 * 1024)),

    /**
     * access token 提前多少秒刷新。留出的余量要覆盖「一次页面加载的多个请求」，
     * 否则第一个请求刷新、后续请求拿着刚过期的 token 再撞一次 401。
     */
    'refresh_skew_seconds' => max(60, (int) env('JIANDU_REFRESH_SKEW_SECONDS', 300)),
];
