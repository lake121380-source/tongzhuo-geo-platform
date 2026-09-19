<?php

/**
 * 桐灼GEO REST API 路由（Laravel 默认挂载在 /api 前缀下，本文件内为 v1 子路径）。
 *
 * 中间件：api.request_id 注入/透传 X-Request-Id；api.auth 校验 Bearer；
 * api.scope:* 校验 Sanctum token abilities。幂等写操作在控制器内按 route_key 处理。
 *
 * @see bak/api/v1/index.php 遗留单入口对照
 */

use App\Http\Controllers\Api\V1\AdminSecurityController;
use App\Http\Controllers\Api\V1\AdminUserController;
use App\Http\Controllers\Api\V1\AiConfigurationController;
use App\Http\Controllers\Api\V1\AiResearchController;
use App\Http\Controllers\Api\V1\AiSourceProviderApiController;
use App\Http\Controllers\Api\V1\AiSpecialPromptApiController;
use App\Http\Controllers\Api\V1\AiSystemSettingsApiController;
use App\Http\Controllers\Api\V1\AiWorkspaceController;
use App\Http\Controllers\Api\V1\AnalyticsController;
use App\Http\Controllers\Api\V1\ArticleController;
use App\Http\Controllers\Api\V1\ArticleEditorAssistantApiController;
use App\Http\Controllers\Api\V1\AuthController;
use App\Http\Controllers\Api\V1\BrowserConnectionApprovalApiController;
use App\Http\Controllers\Api\V1\BrowserDeviceAuthorizationController;
use App\Http\Controllers\Api\V1\BrowserManualPublicationController;
use App\Http\Controllers\Api\V1\BrowserSessionController;
use App\Http\Controllers\Api\V1\CatalogController;
use App\Http\Controllers\Api\V1\DistributionArticleController;
use App\Http\Controllers\Api\V1\DistributionChannelController;
use App\Http\Controllers\Api\V1\DistributionChannelSecretController;
use App\Http\Controllers\Api\V1\DistributionJobApiController;
use App\Http\Controllers\Api\V1\DistributionSettingsSyncController;
use App\Http\Controllers\Api\V1\EnterpriseKnowledgeApiController;
use App\Http\Controllers\Api\V1\HostedSiteController;
use App\Http\Controllers\Api\V1\JianduController;
use App\Http\Controllers\Api\V1\JobController;
use App\Http\Controllers\Api\V1\KnowledgeAssetApiController;
use App\Http\Controllers\Api\V1\KnowledgeFactApiController;
use App\Http\Controllers\Api\V1\KnowledgeSearchController;
use App\Http\Controllers\Api\V1\LeadManagementController;
use App\Http\Controllers\Api\V1\LibraryImportApiController;
use App\Http\Controllers\Api\V1\ManualPublicationController;
use App\Http\Controllers\Api\V1\ManualPublicationSettingsApiController;
use App\Http\Controllers\Api\V1\MaterialController;
use App\Http\Controllers\Api\V1\SitePreviewController;
use App\Http\Controllers\Api\V1\SiteSensitiveWordApiController;
use App\Http\Controllers\Api\V1\SiteSeoController;
use App\Http\Controllers\Api\V1\SiteSettingsController;
use App\Http\Controllers\Api\V1\SiteThemeReplicationController;
use App\Http\Controllers\Api\V1\SystemUpdateApiController;
use App\Http\Controllers\Api\V1\TaskController;
use App\Http\Controllers\Api\V1\TitleGenerationApiController;
use App\Http\Controllers\Api\V1\UrlImportController;
use App\Http\Controllers\Api\V1\UrlScannerController;
use Illuminate\Support\Facades\Route;

