@extends('theme.toutiao-news-20260426.layout')

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
        @include("site.partials.homepage-modules", ["homepageModules" => $homepageModules ?? [], "homepageStyle" => $homepageStyle ?? [], "showHomepageModules" => $showHomepageModules ?? false, "articles" => $articles ?? collect(), "featuredArticles" => $featuredArticles ?? collect(), "hotArticles" => $hotArticles ?? collect()])

@php
        $homepageHotArticles = collect($hotArticles ?? []);
        $homepageSlides = collect($homepageCarouselSlides ?? [])->take(3);
        $isDefaultHome = $search === '' && !$category && !$categoryMissing;
    @endphp
    <div class="tt-shell tt-layout">
        <section class="tt-feed">
            @if($search !== '')
                <div class="tt-page-head">
                    <div class="tt-page-kicker">{{ __('site.search_button') }}</div>
                    <h1 class="tt-page-title">{{ __('site.search_breadcrumb', ['term' => $search]) }}</h1>
                    <p class="tt-page-desc">{{ $pageDescription }}</p>
                </div>
            @elseif($categoryMissing)
                <div class="tt-page-head">
                    <div class="tt-page-kicker">{{ __('site.category_not_found') }}</div>
                    <h1 class="tt-page-title">{{ __('site.category_not_found') }}</h1>
                    <p class="tt-page-desc">{{ $pageDescription }}</p>
                </div>
            @else
                @if($homepageSlides->isNotEmpty())
                    <section class="tt-home-poster-carousel" data-home-poster-carousel>
                        @foreach($homepageSlides as $slide)
                            @php
                                $slideTitle = trim((string) ($slide['title'] ?? ''));
                                $slideLink = trim((string) ($slide['link_url'] ?? ''));
                                $slideAlt = $slideTitle !== '' ? $slideTitle : $siteTitle;
                            @endphp
                            @if($slideLink !== '')
                                <a href="{{ $slideLink }}" class="tt-home-poster-slide {{ $loop->first ? 'is-active' : '' }}" data-home-poster-slide>
                                    <img src="{{ $slide['image_url'] }}" alt="{{ $slideAlt }}">
                                    @if($slideTitle !== '')
                                        <span class="tt-home-poster-caption">{{ $slideTitle }}</span>
                                    @endif
                                </a>
                            @else
                                <div class="tt-home-poster-slide {{ $loop->first ? 'is-active' : '' }}" data-home-poster-slide>
                                    <img src="{{ $slide['image_url'] }}" alt="{{ $slideAlt }}">
                                    @if($slideTitle !== '')
                                        <span class="tt-home-poster-caption">{{ $slideTitle }}</span>
                                    @endif
                                </div>
                            @endif
                        @endforeach
                        @if($homepageSlides->count() > 1)
                            <div class="tt-home-poster-dots" aria-hidden="true">
                                @foreach($homepageSlides as $slide)
                                    <button type="button" class="{{ $loop->first ? 'is-active' : '' }}" data-home-poster-dot></button>
                                @endforeach
                            </div>
                        @endif
                    </section>
                @endif
                @if($homepageHotArticles->isNotEmpty())
                    <div class="tt-hot-carousel" data-hot-carousel>
                        @foreach($homepageHotArticles as $hotArticle)
                            <a href="{{ route('site.article', $hotArticle->slug) }}" class="tt-breaking {{ $loop->first ? 'is-active' : '' }}" data-hot-slide>
                                <strong>{{ __('site.home_hot_badge') }}</strong>
                                <span>{{ $hotArticle->title }}</span>
                            </a>
                        @endforeach
                        @if($homepageHotArticles->count() > 1)
                            <div class="tt-hot-dots" aria-hidden="true">
                                @foreach($homepageHotArticles as $hotArticle)
                                    <button type="button" class="{{ $loop->first ? 'is-active' : '' }}" data-hot-dot></button>
                                @endforeach
                            </div>
                        @endif
                    </div>
                @endif
            @endif

            @if($featuredArticles->isNotEmpty() && $search === '' && !$category)
                <section class="tt-feed-card">
                    <div class="tt-section-title">
                        <span class="tt-title-row">{{ __('site.home_featured') }}</span>
                    </div>
                    <div class="tt-feed">
                        @foreach($featuredArticles->take(5) as $article)
                            @include('theme.toutiao-news-20260426.partials.article-card', ['article' => $article, 'showFeaturedBadge' => true])
                        @endforeach
                    </div>
                </section>
            @endif

            {{--
                首页把文章区收成「最新观点」精选 3 条。
                2026-09-16：此前首页铺的是**全部文章的信息流**（带分页、带侧栏热榜），
                那是内容站的形态——访客来官网是判断"这家公司行不行"，不是来读资讯的；
                而且主列表和侧栏「最新文章」列的是同两篇（重复内容）。
                现在文章在首页只承担"证明这家公司在持续输出"的作用，看更多去归档页。
                搜索/分类结果页不受影响，仍走原来的完整列表 + 分页。
            --}}
            <section class="tt-feed-card">
                <div class="tt-section-title">
                    <span class="tt-title-row">{{ $isDefaultHome ? __('site.home_insights') : $viewTitle }}</span>
                    @if($isDefaultHome && $articles->isNotEmpty())
                        <a class="tt-title-more" href="{{ route('site.archive') }}">{{ __('site.home_view_all') }} →</a>
                    @endif
                </div>
                <div class="tt-feed">
                    @forelse($isDefaultHome ? $articles->take(3) : $articles as $article)
                        @include('theme.toutiao-news-20260426.partials.article-card', ['article' => $article])
                    @empty
                        <div class="rounded-2xl border border-dashed border-gray-200 bg-white p-10 text-center text-gray-500">
                            {{ __('site.home_empty_title') }}
                        </div>
                    @endforelse
                </div>
            </section>

            @unless($isDefaultHome)
                <div class="mt-3">
                    {{ $articles->links() }}
                </div>
            @endunless
        </section>

        {{-- 首页不再要侧栏：那栏的「最新文章」和主列表是同一批内容，
             「桐灼 GEO Feed」面板又把 hero 讲过的话重复一遍。搜索/分类页保留。 --}}
        @unless($isDefaultHome)
            @include('theme.toutiao-news-20260426.partials.sidebar', ['showFeedPanel' => false])
        @endunless
    </div>
@endsection
