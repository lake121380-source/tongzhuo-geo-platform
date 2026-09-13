<?php

namespace App\Services\Admin\SiteThemeReplication;

use Illuminate\Http\Response;
use InvalidArgumentException;

class ThemePreviewRenderer
{
    private const CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox";

    public function render(string $page): Response
    {
        $page = $this->normalizePage($page);

        // 2026-09-12 退役改指：原先这里 `response()->view('admin.site-theme-replications.preview-safe', …)`，
        // 那个 Blade 视图已随 `resources/views/admin` 一起删除——`view()` 找不到视图会抛
        // `InvalidArgumentException`，于是 `GET /api/v1/site-settings/theme-replications/{id}/preview/{page}`
        // 直接 500，而 React 后台的**主题预览**正是调这个接口（`geoflowClient` 里那条 downloadAuthenticated）。
        //
        // 这个预览本来就是**不含任何不受信内容的静态占位版式**（标题 + 说明 + 三张卡），
        // 所以直接拼 HTML 即可，安全头逐条保留（尤其是那条 `sandbox` CSP）。
        $cards = collect($this->cards($page))
            ->map(static fn (array $card): string => sprintf(
                '<li class="card"><h2>%s</h2><p>%s</p></li>',
                e($card['title']),
                e($card['description']),
            ))
            ->implode('');

        $html = '<!DOCTYPE html><html lang="'.e(str_replace('_', '-', app()->getLocale())).'"><head>'
            .'<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            .'<title>'.e((string) __('admin.theme_replication.safe_preview.'.$page.'_title')).'</title>'
            .'<style>'
            .'body{margin:0;padding:24px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#0f172a;background:#f8fafc}'
            .'h1{margin:0 0 8px;font-size:20px}'
            .'p.lead{margin:0 0 20px;color:#475569;font-size:13px}'
            .'ul.cards{list-style:none;margin:0;padding:0;display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}'
            .'li.card{border:1px solid #e2e8f0;border-radius:12px;padding:16px;background:#fff}'
            .'li.card h2{margin:0 0 6px;font-size:14px}'
            .'li.card p{margin:0;color:#64748b;font-size:12px;line-height:1.6}'
            .'</style></head><body data-safe-theme-preview data-preview-page="'.e($page).'">'
            .'<h1>'.e((string) __('admin.theme_replication.safe_preview.'.$page.'_title')).'</h1>'
            .'<p class="lead">'.e((string) __('admin.theme_replication.safe_preview.'.$page.'_description')).'</p>'
            .'<ul class="cards">'.$cards.'</ul>'
            .'</body></html>';

        return response($html, 200, [
            'Content-Type' => 'text/html; charset=UTF-8',
            'Content-Security-Policy' => self::CONTENT_SECURITY_POLICY,
            'X-Content-Type-Options' => 'nosniff',
            'Cache-Control' => 'no-store, private',
            'Pragma' => 'no-cache',
            'Referrer-Policy' => 'no-referrer',
        ]);
    }

    private function normalizePage(string $page): string
    {
        return match ($page) {
            'home', 'category', 'article' => $page,
            default => throw new InvalidArgumentException('Unsupported preview page.'),
        };
    }

    /**
     * @return list<array{title:string,description:string}>
     */
    private function cards(string $page): array
    {
        return [
            [
                'title' => __('admin.theme_replication.safe_preview.'.$page.'_card_one_title'),
                'description' => __('admin.theme_replication.safe_preview.'.$page.'_card_one_description'),
            ],
            [
                'title' => __('admin.theme_replication.safe_preview.'.$page.'_card_two_title'),
                'description' => __('admin.theme_replication.safe_preview.'.$page.'_card_two_description'),
            ],
            [
                'title' => __('admin.theme_replication.safe_preview.'.$page.'_card_three_title'),
                'description' => __('admin.theme_replication.safe_preview.'.$page.'_card_three_description'),
            ],
        ];
    }
}
