<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Models\ManualPublicationAccount;
use App\Models\ManualPublicationPersona;
use App\Services\Api\IdempotencyService;
use App\Support\ManualPublicationSettingsRules;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Bearer 版的发布账号与人设管理。
 *
 * **注意**：旧的 `SaveManualPublicationPersonaRequest` / `SaveManualPublicationAccountRequest`
 * 的 `authorize()` 读的是 `$this->user('admin')`——在 Bearer 上下文里那是 **null**，
 * 直接复用会一律 403。所以这里自己判超管，并复用同一套字段规则与同样的归一化。
 * 这两个模型也是**超管专属**（旧后台的 FormRequest 就是这么限的），不放松。
 */
final class ManualPublicationSettingsApiController extends BaseApiController
{
    /** 人设 + 账号列表（供 `-AI` 的设置面板渲染）。 */
    public function index(Request $request): JsonResponse
    {
        $this->requireSuperAdmin($request);

        return $this->success($request, [
            'personas' => ManualPublicationPersona::query()
                ->withCount('accounts')
                ->orderByDesc('is_active')
                ->orderBy('name')
                ->get()
                ->map(static fn (ManualPublicationPersona $persona): array => [
                    'id' => (int) $persona->id,
                    'name' => (string) $persona->name,
                    'bio' => (string) ($persona->bio ?? ''),
                    'tone' => (string) ($persona->tone ?? ''),
                    'domain' => (string) ($persona->domain ?? ''),
                    'disclosure_text' => (string) ($persona->disclosure_text ?? ''),
                    'is_active' => (bool) $persona->is_active,
                    'accounts_count' => (int) ($persona->accounts_count ?? 0),
                ])->values()->all(),
            'accounts' => ManualPublicationAccount::query()
                ->with('persona:id,name')
                ->orderByDesc('is_active')
                ->orderBy('account_name')
                ->get()
                ->map(static fn (ManualPublicationAccount $account): array => [
                    'id' => (int) $account->id,
                    'persona_id' => (int) $account->persona_id,
                    'persona_name' => (string) ($account->persona?->name ?? ''),
                    'platform' => (string) $account->platform,
                    'custom_platform' => (string) ($account->custom_platform ?? ''),
                    'account_name' => (string) $account->account_name,
                    'profile_url' => (string) ($account->profile_url ?? ''),
                    'notes' => (string) ($account->notes ?? ''),
                    'is_active' => (bool) $account->is_active,
                ])->values()->all(),
            'platforms' => ManualPublicationAccount::PLATFORMS,
        ]);
    }

    public function storePersona(Request $request): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->requireSuperAdmin($request);
        $payload = $this->validatePersona($request);

        return IdempotencyService::executeJson($request, 'POST /manual-publications/settings/personas', function () use ($request, $admin, $payload): JsonResponse {
            $persona = ManualPublicationPersona::query()->create($payload + [
                'created_by_admin_id' => (int) $admin->getKey(),
            ]);

            return $this->success($request, ['persona_id' => (int) $persona->id], 201);
        });
    }

    public function updatePersona(Request $request, int $persona): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->requireSuperAdmin($request);
        $payload = $this->validatePersona($request);

        return IdempotencyService::executeJson($request, 'PATCH /manual-publications/settings/personas/{persona}', function () use ($request, $persona, $payload): JsonResponse {
            $row = ManualPublicationPersona::query()->whereKey($persona)->first();
            if (! $row instanceof ManualPublicationPersona) {
                throw new ApiException('persona_not_found', '发布人设不存在', 404);
            }
            $row->update($payload);

            return $this->success($request, ['persona_id' => (int) $row->id]);
        });
    }

    public function storeAccount(Request $request): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->requireSuperAdmin($request);
        $payload = $this->validateAccount($request);

        return IdempotencyService::executeJson($request, 'POST /manual-publications/settings/accounts', function () use ($request, $admin, $payload): JsonResponse {
            $account = ManualPublicationAccount::query()->create($payload + [
                'created_by_admin_id' => (int) $admin->getKey(),
            ]);

            return $this->success($request, ['account_id' => (int) $account->id], 201);
        });
    }

    public function updateAccount(Request $request, int $account): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->requireSuperAdmin($request);
        $payload = $this->validateAccount($request);

        return IdempotencyService::executeJson($request, 'PATCH /manual-publications/settings/accounts/{account}', function () use ($request, $account, $payload): JsonResponse {
            $row = ManualPublicationAccount::query()->whereKey($account)->first();
            if (! $row instanceof ManualPublicationAccount) {
                throw new ApiException('account_not_found', '发布账号不存在', 404);
            }
            $row->update($payload);

            return $this->success($request, ['account_id' => (int) $row->id]);
        });
    }

    /** @return array<string, mixed> */
    private function validatePersona(Request $request): array
    {
        // 规则与归一化都来自共享类——两边各写一遍曾导致 account_name 允许 255 却撞 160 的列。
        $data = $request->validate(ManualPublicationSettingsRules::persona());

        return ManualPublicationSettingsRules::normalizePersona($data, $request->boolean('is_active'));
    }

    private function validateAccount(Request $request): array
    {
        // 规则与归一化都来自共享类——两边各写一遍曾导致 account_name 允许 255 却撞 160 的列。
        $data = $request->validate(ManualPublicationSettingsRules::account($request->all()));

        return ManualPublicationSettingsRules::normalizeAccount($data, $request->boolean('is_active'));
    }

    private function requireSuperAdmin(Request $request): Admin
    {
        $admin = $this->executionAdmin($request);
        if (! $admin->isSuperAdmin()) {
            throw new ApiException('forbidden', '只有超级管理员可以维护发布账号与人设', 403, [
                'required_role' => 'super_admin',
            ]);
        }

        return $admin;
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }
}
