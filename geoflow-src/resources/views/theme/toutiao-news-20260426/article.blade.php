@extends('theme.toutiao-news-20260426.layout')

@push('head')
    @php
        $schemaAtContext = chr(64).'context';
        $schemaAtType = chr(64).'type';
        $schemaAtId = chr(64).'id';
        $articleSchema = [
            $schemaAtContext => 'https://schema.org',
            $schemaAtType => 'NewsArticle',
            'headline' => $article->title,
            'description' => $pageDescription,
            'datePublished' => optional($article->published_at ?? $article->created_at)->toAtomString(),
            'dateModified' => optional($article->updated_at ?? $article->published_at ?? $article->created_at)->toAtomString(),
            'mainEntityOfPage' => [
                $schemaAtType => 'WebPage',
                $schemaAtId => $canonicalUrl ?? route('site.article', $article->slug),
            ],
            'author' => [
                $schemaAtType => 'Person',
                'name' => $article->author?->name ?? $siteTitle,
            ],
            'publisher' => [
                $schemaAtType => 'Organization',
                'name' => $siteTitle,
            ],
            'articleSection' => $article->category?->name,
            'keywords' => $tags,
        ];
    @endphp
    @if($article->category)
        <meta property="article:section" content="{{ $article->category->name }}">
    @endif
    <x-json-ld :data="$articleSchema" />
@endpush

@section('content')
    <div class="tt-shell tt-article-layout">
        <nav class="tt-breadcrumb tt-article-module" aria-label="Breadcrumb">
            <a href="{{ route('site.home') }}">{{ __('front.nav.home') }}</a>
            @if($article->category)
                <span>/</span>
                <a href="{{ route('site.category', $article->category->slug) }}">{{ $article->category->name }}</a>
            @endif
            <span>/</span>
            <span>{{ $article->title }}</span>
        </nav>

        <article class="tt-article-main tt-article-module">
            <div class="tt-card-meta">
                @if($article->category)
                    <a href="{{ route('site.category', $article->category->slug) }}" class="tt-pill">{{ $article->category->name }}</a>
                @endif
                <time datetime="{{ ($article->published_at ?? $article->created_at)?->toAtomString() }}">
                    {{ ($article->published_at ?? $article->created_at)?->format('Y-m-d') }}
                </time>
                @if($article->author)
                    <span>{{ $article->author->name }}</span>
                @endif
                <span>{{ (int) $article->view_count }} views</span>
            </div>

            <h1 class="tt-article-h1 mt-4">{{ $article->title }}</h1>

            @if($excerptPlain !== '')
                <p class="mt-5 rounded-2xl bg-gray-50 p-5 text-lg leading-8 text-gray-600">{{ $excerptPlain }}</p>
            @endif

            <div class="tt-prose">
                {!! $contentHtml !!}
            </div>

            @if(!empty($tags))
                <div class="mt-10 flex flex-wrap gap-2">
                    @foreach($tags as $tag)
                        <span class="tt-pill">{{ $tag }}</span>
                    @endforeach
                </div>
            @endif
        </article>

        @if($relatedArticles->isNotEmpty())
            <section class="tt-related-block tt-article-module">
                <div class="tt-section-title">
                    <span class="tt-title-row">{{ __('site.article_related') }}</span>
                </div>
                <div class="tt-related-grid">
                    @foreach($relatedArticles as $related)
                        <a href="{{ route('site.article', $related->slug) }}" class="tt-related-card">
                            <span class="tt-related-index">{{ $loop->iteration }}</span>
                            <span>{{ $related->title }}</span>
                        </a>
                    @endforeach
                </div>
            </section>
        @endif

        {{--
            这里原本还有一个 <aside class="tt-sidebar">（内含第二份「相关阅读」+ 站点简介面板）。
            但 `.tt-article-layout .tt-sidebar { display: none !important }` 在所有断点都把它隐藏
            （theme.css:1684），于是：DOM 里多一份重复的「相关阅读」、多几个图标节点，
            对 SEO 是重复内容，对后来改代码的人是"明明有这段为什么看不到"的陷阱。
            2026-09-16：既然从不显示，就不再渲染。相关阅读已由上面的 tt-related-block 承担。
        --}}
    </div>
@endsection
