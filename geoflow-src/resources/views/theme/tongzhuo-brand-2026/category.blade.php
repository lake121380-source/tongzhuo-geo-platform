@extends('theme.tongzhuo-brand-2026.layout')

@section('content')
    <div class="tz-container tz-page-head">
        <h1 class="tz-page-title">{{ $category->name }}</h1>
        @if(trim((string) $category->description) !== '')
            <p class="tz-page-lede">{{ $category->description }}</p>
        @endif
    </div>

    <div class="tz-container tz-section">
        <div class="tz-list">
            @forelse($articles as $article)
                @include('theme.tongzhuo-brand-2026.partials.article-card', ['article' => $article])
            @empty
                <p class="tz-page-lede">{{ __('site.home_empty_title') }}</p>
            @endforelse
        </div>

        @include('theme.tongzhuo-brand-2026.partials.pagination', ['paginator' => $articles])
    </div>
@endsection
