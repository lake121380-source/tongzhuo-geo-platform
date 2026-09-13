<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\AiModelAccessException;
use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Models\AiModel;
use App\Models\KnowledgeBase;
use App\Models\KnowledgeFact;
use App\Models\KnowledgeFactEvidence;
use App\Models\KnowledgeFactGenerationRun;
use App\Models\KnowledgeFactLibrary;
use App\Models\KnowledgeFactLibraryRevision;
use App\Models\KnowledgeFactValue;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\KnowledgeFacts\KnowledgeFactEditor;
use App\Services\GeoFlow\KnowledgeFacts\KnowledgeFactGenerationCoordinator;
use App\Services\GeoFlow\KnowledgeFacts\KnowledgeFactLibraryPresenter;
use App\Services\GeoFlow\KnowledgeFacts\KnowledgeFactPublisher;
use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\ConflictHttpException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

/**
 * JSON adapter for 桐灼GEO's reviewed atomic-fact knowledge workflow.
 *
 * The old admin controller already owns the domain rules.  This controller
 * deliberately delegates edits, evidence linking, generation and publishing
 * to those services so the React admin cannot create a second, weaker
 * implementation of the knowledge governance model.
 */
final class KnowledgeFactApiController extends BaseApiController
{
    private const MAX_PAGE_SIZE = 100;

    private const MAX_REVISION_PAGE_SIZE = 50;

    public function index(
        Request $request,
        int $knowledgeBase,
        KnowledgeFactLibraryPresenter $presenter,
    ): JsonResponse {
        $admin = $this->executionAdmin($request);
        $base = $this->findKnowledgeBase($knowledgeBase);
        $library = $base->factLibrary()->with('activeRevision')->first();

        $items = [];
        $pagination = [
            'page' => max(1, $request->integer('page', 1)),
            'per_page' => min(self::MAX_PAGE_SIZE, max(1, $request->integer('per_page', 20))),
            'total' => 0,
            'total_pages' => 0,
        ];

        if ($library instanceof KnowledgeFactLibrary) {
            $query = $library->facts()
                ->with([
                    'values' => fn ($values) => $values
                        ->with(['evidences' => fn ($evidences) => $evidences->orderByDesc('is_primary')->orderBy('id')])
                        ->withCount('evidences'),
                ])
                ->when($this->textQuery($request, 'q') !== '', function ($query) use ($request): void {
                    $search = $this->textQuery($request, 'q');
                    $query->where(fn ($nested) => $nested
                        ->where('label', 'like', '%'.$search.'%')
                        ->orWhere('subject', 'like', '%'.$search.'%')
                        ->orWhere('predicate', 'like', '%'.$search.'%'));
                })
                ->when($this->textQuery($request, 'status') === 'pending', fn ($query) => $query->where('review_status', '!=', 'reviewed'))
                ->when($this->textQuery($request, 'status') === 'reviewed', fn ($query) => $query->where('review_status', 'reviewed'))
                ->when($this->textQuery($request, 'status') === 'conflict', fn ($query) => $query->whereHas('values', fn ($values) => $values->where('conflict_status', '!=', 'clear')))
                ->orderBy('id');

            $page = $query->paginate($pagination['per_page'], ['*'], 'page', $pagination['page']);
            $items = $page->getCollection()->map(fn (KnowledgeFact $fact): array => $this->serializeFact($fact))->values()->all();
            $pagination = [
                'page' => (int) $page->currentPage(),
                'per_page' => (int) $page->perPage(),
                'total' => (int) $page->total(),
                'total_pages' => (int) $page->lastPage(),
            ];
        }

        $revisions = $library instanceof KnowledgeFactLibrary
            ? $library->revisions()->with('publisher')->limit(self::MAX_REVISION_PAGE_SIZE)->get()
                ->map(fn (KnowledgeFactLibraryRevision $revision): array => $this->serializeRevision($revision, false))->values()->all()
            : [];
        $runs = $library instanceof KnowledgeFactLibrary
            ? $library->generationRuns()->latest('id')->limit(10)->get()
                ->map(fn (KnowledgeFactGenerationRun $run): array => $this->serializeRun($run))->values()->all()
            : [];

        $summary = $library instanceof KnowledgeFactLibrary
            ? $presenter->summary($library)
            : [
                'fact_count' => 0,
                'enabled_count' => 0,
                'pending_count' => 0,
                'conflict_count' => 0,
                'active_version' => null,
                'serving_status' => 'unavailable',
                'workflow_status' => 'idle',
                'ready' => false,
            ];
        $readiness = $library instanceof KnowledgeFactLibrary
            ? $presenter->publishReadiness($library)
            : ['ready' => false, 'blockers' => ['尚未创建事实库。']];

        return $this->success($request, [
            'knowledge_base' => $this->serializeKnowledgeBase($base),
            'library' => [
                'id' => $library?->id,
                'knowledge_base_id' => $base->id,
                'summary' => $summary,
                'publish_readiness' => $readiness,
            ],
            'items' => $items,
            'pagination' => $pagination,
            'revisions' => $revisions,
            'generation_runs' => $runs,
            'can_manage_protected' => $admin->canManageProtectedWorkflows(),
        ]);
    }

