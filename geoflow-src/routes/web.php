<?php

/**
 * Web 路由：**只剩前台站点**。
 *
 * 2026-09-12 退役：原 Blade 管理后台的路由组（近 600 行）连同 `admin_base_path` 机制一并删除，
 * 后台界面由 React（`/geo_admin`，nginx 静态直出）承担。业务后端仍在 `api/v1`。
 */

use App\Http\Controllers\Site\AboutController;
use App\Http\Controllers\Site\ArchiveController;
use App\Http\Controllers\Site\ArticleController as SiteArticleController;
use App\Http\Controllers\Site\CategoryController as SiteCategoryController;
use App\Http\Controllers\Site\HomeController;
use App\Http\Controllers\Site\HostedAssetController;
use App\Http\Controllers\Site\LeadFormController as SiteLeadFormController;
use App\Http\Controllers\Site\SiteDiscoveryController;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Route;

Route::get('/favicon.ico', HostedAssetController::class)->name('site.asset.favicon');
Route::get('/{assetPath}', HostedAssetController::class)
    ->where('assetPath', '(?:(?:assets|js|storage|themes)/[a-zA-Z0-9._/-]+|build/assets/[a-zA-Z0-9._-]+)')
    ->name('site.asset');

Route::get('/app', function () {
    // The React -AI shell remains the primary administrator UI. Keep the
    // historical PWA entry pointed at it while the Blade backend stays
    // available under /legacy-admin as a temporary authenticated fallback.
    // Use a relative Location so local deployments on a non-default port
    // (for example :18080) do not lose their port during the redirect.
    return new RedirectResponse('/geo_admin');
})->name('pwa.launch');

Route::middleware(['site.locale', 'site.view_log'])->group(function (): void {
    Route::get('/', [HomeController::class, 'index'])->name('site.home');
    Route::get('/about', [AboutController::class, 'index'])->name('site.about');
    Route::get('/robots.txt', [SiteDiscoveryController::class, 'robots'])->name('site.robots');
    Route::get('/sitemap.xml', [SiteDiscoveryController::class, 'sitemap'])->name('site.sitemap');
    Route::get('/llms.txt', [SiteDiscoveryController::class, 'llms'])->name('site.llms');
    Route::get('/llms-full.txt', [SiteDiscoveryController::class, 'llmsFull'])->name('site.llms.full');
    Route::get('/sitemaps/pages-{page}.xml', [SiteDiscoveryController::class, 'sitemapShard'])
        ->whereNumber('page')
        ->name('site.sitemap.shard');
    Route::get('/archive', [ArchiveController::class, 'index'])->name('site.archive');
    Route::get('/archive/{year}/{month}', [ArchiveController::class, 'month'])
        ->name('site.archive.month')
        ->where(['year' => '[0-9]{4}', 'month' => '[0-9]{2}']);
    Route::get('/category/{slug}', [SiteCategoryController::class, 'show'])->name('site.category');
    Route::get('/article/{slug}', [SiteArticleController::class, 'show'])->name('site.article');
    Route::get('/forms/{slug}', [SiteLeadFormController::class, 'show'])->name('site.lead-forms.show');
    Route::post('/forms/{slug}/submissions', [SiteLeadFormController::class, 'submit'])
        ->middleware('throttle:site-lead-submission')
        ->name('site.lead-forms.submit');
});
