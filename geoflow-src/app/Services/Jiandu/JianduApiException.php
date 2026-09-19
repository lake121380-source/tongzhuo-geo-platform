<?php

namespace App\Services\Jiandu;

use RuntimeException;

/**
 * 调用见度GEO 开放 API 时的失败。区分两类：
 *
 *  · **上游业务失败**（4xx/5xx）：`upstreamStatus` 是见度侧的真实状态码，
 *    `payload` 是见度返回的错误体（它的 `code` 字段用于分支，如
 *    `api_not_in_plan`）——由上层翻译成本系统语义，**不要把上游原始错误
 *    直接透给前端**（可能带内部字段）。
 *  · **网络层失败**：`upstreamStatus = 0`（连不上、超时、响应不是 JSON）。
 */
final class JianduApiException extends RuntimeException
{
    /** @param array<string, mixed> $payload */
    public function __construct(
        string $message,
        public readonly int $upstreamStatus = 0,
        public readonly array $payload = [],
    ) {
        parent::__construct($message);
    }
}
