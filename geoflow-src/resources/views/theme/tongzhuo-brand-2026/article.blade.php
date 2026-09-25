@extends('theme.tongzhuo-brand-2026.layout')

@push('head')
    @php
        $schemaAtContext = chr(64).'context';
        $schemaAtType = chr(64).'type';
        $tzPublished = $article->published_at ?? $article->created_at;
        $articleSchema = array_filter([
            $schemaAtContext => 'https://schema.org',
            $schemaAtType => 'Article',
            'headline' => $article->title,
            'description' => $excerptPlain !== '' ? $excerptPlain : $pageDescription,
            'datePublished' => $tzPublished?->toAtomString(),
            'dateModified' => $article->updated_at?->toAtomString(),
            'mainEntityOfPage' => $canonicalUrl ?? null,
            'author' => $article->author?->name ? [
                $schemaAtType => 'Person',
                'name' => $article->author->name,
            ] : null,
            'publisher' => [
                $schemaAtType => 'Organization',
                // 页面正文模板拿不到 layout composer 的变量，只能用控制器传的 $siteTitle
                'name' => $siteTitle ?? '',
            ],
        ]);
    @endphp
    <x-json-ld :data="$articleSchema" />
@endpush

@section('content')
    @php
        $tzPublished = $article->published_at ?? $article->created_at;
    @endphp

    <article>
        <div class="tz-container tz-article-head">
            <div class="tz-article-meta">
                <time datetime="{{ $tzPublished?->toAtomString() }}">{{ $tzPublished?->format('Y-m-d') }}</time>
                @if($article->category)
                    <a href="{{ route('site.category', $article->category->slug) }}">{{ $article->category->name }}</a>
                @endif
                @if($article->author?->name)
                    <span>{{ $article->author->name }}</span>
                @endif
                @if((int) $article->view_count > 0)
                    <span>{{ (int) $article->view_count }} 次阅读</span>
                @endif
            </div>

            <h1 class="tz-article-title">{{ $article->title }}</h1>

            @if($excerptPlain !== '')
                <p class="tz-article-lede">{{ $excerptPlain }}</p>
            @endif
        </div>

        <div class="tz-container">
            <div class="tz-prose">
                {!! $contentHtml !!}
            </div>

            @if(!empty($tags))
                <ul class="tz-tags">
                    @foreach($tags as $tag)
                        <li>{{ $tag }}</li>
                    @endforeach
                </ul>
            @endif
        </div>
    </article>

    @if($relatedArticles->isNotEmpty())
        <div class="tz-container tz-section tz-section--top">
            {{-- 键名是 article_related（语言包里六种语言都有），不是 related_articles——
                 写错时 Laravel 找不到译文，会直接把键名渲染到页面上（原样显示 site.related_articles）。 --}}
            <h2 class="tz-section-title">{{ __('site.article_related') }}</h2>
            <div class="tz-list">
                @foreach($relatedArticles as $relatedArticle)
                    {{-- relatedArticles 只 select 了 id/title/slug 三列，不要访问 ->category --}}
                    <div class="tz-item">
                        <h3 class="tz-item-title">
                            <a href="{{ route('site.article', $relatedArticle->slug) }}">{{ $relatedArticle->title }}</a>
                        </h3>
                    </div>
                @endforeach
            </div>
        </div>
    @endif
@endsection
