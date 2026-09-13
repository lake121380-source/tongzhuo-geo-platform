<?php

namespace App\Support;

use App\Http\Controllers\Api\V1\ManualPublicationSettingsApiController;
use App\Models\ManualPublicationAccount;
use App\Models\ManualPublicationPersona;
use Illuminate\Validation\Rule;

/**
 * 发布账号 / 人设的校验规则。
 *
 * 旧 Blade 后台（`SaveManualPublicationPersonaRequest` / `SaveManualPublicationAccountRequest`）
 * 与 api/v1（{@see ManualPublicationSettingsApiController}）
 * 共用这一份。
 *
 * 抽出来的直接原因：两边**各写了一遍而且写歪了**，偏差不是风格问题，是会出错的：
 * - `account_name` 列宽 160，api/v1 却允许 255 → 超长名字过完校验再撞库，接口 500；
 * - `profile_url` 列宽 1000，api/v1 只允许 500 → 旧后台能存的 URL 新接口拒收；
 * - `custom_platform` 的「平台选自定义时必填」与 URL 格式校验，api/v1 整个漏了。
 *
 * **规则的权威是数据库列宽**，不是任何一边的实现。
 */
final class ManualPublicationSettingsRules
{
    /** @return array<string, list<mixed>> */
    public static function persona(): array
    {
        return [
            'name' => ['required', 'string', 'max:120'],
            'bio' => ['nullable', 'string', 'max:5000'],
            'tone' => ['nullable', 'string', 'max:120'],
            'domain' => ['nullable', 'string', 'max:255'],
            'disclosure_text' => ['nullable', 'string', 'max:2000'],
            'is_active' => ['nullable', 'boolean'],
        ];
    }

    /**
     * @param  array<string, mixed>  $input  用来判定 `custom_platform` 是否必填
     * @return array<string, list<mixed>>
     */
    public static function account(array $input = []): array
    {
        $platform = $input['platform'] ?? null;

        return [
            'persona_id' => [
                'required',
                'integer',
                Rule::exists((new ManualPublicationPersona)->getTable(), 'id'),
            ],
            'platform' => ['required', Rule::in(ManualPublicationAccount::PLATFORMS)],
            'custom_platform' => [
                'nullable',
                // 选了「自定义」却不写平台名，存下来的账号在界面上没有可读名字。
                Rule::requiredIf(static fn (): bool => $platform === ManualPublicationAccount::PLATFORM_CUSTOM),
                'string',
                'max:120',
            ],
            'account_name' => ['required', 'string', 'max:160'],
            'profile_url' => ['nullable', 'url:http,https', 'max:1000'],
            'notes' => ['nullable', 'string', 'max:5000'],
            'is_active' => ['nullable', 'boolean'],
        ];
    }

    /**
     * 归一化成入库用的字段（两边共用的裁剪规则）。
     *
     * @param  array<string, mixed>  $data
     * @return array<string, mixed>
     */
    public static function normalizePersona(array $data, bool $isActive): array
    {
        return [
            'name' => trim((string) $data['name']),
            'bio' => trim((string) ($data['bio'] ?? '')) ?: null,
            'tone' => trim((string) ($data['tone'] ?? '')) ?: null,
            'domain' => trim((string) ($data['domain'] ?? '')) ?: null,
            'disclosure_text' => trim((string) ($data['disclosure_text'] ?? '')) ?: null,
            'is_active' => $isActive,
        ];
    }

    /**
     * @param  array<string, mixed>  $data
     * @return array<string, mixed>
     */
    public static function normalizeAccount(array $data, bool $isActive): array
    {
        return [
            'persona_id' => (int) $data['persona_id'],
            'platform' => (string) $data['platform'],
            'custom_platform' => trim((string) ($data['custom_platform'] ?? '')) ?: null,
            'account_name' => trim((string) $data['account_name']),
            'profile_url' => trim((string) ($data['profile_url'] ?? '')) ?: null,
            'notes' => trim((string) ($data['notes'] ?? '')) ?: null,
            'is_active' => $isActive,
        ];
    }
}
