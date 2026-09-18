<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    @include('site.partials.seo-head')
    @stack('head')
    {{--
        样式层说明：site.css 是构建期 Tailwind 产物、style.css/custom.css 是站点历史基础类，
        这套主题只用自己 theme.css 里的 .tz-* 类，不写 Tailwind 工具类——
        省掉「改了类名必须重跑 vite build」这一步。
    --}}
    @vite('resources/css/site.css')
    <link rel="stylesheet" href="{{ asset('assets/css/style.css') }}">
    <link rel="stylesheet" href="{{ asset('assets/css/custom.css') }}">
    <link rel="stylesheet" href="{{ asset('themes/tongzhuo-brand-2026/theme.css') }}">
    @if(!empty($headAnalyticsCode))
        {!! $headAnalyticsCode !!}
    @endif
    @php
        $schemaAtContext = chr(64).'context';
        $schemaAtType = chr(64).'type';
        $websiteSchema = [
            $schemaAtContext => 'https://schema.org',
            $schemaAtType => 'WebSite',
            'name' => $siteName,
            'url' => route('site.home'),
            'potentialAction' => [
                $schemaAtType => 'SearchAction',
                'target' => route('site.home').'?search={search_term_string}',
                'query-input' => 'required name=search_term_string',
            ],
        ];
    @endphp
    <x-json-ld :data="$websiteSchema" />
</head>
<body class="tz-body">
    <a class="tt-skip-link" href="#main">跳到主要内容</a>
    @include('theme.tongzhuo-brand-2026.partials.header')
    <main class="tz-main" id="main">
        @yield('content')
    </main>
    @include('theme.tongzhuo-brand-2026.partials.footer')
    @stack('scripts')
</body>
</html>
