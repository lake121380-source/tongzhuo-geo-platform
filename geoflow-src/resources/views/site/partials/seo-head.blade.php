@php
    $seoSiteName = trim((string) ($siteName ?? $siteTitle ?? config('geoflow.site_name', config('app.name'))));
    $seoTitle = trim((string) ($pageTitle ?? $seoSiteName));
    $seoDescription = trim((string) ($pageDescription ?? ($siteDescription ?? '')));
    $seoKeywords = trim((string) ($pageKeywords ?? ($siteKeywords ?? '')));
    $seoCanonical = trim((string) ($canonicalUrl ?? url()->current()));
    $seoOgType = trim((string) ($pageOgType ?? 'website'));
    $pwaCurrentSite = app(\App\Support\Site\CurrentSite::class);
    $pwaEnabled = $pwaCurrentSite->isResolved() && $pwaCurrentSite->isPrimary();

    if ($seoTitle === '') {
        $seoTitle = $seoSiteName;
    }

    if ($seoOgType === '') {
        $seoOgType = 'website';
    }
@endphp
@if($pwaEnabled)
    <x-pwa-head />
    @vite('resources/js/pwa.js')
@endif
<title>{{ $seoTitle }}</title>
<meta name="description" content="{{ $seoDescription }}">
@if(isset($siteIndexingAllowed) && !$siteIndexingAllowed)
    <meta name="robots" content="noindex, nofollow">
@elseif(!empty($pageRobots))
    {{-- 按页面覆写：搜索结果页这类"无限抓取面"要 noindex，但不能整个站点都 nofollow。 --}}
    <meta name="robots" content="{{ $pageRobots }}">
@endif
@if($seoKeywords !== '')
    <meta name="keywords" content="{{ $seoKeywords }}">
@endif
@if(!empty($siteFavicon))
    <link rel="icon" href="{{ $siteFavicon }}">
@endif
@if($seoCanonical !== '')
    <link rel="canonical" href="{{ $seoCanonical }}">
@endif
<meta property="og:title" content="{{ $seoTitle }}">
<meta property="og:description" content="{{ $seoDescription }}">
<meta property="og:type" content="{{ $seoOgType }}">
@if($seoCanonical !== '')
    <meta property="og:url" content="{{ $seoCanonical }}">
@endif
@if($seoSiteName !== '')
    <meta property="og:site_name" content="{{ $seoSiteName }}">
@endif
@php
    /*
     * 分享卡片图与 Twitter 卡片。
     * 2026-09-16 补：此前全站没有 `og:image` 也没有任何 `twitter:*`（实测命中 0 次），
     * 分享到微信/社交平台就是一张无图卡——而这个产品的卖点之一就是"全域分发"。
     * 优先级：当前页指定的图（如文章封面）→ 站点 logo。
     */
    $seoOgImage = trim((string) ($pageOgImage ?? ''));
    if ($seoOgImage === '' && isset($companyProfile)) {
        $seoOgImage = $companyProfile->logo;
    }
@endphp
@if($seoOgImage !== '')
    <meta property="og:image" content="{{ $seoOgImage }}">
    <meta name="twitter:image" content="{{ $seoOgImage }}">
@endif
<meta name="twitter:card" content="{{ $seoOgImage !== '' ? 'summary_large_image' : 'summary' }}">
<meta name="twitter:title" content="{{ $seoTitle }}">
<meta name="twitter:description" content="{{ $seoDescription }}">
@php
    /*
     * 公司实体结构化数据。
     *
     * 这段是「给 AI 读的那一半」：人看的页面（首页/关于页）讲的是同一件事，
     * 但搜索引擎和 AI 回答引擎要的是机器可读的 Organization。
     * 此前全站只输出 WebSite / CollectionPage / NewsArticle，**一个 Organization 都没有**
     * ——AI 回答「这家公司是做什么的、怎么联系」时无据可引。
     *
     * 数据全部来自 CompanyProfile（站点设置的唯一来源），这里只负责换格式；
     * 没配就整段不输出，不产出只有名字的空壳结构化数据。
     */
    $companyOrganization = null;
    if (isset($companyProfile) && $companyProfile->isConfigured()) {
        $atContext = chr(64).'context';
        $atType = chr(64).'type';
        $organization = [
            $atType => 'Organization',
            'name' => $companyProfile->name,
            /*
             * 这里必须是**站点根**，不是当前页。
             * 2026-09-16 修：原先写的是 `$seoCanonical ?: url('/')`，于是同一个公司实体在
             * 首页/文章页/关于页各报一个不同的 url——搜索引擎与 AI 无法把这些声明归并成
             * 同一个实体（`hasOfferCatalog` 也跟着绑到错误的 URL 上）。
             * 走 `$siteRootUrl`（SiteUrlGenerator，与 canonical/sitemap 同源）而不是 `route()`，
             * 避免同一站点出现两个 host。
             */
            'url' => $siteRootUrl ?? url('/'),
        ];
        if ($companyProfile->legalName !== '') {
            $organization['legalName'] = $companyProfile->legalName;
        }
        if ($companyProfile->tagline !== '') {
            $organization['slogan'] = $companyProfile->tagline;
        }
        if ($companyProfile->description !== '') {
            $organization['description'] = $companyProfile->description;
        }
        if ($companyProfile->logo !== '') {
            $organization['logo'] = $companyProfile->logo;
            $organization['image'] = $companyProfile->logo;
        }
        if ($companyProfile->email !== '') {
            $organization['email'] = $companyProfile->email;
        }
        if ($companyProfile->phone !== '') {
            $organization['telephone'] = $companyProfile->phone;
        }
        if ($companyProfile->foundingDate !== '') {
            $organization['foundingDate'] = $companyProfile->foundingDate;
        }
        if ($companyProfile->address !== '') {
            $organization['address'] = [
                $atType => 'PostalAddress',
                'streetAddress' => $companyProfile->address,
                'addressCountry' => 'CN',
            ];
        }
        if ($companyProfile->hasServices()) {
            $organization['hasOfferCatalog'] = [
                $atType => 'OfferCatalog',
                'name' => $companyProfile->name.' 服务',
                'itemListElement' => array_values(array_map(
                    static fn (array $service, int $index): array => [
                        $atType => 'Offer',
                        'position' => $index + 1,
                        'itemOffered' => array_filter([
                            $atType => 'Service',
                            'name' => $service['title'],
                            'description' => $service['description'] !== '' ? $service['description'] : null,
                            'provider' => [$atType => 'Organization', 'name' => $companyProfile->name],
                        ], static fn (mixed $value): bool => $value !== null),
                    ],
                    $companyProfile->services,
                    array_keys($companyProfile->services),
                )),
            ];
        }
        $companyOrganization = [$atContext => 'https://schema.org'] + $organization;
    }
@endphp
@if($companyOrganization !== null)
    <x-json-ld :data="$companyOrganization" />
@endif
