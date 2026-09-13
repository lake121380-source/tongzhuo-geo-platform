<?php

namespace App\Services\GeoFlow;

use App\Http\Controllers\Admin\KeywordLibraryController;
use App\Http\Controllers\Admin\TitleLibraryController;
use App\Http\Controllers\Api\V1\LibraryImportApiController;
use App\Models\Keyword;
use App\Models\KeywordLibrary;
use App\Models\Title;
use App\Models\TitleLibrary;
use App\Support\LibraryImportPolicy;
use Illuminate\Support\Facades\DB;
use RuntimeException;

/**
 * 关键词库 / 标题库的批量导入。
 *
 * 旧 Blade 后台（{@see KeywordLibraryController}、
 * {@see TitleLibraryController}）与 api/v1
 * （{@see LibraryImportApiController}）共用这一份实现。
 *
 * 上限、切分与归一化规则全部取自 {@see LibraryImportPolicy}——两个入口共用同一套限额，
 * 不会出现「后台能导 1000 条、API 只能导 200 条」这种漂移。
 */
final class LibraryImportService
{
    public const ERRORS_REQUIRED = 'library_import_required';

    public const ERRORS_TOO_MANY = 'library_import_too_many';

    public const ERRORS_TOO_LARGE = 'library_import_too_large';

    public const ERRORS_ENTRY_TOO_LONG = 'library_import_entry_too_long';

    public const ERRORS_LIBRARY_NOT_FOUND = 'library_not_found';

    /**
     * 非法 UTF-8 单独占一个原因码。
     *
     * 不查这一条的话，`preg_split(..., '/u')` 会返回 false，被 `splitBounded` 当成
     * 「分段溢出」，运营方看到的是「导入条数超出上限」——**文案把人引向完全错误的方向**。
     */
    public const ERRORS_INVALID_UTF8 = 'library_import_invalid_utf8';

    /**
     * 标题库导入有**两个**长度上限（标题本身、关联关键词），必须分开报。
     *
     * 合成一个码的话，运营方在「关键词超长」时看到的会是「标题超长」——文案把他
     * 引向错误的字段。这是测试抓出来的，不是想当然。
     */
    public const ERRORS_TITLE_TOO_LONG = 'library_import_title_too_long';

    public const ERRORS_KEYWORD_TOO_LONG = 'library_import_keyword_too_long';

    /**
     * 导入关键词：按换行或逗号切分。
     *
     * @return array{imported:int,skipped:int}
     */
    public function importKeywords(int $libraryId, string $text): array
    {
        $this->assertTextSize($text);
        $library = KeywordLibrary::query()->whereKey($libraryId)->first();
        if (! $library instanceof KeywordLibrary) {
            throw new RuntimeException(self::ERRORS_LIBRARY_NOT_FOUND);
        }

        $split = LibraryImportPolicy::splitBounded($text, '/(?:\R|,)/u');
        if ($split['overflow']) {
            throw new RuntimeException(self::ERRORS_TOO_MANY);
        }

        $keywords = collect();
        foreach ($split['segments'] as $segment) {
            $keyword = trim($segment);
            if ($keyword === '') {
                continue;
            }
            $keywords->push($keyword);
            if ($keywords->count() > LibraryImportPolicy::MAX_ENTRIES) {
                throw new RuntimeException(self::ERRORS_TOO_MANY);
            }
        }

        if ($keywords->isEmpty()) {
            throw new RuntimeException(self::ERRORS_REQUIRED);
        }
        if ($keywords->contains(static fn (string $word): bool => mb_strlen($word, 'UTF-8') > LibraryImportPolicy::KEYWORD_MAX_CHARACTERS)) {
            throw new RuntimeException(self::ERRORS_ENTRY_TOO_LONG);
        }

        $submitted = $keywords->count();
        $unique = $keywords->uniqueStrict()->values();

        $imported = DB::transaction(function () use ($unique, $libraryId): int {
            KeywordLibrary::query()->whereKey($libraryId)->lockForUpdate()->firstOrFail();

            $rows = $unique->map(static fn (string $keyword): array => [
                'library_id' => $libraryId,
                'keyword' => $keyword,
                'used_count' => 0,
                'usage_count' => 0,
                'created_at' => now(),
            ])->all();

            $count = 0;
            foreach (array_chunk($rows, LibraryImportPolicy::INSERT_CHUNK_SIZE) as $chunk) {
                $count += DB::table((new Keyword)->getTable())->insertOrIgnore($chunk);
            }

            if ($count > 0) {
                KeywordLibrary::query()->whereKey($libraryId)->increment('keyword_count', $count);
            }

            return $count;
        }, 3);

        return ['imported' => $imported, 'skipped' => $submitted - $imported];
    }