    public function revision(
        Request $request,
        int $knowledgeBase,
        int $revision,
    ): JsonResponse {
        $this->executionAdmin($request);
        $base = $this->findKnowledgeBase($knowledgeBase);
        $library = $base->factLibrary()->first();
        if (! $library instanceof KnowledgeFactLibrary) {
            throw new ApiException('fact_library_not_found', '事实库不存在', 404);
        }
        $row = $library->revisions()->with('publisher')->whereKey($revision)->first();
        if (! $row instanceof KnowledgeFactLibraryRevision) {
            throw new ApiException('fact_revision_not_found', '事实版本不存在', 404);
        }

        return $this->success($request, [
            'knowledge_base' => $this->serializeKnowledgeBase($base),
            'revision' => $this->serializeRevision($row, true),
        ]);
    }

    public function store(
        Request $request,
        int $knowledgeBase,
        KnowledgeFactEditor $editor,
    ): JsonResponse {
        $admin = $this->writableAdmin($request, $knowledgeBase);
        $payload = $this->validateFactPayload($request, 'create');
        $library = $this->getOrCreateLibrary($knowledgeBase);

        return $this->mutation($request, 'POST /materials/knowledge-bases/{id}/facts', function () use ($request, $editor, $library, $payload, $admin): JsonResponse {
            $fact = $editor->createFact($library, $payload, $admin);

            return $this->success($request, ['fact' => $this->serializeFact($fact->load('values.evidences'))], 201);
        });
    }

    public function update(
        Request $request,
        int $knowledgeBase,
        int $fact,
        KnowledgeFactEditor $editor,
    ): JsonResponse {
        $admin = $this->writableAdmin($request, $knowledgeBase);
        $library = $this->getOrCreateLibrary($knowledgeBase);
        $row = $this->factInLibrary($library, $fact);
        $payload = $this->validateFactPayload($request, 'update');

        return $this->mutation($request, 'PATCH /materials/knowledge-bases/{id}/facts/{fact}', function () use ($request, $editor, $library, $row, $payload, $admin): JsonResponse {
            $updated = $editor->updateFact($library, $row, $payload, $admin);

            return $this->success($request, ['fact' => $this->serializeFact($updated->load('values.evidences'))]);
        });
    }

    public function review(
        Request $request,
        int $knowledgeBase,
        int $fact,
        KnowledgeFactEditor $editor,
    ): JsonResponse {
        $admin = $this->writableAdmin($request, $knowledgeBase);
        $library = $this->getOrCreateLibrary($knowledgeBase);
        $row = $this->factInLibrary($library, $fact);
        $payload = $request->validate([
            'lock_version' => ['required', 'integer', 'min:1'],
            'review_status' => ['required', 'in:draft,reviewed,rejected'],
        ]);

        return $this->mutation($request, 'POST /materials/knowledge-bases/{id}/facts/{fact}/review', function () use ($request, $editor, $library, $row, $payload, $admin): JsonResponse {
            $updated = $editor->updateFact($library, $row, $payload, $admin);

            return $this->success($request, ['fact' => $this->serializeFact($updated->load('values.evidences'))]);
        });
    }

    public function archive(
        Request $request,
        int $knowledgeBase,
        int $fact,
        KnowledgeFactEditor $editor,
    ): JsonResponse {
        $admin = $this->writableAdmin($request, $knowledgeBase);
        $library = $this->getOrCreateLibrary($knowledgeBase);
        $row = $this->factInLibrary($library, $fact);
        $payload = $request->validate(['lock_version' => ['required', 'integer', 'min:1']]);

        return $this->mutation($request, 'POST /materials/knowledge-bases/{id}/facts/{fact}/archive', function () use ($request, $editor, $library, $row, $payload, $admin): JsonResponse {
            $updated = $editor->updateFact($library, $row, [
                'lock_version' => $payload['lock_version'],
                'is_enabled' => false,
                'review_status' => 'rejected',
            ], $admin);

            return $this->success($request, ['fact' => $this->serializeFact($updated->load('values.evidences'))]);
        });
    }

