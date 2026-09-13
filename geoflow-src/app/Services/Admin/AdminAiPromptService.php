<?php

namespace App\Services\Admin;

use App\Http\Controllers\Admin\AiPromptController;
use App\Http\Controllers\Api\V1\AiConfigurationController;
use App\Models\Prompt;

/**
 * 提示词的复制。
 *
 * 旧 Blade 后台（{@see AiPromptController::copy}）与 api/v1
 * （{@see AiConfigurationController::copyPrompt}）共用这一份实现。
 *
 * 复制是**改系统内置提示词的唯一途径**：内置提示词带 `system_key`，不能在原处改，
 * 只能复制成一条可编辑的副本。所以两件事必须固定下来，不能各写一遍：
 * ① 只允许复制 content / quality_check——这两类才有「副本」的意义；
 * ② 副本必须清掉 `system_key` / `system_version`，否则它会继续被当成系统托管条目，
 *    既改不动、又可能被同步逻辑覆盖。
 */
final class AdminAiPromptService
{
    /** @var list<string> */
    public const COPYABLE_TYPES = ['content', 'quality_check'];

    public const COPY_NAME_SUFFIX = '（副本）';

    public function copy(Prompt $source): Prompt
    {
        return Prompt::query()->create([
            'name' => mb_substr((string) $source->name.self::COPY_NAME_SUFFIX, 0, 100, 'UTF-8'),
            'type' => (string) $source->type,
            'content' => (string) $source->content,
            'variables' => (string) ($source->variables ?? ''),
            'system_key' => null,
            'system_version' => null,
        ]);
    }
}
