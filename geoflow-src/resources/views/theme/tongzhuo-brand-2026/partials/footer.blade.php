@php
    /*
     * 页脚是这套设计里唯一「大胆」的地方：电话号码以 display 尺寸呈现。
     *
     * 这门生意的转化就是通电话，而多数站点把联系方式以 14px 藏在页脚。
     * 它不装饰、只服务转化——把全页最大的一级字号给「怎么找到我们」，是这门
     * 生意本身决定的，不是风格选择。
     */
    $tzCompany = $companyProfile ?? null;
    $tzPhone = trim((string) ($tzCompany?->phone ?? ''));
    $tzEmail = trim((string) ($tzCompany?->email ?? ''));
    $tzAddress = trim((string) ($tzCompany?->address ?? ''));
    $tzTelHref = preg_replace('/[^0-9+]/', '', $tzPhone);
@endphp
<footer class="tz-footer">
    <div class="tz-container">
        @if($tzPhone !== '')
            {{-- 电话直接以 tel: 呈现，不需要点开任何东西就能看见 --}}
            <a class="tz-contact-call" href="tel:{{ $tzTelHref }}">{{ $tzPhone }}</a>
            <p class="tz-contact-lede">打电话，或留个联系方式，我们尽快回复。</p>
        @else
            <p class="tz-contact-lede">留个联系方式，我们尽快回复。</p>
        @endif

        @if(!empty($contactFormUrl))
            <div class="tz-contact-actions">
                <a class="tz-btn" href="{{ $contactFormUrl }}">在线留言</a>
                @if($tzEmail !== '')
                    <a href="mailto:{{ $tzEmail }}">{{ $tzEmail }}</a>
                @endif
            </div>
        @endif

        <div class="tz-footer-grid">
            @if($tzPhone !== '' || $tzEmail !== '' || $tzAddress !== '')
                <div>
                    <p class="tz-footer-label">联系我们</p>
                    <ul class="tz-footer-list">
                        @if($tzPhone !== '')
                            <li>电话：<a href="tel:{{ $tzTelHref }}">{{ $tzPhone }}</a></li>
                        @endif
                        @if($tzEmail !== '')
                            <li>邮箱：<a href="mailto:{{ $tzEmail }}">{{ $tzEmail }}</a></li>
                        @endif
                        @if($tzAddress !== '')
                            <li>地址：{{ $tzAddress }}</li>
                        @endif
                    </ul>
                </div>
            @endif

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
        </div>

        <div class="tz-footer-base">
            <span>{{ $footerCopyright !== '' ? $footerCopyright : '© '.date('Y').' '.$siteName.'。保留所有权利。' }}</span>
            {{-- 备案号：site.partials.footer-filing 是共享分部，测试会遍历所有主题断言它可见，别删。 --}}
            @include('site.partials.footer-filing')
        </div>
    </div>
</footer>