    public function storeValue(
        Request $request,
        int $knowledgeBase,
        int $fact,
        KnowledgeFactEditor $editor,
    ): JsonResponse {
        $admin = $this->writableAdmin($request, $knowledgeBase);
        $library = $this->getOrCreateLibrary($knowledgeBase);
        $factRow = $this->factInLibrary($library, $fact);
        $payload = $this->validateValuePayload($request, false);

        return $this->mutation($request, 'POST /materials/knowledge-bases/{id}/facts/{fact}/values', function () use ($request, $editor, $library, $factRow, $payload, $admin): JsonResponse {
            $value = $editor->createValue($library, $factRow, $payload, $admin);

            return $this->success($request, ['value' => $this->serializeValue($value->load('evidences'))], 201);
        });
    }

    public function updateValue(
        Request $request,
        int $knowledgeBase,
        int $value,
        KnowledgeFactEditor $editor,
    ): JsonResponse {
        $admin = $this->writableAdmin($request, $knowledgeBase);
        $library = $this->getOrCreateLibrary($knowledgeBase);
        $row = $this->valueInLibrary($library, $value);
        $payload = $this->validateValuePayload($request, true);

        return $this->mutation($request, 'PATCH /materials/knowledge-bases/{id}/fact-values/{value}', function () use ($request, $editor, $library, $row, $payload, $admin): JsonResponse {
            $updated = $editor->updateValue($library, $row, $payload, $admin);

            return $this->success($request, ['value' => $this->serializeValue($updated->load('evidences'))]);
        });
    }

    public function archiveValue(
        Request $request,
        int $knowledgeBase,
        int $value,
        KnowledgeFactEditor $editor,
    ): JsonResponse {
        $admin = $this->writableAdmin($request, $knowledgeBase);
        $library = $this->getOrCreateLibrary($knowledgeBase);
        $row = $this->valueInLibrary($library, $value);
        $payload = $request->validate(['lock_version' => ['required', 'integer', 'min:1']]);

        return $this->mutation($request, 'POST /materials/knowledge-bases/{id}/fact-values/{value}/archive', function () use ($request, $editor, $library, $row, $payload, $admin): JsonResponse {
            $updated = $editor->updateValue($library, $row, [
                'lock_version' => $payload['lock_version'],
                'review_status' => 'rejected',
                'conflict_status' => 'resolved',
            ], $admin);

            return $this->success($request, ['value' => $this->serializeValue($updated->load('evidences'))]);
        });
    }

    public function storeEvidence(
        Request $request,
        int $knowledgeBase,
        int $value,
        KnowledgeFactEditor $editor,
    ): JsonResponse {
        $admin = $this->writableAdmin($request, $knowledgeBase);
        $library = $this->getOrCreateLibrary($knowledgeBase);
        $row = $this->valueInLibrary($library, $value);
        $payload = $request->validate([
            'knowledge_chunk_id' => ['required', 'integer', 'min:1'],
            'is_primary' => ['sometimes', 'boolean'],
            'source_locator_json' => ['sometimes', 'array'],
            'excerpt' => ['sometimes', 'string', 'max:5000'],
        ]);

        return $this->mutation($request, 'POST /materials/knowledge-bases/{id}/fact-values/{value}/evidences', function () use ($request, $editor, $library, $row, $payload, $admin): JsonResponse {
            $evidence = $editor->createEvidence($library, $row, $payload, $admin);

            return $this->success($request, ['evidence' => $this->serializeEvidence($evidence)], 201);
        });
    }

    public function merge(
        Request $request,
        int $knowledgeBase,
        int $fact,
        KnowledgeFactEditor $editor,
    ): JsonResponse {
        $this->writableAdmin($request, $knowledgeBase);
        $library = $this->getOrCreateLibrary($knowledgeBase);
        $source = $this->factInLibrary($library, $fact);
        $payload = $request->validate(['target_fact_id' => ['required', 'integer', 'min:1']]);
        $target = $this->factInLibrary($library, (int) $payload['target_fact_id']);

        return $this->mutation($request, 'POST /materials/knowledge-bases/{id}/facts/{fact}/merge', function () use ($request, $editor, $library, $source, $target): JsonResponse {
            $editor->merge($library, $source, $target);

            return $this->success($request, ['target_fact_id' => (int) $target->id]);
        });
    }

