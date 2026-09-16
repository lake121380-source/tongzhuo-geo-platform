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
    <link rel="stylesheet" href="{{ asset('themes/apple_support_clone/theme.css') }}">
    <script src="{{ asset('js/lucide.min.js') }}"></script>
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
<body class="as-body">
    @include('site.partials.header')
    <main class="as-main">
        <div class="apple-support-theme">
            @yield('theme_content')
        </div>
    </main>
    @include('site.partials.footer')
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
