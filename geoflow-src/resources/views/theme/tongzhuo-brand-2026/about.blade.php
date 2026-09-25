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
            @if(!empty($aboutBodyParts))
                {{--
                    后台「站点与品牌设置 → 关于页正文」配了内容：按 Markdown 渲染，
                    `{{services}}`（单独一行）处插入服务清单块——见 SiteSettingsController 的字段说明。
                --}}
                {!! $aboutBodyParts[0] !!}
                @if(count($aboutBodyParts) > 1)
                    @include('theme.tongzhuo-brand-2026.partials.about-services', ['servicesTitle' => $servicesTitle ?? '', 'companyProfile' => $tzCompany])
                    {!! implode('', array_slice($aboutBodyParts, 1)) !!}
                @endif
            @else
                {{-- 没配置：内置默认文案（2026-09-18 定稿），保证全新安装不出现空白页。 --}}
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

                @include('theme.tongzhuo-brand-2026.partials.about-services', ['servicesTitle' => $servicesTitle ?? '', 'companyProfile' => $tzCompany])

                <h2>怎么开始</h2>
                <p>
                    先聊一次你的业务和现在的线上表现，我们会说清楚哪一部分现在就能做、
                    哪一部分没把握——没把握的不会接。
                </p>
            @endif
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
        上游归属声明：**2026-09-19 哥哥要求不在对外页面展示，已摘掉。**

        这里原本是页尾一行：「本站内容系统基于开源项目 GEOFlow 构建，遵循其 AGPL-3.0 许可。
        查看上游项目 →」。归属声明本身是 AGPL 的要求（GEOFlow 是 AGPL-3.0-only，
        见 config/geoflow.php 与 NOTICE），config 里原本写明「不随品牌改名移除」——
        这次不是改名，是哥哥**明确要求撤掉对外展示**，所以按他的决定执行。

        撤掉的只是**这一页这一行**。归属并没有从产品里消失：
          · 后台欢迎弹窗（AdminWelcomeModalService：GitHub + 更新日志链接）
          · 后台顶栏的 GitHub 按钮（components/admin/v3/topbar.blade.php）
          · 后台对话框（components/admin/v3/dialogs.blade.php）
          · 源码级：LICENSE / NOTICE / CLA.md / composer.json / README 全部未动
        **将来若要把后台那几处也去掉，先确认是否已取得上游的专有授权**，
        不能只删页面——那才会真正动到许可义务。

        恢复方法：把下面这段 @if 加回来即可，`AboutController` 仍在传 `repositoryUrl`。
    --}}
@endsection