    public function split(
        Request $request,
        int $knowledgeBase,
        int $fact,
        KnowledgeFactEditor $editor,
    ): JsonResponse {
        $admin = $this->writableAdmin($request, $knowledgeBase);
        $library = $this->getOrCreateLibrary($knowledgeBase);
        $source = $this->factInLibrary($library, $fact);
        $payload = $request->validate([
            'value_ids' => ['required', 'array', 'min:1'],
            'value_ids.*' => ['integer', 'min:1'],
            'stable_key' => ['required', 'string', 'max:160', 'regex:/\A[a-z0-9][a-z0-9._-]*\z/'],
            'label' => ['required', 'string', 'max:255'],
        ]);

        return $this->mutation($request, 'POST /materials/knowledge-bases/{id}/facts/{fact}/split', function () use ($request, $editor, $library, $source, $payload, $admin): JsonResponse {
            $new = $editor->split($library, $source, array_map('intval', $payload['value_ids']), $payload, $admin);

            return $this->success($request, ['fact' => $this->serializeFact($new->load('values.evidences'))], 201);
        });
    }

    public function publish(
        Request $request,
        int $knowledgeBase,
        KnowledgeFactPublisher $publisher,
    ): JsonResponse {
        $admin = $this->writableAdmin($request, $knowledgeBase);
        $library = $this->getOrCreateLibrary($knowledgeBase);

        return $this->mutation($request, 'POST /materials/knowledge-bases/{id}/facts/publish', function () use ($request, $publisher, $library, $admin): JsonResponse {
            $revision = $publisher->publish($library, $admin);

            return $this->success($request, [
                'revision' => $this->serializeRevision($revision->load('publisher'), true),
                'library' => [
                    'id' => (int) $library->id,
                    'summary' => app(KnowledgeFactLibraryPresenter::class)->summary($library->fresh('activeRevision')),
                ],
            ]);
        });
    }

    public function restore(
        Request $request,
        int $knowledgeBase,
        int $revision,
        KnowledgeFactPublisher $publisher,
    ): JsonResponse {
        $admin = $this->writableAdmin($request, $knowledgeBase);
        $library = $this->getOrCreateLibrary($knowledgeBase);
        $source = $library->revisions()->whereKey($revision)->first();
        if (! $source instanceof KnowledgeFactLibraryRevision) {
            throw new ApiException('fact_revision_not_found', '事实版本不存在', 404);
        }

        return $this->mutation($request, 'POST /materials/knowledge-bases/{id}/fact-revisions/{revision}/restore', function () use ($request, $publisher, $library, $source, $admin): JsonResponse {
            $restored = $publisher->restore($library, $source, $admin);

            return $this->success($request, ['revision' => $this->serializeRevision($restored->load('publisher'), true)]);
        });
    }

    public function startGeneration(
        Request $request,
        int $knowledgeBase,
        KnowledgeFactGenerationCoordinator $coordinator,
        KnowledgeFactLibraryPresenter $presenter,
    ): JsonResponse {
        $admin = $this->writableAdmin($request, $knowledgeBase);
        $library = $this->getOrCreateLibrary($knowledgeBase);
        $payload = $request->validate([
            'mode' => ['required', 'in:initial,supplement,refresh_stale'],
            'target_count' => ['required', 'integer', 'min:1', 'max:'.(int) config('geoflow.knowledge_fact_generation_max_per_run', 200)],
            'ai_model_id' => ['required', 'integer', 'min:1'],
            'request_key' => ['required', 'uuid'],
        ]);
        $model = AiModel::query()->find((int) $payload['ai_model_id']);
        if (! $model instanceof AiModel) {
            throw new ApiException('ai_model_not_found', '事实生成模型不存在', 404);
        }

        return $this->mutation($request, 'POST /materials/knowledge-bases/{id}/fact-generation', function () use ($request, $coordinator, $presenter, $library, $model, $admin, $payload): JsonResponse {
            try {
                $run = $coordinator->start(
                    $library,
                    $model,
                    $admin,
                    (string) $payload['mode'],
                    (int) $payload['target_count'],
                    (string) $payload['request_key'],
                );
            } catch (AiModelAccessException $exception) {
                // 2026-09-12 退役补齐：旧 Blade 后台的 `admin.knowledge-bases.fact-generation.store`
                // 会把「模型不可用」翻成 404 `ai_model_not_accessible`；这条 API 少了这层映射，
                // 于是同一个拒绝会漏成 500。与 `Api/V1/ArticleController` 的兄弟写法保持一致。
                $status = $exception->getErrorCode() === AiModelAccessException::AI_MODEL_NOT_ACCESSIBLE
                    ? 404
                    : 409;

                throw new ApiException($exception->getErrorCode(), '选择的 AI 模型当前不可用', $status);
            }

            return $this->success($request, ['run' => $this->serializeRun($run), 'presented' => $presenter->generationRun($run, (int) $library->knowledge_base_id)], 202);
        });
    }

