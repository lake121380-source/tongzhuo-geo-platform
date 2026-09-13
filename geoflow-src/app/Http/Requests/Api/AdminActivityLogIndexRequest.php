<?php

namespace App\Http\Requests\Api;

use App\Exceptions\ApiException;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;

class AdminActivityLogIndexRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'admin_id' => ['nullable', 'integer', 'min:1'],
            'search' => ['nullable', 'string', 'max:120'],
            'action' => ['nullable', 'string', 'max:120', 'regex:/\A[a-z0-9._:-]+\z/iD'],
            'date_from' => ['nullable', 'date_format:Y-m-d'],
            'date_to' => ['nullable', 'date_format:Y-m-d'],
            'page' => ['nullable', 'integer', 'min:1'],
            'per_page' => ['nullable', 'integer', 'min:1', 'max:100'],
        ];
    }

    /** @return list<callable> */
    public function after(): array
    {
        return [
            function (Validator $validator): void {
                $from = $this->input('date_from');
                $to = $this->input('date_to');
                if (is_string($from) && is_string($to) && $from > $to) {
                    $validator->errors()->add('date_to', '结束日期不能早于开始日期');
                }
            },
        ];
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
