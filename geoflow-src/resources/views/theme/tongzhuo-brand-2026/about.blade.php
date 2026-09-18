@extends('theme.tongzhuo-brand-2026.layout')

@php
    /*
     * ⚠️ 这一页在 2026-09-18 重设计时**整篇重写过文案**。
     *
     * 此前渲染的是 resources/views/site/partials/about-content.blade.php，
     * 那篇把「桐灼GEO」描述成「一套面向 GEO 的开源智能内容工程与多站点分发系统」，
     * 还挂着 GitHub 仓库按钮 —— 讲的是上游开源项目 GEOFlow，不是这家公司。
     * 访客从首页（「面向工业品与中小企业的 AI 营销增长服务商」）点进「关于我们」，
     * 会以为走错了地方。同一份信息在 site_settings 里明明有正确的一份（首页 hero、
     * 结构化数据、llms.txt 都用它），只有这一页是脱节的。
     *
     * 现在改为介绍公司本体。上游归属声明（AGPL 要求）保留在页尾，但降为一行说明。
     */
    $tzCompany = $companyProfile ?? null;
    $tzLegalName = trim((string) ($tzCompany?->legalName ?? ''));
    $tzAddress = trim((string) ($tzCompany?->address ?? ''));
    $tzFounded = trim((string) ($tzCompany?->foundingDate ?? ''));
    $tzEmail = trim((string) ($tzCompany?->email ?? ''));
    $tzPhone = trim((string) ($tzCompany?->phone ?? ''));
    $tzTelHref = preg_replace('/[^0-9+]/', '', $tzPhone);
    $tzLede = trim((string) ($tzCompany?->description ?? ''));
    $tzHasFacts = $tzLegalName !== '' || $tzAddress !== '' || $tzFounded !== '' || $tzEmail !== '' || $tzPhone !== '';
@endphp

@section('content')
    <div class="tz-container tz-page-head">
        <h1 class="tz-page-title">{{ $pageTitle }}</h1>
        @if($tzLede !== '')
            <p class="tz-page-lede">{{ $tzLede }}</p>
        @endif
    </div>

    <div class="tz-container tz-section">
        <div class="tz-prose">
            <p>
                客户现在越来越多先问 AI，而不是先翻搜索引擎。如果 AI 答不上来你，
                或者把你答错了，生意就在这一步丢掉了——而这一步，多数企业自己看不见，
                也没法验证。
            </p>
            <p>
                我们做的事就是把这件事变成可控的：把企业的业务资料、行业经验和真实案例，
                整理成 AI 能读懂、能引用、也能追溯来源的信源，再持续地把它发布出去。
                客户在 AI 那边问到相关问题的时候，能被找到、被准确地说起。
            </p>
            <p>
                这件事没有捷径，也不靠堆量。它靠的是资料本身是不是完整、可核验，
                以及内容是不是真的在回答客户的问题——所以我们的每一个交付物，
                都能说清楚它出自哪份资料、依据哪条规则、由谁放行。
            </p>

            <h2>我们提供的服务</h2>
            @if($tzCompany?->hasServices())
                <ul>
                    @foreach($tzCompany->services as $tzService)
                        <li>
                            <strong>{{ $tzService['title'] }}</strong>@if(trim((string) ($tzService['description'] ?? '')) !== '')：{{ $tzService['description'] }}@endif
                        </li>
                    @endforeach
                </ul>
            @else
                <p><a href="{{ route('site.services') }}">查看服务清单</a></p>
            @endif

            <h2>怎么开始</h2>
            <p>
                先聊一次你的业务和现在的线上表现，我们会说清楚哪一部分现在就能做、
                哪一部分没把握——没把握的不会接。
            </p>
        </div>
    </div>

    @if($tzHasFacts)
        <div class="tz-container tz-section tz-section--top">
            <h2 class="tz-section-title">公司信息</h2>
            <div class="tz-footer-grid">
                <div>
                    <p class="tz-footer-label">主体</p>
                    <ul class="tz-footer-list">
                        @if($tzLegalName !== '')
                            <li>{{ $tzLegalName }}</li>
                        @endif
                        @if($tzFounded !== '')
                            <li>成立于 {{ $tzFounded }}</li>
                        @endif
                        @if($tzAddress !== '')
                            <li>{{ $tzAddress }}</li>
                        @endif
                    </ul>
                </div>
                <div>
                    <p class="tz-footer-label">联系方式</p>
                    <ul class="tz-footer-list">
                        @if($tzPhone !== '')
                            <li>电话：<a href="tel:{{ $tzTelHref }}">{{ $tzPhone }}</a></li>
                        @endif
                        @if($tzEmail !== '')
                            <li>邮箱：<a href="mailto:{{ $tzEmail }}">{{ $tzEmail }}</a></li>
                        @endif
                    </ul>
                </div>
            </div>
        </div>
    @endif

    {{--
        上游归属声明。config/geoflow.php:8-11 写明这条链接不随品牌改名移除
        （GEOFlow 是 AGPL-3.0-only，归属声明是许可要求）。但它不该是这一页的主角，
        所以降为页尾一行说明，而不是原来那个醒目的按钮。
    --}}
    @if(!empty($repositoryUrl))
        <div class="tz-container tz-section">
            <p class="tz-attribution">
                本站内容系统基于开源项目 GEOFlow 构建，遵循其 AGPL-3.0 许可。
                <a href="{{ $repositoryUrl }}" rel="noopener noreferrer">查看上游项目</a>
            </p>
        </div>
    @endif
@endsection
