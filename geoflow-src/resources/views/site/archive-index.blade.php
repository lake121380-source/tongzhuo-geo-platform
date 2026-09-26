@extends('site.layout')

@section('content')
    <div class="site-container px-4 py-8 sm:px-6 lg:px-8">
        <h1 class="site-page-title mb-6">{{ __('site.archive_title') }}</h1>

        @if(count($archives) === 0)
            <p class="text-gray-600">{{ __('site.archive_empty') }}</p>
        @else
            {{-- 这一页原本文档结构只有 h1，没有任何二级标题（2026-09-19 SEO 审计提的）。
                 给列表补一个 h2，让页面有层级。 --}}
            <h2 class="text-lg font-semibold text-gray-900 mb-3">{{ __('site.archive_by_month') }}</h2>
            <ul class="space-y-3">
                @foreach($archives as $row)
                    <li>
                        <a href="{{ route('site.archive.month', ['year' => $row['year'], 'month' => $row['month']]) }}" class="text-blue-600 hover:text-blue-800">
                            {{ $row['year'] }}-{{ $row['month'] }}
                        </a>
                        <span class="ml-2 text-sm text-gray-500">({{ $row['count'] }})</span>
                    </li>
                @endforeach
            </ul>
        @endif
    </div>
@endsection