    /**
     * 导入标题：每行一个标题，支持 `标题|关键词` 成对格式。
     *
     * @return array{imported:int,skipped:int}
     */
    public function importTitles(int $libraryId, string $text): array
    {
        $this->assertTextSize($text);
        $library = TitleLibrary::query()->whereKey($libraryId)->first();
        if (! $library instanceof TitleLibrary) {
            throw new RuntimeException(self::ERRORS_LIBRARY_NOT_FOUND);
        }

        $split = LibraryImportPolicy::splitBounded($text, '/\R/u');
        if ($split['overflow']) {
            throw new RuntimeException(self::ERRORS_TOO_MANY);
        }

        $entries = collect();
        foreach ($split['segments'] as $segment) {
            $line = trim($segment);
            if ($line === '') {
                continue;
            }

            if (str_contains($line, '|')) {
                [$title, $keyword] = array_pad(explode('|', $line, 2), 2, '');
                $entry = [
                    'title' => LibraryImportPolicy::normalizeTitle((string) $title),
                    'keyword' => trim((string) $keyword),
                ];
            } else {
                $entry = ['title' => LibraryImportPolicy::normalizeTitle($line), 'keyword' => ''];
            }

            if ($entry['title'] === '') {
                continue;
            }

            $entries->push($entry);
            if ($entries->count() > LibraryImportPolicy::MAX_ENTRIES) {
                throw new RuntimeException(self::ERRORS_TOO_MANY);
            }
        }

        if ($entries->isEmpty()) {
            throw new RuntimeException(self::ERRORS_REQUIRED);
        }
        if ($entries->contains(static fn (array $entry): bool => ! LibraryImportPolicy::titleFitsStorage($entry['title']))) {
            throw new RuntimeException(self::ERRORS_TITLE_TOO_LONG);
        }
        if ($entries->contains(static fn (array $entry): bool => mb_strlen($entry['keyword'], 'UTF-8') > LibraryImportPolicy::TITLE_KEYWORD_MAX_CHARACTERS)) {
            throw new RuntimeException(self::ERRORS_KEYWORD_TOO_LONG);
        }
        if ($entries->contains(static fn (array $entry): bool => LibraryImportPolicy::containsNullByte($entry['keyword']))) {
            throw new RuntimeException(self::ERRORS_REQUIRED);
        }

        $submitted = $entries->count();
        $unique = $entries->uniqueStrict(static fn (array $entry): string => $entry['title'])->values();

        $imported = DB::transaction(function () use ($unique, $libraryId): int {
            TitleLibrary::query()->whereKey($libraryId)->lockForUpdate()->firstOrFail();

            $rows = $unique->map(static fn (array $entry): array => [
                'library_id' => $libraryId,
                'title' => $entry['title'],
                'title_fingerprint' => Title::fingerprintFor($entry['title']),
                'keyword' => $entry['keyword'],
                'is_ai_generated' => false,
                'used_count' => 0,
                'usage_count' => 0,
                'created_at' => now(),
            ])->all();

            $count = 0;
            foreach (array_chunk($rows, LibraryImportPolicy::INSERT_CHUNK_SIZE) as $chunk) {
                $count += DB::table((new Title)->getTable())->insertOrIgnore($chunk);
            }

            if ($count > 0) {
                TitleLibrary::query()->whereKey($libraryId)->increment('title_count', $count);
            }

            return $count;
        }, 3);

        return ['imported' => $imported, 'skipped' => $submitted - $imported];
    }

    private function assertTextSize(string $text): void
    {
        if (strlen($text) > LibraryImportPolicy::MAX_TEXT_BYTES) {
            throw new RuntimeException(self::ERRORS_TOO_LARGE);
        }
        if (LibraryImportPolicy::containsNullByte($text)) {
            throw new RuntimeException(self::ERRORS_REQUIRED);
        }
        if (! LibraryImportPolicy::isValidUtf8($text)) {
            throw new RuntimeException(self::ERRORS_INVALID_UTF8);
        }
    }
}
