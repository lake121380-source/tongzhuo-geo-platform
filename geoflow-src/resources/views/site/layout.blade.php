@php
    /*
     * 外壳统一（2026-09-16）。
     *
     * 此前：首页/文章页/分类页走主题外壳（`theme.*.layout`），而关于页/归档页/服务页/表单页/404
     * 走 `site.layout` 自带的那套页头页脚——两者导航项、配色、布局都不同，访客从首页点进
     * 「关于」会以为跳到了另一个网站。
     *
     * 现在：只要当前主题提供了 `partials/header` / `partials/footer`，这里就用它的，
     * 并挂上主题自己的 `theme.css`。主题没有这些文件时退回 `site.partials.*`（原有行为）。
     * 已核实 `theme.css` 是完全命名空间化的（只有 `:root` 变量与 `.tt-*` 类，0 个裸元素选择器），
     * 所以引入它不会污染这些页面的版式。
     */
    $shellThemeId = \App\Support\Site\SiteThemeViewResolver::activeThemeId();
    $themeHeaderView = $shellThemeId !== '' && view()->exists('theme.'.$shellThemeId.'.partials.header')
        ? 'theme.'.$shellThemeId.'.partials.header'
        : 'site.partials.header';
    $themeFooterView = $shellThemeId !== '' && view()->exists('theme.'.$shellThemeId.'.partials.footer')
        ? 'theme.'.$shellThemeId.'.partials.footer'
        : 'site.partials.footer';
    $themeCss = $shellThemeId !== '' ? 'themes/'.$shellThemeId.'/theme.css' : '';
    $hasThemeCss = $themeCss !== '' && file_exists(public_path($themeCss));
@endphp
<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    @include('site.partials.seo-head')
    @stack('head')
    {{-- Tailwind 改为构建期产出（原先加载 407KB 的 Play CDN，官方明确不得用于生产；
         详见 resources/css/site.css 的说明）。改动前台类名后需重新 vite build。 --}}
    @vite('resources/css/site.css')
    <link rel="stylesheet" href="{{ asset('assets/css/style.css') }}">
    <link rel="stylesheet" href="{{ asset('assets/css/custom.css') }}">
    @if($hasThemeCss)
        <link rel="stylesheet" href="{{ asset($themeCss) }}">
    @endif
    <script src="{{ asset('js/lucide.min.js') }}"></script>
    @if(!empty($headAnalyticsCode))
        {!! $headAnalyticsCode !!}
    @endif
</head>
{{--
    body 类：主题有 CSS 时用 `.theme-shell`（与主题的 `.tt-body` 挂同一组令牌，
    底色与字体一致），没有主题时退回 Tailwind 的 `bg-white`。
    2026-09-16：此前这里固定写 `bg-white`，导致同一个站有两支正文字体、两种页面底色。
--}}
<body class="{{ $hasThemeCss ? 'theme-shell' : 'bg-white' }}">
    <a class="tt-skip-link" href="#main">跳到主要内容</a>
    @include($themeHeaderView)
    <main id="main">
        @yield('content')
    </main>
    @include($themeFooterView)
    @stack('scripts')
    <script src="{{ asset('assets/js/main.js') }}"></script>
    <script>
        document.addEventListener('DOMContentLoaded', function () {
            if (typeof lucide !== 'undefined') {
                lucide.createIcons();
            }
        });
    </script>
</body>
</html>
