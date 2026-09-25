<?php

namespace App\Http\Controllers\Site;

use App\Http\Controllers\Controller;
use App\Services\Site\SiteUrlGenerator;
use App\Support\Site\ArticleHtmlPresenter;
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
        /*
         * 描述用**纯文本摘要**：about_content 是 Markdown（还可能带 {{services}} 占位符），
         * 原样塞进 <meta description> / og:description / 结构化数据会把记号一起暴露给
         * 搜索引擎与 AI（2026-09-25 本地实测：占位符字面量真的出现在 meta 里）。
         * 清完记号仍为空则回落到默认描述。
         */
        $aboutPlain = '';
        if ($aboutContent !== '') {
            $stripped = str_replace('{{services}}', ' ', $aboutContent);
            $stripped = (string) preg_replace('/^\s{0,3}#{1,6}\s*/mu', '', $stripped);
            $stripped = (string) preg_replace('/[*_`>#\[\]]+/u', ' ', $stripped);
            $aboutPlain = trim((string) preg_replace('/\s+/u', ' ', $stripped));
            if (mb_strlen($aboutPlain) > 160) {
                $aboutPlain = mb_substr($aboutPlain, 0, 160).'…';
            }
        }
        $pageDescription = $aboutPlain !== '' ? $aboutPlain : $defaultDescription;
        $view = $this->currentSite->isHosted() ? view('site.about') : null;
        $company = CompanyProfile::fromSettings($map);
        $servicesTitle = trim((string) ($map['company_services_title'] ?? '')) !== ''
            ? trim((string) $map['company_services_title'])
            : '我们提供的服务';
        /*
         * 关于页正文：Markdown。单独一行写 `{{services}}` = 「服务清单插在这里」的占位，
         * 不写就不显示清单（见 SiteSettingsController 里的字段说明）。
         * **没配置（空）时视图回落到内置默认文案**——全新安装不会出现空白页，
         * 现有站点的样子也不会因为这次改动而变。
         */
        $aboutBodyParts = $aboutContent === ''
            ? []
            : array_map(
                static fn (string $chunk): string => ArticleHtmlPresenter::markdownToHtml($chunk),
                explode('{{services}}', $aboutContent),
            );

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
            'aboutBodyParts' => $aboutBodyParts,
            'servicesTitle' => $servicesTitle,
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
            'companyProfile' => $company,
            'isHostedAbout' => $isHosted,
        ];

        return $view ? $view->with($data) : SiteThemeViewResolver::first('about', $data);
    }
}
