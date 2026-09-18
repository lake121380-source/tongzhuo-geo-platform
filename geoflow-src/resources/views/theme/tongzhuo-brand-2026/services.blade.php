@extends('theme.tongzhuo-brand-2026.layout')

@php
    // ServiceController 保证 $companyServices 非空（没配服务清单时这一页直接 404，
    // 不渲染空壳——导航入口也按同一条件隐藏，不给点不通的入口）。
    $tzServices = is_array($companyServices ?? null) ? $companyServices : [];
@endphp

@section('content')
    <div class="tz-container tz-page-head">
        {{--
            H1 不用 $pageTitle：那是给 <title> 的 SEO 串（「服务 - 桐灼GEO」），
            当可见标题会把品牌名重复一遍（页头刚写过）。<title> 仍由 seo-head 输出。
        --}}
        <h1 class="tz-page-title">我们提供的服务</h1>
        @if(trim((string) ($pageDescription ?? '')) !== '')
            <p class="tz-page-lede">{{ $pageDescription }}</p>
        @endif
    </div>

    <div class="tz-container tz-section">
        <ul class="tz-services">
            @foreach($tzServices as $tzService)
                <li>
                    <h2 class="tz-service-title">{{ $tzService['title'] ?? '' }}</h2>
                    @if(trim((string) ($tzService['description'] ?? '')) !== '')
                        <p class="tz-service-desc">{{ $tzService['description'] }}</p>
                    @endif
                </li>
            @endforeach
        </ul>
    </div>

    @if(!empty($contactFormUrl))
        <div class="tz-container tz-section tz-section--top">
            <h2 class="tz-section-title">想聊聊你的情况？</h2>
            <p class="tz-page-lede">留下联系方式，我们尽快回复。</p>
            <p style="margin-top:2rem">
                <a class="tz-btn" href="{{ $contactFormUrl }}">在线留言</a>
            </p>
        </div>
    @endif
@endsection
