@php
    /**
     * 文章索引行。
     *
     * 这套设计里没有卡片：一行就是「日期 · 分类」+ 标题 + 一句摘要，
     * 下面一条细线收尾。没有封面图（站点本来也没有这个字段），
     * 也没有「阅读全文 →」——整个标题就是链接，不需要再喊一次。
     *
     * @var \App\Models\Article $article
     */
    $tzSummaryRaw = (string) ($cardSummaries[$article->id] ?? '');
    $tzSummary = trim(preg_replace(
        ['/!\[[^\]]*]\([^)]+\)/u', '/\[[^\]]+]\([^)]+\)/u', '/[`*_>#|~-]+/u', '/\s+/u'],
        ' ',
        strip_tags($tzSummaryRaw),
    ) ?? '');
    $tzPublished = $article->published_at ?? $article->created_at;
@endphp
<article class="tz-item">
    <div class="tz-item-meta">
        <time datetime="{{ $tzPublished?->toAtomString() }}">{{ $tzPublished?->format('Y-m-d') }}</time>
        @if($article->category)
            <a href="{{ route('site.category', $article->category->slug) }}">{{ $article->category->name }}</a>
        @endif
        @if(!empty($showFeaturedBadge))
            <span>{{ __('site.home_featured_badge') }}</span>
        @endif
        @if((int) $article->view_count > 0)
            <span>{{ (int) $article->view_count }} 次阅读</span>
        @endif
    </div>
    <h2 class="tz-item-title">
        <a href="{{ route('site.article', $article->slug) }}">{{ $article->title }}</a>
    </h2>
    @if($tzSummary !== '')
        <p class="tz-item-summary">{{ $tzSummary }}</p>
    @endif
</article>
