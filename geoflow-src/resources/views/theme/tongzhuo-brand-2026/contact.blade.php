@extends('theme.tongzhuo-brand-2026.layout')

@php
    /*
     * 联系我们（2026-09-25 新增，哥哥要求）。
     * 联系方式全部来自站点设置里的「公司实体」（与首页 / 关于页 / Organization 结构化数据 /
     * llms.txt 同源，见 CompanyProfile）——运营改电话邮箱只需要在后台改一处。
     */
    $tzCompany = $companyProfile ?? null;
    $tzPhone = trim((string) ($tzCompany?->phone ?? ''));
    $tzTelHref = preg_replace('/[^0-9+]/', '', $tzPhone);
    $tzEmail = trim((string) ($tzCompany?->email ?? ''));
    $tzAddress = trim((string) ($tzCompany?->address ?? ''));
    $tzLegalName = trim((string) ($tzCompany?->legalName ?? ''));
@endphp

@section('content')
    <div class="tz-container tz-page-head">
        <h1 class="tz-page-title">联系我们</h1>
        @if(trim((string) ($pageDescription ?? '')) !== '')
            <p class="tz-page-lede">{{ $pageDescription }}</p>
        @endif
    </div>

    <div class="tz-container tz-section">
        <div class="tz-footer-grid">
            <div>
                <p class="tz-footer-label">直接联系</p>
                <ul class="tz-footer-list">
                    @if($tzPhone !== '')
                        <li>电话：<a href="tel:{{ $tzTelHref }}">{{ $tzPhone }}</a></li>
                    @endif
                    @if($tzEmail !== '')
                        <li>邮箱：<a href="mailto:{{ $tzEmail }}">{{ $tzEmail }}</a></li>
                    @endif
                    @if($tzPhone === '' && $tzEmail === '')
                        <li>联系方式尚未配置——请在后台「站点与品牌设置 → 公司实体信息」中填写。</li>
                    @endif
                </ul>
            </div>

            <div>
                <p class="tz-footer-label">在线留言</p>
                @if(!empty($contactFormUrl))
                    <ul class="tz-footer-list">
                        <li>说清你的行业和想解决的问题，我们会在一个工作日内回复。</li>
                    </ul>
                    <p style="margin-top:.75rem"><a class="tz-btn" href="{{ $contactFormUrl }}">去填表单</a></p>
                @else
                    <ul class="tz-footer-list">
                        <li>在线表单尚未开通——先打电话或发邮件都可以。</li>
                    </ul>
                @endif
            </div>

            @if($tzLegalName !== '' || $tzAddress !== '')
                <div>
                    <p class="tz-footer-label">公司主体</p>
                    <ul class="tz-footer-list">
                        @if($tzLegalName !== '')
                            <li>{{ $tzLegalName }}</li>
                        @endif
                        @if($tzAddress !== '')
                            <li>{{ $tzAddress }}</li>
                        @endif
                    </ul>
                </div>
            @endif
        </div>
    </div>
@endsection
