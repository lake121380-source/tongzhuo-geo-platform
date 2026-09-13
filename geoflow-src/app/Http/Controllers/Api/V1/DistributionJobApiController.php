<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Models\ArticleDistribution;
use App\Models\DistributionChannel;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\DistributionArticleOperationService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * Bearer 版的分发记录修正：改远端文章、删远端文章。
 *
 * 本地落库、AI 引用标记清洗、Hosted Site 指纹同步与远端推送全部由
 * {@see DistributionArticleOperationService} 拥有——与旧 Blade 后台是同一份实现。
 */
final class DistributionJobApiController extends BaseApiController
{
    public function __construct(
        private readonly DistributionArticleOperationService $operations,
    ) {}

    /** 修改某条分发记录对应的远端文章。 */
    public function update(Request $request, int $distribution): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->superAdmin($request);
        $payload = $request->validate([
            'title' => ['required', 'string', 'max:500'],
            'excerpt' => ['nullable', 'string'],
            'content' => ['required', 'string'],
            'keywords' => ['nullable', 'string'],
            'meta_description' => ['nullable', 'string'],
        ]);

        $row = $this->jobForMutation($distribution);

        try {
            $this->operations->updateRemoteArticle($row, $payload);
        } catch (ValidationException $exception) {
            throw $exception;
        } catch (Throwable $exception) {
            throw new ApiException('remote_article_update_failed', '远端文章更新失败', 500, [
                'reason' => $exception->getMessage(),
            ]);
        }

        return IdempotencyService::executeJson($request, 'PATCH /distribution/jobs/{distribution}', function () use ($request, $row): JsonResponse {
            return $this->success($request, ['job' => $this->projection($row->refresh())]);
        });
    }

    /** 删除某条分发记录对应的远端文章。 */
    public function destroy(Request $request, int $distribution): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $this->superAdmin($request);

        $row = $this->jobForMutation($distribution);

        try {
            $deleted = $this->operations->deleteRemoteArticle($row);
        } catch (Throwable $exception) {
            throw new ApiException('remote_article_delete_failed', '远端文章删除失败', 500, [
                'reason' => $exception->getMessage(),
            ]);
        }

        return IdempotencyService::executeJson($request, 'DELETE /distribution/jobs/{distribution}', function () use ($request, $deleted): JsonResponse {
            return $this->success($request, ['job' => $this->projection($deleted)]);
        });
    }

    /** 分发记录必须带得上文章与渠道，且渠道不能是 Hosted Site 或正在删除。 */
    private function jobForMutation(int $distribution): ArticleDistribution
    {
        $row = ArticleDistribution::query()->with(['article', 'channel'])->whereKey($distribution)->first();
        if (! $row instanceof ArticleDistribution || ! $row->article || ! $row->channel) {
            throw new ApiException('distribution_job_not_found', '分发记录不存在', 404);
        }
        if ($row->channel->isHostedSite()) {
            throw new ApiException('job_not_supported', 'Hosted Site 渠道不需要手动修正远端文章', 422);
        }
        if ((string) $row->channel->status === DistributionChannel::STATUS_DELETING) {
            throw new ApiException('distribution_channel_deleting', '分发渠道正在删除流程中，暂不能修正远端文章', 409);
        }

        return $row;
    }

    /** @return array<string, mixed> */
    private function projection(ArticleDistribution $row): array
    {
        return [
            'id' => (int) $row->id,
            'action' => (string) $row->action,
            'status' => (string) $row->status,
            'remote_url' => $row->remote_url,
        ];
    }

    /**
     * 分发记录修正保留旧后台的**超管边界**（旧 `distribution` 组挂在 `admin.super` 下）。
     */
    private function superAdmin(Request $request): Admin
    {
        $admin = $this->executionAdmin($request);
        if (! $admin->isSuperAdmin()) {
            throw new ApiException('forbidden', '只有超级管理员可以修正分发记录', 403, [
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
