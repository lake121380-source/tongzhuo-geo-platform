<?php

namespace App\Http\Requests\Api;

use App\Exceptions\ApiException;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;

/**
 * Validate a URL-import request before the importer performs any outbound
 * request.  The importer applies the SSRF/allow-list policy again when it
 * normalizes the URL; this request only handles shape and size limits.
 */
final class StoreUrlImportRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'url' => ['required', 'string', 'max:2048'],
            'project_name' => ['sometimes', 'nullable', 'string', 'max:120'],
            'source_label' => ['sometimes', 'nullable', 'string', 'max:120'],
            'content_language' => ['sometimes', 'nullable', 'string', 'max:20'],
            'notes' => ['sometimes', 'nullable', 'string', 'max:1000'],
            'outputs' => ['sometimes', 'array', 'min:1', 'max:3'],
            'outputs.*' => ['string', 'distinct', 'in:knowledge,keywords,titles'],
        ];
    }

    /**
     * URL 导入会创建异步任务，调用方必须提供幂等键，避免网络重试
     * 意外创建多个相同任务。校验方式与其它 API 写请求保持一致。
     */
    protected function passedValidation(): void
    {
        $key = $this->header('X-Idempotency-Key');
        if (! is_string($key) || $key === '') {
            throw new ApiException(
                'idempotency_key_required',
                'URL 导入必须提供 X-Idempotency-Key',
                422,
            );
        }
        if (strlen($key) > 120 || preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]*$/D', $key) !== 1) {
            throw new ApiException('invalid_idempotency_key', 'X-Idempotency-Key 格式无效', 422);
        }
    }

    protected function failedValidation(Validator $validator): never
    {
        $fieldErrors = collect($validator->errors()->messages())
            ->map(static fn (array $messages): string => (string) ($messages[0] ?? 'Invalid value.'))
            ->all();

        throw new ApiException('validation_failed', '参数校验失败', 422, [
            'field_errors' => $fieldErrors,
        ]);
    }
}
