<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Models\LeadForm;
use App\Models\LeadSubmission;
use App\Services\Api\IdempotencyService;
use App\Support\AdminActivityLogger;
use App\Support\Lead\LeadFormFields;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Authenticated lead-form and lead-management contract for the React admin.
 *
 * Public form rendering/submission remains owned by the existing Site
 * controller. This controller only projects and mutates the same persisted
 * LeadForm/LeadSubmission records used by the legacy admin.
 */
class LeadManagementController extends BaseApiController
{
    public function forms(Request $request): JsonResponse
    {
        $this->executionAdmin($request);
        $perPage = min(100, max(1, (int) $request->query('per_page', 20)));
        $query = LeadForm::query()->withCount('submissions');
        $status = trim((string) $request->query('status', ''));
        if (in_array($status, [LeadForm::STATUS_ACTIVE, LeadForm::STATUS_INACTIVE], true)) {
            $query->where('status', $status);
        }
        $search = trim((string) $request->query('search', ''));
        if ($search !== '') {
            $like = '%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], mb_strtolower($search)).'%';
            $query->where(function (Builder $inner) use ($like): void {
                $inner->whereRaw('LOWER(name) LIKE ?', [$like])
                    ->orWhereRaw('LOWER(slug) LIKE ?', [$like])
                    ->orWhereRaw('LOWER(COALESCE(description, ?)) LIKE ?', ['', $like]);
            });
        }

        $paginator = $query->orderByDesc('created_at')->orderByDesc('id')->paginate($perPage);

        return $this->success($request, [
            'items' => collect($paginator->items())->map(fn (LeadForm $form): array => $this->formProjection($form))->all(),
            'stats' => [
                'total' => LeadForm::query()->count(),
                'active' => LeadForm::query()->where('status', LeadForm::STATUS_ACTIVE)->count(),
                'submissions' => LeadSubmission::query()->count(),
            ],
            'field_types' => LeadForm::FIELD_TYPES,
            'default_fields' => LeadFormFields::defaultFields(),
            'pagination' => $this->pagination($paginator),
        ]);
    }

    public function form(Request $request, int $leadForm): JsonResponse
    {
        $this->executionAdmin($request);
        $form = LeadForm::query()->withCount('submissions')->whereKey($leadForm)->first();
        if (! $form instanceof LeadForm) {
            throw new ApiException('lead_form_not_found', '线索表单不存在', 404);
        }

        return $this->success($request, ['form' => $this->formProjection($form)]);
    }

    public function storeForm(Request $request): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $actor = $this->executionAdmin($request);

