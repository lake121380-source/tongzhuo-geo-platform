<?php

namespace App\Http\Requests\Api;

use App\Exceptions\ApiException;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;

/**
 * 标题库就绪度预检请求。
 *
 * 旧后台通过 POST 表单提交同一组字段；API 使用 GET query，但校验和
 * 业务含义保持一致，避免前端自行复制标题数量/循环任务规则。
 */
class TaskTitleReadinessRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string,list<mixed>> */
    public function rules(): array
    {
        return [
            'title_library_id' => ['required', 'integer', 'min:1', 'exists:title_libraries,id'],
            'article_limit' => ['required', 'integer', 'min:1', 'max:99999'],
            'is_loop' => ['required', 'boolean'],
            'status' => ['required', 'string', 'in:active,paused'],
            'task_id' => ['sometimes', 'nullable', 'integer', 'min:1', 'exists:tasks,id'],
        ];
    }

    protected function failedValidation(Validator $validator): never
    {
        $fieldErrors = collect($validator->errors()->messages())
            ->map(fn (array $messages): string => (string) ($messages[0] ?? 'Invalid value.'))
            ->all();

        throw new ApiException('validation_failed', '参数校验失败', 422, [
            'field_errors' => $fieldErrors,
        ]);
    }
}
