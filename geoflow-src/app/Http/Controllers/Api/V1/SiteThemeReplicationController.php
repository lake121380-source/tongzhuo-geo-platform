<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Jobs\IterateSiteThemeReplicationJob;
use App\Jobs\RunSiteThemeReplicationJob;
use App\Models\Admin;
use App\Models\SiteThemeReplication;
use App\Services\Admin\SiteThemeReplication\ThemePreviewRenderer;
use App\Services\Admin\SiteThemeReplication\ThemeReplicationPackageService;
use App\Services\Admin\SiteThemeReplication\ThemeReplicationPublishService;
use App\Services\Admin\SiteThemeReplicationService;
use App\Services\Api\IdempotencyService;
use App\Support\Site\SiteThemeCatalog;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Validation\Rule;
use InvalidArgumentException;
use RuntimeException;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

final class SiteThemeReplicationController extends BaseApiController
{
    public function index(Request $request, SiteThemeReplicationService $service, SiteThemeCatalog $catalog): JsonResponse
    {
        $this->requireSuperAdmin($request);
        $items = SiteThemeReplication::query()->with('aiModel')->latest('id')->limit(min(100, max(1, $request->integer('limit', 20))))->get();

        return $this->success($request, [
            'items' => $items->map(fn (SiteThemeReplication $item): array => $this->projection($item, $service))->values()->all(),
            'themes' => $catalog->all(),
            'models' => $service->activeChatModels()->map(fn ($model): array => ['id' => (int) $model->id, 'name' => (string) $model->name, 'model_id' => (string) $model->model_id])->values()->all(),
            'schema_ready' => $service->isSchemaReady(),
        ]);
    }

    public function show(Request $request, int $replication, SiteThemeReplicationService $service): JsonResponse
    {
        $this->requireSuperAdmin($request);
        $item = SiteThemeReplication::query()->with(['aiModel', 'versions'])->findOrFail($replication);

        return $this->success($request, ['replication' => $this->projection($item, $service, true)]);
    }

    public function store(Request $request, SiteThemeReplicationService $service): JsonResponse
    {
        $admin = $this->requireSuperAdmin($request);
        $this->requireIdempotencyKey($request);
        $payload = $request->validate([
            'name' => ['required', 'string', 'max:120'],
            'theme_id' => ['required', 'string', 'max:80', 'regex:/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,78}[a-zA-Z0-9]$/'],
            'base_theme_id' => ['nullable', 'string', 'max:80'],
            'ai_model_id' => ['required', 'integer', Rule::exists('ai_models', 'id')->where(fn ($q) => $q->where('status', 'active')->whereRaw("COALESCE(NULLIF(model_type, ''), 'chat') = 'chat'"))],
            'home_url' => ['required', 'url:http,https', 'max:500'],
            'category_url' => ['required', 'url:http,https', 'max:500'],
            'article_url' => ['required', 'url:http,https', 'max:500'],
            'style_preference' => ['required', Rule::in(['content_site', 'brand_site', 'news_site'])],
            'compliance_ack' => ['accepted'],
        ]);

        return IdempotencyService::executeJson($request, 'POST /site-settings/theme-replications', function () use ($request, $service, $admin, $payload): JsonResponse {
            if (! $service->isSchemaReady()) {
                throw new ApiException('theme_replication_migration_required', __('admin.theme_replication.message.migration_required'), 409);
            }
            // 2026-09-12 退役补齐：旧 Blade 的 `Admin\SiteThemeReplicationController` 会先校验
            // `base_theme_id` 是否属于主题目录（`isCatalogThemeId`），这条 API 只当普通字符串收，
            // 于是**任何未知基底主题都会被静默接受**。与旧面同一条边界，缺了就是校验倒退。
            $baseThemeId = trim((string) ($payload['base_theme_id'] ?? ''));
            if ($baseThemeId !== '' && ! $service->isCatalogThemeId($baseThemeId)) {
                throw new ApiException('validation_failed', __('admin.theme_replication.validation.base_theme_invalid'), 422, [
                    'field_errors' => ['base_theme_id' => __('admin.theme_replication.validation.base_theme_invalid')],
                ]);
            }
            try {
                $themeId = $service->normalizeThemeId((string) $payload['theme_id']);
                if ($service->themeIdExists($themeId)) {
                    throw new ApiException('theme_id_exists', __('admin.theme_replication.validation.theme_id_exists'), 409);
                }
                $item = $service->create([...$payload, 'theme_id' => $themeId, 'created_by_admin_id' => (int) $admin->id]);
            } catch (InvalidArgumentException|RuntimeException $e) {
                throw new ApiException('theme_replication_create_failed', $e->getMessage(), 422);
            }
            RunSiteThemeReplicationJob::dispatch((int) $item->id)->onQueue('theme-replication');

            return $this->success($request, ['replication' => $this->projection($item, $service)], 201);
        });
    }

