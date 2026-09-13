<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Services\Admin\AdminAiSpecialPromptService;
use App\Services\Api\IdempotencyService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Bearer 版的关键词 / 描述生成提示词（旧后台「特殊提示词配置」）。
 *
 * 这两类提示词被 URL 导入流水线真实消费，退役后不能只留在 Blade 页面里。
 *
 * 独立成一组端点、而不是并进通用的 `prompts` CRUD，是因为**保存语义不同**：
 * 这里按类型整体覆盖（读最新一条、写全部同类型记录），通用 CRUD 只能改某一条，
 * 会让同类型的历史重复记录分叉出不同口径。语义与旧页面完全一致，见
 * {@see AdminAiSpecialPromptService}。
 */
final class AiSpecialPromptApiController extends BaseApiController
{
    public function __construct(
        private readonly AdminAiSpecialPromptService $specialPrompts,
    ) {}

    /** 两类提示词当前生效的内容。 */
    public function index(Request $request): JsonResponse
    {
        $this->executionAdmin($request);

        return $this->success($request, [
            'prompts' => array_map(
                fn (string $type): array => $this->projection($type),
                AdminAiSpecialPromptService::TYPES,
            ),
        ]);
    }

    /** 保存某一类提示词。 */
    public function update(Request $request, string $type): JsonResponse
    {
        $this->executionAdmin($request);
        if (! $this->specialPrompts->supports($type)) {
            throw new ApiException('special_prompt_type_unknown', '不支持的特殊提示词类型', 404);
        }

        $payload = $request->validate([
            'content' => ['required', 'string', 'max:'.AdminAiSpecialPromptService::MAX_CONTENT_CHARACTERS],
        ]);

        return IdempotencyService::executeJson(
            $request,
            'POST /prompts/special/{type}',
            function () use ($request, $type, $payload): JsonResponse {
                $this->specialPrompts->upsert($type, (string) $payload['content']);

                return $this->success($request, $this->projection($type));
            },
        );
    }

    /** @return array{type:string,content:string,configured:bool} */
    private function projection(string $type): array
    {
        $content = $this->specialPrompts->content($type);

        return [
            'type' => $type,
            // 空串表示「没配过」，前端据此显示未配置，而不是显示一段空白提示词。
            'content' => $content,
            'configured' => $content !== '',
        ];
    }
}
