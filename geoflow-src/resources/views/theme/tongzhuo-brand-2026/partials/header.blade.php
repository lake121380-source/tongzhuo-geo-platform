@php
    /*
     * 页头 = 顶栏（公司实体）+ 导航。
     *
     * 顶栏那行不是装饰：它把「公司全称」「核心团队年限」放在首屏之上，
     * 对人和对 AI 都是最快的实体声明。**「5 年+」必须写作「核心团队」的年限**——
     * 公司 2025-09 注册，不加限定会被读成公司年龄。
     *
     * 2026-09-19：顶栏右侧的「机器可读标本：/llms.txt」按哥哥要求去掉。
     * `/llms.txt` 本身照常发布（路由 site.llms 未动），只是不再在页头上挂入口。
     *
     * 导航没有移动端汉堡菜单，靠折行。站点常年只有 4–6 个短项，
     * 折行的可用性和健壮性都优于一个需要 JS 的抽屉。
     * 顺序：首页 · 服务 · 分类… · 关于我们（2026-09-18 定）。分类最多 5 个。
     */
    $tzActiveCategory = request()->routeIs('site.category') ? (string) request()->route('slug') : '';
    $tzHome = !request()->routeIs('site.category')
        && !request()->routeIs('site.article')
        && !request()->routeIs('site.services')
        && !request()->routeIs('site.about')
        && !request()->routeIs('site.archive');
@endphp
<div class="tz-topbar">
    <div class="tz-container tz-topbar-inner">
        <div class="tz-topbar-group">
            <span class="tz-topbar-dot" aria-hidden="true"></span>
            <span>{{ $companyProfile?->legalName ?: $siteName }} 官方网站</span>
            <span aria-hidden="true">|</span>
            <span>核心团队深耕工业品营销与数字化 5 年+</span>
        </div>
    </div>
</div>

<header class="tz-header">
    <div class="tz-container tz-header-row">
        <a href="{{ route('site.home') }}" class="tz-brand" aria-label="{{ $siteName }}">
            @if(!empty($siteLogo))
                <img src="{{ $siteLogo }}" alt="{{ $siteName }}" style="height:2.25rem;width:auto">
            @else
                <span class="tz-brand-mark" aria-hidden="true">桐</span>
            @endif
            <span class="tz-brand-text">
                <span class="tz-brand-name">{{ $siteName }}</span>
                <span class="tz-brand-sub">AI Growth · B2B GEO</span>
            </span>
        </a>

        <nav class="tz-nav" aria-label="主导航">
            <a href="{{ route('site.home') }}" data-nav-item="home" class="{{ $tzHome ? 'is-active' : '' }}">{{ __('front.nav.home') }}</a>

            @if(!empty($servicesUrl))
                <a href="{{ $servicesUrl }}" data-nav-item="services" class="{{ request()->routeIs('site.services') ? 'is-active' : '' }}">服务</a>
            @endif

            @foreach($navCategories->take(5) as $categoryItem)
                <a
                    href="{{ route('site.category', $categoryItem->slug) }}"
                    data-nav-item="category"
                    class="{{ $tzActiveCategory === (string) $categoryItem->slug ? 'is-active' : '' }}"
                >{{ $categoryItem->name }}</a>
            @endforeach

            <a href="{{ route('site.about') }}" data-nav-item="about" class="{{ request()->routeIs('site.about') ? 'is-active' : '' }}">关于我们</a>
        </nav>

        <div class="tz-header-cta">
            @if(!empty($contactFormUrl))
                <a class="tz-btn tz-btn-sm" href="{{ $contactFormUrl }}">免费 AI 可见性诊断</a>
            @endif
        </div>
    </div>
</header>
