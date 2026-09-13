<?php

namespace App\Services\GeoFlow;

use App\Exceptions\AiModelAccessException;
use App\Exceptions\AiModelRuntimeEligibilityException;
use App\Http\Controllers\Admin\ArticleEditorAssistantController;
use App\Http\Controllers\Api\V1\ArticleEditorAssistantApiController;
use App\Models\Admin;
use App\Models\KnowledgeBase;
use App\Models\Prompt;
use App\Models\Title;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use RuntimeException;
use Tests\Unit\AdminAiDirectEntryAccessArchitectureTest;
use Throwable;

/**
 * 文章编辑器助手的共享实现。
 *
 * 旧 Blade 后台（{@see ArticleEditorAssistantController}）
 * 与 api/v1（{@see ArticleEditorAssistantApiController}）
 * 都是这个服务的薄适配器：模型访问边界、配额、知识库证据门禁、提示词渲染与惰性流消费
 * 只有这一份实现，两个入口只负责把结果翻译成各自的线上格式。
 *
 * 顺序不能改：**必须在持有调用锁时消费惰性流**，且每一步都重新校验模型仍然可用
 * （{@see AdminAiDirectEntryAccessArchitectureTest} 会检查这里的次序）。
 */
final class ArticleEditorAssistantService
{
    /** prepare() 在知识库检索为空时抛出的稳定标识，供各入口翻译成自己的文案。 */
    public const KNOWLEDGE_UNAVAILABLE = 'article_editor_knowledge_unavailable';

    public const EVENT_DELTA = 'delta';

    public const EVENT_REPLACEMENT = 'replacement';

    public const EVENT_ERROR = 'error';

    public const EVENT_DONE = 'done';

    public function __construct(
        private readonly ArticleContentPromptRenderer $promptRenderer,
        private readonly ArticleContentGenerationService $generationService,
        private readonly KnowledgeRetrievalService $knowledgeRetrievalService,
        private readonly ArticleCitationMarkerCleaner $citationMarkerCleaner,
        private readonly DirectAdminAiExecutionGuard $executionGuard,
        private readonly DirectAdminAiModelInvocationGateway $invocationGateway,
    ) {}

    /**
     * 标题库候选标题查询（编辑器「换一个推荐标题」用）。
     *
     * @param  array{library_id?:int|null,search?:string|null,usage?:string|null,page?:int|null}  $filters
     * @return array{items:list<array<string,mixed>>,pagination:array{page:int,last_page:int,total:int}}
     */
    public function titles(array $filters): array
    {
        $search = trim((string) ($filters['search'] ?? ''));
        $usage = (string) ($filters['usage'] ?? 'unused');

        $titles = Title::query()
            ->select(['id', 'library_id', 'title', 'keyword', 'is_ai_generated', 'used_count', 'usage_count'])
            ->with('library:id,name')
            ->when(isset($filters['library_id']), fn (Builder $query): Builder => $query->where('library_id', (int) $filters['library_id']))
            ->when($usage === 'unused', fn (Builder $query): Builder => $query->where(function (Builder $query): void {
                $query->whereNull('used_count')->orWhere('used_count', '<=', 0);
            }))
            ->when($usage === 'used', fn (Builder $query): Builder => $query->where('used_count', '>', 0))
            ->when($search !== '', fn (Builder $query): Builder => $query->where(function (Builder $query) use ($search): void {
                $query
                    ->whereLike('title', '%'.$search.'%')
                    ->orWhereLike('keyword', '%'.$search.'%')
                    ->orWhereHas('library', fn (Builder $libraryQuery): Builder => $libraryQuery->whereLike('name', '%'.$search.'%'));
            }))
            ->orderByRaw('COALESCE(used_count, 0) ASC')
            ->orderByDesc('id')
            ->paginate(20)
            ->withQueryString();

        return [
            'items' => collect($titles->items())->map(static fn (Title $title): array => [
                'id' => (int) $title->id,
                'title' => (string) $title->title,
                'keyword' => (string) ($title->keyword ?? ''),
                'library_id' => (int) $title->library_id,
                'library_name' => (string) ($title->library?->name ?? ''),
                'is_ai_generated' => (bool) $title->is_ai_generated,
                'used_count' => (int) ($title->used_count ?? 0),
            ])->values()->all(),
            'pagination' => [
                'page' => $titles->currentPage(),
                'last_page' => $titles->lastPage(),
                'total' => $titles->total(),
            ],
        ];
    }

