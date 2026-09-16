@php
    /*
     * 站点页脚（site.* 视图使用：关于页 / 归档页 / 表单页 / 404）。
     * 2026-09-16：此前只有版权 + 一行「关于」链接，没有任何联系方式——
     * 与主题页脚同样的问题，一起接上 CompanyProfile。
     */
    $footerCompany = $companyProfile ?? null;
    $footerPhone = $footerCompany?->phone ?? '';
    $footerEmail = $footerCompany?->email ?? '';
    $footerAddress = $footerCompany?->address ?? '';
@endphp
<footer class="bg-white border-t border-gray-100 mt-16">
    <div class="site-container px-4 sm:px-6 lg:px-8 py-8">
        <div class="text-center">
            @if($footerPhone !== '' || $footerEmail !== '' || $footerAddress !== '')
                <ul class="mb-4 space-y-1 text-sm text-gray-600">
                    @if($footerPhone !== '')
                        <li>电话：<a class="text-blue-600 hover:text-blue-800" href="tel:{{ preg_replace('/[^0-9+]/', '', $footerPhone) }}">{{ $footerPhone }}</a></li>
                    @endif
                    @if($footerEmail !== '')
                        <li>邮箱：<a class="text-blue-600 hover:text-blue-800" href="mailto:{{ $footerEmail }}">{{ $footerEmail }}</a></li>
                    @endif
                    @if($footerAddress !== '')
                        <li>地址：{{ $footerAddress }}</li>
                    @endif
                </ul>
            @endif
            <p class="text-gray-500 text-sm">{{ $footerCopyright !== '' ? $footerCopyright : '© '.date('Y').' '.$siteName }}</p>
            {{--
                这里刻意**不放**「文章归档」：这条共享页脚被 apple_support_clone 等主题的布局引用，
                而 `EnterpriseSignatureThemeTest::test_legacy_apple_theme_uses_the_about_navigation`
                明确要求那些主题只出「关于」、不出归档入口。要加入口请改主题自己的页脚。
            --}}
            <div class="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm">
                <a href="{{ route('site.about') }}" class="text-gray-500 hover:text-gray-900">关于 {{ $siteName }}</a>
                @if(!empty($contactFormUrl))
                    <a href="{{ $contactFormUrl }}" class="text-gray-500 hover:text-gray-900">在线留言</a>
                @endif
            </div>
            @include("site.partials.footer-filing")
        </div>
    </div>
</footer>
