@extends('site.layout')

@push('head')
    @php
        $schemaAtContext = chr(64).'context';
        $schemaAtType = chr(64).'type';
        $serviceSchema = [
            $schemaAtContext => 'https://schema.org',
            $schemaAtType => 'ItemList',
            'name' => $pageTitle,
            'description' => $pageDescription,
            'url' => $canonicalUrl ?? route('site.services'),
            'itemListElement' => array_values(array_map(
                static fn (array $service, int $index): array => [
                    $schemaAtType => 'ListItem',
                    'position' => $index + 1,
                    'item' => array_filter([
                        $schemaAtType => 'Service',
                        'name' => $service['title'],
                        'description' => $service['description'] !== '' ? $service['description'] : null,
                        'provider' => [$schemaAtType => 'Organization', 'name' => $companyProfile->name],
                    ], static fn (mixed $value): bool => $value !== null),
                ],
                $companyServices,
                array_keys($companyServices),
            )),
        ];
    @endphp
    <x-json-ld :data="$serviceSchema" />
@endpush

@section('content')
    <div class="site-container px-4 py-8 sm:px-6 lg:px-8">
        <div class="mb-8">
            <h1 class="mb-3 text-3xl font-bold text-gray-900">{{ $companyProfile->name }} 的服务</h1>
            @if($pageDescription !== '')
                <p class="max-w-3xl text-gray-600">{{ $pageDescription }}</p>
            @endif
        </div>

        <div class="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            @foreach($companyServices as $service)
                <section class="rounded-xl border border-gray-100 bg-white p-5 shadow-sm">
                    <h2 class="text-lg font-semibold text-gray-900">{{ $service['title'] }}</h2>
                    @if($service['description'] !== '')
                        <p class="mt-2 text-sm leading-relaxed text-gray-600">{{ $service['description'] }}</p>
                    @endif
                </section>
            @endforeach
        </div>

        {{-- 转化区：与首页 CTA、页脚用同一条判定（有可用表单就指向表单）。 --}}
        <section class="mt-10 rounded-xl border border-gray-100 bg-gray-50 p-6">
            <h2 class="text-xl font-semibold text-gray-900">想聊聊你的情况？</h2>
            <p class="mt-2 text-sm text-gray-600">留下联系方式，我们会尽快回复。</p>
            @php
                $servicePhone = $companyProfile->phone;
                $serviceEmail = $companyProfile->email;
            @endphp
            @if($servicePhone !== '' || $serviceEmail !== '')
                <ul class="mt-4 space-y-1 text-sm text-gray-700">
                    @if($servicePhone !== '')
                        <li>电话：<a class="text-blue-600 hover:text-blue-800" href="tel:{{ preg_replace('/[^0-9+]/', '', $servicePhone) }}">{{ $servicePhone }}</a></li>
                    @endif
                    @if($serviceEmail !== '')
                        <li>邮箱：<a class="text-blue-600 hover:text-blue-800" href="mailto:{{ $serviceEmail }}">{{ $serviceEmail }}</a></li>
                    @endif
                </ul>
            @endif
            @if($contactFormUrl !== '')
                <a href="{{ $contactFormUrl }}" class="site-btn-primary mt-5">
                    在线留言
                </a>
            @endif
        </section>
    </div>
@endsection
