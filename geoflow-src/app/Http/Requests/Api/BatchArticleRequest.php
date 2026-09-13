<?php

namespace App\Http\Requests\Api;

use App\Exceptions\ApiException;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;

class BatchArticleRequest extends FormRequest
{
    public const MAX_ARTICLES = 100;

    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string,list<mixed>> */
    public function rules(): array
    {
        return [
            'article_ids' => ['required', 'array', 'min:1', 'max:'.self::MAX_ARTICLES],
            'article_ids.*' => ['bail', 'required', 'integer', 'min:1', 'distinct'],
        ];
    }

    /** @return array<string,string> */
    public function messages(): array
    {
        return [
            'article_ids.required' => '请选择至少一篇文章',
            'article_ids.array' => 'article_ids 必须是数组',
            'article_ids.min' => '请选择至少一篇文章',
            'article_ids.max' => '单次最多处理 '.self::MAX_ARTICLES.' 篇文章',
            'article_ids.*.required' => '文章 ID 不能为空',
            'article_ids.*.integer' => '文章 ID 必须是正整数',
            'article_ids.*.min' => '文章 ID 必须是正整数',
            'article_ids.*.distinct' => '文章 ID 不能重复',
        ];
    }

    /** @return list<callable> */
    public function after(): array
    {
        return [
            function (Validator $validator): void {
                $ids = $this->input('article_ids');
                if (is_array($ids) && ! array_is_list($ids)) {
                    $validator->errors()->add('article_ids', 'article_ids 必须是从 0 开始的 ID 列表');
                }
            },
        ];
    }

    protected function passedValidation(): void
    {
        $key = $this->header('X-Idempotency-Key');
        if (! is_string($key) || $key === '') {
            throw new ApiException(
                'idempotency_key_required',
                '批量操作必须提供 X-Idempotency-Key',
                422,
            );
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