    public function retry(Request $request, int $replication, SiteThemeReplicationService $service): JsonResponse
    {
        $this->requireSuperAdmin($request);
        $this->requireIdempotencyKey($request);
        $item = SiteThemeReplication::query()->findOrFail($replication);

        return IdempotencyService::executeJson($request, 'POST /site-settings/theme-replications/{id}/retry', function () use ($request, $service, $item): JsonResponse {
            if ((string) $item->status !== SiteThemeReplication::STATUS_FAILED) {
                throw new ApiException('retry_unavailable', __('admin.theme_replication.message.retry_unavailable'), 409);
            }
            $service->retry($item);
            RunSiteThemeReplicationJob::dispatch((int) $item->id)->onQueue('theme-replication');

            return $this->success($request, ['replication' => $this->projection($item->fresh(), $service)]);
        });
    }

    public function iterate(Request $request, int $replication, SiteThemeReplicationService $service): JsonResponse
    {
        $this->requireSuperAdmin($request);
        $this->requireIdempotencyKey($request);
        $payload = $request->validate(['feedback' => ['required', 'string', 'max:2000']]);
        $item = SiteThemeReplication::query()->findOrFail($replication);

        return IdempotencyService::executeJson($request, 'POST /site-settings/theme-replications/{id}/iterate', function () use ($request, $service, $item, $payload): JsonResponse {
            if ((string) $item->status !== SiteThemeReplication::STATUS_READY) {
                throw new ApiException('iteration_unavailable', __('admin.theme_replication.message.iteration_unavailable'), 409);
            }
            $item->forceFill(['status' => SiteThemeReplication::STATUS_ITERATING, 'error_message' => null])->save();
            $service->log($item, 'info', 'iteration_queued', __('admin.theme_replication.log.iteration_queued'), ['feedback' => mb_substr((string) $payload['feedback'], 0, 500)]);
            IterateSiteThemeReplicationJob::dispatch((int) $item->id, (string) $payload['feedback'])->onQueue('theme-replication');

            return $this->success($request, ['replication' => $this->projection($item->fresh(), $service)]);
        });
    }

    public function action(Request $request, int $replication, string $action, SiteThemeReplicationService $service, ThemeReplicationPublishService $publisher): JsonResponse
    {
        $this->requireSuperAdmin($request);
        $this->requireIdempotencyKey($request);
        $item = SiteThemeReplication::query()->findOrFail($replication);

        return IdempotencyService::executeJson($request, 'POST /site-settings/theme-replications/{id}/'.$action, function () use ($request, $action, $service, $publisher, $item): JsonResponse {
            try {
                $data = match ($action) {
                    'publish' => ['publish' => $publisher->publish($item)],
                    'archive' => ['replication' => $service->archive($item)],
                    'delete-drafts' => ['replication' => $service->deleteDrafts($item)],
                    default => throw new ApiException('unsupported_action', 'Unsupported action', 404),
                };
            } catch (RuntimeException $e) {
                throw new ApiException('theme_replication_'.$action.'_failed', $e->getMessage(), 409);
            }
            if (isset($data['replication'])) {
                $data['replication'] = $this->projection($data['replication']->fresh(), $service);
            }

            return $this->success($request, $data);
        });
    }

