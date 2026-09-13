<?php

namespace App\Http\Requests\Admin;

use App\Models\Admin;
use App\Support\TitleGenerationRequestRules;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;

class GenerateTitlesWithAiRequest extends FormRequest
{
    /** @var list<string> */
    private array $nonScalarInputFields = [];

    protected function prepareForValidation(): void
    {
        $this->nonScalarInputFields = [];

        $normalized = [];
        foreach (['title_count', 'custom_prompt'] as $field) {
            $value = $this->input($field);
            if ($value !== null && ! is_string($value) && ! is_int($value) && ! is_float($value)) {
                $this->nonScalarInputFields[] = $field;
                $value = null;
            }

            $normalized[$field] = $value;
        }

        $this->merge($normalized);
    }

    public function authorize(): bool
    {
        return $this->user('admin') instanceof Admin;
    }

    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return TitleGenerationRequestRules::rules($this->all());
    }

    /** @return list<callable(Validator): void> */
    public function after(): array
    {
        return [
            function (Validator $validator): void {
                foreach ($this->nonScalarInputFields as $field) {
                    $validator->errors()->add(
                        $field,
                        __('validation.string', ['attribute' => str_replace('_', ' ', $field)]),
                    );
                }
            },
            TitleGenerationRequestRules::after(),
        ];
    }

    /** @return array<string, string> */
    public function messages(): array
    {
        return TitleGenerationRequestRules::messages();
    }
}
