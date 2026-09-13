<?php

namespace App\Services\Admin;

use App\Http\Controllers\Admin\AiSpecialPromptController;
use App\Http\Controllers\Api\V1\AiSpecialPromptApiController;
use App\Models\Prompt;
use Illuminate\Support\Facades\DB;
use InvalidArgumentException;

/**
 * 特殊提示词（keyword / description）。
 *
 * 旧 Blade 后台（{@see AiSpecialPromptController}）与
 * api/v1（{@see AiSpecialPromptApiController}）共用这一份实现。
 *
 * 这两类提示词**被生成流水线真实消费**：关键词提示词决定 AI 生成标题关键词的口径，
 * 描述提示词决定文章描述的风格（`UrlImportProcessingService` 会把它们拼进生成 prompt）。
 *
 * 它们的保存语义与通用 `prompts` CRUD **不同**：按类型整体覆盖，而不是改某一条。
 * 历史上同一类型可能有多条重复记录，只改一条会让不同批次用上不同口径——所以
 * 「读最新一条、写全部同类型记录」这两件事必须成对出现，不能拆到两个入口各写一遍。
 */
final class AdminAiSpecialPromptService
{
    public const TYPE_KEYWORD = 'keyword';

    public const TYPE_DESCRIPTION = 'description';

    /** 通用 `prompts` 端点管的是 content / quality_check，这两类只走本服务。 */
    public const TYPES = [self::TYPE_KEYWORD, self::TYPE_DESCRIPTION];

    /** 与通用 prompts 端点同一个上限（`AiConfigurationController::validatePromptPayload`）。 */
    public const MAX_CONTENT_CHARACTERS = 200_000;

    public function supports(string $type): bool
    {
        return in_array($type, self::TYPES, true);
    }

    /**
     * 该类型当前的生效内容——取最新更新的一条；没有配置过时返回空串。
     *
     * 空串表示「没配过」，调用方据此决定是否回落到内置默认提示词，
     * 不要在这里替运营方编一段默认文案。
     */
    public function content(string $type): string
    {
        $this->assertSupported($type);

        return (string) (Prompt::query()
            ->where('type', $type)
            ->orderByDesc('updated_at')
            ->orderByDesc('id')
            ->value('content') ?? '');
    }

    /**
     * 保存该类型的内容：已有同类型记录就全部覆盖，否则建一条。
     *
     * 覆盖全部而不是新增一条，是为了让「最新一条」与「全部记录」始终一致——
     * 分叉的历史记录正是这套页面当初要解决的问题。
     */
    public function upsert(string $type, string $content): void
    {
        $this->assertSupported($type);
        $content = trim($content);

        DB::transaction(function () use ($type, $content): void {
            $updated = Prompt::query()
                ->where('type', $type)
                ->update(['content' => $content, 'updated_at' => now()]);

            if ($updated > 0) {
                return;
            }

            Prompt::query()->create([
                'name' => self::fallbackName($type),
                'type' => $type,
                'content' => $content,
                'variables' => '',
            ]);
        }, 3);
    }

    public static function fallbackName(string $type): string
    {
        return match ($type) {
            self::TYPE_KEYWORD => '关键词生成提示词',
            self::TYPE_DESCRIPTION => '文章描述生成提示词',
            default => throw new InvalidArgumentException('unsupported_special_prompt_type'),
        };
    }

    private function assertSupported(string $type): void
    {
        if (! $this->supports($type)) {
            throw new InvalidArgumentException('unsupported_special_prompt_type');
        }
    }
}