    public function copy(Request $request, int $replication, SiteThemeReplicationService $service): JsonResponse
    {
        $admin = $this->requireSuperAdmin($request);
        $this->requireIdempotencyKey($request);
        $payload = $request->validate(['name' => ['required', 'string', 'max:120'], 'theme_id' => ['required', 'string', 'max:80', 'regex:/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,78}[a-zA-Z0-9]$/']]);
        $item = SiteThemeReplication::query()->findOrFail($replication);

        return IdempotencyService::executeJson($request, 'POST /site-settings/theme-replications/{id}/copy', function () use ($request, $service, $admin, $item, $payload): JsonResponse {
            try {
                $copy = $service->duplicateAsNewTheme($item, [...$payload, 'created_by_admin_id' => (int) $admin->id]);
            } catch (InvalidArgumentException|RuntimeException $e) {
                throw new ApiException('theme_replication_copy_failed', $e->getMessage(), 409);
            }

            return $this->success($request, ['replication' => $this->projection($copy, $service)], 201);
        });
    }

    public function preview(Request $request, int $replication, string $page, ThemePreviewRenderer $renderer): Response
    {
        $this->requireSuperAdmin($request);
        $item = SiteThemeReplication::query()->findOrFail($replication);
        abort_unless($item->isPreviewReady(), 404, __('admin.theme_replication.error.preview_unavailable'));

        return $renderer->render($page);
    }

    public function package(Request $request, int $replication, ThemeReplicationPackageService $packages): BinaryFileResponse
    {
        $this->requireSuperAdmin($request);
        $item = SiteThemeReplication::query()->findOrFail($replication);
        abort_unless($item->canPackage(), 409, __('admin.theme_replication.message.publish_unavailable'));
        $package = $packages->createPackage($item);

        return response()->download((string) $package['absolute_path'], (string) $package['name'], ['Cache-Control' => 'private, no-store']);
    }

    private function projection(SiteThemeReplication $item, SiteThemeReplicationService $service, bool $detail = false): array
    {
        $data = ['id' => (int) $item->id, 'name' => (string) $item->name, 'theme_id' => (string) $item->theme_id, 'base_theme_id' => $item->base_theme_id, 'ai_model_id' => $item->ai_model_id, 'status' => (string) $item->status, 'home_url' => (string) $item->home_url, 'category_url' => (string) $item->category_url, 'article_url' => (string) $item->article_url, 'style_preference' => (string) $item->style_preference, 'compliance_status' => (string) $item->compliance_status, 'current_version' => (int) $item->current_version, 'iteration_count' => (int) $item->iteration_count, 'error_message' => $item->error_message, 'created_at' => $item->created_at?->toIso8601String(), 'updated_at' => $item->updated_at?->toIso8601String(), 'can_publish' => $item->canPublish(), 'can_package' => $item->canPackage(), 'can_archive' => $item->canBeArchived(), 'can_delete_drafts' => $item->canDeleteDrafts()];
        if ($detail) {
            $logs = $item->logs()->oldest('id')->limit(100)->get();
            $data['progress'] = $service->progressSnapshot($item, $logs);
            $data['failure_advice'] = $service->failureAdvice($item);
            $data['versions'] = $item->versions->map(fn ($v): array => ['id' => (int) $v->id, 'version' => (int) $v->version, 'feedback' => $v->feedback, 'created_at' => $v->created_at?->toIso8601String()])->values()->all();
        }

        return $data;
    }

    private function requireSuperAdmin(Request $request): Admin
    {
        $admin = $this->executionAdmin($request);
        if (! $admin->isSuperAdmin()) {
            throw new ApiException('forbidden', '主题复制管理仅限超级管理员', 403);
        }

        return $admin;
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }
}
