<?php

namespace App\Http\Controllers\Api\V1;

use App\Data\Ai\SystemAiIdentity;
use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Models\KnowledgeBase;
use App\Models\KnowledgeBaseRevision;
use App\Models\KnowledgeMediaAsset;
use App\Models\SystemKnowledgeBase;
use App\Services\AiWorkspace\AdminHelpFeatureRegistry;
use App\Services\AiWorkspace\SystemKnowledgeBaseManager;
use App\Services\AiWorkspace\SystemKnowledgeMediaManager;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\ArticleAiQualityInvalidationService;
use App\Services\GeoFlow\KnowledgeChunkSyncCoordinator;
use App\Services\GeoFlow\KnowledgeSourceParser;
use App\Services\GeoFlow\MaterialLibraryService;
use App\Support\AdminActivityLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Collection;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * JSON adapter for the complete 桐灼GEO knowledge-asset workflow.
 *
 * This controller intentionally delegates persistence, chunk scheduling and
 * protected system-knowledge rules to the existing services used by the old
 * admin UI.  React receives the same durable state instead of a second
 * in-memory implementation.
 */
final class KnowledgeAssetApiController extends BaseApiController
{
    public function show(Request $request, int $knowledgeBase, MaterialLibraryService $materials, SystemKnowledgeBaseManager $system, AdminHelpFeatureRegistry $features): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $base = KnowledgeBase::query()
            ->with(['systemBinding', 'revisions.creator', 'mediaAssets.creator'])
            ->withCount(['chunks as chunk_count', 'linkedTasks as linked_task_count'])
            ->findOrFail($knowledgeBase);

        $payload = $materials->show('knowledge-bases', $knowledgeBase);
        $item = (array) ($payload['item'] ?? []);
        $item['chunk_count'] = (int) ($base->chunk_count ?? 0);
        $item['linked_task_count'] = (int) ($base->linked_task_count ?? 0);
        $item['chunk_sync_status'] = (string) ($base->chunk_sync_status ?? 'idle');
        $item['chunk_sync_error'] = (string) ($base->chunk_sync_error ?? '');
        $item['chunk_synced_at'] = $base->chunk_synced_at?->toIso8601String();
        $item['is_system_managed'] = $base->isSystemManaged();
        $item['system_health'] = $base->isSystemManaged() ? $system->health($base) : null;

