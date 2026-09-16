<?php

namespace App\Http\Controllers\Site;

use App\Http\Controllers\Controller;
use App\Models\LeadForm;
use App\Services\Site\SiteUrlGenerator;
use App\Support\Site\CompanyProfile;
use App\Support\Site\CurrentSite;
use App\Support\Site\SiteSettingsBag;
use App\Support\Site\SiteThemeViewResolver;
use Illuminate\Support\Facades\Schema;
use Illuminate\View\View;

/**
 * 服务页。
 *
 * 2026-09-16 新增。此前系统只有「文章 / 分类 / 归档 / 关于 / 表单」这几类页面，
 * 官网首页把「我们提供哪些服务」讲完，**服务卡片却没有地方可点**——一个获客官网
 * 给出了服务清单，却不给任何详情入口。这一页用 CompanyProfile 的服务清单渲染，
 * 与首页服务卡片、Organization 结构化数据、llms.txt **同源**（同一份数据，第四个出口）。
 *
 * 没有配置服务时返回 404，而不是渲染一个空壳页面——导航里的「服务」入口也是按同样的
 * 条件显示的（见 SiteLayoutComposer）。
 */
class ServiceController extends Controller
{
    public function __construct(
        private readonly SiteUrlGenerator $urls,
        private readonly CurrentSite $currentSite,
    ) {}

    public function index(): View
    {
        $map = SiteSettingsBag::all();
        $company = CompanyProfile::fromSettings($map);

        abort_unless($company->hasServices(), 404);

        $siteTitle = (string) ($map['site_name'] ?? config('geoflow.site_name', config('app.name')));
        $siteDescription = (string) ($map['site_description'] ?? '');
        $pageTitle = '服务 - '.$siteTitle;
        $pageDescription = $company->tagline !== ''
            ? $company->tagline
            : ($company->description !== '' ? $company->description : $siteDescription);

        // 转化目标：与首页 CTA 用同一条判定（有可用表单就指向表单）。
        $contactFormUrl = '';
        if (Schema::hasTable('lead_forms')) {
            $slug = LeadForm::query()
                ->where('status', LeadForm::STATUS_ACTIVE)
                ->orderBy('id')
                ->value('slug');
            if (is_string($slug) && $slug !== '') {
                $contactFormUrl = $this->urls->form($slug);
            }
        }

        return SiteThemeViewResolver::first('services', [
            'activeNav' => 'services',
            'siteTitle' => $siteTitle,
            'siteDescription' => $siteDescription,
            'siteKeywords' => (string) ($map['site_keywords'] ?? ''),
            'pageTitle' => $pageTitle,
            'pageDescription' => $pageDescription,
            'pageKeywords' => (string) ($map['site_keywords'] ?? ''),
            'pageOgType' => 'website',
            'canonicalUrl' => $this->urls->services(),
            // 子视图的 @section 作用域拿不到布局 composer 注入的变量，这里显式传。
            'companyProfile' => $company,
            'companyServices' => $company->services,
            'contactFormUrl' => $contactFormUrl,
            'isHostedServices' => $this->currentSite->isHosted(),
        ]);
    }
}
