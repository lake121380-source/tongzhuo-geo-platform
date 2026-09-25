<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Models\ManualPublication;
use App\Models\ManualPublicationAccount;
use App\Models\ManualPublicationPersona;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\ManualPublicationService;
use Carbon\Carbon;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Throwable;

/**
 * JSON projection for the existing 桐灼GEO manual-publication workflow.
 * Business validation and transitions remain in ManualPublicationService;
 * this controller only adapts the API contract for the -AI shell.
 */
final class ManualPublicationController extends BaseApiController
{
    public function index(Request $request): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        Gate::forUser($admin)->authorize('viewAny', ManualPublication::class);

        $query = $this->filteredQuery($request, $admin);

        $page = $query->latest('id')->paginate(min(100, max(1, $request->integer('per_page', 20))), ['*'], 'page', max(1, $request->integer('page', 1)));
        $statsQuery = ManualPublication::query()->visibleTo($admin);

        return $this->success($request, [
            'items' => $page->getCollection()->map(fn (ManualPublication $item): array => $this->projection($item))->values()->all(),
            'pagination' => [
                'page' => (int) $page->currentPage(),
                'per_page' => (int) $page->perPage(),
                'total' => (int) $page->total(),
                'total_pages' => (int) $page->lastPage(),
            ],
            'stats' => [
                'total' => (int) $statsQuery->count(),
                'ready' => (int) (clone $statsQuery)->where('status', ManualPublication::STATUS_READY)->count(),
                'in_progress' => (int) (clone $statsQuery)->where('status', ManualPublication::STATUS_IN_PROGRESS)->count(),
                'completed' => (int) (clone $statsQuery)->where('status', ManualPublication::STATUS_COMPLETED)->count(),
            ],
            'options' => $this->options($admin),
        ]);
    }

    public function show(Request $request, int $manualPublication): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $publication = ManualPublication::query()->with($this->relations())->findOrFail($manualPublication);
        Gate::forUser($admin)->authorize('view', $publication);

        return $this->success($request, [
            'publication' => $this->projection($publication, true),
            'transitions' => $publication->transitions()->latest('id')->limit(50)->get()->map(fn ($transition): array => [
                'id' => (int) $transition->id,
                'from_status' => $transition->from_status,
                'to_status' => $transition->to_status,
                'completion_url' => $transition->completion_url,
                'result_note' => $transition->result_note,
                'created_at' => $transition->created_at?->toIso8601String(),
            ])->values()->all(),
        ]);
    }

    public function store(Request $request, ManualPublicationService $service): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        Gate::forUser($admin)->authorize('create', ManualPublication::class);
        $this->requireIdempotencyKey($request);
        $payload = $this->validatedPayload($request, true);

        return IdempotencyService::executeJson($request, 'POST /manual-publications', function () use ($request, $service, $admin, $payload): JsonResponse {
            try {
                $publication = $service->create($payload, $admin)->load($this->relations());
            } catch (Throwable $exception) {
                throw new ApiException('manual_publication_create_failed', $this->publicFailure($exception), 422);
            }

            return $this->success($request, ['publication' => $this->projection($publication, true)], 201);
        });
    }

    public function update(Request $request, int $manualPublication, ManualPublicationService $service): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $publication = ManualPublication::query()->findOrFail($manualPublication);
        Gate::forUser($admin)->authorize('update', $publication);
        $this->requireIdempotencyKey($request);
        $payload = $this->validatedPayload($request, false);
        $revision = (int) $request->input('revision', 0);
        if ($revision < 1) {
            throw new ApiException('validation_failed', 'revision 无效', 422, ['field_errors' => ['revision' => 'revision 必须为正整数']]);
        }

        return IdempotencyService::executeJson($request, 'PATCH /manual-publications/{id}', function () use ($request, $service, $publication, $payload, $revision): JsonResponse {
            try {
                $updated = $service->update($publication, $payload, $revision)->load($this->relations());
            } catch (Throwable $exception) {
                throw new ApiException('manual_publication_update_failed', $this->publicFailure($exception), 409);
            }

            return $this->success($request, ['publication' => $this->projection($updated, true)]);
        });
    }

    public function transition(Request $request, int $manualPublication, ManualPublicationService $service): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $publication = ManualPublication::query()->findOrFail($manualPublication);
        Gate::forUser($admin)->authorize('transition', $publication);
        $this->requireIdempotencyKey($request);
        $payload = $request->validate([
            'target_status' => ['required', Rule::in(ManualPublication::STATUSES)],
            'revision' => ['required', 'integer', 'min:1'],
            'completion_url' => ['nullable', 'url:http,https', 'max:1000'],
            'result_note' => ['nullable', 'string', 'max:5000'],
        ]);

        return IdempotencyService::executeJson($request, 'POST /manual-publications/{id}/transition', function () use ($request, $service, $admin, $publication, $payload): JsonResponse {
            try {
                $updated = $service->transition($publication, (string) $payload['target_status'], (int) $payload['revision'], $admin, $payload['completion_url'] ?? null, $payload['result_note'] ?? null)->load($this->relations());
            } catch (Throwable $exception) {
                throw new ApiException('manual_publication_transition_failed', $this->publicFailure($exception), 409);
            }

            return $this->success($request, ['publication' => $this->projection($updated, true)]);
        });
    }

    /** @return array<string,mixed> */
    /**
     * 工单导出（CSV）。
     *
     * 与列表用**同一个筛选**：导出的是「当前看到的这一份」，不是全量——否则运营方
     * 在界面上筛完再导出会拿到意料之外的数据。带 BOM，Excel 打开不乱码。
     */
    public function export(Request $request): StreamedResponse
    {
        $admin = $this->executionAdmin($request);
        Gate::forUser($admin)->authorize('exportAny', ManualPublication::class);

        $query = $this->filteredQuery($request, $admin)->latest('id');
        $filename = 'tongzhuo-manual-publications-'.now()->format('Ymd-His').'.csv';

        return response()->streamDownload(function () use ($query): void {
            $handle = fopen('php://output', 'w');
            if ($handle === false) {
                return;
            }

            fwrite($handle, "\xEF\xBB\xBF");
            fputcsv($handle, [
                'ID', '类型', '平台', '文章', '人设', '账号', '指派人', '状态', '计划时间',
                '目标链接', '正文', '风险', '重复', '完成链接', '结果备注', '创建时间',
            ]);

            // 逐条写出，避免把整张表读进内存。
            $query->with($this->relations())->chunk(200, function ($rows) use ($handle): void {
                foreach ($rows as $row) {
                    $projection = $this->projection($row);
                    fputcsv($handle, [
                        $projection['id'] ?? '',
                        $projection['type'] ?? '',
                        $projection['platform'] ?? '',
                        $projection['article_title'] ?? '',
                        $projection['persona_name'] ?? '',
                        $projection['account_name'] ?? '',
                        $projection['assignee'] ?? '',
                        $projection['status'] ?? '',
                        $projection['scheduled_at'] ?? '',
                        $projection['target_url'] ?? '',
                        $projection['content'] ?? '',
                        $projection['risk_status'] ?? '',
                        $projection['duplicates'] ?? '',
                        $projection['completion_url'] ?? '',
                        $projection['result_note'] ?? '',
                        $projection['created_at'] ?? '',
                    ]);
                }
            });

            fclose($handle);
        }, $filename, ['Content-Type' => 'text/csv; charset=UTF-8']);
    }

    /** 列表与导出共用的筛选，保证「导出的就是看到的」。 */
    private function filteredQuery(Request $request, Admin $admin): Builder
    {
        $query = ManualPublication::query()->visibleTo($admin)->with($this->relations());

        $status = trim((string) $request->query('status'));
        if (in_array($status, ManualPublication::STATUSES, true)) {
            $query->where('status', $status);
        }

        // 以下六个维度与旧后台**逐条对齐**（`Admin/ManualPublicationController::filteredQuery`）：
        // 列表与导出共用这一个方法，所以补在这里等于两边同时补齐——早先只做了 status+search，
        // 「按平台/指派人/时间筛完再导出」会变成假动作。
        $type = trim((string) $request->query('type'));
        if (in_array($type, ManualPublication::TYPES, true)) {
            $query->where('type', $type);
        }

        $platform = trim((string) $request->query('platform'));
        if (in_array($platform, ManualPublicationAccount::PLATFORMS, true)) {
            $query->where('platform', $platform);
        }

        // 只有超管能按「指派给谁」筛——与旧后台同一条边界。
        $assigneeId = (int) $request->query('assigned_admin_id');
        if ($admin->isSuperAdmin() && $assigneeId > 0) {
            $query->where('assigned_admin_id', $assigneeId);
        }

        $articleId = (int) $request->query('article_id');
        if ($articleId > 0) {
            $query->where('article_id', $articleId);
        }

        foreach (['scheduled_from' => '>=', 'scheduled_to' => '<='] as $field => $operator) {
            $date = $this->dateFilter($request->query($field));
            if ($date !== null) {
                $query->whereDate('scheduled_at', $operator, $date);
            }
        }

        $search = trim((string) $request->query('search'));
        if ($search !== '') {
            $like = '%'.$search.'%';
            $query->where(function (Builder $builder) use ($like): void {
                $builder->where('content', 'like', $like)
                    ->orWhere('target_url', 'like', $like)
                    ->orWhereHas('article', fn (Builder $article) => $article->where('title', 'like', $like))
                    ->orWhereHas('account', fn (Builder $account) => $account->where('account_name', 'like', $like));
            });
        }

        return $query;
    }

    /** 与旧后台同口径：能解析成日期就用 `Y-m-d` 比较，解析不了就当没传（不报错、也不筛）。 */
    private function dateFilter(mixed $value): ?string
    {
        $value = trim((string) $value);
        if ($value === '') {
            return null;
        }

        try {
            return Carbon::parse($value)->toDateString();
        } catch (Throwable) {
            return null;
        }
    }

    private function options(Admin $admin): array
    {
        return [
            'personas' => ManualPublicationPersona::query()->where('is_active', true)->orderBy('name')->get(['id', 'name', 'tone', 'domain', 'disclosure_text'])->map(fn ($row): array => $row->toArray())->values()->all(),
            'accounts' => ManualPublicationAccount::query()->where('is_active', true)->with('persona:id,name')->orderBy('account_name')->get()->map(fn ($row): array => ['id' => (int) $row->id, 'persona_id' => (int) $row->persona_id, 'platform' => (string) $row->platform, 'custom_platform' => $row->custom_platform, 'account_name' => (string) $row->account_name, 'profile_url' => $row->profile_url, 'persona' => $row->persona?->name])->values()->all(),
            'admins' => Admin::query()->where('status', 'active')->orderBy('display_name')->get(['id', 'username', 'display_name'])->map(fn ($row): array => $row->toArray())->values()->all(),
            'platforms' => ManualPublicationAccount::PLATFORMS,
            'types' => ManualPublication::TYPES,
            'statuses' => ManualPublication::STATUSES,
        ];
    }

    /** @return array<string,mixed> */
    private function projection(ManualPublication $publication, bool $detail = false): array
    {
        $data = [
            'id' => (int) $publication->id,
            'type' => (string) $publication->type,
            'article_id' => $publication->article_id !== null ? (int) $publication->article_id : null,
            'article' => $publication->article ? ['id' => (int) $publication->article->id, 'title' => (string) $publication->article->title, 'review_status' => (string) $publication->article->review_status] : null,
            'persona_id' => $publication->persona_id !== null ? (int) $publication->persona_id : null,
            'persona' => $publication->persona ? ['id' => (int) $publication->persona->id, 'name' => (string) $publication->persona->name] : null,
            'account_id' => $publication->account_id !== null ? (int) $publication->account_id : null,
            'account' => $publication->account ? ['id' => (int) $publication->account->id, 'name' => (string) $publication->account->account_name, 'platform' => (string) $publication->account->platform] : null,
            'assigned_admin_id' => $publication->assigned_admin_id !== null ? (int) $publication->assigned_admin_id : null,
            'assigned_admin' => $publication->assignee ? ['id' => (int) $publication->assignee->id, 'display_name' => (string) $publication->assignee->display_name, 'username' => (string) $publication->assignee->username] : null,
            'platform' => (string) $publication->platform,
            'custom_platform' => $publication->custom_platform,
            'target_url' => $publication->target_url,
            'target_context' => $publication->target_context,
            'content' => $publication->content,
            'risk_status' => $publication->risk_status,
            'duplicate_warning_count' => (int) $publication->duplicate_warning_count,
            'scheduled_at' => $publication->scheduled_at?->toIso8601String(),
            'status' => (string) $publication->status,
            'revision' => (int) $publication->revision,
            'completion_url' => $publication->completion_url,
            'result_note' => $publication->result_note,
            'browser_claimed_at' => $publication->browser_claimed_at?->toIso8601String(),
            'browser_last_seen_at' => $publication->browser_last_seen_at?->toIso8601String(),
            'created_at' => $publication->created_at?->toIso8601String(),
            'updated_at' => $publication->updated_at?->toIso8601String(),
        ];
        if ($detail) {
            $data['publication_payload'] = $publication->publication_payload;
            $data['execution_receipt'] = $publication->execution_receipt;
            $data['allowed_next_statuses'] = ManualPublication::allowedNextStatuses((string) $publication->status);
        }

        return $data;
    }

    /** @return array<string,mixed> */
    private function validatedPayload(Request $request, bool $includeStatus): array
    {
        $rules = [
            'type' => ['required', Rule::in(ManualPublication::TYPES)],
            'article_id' => ['nullable', 'integer', Rule::exists('articles', 'id')->whereNull('deleted_at')],
            'persona_id' => ['required', 'integer', Rule::exists('manual_publication_personas', 'id')->where('is_active', true)],
            'account_id' => ['nullable', 'integer', Rule::exists('manual_publication_accounts', 'id')->where('is_active', true)],
            'assigned_admin_id' => ['nullable', 'integer', Rule::exists('admins', 'id')->where('status', 'active')],
            'platform' => ['required', Rule::in(ManualPublicationAccount::PLATFORMS)],
            'custom_platform' => ['nullable', 'string', 'max:120'],
            'target_url' => ['nullable', 'url:http,https', 'max:1000'],
            'target_context' => ['nullable', 'string', 'max:5000'],
            'content' => ['required', 'string'],
            'scheduled_at' => ['nullable', 'date'],
        ];
        if ($includeStatus) {
            $rules['status'] = ['required', Rule::in([ManualPublication::STATUS_DRAFT, ManualPublication::STATUS_READY])];
        }
        $validator = Validator::make($request->all(), $rules);
        $validator->after(function ($validator) use ($request, $includeStatus): void {
            $type = (string) $request->input('type');
            if ($type === ManualPublication::TYPE_POST && ! $request->filled('article_id')) {
                $validator->errors()->add('article_id', 'post 类型必须选择已审核文章');
            }
            if ($type === ManualPublication::TYPE_COMMENT && (! $request->filled('target_url') || ! $request->filled('target_context'))) {
                $validator->errors()->add('target_url', 'comment 类型必须提供目标 URL 和上下文');
            }
            if ($request->input('platform') === ManualPublicationAccount::PLATFORM_CUSTOM && ! $request->filled('custom_platform')) {
                $validator->errors()->add('custom_platform', '自定义平台必须填写名称');
            }
            if ($includeStatus && $request->input('status') === ManualPublication::STATUS_READY && ! $request->filled('assigned_admin_id')) {
                $validator->errors()->add('assigned_admin_id', 'ready 状态必须指定执行人');
            }
        });
        if ($validator->fails()) {
            throw new ValidationException($validator);
        }

        return $validator->validated();
    }

    private function requireIdempotencyKey(Request $request): void
    {
        $key = trim((string) $request->header('X-Idempotency-Key'));
        if ($key === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }

    /**
     * 业务失败原因的透出策略。
     *
     * 服务层抛的是**写得能看懂的中文**（例：「已被领取/已完成的工单不能编辑，请先释放」
     * 「工单已在别处变更，请刷新重试」）。以前这里只放行形如机器码的短串，中文一律被替换成
     * `manual_publication_operation_failed` —— 而前端是把 `message` 直接展示的，红色横幅上
     * 就是一串英文，运营既不知道是被别人领走了还是状态不对，也不知道该释放还是该刷新。
     *
     * 仍然挡住真正的内部异常文本（SQL、命名空间、路径、堆栈）——那些不该出现在界面上。
     */
    private function publicFailure(Throwable $exception): string
    {
        $message = trim($exception->getMessage());
        if ($message === '') {
            return 'manual_publication_operation_failed';
        }

        if (preg_match('/\A[a-z0-9_.:-]{1,100}\z/', $message) === 1) {
            return $message;
        }

        $looksInternal = preg_match(
            '/(SQLSTATE|Illuminate\\\\|Symfony\\\\|\.php\b|\/var\/|Stack trace|QueryException|PDOException)/i',
            $message,
        ) === 1;
        if ($looksInternal) {
            return 'manual_publication_operation_failed';
        }

        // 自述型业务文案：含中文、长度可控 → 原样透出。
        if (preg_match('/\p{Han}/u', $message) === 1 && mb_strlen($message) <= 200) {
            return $message;
        }

        return 'manual_publication_operation_failed';
    }

    /** @return array<string,mixed> */
    private function relations(): array
    {
        return [
            'article' => fn ($query) => $query->withTrashed()->select(['id', 'title', 'review_status', 'deleted_at']),
            'persona:id,name',
            'account:id,account_name,platform',
            'assignee:id,username,display_name',
        ];
    }
}
