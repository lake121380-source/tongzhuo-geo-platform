<?php

namespace App\Http\Requests\Api;

use App\Exceptions\ApiException;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;

final class StoreUrlScanRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string,list<mixed>> */
    public function rules(): array
    {
        return ['url' => ['required', 'string', 'max:2048']];
    }

    protected function passedValidation(): void
    {
        $key = $this->header('X-Idempotency-Key');
        if (! is_string($key) || trim($key) === '') {
            throw new ApiException('idempotency_key_required', 'URL 扫描必须提供 X-Idempotency-Key', 422);
        }
        if (strlen($key) > 120 || preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]*$/D', $key) !== 1) {
            throw new ApiException('invalid_idempotency_key', 'X-Idempotency-Key 格式无效', 422);
        }
    }

    protected function failedValidation(Validator $validator): never
    {
        throw new ApiException('validation_failed', '参数校验失败', 422, [
            'field_errors' => collect($validator->errors()->messages())
                ->map(static fn (array $messages): string => (string) ($messages[0] ?? 'Invalid value.'))
                ->all(),
        ]);
    }
}
