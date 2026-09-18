@php
    $path = request()->path();
    $isHome = $path === '' || $path === '/';
@endphp
<header class="tt-header">
    <div class="tt-shell">
        <div class="tt-header-row">
            <a href="{{ route('site.home') }}" class="tt-brand" aria-label="{{ $siteName }}">
                @if(!empty($siteLogo))
                    <img src="{{ $siteLogo }}" alt="{{ $siteName }}" class="h-9 w-auto max-w-48 object-contain">
                @else
                    <span>{{ $siteName }}</span>
                @endif
            </a>

            <nav class="tt-topnav" aria-label="Primary">
                <a href="{{ route('site.home') }}" data-nav-item="home" class="{{ $isHome ? 'is-active' : '' }}">{{ __('front.nav.home') }}</a>
                @if(!empty($servicesUrl))
                    <a href="{{ $servicesUrl }}" data-nav-item="services">服务</a>
                @endif
                @foreach($navCategories->take(5) as $categoryItem)
                    <a href="{{ route('site.category', $categoryItem->slug) }}">{{ $categoryItem->name }}</a>
                @endforeach
                {{-- 「关于我们」压轴：分类是内容栏目、最多 5 个，排在末尾会把关于挤到很靠右。 --}}
                <a href="{{ route('site.about') }}" data-nav-item="about">关于我们</a>
            </nav>

            {{-- aria-label 原来写的是「分类」，但它控制的是整个移动导航；补上 aria-expanded，
                 否则屏幕阅读器读不出菜单当前是开还是关。 --}}
            <button type="button" class="tt-mobile-menu" onclick="const nav=document.getElementById('ttMobileNav'); const open=nav?.classList.toggle('hidden') === false; this.setAttribute('aria-expanded', open ? 'true' : 'false');" aria-label="打开导航菜单" aria-expanded="false" aria-controls="ttMobileNav">
                <i data-lucide="menu" class="w-7 h-7"></i>
            </button>
        </div>
        <div id="ttMobileNav" class="hidden pb-4">
            <div class="tt-channel-rail !sticky !top-auto">
                <a href="{{ route('site.home') }}" data-nav-item="home" class="tt-channel {{ $isHome ? 'is-active' : '' }}">{{ __('front.nav.home') }}</a>
                @if(!empty($servicesUrl))
                    <a href="{{ $servicesUrl }}" data-nav-item="services" class="tt-channel">服务</a>
                @endif
                @foreach($navCategories as $categoryItem)
                    <a href="{{ route('site.category', $categoryItem->slug) }}" class="tt-channel">{{ $categoryItem->name }}</a>
                @endforeach
                <a href="{{ route('site.about') }}" data-nav-item="about" class="tt-channel">关于我们</a>
            </div>
        </div>
    </div>
</header>