        return $this->success($request, [
            'item' => $item,
            'revisions' => $base->revisions->map(fn (KnowledgeBaseRevision $revision): array => $this->serializeRevision($revision, false))->values()->all(),
            'media' => $this->visibleMedia($base->mediaAssets, $admin, $features)
                ->map(fn (KnowledgeMediaAsset $asset): array => $this->serializeMedia($asset))->values()->all(),
        ]);
    }

    public function revisions(Request $request, int $knowledgeBase): JsonResponse
    {
        $this->executionAdmin($request);
        $base = KnowledgeBase::query()->findOrFail($knowledgeBase);

        return $this->success($request, [
            'knowledge_base_id' => (int) $base->id,
            'items' => $base->revisions()->with('creator')->limit(50)->get()
                ->map(fn (KnowledgeBaseRevision $revision): array => $this->serializeRevision($revision, false))
                ->values()->all(),
        ]);
    }

    public function revision(Request $request, int $knowledgeBase, int $revision): JsonResponse
    {
        $this->executionAdmin($request);
        $base = KnowledgeBase::query()->findOrFail($knowledgeBase);
        $row = $base->revisions()->with('creator')->whereKey($revision)->firstOrFail();

        return $this->success($request, [
            'knowledge_base_id' => (int) $base->id,
            'revision' => $this->serializeRevision($row, true),
        ]);
    }

    public function upload(Request $request, MaterialLibraryService $materials, KnowledgeSourceParser $parser): JsonResponse
    {
        $this->executionAdmin($request);
        $payload = $request->validate([
            'name' => ['nullable', 'string', 'max:100'],
            'description' => ['nullable', 'string', 'max:2000'],
            'content' => ['nullable', 'string'],
            'file_type' => ['nullable', 'in:markdown,word,text'],
            'source_name' => ['nullable', 'string', 'max:255'],
            'source_url' => ['nullable', 'url', 'max:500'],
            'source_type' => ['nullable', 'string', 'max:80'],
            'business_line' => ['nullable', 'string', 'max:160'],
            'risk_level' => ['nullable', 'in:low,medium,high'],
            'review_status' => ['nullable', 'in:unreviewed,reviewing,reviewed,rejected'],
            'knowledge_file' => ['nullable', 'file', 'max:8192', 'mimes:txt,md,markdown,docx'],
            'knowledge_files' => ['nullable', 'array', 'max:10'],
            'knowledge_files.*' => ['file', 'max:8192', 'mimes:txt,md,markdown,docx'],
        ], [
            // 这几条以前没配中文：被拒时运营看到的是英文的
            // "The knowledge file field must be a file of type: txt, md, markdown, docx."，
            // 而前端只渲染 message（不展示 field_errors），于是界面上只剩「参数校验失败」。
            'knowledge_file.mimes' => '只支持 TXT / Markdown / DOCX 文件（PDF、Excel、CSV 等请先转成 Markdown 或 TXT）',
            'knowledge_file.max' => '单个文件不能超过 8 MB',
            'knowledge_files.*.mimes' => '只支持 TXT / Markdown / DOCX 文件（PDF、Excel、CSV 等请先转成 Markdown 或 TXT）',
            'knowledge_files.*.max' => '单个文件不能超过 8 MB',
        ]);

        $files = $parser->uploadedKnowledgeFiles($request);
        if ($files === [] && $request->hasFile('file')) {
            $file = $request->file('file');
            if ($file instanceof UploadedFile) {
                $files[] = $file;
            }
        }
        $manual = $parser->normalizeKnowledgeText((string) ($payload['content'] ?? ''));
        if ($manual === '' && $files === []) {
            throw new ApiException('validation_failed', '知识库正文或文件不能为空', 422, [
                'field_errors' => ['content' => '请填写正文或上传知识文件'],
            ]);
        }

        $storedPaths = [];
        try {
            $parsed = $parser->parseUploadedKnowledgeFiles($files, $storedPaths, 'uploads/knowledge');
            $content = $parser->mergeKnowledgeSources($manual, $parsed);
            $name = trim((string) ($payload['name'] ?? ''))
                ?: ($parser->inferKnowledgeName($files) ?: $parser->inferKnowledgeNameFromContent($content));
            if ($name === '') {
                throw new ApiException('validation_failed', '知识库名称不能为空', 422, [
                    'field_errors' => ['name' => '请填写知识库名称'],
                ]);
            }
            $createPayload = array_merge($payload, [
                'name' => $name,
                'content' => $content,
                'file_type' => $parser->resolveKnowledgeFileType((string) ($payload['file_type'] ?? 'markdown'), $manual, $parsed),
                'file_path' => $parser->encodeKnowledgeFilePaths($storedPaths),
                'character_count' => mb_strlen($content, 'UTF-8'),
                'word_count' => mb_strlen(strip_tags($content), 'UTF-8'),
            ]);

            return IdempotencyService::executeJson(
                $request,
                'POST /knowledge-bases/upload',
                function () use ($request, $materials, $createPayload, $parser, $storedPaths): JsonResponse {
                    try {
                        $created = $materials->create('knowledge-bases', $createPayload);
                    } catch (Throwable $exception) {
                        $parser->cleanupKnowledgeFiles($storedPaths);
                        throw $exception;
                    }
                    $this->log($request, 'knowledge_base.created', (int) (($created['item']['id'] ?? 0)), [
                        'uploaded_file_count' => count($storedPaths),
                    ]);

                    return $this->success($request, $created, 201);
                },
            );
        } catch (ValidationException|ApiException $exception) {
            $parser->cleanupKnowledgeFiles($storedPaths);
            throw $exception;
        } catch (\RuntimeException $exception) {
            // 解析器抛的 RuntimeException 都是**写给用户看的中文**（例：「不支持的文件格式，
            // 请上传 TXT、MD 或 DOCX 文件」「知识库名称不能为空」）。以前没人接，直接落进
            // bootstrap 的 500 兜底 → 运营看到「服务器内部错误」，既不知道原因、也以为系统坏了。
            // 这里翻成 422，把原话交给用户。
            $parser->cleanupKnowledgeFiles($storedPaths);
            $message = trim($exception->getMessage());

            throw new ApiException(
                'knowledge_source_invalid',
                $message !== '' ? $message : '知识文件无法解析，请检查文件格式',
                422,
                ['field_errors' => ['knowledge_file' => $message !== '' ? $message : '知识文件无法解析']],
            );
        } catch (Throwable $exception) {
            $parser->cleanupKnowledgeFiles($storedPaths);
            throw $exception;
        }
    }

    public function refresh(Request $request, int $knowledgeBase, KnowledgeChunkSyncCoordinator $sync): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $base = KnowledgeBase::query()->with('systemBinding')->findOrFail($knowledgeBase);
        // 2026-09-12 退役补齐：旧 Blade 后台的 `admin.knowledge-bases.chunks.refresh` 只对超管开放
        // （受保护工作流）。这条 API 原先只查 `materials:write` scope，**普通管理员可以重建系统知识库的
        // 索引**。与媒体、`official/adopt` 的门禁对齐。
        $this->assertProtectedKnowledgeWritable($base, $admin);
        if (trim((string) $base->content) === '') {
            throw new ApiException('content_required', '知识库正文不能为空', 422);
        }

        return IdempotencyService::executeJson(
            $request,
            'POST /knowledge-bases/{id}/refresh',
            function () use ($request, $base, $sync): JsonResponse {
                $scheduled = $sync->request(
                    (int) $base->id,
                    SystemAiIdentity::knowledgeIndex(),
                    requireRealEmbedding: ! $base->isSystemManaged(),
                    force: true,
                );
                $this->log($request, 'knowledge_base.chunks_refresh_requested', (int) $base->id, ['scheduled' => $scheduled]);

                return $this->success($request, [
                    'knowledge_base_id' => (int) $base->id,
                    'scheduled' => $scheduled,
                    'chunk_sync_status' => (string) ($base->fresh()->chunk_sync_status ?? 'pending'),
                ]);
            },
        );
    }

    public function restoreRevision(Request $request, int $knowledgeBase, int $revision, SystemKnowledgeBaseManager $system): JsonResponse
    {
        $admin = $this->writableAdmin($request);
        $base = KnowledgeBase::query()->with('systemBinding')->findOrFail($knowledgeBase);
        $row = $base->revisions()->whereKey($revision)->firstOrFail();
        if (! $base->isSystemManaged()) {
            throw new ApiException('revision_restore_unsupported', '普通知识库没有可恢复的系统版本', 422);
        }

        return IdempotencyService::executeJson(
            $request,
            'POST /knowledge-bases/{id}/revisions/{revision}/restore',
            function () use ($request, $system, $base, $row, $admin): JsonResponse {
                try {
                    $restored = $system->restore($base, $row, $admin);
                } catch (Throwable $exception) {
                    throw new ApiException('revision_restore_failed', $exception->getMessage(), 422);
                }
                $this->log($request, 'knowledge_base.revision_restored', (int) $base->id, ['revision_id' => (int) $row->id]);

                return $this->success($request, [
                    'knowledge_base_id' => (int) $base->id,
                    'revision' => $this->serializeRevision($restored, true),
                ]);
            },
        );
    }

    public function mediaIndex(Request $request, int $knowledgeBase, AdminHelpFeatureRegistry $features): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $base = KnowledgeBase::query()->findOrFail($knowledgeBase);

        return $this->success($request, [
            'knowledge_base_id' => (int) $base->id,
            'items' => $this->visibleMedia($base->mediaAssets()->with('creator')->get(), $admin, $features)
                ->map(fn (KnowledgeMediaAsset $asset): array => $this->serializeMedia($asset))
                ->values()->all(),
        ]);
    }

    /**
     * 受保护页面的媒体不下发给没有该页权限的管理员。
     *
     * 旧 Blade 知识库详情页就是这么过滤的（`KnowledgeBaseController` 里同一段判断）。迁到 API 后
     * 这层过滤丢了——普通管理员会在 React 知识库页看到一条缩略图永远取不到（403/404）的记录。
     * 图片本身仍由 `/api/v1/ai-workspace/media/{id}` 把守，这里挡住的是元数据与入口本身。
     *
     * @param  Collection<int, KnowledgeMediaAsset>  $assets
     * @return Collection<int, KnowledgeMediaAsset>
     */
    private function visibleMedia($assets, Admin $admin, AdminHelpFeatureRegistry $features)
    {
        return $assets
            ->filter(fn (KnowledgeMediaAsset $asset): bool => $features->canAccessPath($admin, (string) $asset->tab_path))
            ->values();
    }

    public function mediaStore(Request $request, int $knowledgeBase, SystemKnowledgeMediaManager $media): JsonResponse
    {
        $admin = $this->writableAdmin($request);
        $base = KnowledgeBase::query()->with('systemBinding')->findOrFail($knowledgeBase);
        $this->assertProtectedKnowledgeWritable($base, $admin);
        $payload = $this->mediaPayload($request, true);
        $file = $request->file('image');
        if (! $file instanceof UploadedFile) {
            throw new ApiException('validation_failed', '必须上传 PNG 或 WebP 图片', 422);
        }

        return IdempotencyService::executeJson($request, 'POST /knowledge-bases/{id}/media', function () use ($request, $media, $base, $admin, $file, $payload): JsonResponse {
            try {
                $asset = $media->replace($base, $admin, $file, $payload);
            } catch (Throwable $exception) {
                throw new ApiException('media_store_failed', $exception->getMessage(), 422);
            }
            $this->log($request, 'knowledge_base.media_imported', (int) $base->id, ['media_asset_id' => (int) $asset->id]);

            return $this->success($request, ['item' => $this->serializeMedia($asset)], 201);
        });
    }

    public function mediaUpdate(Request $request, int $knowledgeBase, int $mediaAsset, SystemKnowledgeMediaManager $media): JsonResponse
    {
        $admin = $this->writableAdmin($request);
        $asset = KnowledgeMediaAsset::query()->where('knowledge_base_id', $knowledgeBase)->findOrFail($mediaAsset);
        $this->assertProtectedKnowledgeWritable(
            KnowledgeBase::query()->with('systemBinding')->findOrFail($knowledgeBase),
            $admin,
        );
        $payload = $this->mediaPayload($request, false);

        return IdempotencyService::executeJson($request, 'PATCH /knowledge-bases/{id}/media/{media}', function () use ($request, $media, $asset, $admin, $payload): JsonResponse {
            try {
                $updated = $media->updateMetadata($asset, $admin, $payload);
            } catch (Throwable $exception) {
                throw new ApiException('media_update_failed', $exception->getMessage(), 422);
            }
            $this->log($request, 'knowledge_base.media_updated', (int) $asset->knowledge_base_id, ['media_asset_id' => (int) $updated->id]);

            return $this->success($request, ['item' => $this->serializeMedia($updated)]);
        });
    }

    public function mediaReplace(Request $request, int $knowledgeBase, int $mediaAsset, SystemKnowledgeMediaManager $media): JsonResponse
    {
        $admin = $this->writableAdmin($request);
        $asset = KnowledgeMediaAsset::query()->where('knowledge_base_id', $knowledgeBase)->findOrFail($mediaAsset);
        $base = KnowledgeBase::query()->with('systemBinding')->findOrFail($knowledgeBase);
        $this->assertProtectedKnowledgeWritable($base, $admin);
        $payload = $this->mediaPayload($request, true, $asset);
        $file = $request->file('image');
        if (! $file instanceof UploadedFile) {
            throw new ApiException('validation_failed', '必须上传 PNG 或 WebP 图片', 422);
        }
        $payload['asset_key'] = (string) $asset->asset_key;
        $payload['locale'] = (string) $asset->locale;

        return IdempotencyService::executeJson($request, 'POST /knowledge-bases/{id}/media/{media}/replace', function () use ($request, $media, $base, $admin, $file, $payload): JsonResponse {
            try {
                $replacement = $media->replace($base, $admin, $file, $payload);
            } catch (Throwable $exception) {
                throw new ApiException('media_replace_failed', $exception->getMessage(), 422);
            }
            $this->log($request, 'knowledge_base.media_replaced', (int) $base->id, [
                'media_asset_id' => (int) $replacement->id,
                'supersedes_id' => $replacement->supersedes_id === null ? null : (int) $replacement->supersedes_id,
            ]);

            return $this->success($request, ['item' => $this->serializeMedia($replacement)], 201);
        });
    }

    public function mediaToggle(Request $request, int $knowledgeBase, int $mediaAsset, SystemKnowledgeMediaManager $media): JsonResponse
    {
        $admin = $this->writableAdmin($request);
        $asset = KnowledgeMediaAsset::query()->where('knowledge_base_id', $knowledgeBase)->findOrFail($mediaAsset);
        $this->assertProtectedKnowledgeWritable(
            KnowledgeBase::query()->with('systemBinding')->findOrFail($knowledgeBase),
            $admin,
        );
        $active = $request->boolean('active');

        return IdempotencyService::executeJson($request, 'POST /knowledge-bases/{id}/media/{media}/toggle', function () use ($request, $media, $asset, $admin, $active): JsonResponse {
            try {
                $updated = $media->setActive($asset, $admin, $active);
            } catch (Throwable $exception) {
                throw new ApiException('media_toggle_failed', $exception->getMessage(), 422);
            }
            $this->log($request, 'knowledge_base.media_status_changed', (int) $asset->knowledge_base_id, [
                'media_asset_id' => (int) $updated->id,
                'active' => $active,
            ]);

            return $this->success($request, ['item' => $this->serializeMedia($updated)]);
        });
    }

    /** @return array<string,mixed> */
    /**
     * 采纳当前随包发布的官方版本（旧后台 `knowledge-bases/{id}/official/adopt`）。
     *
     * 产品升级带来新官方内容后**必须走这条**：否则运营方在 `-AI` 里永远采纳不了新版本，
     * 系统知识库的 `system_health` 会一直报「有官方更新可用」。
     *
     * **旧的 `revisions/{revision}/restore` 替代不了**：它只在内容哈希恰好等于绑定记录的
     * `official_content_hash` 时才清 `customized_at`，**不会刷新 `official_version` /
     * `official_content_hash` / `last_synced_at`**——采纳新版本这件事它做不到。
     *
     * 真正的重置由 {@see SystemKnowledgeBaseManager::adoptOfficial} 拥有（加锁、写修订、
     * 刷新绑定记录）；这里只做权限门禁、内容是否变化、质检失效与审计。
     */
    public function adoptOfficial(Request $request, int $knowledgeBase, SystemKnowledgeBaseManager $system, ArticleAiQualityInvalidationService $qualityInvalidation): JsonResponse
    {
        // 幂等按本控制器的既有约定「可选」：带了 X-Idempotency-Key 就回放，
        // 不带也照常执行（与 restoreRevision 等兄弟方法一致）。
        $admin = $this->executionAdmin($request);
        $base = KnowledgeBase::query()->with('systemBinding')->find($knowledgeBase);
        if (! $base instanceof KnowledgeBase) {
            throw new ApiException('knowledge_base_not_found', '知识库不存在', 404);
        }
        // 与旧后台同一条边界：改系统知识库要受保护工作流权限。
        if (! $admin->canManageProtectedWorkflows()) {
            throw new ApiException('protected_knowledge_read_only', '系统知识库需要受保护工作流权限才能修改', 403);
        }
        // 先判绑定再取定义：`definition('')` 自己会抛 RuntimeException，
        // 那条路走出去就是 500，而这里该给的是明确的 422。
        if (! $base->systemBinding instanceof SystemKnowledgeBase) {
            throw new ApiException('system_knowledge_not_bound', '该知识库不是系统知识库，无法采纳官方版本', 422);
        }

        return IdempotencyService::executeJson(
            $request,
            'POST /knowledge-bases/{knowledgeBase}/official/adopt',
            function () use ($request, $admin, $base, $knowledgeBase, $system, $qualityInvalidation): JsonResponse {
                $definition = $system->definition((string) $base->systemBinding?->system_key);
                // 先算「内容是否真的变了」：它决定要不要作废既有的 AI 质检结论。
                $contentChanged = ! hash_equals(
                    hash('sha256', (string) $base->content),
                    (string) $definition['content_hash'],
                );

                try {
                    $revision = $system->adoptOfficial($base, $admin);
                } catch (\RuntimeException $exception) {
                    throw new ApiException('system_knowledge_not_bound', '该知识库不是系统知识库，无法采纳官方版本', 422, ['reason' => $exception->getMessage()]);
                }

                // 正文变了就必须作废旧质检结论——否则文章会带着按旧官方内容得出的结论继续流转。
                if ($contentChanged) {
                    $qualityInvalidation->invalidateKnowledgeBase($knowledgeBase, '系统知识已采用当前官方版本');
                }

                $this->log($request, 'system_knowledge.official_adopted', $knowledgeBase, [
                    'revision_id' => (int) $revision->getKey(),
                    'content_changed' => $contentChanged,
                ]);

                return $this->success($request, [
                    'knowledge_base_id' => $knowledgeBase,
                    'revision_id' => (int) $revision->getKey(),
                    'content_changed' => $contentChanged,
                ]);
            },
        );
    }

    private function mediaPayload(Request $request, bool $requiresImage, ?KnowledgeMediaAsset $defaults = null): array
    {
        $payload = $request->validate([
            'image' => [$requiresImage ? 'required' : 'nullable', 'file', 'max:8192', 'mimetypes:image/png,image/webp'],
            'asset_key' => [$defaults || ! $requiresImage ? 'nullable' : 'required', 'string', 'max:120', 'regex:/\A[a-z0-9._-]+\z/'],
            'section_key' => [$defaults ? 'nullable' : 'required', 'string', 'max:160'],
            'tab_path' => [$defaults ? 'nullable' : 'required', 'string', 'max:180'],
            'title' => [$defaults ? 'nullable' : 'required', 'string', 'max:180'],
            'alt_text' => [$defaults ? 'nullable' : 'required', 'string', 'max:500'],
            'caption' => ['nullable', 'string', 'max:1000'],
            'keywords' => ['nullable', 'string', 'max:1000'],
            'sort_order' => ['nullable', 'integer', 'min:0', 'max:10000'],
            'locale' => ['nullable', 'in:zh_CN'],
            'needs_review' => ['nullable', 'boolean'],
        ]);
        if ($defaults instanceof KnowledgeMediaAsset) {
            foreach (['asset_key', 'section_key', 'tab_path', 'title', 'alt_text', 'caption', 'sort_order', 'locale'] as $field) {
                if (! array_key_exists($field, $payload) || trim((string) $payload[$field]) === '') {
                    $payload[$field] = $defaults->{$field};
                }
            }
            $payload['keywords'] ??= implode(', ', (array) $defaults->keywords_json);
            $payload['needs_review'] ??= (bool) $defaults->needs_review;
        }

        return $payload;
    }

    private function writableAdmin(Request $request): Admin
    {
        $admin = $this->executionAdmin($request);
        if (! $admin->canManageProtectedWorkflows()) {
            // Ordinary administrators can edit regular knowledge bases, while
            // SystemKnowledgeMediaManager/SystemKnowledgeBaseManager enforce
            // their stricter protected-workflow boundary for system assets.
            return $admin;
        }

        return $admin;
    }

    /** @return array<string,mixed> */
    private function serializeRevision(KnowledgeBaseRevision $revision, bool $includeContent): array
    {
        return [
            'id' => (int) $revision->id,
            'knowledge_base_id' => (int) $revision->knowledge_base_id,
            'revision_number' => (int) $revision->revision_number,
            'content_hash' => (string) $revision->content_hash,
            'source' => (string) $revision->source,
            'created_by_admin_id' => $revision->created_by_admin_id === null ? null : (int) $revision->created_by_admin_id,
            'creator_username' => $revision->creator?->username,
            'restored_from_revision_id' => $revision->restored_from_revision_id === null ? null : (int) $revision->restored_from_revision_id,
            'created_at' => $revision->created_at?->toIso8601String(),
            ...($includeContent ? ['content' => (string) $revision->content] : []),
        ];
    }

    /** @return array<string,mixed> */
    private function serializeMedia(KnowledgeMediaAsset $asset): array
    {
        return [
            'id' => (int) $asset->id,
            'knowledge_base_id' => (int) $asset->knowledge_base_id,
            'asset_key' => (string) $asset->asset_key,
            'asset_version' => (int) $asset->asset_version,
            'supersedes_id' => $asset->supersedes_id === null ? null : (int) $asset->supersedes_id,
            'section_key' => (string) $asset->section_key,
            'tab_path' => (string) $asset->tab_path,
            'title' => (string) $asset->title,
            'alt_text' => (string) $asset->alt_text,
            'caption' => (string) ($asset->caption ?? ''),
            'keywords' => (array) ($asset->keywords_json ?? []),
            'mime_type' => (string) $asset->mime_type,
            'width' => (int) $asset->width,
            'height' => (int) $asset->height,
            'content_hash' => (string) $asset->content_hash,
            'locale' => (string) $asset->locale,
            'sort_order' => (int) $asset->sort_order,
            'is_active' => (bool) $asset->is_active,
            'needs_review' => (bool) $asset->needs_review,
            'created_at' => $asset->created_at?->toIso8601String(),
            'updated_at' => $asset->updated_at?->toIso8601String(),
        ];
    }

    /**
     * 系统知识库的改动（媒体、切片重建…）需要受保护工作流权限。
     *
     * `SystemKnowledgeMediaManager::authorize()` 里也有这道门禁，但它抛的是
     * `RuntimeException`，会被各处的 catch 统一映射成 **422「操作失败」**——
     * 越权就被报成「参数不对」。旧后台给的是 403，这里按本文件既有形状补回来
     * （与 {@see self::adoptOfficial()}、`KnowledgeFactApiController` 一致）。
     */
    private function assertProtectedKnowledgeWritable(KnowledgeBase $base, Admin $admin): void
    {
        if ($base->isSystemManaged() && ! $admin->canManageProtectedWorkflows()) {
            throw new ApiException('protected_knowledge_read_only', '系统知识库需要受保护工作流权限才能修改', 403);
        }
    }

    /** @param array<string,mixed> $details */
    private function log(Request $request, string $action, int $targetId, array $details = []): void
    {
        $admin = $this->executionAdmin($request);
        AdminActivityLogger::logFromRequest($request, $admin, $action, array_merge([
            'target_type' => 'knowledge_base',
            'target_id' => $targetId,
        ], $details));
    }
}
