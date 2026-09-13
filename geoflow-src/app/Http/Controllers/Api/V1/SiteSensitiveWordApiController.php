<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Models\SensitiveWord;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\ArticleRiskScanner;
use App\Services\GeoFlow\SensitiveWordService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;
use RuntimeException;

/**
 * Bearer 版的敏感词规则管理。
 *
 * 敏感词表是**文章质量门禁的真实输入**（`ArticleRiskScanner` 直接读它做风险扫描），
 * 所以这里既保留旧后台的**超管边界**，也沿用同一套写入约束：串行化的缓存锁、
 * 单次条数上限、词长上限、全局规则总量门禁。规则逻辑全部由
 * {@see SensitiveWordService} 拥有。
 */
final class SiteSensitiveWordApiController extends BaseApiController
{
    /** 规则可作用的字段，与旧后台的校验白名单一致。 */
    private const SCOPES = ['title', 'excerpt', 'content', 'keywords', 'meta_description'];

    public function __construct(
        private readonly SensitiveWordService $words,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $this->executionAdmin($request);
        $payload = $request->validate([
            'search' => ['nullable', 'string', 'max:200'],
        ]);

        $rules = $this->words->rules($payload['search'] ?? null);

        return $this->success($request, [
            'items' => $rules->map(fn (SensitiveWord $rule): array => $this->projection($rule))->values()->all(),
            'total' => $rules->count(),
            // 让前端知道还有多少额度，而不是撞了 422 才发现。
            'limit' => ArticleRiskScanner::MAX_RULE_COUNT,
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->requireSuperAdmin($request);
        $payload = $request->validate($this->batchRules());

        try {
            $result = $this->words->storeBatch($payload);
        } catch (RuntimeException $exception) {
            throw $this->mapFailure($exception);
        }

        return IdempotencyService::executeJson($request, 'POST /site-settings/sensitive-words', function () use ($request, $result): JsonResponse {
            return $this->success($request, ['inserted' => $result['inserted']], 201);
        });
    }

    public function update(Request $request, int $word): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->requireSuperAdmin($request);
        $payload = $request->validate([
            'word' => ['required', 'string', 'max:'.SensitiveWordService::MAX_WORD_LENGTH, Rule::unique('sensitive_words', 'word')->ignore($word)],
            'severity' => ['required', Rule::in(['warning', 'blocked'])],
            'category' => ['required', 'string', 'max:100'],
            'is_enabled' => ['required', 'boolean'],
            'suggestion' => ['nullable', 'string', 'max:255'],
            'applies_to' => ['nullable', 'array'],
            'applies_to.*' => ['string', Rule::in(self::SCOPES)],
        ]);

        try {
            $rule = $this->words->updateRule($word, $payload);
        } catch (RuntimeException $exception) {
            throw $this->mapFailure($exception);
        }

        return IdempotencyService::executeJson($request, 'PATCH /site-settings/sensitive-words/{word}', function () use ($request, $rule): JsonResponse {
            return $this->success($request, ['rule' => $this->projection($rule)]);
        });
    }

    public function destroy(Request $request, int $word): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->requireSuperAdmin($request);

        try {
            $rule = $this->words->deleteRule($word);
        } catch (RuntimeException $exception) {
            throw $this->mapFailure($exception);
        }

        return IdempotencyService::executeJson($request, 'DELETE /site-settings/sensitive-words/{word}', function () use ($request, $rule): JsonResponse {
            return $this->success($request, ['deleted_word_id' => (int) $rule->id]);
        });
    }

    /** @return array<string, list<mixed>> */
    private function batchRules(): array
    {
        return [
            'words' => ['required', 'string', 'max:50000'],
            'severity' => ['nullable', Rule::in(['warning', 'blocked'])],
            'category' => ['nullable', 'string', 'max:100'],
            'is_enabled' => ['nullable', 'boolean'],
            'suggestion' => ['nullable', 'string', 'max:255'],
            'applies_to' => ['nullable', 'array'],
            'applies_to.*' => ['string', Rule::in(self::SCOPES)],
        ];
    }

    /** @return array<string, mixed> */
    private function projection(SensitiveWord $rule): array
    {
        return [
            'id' => (int) $rule->id,
            'word' => (string) $rule->word,
            'severity' => (string) $rule->severity,
            'category' => (string) $rule->category,
            'is_enabled' => (bool) $rule->is_enabled,
            'suggestion' => (string) ($rule->suggestion ?? ''),
            'applies_to' => is_array($rule->applies_to) ? $rule->applies_to : [],
            'created_at' => (string) ($rule->created_at?->format('Y-m-d') ?? ''),
        ];
    }

    private function mapFailure(RuntimeException $exception): ApiException
    {
        return match ($exception->getMessage()) {
            SensitiveWordService::ERRORS_REQUIRED => new ApiException(SensitiveWordService::ERRORS_REQUIRED, '请至少提交一个敏感词', 422),
            SensitiveWordService::ERRORS_TOO_MANY => new ApiException(SensitiveWordService::ERRORS_TOO_MANY, '单次最多提交 '.SensitiveWordService::MAX_PER_SUBMISSION.' 个敏感词', 422),
            SensitiveWordService::ERRORS_TOO_LONG => new ApiException(SensitiveWordService::ERRORS_TOO_LONG, '单个敏感词不能超过 '.SensitiveWordService::MAX_WORD_LENGTH.' 个字符', 422),
            SensitiveWordService::ERRORS_LIMIT_REACHED => new ApiException(SensitiveWordService::ERRORS_LIMIT_REACHED, '敏感词规则总数已达上限，请先清理旧规则', 422),
            SensitiveWordService::ERRORS_NOT_FOUND => new ApiException(SensitiveWordService::ERRORS_NOT_FOUND, '敏感词规则不存在', 404),
            default => new ApiException('sensitive_word_operation_failed', '敏感词操作失败', 500, ['reason' => $exception->getMessage()]),
        };
    }

    private function requireSuperAdmin(Request $request): Admin
    {
        $admin = $this->executionAdmin($request);
        if (! $admin->isSuperAdmin()) {
            throw new ApiException('forbidden', '只有超级管理员可以维护敏感词规则', 403, [
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
