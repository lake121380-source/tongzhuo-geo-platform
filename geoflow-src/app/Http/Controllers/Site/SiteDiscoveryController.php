<?php

namespace App\Http\Controllers\Site;

use App\Http\Controllers\Controller;
use App\Services\Site\SiteDiscoveryRenderer;
use Illuminate\Http\Response;

final class SiteDiscoveryController extends Controller
{
    public function __construct(private readonly SiteDiscoveryRenderer $renderer) {}

    public function robots(): Response
    {
        return response($this->renderer->robotsText(), 200, [
            'Content-Type' => 'text/plain; charset=UTF-8',
            'Cache-Control' => 'no-cache, private',
        ]);
    }

    public function sitemap(): Response
    {
        return response($this->renderer->sitemapXml(), 200, [
            'Content-Type' => 'application/xml; charset=UTF-8',
            'Cache-Control' => 'no-cache, private',
        ]);
    }

    public function sitemapShard(int $page): Response
    {
        return response($this->renderer->sitemapShardXml($page), 200, [
            'Content-Type' => 'application/xml; charset=UTF-8',
            'Cache-Control' => 'no-cache, private',
        ]);
    }

    public function llms(): Response
    {
        return response($this->renderer->llmsText('short'), 200, [
            'Content-Type' => 'text/plain; charset=UTF-8',
            'Cache-Control' => 'no-cache, private',
        ]);
    }

    public function llmsFull(): Response
    {
        return response($this->renderer->llmsText('full'), 200, [
            'Content-Type' => 'text/plain; charset=UTF-8',
            'Cache-Control' => 'no-cache, private',
        ]);
    }
}
