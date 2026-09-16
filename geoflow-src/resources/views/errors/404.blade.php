@extends('site.layout')

@section('content')
    @php
        /*
         * 404 用前台自己的外壳。
         *
         * 2026-09-16：此前 errors/404 走的是 `errors.layout` —— 那是**后台**的错误页：
         * 无页头、无导航、无页脚，字体是 -apple-system，只加载 `css/admin-error-v3.css`。
         * 独立审计实测该页 `header=0, nav=0, footer=0`，而其余 7 个页面都是 header≥1。
         * 外链失效/输错地址是最常见的 404 入口，看到的却是一个和品牌断开的孤岛卡片。
         *
         * 这里对公共数据一律做 `?? null` 兜底：错误页比普通页更容易在"上下文不完整"时渲染，
         * 不能因为一个变量没注入就再抛一次异常。
         */
        $notFoundServicesUrl = $servicesUrl ?? '';
        $notFoundFormUrl = $contactFormUrl ?? '';
        $notFoundName = $siteName ?? config('app.name');
    @endphp
    <div class="site-container px-4 py-16 sm:px-6 lg:px-8" style="min-height: 52vh;">
        <p class="text-sm font-semibold text-gray-500">404</p>
        <h1 class="mt-2 text-3xl font-bold text-gray-900">这个页面不存在</h1>
        <p class="mt-3 max-w-2xl text-gray-600">
            你访问的地址可能已经改动或被移除。可以从下面几个入口继续：
        </p>
        <ul class="mt-6 flex flex-wrap gap-x-6 gap-y-3 text-blue-600">
            <li><a class="hover:text-blue-800" href="{{ route('site.home') }}">回到首页</a></li>
            @if($notFoundServicesUrl !== '')
                <li><a class="hover:text-blue-800" href="{{ $notFoundServicesUrl }}">我们的服务</a></li>
            @endif
            <li><a class="hover:text-blue-800" href="{{ route('site.archive') }}">文章归档</a></li>
            <li><a class="hover:text-blue-800" href="{{ route('site.about') }}">关于 {{ $notFoundName }}</a></li>
            @if($notFoundFormUrl !== '')
                <li><a class="hover:text-blue-800" href="{{ $notFoundFormUrl }}">在线留言</a></li>
            @endif
        </ul>
    </div>
@endsection
