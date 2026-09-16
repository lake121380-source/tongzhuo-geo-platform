@php
    /*
     * 页脚 = 访客最后一个「我该怎么联系你们」的机会。
     *
     * 2026-09-16 修：此前这里只有一行版权，全站可见文本里电话/邮箱出现 0 次——
     * 而同一批信息早就写在 CompanyProfile 里、也输出进了给 AI 读的结构化数据。
     * 结果是「AI 知道怎么联系你，人不知道」。现在把它接出来：
     * 联系方式直接可见（不需要点开任何东西），并给出表单入口。
     */
    $footerCompany = $companyProfile ?? null;
    $footerPhone = $footerCompany?->phone ?? '';
    $footerEmail = $footerCompany?->email ?? '';
    $footerAddress = $footerCompany?->address ?? '';
    $footerHasContact = $footerPhone !== '' || $footerEmail !== '' || $footerAddress !== '';
@endphp
<footer class="tt-footer">
    <div class="tt-shell">
        @if($footerHasContact || !empty($contactFormUrl))
            <div class="tt-footer-contact">
                @if($footerHasContact)
                    <div class="tt-footer-contact-block">
                        <p class="tt-footer-contact-title">联系我们</p>
                        <ul class="tt-footer-contact-list">
                            @if($footerPhone !== '')
                                <li>电话：<a href="tel:{{ preg_replace('/[^0-9+]/', '', $footerPhone) }}">{{ $footerPhone }}</a></li>
                            @endif
                            @if($footerEmail !== '')
                                <li>邮箱：<a href="mailto:{{ $footerEmail }}">{{ $footerEmail }}</a></li>
                            @endif
                            @if($footerAddress !== '')
                                <li>地址：{{ $footerAddress }}</li>
                            @endif
                        </ul>
                    </div>
                @endif
                <div class="tt-footer-contact-block">
                    <p class="tt-footer-contact-title">相关页面</p>
                    <ul class="tt-footer-contact-list">
                        <li><a href="{{ route('site.about') }}">关于我们</a></li>
                        <li><a href="{{ route('site.archive') }}">文章归档</a></li>
                        @if(!empty($contactFormUrl))
                            <li><a href="{{ $contactFormUrl }}">在线留言</a></li>
                        @endif
                    </ul>
                </div>
            </div>
        @endif
        <div class="tt-footer-inner">
            {{ $footerCopyright !== '' ? $footerCopyright : '© '.date('Y').' '.$siteName.'. All rights reserved.' }}
            @include("site.partials.footer-filing")
        </div>
    </div>
</footer>
