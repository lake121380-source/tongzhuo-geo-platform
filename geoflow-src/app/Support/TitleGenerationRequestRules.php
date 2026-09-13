<?php

namespace App\Support;

use App\Http\Controllers\Api\V1\TitleGenerationApiController;
use App\Http\Requests\Admin\GenerateTitlesWithAiRequest;
use App\Models\KeywordLibrary;
use Closure;
use Illuminate\Contracts\Validation\Factory as ValidationFactory;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

/**
 * 标题库 AI 生成的提交校验。
 *
 * 旧 Blade 后台（{@see GenerateTitlesWithAiRequest}）与 api/v1
 * （{@see TitleGenerationApiController}）共用这一份规则。
 *
 * 这里有两道「花钱之前必须有人点头」的门禁，**不能由两个入口各自实现一遍**：
 * ① 目标数量超过 `geoflow.title_ai_confirmation_threshold` 时必须显式确认；
 * ② 目标数量超过关键词库实际词数时必须确认「允许复用关键词」。
 * 两边一旦漂移，就会出现「后台拦得住、API 拦不住」的缺口。
 */
final class TitleGenerationRequestRules
{
    /** @var list<string> */
    public const STYLES = ['professional', 'attractive', 'seo', 'creative', 'question'];

    public static function maxTitleCount(): int
    {
        return (int) config('geoflow.title_ai_max_count', 100_000);
    }

    public static function confirmationThreshold(): int
    {
        return (int) config('geoflow.title_ai_confirmation_threshold', 1000);
    }

    /**
     * 供不经过 FormRequest 的入口（api/v1）直接构造校验器。
     *
     * @param  array<string, mixed>  $input
     */
    public static function validator(array $input): Validator
    {
        $validator = app(ValidationFactory::class)->make($input, self::rules($input), self::messages());
        $validator->after(self::after());

        return $validator;
    }

    /**
     * @param  array<string, mixed>  $input
     * @return array<string, list<mixed>>
     */
    public static function rules(array $input): array
    {
        $requiresLargeRunConfirmation = self::submittedTitleCount($input) > self::confirmationThreshold();

        return [
            'keyword_library_id' => ['required', 'integer', 'exists:keyword_libraries,id'],
            'ai_model_id' => [
                'required',
                'integer',
                Rule::exists('ai_models', 'id')->where(static function ($query): void {
                    $query->where('status', 'active')
                        ->whereRaw("COALESCE(NULLIF(model_type, ''), 'chat') = 'chat'");
                }),
            ],
            'title_count' => ['required', 'integer', 'min:1', 'max:'.self::maxTitleCount()],
            'title_style' => ['required', Rule::in(self::STYLES)],
            'custom_prompt' => ['nullable', 'string', 'max:5000'],
            'confirmed_large_run' => $requiresLargeRunConfirmation
                ? ['required', 'accepted']
                : ['nullable'],
            'confirmed_keyword_reuse' => ['nullable', Rule::in([0, 1, '0', '1'])],
        ];
    }

    /** @return array<string, string> */
    public static function messages(): array
    {
        return [
            'keyword_library_id.required' => __('admin.title_ai_generate.error.keyword_library_required'),
            'keyword_library_id.exists' => __('admin.title_ai_generate.error.keyword_library_missing'),
            'ai_model_id.required' => __('admin.title_ai_generate.error.ai_model_required'),
            'ai_model_id.exists' => __('admin.title_ai_generate.error.ai_model_missing'),
            'title_count.min' => __('admin.title_ai_generate.error.invalid_count', ['max' => self::maxTitleCount()]),
            'title_count.max' => __('admin.title_ai_generate.error.invalid_count', ['max' => self::maxTitleCount()]),
            'confirmed_large_run.required' => __('admin.title_ai_generate.error.large_run_confirmation_required'),
            'confirmed_large_run.accepted' => __('admin.title_ai_generate.error.large_run_confirmation_required'),
            'confirmed_keyword_reuse.in' => __('admin.title_ai_generate.error.keyword_reuse_confirmation_required'),
        ];
    }

    /**
     * 「目标数量 > 关键词库词数」这一条要查库，必须放在 after 里：
     * 前面的字段校验没过时不能再去查。
     */
    public static function after(): Closure
    {
        return static function (Validator $validator): void {
            $data = $validator->getData();
            if (! is_array($data) || $validator->errors()->hasAny(['keyword_library_id', 'title_count'])) {
                return;
            }

            $libraryId = $data['keyword_library_id'] ?? null;
            if (! is_int($libraryId) && ! (is_string($libraryId) && ctype_digit($libraryId))) {
                return;
            }

            $keywordLibrary = KeywordLibrary::query()
                ->select('id')
                ->withCount('keywords')
                ->find((int) $libraryId);
            if ($keywordLibrary === null) {
                return;
            }

            $keywordCount = (int) $keywordLibrary->keywords_count;
            if ($keywordCount > 0
                && self::submittedTitleCount($data) > $keywordCount
                && ! self::confirmed($data['confirmed_keyword_reuse'] ?? null)) {
                $validator->errors()->add(
                    'confirmed_keyword_reuse',
                    __('admin.title_ai_generate.error.keyword_reuse_confirmation_required'),
                );
            }
        };
    }

    /** @param array<string, mixed> $input */
    private static function submittedTitleCount(array $input): int
    {
        $value = $input['title_count'] ?? null;

        return is_int($value) || is_string($value) || is_float($value) ? (int) $value : 0;
    }

    private static function confirmed(mixed $value): bool
    {
        return in_array($value, [1, '1', true], true);
    }
}
