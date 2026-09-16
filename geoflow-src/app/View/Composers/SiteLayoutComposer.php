<?php

namespace App\View\Composers;

use App\Models\Category;
use App\Models\HostedSiteProfile;
use App\Models\LeadForm;
use App\Services\Site\SiteScopedArticleQuery;
use App\Services\Site\SiteUrlGenerator;
use App\Support\Site\CompanyProfile;
use App\Support\Site\CurrentSite;
use App\Support\Site\SiteSettingsBag;
use Illuminate\Support\Facades\Schema;
use Illuminate\View\View;

/**
 * 为前台 Blade 布局注入站点名称、分类导航等公共变量。
 */
final class SiteLayoutComposer
{
    public function __construct(
        private readonly SiteScopedArticleQuery $siteArticles,
        private readonly CurrentSite $currentSite,
        private readonly SiteUrlGenerator $urls,
    ) {}

    public function compose(View $view): void
    {
        $map = SiteSettingsBag::all();
        $siteName = (string) ($map['site_name'] ?? config('geoflow.site_name', config('app.name')));
        $siteLogo = (string) ($map['site_logo'] ?? '');
        $siteFavicon = (string) ($map['site_favicon'] ?? '');
        $copyright = (string) ($map['copyright_info'] ?? '');
        $filingInfo = trim((string) ($map['filing_info'] ?? ''));
        $filingUrl = trim((string) ($map['filing_url'] ?? ''));
        $analyticsCode = (string) ($map['analytics_code'] ?? '');
        // 公司实体：前台页面、结构化数据、llms.txt 三处都从这里取，避免各写一份漂移。
        $companyProfile = CompanyProfile::fromSettings($map);

        $categories = collect();
        if (Schema::hasTable('categories')) {
            $categories = Category::query()
                ->whereHas('articles', function ($q): void {
                    $this->siteArticles->apply($q);
                })
                ->orderBy('sort_order')
                ->orderBy('id')
                ->withCount([
                    'articles as published_count' => function ($q): void {
                        $this->siteArticles->apply($q);
                    },
                ])
                ->get();
        }

        /*
         * 线索表单入口。系统里本来就有「表单」这种页面（/forms/{slug}），但全站没有任何地方
         * 链接过它——表单是活的、能收线索，却是个孤岛，官网实际上收不到线索。
         * 这里把「当前可用的联系表单」解析出来交给布局，页头/页脚/CTA 才有地方可指。
         * hosted 站点还要过一遍 `lead_form_slugs` 白名单，与 LeadFormController 的判定保持一致。
         */
        $contactFormUrl = '';
        if (Schema::hasTable('lead_forms')) {
            $activeSlug = LeadForm::query()
                ->where('status', LeadForm::STATUS_ACTIVE)
                ->orderBy('id')
                ->value('slug');
            $allowedSlugs = null;
            if ($this->currentSite->isHosted()) {
                $decoded = json_decode((string) ($map['lead_form_slugs'] ?? '[]'), true);
                $allowedSlugs = is_array($decoded) ? array_map('strval', $decoded) : [];
            }
            if (is_string($activeSlug) && $activeSlug !== ''
                && ($allowedSlugs === null || in_array($activeSlug, $allowedSlugs, true))) {
                $contactFormUrl = $this->urls->form($activeSlug);
            }
        }

        $view->with([
            'siteName' => $siteName,
            'siteLogo' => $siteLogo,
            'siteFavicon' => $siteFavicon,
            'footerCopyright' => $copyright,
            'footerFilingInfo' => $filingInfo,
            'footerFilingUrl' => $filingUrl,
            'headAnalyticsCode' => $analyticsCode,
            'companyProfile' => $companyProfile,
            // 站点根地址走 SiteUrlGenerator（与 canonical/sitemap 同源），
            // 不用 route()——那个取的是请求 Host，会出现同一站点两个 host 的局面。
            'siteRootUrl' => $this->urls->home(),
            // 服务页入口：没配服务清单时这一页会 404，导航就不该显示它——两个判据必须一致。
            'servicesUrl' => $companyProfile->hasServices() ? $this->urls->services() : '',
            'contactFormUrl' => $contactFormUrl,
            'navCategories' => $categories,
            'siteIndexingAllowed' => ! $this->currentSite->isHosted()
                || $this->currentSite->profile()?->indexing_status === HostedSiteProfile::INDEXING_INDEX,
        ]);
    }
}
