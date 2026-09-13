<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Models\DistributionChannel;
use App\Models\HostedSiteProfile;
use App\Services\Site\SitePreviewProjection;
use App\Support\Site\CurrentSite;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

final class SitePreviewController extends BaseApiController
{
    public function __invoke(
        Request $request,
        SitePreviewProjection $projection,
        CurrentSite $currentSite,
    ): JsonResponse {
        $this->executionAdmin($request);
        $payload = $request->validate([
            'page' => ['sometimes', 'string', Rule::in(['home', 'category', 'article'])],
            'category_id' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'article_id' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'hosted_site_id' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'limit' => ['sometimes', 'integer', 'min:1', 'max:24'],
        ]);

        $availableSites = $projection->availableSites();
        $hostedSiteId = isset($payload['hosted_site_id']) ? (int) $payload['hosted_site_id'] : null;
        if ($hostedSiteId !== null) {
            if (! (bool) config('geoflow.hosted_sites.enabled', false)) {
                throw new ApiException('hosted_sites_disabled', 'Hosted Site 功能当前未启用', 404);
            }
            $profile = HostedSiteProfile::query()
                ->with('channel')
                ->whereKey($hostedSiteId)
                ->whereHas('channel', static fn ($query) => $query->where('channel_type', DistributionChannel::TYPE_HOSTED_SITE))
                ->first();
            if (! $profile instanceof HostedSiteProfile) {
                throw new ApiException('hosted_site_not_found', 'Hosted Site 不存在', 404);
            }
            $currentSite->setHosted($profile);
        }

        $data = $projection->build(
            (string) ($payload['page'] ?? 'home'),
            isset($payload['category_id']) ? (int) $payload['category_id'] : null,
            isset($payload['article_id']) ? (int) $payload['article_id'] : null,
            (int) ($payload['limit'] ?? 12),
            $hostedSiteId,
        );
        $data['available_sites'] = $availableSites;

        return $this->success($request, $data);
    }
}
