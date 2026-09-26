@extends('theme.tongzhuo-brand-2026.layout')

@php
    // $archives 是纯数组：list<array{year:string, month:string, count:int}>，按年、月倒序。
    $tzArchives = is_array($archives ?? null) ? $archives : [];
@endphp

@section('content')
    <div class="tz-container tz-page-head">
        <h1 class="tz-page-title">文章归档</h1>
        @if(trim((string) ($pageDescription ?? '')) !== '')
            <p class="tz-page-lede">{{ $pageDescription }}</p>
        @endif
    </div>

    <div class="tz-container tz-section">
        @if(count($tzArchives) > 0)
            {{-- 这一页此前只有 h1、没有任何二级标题（2026-09-19 SEO 审计提的）。 --}}
            <h2 class="tz-section-title">{{ __('site.archive_by_month') }}</h2>
            <ul class="tz-months">
                @foreach($tzArchives as $tzMonth)
                    <li class="tz-month">
                        <a href="{{ route('site.archive.month', ['year' => $tzMonth['year'], 'month' => $tzMonth['month']]) }}">
                            {{ $tzMonth['year'] }} 年 {{ (int) $tzMonth['month'] }} 月
                        </a>
                        <span class="tz-month-count">{{ (int) $tzMonth['count'] }} 篇</span>
                    </li>
                @endforeach
            </ul>
        @else
            <p class="tz-page-lede">{{ __('site.home_empty_title') }}</p>
        @endif
    </div>
@endsection
