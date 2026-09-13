<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\LibraryImportService;
use App\Support\LibraryImportPolicy;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use RuntimeException;

/**
 * Bearer 版的关键词库 / 标题库批量导入。
 *
 * 切分规则、条数与长度上限、去重与计数回写全部由 {@see LibraryImportService} 拥有
 * ——与旧 Blade 后台共用同一套 {@see LibraryImportPolicy} 限额。
 */
final class LibraryImportApiController extends BaseApiController
{
    public function __construct(
        private readonly LibraryImportService $imports,
    ) {}

    public function keywords(Request $request, int $library): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->executionAdmin($request);
        $payload = $request->validate(['keywords_text' => ['required', 'string']]);

        try {
            $result = $this->imports->importKeywords($library, (string) $payload['keywords_text']);
        } catch (RuntimeException $exception) {
            throw $this->failure($exception);
        }

        return IdempotencyService::executeJson($request, 'POST /materials/keyword-libraries/{library}/import', function () use ($request, $library, $result): JsonResponse {
            return $this->success($request, [
                'library_id' => $library,
                'imported' => $result['imported'],
                'skipped' => $result['skipped'],
            ]);
        });
    }

    public function titles(Request $request, int $library): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->executionAdmin($request);
        $payload = $request->validate(['titles_text' => ['required', 'string']]);

        try {
            $result = $this->imports->importTitles($library, (string) $payload['titles_text']);
        } catch (RuntimeException $exception) {
            throw $this->failure($exception);
        }

        return IdempotencyService::executeJson($request, 'POST /materials/title-libraries/{library}/import', function () use ($request, $library, $result): JsonResponse {
            return $this->success($request, [
                'library_id' => $library,
                'imported' => $result['imported'],
                'skipped' => $result['skipped'],
            ]);
        });
    }

    private function failure(RuntimeException $exception): ApiException
    {
        return match ($exception->getMessage()) {
            LibraryImportService::ERRORS_REQUIRED => new ApiException(LibraryImportService::ERRORS_REQUIRED, '没有可导入的条目', 422),
            LibraryImportService::ERRORS_TOO_MANY => new ApiException(LibraryImportService::ERRORS_TOO_MANY, '导入条数超出上限', 422),
            LibraryImportService::ERRORS_TOO_LARGE => new ApiException(LibraryImportService::ERRORS_TOO_LARGE, '导入文本超出体积上限', 422),
            LibraryImportService::ERRORS_ENTRY_TOO_LONG => new ApiException(LibraryImportService::ERRORS_ENTRY_TOO_LONG, '单条内容超出长度上限', 422),
            LibraryImportService::ERRORS_INVALID_UTF8 => new ApiException(LibraryImportService::ERRORS_INVALID_UTF8, '导入文本不是合法的 UTF-8 编码', 422),
            LibraryImportService::ERRORS_TITLE_TOO_LONG => new ApiException(LibraryImportService::ERRORS_TITLE_TOO_LONG, '单个标题超出长度上限', 422),
            LibraryImportService::ERRORS_KEYWORD_TOO_LONG => new ApiException(LibraryImportService::ERRORS_KEYWORD_TOO_LONG, '关联关键词超出长度上限', 422),
            LibraryImportService::ERRORS_LIBRARY_NOT_FOUND => new ApiException(LibraryImportService::ERRORS_LIBRARY_NOT_FOUND, '素材库不存在', 404),
            default => new ApiException('library_import_failed', '批量导入失败', 500, ['reason' => $exception->getMessage()]),
        };
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }
}