// 实际路径形如：/api/v1/...
Route::prefix('v1')
    ->middleware(['api.request_id'])
    ->group(function (): void {
        // 公开：管理员登录，返回 API Token（无需 Bearer）
        Route::post('auth/login', [AuthController::class, 'login'])
            ->middleware('throttle:admin-login');

        Route::middleware(['browser.protocol'])
            ->prefix('browser-operations')
            ->group(function (): void {
                Route::post('device-authorizations', [BrowserDeviceAuthorizationController::class, 'store'])
                    ->middleware('throttle:5,1');
                Route::post('device-token', [BrowserDeviceAuthorizationController::class, 'token'])
                    ->middleware('throttle:30,1');
            });

        // 需有效 Token + 对应 scope
        Route::middleware(['api.auth'])->group(function (): void {
            Route::post('auth/logout', [AuthController::class, 'logout'])
                ->middleware('throttle:30,1');

            Route::middleware(['browser.protocol', 'api.scope:browser-operations:read'])
                ->prefix('browser-operations')
                ->group(function (): void {
                    Route::get('session', [BrowserSessionController::class, 'show'])->middleware('throttle:120,1');
                    Route::delete('session', [BrowserSessionController::class, 'destroy'])
                        ->middleware(['api.scope:browser-operations:execute', 'throttle:30,1']);
                });

            Route::middleware(['browser.protocol', 'api.scope:browser-operations:read'])
                ->prefix('manual-publications')
                ->group(function (): void {
                    Route::get('/', [BrowserManualPublicationController::class, 'index'])->middleware('throttle:120,1');
                    Route::get('{manualPublicationId}', [BrowserManualPublicationController::class, 'show'])->whereNumber('manualPublicationId')->middleware('throttle:120,1');
                    Route::middleware('api.scope:browser-operations:execute')->group(function (): void {
                        Route::middleware('throttle:30,1')->group(function (): void {
                            Route::post('{manualPublicationId}/claim', [BrowserManualPublicationController::class, 'claim'])->whereNumber('manualPublicationId');
                            Route::post('{manualPublicationId}/heartbeat', [BrowserManualPublicationController::class, 'heartbeat'])->whereNumber('manualPublicationId');
                            Route::post('{manualPublicationId}/release', [BrowserManualPublicationController::class, 'release'])->whereNumber('manualPublicationId');
                            Route::post('{manualPublicationId}/receipt', [BrowserManualPublicationController::class, 'receipt'])->whereNumber('manualPublicationId');
                        });
                    });
                });
            // catalog:read — 下拉元数据（模型、提示词、库、作者、分类等）
            Route::get('catalog', [CatalogController::class, 'show'])->middleware('api.scope:catalog:read');

            // account/tokens/audit — React 设置页的管理员资料、安全凭据与审计投影。
            // 超级管理员边界在控制器内再次校验，避免仅凭 scope 越权。
            Route::prefix('admin')->group(function (): void {
                Route::get('profile', [AdminSecurityController::class, 'profile'])
                    ->middleware('api.scope:account:read');
                Route::patch('profile', [AdminSecurityController::class, 'updateProfile'])
                    ->middleware(['api.scope:account:write', 'throttle:30,1']);
                Route::patch('password', [AdminSecurityController::class, 'updatePassword'])
                    ->middleware(['api.scope:account:write', 'throttle:api-admin-sensitive']);
                // 浏览器插件的设备授权（与个人 API Token 分开）。
                Route::get('browser-clients', [AdminSecurityController::class, 'browserClients'])
                    ->middleware('api.scope:account:read');
                Route::delete('browser-clients/{token}', [AdminSecurityController::class, 'revokeBrowserClient'])
                    ->whereNumber('token')
                    ->middleware(['api.scope:account:write', 'throttle:30,1']);
                Route::get('tokens', [AdminSecurityController::class, 'tokens'])
                    ->middleware('api.scope:tokens:read');
                Route::post('tokens', [AdminSecurityController::class, 'storeToken'])
                    ->middleware(['api.scope:tokens:write', 'throttle:30,1']);
                Route::post('tokens/{token}/revoke', [AdminSecurityController::class, 'revokeToken'])
                    ->whereNumber('token')
                    ->middleware(['api.scope:tokens:write', 'throttle:30,1']);
                Route::get('activity-logs', [AdminSecurityController::class, 'activityLogs'])
                    ->middleware('api.scope:audit:read');
                // admin users — 超级管理员才能管理普通管理员账号；控制器再次校验角色。
                Route::get('users', [AdminUserController::class, 'index'])
                    ->middleware('api.scope:account:read');
                Route::get('users/{admin}', [AdminUserController::class, 'show'])
                    ->whereNumber('admin')
                    ->middleware('api.scope:account:read');
                Route::post('users', [AdminUserController::class, 'store'])
                    ->middleware(['api.scope:account:write', 'throttle:30,1']);
                Route::patch('users/{admin}', [AdminUserController::class, 'update'])
                    ->whereNumber('admin')
                    ->middleware(['api.scope:account:write', 'throttle:30,1']);
                Route::post('users/{admin}/status', [AdminUserController::class, 'toggleStatus'])
                    ->whereNumber('admin')
                    ->middleware(['api.scope:account:write', 'throttle:30,1']);
                Route::delete('users/{admin}', [AdminUserController::class, 'destroy'])
                    ->whereNumber('admin')
                    ->middleware(['api.scope:account:write', 'throttle:admin-sensitive']);
            });

            // analytics:* — React admin projection of the existing analytics
            // services. No estimated/demo metrics are returned.
            Route::middleware('api.scope:analytics:read')
                ->prefix('analytics')
                ->group(function (): void {
                    Route::get('overview', [AnalyticsController::class, 'overview']);
                    // 旧 Blade analytics 首页的「增长总览 + 下一步该做什么的告警条」。
                    // 2026-09-12 退役时这两个版面一度没有入口（服务还在、只被已删的控制器引用），
                    // 哥哥拍板「既然还需要这个功能就去补上」，于是在 React 分析页接回来。
                    Route::get('growth-overview', [AnalyticsController::class, 'growthOverview']);
                    Route::get('content', [AnalyticsController::class, 'content']);
                    Route::get('traffic', [AnalyticsController::class, 'traffic']);
                    Route::get('crawlers', [AnalyticsController::class, 'crawlers']);
                    Route::get('ai-visibility', [AnalyticsController::class, 'aiVisibility']);
                    Route::get('distribution', [AnalyticsController::class, 'distribution']);
                    Route::get('leads', [AnalyticsController::class, 'leads']);
                });

            // lead-forms/leads — reuse 桐灼GEO's public form submission and
            // persisted lead workflow while exposing an authenticated React
            // management surface. Contact payloads require the dedicated
            // leads:read scope; all mutations are idempotent and audited.
            Route::get('lead-forms', [LeadManagementController::class, 'forms'])
                ->middleware('api.scope:leads:read');
            Route::post('lead-forms', [LeadManagementController::class, 'storeForm'])
                ->middleware(['api.scope:leads:write', 'throttle:30,1']);
            Route::get('lead-forms/{leadForm}', [LeadManagementController::class, 'form'])
                ->whereNumber('leadForm')
                ->middleware('api.scope:leads:read');
            Route::patch('lead-forms/{leadForm}', [LeadManagementController::class, 'updateForm'])
                ->whereNumber('leadForm')
                ->middleware(['api.scope:leads:write', 'throttle:30,1']);
            Route::post('lead-forms/{leadForm}/status', [LeadManagementController::class, 'setFormStatus'])
                ->whereNumber('leadForm')
                ->middleware(['api.scope:leads:write', 'throttle:30,1']);
            Route::delete('lead-forms/{leadForm}', [LeadManagementController::class, 'destroyForm'])
                ->whereNumber('leadForm')
                ->middleware(['api.scope:leads:write', 'throttle:admin-sensitive']);
            Route::get('leads', [LeadManagementController::class, 'leads'])
                ->middleware('api.scope:leads:read');
            Route::get('leads/export', [LeadManagementController::class, 'exportLeads'])
                ->middleware(['api.scope:leads:read', 'throttle:30,1']);
            Route::get('leads/{lead}', [LeadManagementController::class, 'lead'])
                ->whereNumber('lead')
                ->middleware('api.scope:leads:read');
            Route::patch('leads/{lead}', [LeadManagementController::class, 'updateLead'])
                ->whereNumber('lead')
                ->middleware(['api.scope:leads:write', 'throttle:30,1']);

            // ai-workspace — Bearer projection of 桐灼GEO's native persisted
            // assistant. The underlying repository, retrieval, model gate and
            // SSE generation lease are shared with the legacy admin surface.
            Route::prefix('ai-workspace')->group(function (): void {
                Route::middleware(['api.scope:workspace:read', 'throttle:ai-workspace-read'])->group(function (): void {
                    Route::get('status', [AiWorkspaceController::class, 'status']);
                    Route::get('conversations', [AiWorkspaceController::class, 'conversations']);
                    Route::get('conversations/{conversation}', [AiWorkspaceController::class, 'showConversation']);
                    Route::get('media/{mediaAsset}', [AiWorkspaceController::class, 'media'])->whereNumber('mediaAsset');
                });
                Route::middleware('api.scope:workspace:write')->group(function (): void {
                    Route::post('conversations', [AiWorkspaceController::class, 'storeConversation'])->middleware('throttle:ai-workspace');
                    Route::patch('conversations/{conversation}', [AiWorkspaceController::class, 'renameConversation'])->middleware('throttle:ai-workspace');
                    Route::post('conversations/{conversation}/archive', [AiWorkspaceController::class, 'archiveConversation'])->middleware('throttle:ai-workspace');
                    Route::post('conversations/{conversation}/messages', [AiWorkspaceController::class, 'sendMessage'])->middleware('throttle:ai-workspace-messages');
                });
            });

            // system-updates — authenticated projection of the independent
            // 桐灼GEO Updater. Laravel never performs host mutations itself.
            // The controller also requires a current super administrator.
            Route::prefix('system-updates')->group(function (): void {
                Route::get('/', [SystemUpdateApiController::class, 'show'])
                    ->middleware('api.scope:system:read');
                Route::get('updater/package', [SystemUpdateApiController::class, 'download'])
                    ->middleware(['api.scope:system:read', 'throttle:30,1']);
                Route::post('check', [SystemUpdateApiController::class, 'check'])
                    ->middleware(['api.scope:system:write', 'throttle:30,1']);
                Route::post('updater/prepare', [SystemUpdateApiController::class, 'prepare'])
                    ->middleware(['api.scope:system:write', 'throttle:admin-sensitive']);
                Route::post('operations/{kind}', [SystemUpdateApiController::class, 'startOperation'])
                    ->whereIn('kind', ['update', 'backup', 'rollback', 'verify'])
                    ->middleware(['api.scope:system:write', 'throttle:admin-sensitive']);
            });

            // -AI research surfaces. Reads use the existing analytics boundary;
            // external visibility scans use analytics:collect and article
            // evidence drafts use the existing articles:write boundary.
            Route::middleware('api.scope:analytics:read')->group(function (): void {
                Route::get('ai-research/query-radar', [AiResearchController::class, 'queryRadar']);
                Route::get('ai-research/competitor', [AiResearchController::class, 'competitor']);
                Route::get('ai-research/brand-entity', [AiResearchController::class, 'brandEntity']);
                Route::get('ai-research/attribution', [AiResearchController::class, 'attribution']);
            });
            Route::post('ai-research/query-radar/collect', [AiResearchController::class, 'collectQuery'])
                ->middleware(['api.scope:analytics:collect', 'throttle:admin-sensitive']);
            Route::post('ai-research/query-radar/draft', [AiResearchController::class, 'generateQueryDraft'])
                ->middleware(['api.scope:articles:write', 'throttle:30,1']);
            Route::post('ai-research/competitor/config', [AiResearchController::class, 'saveCompetitorConfig'])
                ->middleware(['api.scope:analytics:collect', 'throttle:30,1']);
            Route::post('ai-research/competitor/benchmark', [AiResearchController::class, 'benchmarkCompetitor'])
                ->middleware(['api.scope:analytics:collect', 'throttle:admin-sensitive']);
            Route::post('ai-research/brand-entity', [AiResearchController::class, 'saveBrandEntity'])
                ->middleware(['api.scope:seo:write', 'throttle:30,1']);
            Route::post('ai-research/sandbox', [AiResearchController::class, 'sandbox'])
                ->middleware(['api.scope:models:write', 'throttle:admin-sensitive']);

            // models/prompts — 当前管理员可用的 AI 配置投影，不暴露 API key。
            // AI 配置器概览计数（只读监测，与旧后台 ai-configurator 页同一算法）。
            Route::get('ai-configuration/overview', [AiConfigurationController::class, 'overview'])
                ->middleware('api.scope:models:read');
            Route::get('models', [AiConfigurationController::class, 'models'])
                ->middleware('api.scope:models:read');
            Route::post('models/{model}/default', [AiConfigurationController::class, 'setDefault'])
                ->whereNumber('model')
                ->middleware(['api.scope:models:write', 'throttle:30,1']);
            Route::post('models', [AiConfigurationController::class, 'storeModel'])
                ->middleware(['api.scope:models:write', 'throttle:30,1']);
            Route::patch('models/{model}', [AiConfigurationController::class, 'updateModel'])
                ->whereNumber('model')
                ->middleware(['api.scope:models:write', 'throttle:30,1']);
            Route::delete('models/{model}', [AiConfigurationController::class, 'destroyModel'])
                ->whereNumber('model')
                ->middleware(['api.scope:models:write', 'throttle:30,1']);
            Route::post('models/{model}/test', [AiConfigurationController::class, 'testModel'])
                ->whereNumber('model')
                ->middleware(['api.scope:models:write', 'throttle:admin-sensitive']);
            Route::get('prompts', [AiConfigurationController::class, 'prompts'])
                ->middleware('api.scope:models:read');
            Route::get('prompts/{prompt}', [AiConfigurationController::class, 'prompt'])
                ->whereNumber('prompt')
                ->middleware('api.scope:models:read');
            Route::post('prompts', [AiConfigurationController::class, 'storePrompt'])
                ->middleware(['api.scope:models:write', 'throttle:30,1']);
            Route::patch('prompts/{prompt}', [AiConfigurationController::class, 'updatePrompt'])
                ->whereNumber('prompt')
                ->middleware(['api.scope:models:write', 'throttle:30,1']);
            Route::delete('prompts/{prompt}', [AiConfigurationController::class, 'destroyPrompt'])
                ->whereNumber('prompt')
                ->middleware(['api.scope:models:write', 'throttle:30,1']);
            // 复制成可编辑副本——系统内置提示词只读，这是改它们的唯一途径。
            Route::post('prompts/{prompt}/copy', [AiConfigurationController::class, 'copyPrompt'])
                ->whereNumber('prompt')
                ->middleware(['api.scope:models:write', 'throttle:30,1']);
            // 特殊提示词（keyword / description）：读最新一条、按类型整体覆盖。
            // 与通用 prompts CRUD 不是同一套语义，故单列；`prompts/{prompt}` 有
            // whereNumber 约束，不会把 `prompts/special` 吃掉。
            Route::get('prompts/special', [AiSpecialPromptApiController::class, 'index'])
                ->middleware('api.scope:models:read');
            Route::post('prompts/special/{type}', [AiSpecialPromptApiController::class, 'update'])
                ->middleware(['api.scope:models:write', 'throttle:30,1']);
            // 本人的默认对话 / 向量模型一次设定。与 models/{model}/default 的区别：
            // 那条只改 chat，这条两个槽位一起决定。
            Route::post('models/defaults', [AiConfigurationController::class, 'setPersonalDefaults'])
                ->middleware(['api.scope:models:write', 'throttle:30,1']);
            // 系统级 AI 配置：默认 embedding 与知识库切片策略。超管专属，影响向量化口径。
            Route::get('ai-system-settings', [AiSystemSettingsApiController::class, 'show'])
                ->middleware('api.scope:models:read');
            Route::post('ai-system-settings/chunking', [AiSystemSettingsApiController::class, 'updateChunking'])
                ->middleware(['api.scope:models:write', 'throttle:admin-sensitive']);
            Route::post('ai-system-settings/default-embedding', [AiSystemSettingsApiController::class, 'updateDefaultEmbedding'])
                ->middleware(['api.scope:models:write', 'throttle:admin-sensitive']);
            // Source providers are system-level AI-visibility configuration.
            // The controller also requires a current super administrator.
            Route::get('source-providers', [AiSourceProviderApiController::class, 'index'])
                ->middleware('api.scope:models:read');
            Route::post('source-providers', [AiSourceProviderApiController::class, 'store'])
                ->middleware(['api.scope:models:write', 'throttle:30,1']);
            Route::patch('source-providers/{provider}', [AiSourceProviderApiController::class, 'update'])
                ->whereNumber('provider')
                ->middleware(['api.scope:models:write', 'throttle:30,1']);
            // 可见度分析模型的绑定（ark / deepseek）与绑定模型的 API 配置。
            // 字面量路径要排在 source-providers/{provider} 之前（后者有 whereNumber 兜底）。
            Route::get('source-providers/model-bindings', [AiSourceProviderApiController::class, 'bindings'])
                ->middleware('api.scope:models:read');
            Route::post('source-providers/model-bindings', [AiSourceProviderApiController::class, 'updateBindings'])
                ->middleware(['api.scope:models:write', 'throttle:admin-sensitive']);
            Route::post('source-providers/model-bindings/test', [AiSourceProviderApiController::class, 'testBinding'])
                ->middleware(['api.scope:models:write', 'throttle:admin-sensitive']);
            Route::post('source-providers/model-api', [AiSourceProviderApiController::class, 'saveModelApi'])
                ->middleware(['api.scope:models:write', 'throttle:admin-sensitive']);
            // 真实出站探活：会消耗一次额度，所以按写操作（幂等键 + 超管边界）。
            Route::post('source-providers/{provider}/test', [AiSourceProviderApiController::class, 'test'])
                ->whereNumber('provider')
                ->middleware(['api.scope:models:write', 'throttle:admin-sensitive']);
            Route::delete('source-providers/{provider}', [AiSourceProviderApiController::class, 'destroy'])
                ->whereNumber('provider')
                ->middleware(['api.scope:models:write', 'throttle:30,1']);

            // site SEO/discovery — config draft, published output previews and llms.txt publication.
            Route::get('site-settings', [SiteSettingsController::class, 'show'])
                ->middleware('api.scope:seo:read');
            Route::patch('site-settings', [SiteSettingsController::class, 'update'])
                ->middleware(['api.scope:seo:write', 'throttle:30,1']);
            // site-settings/sensitive-words — 敏感词规则。它是文章质量门禁的真实输入，
            // 入口侧另有超管边界，见 SiteSensitiveWordApiController。
            Route::get('site-settings/sensitive-words', [SiteSensitiveWordApiController::class, 'index'])
                ->middleware('api.scope:seo:read');
            Route::post('site-settings/sensitive-words', [SiteSensitiveWordApiController::class, 'store'])
                ->middleware(['api.scope:seo:write', 'throttle:admin-sensitive']);
            Route::patch('site-settings/sensitive-words/{word}', [SiteSensitiveWordApiController::class, 'update'])
                ->whereNumber('word')
                ->middleware(['api.scope:seo:write', 'throttle:admin-sensitive']);
            Route::delete('site-settings/sensitive-words/{word}', [SiteSensitiveWordApiController::class, 'destroy'])
                ->whereNumber('word')
                ->middleware(['api.scope:seo:write', 'throttle:admin-sensitive']);
            Route::post('site-settings/theme', [SiteSettingsController::class, 'updateTheme'])
                ->middleware(['api.scope:seo:write', 'throttle:30,1']);
            Route::patch('site-settings/homepage', [SiteSettingsController::class, 'updateHomepage'])
                ->middleware(['api.scope:seo:write', 'throttle:30,1']);
            Route::post('site-settings/homepage/preset', [SiteSettingsController::class, 'applyHomepagePreset'])
                ->middleware(['api.scope:seo:write', 'throttle:30,1']);
            Route::post('site-settings/homepage/import', [SiteSettingsController::class, 'importHomepage'])
                ->middleware(['api.scope:seo:write', 'throttle:30,1']);
            // Theme replication — authenticated super-admin operations backed by the existing
            // 桐灼GEO replication service, queue and draft storage.
            Route::prefix('site-settings/theme-replications')->group(function (): void {
                Route::get('/', [SiteThemeReplicationController::class, 'index'])
                    ->middleware('api.scope:seo:read');
                Route::get('{replication}', [SiteThemeReplicationController::class, 'show'])
                    ->whereNumber('replication')
                    ->middleware('api.scope:seo:read');
                Route::post('/', [SiteThemeReplicationController::class, 'store'])
                    ->middleware(['api.scope:seo:write', 'throttle:30,1']);
                Route::post('{replication}/retry', [SiteThemeReplicationController::class, 'retry'])
                    ->whereNumber('replication')
                    ->middleware(['api.scope:seo:write', 'throttle:30,1']);
                Route::post('{replication}/iterate', [SiteThemeReplicationController::class, 'iterate'])
                    ->whereNumber('replication')
                    ->middleware(['api.scope:seo:write', 'throttle:30,1']);
                Route::post('{replication}/publish', [SiteThemeReplicationController::class, 'action'])
                    ->whereNumber('replication')
                    ->defaults('action', 'publish')
                    ->middleware(['api.scope:seo:write', 'throttle:30,1']);
                Route::post('{replication}/archive', [SiteThemeReplicationController::class, 'action'])
                    ->whereNumber('replication')
                    ->defaults('action', 'archive')
                    ->middleware(['api.scope:seo:write', 'throttle:30,1']);
                Route::post('{replication}/delete-drafts', [SiteThemeReplicationController::class, 'action'])
                    ->whereNumber('replication')
                    ->defaults('action', 'delete-drafts')
                    ->middleware(['api.scope:seo:write', 'throttle:30,1']);
                Route::post('{replication}/copy', [SiteThemeReplicationController::class, 'copy'])
                    ->whereNumber('replication')
                    ->middleware(['api.scope:seo:write', 'throttle:30,1']);
                Route::get('{replication}/preview/{page}', [SiteThemeReplicationController::class, 'preview'])
                    ->whereNumber('replication')
                    ->whereIn('page', ['home', 'category', 'article'])
                    ->middleware('api.scope:seo:read');
                Route::get('{replication}/package', [SiteThemeReplicationController::class, 'package'])
                    ->whereNumber('replication')
                    ->middleware('api.scope:seo:read');
            });
            Route::get('site/preview', SitePreviewController::class)
                ->middleware('api.scope:seo:read');
            Route::get('site/seo-config', [SiteSeoController::class, 'config'])
                ->middleware('api.scope:seo:read');
            Route::get('site/seo-audit', [SiteSeoController::class, 'audit'])
                ->middleware('api.scope:seo:read');
            Route::patch('site/seo-config', [SiteSeoController::class, 'updateConfig'])
                ->middleware(['api.scope:seo:write', 'throttle:30,1']);
            Route::get('site/robots/preview', [SiteSeoController::class, 'robotsPreview'])
                ->middleware('api.scope:seo:read');
            Route::get('site/sitemap/preview', [SiteSeoController::class, 'sitemapPreview'])
                ->middleware('api.scope:seo:read');
            Route::post('site/sitemap/rebuild', [SiteSeoController::class, 'rebuildSitemap'])
                ->middleware(['api.scope:seo:write', 'throttle:30,1']);
            Route::get('site/llms-txt/preview', [SiteSeoController::class, 'llmsPreview'])
                ->middleware('api.scope:seo:read');
            Route::post('site/llms-txt/publish', [SiteSeoController::class, 'publishLlms'])
                ->middleware(['api.scope:seo:write', 'throttle:30,1']);

            // tasks:* — 任务 CRUD、启停、入队、子 Job 列表
            Route::get('tasks', [TaskController::class, 'index'])->middleware('api.scope:tasks:read');
            // 全局监测：队列/Worker 健康快照与跨任务最近运行。都是只读，复用任务页同一查询服务。
            Route::get('tasks/health', [TaskController::class, 'health'])
                ->middleware(['api.scope:tasks:read', 'throttle:120,1']);
            Route::get('tasks/jobs', [TaskController::class, 'recentRuns'])
                ->middleware(['api.scope:tasks:read', 'throttle:120,1']);
            Route::get('tasks/workers', [TaskController::class, 'workers'])
                ->middleware('api.scope:tasks:read');
            Route::get('tasks/trash', [TaskController::class, 'trash'])
                ->middleware('api.scope:tasks:read');
            Route::get('tasks/title-readiness', [TaskController::class, 'titleReadiness'])
                ->middleware('api.scope:tasks:read');
            Route::post('tasks', [TaskController::class, 'store'])->middleware('api.scope:tasks:write');
            Route::get('tasks/{task}', [TaskController::class, 'show'])
                ->whereNumber('task')
                ->middleware('api.scope:tasks:read');
            Route::patch('tasks/{task}', [TaskController::class, 'update'])
                ->whereNumber('task')
                ->middleware('api.scope:tasks:write');
            Route::delete('tasks/{task}', [TaskController::class, 'destroy'])
                ->whereNumber('task')
                ->middleware('api.scope:tasks:write');
            Route::post('tasks/{task}/start', [TaskController::class, 'start'])
                ->whereNumber('task')
                ->middleware('api.scope:tasks:write');
            Route::post('tasks/{task}/stop', [TaskController::class, 'stop'])
                ->whereNumber('task')
                ->middleware('api.scope:tasks:write');
            Route::post('tasks/{task}/restore', [TaskController::class, 'restore'])
                ->whereNumber('task')
                ->middleware('api.scope:tasks:write');
            Route::post('tasks/{task}/enqueue', [TaskController::class, 'enqueue'])
                ->whereNumber('task')
                ->middleware('api.scope:tasks:write');
            Route::get('tasks/{task}/jobs', [TaskController::class, 'jobs'])
                ->whereNumber('task')
                ->middleware('api.scope:tasks:read');

            // jobs:read — 单条 task_runs 执行记录
            Route::get('jobs/{job}', [JobController::class, 'show'])
                ->whereNumber('job')
                ->middleware('api.scope:jobs:read');

            // distribution:read — safe channel projection and real remote health check.
            Route::get('distribution/channels', [DistributionChannelController::class, 'index'])
                ->middleware('api.scope:distribution:read');
            Route::get('distribution/channels/{channel}', [DistributionChannelController::class, 'show'])
                ->whereNumber('channel')
                ->middleware('api.scope:distribution:read');
            Route::post('distribution/channels', [DistributionChannelController::class, 'store'])
                ->middleware(['api.scope:distribution:write', 'throttle:30,1']);
            Route::patch('distribution/channels/{channel}', [DistributionChannelController::class, 'update'])
                ->whereNumber('channel')
                ->middleware(['api.scope:distribution:write', 'throttle:30,1']);
            Route::post('distribution/channels/{channel}/pause', [DistributionChannelController::class, 'pause'])
                ->whereNumber('channel')
                ->middleware(['api.scope:distribution:write', 'throttle:30,1']);
            Route::post('distribution/channels/{channel}/activate', [DistributionChannelController::class, 'activate'])
                ->whereNumber('channel')
                ->middleware(['api.scope:distribution:write', 'throttle:30,1']);
            Route::post('distribution/channels/{channel}/rotate-secret', [DistributionChannelController::class, 'rotateSecret'])
                ->whereNumber('channel')
                ->middleware(['api.scope:distribution:write', 'throttle:admin-sensitive']);
            // distribution/sync-settings — 把站点设置推到渠道前端。与旧 Blade 后台共用
            // DistributionSettingsSyncService；确认门禁与预览用的是同一个判定。
            Route::get('distribution/sync-settings/preview', [DistributionSettingsSyncController::class, 'preview'])
                ->middleware(['api.scope:distribution:read', 'throttle:60,1']);
            Route::post('distribution/channels/{channel}/frontend-capabilities/refresh', [DistributionSettingsSyncController::class, 'refreshCapabilities'])
                ->whereNumber('channel')
                ->middleware(['api.scope:distribution:write', 'throttle:admin-sensitive']);
            Route::post('distribution/sync-settings/all', [DistributionSettingsSyncController::class, 'syncAll'])
                ->middleware(['api.scope:distribution:write', 'throttle:admin-sensitive']);
            Route::post('distribution/sync-settings/selected', [DistributionSettingsSyncController::class, 'syncSelected'])
                ->middleware(['api.scope:distribution:write', 'throttle:admin-sensitive']);
            // distribution/channels/{channel}/reveal-secret|package — 查看密钥与交付接入包。
            // 入口侧还要过「超管 + 二次密码」，见 DistributionChannelSecretController。
            Route::post('distribution/channels/{channel}/reveal-secret', [DistributionChannelSecretController::class, 'reveal'])
                ->whereNumber('channel')
                ->middleware(['api.scope:distribution:write', 'throttle:api-admin-sensitive']);
            Route::post('distribution/channels/{channel}/package', [DistributionChannelSecretController::class, 'package'])
                ->whereNumber('channel')
                ->middleware(['api.scope:distribution:write', 'throttle:api-admin-sensitive']);
            Route::get('distribution/channels/{channel}/deletion-preview', [DistributionChannelController::class, 'deletionPreview'])
                ->whereNumber('channel')
                ->middleware('api.scope:distribution:read');
            Route::post('distribution/channels/{channel}/prepare-delete', [DistributionChannelController::class, 'prepareDelete'])
                ->whereNumber('channel')
                ->middleware(['api.scope:distribution:write', 'throttle:30,1']);
            Route::post('distribution/channels/{channel}/cancel-delete', [DistributionChannelController::class, 'cancelDelete'])
                ->whereNumber('channel')
                ->middleware(['api.scope:distribution:write', 'throttle:30,1']);
            Route::post('distribution/channels/{channel}/delete', [DistributionChannelController::class, 'destroy'])
                ->whereNumber('channel')
                ->middleware(['api.scope:distribution:write', 'throttle:admin-sensitive']);
            Route::post('distribution/channels/{channel}/health', [DistributionChannelController::class, 'health'])
                ->whereNumber('channel')
                ->middleware(['api.scope:distribution:read', 'throttle:30,1']);

            // Hosted Site management is a protected 桐灼GEO capability. It
            // has its own lifecycle, quality gate and allocation contract;
            // keep it separate from generic distribution channels.
            // 2026-09-12 退役补齐：旧 Blade 面对这组路由挂了 `hosted-sites.enabled` 开关，
            // API 面漏了——关掉特性开关后仍可读写托管站点。补上同一条边界。
            Route::middleware('hosted-sites.enabled')->group(function (): void {
                Route::get('distribution/hosted-sites', [HostedSiteController::class, 'index'])
                    ->middleware('api.scope:distribution:read');
                Route::get('distribution/hosted-sites/{hostedSite}', [HostedSiteController::class, 'show'])
                    ->whereNumber('hostedSite')
                    ->middleware('api.scope:distribution:read');
                Route::post('distribution/hosted-sites', [HostedSiteController::class, 'store'])
                    ->middleware(['api.scope:distribution:write', 'throttle:30,1']);
                Route::patch('distribution/hosted-sites/{hostedSite}', [HostedSiteController::class, 'update'])
                    ->whereNumber('hostedSite')
                    ->middleware(['api.scope:distribution:write', 'throttle:30,1']);
                Route::post('distribution/hosted-sites/{hostedSite}/preflight', [HostedSiteController::class, 'preflight'])
                    ->whereNumber('hostedSite')
                    ->middleware(['api.scope:distribution:write', 'throttle:30,1']);
                Route::post('distribution/hosted-sites/{hostedSite}/activate', [HostedSiteController::class, 'activate'])
                    ->whereNumber('hostedSite')
                    ->middleware(['api.scope:distribution:write', 'throttle:30,1']);
                Route::post('distribution/hosted-sites/{hostedSite}/pause', [HostedSiteController::class, 'pause'])
                    ->whereNumber('hostedSite')
                    ->middleware(['api.scope:distribution:write', 'throttle:30,1']);
                Route::post('distribution/hosted-sites/{hostedSite}/maintenance', [HostedSiteController::class, 'maintenance'])
                    ->whereNumber('hostedSite')
                    ->middleware(['api.scope:distribution:write', 'throttle:30,1']);
                Route::post('distribution/hosted-sites/{hostedSite}/indexing', [HostedSiteController::class, 'indexing'])
                    ->whereNumber('hostedSite')
                    ->middleware(['api.scope:distribution:write', 'throttle:30,1']);
                Route::post('distribution/hosted-sites/{hostedSite}/archive', [HostedSiteController::class, 'archive'])
                    ->whereNumber('hostedSite')
                    ->middleware(['api.scope:distribution:write', 'throttle:admin-sensitive']);
                Route::post('distribution/hosted-sites/{hostedSite}/articles', [HostedSiteController::class, 'assignArticle'])
                    ->whereNumber('hostedSite')
                    ->middleware(['api.scope:distribution:write', 'api.scope:articles:publish', 'throttle:30,1']);
            });
            Route::get('distribution/jobs', [DistributionArticleController::class, 'index'])
                ->middleware('api.scope:distribution:read');
            Route::get('articles/{article}/distributions', [DistributionArticleController::class, 'forArticle'])
                ->whereNumber('article')
                ->middleware(['api.scope:articles:read', 'api.scope:distribution:read']);
            Route::post('articles/{article}/distribute', [DistributionArticleController::class, 'enqueue'])
                ->whereNumber('article')
                ->middleware(['api.scope:articles:publish', 'api.scope:distribution:write', 'throttle:30,1']);
            Route::post('distribution/jobs/{distribution}/retry', [DistributionArticleController::class, 'retry'])
                ->whereNumber('distribution')
                ->middleware(['api.scope:articles:publish', 'api.scope:distribution:write', 'throttle:30,1']);
            // 分发记录修正：改/删远端文章。与旧 Blade 后台共用 DistributionArticleOperationService。
            Route::patch('distribution/jobs/{distribution}', [DistributionJobApiController::class, 'update'])
                ->whereNumber('distribution')
                ->middleware(['api.scope:distribution:write', 'throttle:30,1']);
            Route::delete('distribution/jobs/{distribution}', [DistributionJobApiController::class, 'destroy'])
                ->whereNumber('distribution')
                ->middleware(['api.scope:distribution:write', 'throttle:30,1']);

            // jiandu — 「见度GEO」检测系统的接入（外部系统，见 JianduController 注释）。
            // 凭据与出站请求全在服务端；前端只与本组端点交互，永远不接触见度 token。
            // 写接口一律要求 X-Idempotency-Key（控制器内校验），发码另有 30/分钟 粗闸
            // （见度侧真实防线是它自己的 60 秒冷却与账号限流）。
            Route::prefix('jiandu')->group(function (): void {
                Route::middleware('api.scope:jiandu:read')->group(function (): void {
                    Route::get('status', [JianduController::class, 'status']);
                    Route::get('me', [JianduController::class, 'me']);
                    Route::get('projects', [JianduController::class, 'projects']);
                    Route::get('overview', [JianduController::class, 'overview']);
                    Route::get('detections', [JianduController::class, 'detections']);
                    Route::get('reports', [JianduController::class, 'reports']);
                });
                Route::middleware(['api.scope:jiandu:write', 'throttle:30,1'])->group(function (): void {
                    Route::post('session', [JianduController::class, 'storeSession']);
                    Route::post('session/send-code', [JianduController::class, 'sendCode']);
                    Route::delete('session', [JianduController::class, 'destroySession']);
                });
            });

            // manual-publications — management projection of 桐灼GEO's existing
            // governed workflow. Browser execution remains under the dedicated
            // browser-operations protocol above.
            Route::get('manual-publications/management', [ManualPublicationController::class, 'index'])
                ->middleware('api.scope:articles:read');
            // manual-publications/settings — 发布账号与人设（超管专属，控制器内自行判定）。
            Route::get('manual-publications/settings', [ManualPublicationSettingsApiController::class, 'index'])
                ->middleware('api.scope:articles:read');
            // 导出必须在 manual-publications/{id} 之前注册，否则会被它吞掉。
            Route::get('manual-publications/export', [ManualPublicationController::class, 'export'])
                ->middleware('api.scope:articles:read');
            // 浏览器插件连接流程的运营方一侧：查看待批配对、批准/拒绝。
            Route::get('manual-publications/browser-connect', [BrowserConnectionApprovalApiController::class, 'show'])
                ->middleware('api.scope:articles:read');
            Route::post('manual-publications/browser-connect/decision', [BrowserConnectionApprovalApiController::class, 'decision'])
                ->middleware(['api.scope:articles:write', 'throttle:admin-sensitive']);
            Route::post('manual-publications/settings/personas', [ManualPublicationSettingsApiController::class, 'storePersona'])
                ->middleware(['api.scope:articles:write', 'throttle:30,1']);
            Route::patch('manual-publications/settings/personas/{persona}', [ManualPublicationSettingsApiController::class, 'updatePersona'])
                ->whereNumber('persona')
                ->middleware(['api.scope:articles:write', 'throttle:30,1']);
            Route::post('manual-publications/settings/accounts', [ManualPublicationSettingsApiController::class, 'storeAccount'])
                ->middleware(['api.scope:articles:write', 'throttle:30,1']);
            Route::patch('manual-publications/settings/accounts/{account}', [ManualPublicationSettingsApiController::class, 'updateAccount'])
                ->whereNumber('account')
                ->middleware(['api.scope:articles:write', 'throttle:30,1']);
            // The browser-operations protocol already owns GET /manual-publications/{id}.
            // Keep the management projection on an explicit child path so a detail read
            // cannot be intercepted by the browser protocol middleware.
            Route::get('manual-publications/{manualPublication}/management', [ManualPublicationController::class, 'show'])
                ->whereNumber('manualPublication')
                ->middleware('api.scope:articles:read');
            Route::post('manual-publications', [ManualPublicationController::class, 'store'])
                ->middleware(['api.scope:articles:write', 'throttle:30,1']);
            Route::patch('manual-publications/{manualPublication}', [ManualPublicationController::class, 'update'])
                ->whereNumber('manualPublication')
                ->middleware(['api.scope:articles:write', 'throttle:30,1']);
            Route::post('manual-publications/{manualPublication}/transition', [ManualPublicationController::class, 'transition'])
                ->whereNumber('manualPublication')
                ->middleware(['api.scope:articles:write', 'throttle:30,1']);

            // materials:* — 后台素材库 CRUD 与库内条目管理
            // knowledge assets — 文件上传、切片刷新、版本恢复和系统知识媒体。
            Route::get('knowledge-bases/{knowledgeBase}', [KnowledgeAssetApiController::class, 'show'])
                ->whereNumber('knowledgeBase')
                ->middleware('api.scope:materials:read');
            Route::get('knowledge-bases/{knowledgeBase}/revisions', [KnowledgeAssetApiController::class, 'revisions'])
                ->whereNumber('knowledgeBase')
                ->middleware('api.scope:materials:read');
            Route::get('knowledge-bases/{knowledgeBase}/revisions/{revision}', [KnowledgeAssetApiController::class, 'revision'])
                ->whereNumber(['knowledgeBase', 'revision'])
                ->middleware('api.scope:materials:read');
            Route::post('knowledge-bases/upload', [KnowledgeAssetApiController::class, 'upload'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('knowledge-bases/{knowledgeBase}/refresh', [KnowledgeAssetApiController::class, 'refresh'])
                ->whereNumber('knowledgeBase')
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('knowledge-bases/{knowledgeBase}/revisions/{revision}/restore', [KnowledgeAssetApiController::class, 'restoreRevision'])
                ->whereNumber(['knowledgeBase', 'revision'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            // 采纳随包发布的官方版本——revisions/restore 替代不了（它不刷新 official_version）。
            Route::post('knowledge-bases/{knowledgeBase}/official/adopt', [KnowledgeAssetApiController::class, 'adoptOfficial'])
                ->whereNumber('knowledgeBase')
                ->middleware(['api.scope:materials:write', 'throttle:admin-sensitive']);
            Route::get('knowledge-bases/{knowledgeBase}/media', [KnowledgeAssetApiController::class, 'mediaIndex'])
                ->whereNumber('knowledgeBase')
                ->middleware('api.scope:materials:read');
            Route::post('knowledge-bases/{knowledgeBase}/media', [KnowledgeAssetApiController::class, 'mediaStore'])
                ->whereNumber('knowledgeBase')
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::patch('knowledge-bases/{knowledgeBase}/media/{mediaAsset}', [KnowledgeAssetApiController::class, 'mediaUpdate'])
                ->whereNumber(['knowledgeBase', 'mediaAsset'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('knowledge-bases/{knowledgeBase}/media/{mediaAsset}/replace', [KnowledgeAssetApiController::class, 'mediaReplace'])
                ->whereNumber(['knowledgeBase', 'mediaAsset'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('knowledge-bases/{knowledgeBase}/media/{mediaAsset}/toggle', [KnowledgeAssetApiController::class, 'mediaToggle'])
                ->whereNumber(['knowledgeBase', 'mediaAsset'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);

            // enterprise knowledge — AI 草稿生成、来源、校验、版本恢复与发布。
            Route::get('enterprise-knowledge', [EnterpriseKnowledgeApiController::class, 'index'])
                ->middleware('api.scope:materials:read');
            Route::post('enterprise-knowledge', [EnterpriseKnowledgeApiController::class, 'store'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::get('enterprise-knowledge/{project}', [EnterpriseKnowledgeApiController::class, 'show'])
                ->whereNumber('project')
                ->middleware('api.scope:materials:read');
            Route::get('enterprise-knowledge/{project}/status', [EnterpriseKnowledgeApiController::class, 'status'])
                ->whereNumber('project')
                ->middleware('api.scope:materials:read');
            Route::post('enterprise-knowledge/{project}/editor/images/upload', [EnterpriseKnowledgeApiController::class, 'uploadEditorImage'])
                ->whereNumber('project')
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('enterprise-knowledge/{project}/autosave', [EnterpriseKnowledgeApiController::class, 'autosave'])
                ->whereNumber('project')
                ->middleware(['api.scope:materials:write', 'throttle:60,1']);
            Route::post('enterprise-knowledge/{project}/validate', [EnterpriseKnowledgeApiController::class, 'validateDraft'])
                ->whereNumber('project')
                ->middleware(['api.scope:materials:write', 'throttle:60,1']);
            Route::post('enterprise-knowledge/{project}/revisions/{revision}/restore', [EnterpriseKnowledgeApiController::class, 'restoreRevision'])
                ->whereNumber(['project', 'revision'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('enterprise-knowledge/{project}/publish', [EnterpriseKnowledgeApiController::class, 'publish'])
                ->whereNumber('project')
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::delete('enterprise-knowledge/{project}', [EnterpriseKnowledgeApiController::class, 'destroy'])
                ->whereNumber('project')
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::get('materials', [MaterialController::class, 'summary'])->middleware('api.scope:materials:read');
            Route::get('materials/{type}', [MaterialController::class, 'index'])->middleware('api.scope:materials:read');
            Route::post('materials/{type}', [MaterialController::class, 'store'])->middleware('api.scope:materials:write');
            Route::get('materials/{type}/{id}', [MaterialController::class, 'show'])
                ->whereNumber('id')
                ->middleware('api.scope:materials:read');
            Route::patch('materials/{type}/{id}', [MaterialController::class, 'update'])
                ->whereNumber('id')
                ->middleware('api.scope:materials:write');
            Route::delete('materials/{type}/{id}', [MaterialController::class, 'destroy'])
                ->whereNumber('id')
                ->middleware('api.scope:materials:write');
            // 知识库只读检索；默认词法召回，远程 Embedding 必须由客户端显式开启。
            Route::get('materials/knowledge-bases/{knowledgeBase}/search', [KnowledgeSearchController::class, 'show'])
                ->whereNumber('knowledgeBase')
                ->middleware(['api.scope:materials:read', 'throttle:60,1']);
            // knowledge facts — reviewed atomic facts, evidence and immutable
            // revisions.  These routes reuse the 桐灼GEO fact editor/publisher
            // and never accept a client-supplied manifest as authoritative.
            Route::get('materials/knowledge-bases/{knowledgeBase}/facts', [KnowledgeFactApiController::class, 'index'])
                ->whereNumber('knowledgeBase')
                ->middleware('api.scope:materials:read');
            Route::get('materials/knowledge-bases/{knowledgeBase}/fact-revisions/{revision}', [KnowledgeFactApiController::class, 'revision'])
                ->whereNumber(['knowledgeBase', 'revision'])
                ->middleware('api.scope:materials:read');
            Route::post('materials/knowledge-bases/{knowledgeBase}/facts/publish', [KnowledgeFactApiController::class, 'publish'])
                ->whereNumber('knowledgeBase')
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('materials/knowledge-bases/{knowledgeBase}/fact-revisions/{revision}/restore', [KnowledgeFactApiController::class, 'restore'])
                ->whereNumber(['knowledgeBase', 'revision'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('materials/knowledge-bases/{knowledgeBase}/facts', [KnowledgeFactApiController::class, 'store'])
                ->whereNumber('knowledgeBase')
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::patch('materials/knowledge-bases/{knowledgeBase}/facts/{fact}', [KnowledgeFactApiController::class, 'update'])
                ->whereNumber(['knowledgeBase', 'fact'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('materials/knowledge-bases/{knowledgeBase}/facts/{fact}/review', [KnowledgeFactApiController::class, 'review'])
                ->whereNumber(['knowledgeBase', 'fact'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('materials/knowledge-bases/{knowledgeBase}/facts/{fact}/archive', [KnowledgeFactApiController::class, 'archive'])
                ->whereNumber(['knowledgeBase', 'fact'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('materials/knowledge-bases/{knowledgeBase}/facts/{fact}/values', [KnowledgeFactApiController::class, 'storeValue'])
                ->whereNumber(['knowledgeBase', 'fact'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::patch('materials/knowledge-bases/{knowledgeBase}/fact-values/{value}', [KnowledgeFactApiController::class, 'updateValue'])
                ->whereNumber(['knowledgeBase', 'value'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('materials/knowledge-bases/{knowledgeBase}/fact-values/{value}/archive', [KnowledgeFactApiController::class, 'archiveValue'])
                ->whereNumber(['knowledgeBase', 'value'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('materials/knowledge-bases/{knowledgeBase}/fact-values/{value}/evidences', [KnowledgeFactApiController::class, 'storeEvidence'])
                ->whereNumber(['knowledgeBase', 'value'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('materials/knowledge-bases/{knowledgeBase}/facts/{fact}/merge', [KnowledgeFactApiController::class, 'merge'])
                ->whereNumber(['knowledgeBase', 'fact'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('materials/knowledge-bases/{knowledgeBase}/facts/{fact}/split', [KnowledgeFactApiController::class, 'split'])
                ->whereNumber(['knowledgeBase', 'fact'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('materials/knowledge-bases/{knowledgeBase}/fact-generation', [KnowledgeFactApiController::class, 'startGeneration'])
                ->whereNumber('knowledgeBase')
                ->middleware(['api.scope:materials:write', 'throttle:admin-sensitive']);
            Route::get('materials/knowledge-bases/{knowledgeBase}/fact-generation/{run}', [KnowledgeFactApiController::class, 'showGeneration'])
                ->whereNumber(['knowledgeBase', 'run'])
                ->middleware('api.scope:materials:read');
            Route::post('materials/knowledge-bases/{knowledgeBase}/fact-generation/{run}/cancel', [KnowledgeFactApiController::class, 'cancelGeneration'])
                ->whereNumber(['knowledgeBase', 'run'])
                ->middleware(['api.scope:materials:write', 'throttle:admin-sensitive']);
            Route::post('materials/knowledge-bases/{knowledgeBase}/fact-generation/{run}/resolve', [KnowledgeFactApiController::class, 'resolveGeneration'])
                ->whereNumber(['knowledgeBase', 'run'])
                ->middleware(['api.scope:materials:write', 'throttle:admin-sensitive']);
            // materials/*-libraries/{library}/import — 批量导入。必须在通用的
            // materials/{type}/{id}/items 之外单独注册：导入收的是文本不是条目对象。
            Route::post('materials/keyword-libraries/{library}/import', [LibraryImportApiController::class, 'keywords'])
                ->whereNumber('library')
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('materials/title-libraries/{library}/import', [LibraryImportApiController::class, 'titles'])
                ->whereNumber('library')
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            // 标题库 AI 生成链路：提交 / 记录 / 进度 / 重试 / 取消。
            // 与旧后台共用 TitleGenerationRunService 与生成配置上限，故单独注册
            // 而不是塞进通用的 materials/{type}/{id} 动词。
            Route::get('materials/title-libraries/{library}/ai-generation-runs', [TitleGenerationApiController::class, 'index'])
                ->whereNumber('library')
                ->middleware(['api.scope:materials:read', 'throttle:60,1']);
            Route::post('materials/title-libraries/{library}/ai-generation-runs', [TitleGenerationApiController::class, 'store'])
                ->whereNumber('library')
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::get('materials/title-libraries/{library}/ai-generation-runs/{run}', [TitleGenerationApiController::class, 'show'])
                ->whereNumber(['library', 'run'])
                ->middleware(['api.scope:materials:read', 'throttle:120,1']);
            Route::post('materials/title-libraries/{library}/ai-generation-runs/{run}/retry', [TitleGenerationApiController::class, 'retry'])
                ->whereNumber(['library', 'run'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('materials/title-libraries/{library}/ai-generation-runs/{run}/cancel', [TitleGenerationApiController::class, 'cancel'])
                ->whereNumber(['library', 'run'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            // 图片库多图上传。单张仍走通用的 materials/{type}/{id}/items。
            Route::post('materials/image-libraries/{library}/images', [MaterialController::class, 'storeImages'])
                ->whereNumber('library')
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            // 作者详情页的「最近文章」列表（旧后台 Admin\AuthorController::detail）。
            Route::get('materials/authors/{author}/articles', [MaterialController::class, 'authorArticles'])
                ->whereNumber('author')
                ->middleware('api.scope:materials:read');
            Route::get('materials/{type}/{id}/items', [MaterialController::class, 'items'])
                ->whereNumber('id')
                ->middleware('api.scope:materials:read');
            Route::post('materials/{type}/{id}/items', [MaterialController::class, 'storeItem'])
                ->whereNumber('id')
                ->middleware('api.scope:materials:write');
            Route::delete('materials/{type}/{id}/items', [MaterialController::class, 'destroyItems'])
                ->whereNumber('id')
                ->middleware('api.scope:materials:write');

            // url-imports:* — URL 抓取、AI 预览与知识/关键词/标题库提交。
            // 复用 桐灼GEO 的 SafeOutboundHttpClient、AI 执行身份和队列，
            // 不把旧 Blade 的重定向协议带进 React 管理端。
            Route::get('url-imports', [UrlImportController::class, 'index'])
                ->middleware('api.scope:materials:read');
            Route::post('url-imports', [UrlImportController::class, 'store'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::get('url-imports/{urlImport}', [UrlImportController::class, 'show'])
                ->whereNumber('urlImport')
                ->middleware('api.scope:materials:read');
            Route::post('url-imports/{urlImport}/run', [UrlImportController::class, 'run'])
                ->whereNumber('urlImport')
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::post('url-imports/{urlImport}/commit', [UrlImportController::class, 'commit'])
                ->whereNumber('urlImport')
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);

            // url-scans:* — 对公开 URL 的 SSRF 安全只读 GEO 体检报告。
            // 扫描结果持久化，便于重试、审计和导出，不执行 AI 或写入目标站点。
            Route::get('url-scans', [UrlScannerController::class, 'index'])
                ->middleware('api.scope:materials:read');
            Route::post('url-scans', [UrlScannerController::class, 'store'])
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::get('url-scans/{urlScan}', [UrlScannerController::class, 'show'])
                ->whereNumber('urlScan')
                ->middleware('api.scope:materials:read');
            Route::post('url-scans/{urlScan}/retry', [UrlScannerController::class, 'retry'])
                ->whereNumber('urlScan')
                ->middleware(['api.scope:materials:write', 'throttle:30,1']);
            Route::get('url-scans/{urlScan}/export', [UrlScannerController::class, 'export'])
                ->whereNumber('urlScan')
                ->middleware('api.scope:materials:read');

            // articles:* — 文章 CRUD、审核、发布、软删
            Route::get('articles', [ArticleController::class, 'index'])->middleware('api.scope:articles:read');
            Route::post('articles', [ArticleController::class, 'store'])
                ->middleware(['api.scope:articles:write', 'throttle:60,1']);
            Route::post('articles/batch/review', [ArticleController::class, 'batchReview'])
                ->middleware(['api.scope:articles:publish', 'throttle:30,1']);
            Route::post('articles/batch/publish', [ArticleController::class, 'batchPublish'])
                ->middleware(['api.scope:articles:publish', 'throttle:30,1']);
            // 批量改状态（撤回成草稿 / 设为发布或私有）——旧后台 batch/update-status 的等价物。
            // 用 articles:publish 而非 articles:write：这条端点**能发布**，撤回只是它的一个子动作。
            Route::post('articles/batch/status', [ArticleController::class, 'batchUpdateStatus'])
                ->middleware(['api.scope:articles:publish', 'throttle:30,1']);
            Route::post('articles/batch/trash', [ArticleController::class, 'batchTrash'])
                ->middleware(['api.scope:articles:write', 'throttle:30,1']);
            Route::post('articles/batch/restore', [ArticleController::class, 'batchRestore'])
                ->middleware(['api.scope:articles:write', 'throttle:30,1']);
            Route::post('articles/batch/force-delete', [ArticleController::class, 'batchForceDelete'])
                ->middleware(['api.scope:articles:write', 'throttle:admin-sensitive']);
            Route::post('articles/trash/empty', [ArticleController::class, 'emptyTrash'])
                ->middleware(['api.scope:articles:write', 'throttle:admin-sensitive']);
            Route::post('articles/markdown-export/prepare', [ArticleController::class, 'prepareMarkdownExport'])
                ->middleware(['api.scope:articles:read', 'throttle:article-markdown-export-prepare']);
            Route::get('articles/markdown-export/{exportToken}/download', [ArticleController::class, 'downloadMarkdownExport'])
                ->middleware(['api.scope:articles:read', 'signed:relative', 'throttle:article-markdown-export-download'])
                ->where('exportToken', '[A-Za-z0-9]{40}')
                ->name('api.v1.articles.markdown-export.download');
            Route::post('articles/editor/wechat-html', [ArticleController::class, 'exportWeChatHtml'])
                ->middleware(['api.scope:articles:write', 'throttle:60,1']);
            // articles/editor — 编辑器内联助手。与旧 Blade 后台共用
            // ArticleEditorAssistantService，不另建一套模型边界与配额。
            Route::get('articles/editor/titles', [ArticleEditorAssistantApiController::class, 'titles'])
                ->middleware(['api.scope:articles:read', 'throttle:60,1']);
            Route::post('articles/editor/generate', [ArticleEditorAssistantApiController::class, 'generate'])
                ->middleware(['api.scope:articles:write', 'throttle:api-admin-sensitive']);
            Route::get('articles/{article}', [ArticleController::class, 'show'])
                ->whereNumber('article')
                ->middleware('api.scope:articles:read');
            Route::get('articles/{article}/ai-quality/status', [ArticleController::class, 'aiQualityStatus'])
                ->whereNumber('article')
                ->middleware(['api.scope:articles:read', 'throttle:120,1']);
            Route::patch('articles/{article}', [ArticleController::class, 'update'])
                ->whereNumber('article')
                ->middleware(['api.scope:articles:write', 'throttle:60,1']);
            Route::post('articles/{article}/review', [ArticleController::class, 'review'])
                ->whereNumber('article')
                ->middleware(['api.scope:articles:publish', 'throttle:60,1']);
            Route::post('articles/{article}/publish', [ArticleController::class, 'publish'])
                ->whereNumber('article')
                ->middleware(['api.scope:articles:publish', 'throttle:60,1']);
            Route::post('articles/{article}/ai-quality/recheck', [ArticleController::class, 'recheckAiQuality'])
                ->whereNumber('article')
                ->middleware(['api.scope:articles:publish', 'throttle:api-ai-quality-manual']);
            Route::post('articles/{article}/ai-quality/override', [ArticleController::class, 'overrideAiQuality'])
                ->whereNumber('article')
                ->middleware(['api.scope:articles:publish', 'throttle:30,1']);
            Route::post('articles/{article}/ai-quality/optimization', [ArticleController::class, 'startAiOptimization'])
                ->whereNumber('article')
                ->middleware(['api.scope:articles:publish', 'throttle:api-ai-quality-manual'])
                ->name('api.v1.articles.ai-quality.optimization.store');
            Route::get('articles/{article}/ai-quality/optimization/candidate', [ArticleController::class, 'latestAiOptimizationCandidate'])
                ->whereNumber('article')
                ->middleware(['api.scope:articles:read', 'throttle:120,1'])
                ->name('api.v1.articles.ai-quality.optimization.latest-candidate');
            Route::get('articles/{article}/ai-quality/optimization/{run}/candidate', [ArticleController::class, 'aiOptimizationCandidate'])
                ->whereNumber(['article', 'run'])
                ->middleware(['api.scope:articles:read', 'throttle:120,1'])
                ->name('api.v1.articles.ai-quality.optimization.candidate');
            Route::post('articles/{article}/ai-quality/optimization/{run}/apply', [ArticleController::class, 'applyAiOptimization'])
                ->whereNumber(['article', 'run'])
                ->middleware(['api.scope:articles:publish', 'throttle:api-ai-quality-manual'])
                ->name('api.v1.articles.ai-quality.optimization.apply');
            Route::post('articles/{article}/ai-quality/optimization/{run}/cancel', [ArticleController::class, 'cancelAiOptimization'])
                ->whereNumber(['article', 'run'])
                ->middleware(['api.scope:articles:publish', 'throttle:api-ai-quality-manual'])
                ->name('api.v1.articles.ai-quality.optimization.cancel');
            Route::post('articles/{article}/ai-quality/optimization/{run}/rollback', [ArticleController::class, 'rollbackAiOptimization'])
                ->whereNumber(['article', 'run'])
                ->middleware(['api.scope:articles:publish', 'throttle:api-ai-quality-manual'])
                ->name('api.v1.articles.ai-quality.optimization.rollback');
            Route::post('articles/{article}/trash', [ArticleController::class, 'trash'])
                ->whereNumber('article')
                ->middleware(['api.scope:articles:write', 'throttle:60,1']);
            Route::post('articles/{article}/restore', [ArticleController::class, 'restore'])
                ->whereNumber('article')
                ->middleware(['api.scope:articles:write', 'throttle:60,1']);
            Route::post('articles/{article}/risk-scan', [ArticleController::class, 'recheckRisk'])
                ->whereNumber('article')
                ->middleware(['api.scope:articles:write', 'throttle:admin-sensitive']);
            Route::post('articles/{article}/editor/images/upload', [ArticleController::class, 'uploadEditorImage'])
                ->whereNumber('article')
                ->middleware(['api.scope:articles:write', 'throttle:60,1']);
        });
    });