        return IdempotencyService::executeJson($request, 'POST /lead-forms', function () use ($request, $actor): JsonResponse {
            $payload = $this->validateFormPayload($request, null, false);
            $fields = LeadFormFields::normalizePosted($payload['fields']);
            if ($fields === []) {
                throw new ApiException('lead_form_fields_required', '至少配置一个有效字段', 422, [
                    'field_errors' => ['fields' => '至少配置一个有效字段'],
                ]);
            }
            $form = LeadForm::query()->create([
                'name' => trim((string) $payload['name']),
                'slug' => $this->uniqueSlug((string) ($payload['slug'] ?? ''), (string) $payload['name']),
                'status' => (string) ($payload['status'] ?? LeadForm::STATUS_ACTIVE),
                'description' => trim((string) ($payload['description'] ?? '')),
                'submit_button_label' => trim((string) ($payload['submit_button_label'] ?? '')) ?: '提交',
                'success_message' => trim((string) ($payload['success_message'] ?? '')),
                'fields' => $fields,
            ]);
            $form->loadCount('submissions');
            $this->audit($request, $actor, 'api.lead_form.create', 'lead_form', (int) $form->id, [
                'name' => (string) $form->name,
                'status' => (string) $form->status,
                'field_count' => count($fields),
            ]);

            return $this->success($request, ['form' => $this->formProjection($form)], 201);
        });
    }

    public function updateForm(Request $request, int $leadForm): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $actor = $this->executionAdmin($request);
        $payload = $this->validateFormPayload($request, $leadForm, true);

        return IdempotencyService::executeJson($request, 'PATCH /lead-forms/{id}', function () use ($request, $actor, $payload, $leadForm): JsonResponse {
            $form = LeadForm::query()->whereKey($leadForm)->lockForUpdate()->first();
            if (! $form instanceof LeadForm) {
                throw new ApiException('lead_form_not_found', '线索表单不存在', 404);
            }
            $this->assertVersion($form, (string) $payload['expected_updated_at'], 'lead_form_conflict');

            $changes = [];
            foreach (['name', 'status', 'description', 'submit_button_label', 'success_message'] as $field) {
                if (array_key_exists($field, $payload)) {
                    $changes[$field] = is_string($payload[$field]) ? trim($payload[$field]) : $payload[$field];
                }
            }
            if (array_key_exists('slug', $payload) || array_key_exists('name', $payload)) {
                $changes['slug'] = $this->uniqueSlug(
                    (string) ($payload['slug'] ?? $form->slug),
                    (string) ($payload['name'] ?? $form->name),
                    $form,
                );
            }
            if (array_key_exists('fields', $payload)) {
                $fields = LeadFormFields::normalizePosted($payload['fields']);
                if ($fields === []) {
                    throw new ApiException('lead_form_fields_required', '至少配置一个有效字段', 422, [
                        'field_errors' => ['fields' => '至少配置一个有效字段'],
                    ]);
                }
                $changes['fields'] = $fields;
            }
            if ($changes !== []) {
                $form->forceFill($changes)->save();
            }
            $form->refresh()->loadCount('submissions');
            $this->audit($request, $actor, 'api.lead_form.update', 'lead_form', (int) $form->id, [
                'changed_fields' => array_values(array_keys($changes)),
            ]);

            return $this->success($request, ['form' => $this->formProjection($form)]);
        });
    }

    public function setFormStatus(Request $request, int $leadForm): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $actor = $this->executionAdmin($request);
        $payload = $request->validate([
            'status' => ['required', Rule::in([LeadForm::STATUS_ACTIVE, LeadForm::STATUS_INACTIVE])],
            'expected_updated_at' => ['required', 'string', 'max:80'],
        ]);

        return IdempotencyService::executeJson($request, 'POST /lead-forms/{id}/status', function () use ($request, $actor, $payload, $leadForm): JsonResponse {
            $form = LeadForm::query()->whereKey($leadForm)->lockForUpdate()->first();
            if (! $form instanceof LeadForm) {
                throw new ApiException('lead_form_not_found', '线索表单不存在', 404);
            }
            $this->assertVersion($form, (string) $payload['expected_updated_at'], 'lead_form_conflict');
            $form->forceFill(['status' => (string) $payload['status']])->save();
            $form->refresh()->loadCount('submissions');
            $this->audit($request, $actor, 'api.lead_form.status', 'lead_form', (int) $form->id, [
                'status' => (string) $form->status,
            ]);

            return $this->success($request, ['form' => $this->formProjection($form)]);
        });
    }

    public function destroyForm(Request $request, int $leadForm): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $actor = $this->executionAdmin($request);
        $payload = $request->validate(['expected_updated_at' => ['required', 'string', 'max:80']]);

        return IdempotencyService::executeJson($request, 'DELETE /lead-forms/{id}', function () use ($request, $actor, $payload, $leadForm): JsonResponse {
            $form = LeadForm::query()->withCount('submissions')->whereKey($leadForm)->lockForUpdate()->first();
            if (! $form instanceof LeadForm) {
                throw new ApiException('lead_form_not_found', '线索表单不存在', 404);
            }
            $this->assertVersion($form, (string) $payload['expected_updated_at'], 'lead_form_conflict');
            if ((int) $form->submissions_count > 0) {
                throw new ApiException('lead_form_has_submissions', '已有线索的表单不能删除，可改为停用', 409, [
                    'submissions_count' => (int) $form->submissions_count,
                ]);
            }
            $id = (int) $form->id;
            $name = (string) $form->name;
            $form->delete();
            $this->audit($request, $actor, 'api.lead_form.delete', 'lead_form', $id, ['name' => $name]);

            return $this->success($request, ['deleted' => true, 'id' => $id]);
        });
    }

    public function leads(Request $request): JsonResponse
    {
        $this->executionAdmin($request);
        $perPage = min(100, max(1, (int) $request->query('per_page', 20)));
        $paginator = $this->filteredLeads($request)
            ->with(['form:id,name,slug,fields', 'handler:id,username', 'hostedSiteProfile:id,hostname'])
            ->orderByDesc('created_at')
            ->orderByDesc('id')
            ->paginate($perPage);

        return $this->success($request, [
            'items' => collect($paginator->items())->map(fn (LeadSubmission $lead): array => $this->leadProjection($lead, false))->all(),
            'stats' => [
                'total' => LeadSubmission::query()->count(),
                'new' => LeadSubmission::query()->where('status', LeadSubmission::STATUS_NEW)->count(),
                'pending' => LeadSubmission::query()->whereIn('status', [LeadSubmission::STATUS_NEW, LeadSubmission::STATUS_CONTACTED])->count(),
                'converted' => LeadSubmission::query()->where('status', LeadSubmission::STATUS_CONVERTED)->count(),
            ],
            'statuses' => LeadSubmission::STATUSES,
            'forms' => LeadForm::query()->orderBy('name')->get(['id', 'name'])->map(fn (LeadForm $form): array => [
                'id' => (int) $form->id,
                'name' => (string) $form->name,
            ])->all(),
            'pagination' => $this->pagination($paginator),
        ]);
    }

    public function lead(Request $request, int $lead): JsonResponse
    {
        $this->executionAdmin($request);
        $submission = LeadSubmission::query()
            ->with(['form:id,name,slug,fields', 'handler:id,username', 'hostedSiteProfile:id,hostname'])
            ->whereKey($lead)
            ->first();
        if (! $submission instanceof LeadSubmission) {
            throw new ApiException('lead_not_found', '线索不存在', 404);
        }

        return $this->success($request, ['lead' => $this->leadProjection($submission, true)]);
    }

    public function updateLead(Request $request, int $lead): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $actor = $this->executionAdmin($request);
        $payload = $request->validate([
            'status' => ['required', Rule::in(LeadSubmission::STATUSES)],
            'note' => ['nullable', 'string', 'max:5000'],
            'expected_updated_at' => ['required', 'string', 'max:80'],
        ]);

        return IdempotencyService::executeJson($request, 'PATCH /leads/{id}', function () use ($request, $actor, $payload, $lead): JsonResponse {
            $submission = LeadSubmission::query()->whereKey($lead)->lockForUpdate()->first();
            if (! $submission instanceof LeadSubmission) {
                throw new ApiException('lead_not_found', '线索不存在', 404);
            }
            $this->assertVersion($submission, (string) $payload['expected_updated_at'], 'lead_conflict');
            $previousStatus = (string) $submission->status;
            $submission->forceFill([
                'status' => (string) $payload['status'],
                'note' => trim((string) ($payload['note'] ?? '')),
                'handled_by' => (int) $actor->id,
                'handled_at' => now(),
            ])->save();
            $submission->refresh()->load(['form:id,name,slug,fields', 'handler:id,username', 'hostedSiteProfile:id,hostname']);
            $this->audit($request, $actor, 'api.lead.update', 'lead_submission', (int) $submission->id, [
                'previous_status' => $previousStatus,
                'status' => (string) $submission->status,
                'note_changed' => true,
            ]);

            return $this->success($request, ['lead' => $this->leadProjection($submission, true)]);
        });
    }

    public function exportLeads(Request $request): StreamedResponse
    {
        $actor = $this->executionAdmin($request);
        $query = $this->filteredLeads($request);
        $this->audit($request, $actor, 'api.lead.export', 'lead_submission', null, [
            'filters' => array_keys(array_filter($request->only(['status', 'form_id', 'date_from', 'date_to', 'search']), fn (mixed $value): bool => trim((string) $value) !== '')),
        ]);
        $filename = 'geoflow-leads-'.now()->format('Ymd-His').'.csv';

        return response()->streamDownload(function () use ($query): void {
            $handle = fopen('php://output', 'w');
            if ($handle === false) {
                return;
            }
            fwrite($handle, "\xEF\xBB\xBF");
            fputcsv($handle, ['ID', 'Form', 'Status', 'Payload', 'Source URL', 'Note', 'Created At']);
            $query->chunkById(200, function ($rows) use ($handle): void {
                $rows->load('form:id,name');
                foreach ($rows as $row) {
                    if (! $row instanceof LeadSubmission) {
                        continue;
                    }
                    fputcsv($handle, [
                        $row->id,
                        $this->csvCell($row->form?->name ?? ''),
                        $this->csvCell($row->status),
                        $this->csvCell(json_encode($row->payload ?? [], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)),
                        $this->csvCell($row->source_url ?? ''),
                        $this->csvCell($row->note ?? ''),
                        $this->csvCell($row->created_at?->format('Y-m-d H:i:s') ?? ''),
                    ]);
                }
            });
        }, $filename, ['Content-Type' => 'text/csv; charset=UTF-8']);
    }

    /** @return array<string,mixed> */
    private function validateFormPayload(Request $request, ?int $ignoreId, bool $updating): array
    {
        $presence = $updating ? 'sometimes' : 'required';
        $rules = [
            'name' => [$presence, 'string', 'max:120'],
            'slug' => ['sometimes', 'nullable', 'string', 'max:120', 'regex:/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/', Rule::unique('lead_forms', 'slug')->ignore($ignoreId)],
            'status' => ['sometimes', Rule::in([LeadForm::STATUS_ACTIVE, LeadForm::STATUS_INACTIVE])],
            'description' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'submit_button_label' => ['sometimes', 'nullable', 'string', 'max:80'],
            'success_message' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'fields' => [$presence, 'array', 'min:1', 'max:50'],
            'fields.*.label' => ['required', 'string', 'max:120'],
            'fields.*.name' => ['nullable', 'string', 'max:60'],
            'fields.*.type' => ['required', Rule::in(LeadForm::FIELD_TYPES)],
            'fields.*.required' => ['sometimes', 'boolean'],
            'fields.*.options' => ['sometimes', 'nullable', 'array', 'max:20'],
            'fields.*.options.*' => ['string', 'max:200'],
        ];
        if ($updating) {
            $rules['expected_updated_at'] = ['required', 'string', 'max:80'];
        }

        return $request->validate($rules);
    }

    private function uniqueSlug(string $slug, string $name, ?LeadForm $current = null): string
    {
        $base = trim($slug) !== '' ? trim($slug) : Str::slug($name);
        $base = Str::lower($base !== '' ? $base : Str::random(8));
        $candidate = $base;
        $suffix = 2;
        while (LeadForm::query()->where('slug', $candidate)->when($current, fn (Builder $query) => $query->whereKeyNot($current->id))->exists()) {
            $candidate = $base.'-'.$suffix++;
        }

        return $candidate;
    }

    private function filteredLeads(Request $request): Builder
    {
        $query = LeadSubmission::query();
        $status = trim((string) $request->query('status', ''));
        if (in_array($status, LeadSubmission::STATUSES, true)) {
            $query->where('status', $status);
        }
        $formId = (int) $request->query('form_id', 0);
        if ($formId > 0) {
            $query->where('lead_form_id', $formId);
        }
        if (($date = $this->dateFilter($request->query('date_from'))) !== null) {
            $query->whereDate('created_at', '>=', $date);
        }
        if (($date = $this->dateFilter($request->query('date_to'))) !== null) {
            $query->whereDate('created_at', '<=', $date);
        }
        $search = trim((string) $request->query('search', ''));
        if ($search !== '') {
            $like = '%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], mb_strtolower($search)).'%';
            $payloadExpression = match (DB::connection()->getDriverName()) {
                'mysql', 'mariadb' => 'LOWER(CAST(payload AS CHAR))',
                'sqlsrv' => 'LOWER(CAST(payload AS NVARCHAR(MAX)))',
                default => 'LOWER(CAST(payload AS TEXT))',
            };
            $query->where(function (Builder $inner) use ($like, $payloadExpression): void {
                $inner->whereRaw('LOWER(COALESCE(source_url, ?)) LIKE ?', ['', $like])
                    ->orWhereRaw($payloadExpression.' LIKE ?', [$like])
                    ->orWhereRaw('LOWER(COALESCE(note, ?)) LIKE ?', ['', $like]);
            });
        }

        return $query;
    }

    /** @return array<string,mixed> */
    private function formProjection(LeadForm $form): array
    {
        return [
            'id' => (int) $form->id,
            'name' => (string) $form->name,
            'slug' => (string) $form->slug,
            'status' => (string) $form->status,
            'description' => (string) ($form->description ?? ''),
            'submit_button_label' => (string) $form->submit_button_label,
            'success_message' => (string) ($form->success_message ?? ''),
            'fields' => $form->normalizedFields(),
            'submissions_count' => (int) ($form->submissions_count ?? 0),
            'public_path' => '/forms/'.rawurlencode((string) $form->slug),
            'created_at' => $form->created_at?->toIso8601String(),
            'updated_at' => $this->version($form),
        ];
    }

    /** @return array<string,mixed> */
    private function leadProjection(LeadSubmission $lead, bool $detail): array
    {
        $data = [
            'id' => (int) $lead->id,
            'status' => (string) $lead->status,
            'payload' => is_array($lead->payload) ? $lead->payload : [],
            'source_url' => (string) ($lead->source_url ?? ''),
            'note' => (string) ($lead->note ?? ''),
            'form' => $lead->form ? [
                'id' => (int) $lead->form->id,
                'name' => (string) $lead->form->name,
                'slug' => (string) $lead->form->slug,
                'fields' => $lead->form->normalizedFields(),
            ] : null,
            'hosted_site' => $lead->hostedSiteProfile ? [
                'id' => (int) $lead->hostedSiteProfile->id,
                'hostname' => (string) $lead->hostedSiteProfile->hostname,
            ] : null,
            'handler' => $lead->handler ? [
                'id' => (int) $lead->handler->id,
                'username' => (string) $lead->handler->username,
            ] : null,
            'handled_at' => $lead->handled_at?->toIso8601String(),
            'created_at' => $lead->created_at?->toIso8601String(),
            'updated_at' => $this->version($lead),
        ];
        if ($detail) {
            $data['ip_address'] = (string) $lead->ip_address;
            $data['user_agent'] = (string) ($lead->user_agent ?? '');
        }

        return $data;
    }

    private function assertVersion(LeadForm|LeadSubmission $record, string $expected, string $code): void
    {
        if (! hash_equals($this->version($record), trim($expected))) {
            throw new ApiException($code, '记录已被其他操作更新，请刷新后重试', 409, [
                'current_updated_at' => $this->version($record),
            ]);
        }
    }

    private function version(LeadForm|LeadSubmission $record): string
    {
        return $record->updated_at?->format('Y-m-d\TH:i:s.uP') ?? '';
    }

    /** @return array<string,int> */
    private function pagination(object $paginator): array
    {
        return [
            'page' => (int) $paginator->currentPage(),
            'per_page' => (int) $paginator->perPage(),
            'total' => (int) $paginator->total(),
            'total_pages' => (int) $paginator->lastPage(),
        ];
    }

    private function dateFilter(mixed $value): ?string
    {
        $date = trim((string) $value);
        if ($date === '') {
            return null;
        }
        try {
            $parsed = Carbon::createFromFormat('!Y-m-d', $date);

            return $parsed->toDateString() === $date ? $date : null;
        } catch (\Throwable) {
            return null;
        }
    }

    private function csvCell(mixed $value): string
    {
        $cell = is_string($value) ? $value : (string) $value;

        return $cell !== '' && preg_match('/^[=+\-@\t\r]/', $cell) === 1 ? "'".$cell : $cell;
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }

    /** @param array<string,mixed> $details */
    private function audit(Request $request, Admin $actor, string $action, string $targetType, ?int $targetId, array $details): void
    {
        AdminActivityLogger::log($actor, $action, [
            'request_method' => $request->method(),
            'page' => trim($request->path(), '/'),
            'target_type' => $targetType,
            'target_id' => $targetId,
            'ip_address' => (string) ($request->ip() ?? ''),
            'details' => $details,
        ]);
    }
}