    /**
     * 冻结模型访问边界、解析知识库证据并渲染提示词。
     *
     * 失败时抛出领域异常，由各入口翻译成自己的错误格式（旧后台是裸 JSON，
     * api/v1 是统一信封）——这里不吞异常，也不返回「半个计划」。
     *
     * @throws AiModelAccessException
     * @throws AiModelRuntimeEligibilityException
     * @throws RuntimeException
     */
    public function prepare(
        Admin $admin,
        string $title,
        string $keyword,
        int $knowledgeBaseId,
        int $promptId,
        ?int $aiModelId,
    ): ArticleEditorGenerationPlan {
        $knowledgeBase = KnowledgeBase::query()->whereKey($knowledgeBaseId)->firstOrFail(['id']);
        $prompt = Prompt::query()->whereKey($promptId)->where('type', 'content')->firstOrFail();

        $executionContext = $this->executionGuard->freeze(
            $admin,
            'article_editor',
            (int) $knowledgeBase->id,
            requestedModelId: $aiModelId,
        );
        $selection = $this->executionGuard->resolveModel($executionContext);
        $aiModel = $selection['model'];

        $knowledgeContext = $this->knowledgeRetrievalService->retrieveContext(
            (int) $knowledgeBase->id,
            implode("\n", array_filter([trim($title), trim($keyword)])),
            5,
            3200,
            $admin,
            $executionContext->requestId,
        );
        if ($knowledgeContext === '') {
            throw new RuntimeException(self::KNOWLEDGE_UNAVAILABLE);
        }

        return new ArticleEditorGenerationPlan(
            admin: $admin,
            resolvedModel: $aiModel,
            knowledgeBase: $knowledgeBase,
            prompt: $prompt,
            title: trim($title),
            keyword: trim($keyword),
            contentPrompt: $this->promptRenderer->renderForEditor(
                trim($title),
                trim($keyword),
                (string) $prompt->content,
                $knowledgeContext,
            ),
            executionContext: $executionContext,
        );
    }

    /**
     * 在调用锁内消费惰性流。
     *
     * 每一步都重新执行 assertModelCurrent：模型可能在流式过程中被停用或改权限，
     * 一旦失效必须立刻停止出站并作废这次调用（而不是把旧模型的结果交付出去）。
     *
     * @return \Generator<int, array{event:string,data:array<string,mixed>}, mixed, void>
     */
    public function stream(ArticleEditorGenerationPlan $plan): \Generator
    {
        $aiModel = $plan->resolvedModel;
        $executionContext = $plan->executionContext;
        $knowledgeBase = $plan->knowledgeBase;

        $invocation = null;
        $streamSession = null;
        $stream = null;
        $providerReturned = false;

        try {
            $invocation = $this->invocationGateway->acquire(
                $executionContext,
                $this->generationService->providerTimeoutSeconds() + 60,
            );
            $aiModel = $invocation->model;
            $streamSession = $this->generationService->deferredStreamWithReservation(
                $aiModel,
                $plan->contentPrompt,
                $invocation->reservation,
                fn () => $invocation->beginUsageAttempt(
                    requestPayload: $plan->contentPrompt,
                    operation: 'article_editor.generate',
                    businessSource: 'article_editor',
                    sourceType: KnowledgeBase::class,
                    sourceId: (int) $knowledgeBase->id,
                ),
            );
            $stream = $streamSession->stream;
            foreach ($stream as $event) {
                $this->executionGuard->assertModelCurrent($executionContext, $aiModel);
                yield $this->event(self::EVENT_DELTA, ['content' => (string) $event]);
            }
            $providerReturned = true;

            $this->executionGuard->assertModelCurrent($executionContext, $aiModel);
            $content = $this->citationMarkerCleaner->cleanContent((string) $stream->text);
            $this->executionGuard->assertModelCurrent($executionContext, $aiModel);
            yield $this->event(self::EVENT_REPLACEMENT, ['content' => $content]);

            if ($content !== '') {
                DB::transaction(function () use ($executionContext, $aiModel, $knowledgeBase, $streamSession): void {
                    $this->executionGuard->assertModelCurrent($executionContext, $aiModel);
                    KnowledgeBase::query()->whereKey((int) $knowledgeBase->id)->increment('usage_count');
                    $this->executionGuard->assertModelCurrent($executionContext, $aiModel);
                    $streamSession->complete();
                    $this->executionGuard->assertModelCurrent($executionContext, $aiModel);
                });
            }
            $this->executionGuard->assertModelCurrent($executionContext, $aiModel);
            $invocation->recordDelivered($stream->usage ?? null);
            yield $this->event(self::EVENT_DONE, []);
        } catch (AiModelAccessException $exception) {
            $invocation?->recordRevoked($exception->getErrorCode(), $stream?->usage ?? null);
            yield $this->errorEvent($exception->getErrorCode());
        } catch (Throwable) {
            if ($providerReturned) {
                $invocation?->recordDiscarded('ai_result_persistence_failed', $stream?->usage ?? null);
            } else {
                $invocation?->recordProviderFailure();
            }
            Log::warning('Article assistant stream stopped safely.', [
                'execution' => $executionContext->toSafeArray(),
                'ai_model_id' => (int) $aiModel->id,
            ]);
            yield $this->errorEvent('ai_model_unavailable');
        } finally {
            $streamSession?->abort();
            $invocation?->close();
        }
    }

    /** @return array{event:string,data:array<string,mixed>} */
    private function event(string $name, array $data): array
    {
        return ['event' => $name, 'data' => $data];
    }

    /** @return array{event:string,data:array<string,mixed>} */
    private function errorEvent(string $errorCode): array
    {
        return $this->event(self::EVENT_ERROR, ['error_code' => $errorCode]);
    }
}
