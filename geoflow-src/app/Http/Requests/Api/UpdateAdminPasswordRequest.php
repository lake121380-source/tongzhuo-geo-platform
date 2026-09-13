<?php

namespace App\Http\Requests\Api;

use App\Exceptions\ApiException;
use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;

/**
 * Validate an administrator's self-service password change.
 *
 * The request deliberately exposes only the three password fields.  The
 * controller never accepts account identity, role or status fields from this
 * endpoint, so a compromised client cannot turn a password change into an
 * account mutation.
 */
final class UpdateAdminPasswordRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, list<mixed>> */
    public function rules(): array
    {
        return [
            'current_password' => ['required', 'string'],
            'password' => ['required', 'string', 'min:8', 'confirmed'],
            'password_confirmation' => ['required', 'string'],
        ];
    }

    /**
     * Every API FormRequest returns the same error envelope as controller
     * failures.  Do not allow Laravel's default HTML/redirect response here.
     */
    protected function failedValidation(Validator $validator): never
    {
        throw new ApiException('validation_failed', '参数校验失败', 422, [
            'field_errors' => collect($validator->errors()->messages())
                ->map(static fn (array $messages): string => (string) ($messages[0] ?? 'Invalid value.'))
                ->all(),
        ]);
    }

    /**
     * Password changes are mutations and must be replay-safe.  Requiring the
     * key at validation time also means malformed calls fail before the
     * controller can touch the account row.
     */
    protected function passedValidation(): void
    {
        $key = $this->header('X-Idempotency-Key');
        if (! is_string($key) || trim($key) === '') {
            throw new ApiException('idempotency_key_required', '密码修改必须提供 X-Idempotency-Key', 422);
        }
        if (strlen($key) > 120 || preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]*$/D', $key) !== 1) {
            throw new ApiException('invalid_idempotency_key', 'X-Idempotency-Key 格式无效', 422);
        }
    }
}
