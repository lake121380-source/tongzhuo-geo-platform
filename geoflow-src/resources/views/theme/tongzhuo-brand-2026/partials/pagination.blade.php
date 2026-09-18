@php
    /**
     * 分页。不用 Laravel 默认的 Tailwind 分页视图——那套圆角按钮与本主题的
     * 「无卡片、无圆角」直接冲突，且默认视图会带一堆用不上的包裹元素。
     *
     * @var \Illuminate\Contracts\Pagination\LengthAwarePaginator $paginator
     */
@endphp
@if($paginator->hasPages())
    <nav class="tz-pager" aria-label="分页">
        @if($paginator->onFirstPage())
            <span class="tz-pager-off">上一页</span>
        @else
            <a href="{{ $paginator->previousPageUrl() }}" rel="prev">上一页</a>
        @endif

        <span class="tz-pager-pos">第 {{ $paginator->currentPage() }} / {{ $paginator->lastPage() }} 页</span>

        @if($paginator->hasMorePages())
            <a href="{{ $paginator->nextPageUrl() }}" rel="next">下一页</a>
        @else
            <span class="tz-pager-off">下一页</span>
        @endif
    </nav>
@endif
