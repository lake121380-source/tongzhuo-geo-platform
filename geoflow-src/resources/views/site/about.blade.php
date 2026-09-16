@extends('site.layout')

@push('head')
    @php
        $schemaAtContext = chr(64).'context';
        $schemaAtType = chr(64).'type';
        $aboutSchema = [
            $schemaAtContext => 'https://schema.org',
            $schemaAtType => 'AboutPage',
            'name' => $aboutTitle ?? '关于 桐灼GEO',
            'description' => $pageDescription,
            'url' => $canonicalUrl ?? route('site.about'),
        ];
    @endphp
    <x-json-ld :data="$aboutSchema" />
@endpush

@section('content')
    <div class="site-container article-page px-4 sm:px-6 lg:px-8 py-8 lg:py-10">
        <article class="article-shell article-detail-shell">
            <div class="article-detail-pad">
                <div class="article-rail mb-10">
                    @unless(!empty($isHostedAbout))
                        <p class="text-sm font-medium text-blue-600 mb-4">开源项目</p>
                    @endunless
                    <h1 class="article-hero-title font-semibold text-gray-900 mb-4 leading-tight">{{ $aboutTitle ?? '关于 桐灼GEO' }}</h1>
                    @if(!empty($isHostedAbout))
                        <p class="article-kicker text-gray-600 max-w-3xl whitespace-pre-line">{{ $aboutContent !== '' ? $aboutContent : $pageDescription }}</p>
                    @elseif($aboutContent !== '')
                        <p class="article-kicker text-gray-600 max-w-3xl whitespace-pre-line">{{ $aboutContent }}</p>
                    @else
                        <p class="article-kicker text-gray-600 max-w-3xl">
                            把可信知识、AI 内容工程与多站点分发连接起来，为持续运营的 GEO 内容资产提供一套开放的工作流。
                        </p>
                    @endif
                    @php
                        /*
                         * 联系方式此前被 `@if($isHostedAbout)` 挡住，**主站模式下永远不渲染**——
                         * 而"关于"是官网上唯一讲"这家公司是谁"的页面，恰恰最该给出联系方式。
                         * 2026-09-16 修：两种模式都显示，数据取自 CompanyProfile（与结构化数据同源）。
                         */
                        $aboutCompany = $companyProfile ?? null;
                        $aboutPhone = $aboutCompany?->phone ?? '';
                        $aboutEmail = $aboutCompany?->email ?: (string) ($contactEmail ?? '');
                        $aboutAddress = $aboutCompany?->address ?? '';
                    @endphp
                    @if($aboutPhone !== '' || $aboutEmail !== '' || $aboutAddress !== '')
                        <ul class="mt-6 space-y-1 text-sm text-gray-600">
                            @if($aboutPhone !== '')
                                <li>电话：<a class="text-blue-600 hover:text-blue-800" href="tel:{{ preg_replace('/[^0-9+]/', '', $aboutPhone) }}">{{ $aboutPhone }}</a></li>
                            @endif
                            @if($aboutEmail !== '')
                                <li>邮箱：<a class="text-blue-600 hover:text-blue-800" href="mailto:{{ $aboutEmail }}">{{ $aboutEmail }}</a></li>
                            @endif
                            @if($aboutAddress !== '')
                                <li>地址：{{ $aboutAddress }}</li>
                            @endif
                        </ul>
                    @endif
                    @unless(!empty($isHostedAbout))
                    <a href="{{ $repositoryUrl }}" class="inline-flex items-center mt-6 text-blue-600 font-medium" target="_blank" rel="noopener noreferrer">
                        GitHub 仓库
                        <i data-lucide="arrow-up-right" class="w-4 h-4 ml-2" aria-hidden="true"></i>
                    </a>
                    @endunless
                </div>

                @unless(!empty($isHostedAbout))
                <div class="article-prose article-rail max-w-none">
                    @include('site.partials.about-content')
                </div>
                @endunless
            </div>
        </article>
    </div>
@endsection
