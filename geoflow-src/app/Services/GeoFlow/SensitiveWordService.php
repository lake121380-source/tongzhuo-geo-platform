<?php

namespace App\Services\GeoFlow;

use App\Http\Controllers\Admin\SecuritySettingsController;
use App\Http\Controllers\Api\V1\SiteSensitiveWordApiController;
use App\Models\SensitiveWord;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use RuntimeException;

/**
 * 敏感词规则管理。
 *
 * 旧 Blade 后台（{@see SecuritySettingsController}）与
 * api/v1（{@see SiteSensitiveWordApiController}）共用这一份实现。
 *
 * **这不是装饰性配置**：`ArticleRiskScanner` 直接读这张表做文章风险扫描，所以写入必须
 * 串行化（缓存锁）、受总量上限约束，并在写入后让扫描器的规则缓存失效。
 */
final class SensitiveWordService
{
    /** 单次提交的条数上限（旧后台就是 200）。 */
    public const MAX_PER_SUBMISSION = 200;

    /** 单个词的长度上限。 */
    public const MAX_WORD_LENGTH = 255;

    public const ERRORS_REQUIRED = 'sensitive_words_required';

    public const ERRORS_TOO_MANY = 'sensitive_words_too_many';

    public const ERRORS_TOO_LONG = 'sensitive_words_too_long';

    public const ERRORS_LIMIT_REACHED = 'sensitive_words_limit_reached';

    public const ERRORS_NOT_FOUND = 'sensitive_word_not_found';

    /** @return Collection<int, SensitiveWord> */
    public function rules(?string $search = null): Collection
    {
        $term = trim((string) $search);

        return SensitiveWord::query()
            ->when($term !== '', fn ($query) => $query->where(function ($query) use ($term): void {
                $query->whereLike('word', '%'.$term.'%')
                    ->orWhereLike('category', '%'.$term.'%')
                    ->orWhereLike('suggestion', '%'.$term.'%');
            }))
            ->orderBy('word')
            ->get();
    }

    /**
     * 批量新增：按行/逗号切分、去重、受总量门禁约束，并在提交后让扫描器缓存失效。
     *
     * @param  array<string, mixed>  $payload
     * @return array{inserted:int}
     */
    public function storeBatch(array $payload): array
    {
        $raw = trim((string) ($payload['words'] ?? ''));
        if ($raw === '') {
            throw new RuntimeException(self::ERRORS_REQUIRED);
        }

        // 旧后台按换行切分；这里额外接受逗号，因为运营方常见的是逗号分隔的词表。
        $submitted = collect(preg_split('/\R|,/u', $raw) ?: [])
            ->map(static fn (string $word): string => trim($word))
            ->filter(static fn (string $word): bool => $word !== '')
            ->unique()
            ->values();

        if ($submitted->isEmpty()) {
            throw new RuntimeException(self::ERRORS_REQUIRED);
        }
        if ($submitted->count() > self::MAX_PER_SUBMISSION) {
            throw new RuntimeException(self::ERRORS_TOO_MANY);
        }
        if ($submitted->contains(static fn (string $word): bool => mb_strlen($word, 'UTF-8') > self::MAX_WORD_LENGTH)) {
            throw new RuntimeException(self::ERRORS_TOO_LONG);
        }

        $result = Cache::lock('geoflow:sensitive-word-rules:mutation', 15)->block(5, function () use ($payload, $submitted): array {
            return DB::transaction(function () use ($payload, $submitted): array {
                $existing = SensitiveWord::query()->whereIn('word', $submitted->all())->pluck('word')->all();

                $rows = $submitted
                    ->reject(static fn (string $word): bool => in_array($word, $existing, true))
                    ->map(static fn (string $word): array => [
                        'word' => $word,
                        'severity' => (string) ($payload['severity'] ?? 'warning'),
                        'category' => trim((string) ($payload['category'] ?? '')) ?: 'sensitive',
                        'is_enabled' => (bool) ($payload['is_enabled'] ?? true),
                        'suggestion' => trim((string) ($payload['suggestion'] ?? '')) ?: null,
                        'applies_to' => json_encode(array_values($payload['applies_to'] ?? []), JSON_UNESCAPED_UNICODE),
                        'created_at' => now(),
                    ])
                    ->values()
                    ->all();

                if (SensitiveWord::query()->count() + count($rows) > ArticleRiskScanner::MAX_RULE_COUNT) {
                    return ['limit_reached' => true, 'inserted' => 0];
                }

                if ($rows !== []) {
                    // 走 query builder：不触发模型事件，所以下面必须显式让规则缓存失效。
                    SensitiveWord::query()->insert($rows);
                    DB::afterCommit(static fn (): int => SensitiveWord::bumpRuleCacheVersion());
                }

                return ['limit_reached' => false, 'inserted' => count($rows)];
            });
        });

        if ($result['limit_reached'] === true) {
            throw new RuntimeException(self::ERRORS_LIMIT_REACHED);
        }

        return ['inserted' => (int) $result['inserted']];
    }

    /**
     * 更新单条规则。
     *
     * 走模型保存，`saved` 事件会自动让扫描器缓存失效——不要在这里重复 bump。
     *
     * @param  array<string, mixed>  $payload
     */
    public function updateRule(int $wordId, array $payload): SensitiveWord
    {
        $rule = SensitiveWord::query()->whereKey($wordId)->first();
        if (! $rule instanceof SensitiveWord) {
            throw new RuntimeException(self::ERRORS_NOT_FOUND);
        }

        $rule->fill([
            'word' => trim((string) $payload['word']),
            'severity' => (string) $payload['severity'],
            'category' => trim((string) $payload['category']),
            'is_enabled' => (bool) $payload['is_enabled'],
            'suggestion' => trim((string) ($payload['suggestion'] ?? '')) ?: null,
            'applies_to' => array_values($payload['applies_to'] ?? []),
        ])->save();

        return $rule->refresh();
    }

    /** 删除单条规则。同样走模型，`deleted` 事件负责缓存失效。 */
    public function deleteRule(int $wordId): SensitiveWord
    {
        $rule = SensitiveWord::query()->whereKey($wordId)->first();
        if (! $rule instanceof SensitiveWord) {
            throw new RuntimeException(self::ERRORS_NOT_FOUND);
        }

        $rule->delete();

        return $rule;
    }
}
