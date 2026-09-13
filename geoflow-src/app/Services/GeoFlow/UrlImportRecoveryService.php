<?php

namespace App\Services\GeoFlow;

use App\Models\UrlImportJob;
use Illuminate\Support\Facades\DB;
use Throwable;

final class UrlImportRecoveryService
{
    private const DISPATCH_FAILED = 'url_import_recovery_dispatch_failed';

    public function __construct(
        private readonly UrlImportRecoveryDispatcher $dispatcher,
    ) {}

    /** @return array{recovered:int,dispatch_failed:int} */
    public function reconcile(int $limit = 50): array
    {
        $jobIds = UrlImportJob::query()
            ->where('status', 'running')
            ->where(function ($query): void {
                // execution_lease_token 是 uuid 列，PostgreSQL 下不可能等于空字符串，
                // 拿 '' 去比较会直接抛 invalid input syntax for type uuid。
                // 「无租约」只有 NULL 一种表示，因此这里只判 NULL 与过期。
                $query->whereNull('execution_lease_token')
                    ->orWhere(function ($expired): void {
                        $expired->whereNotNull('lease_expires_at')
                            ->where('lease_expires_at', '<=', now());
                    });
            })
            ->orderBy('id')
            ->limit(max(1, min(500, $limit)))
            ->pluck('id');

        $recovered = 0;
        $dispatchFailed = 0;
        foreach ($jobIds as $jobId) {
            if (! $this->reserveForRecovery((int) $jobId)) {
                continue;
            }

            try {
                $this->dispatcher->dispatch((int) $jobId);
                $recovered++;
            } catch (Throwable) {
                $dispatchFailed++;
                UrlImportJob::query()
                    ->whereKey((int) $jobId)
                    ->where('status', 'queued')
                    ->whereNull('execution_lease_token')
                    ->update([
                        'status' => 'running',
                        'error_code' => self::DISPATCH_FAILED,
                        'error_message' => self::DISPATCH_FAILED,
                        'retryable_failure' => true,
                        'lease_expires_at' => null,
                        'updated_at' => now(),
                    ]);
            }
        }

        return [
            'recovered' => $recovered,
            'dispatch_failed' => $dispatchFailed,
        ];
    }

    private function reserveForRecovery(int $jobId): bool
    {
        return DB::transaction(function () use ($jobId): bool {
            $job = UrlImportJob::query()->whereKey($jobId)->lockForUpdate()->first();
            if (! $job instanceof UrlImportJob || ! $this->isRecoverable($job)) {
                return false;
            }

            $job->forceFill([
                'status' => 'queued',
                'current_step' => 'queued',
                'execution_lease_token' => null,
                'lease_expires_at' => null,
                'error_code' => null,
                'error_message' => '',
                'retryable_failure' => true,
                'finished_at' => null,
            ])->save();

            return true;
        }, 3);
    }

    private function isRecoverable(UrlImportJob $job): bool
    {
        if ((string) $job->status !== 'running') {
            return false;
        }

        $lease = trim((string) ($job->execution_lease_token ?? ''));

        return $lease === ''
            || ($job->lease_expires_at !== null && $job->lease_expires_at->isPast());
    }
}
