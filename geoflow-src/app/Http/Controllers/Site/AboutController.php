<?php

namespace App\Http\Controllers\Site;

use App\Http\Controllers\Controller;
use App\Services\Site\SiteUrlGenerator;
use App\Support\Site\CompanyProfile;
use App\Support\Site\CurrentSite;
use App\Support\Site\SiteSettingsBag;
use App\Support\Site\SiteThemeViewResolver;
use Illuminate\View\View;

/**
 * 桐灼GEO 项目介绍页。
 */
class AboutController extends Controller
{
    public function __construct(
        private readonly SiteUrlGenerator $urls,
        private readonly CurrentSite $currentSite,
    ) {}

    public function index(): View
    {
        $map = SiteSettingsBag::all();
        $siteTitle = (string) ($map['site_name'] ?? config('geoflow.site_name', config('app.name')));
        $siteDescription = (string) ($map['site_description'] ?? config('geoflow.site_description', ''));
        $siteKeywords = (string) ($map['site_keywords'] ?? config('geoflow.site_keywords', ''));
        $isHosted = $this->currentSite->isHosted();
        $defaultDescription = $isHosted
            ? ($siteDescription !== '' ? $siteDescription : '关于 '.$siteTitle)
            : '桐灼GEO 是面向生成式引擎优化的开源智能内容工程与多站点分发系统，连接知识、生成、审核、发布、分发和数据分析。';
        $aboutTitle = trim((string) ($map['about_title'] ?? ''));
        $aboutContent = trim((string) ($map['about_content'] ?? ''));
        $contactEmail = trim((string) ($map['contact_email'] ?? ''));
        $pageDescription = $aboutContent !== '' ? $aboutContent : $defaultDescription;
        $view = $this->currentSite->isHosted() ? view('site.about') : null;

        $data = [
            'activeNav' => 'about',
            'siteTitle' => $siteTitle,
            'siteDescription' => $siteDescription,
            'siteKeywords' => $siteKeywords,
            'pageTitle' => $aboutTitle !== '' ? $aboutTitle : '关于 '.$siteTitle,
            'pageDescription' => $pageDescription,
            'pageKeywords' => $isHosted
                ? $siteKeywords
                : '桐灼GEO,GEO,生成式引擎优化,开源内容系统,知识库,多站点分发',
            'pageOgType' => 'website',
            'canonicalUrl' => $this->urls->about(),
            'repositoryUrl' => 'https://github.com/yaojingang/GEOFlow',
            'aboutTitle' => $aboutTitle !== '' ? $aboutTitle : '关于 '.$siteTitle,
            'aboutContent' => $aboutContent,
            'contactEmail' => $contactEmail,
            /*
             * 显式传一份公司实体。
             *
             * `SiteLayoutComposer` 只注册在 `site.layout` / `theme.*.layout` 上，而
             * `@extends` 的子视图里，`@section(...)` 的内容是在**子视图自己的作用域**求值的
             * ——拿不到布局 composer 注入的变量。2026-09-16 我在这里漏了这一点，
             * 结果 `$companyProfile` 未定义、about 页 500，而 Laravel 每次都要往日志里写
             * 一份完整堆栈，把日志刷到 179MB、单次请求拖到 60 秒。
             * 所以凡是子视图里要用到的公共数据，要么控制器显式传，要么视图侧做 `?? null` 兜底。
             */
            'companyProfile' => CompanyProfile::fromSettings($map),
            'isHostedAbout' => $isHosted,
        ];

        return $view ? $view->with($data) : SiteThemeViewResolver::first('about', $data);
    }
}
