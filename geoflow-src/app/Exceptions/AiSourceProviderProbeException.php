<?php

namespace App\Exceptions;

use RuntimeException;
use Throwable;

/**
 * 来源 Provider / 可见度模型探活失败。
 *
 * 与质检、标题生成那些异常同理：探活会把额度记账、身份重校验、就绪度落库
 * 串在一起，失败原因必须是一个**有限集合**里的码，不能把底层异常消息
 * （可能带 URL 或密钥片段）直接当对外文案。
 */
final class AiSourceProviderProbeException extends RuntimeException
{
    /** 预留都拿不到：Provider 未就绪、绑定模型不可用等，统一对外说「模型不可用」。 */
    public const UNAVAILABLE = 'ai_model_unavailable';

    private function __construct(
        public readonly string $errorCode,
        ?Throwable $previous = null,
    ) {
        parent::__construct($errorCode, 0, $previous);
    }

    public static function unavailable(?Throwable $previous = null): self
    {
        return new self(self::UNAVAILABLE, $previous);
    }
}
