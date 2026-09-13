<?php

namespace App\Http\Requests\Api;

use Illuminate\Validation\Rule;

class BatchReviewArticlesRequest extends BatchArticleRequest
{
    /** @return array<string,list<mixed>> */
    public function rules(): array
    {
        return array_merge(parent::rules(), [
            'review_status' => [
                'required',
                'string',
                Rule::in(['pending', 'approved', 'rejected', 'auto_approved']),
            ],
            'review_note' => ['sometimes', 'nullable', 'string', 'max:5000'],
            'risk_override_reason' => ['sometimes', 'nullable', 'string', 'max:1000'],
        ]);
    }

    /** @return array<string,string> */
    public function messages(): array
    {
        return array_merge(parent::messages(), [
            'review_status.required' => '请选择审核状态',
            'review_status.in' => '审核状态无效',
            'review_note.string' => '审核备注必须是字符串',
            'review_note.max' => '审核备注不能超过 5000 个字符',
            'risk_override_reason.string' => '风险放行原因必须是字符串',
            'risk_override_reason.max' => '风险放行原因不能超过 1000 个字符',
        ]);
    }
}
