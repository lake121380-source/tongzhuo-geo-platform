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
 * 联系我们（2026-09-25 新增，哥哥要求）。
 *
 * 此前联系方式只埋在页脚——对一个获客官网来说，独立联系页对转化和 SEO 都更好，
 * 而且能挂上已经建好的「线索表单」当在线留言入口。
 *
 * 页面内容全部来自站点设置里那份「公司实体」（与首页 / 关于页 / 结构化数据 /
 * llms.txt 同源，见 CompanyProfile）——**运营改联系方式只需要改一处**。
 * 有启用中的线索表单时给「在线留言」按钮；没有就退回邮箱按钮，不渲染死链。
 */
class ContactController extends Controller
{
    public function __construct(
        private readonly SiteUrlGenerator $urls,
        private readonly CurrentSite $currentSite,
    ) {}

    public function index(): View
    {
        $map = SiteSettingsBag::all();
        $company = CompanyProfile::fromSettings($map);

        $siteTitle = (string) ($map['site_name'] ?? config('geoflow.site_name', config('app.name')));
        $siteDescription = (string) ($map['site_description'] ?? '');
        $pageDescription = $company->tagline !== ''
            ? $company->tagline
            : ($company->description !== '' ? $company->description : ($siteDescription !== '' ? $siteDescription : '联系 '.$siteTitle));

        // 转化目标：与首页 CTA / 服务页同一条判定（有可用表单就指向表单）。
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

        return SiteThemeViewResolver::first('contact', [
            'activeNav' => 'contact',
            'siteTitle' => $siteTitle,
            'siteDescription' => $siteDescription,
            'siteKeywords' => (string) ($map['site_keywords'] ?? ''),
            'pageTitle' => '联系我们 - '.$siteTitle,
            'pageDescription' => $pageDescription,
            'pageKeywords' => (string) ($map['site_keywords'] ?? ''),
            'pageOgType' => 'website',
            'canonicalUrl' => $this->urls->contact(),
            // 子视图的 @section 作用域拿不到布局 composer 注入的变量，这里显式传。
            'companyProfile' => $company,
            'contactFormUrl' => $contactFormUrl,
            'isHostedContact' => $this->currentSite->isHosted(),
        ]);
    }
}