    public function showGeneration(
        Request $request,
        int $knowledgeBase,
        int $run,
        KnowledgeFactLibraryPresenter $presenter,
    ): JsonResponse {
        $this->executionAdmin($request);
        $library = $this->getLibrary($knowledgeBase);
        $row = $library->generationRuns()->whereKey($run)->first();
        if (! $row instanceof KnowledgeFactGenerationRun) {
            throw new ApiException('fact_generation_not_found', '事实生成任务不存在', 404);
        }

        return $this->success($request, [
            'run' => $this->serializeRun($row),
            'presented' => $presenter->generationRun($row, (int) $knowledgeBase),
        ]);
    }

    public function cancelGeneration(
        Request $request,
        int $knowledgeBase,
        int $run,
        KnowledgeFactGenerationCoordinator $coordinator,
    ): JsonResponse {
        $this->writableAdmin($request, $knowledgeBase);
        $library = $this->getLibrary($knowledgeBase);
        $row = $library->generationRuns()->whereKey($run)->first();
        if (! $row instanceof KnowledgeFactGenerationRun) {
            throw new ApiException('fact_generation_not_found', '事实生成任务不存在', 404);
        }

        return $this->mutation($request, 'POST /materials/knowledge-bases/{id}/fact-generation/{run}/cancel', function () use ($request, $coordinator, $row): JsonResponse {
            $coordinator->cancel($row);

            return $this->success($request, ['run' => $this->serializeRun($row->fresh())], 202);
        });
    }

    public function resolveGeneration(
        Request $request,
        int $knowledgeBase,
        int $run,
        KnowledgeFactGenerationCoordinator $coordinator,
    ): JsonResponse {
        $admin = $this->writableAdmin($request, $knowledgeBase);
        $library = $this->getLibrary($knowledgeBase);
        $row = $library->generationRuns()->whereKey($run)->first();
        if (! $row instanceof KnowledgeFactGenerationRun) {
            throw new ApiException('fact_generation_not_found', '事实生成任务不存在', 404);
        }
        $payload = $request->validate([
            'action' => ['required', 'in:discard,merge_as_value,create_with_new_key'],
            'candidate_key' => ['required', 'string', 'size:64'],
            'stable_key' => ['nullable', 'required_if:action,create_with_new_key', 'string', 'max:160', 'regex:/\A[a-z0-9][a-z0-9._-]*\z/'],
        ]);

        return $this->mutation($request, 'POST /materials/knowledge-bases/{id}/fact-generation/{run}/resolve', function () use ($request, $coordinator, $row, $payload, $admin): JsonResponse {
            $resolved = $coordinator->resolveConflict(
                (int) $row->id,
                (string) $payload['candidate_key'],
                (string) $payload['action'],
                isset($payload['stable_key']) ? (string) $payload['stable_key'] : null,
                $admin,
            );

            return $this->success($request, ['run' => $this->serializeRun($resolved)]);
        });
    }

    /**
     * Run an idempotent mutation and translate domain HTTP exceptions into the
     * API error envelope.  ValidationException is intentionally allowed to
     * bubble to the application API renderer with field-level details.
     */
    private function mutation(Request $request, string $routeKey, Closure $operation): JsonResponse
    {
        $this->requireIdempotencyKey($request);

        try {
            return IdempotencyService::executeJson($request, $routeKey, $operation);
        } catch (ApiException $exception) {
            throw $exception;
        } catch (ConflictHttpException $exception) {
            $code = $this->safeErrorCode($exception->getMessage(), 'knowledge_conflict');
            throw new ApiException($code, $this->conflictMessage($code), 409);
        } catch (HttpExceptionInterface $exception) {
            $status = (int) $exception->getStatusCode();
            if (in_array($status, [404, 409, 422], true)) {
                $code = $this->safeErrorCode($exception->getMessage(), $status === 404 ? 'not_found' : 'knowledge_operation_failed');
                throw new ApiException($code, $this->conflictMessage($code), $status);
            }

            throw $exception;
        }
    }

    private function writableAdmin(Request $request, int $knowledgeBase): Admin
    {
        $admin = $this->executionAdmin($request);
        // Validate the mutation contract before resolving or creating any
        // library state.  A rejected request (especially one missing its
        // idempotency key) must not leave an empty fact library behind.
        $this->requireIdempotencyKey($request);
        $base = $this->findKnowledgeBase($knowledgeBase);
        if ($base->isSystemManaged() && ! $admin->canManageProtectedWorkflows()) {
            throw new ApiException('protected_knowledge_read_only', '系统知识库需要受保护工作流权限才能修改', 403);
        }

        return $admin;
    }

