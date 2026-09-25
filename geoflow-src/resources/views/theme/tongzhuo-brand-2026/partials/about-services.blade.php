{{--
    服务清单块：关于页正文里 `{{services}}` 占位处插的就是它（服务页自己有另一套渲染）。
    数据来自站点设置的公司实体（与首页服务卡片 / 服务页 / Organization 结构化数据同源）；
    标题可配：`company_services_title`，默认「我们提供的服务」。
--}}
@php($tzBlockTitle = trim((string) ($servicesTitle ?? '')) !== '' ? $servicesTitle : '我们提供的服务')
<h2>{{ $tzBlockTitle }}</h2>
@if($companyProfile?->hasServices())
    <ul>
        @foreach($companyProfile->services as $tzService)
            <li>
                <strong>{{ $tzService['title'] }}</strong>@if(trim((string) ($tzService['description'] ?? '')) !== '')：{{ $tzService['description'] }}@endif
            </li>
        @endforeach
    </ul>
@else
    <p><a href="{{ route('site.services') }}">查看服务清单</a></p>
@endif
