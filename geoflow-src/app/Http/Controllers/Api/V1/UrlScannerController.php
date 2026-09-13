<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Http\Requests\Api\StoreUrlScanRequest;
use App\Models\UrlScanReport;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\UrlScannerService;
use App\Support\ApiResponse;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Throwable;

final class UrlScannerController extends BaseApiController
{
    public function __construct(private readonly UrlScannerService $scanner) {}

    public function index(Request $request): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $query = UrlScanReport::query()->latest('id');
        if (! $admin->isSuperAdmin()) {
            $query->where('admin_id', $admin->getKey());
        }
        $page = max(1, $request->integer('page', 1));
        $perPage = max(1, min(50, $request->integer('per_page', 20)));
        $reports = $query->paginate($perPage, ['*'], 'page', $page);

        return $this->success($request, [
            'items' => $reports->getCollection()->map(fn (UrlScanReport $report): array => $this->summary($report))->values()->all(),
            'pagination' => [
                'page' => (int) $reports->currentPage(),
                'per_page' => (int) $reports->perPage(),
                'total' => (int) $reports->total(),
                'total_pages' => (int) $reports->lastPage(),
            ],
        ]);
    }

    public function store(StoreUrlScanRequest $request): JsonResponse
    {
        return IdempotencyService::executeJson(
            $request,
            'POST /url-scans',
            function () use ($request): JsonResponse {
                $admin = $this->executionAdmin($request);
                $input = (string) $request->validated('url');
                $report = UrlScanReport::query()->create([
                    'url' => $input,
                    'normalized_url' => $input,
                    'source_domain' => '',
                    'status' => 'running',
                    'report_json' => null,
                    'error_message' => '',
                    'created_by' => (string) $admin->username,
                    'admin_id' => $admin->getKey(),
                    'started_at' => now(),
                ]);

                try {
                    $result = $this->scanner->scan($input);
                    $report->forceFill([
                        'normalized_url' => (string) ($result['normalized_url'] ?? $input),
                        'source_domain' => (string) ($result['source_domain'] ?? ''),
                        'status' => 'completed',
                        'report_json' => json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE),
                        'error_message' => '',
                        'error_code' => null,
                        'finished_at' => now(),
                    ])->save();

                    return $this->success($request, ['scan' => $this->detail($report->refresh())], 201);
                } catch (Throwable $exception) {
                    report($exception);
                    $errorCode = $exception instanceof \InvalidArgumentException ? 'invalid_url' : 'url_scan_failed';
                    $errorMessage = $exception instanceof \InvalidArgumentException
                        ? ($exception->getMessage() ?: 'URL 无效')
                        : 'URL 扫描失败，请检查地址后重试';
                    $report->forceFill([
                        'status' => 'failed',
                        'error_message' => $errorMessage,
                        'error_code' => $errorCode,
                        'finished_at' => now(),
                    ])->save();

                    // Return the governed error envelope instead of throwing:
                    // IdempotencyService commits returned responses in its
                    // transaction, which keeps the failed report available
                    // for a later retry.
                    return ApiResponse::error(
                        $errorCode,
                        $errorMessage,
                        $this->requestId($request),
                        422,
                        ['scan_id' => (int) $report->getKey(), 'retryable' => true],
                    );
                }
            },
        );
    }

    public function show(Request $request, int $urlScan): JsonResponse
    {
        return $this->success($request, ['scan' => $this->detail($this->findVisible($request, $urlScan))]);
    }

    public function retry(Request $request, int $urlScan): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $scan = $this->findOwned($request, $urlScan);

        return IdempotencyService::executeJson($request, 'POST /url-scans/{id}/retry', function () use ($request, $scan): JsonResponse {
            $scan->forceFill([
                'status' => 'running',
                'error_message' => '',
                'error_code' => null,
                'started_at' => now(),
                'finished_at' => null,
            ])->save();
            try {
                $result = $this->scanner->scan((string) $scan->url);
                $scan->forceFill([
                    'normalized_url' => (string) ($result['normalized_url'] ?? $scan->url),
                    'source_domain' => (string) ($result['source_domain'] ?? ''),
                    'status' => 'completed',
                    'report_json' => json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE),
                    'finished_at' => now(),
                ])->save();

                return $this->success($request, ['scan' => $this->detail($scan->refresh())]);
            } catch (Throwable $exception) {
                report($exception);
                $errorCode = $exception instanceof \InvalidArgumentException ? 'invalid_url' : 'url_scan_failed';
                $errorMessage = $exception instanceof \InvalidArgumentException
                    ? ($exception->getMessage() ?: 'URL 无效')
                    : 'URL 扫描失败，请检查地址后重试';
                $scan->forceFill(['status' => 'failed', 'error_message' => $errorMessage, 'error_code' => $errorCode, 'finished_at' => now()])->save();

                return ApiResponse::error(
                    $errorCode,
                    $errorMessage,
                    $this->requestId($request),
                    422,
                    ['scan_id' => (int) $scan->getKey(), 'retryable' => true],
                );
            }
        });
    }

    public function export(Request $request, int $urlScan): StreamedResponse
    {
        $scan = $this->findVisible($request, $urlScan);
        if ((string) $scan->status !== 'completed' || $scan->report() === []) {
            throw new ApiException('url_scan_not_ready', '扫描报告尚未生成', 409);
        }
        $report = $scan->report();
        $markdown = $this->markdown($report);

        return response()->streamDownload(static function () use ($markdown): void {
            echo $markdown;
        }, 'geo-url-scan-'.$scan->getKey().'.md', ['Content-Type' => 'text/markdown; charset=UTF-8']);
    }

    /** @return array<string,mixed> */
    private function detail(UrlScanReport $scan): array
    {
        return ['id' => (int) $scan->getKey(), 'url' => (string) $scan->url, 'status' => (string) $scan->status, 'error_message' => (string) ($scan->error_message ?? ''), 'error_code' => (string) ($scan->error_code ?? ''), 'report' => $scan->report(), 'created_at' => optional($scan->created_at)->toIso8601String(), 'started_at' => optional($scan->started_at)->toIso8601String(), 'finished_at' => optional($scan->finished_at)->toIso8601String()];
    }

    /** @return array<string,mixed> */
    private function summary(UrlScanReport $scan): array
    {
        $report = $scan->report();

        return ['id' => (int) $scan->getKey(), 'url' => (string) $scan->url, 'normalized_url' => (string) $scan->normalized_url, 'source_domain' => (string) $scan->source_domain, 'status' => (string) $scan->status, 'overall_score' => (int) ($report['overall_score'] ?? 0), 'grade' => (string) ($report['grade'] ?? ''), 'scanned_at' => (string) ($report['scanned_at'] ?? ''), 'error_message' => (string) ($scan->error_message ?? ''), 'created_at' => optional($scan->created_at)->toIso8601String()];
    }

    private function findVisible(Request $request, int $id): UrlScanReport
    {
        $admin = $this->executionAdmin($request);
        $query = UrlScanReport::query()->whereKey($id);
        if (! $admin->isSuperAdmin()) {
            $query->where('admin_id', $admin->getKey());
        }
        $scan = $query->first();
        if (! $scan instanceof UrlScanReport) {
            throw new ApiException('not_found', 'URL 扫描报告不存在', 404);
        }

        return $scan;
    }

    private function findOwned(Request $request, int $id): UrlScanReport
    {
        $admin = $this->executionAdmin($request);
        $scan = UrlScanReport::query()->whereKey($id)->where('admin_id', $admin->getKey())->first();
        if (! $scan instanceof UrlScanReport) {
            throw new ApiException('not_found', 'URL 扫描报告不存在或无权操作', 404);
        }

        return $scan;
    }

    private function requireIdempotencyKey(Request $request): void
    {
        $key = $request->header('X-Idempotency-Key');
        if (! is_string($key) || trim($key) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
        if (strlen($key) > 120 || preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]*$/D', $key) !== 1) {
            throw new ApiException('invalid_idempotency_key', 'X-Idempotency-Key 格式无效', 422);
        }
    }

    private function markdown(array $report): string
    {
        $markdown = '# GEO URL 扫描诊断报告'.PHP_EOL;
        $markdown .= 'URL: '.($report['url'] ?? '').PHP_EOL;
        $markdown .= '扫描时间: '.($report['scanned_at'] ?? '').PHP_EOL;
        $markdown .= '综合得分: '.($report['overall_score'] ?? 0).' / 100（'.($report['grade'] ?? '').'）'.PHP_EOL.PHP_EOL;
        foreach ((array) ($report['items'] ?? []) as $item) {
            $markdown .= '## '.($item['dimension'] ?? '').' - '.($item['score'] ?? 0).'分'.PHP_EOL;
            $markdown .= '- 状态: '.($item['status'] ?? '').PHP_EOL;
            $markdown .= '- 详情: '.($item['details'] ?? '').PHP_EOL;
            $markdown .= '- 建议: '.($item['recommendation'] ?? '').PHP_EOL.PHP_EOL;
        }

        return $markdown;
    }
}