    private function findKnowledgeBase(int $id): KnowledgeBase
    {
        $base = KnowledgeBase::query()->with('systemBinding')->whereKey($id)->first();
        if (! $base instanceof KnowledgeBase) {
            throw new ApiException('knowledge_base_not_found', '知识库不存在', 404);
        }

        return $base;
    }

    private function getLibrary(int $knowledgeBase): KnowledgeFactLibrary
    {
        $base = $this->findKnowledgeBase($knowledgeBase);
        $library = $base->factLibrary()->first();
        if (! $library instanceof KnowledgeFactLibrary) {
            throw new ApiException('fact_library_not_found', '事实库不存在', 404);
        }

        return $library;
    }

    private function getOrCreateLibrary(int $knowledgeBase): KnowledgeFactLibrary
    {
        $base = $this->findKnowledgeBase($knowledgeBase);

        return $base->factLibrary()->firstOrCreate([]);
    }

    private function factInLibrary(KnowledgeFactLibrary $library, int $id): KnowledgeFact
    {
        $fact = $library->facts()->whereKey($id)->first();
        if (! $fact instanceof KnowledgeFact) {
            throw new ApiException('knowledge_fact_not_found', '事实不存在', 404);
        }

        return $fact;
    }

    private function valueInLibrary(KnowledgeFactLibrary $library, int $id): KnowledgeFactValue
    {
        $value = KnowledgeFactValue::query()
            ->whereKey($id)
            ->whereHas('fact', fn ($query) => $query->where('library_id', $library->id))
            ->first();
        if (! $value instanceof KnowledgeFactValue) {
            throw new ApiException('knowledge_fact_value_not_found', '事实值不存在', 404);
        }

        return $value;
    }

    /** @return array<string,mixed> */
    private function validateFactPayload(Request $request, string $mode): array
    {
        if ($mode === 'create') {
            return $request->validate([
                'stable_key' => ['required', 'string', 'max:160', 'regex:/\A[a-z0-9][a-z0-9._-]*\z/'],
                'label' => ['required', 'string', 'max:255'],
                'subject' => ['required', 'string', 'max:255'],
                'predicate' => ['required', 'string', 'max:255'],
                'value_type' => ['required', 'in:string,integer,decimal,number,percentage,date,range,boolean,url,path,version'],
                'locale' => ['sometimes', 'string', 'max:16'],
                'aliases_json' => ['sometimes', 'array', 'max:50'],
                'aliases_json.*' => ['string', 'max:255'],
                'importance' => ['sometimes', 'in:critical,high,normal'],
                'usage_scope' => ['sometimes', 'in:quality_only,quality_and_generation'],
            ]);
        }

        return $request->validate([
            'lock_version' => ['required', 'integer', 'min:1'],
            'label' => ['sometimes', 'string', 'max:255'],
            'subject' => ['sometimes', 'string', 'max:255'],
            'predicate' => ['sometimes', 'string', 'max:255'],
            'value_type' => ['sometimes', 'in:string,integer,decimal,number,percentage,date,range,boolean,url,path,version'],
            'aliases_json' => ['sometimes', 'array', 'max:50'],
            'aliases_json.*' => ['string', 'max:255'],
            'importance' => ['sometimes', 'in:critical,high,normal'],
            'usage_scope' => ['sometimes', 'in:quality_only,quality_and_generation'],
            'review_status' => ['sometimes', 'in:draft,reviewed,rejected'],
            'is_enabled' => ['sometimes', 'boolean'],
        ]);
    }

    /** @return array<string,mixed> */
    private function validateValuePayload(Request $request, bool $update): array
    {
        $rules = [
            'canonical_value_json' => [$update ? 'sometimes' : 'required', 'array:value,unit'],
            'canonical_value_json.value' => [$update ? 'required_with:canonical_value_json' : 'required', 'string', 'max:5000'],
            'canonical_value_json.unit' => ['nullable', 'string', 'max:64'],
            'canonical_answer' => [$update ? 'sometimes' : 'required', 'string', 'max:5000'],
            'temporal_kind' => ['sometimes', 'in:timeless,observed,interval'],
            'scope_json' => ['sometimes', 'array', 'max:20'],
            'scope_json.*' => ['nullable', 'string', 'max:255'],
            'valid_from' => ['nullable', 'date'],
            'valid_to' => ['nullable', 'date'],
            'observed_at' => ['nullable', 'date'],
            'comparison_policy_json' => ['sometimes', 'array:tolerance'],
            'comparison_policy_json.tolerance' => ['nullable', 'numeric', 'min:0'],
            'review_status' => ['sometimes', 'in:draft,reviewed,rejected'],
        ];
        if ($update) {
            $rules['lock_version'] = ['required', 'integer', 'min:1'];
            $rules['conflict_status'] = ['sometimes', 'in:clear,unresolved,resolved'];
        }

        return $request->validate($rules);
    }

