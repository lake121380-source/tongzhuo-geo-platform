<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\AiModelAccessException;
use App\Exceptions\AiModelRuntimeEligibilityException;
use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Services\GeoFlow\ArticleEditorAssistantService;
use App\Services\GeoFlow\ArticleEditorGenerationPlan;
use App\Support\AdminActivityLogger;
use Generator;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\StreamedEvent;
use Illuminate\Validation\Rule;
use RuntimeException;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Throwable;

/**
 * Bearer 版的文章编辑器助手。
 *
 * 模型访问边界、配额、知识库检索、提示词渲染与惰性流消费全部由
 * {@see ArticleEditorAssistantService} 拥有——与旧 Blade 后台是同一份实现。
 * 这个控制器只把结果翻译成 api/v1 的信封与 SSE 事件（`delta` / `replacement` /
 * `error` / `done`，与 AI 工作台的流式契约同名同构）。
 */
final class ArticleEditorAssistantApiController extends BaseApiController
{
    public function __construct(
        private readonly ArticleEditorAssistantService $assistant,
    ) {}

    /** 标题库候选标题（编辑器「换一个推荐标题」）。 */
    public function titles(Request $request): JsonResponse
    {
        $this->executionAdmin($request);
        $payload = $request->validate([
            'library_id' => ['nullable', 'integer', 'min:1', 'exists:title_libraries,id'],
            'search' => ['nullable', 'string', 'max:200'],
            'usage' => ['nullable', Rule::in(['unused', 'all', 'used'])],
            'page' => ['nullable', 'integer', 'min:1'],
        ]);

        return $this->success($request, $this->assistant->titles($payload));
    }

    /**
     * 编辑器内联生成：同步流式返回一段正文。
     *
     * 校验、模型边界与知识库证据都在流开始之前完成，因此这些失败仍然是普通的
     * api/v1 错误信封（带 HTTP 状态码）；只有在流已经开始之后出的问题才降级为
     * 流内的 `error` 事件。
     */
    public function generate(Request $request): StreamedResponse
    {
        $admin = $this->executionAdmin($request);
        $payload = $request->validate([
            'title' => ['required', 'string', 'max:500'],
            'keyword' => ['nullable', 'string', 'max:200'],
            'knowledge_base_id' => ['required', 'integer', 'min:1', Rule::exists('knowledge_bases', 'id')],
            'prompt_id' => [
                'required',
                'integer',
                Rule::exists('prompts', 'id')->where(fn ($query) => $query->where('type', 'content')),
            ],
            'ai_model_id' => ['nullable', 'integer', 'min:1'],
        ]);

        try {
            $plan = $this->assistant->prepare(
                $admin,
                (string) $payload['title'],
                (string) ($payload['keyword'] ?? ''),
                (int) $payload['knowledge_base_id'],
                (int) $payload['prompt_id'],
                isset($payload['ai_model_id']) ? (int) $payload['ai_model_id'] : null,
            );
        } catch (AiModelAccessException $exception) {
            throw new ApiException($exception->getErrorCode(), '没有可用的生成模型', 404);
        } catch (AiModelRuntimeEligibilityException $exception) {
            throw new ApiException(AiModelAccessException::AI_MODEL_UNAVAILABLE, $exception->getMessage(), 422);
        } catch (RuntimeException $exception) {
            if ($exception->getMessage() === ArticleEditorAssistantService::KNOWLEDGE_UNAVAILABLE) {
                throw new ApiException('knowledge_unavailable', '知识库中没有可用于生成的证据内容', 422);
            }

            throw new ApiException('article_editor_generation_failed', $exception->getMessage(), 422);
        } catch (Throwable $exception) {
            throw new ApiException('article_editor_generation_failed', '编辑器生成暂时不可用', 500, [
                'reason' => $exception->getMessage(),
            ]);
        }

        $this->audit($request, $admin, $plan);

        return response()->eventStream(
            fn (): Generator => $this->events($plan),
            [
                'Cache-Control' => 'no-cache, no-transform',
                'X-Accel-Buffering' => 'no',
            ],
            null,
        );
    }

    /** @return Generator<int, StreamedEvent, mixed, void> */
    private function events(ArticleEditorGenerationPlan $plan): Generator
    {
        foreach ($this->assistant->stream($plan) as $item) {
            yield new StreamedEvent((string) $item['event'], (array) $item['data']);
        }
    }

    private function audit(Request $request, Admin $admin, ArticleEditorGenerationPlan $plan): void
    {
        AdminActivityLogger::log($admin, 'api.article_editor.generate', [
            'request_method' => $request->method(),
            'page' => 'api/v1/articles/editor',
            'target_type' => 'knowledge_base',
            'target_id' => (int) $plan->knowledgeBase->id,
            'ip_address' => (string) ($request->ip() ?? ''),
            'details' => [
                'ai_model_id' => (int) $plan->resolvedModel->id,
                'prompt_id' => (int) $plan->prompt->id,
                'title_length' => mb_strlen($plan->title),
                'has_keyword' => $plan->keyword !== '',
            ],
        ]);
    }
}
