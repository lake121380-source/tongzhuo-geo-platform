@extends('theme.tongzhuo-brand-2026.layout')

@push('head')
    @php
        $schemaAtContext = chr(64).'context';
        $schemaAtType = chr(64).'type';
        $schemaItems = [];
        foreach ((is_object($articles ?? null) && method_exists($articles, 'getCollection') ? $articles->getCollection() : collect($articles ?? []))->take(10) as $schemaArticle) {
            $schemaItems[] = [
                $schemaAtType => 'ListItem',
                'position' => count($schemaItems) + 1,
                'url' => route('site.article', $schemaArticle->slug),
                'name' => $schemaArticle->title,
            ];
        }
        $collectionSchema = [
            $schemaAtContext => 'https://schema.org',
            $schemaAtType => 'CollectionPage',
            'name' => $pageTitle,
            'description' => $pageDescription,
            'url' => $canonicalUrl ?? route('site.home'),
            'mainEntity' => [
                $schemaAtType => 'ItemList',
                'itemListElement' => $schemaItems,
            ],
        ];
    @endphp
    <x-json-ld :data="$collectionSchema" />
@endpush

@section('content')
    @php
        $tzIsDefaultHome = $search === '' && !$category && !$categoryMissing;
        // 首页只列 3 条：文章在这里的作用是「证明这家公司还在持续输出」，
        // 不是内容分发。看全部去归档页。
        $tzListArticles = $tzIsDefaultHome ? $articles->take(3) : $articles;
    @endphp

    {{--
        首页模块（hero / 服务 / CTA…）由后台的 homepage_modules 配置驱动。
        这里复用共享分部而不是自己重写：它承载了 h1 唯一性、空态跳过、
        lead_form 解析这些正确性语义，重写一遍迟早和后面的修复漂移。
        本主题只通过 theme.css 覆盖它的版式。
    --}}
    @include('site.partials.homepage-modules', [
        'homepageModules' => $homepageModules ?? [],
        'homepageStyle' => $homepageStyle ?? [],
        'showHomepageModules' => $showHomepageModules ?? false,
        'articles' => $articles ?? collect(),
        'featuredArticles' => $featuredArticles ?? collect(),
        'hotArticles' => $hotArticles ?? collect(),
        'leadForms' => $leadForms ?? collect(),
    ])

    @unless($tzIsDefaultHome)
        {{-- 搜索态与分类不存在态：模块区不渲染，标题由这里出（保证每页恰好一个 h1） --}}
        <div class="tz-container tz-page-head">
            <h1 class="tz-page-title">
                @if($search !== '')
                    {{ __('site.search_breadcrumb', ['term' => $search]) }}
                @else
                    {{ __('site.category_not_found') }}
                @endif
            </h1>
            <p class="tz-page-lede">{{ $pageDescription }}</p>
        </div>
    @endunless

    <div class="tz-container tz-section">
        <h2 class="tz-section-title">
            {{ $tzIsDefaultHome ? __('site.home_insights') : $viewTitle }}
        </h2>

        <div class="tz-list">
            @forelse($tzListArticles as $article)
                @include('theme.tongzhuo-brand-2026.partials.article-card', ['article' => $article])
            @empty
                <p class="tz-page-lede">{{ __('site.home_empty_title') }}</p>
            @endforelse
        </div>

        @if($tzIsDefaultHome && $articles->isNotEmpty())
            <p style="margin-top:2.5rem">
                <a class="tz-btn" href="{{ route('site.archive') }}">{{ __('site.home_view_all') }}</a>
            </p>
        @endif

        @unless($tzIsDefaultHome)
            @include('theme.tongzhuo-brand-2026.partials.pagination', ['paginator' => $articles])
        @endunless
    </div>
@endsection