    /** @return array<string,mixed> */
    private function serializeKnowledgeBase(KnowledgeBase $base): array
    {
        return [
            'id' => (int) $base->id,
            'name' => (string) $base->name,
            'chunk_sync_status' => (string) ($base->chunk_sync_status ?? 'idle'),
            'serving_generation' => trim((string) ($base->chunk_serving_generation ?? '')) ?: null,
            'serving_source_hash' => trim((string) ($base->chunk_serving_source_hash ?? '')) ?: null,
        ];
    }

    /** @return array<string,mixed> */
    private function serializeFact(KnowledgeFact $fact): array
    {
        $values = $fact->relationLoaded('values') ? $fact->values : collect();

        return [
            'id' => (int) $fact->id,
            'stable_key' => (string) $fact->stable_key,
            'label' => (string) $fact->label,
            'subject' => (string) $fact->subject,
            'predicate' => (string) $fact->predicate,
            'value_type' => (string) $fact->value_type,
            'locale' => (string) $fact->locale,
            'aliases' => is_array($fact->aliases_json) ? array_values($fact->aliases_json) : [],
            'importance' => (string) $fact->importance,
            'usage_scope' => (string) $fact->usage_scope,
            'review_status' => (string) $fact->review_status,
            'is_enabled' => (bool) $fact->is_enabled,
            'lock_version' => (int) $fact->lock_version,
            'values' => $values->map(fn (KnowledgeFactValue $value): array => $this->serializeValue($value))->values()->all(),
            'created_at' => optional($fact->created_at)->toIso8601String(),
            'updated_at' => optional($fact->updated_at)->toIso8601String(),
        ];
    }

    /** @return array<string,mixed> */
    private function serializeValue(KnowledgeFactValue $value): array
    {
        $evidences = $value->relationLoaded('evidences') ? $value->evidences : collect();

        return [
            'id' => (int) $value->id,
            'fact_id' => (int) $value->fact_id,
            'canonical_value' => is_array($value->canonical_value_json) ? $value->canonical_value_json : [],
            'canonical_answer' => (string) $value->canonical_answer,
            'temporal_kind' => (string) $value->temporal_kind,
            'scope' => is_array($value->scope_json) ? $value->scope_json : [],
            'valid_from' => optional($value->valid_from)->toDateString(),
            'valid_to' => optional($value->valid_to)->toDateString(),
            'observed_at' => optional($value->observed_at)->toIso8601String(),
            'comparison_policy' => is_array($value->comparison_policy_json) ? $value->comparison_policy_json : [],
            'review_status' => (string) $value->review_status,
            'conflict_status' => (string) $value->conflict_status,
            'lock_version' => (int) $value->lock_version,
            'evidences' => $evidences->map(fn (KnowledgeFactEvidence $evidence): array => $this->serializeEvidence($evidence))->values()->all(),
            'created_at' => optional($value->created_at)->toIso8601String(),
            'updated_at' => optional($value->updated_at)->toIso8601String(),
        ];
    }

    /** @return array<string,mixed> */
    private function serializeEvidence(KnowledgeFactEvidence $evidence): array
    {
        return [
            'id' => (int) $evidence->id,
            'value_id' => (int) $evidence->value_id,
            'knowledge_chunk_id' => $evidence->knowledge_chunk_id !== null ? (int) $evidence->knowledge_chunk_id : null,
            'source_hash' => (string) $evidence->source_hash,
            'content_hash' => (string) $evidence->content_hash,
            'source_locator' => is_array($evidence->source_locator_json) ? $evidence->source_locator_json : [],
            'excerpt' => mb_substr((string) $evidence->excerpt, 0, 5000, 'UTF-8'),
            'excerpt_hash' => (string) $evidence->excerpt_hash,
            'is_primary' => (bool) $evidence->is_primary,
            'created_at' => optional($evidence->created_at)->toIso8601String(),
        ];
    }

