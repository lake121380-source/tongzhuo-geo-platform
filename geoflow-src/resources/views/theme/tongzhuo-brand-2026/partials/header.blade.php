@php
    /*
     * 页头没有移动端汉堡菜单，靠折行。
     * 站点常年只有 4–6 个短项，折行的可用性和健壮性都优于一个需要 JS 的抽屉——
     * 少一个会坏的部件，也少一整个键盘可达性的坑。
     *
     * 导航顺序：首页 · 服务 · 分类… · 关于我们（2026-09-18 哥哥定的）。
     * 分类最多 5 个。
     */
    $tzActiveCategory = request()->routeIs('site.category') ? (string) request()->route('slug') : '';
@endphp
<header class="tz-header">
    <div class="tz-container tz-header-row">
        <a href="{{ route('site.home') }}" class="tz-brand" aria-label="{{ $siteName }}">{{ $siteName }}</a>

        <nav class="tz-nav" aria-label="主导航">
            <a href="{{ route('site.home') }}" data-nav-item="home" class="{{ request()->routeIs('site.home') ? 'is-active' : '' }}">{{ __('front.nav.home') }}</a>

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
    </div>
</header>
