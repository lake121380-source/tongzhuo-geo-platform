<?php

namespace App\Http\Requests\Api;

use Illuminate\Validation\Rule;

/**
 * 批量改文章状态（旧后台 `articles/batch/update-status` 的 API 等价物）。
 *
 * 继承 `BatchArticleRequest`，因此**幂等键校验、ID 列表校验、错误信封形状全部沿用**，
 * 只多两个字段。目标状态只允许 draft / published / private——与旧后台一致。
 */
class BatchUpdateArticleStatusRequest extends BatchArticleRequest
{
    /** @return array<string,list<mixed>> */
    public function rules(): array
    {
        return array_merge(parent::rules(), [
            'new_status' => ['required', 'string', Rule::in(['draft', 'published', 'private'])],
            'risk_override_reason' => ['nullable', 'string', 'max:500'],
        ]);
    }

    /** @return array<string,string> */
    public function messages(): array
    {
        return array_merge(parent::messages(), [
            'new_status.required' => '请选择目标状态',
            'new_status.in' => '目标状态只能是 draft / published / private',
        ]);
    }
}