    /** @return array<string,mixed> */
    private function serializeRevision(KnowledgeFactLibraryRevision $revision, bool $includeManifest): array
    {
        $result = [
            'id' => (int) $revision->id,
            'library_id' => (int) $revision->library_id,
            'version' => (int) $revision->version,
            'library_hash' => (string) $revision->library_hash,
            'source_hash' => (string) $revision->source_hash,
            'published_by_admin_id' => $revision->published_by_admin_id !== null ? (int) $revision->published_by_admin_id : null,
            'published_at' => optional($revision->published_at)->toIso8601String(),
            'restored_from_revision_id' => $revision->restored_from_revision_id !== null ? (int) $revision->restored_from_revision_id : null,
            'publisher' => $revision->relationLoaded('publisher') && $revision->publisher
                ? ['id' => (int) $revision->publisher->id, 'username' => (string) $revision->publisher->username]
                : null,
        ];
        if ($includeManifest) {
            $manifest = is_array($revision->manifest_json) ? $revision->manifest_json : [];
            // The manifest is already validated by KnowledgeFactPublisher;
            // cap the response to avoid turning a large immutable revision
            // into an unbounded API response.
            $manifest['facts'] = array_slice((array) ($manifest['facts'] ?? []), 0, 1000);
            $result['manifest'] = $manifest;
        }

        return $result;
    }

    /** @return array<string,mixed> */
    private function serializeRun(KnowledgeFactGenerationRun $run): array
    {
        $result = is_array($run->result_json) ? $run->result_json : [];
        $sanitize = function (mixed $value, int $depth = 0) use (&$sanitize): mixed {
            if ($depth > 5) {
                return null;
            }
            if (is_string($value)) {
                return mb_substr($value, 0, 2000, 'UTF-8');
            }
            if (is_array($value)) {
                $out = [];
                foreach (array_slice($value, 0, 100, true) as $key => $item) {
                    $out[(string) $key] = $sanitize($item, $depth + 1);
                }

                return $out;
            }

            return is_scalar($value) || $value === null ? $value : null;
        };

        return [
            'id' => (int) $run->id,
            'library_id' => (int) $run->library_id,
            'mode' => (string) $run->mode,
            'target_count' => (int) $run->target_count,
            'source_hash' => (string) $run->source_hash,
            'status' => (string) $run->status,
            'ai_model_id' => $run->ai_model_id !== null ? (int) $run->ai_model_id : null,
            'created_by_admin_id' => $run->created_by_admin_id !== null ? (int) $run->created_by_admin_id : null,
            'request_key' => (string) $run->request_key,
            'retryable_failure' => (bool) ($run->retryable_failure ?? true),
            'error_code' => $run->error_code !== null ? (string) $run->error_code : null,
            'error_message' => $run->error_message !== null ? mb_substr((string) $run->error_message, 0, 500, 'UTF-8') : null,
            'candidate_count' => count((array) ($result['candidates'] ?? [])),
            'conflict_count' => count((array) ($result['conflicts'] ?? [])),
            'candidates' => $sanitize(array_slice((array) ($result['candidates'] ?? []), 0, 100)),
            'conflicts' => $sanitize(array_slice((array) ($result['conflicts'] ?? []), 0, 100)),
            'resolved' => $sanitize(array_slice((array) ($result['resolved'] ?? []), 0, 100)),
            'started_at' => optional($run->started_at)->toIso8601String(),
            'completed_at' => optional($run->completed_at)->toIso8601String(),
            'failed_at' => optional($run->failed_at)->toIso8601String(),
            'cancelled_at' => optional($run->cancelled_at)->toIso8601String(),
            'created_at' => optional($run->created_at)->toIso8601String(),
            'updated_at' => optional($run->updated_at)->toIso8601String(),
        ];
    }

    private function textQuery(Request $request, string $key): string
    {
        $value = $request->query($key, '');

        return is_string($value) ? trim(mb_substr($value, 0, 200, 'UTF-8')) : '';
    }

    private function requireIdempotencyKey(Request $request): void
    {
        $key = $request->header('X-Idempotency-Key');
        if (! is_string($key) || trim($key) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
        if (strlen($key) > 120 || preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]*$/D', $key) !== 1) {
            throw new ApiException('invalid_idempotency_key', 'X-Idempotency-Key 格式无效', 422);
        }
    }

    private function safeErrorCode(string $value, string $fallback): string
    {
        $value = trim($value);

        return preg_match('/\A[a-z][a-z0-9_]{2,120}\z/', $value) === 1 ? $value : $fallback;
    }

    private function conflictMessage(string $code): string
    {
        return match ($code) {
            'knowledge_fact_revision_conflict' => '事实已被其他操作更新，请刷新后重试',
            'knowledge_fact_generation_active' => '该事实库已有生成任务正在执行',
            'knowledge_fact_generation_initial_requires_empty_library' => '初始生成要求事实库为空',
            'knowledge_fact_merge_value_type_mismatch' => '两个事实的值类型不一致，无法合并',
            default => '知识资产操作冲突，请刷新后重试',
        };
    }
}
