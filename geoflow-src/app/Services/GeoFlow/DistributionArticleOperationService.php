<?php

namespace App\Services\GeoFlow;

use App\Http\Controllers\Admin\DistributionController;
use App\Http\Controllers\Api\V1\DistributionJobApiController;
use App\Models\Article;
use App\Models\ArticleDistribution;
use App\Services\HostedSites\HostedSiteArticleFingerprintService;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

/**
 * 分发记录对应「远端那篇文章」的修改与删除。
 *
 * 旧 Blade 后台（{@see DistributionController}）与
 * api/v1（{@see DistributionJobApiController}）共用这一份实现。
 * 两件容易漏的事都在这里：AI 生成的文章要先清洗引用标记再落库；改完正文要同步
 * Hosted Site 指纹，否则同一篇文章在站点侧会被判成重复。
 */
final class DistributionArticleOperationService
{
    public function __construct(
        private readonly ArticleCitationMarkerCleaner $articleCitationMarkerCleaner,
        private readonly HostedSiteArticleFingerprintService $hostedFingerprints,
        private readonly DistributionOrchestrator $distributionOrchestrator,
    ) {}

    /**
     * 改远端文章：先改本地文章，再把变更推到远端。
     *
     * @param  array<string, mixed>  $payload
     */
    public function updateRemoteArticle(ArticleDistribution $distribution, array $payload): void
    {
        DB::transaction(function () use ($distribution, $payload): void {
            $article = Article::query()
                ->whereKey((int) $distribution->article_id)
                ->lockForUpdate()
                ->firstOrFail();

            $fields = $article->is_ai_generated
                ? $this->articleCitationMarkerCleaner->cleanArticleFields($payload)
                : $payload;

            if (trim((string) ($fields['content'] ?? '')) === '') {
                throw ValidationException::withMessages(['content' => __('validation.required')]);
            }

            $article->forceFill([
                'title' => (string) $fields['title'],
                'excerpt' => filled($fields['excerpt'] ?? null) ? (string) $fields['excerpt'] : null,
                'content' => (string) $fields['content'],
                'keywords' => filled($fields['keywords'] ?? null) ? (string) $fields['keywords'] : null,
                'meta_description' => filled($fields['meta_description'] ?? null) ? (string) $fields['meta_description'] : null,
            ])->save();

            $this->hostedFingerprints->synchronizeLockedArticle($article);
        }, 3);

        $distribution->refresh();
        $this->distributionOrchestrator->updateRemoteArticle($distribution);
    }

    /** 删远端文章，返回刷新后的分发记录。 */
    public function deleteRemoteArticle(ArticleDistribution $distribution): ArticleDistribution
    {
        $this->distributionOrchestrator->deleteRemoteArticle($distribution);

        return $distribution->refresh();
    }
}
