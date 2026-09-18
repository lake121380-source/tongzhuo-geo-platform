@php
    /*
     * 页脚 = 四列：公司实体 / 服务 / 市场 / 转化入口。
     *
     * 保留「联系方式直接可见」（不需要点开任何东西）这条——
     * 2026-09-16 修过一次「AI 知道怎么联系你、人不知道」，别再退回去。
     */
    $tzCompany = $companyProfile ?? null;
    $tzPhone = trim((string) ($tzCompany?->phone ?? ''));
    $tzEmail = trim((string) ($tzCompany?->email ?? ''));
    $tzAddress = trim((string) ($tzCompany?->address ?? ''));
    $tzTelHref = preg_replace('/[^0-9+]/', '', $tzPhone);
@endphp
<footer class="tz-footer">
    <div class="tz-container">
        <div class="tz-footer-grid">
            <div>
                <p class="tz-footer-label">{{ $siteName }}</p>
                <p class="tz-footer-note">
                    面向工业品与中小企业的 AI 营销增长服务商。
                    让好企业，在 AI 时代被客户与大模型准确看见。
                </p>
                <ul class="tz-footer-list" style="font-family:var(--tz-mono);font-size:var(--tz-2xs)">
                    @if($tzCompany?->legalName)
                        <li>{{ $tzCompany->legalName }}</li>
                    @endif
                    @if($tzAddress !== '')
                        <li>{{ $tzAddress }}</li>
                    @endif
                </ul>
            </div>

            <div>
                <p class="tz-footer-label">核心业务</p>
                <ul class="tz-footer-list">
                    <li><a href="{{ !empty($servicesUrl) ? $servicesUrl : route('site.home') }}">全域 AI 搜索 GEO 优化</a></li>
                    <li><a href="{{ !empty($servicesUrl) ? $servicesUrl : route('site.home') }}">工业品短视频获客运营</a></li>
                    <li><a href="{{ !empty($servicesUrl) ? $servicesUrl : route('site.home') }}">企业 AI 落地与 Agent 定制</a></li>
                </ul>
            </div>

            <div>
                <p class="tz-footer-label">相关页面</p>
                <ul class="tz-footer-list">
                    <li><a href="{{ route('site.about') }}">关于我们</a></li>
                    <li><a href="{{ route('site.archive') }}">文章归档</a></li>
                    @if(!empty($contactFormUrl))
                        <li><a href="{{ $contactFormUrl }}">在线留言</a></li>
                    @endif
                </ul>
            </div>

            <div>
                <p class="tz-footer-label">联系我们</p>
                <ul class="tz-footer-list">
                    @if($tzPhone !== '')
                        <li>电话：<a href="tel:{{ $tzTelHref }}">{{ $tzPhone }}</a></li>
                    @endif
                    @if($tzEmail !== '')
                        <li>邮箱：<a href="mailto:{{ $tzEmail }}">{{ $tzEmail }}</a></li>
                    @endif
                </ul>
                @if(!empty($contactFormUrl))
                    <p style="margin-top:1rem">
                        <a class="tz-btn tz-btn-sm" href="{{ $contactFormUrl }}">预约免费诊断</a>
                    </p>
                @endif
            </div>
        </div>

        <div class="tz-footer-base">
            <span>{{ $footerCopyright !== '' ? $footerCopyright : '© '.date('Y').' '.$siteName.'。保留所有权利。' }}</span>
            {{-- 备案号：site.partials.footer-filing 是共享分部，测试会遍历所有主题断言它可见，别删。 --}}
            @include('site.partials.footer-filing')
            {{--
                上游归属声明（AGPL）由「关于我们」页承担 —— AboutController:51 传 $repositoryUrl，
                页脚拿不到控制器的变量（composer 只注入 siteName/companyProfile 等），
                而 config 里也没有对应的键。**不要在这里臆造一个 config 键。**
            --}}
        </div>
    </div>
</footer>
