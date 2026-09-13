<?php

namespace App\Services\GeoFlow;

use App\Models\EnterpriseKnowledgeProject;
use Illuminate\Support\Facades\DB;
use Throwable;

final class EnterpriseKnowledgeDraftRecoveryService
{
    private const DISPATCH_FAILED = 'enterprise_knowledge_recovery_dispatch_failed';

    public function __construct(
        private readonly EnterpriseKnowledgeDraftRecoveryDispatcher $dispatcher,
    ) {}

    /** @return array{recovered:int,dispatch_failed:int} */
    public function reconcile(int $limit = 50): array
    {
        $projectIds = EnterpriseKnowledgeProject::query()
            ->where('status', 'processing')
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
        foreach ($projectIds as $projectId) {
            if (! $this->reserveForRecovery((int) $projectId)) {
                continue;
            }

            try {
                $this->dispatcher->dispatch((int) $projectId);
                $recovered++;
            } catch (Throwable) {
                $dispatchFailed++;
                EnterpriseKnowledgeProject::query()
                    ->whereKey((int) $projectId)
                    ->where('status', 'queued')
                    ->whereNull('execution_lease_token')
                    ->update([
                        'status' => 'processing',
                        'error_code' => self::DISPATCH_FAILED,
                        'error_message' => self::DISPATCH_FAILED,
                        'retryable_failure' => true,
                        'lease_expires_at' => null,
                        'updated_at' => now(),
                    ]);
            }
        }

        return ['recovered' => $recovered, 'dispatch_failed' => $dispatchFailed];
    }

    private function reserveForRecovery(int $projectId): bool
    {
        return DB::transaction(function () use ($projectId): bool {
            $project = EnterpriseKnowledgeProject::query()
                ->whereKey($projectId)
                ->lockForUpdate()
                ->first();
            if (! $project instanceof EnterpriseKnowledgeProject || ! $this->isRecoverable($project)) {
                return false;
            }

            $project->forceFill([
                'status' => 'queued',
                'execution_lease_token' => null,
                'lease_expires_at' => null,
                'error_code' => null,
                'error_message' => null,
                'retryable_failure' => true,
            ])->save();

            return true;
        }, 3);
    }

    private function isRecoverable(EnterpriseKnowledgeProject $project): bool
    {
        if ((string) $project->status !== 'processing') {
            return false;
        }

        return trim((string) ($project->execution_lease_token ?? '')) === ''
            || ($project->lease_expires_at !== null && $project->lease_expires_at->isPast());
    }
}
