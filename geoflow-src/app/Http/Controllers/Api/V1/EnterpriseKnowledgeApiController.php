<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Jobs\GenerateEnterpriseKnowledgeDraftJob;
use App\Models\Admin;
use App\Models\EnterpriseKnowledgeProject;
use App\Models\EnterpriseKnowledgeRevision;
use App\Models\EnterpriseKnowledgeSource;
use App\Services\Api\IdempotencyService;
use App\Services\GeoFlow\EnterpriseKnowledgeAiExecutionGuard;
use App\Services\GeoFlow\EnterpriseKnowledgeDraftService;
use App\Services\GeoFlow\KnowledgeSourceParser;
use App\Support\AdminActivityLogger;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Lang;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\Rules\File;
use Illuminate\Validation\ValidationException;
use RuntimeException;
use Throwable;

/** JSON adapter for 桐灼GEO's enterprise-knowledge draft workflow. */
final class EnterpriseKnowledgeApiController extends BaseApiController
{
    private const MAX_CONTENT_BYTES = 8 * 1024 * 1024;

    public function index(Request $request): JsonResponse
    {
        $this->executionAdmin($request);
        $page = EnterpriseKnowledgeProject::query()
            ->with('publishedKnowledgeBase')
            ->withCount(['sources', 'revisions'])
            ->latest()
            ->paginate(min(50, max(1, $request->integer('per_page', 20))), ['*'], 'page', max(1, $request->integer('page', 1)));

        return $this->success($request, [
            'items' => $page->getCollection()->map(fn (EnterpriseKnowledgeProject $project): array => $this->serializeProject($project, false))->values()->all(),
            'pagination' => [
                'page' => $page->currentPage(),
                'per_page' => $page->perPage(),
                'total' => $page->total(),
                'total_pages' => $page->lastPage(),
            ],
        ]);
    }

    public function show(Request $request, int $project): JsonResponse
    {
        $this->executionAdmin($request);
        $row = EnterpriseKnowledgeProject::query()->with(['sources', 'revisions.creator', 'publishedKnowledgeBase'])->findOrFail($project);

        return $this->success($request, ['item' => $this->serializeProject($row, true)]);
    }

    public function status(Request $request, int $project): JsonResponse
    {
        $this->executionAdmin($request);
        $row = EnterpriseKnowledgeProject::query()->withCount(['sources', 'revisions'])->findOrFail($project);
        $status = (string) ($row->status ?: 'draft');
        $progress = $row->draftGenerationProgress();
        $fallbackProgress = match ($status) {
            'queued' => 8,
            'processing' => 45,
            'reviewing', 'published', 'failed' => 100,
            default => 0,
        };

        return $this->success($request, [
            'status' => $status,
            'status_label' => $this->translation('admin.enterprise_knowledge.status_'.$status, $status),
            'draft_ready' => trim((string) ($row->draft_content ?? '')) !== '',
            'reload' => in_array($status, ['reviewing', 'published', 'failed'], true),
            'error_message' => (string) ($row->error_message ?? ''),
            'sources_count' => (int) $row->sources_count,
            'revisions_count' => (int) $row->revisions_count,
            'progress' => [
                'step' => (string) ($progress['step'] ?? $status),
                'progress' => (int) ($progress['progress'] ?? $fallbackProgress),
                'message' => (string) ($progress['message'] ?? $this->translation('admin.enterprise_knowledge.progress_message.'.$status, '处理中')),
                'updated_at' => (string) ($progress['updated_at'] ?? optional($row->updated_at)->toIso8601String()),
            ],
        ]);
    }

    /**
     * Upload an image used by the enterprise knowledge Markdown editor.
     *
     * The old Blade editor stores these assets under the project namespace and
     * returns a ready-to-paste Markdown reference. Keep that same durable
     * contract for the React editor; the image itself is never persisted in
     * the browser or in the demo Express store.
     */
    public function uploadEditorImage(Request $request, int $project): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        EnterpriseKnowledgeProject::query()->whereKey($project)->firstOrFail();

        $payload = $request->validate([
            'image' => [
                'required',
                File::image()->types(['jpg', 'jpeg', 'png', 'gif', 'webp'])->max(10 * 1024),
            ],
            'alt' => ['nullable', 'string', 'max:120'],
        ], [
            'image.required' => '必须上传图片',
            'image.image' => '上传文件不是有效图片',
            'image.max' => '图片不能超过 10 MB',
        ]);

        $file = $request->file('image');
        if (! $file instanceof UploadedFile) {
            throw new ApiException('validation_failed', '必须上传图片', 422);
        }

        $storedPath = null;

        try {
            return IdempotencyService::executeJson(
                $request,
                'POST /enterprise-knowledge/{id}/editor/images/upload',
                function () use ($request, $admin, $file, $project, $payload, &$storedPath): JsonResponse {
                    try {
                        $stored = $this->storeEditorImageFile($file, $project);
                        $storedPath = (string) ($stored['path'] ?? '');
                        $alt = $this->normalizeImageAlt((string) ($payload['alt'] ?? ''));
                        if ($alt === '') {
                            $alt = $this->readableImageAlt($file->getClientOriginalName());
                        }
                        $url = Storage::disk('public')->url($storedPath);

                        AdminActivityLogger::logFromRequest($request, $admin, 'enterprise_knowledge.editor_image_uploaded', [
                            'project_id' => $project,
                            'original_name' => $file->getClientOriginalName(),
                            'file_size' => $file->getSize(),
                        ]);

                        return $this->success($request, [
                            'project_id' => $project,
                            'image' => [
                                'url' => $url,
                                'storage_path' => $storedPath,
                                'file_path' => 'storage/'.$storedPath,
                                'original_name' => $file->getClientOriginalName(),
                                'alt' => $alt,
                                'markdown' => '!['.$this->escapeMarkdownAlt($alt).']('.$url.')',
                                'width' => (int) ($stored['width'] ?? 0),
                                'height' => (int) ($stored['height'] ?? 0),
                                'mime_type' => $file->getMimeType(),
                                'file_size' => $file->getSize(),
                            ],
                        ], 201);
                    } catch (Throwable $exception) {
                        if ($storedPath !== null && $storedPath !== '') {
                            Storage::disk('public')->delete($storedPath);
                            $storedPath = null;
                        }
                        throw $exception;
                    }
                },
            );
        } catch (Throwable $exception) {
            if ($storedPath !== null && $storedPath !== '') {
                Storage::disk('public')->delete($storedPath);
            }
            if ($exception instanceof ApiException || $exception instanceof ValidationException) {
                throw $exception;
            }
            report($exception);
            throw new ApiException('editor_image_upload_failed', '企业知识编辑器图片上传失败', 422);
        }
    }

    public function store(Request $request, EnterpriseKnowledgeDraftService $drafts, EnterpriseKnowledgeAiExecutionGuard $guard, KnowledgeSourceParser $parser): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $payload = $request->validate([
            'name' => ['nullable', 'string', 'max:120'],
            'description' => ['nullable', 'string', 'max:1000'],
            'content' => ['nullable', 'string'],
            'enterprise_files' => ['nullable', 'array', 'max:10'],
            'enterprise_files.*' => ['file', 'max:8192', 'mimes:txt,md,markdown,docx'],
        ]);
        $manual = $parser->normalizeKnowledgeText((string) ($payload['content'] ?? ''));
        $files = $parser->uploadedFilesFromFields($request, ['enterprise_files']);
        if ($manual === '' && $files === []) {
            throw new ApiException('validation_failed', '企业知识正文或文件不能为空', 422, ['field_errors' => ['content' => '请填写正文或上传文件']]);
        }
        $storedPaths = [];

        return IdempotencyService::executeJson($request, 'POST /enterprise-knowledge', function () use ($request, $admin, $drafts, $guard, $parser, $payload, $manual, $files, &$storedPaths): JsonResponse {
            try {
                $analysisModel = $drafts->assertAnalysisModelReady($admin);
                $parsed = $parser->parseUploadedKnowledgeFiles($files, $storedPaths, 'uploads/enterprise-knowledge');
                $merged = $parser->mergeKnowledgeSources($manual, $parsed);
                $name = trim((string) ($payload['name'] ?? '')) ?: ($parser->inferKnowledgeName($files) ?: $parser->inferKnowledgeNameFromContent($merged));
                if ($name === '') {
                    throw new ApiException('validation_failed', '企业知识项目名称不能为空', 422, ['field_errors' => ['name' => '请填写项目名称']]);
                }

                $project = DB::transaction(function () use ($admin, $guard, $analysisModel, $name, $payload, $manual, $parsed): EnterpriseKnowledgeProject {
                    $project = EnterpriseKnowledgeProject::query()->create(array_merge([
                        'name' => $name,
                        'description' => trim((string) ($payload['description'] ?? '')),
                        'status' => 'queued',
                        'structured_json' => json_encode(['draft_generation' => ['step' => 'queued', 'progress' => 8, 'updated_at' => now()->toIso8601String()]], JSON_UNESCAPED_UNICODE),
                        'created_by_admin_id' => (int) $admin->id,
                    ], $guard->snapshotForCreation($admin, $analysisModel)));
                    $sort = 0;
                    if ($manual !== '') {
                        EnterpriseKnowledgeSource::query()->create([
                            'enterprise_knowledge_project_id' => (int) $project->id,
                            'original_name' => '手动输入内容',
                            'file_type' => 'markdown',
                            'content' => $manual,
                            'character_count' => mb_strlen($manual, 'UTF-8'),
                            'sort_order' => $sort++,
                        ]);
                    }
                    foreach ($parsed as $file) {
                        $content = (string) ($file['content'] ?? '');
                        EnterpriseKnowledgeSource::query()->create([
                            'enterprise_knowledge_project_id' => (int) $project->id,
                            'original_name' => (string) ($file['original_name'] ?? ''),
                            'file_path' => (string) ($file['file_path'] ?? ''),
                            'file_type' => (string) ($file['file_type'] ?? 'text'),
                            'content' => $content,
                            'character_count' => mb_strlen($content, 'UTF-8'),
                            'sort_order' => $sort++,
                        ]);
                    }

                    return $project;
                });
                GenerateEnterpriseKnowledgeDraftJob::dispatch((int) $project->id)->onQueue('geoflow');
                AdminActivityLogger::logFromRequest($request, $admin, 'enterprise_knowledge.created', ['project_id' => (int) $project->id]);

                return $this->success($request, ['item' => $this->serializeProject($project->fresh(['sources']), true)], 201);
            } catch (Throwable $exception) {
                $parser->cleanupKnowledgeFiles($storedPaths);
                throw $exception;
            }
        });
    }

    public function autosave(Request $request, int $project, EnterpriseKnowledgeDraftService $drafts): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $row = EnterpriseKnowledgeProject::query()->findOrFail($project);
        $content = trim((string) $request->validate(['content' => ['required', 'string']])['content']);
        if (strlen($content) > self::MAX_CONTENT_BYTES) {
            throw new ApiException('content_too_large', '草稿正文超过 8 MB 限制', 422);
        }

        return IdempotencyService::executeJson($request, 'POST /enterprise-knowledge/{id}/autosave', function () use ($request, $row, $content, $drafts, $admin): JsonResponse {
            $items = $drafts->validateDraft($content);
            $row->update([
                'draft_content' => $content,
                'validation_json' => json_encode($items, JSON_UNESCAPED_UNICODE),
                'status' => $row->status === 'published' ? 'reviewing' : (string) $row->status,
            ]);
            $this->recordRevisionIfChanged($row, $content, 'manual', '手动自动保存', $admin);

            return $this->success($request, ['saved_at' => now()->toIso8601String(), 'validation_items' => $items, 'validation_count' => count($items)]);
        });
    }

    public function validateDraft(Request $request, int $project, EnterpriseKnowledgeDraftService $drafts): JsonResponse
    {
        $this->executionAdmin($request);
        $row = EnterpriseKnowledgeProject::query()->findOrFail($project);
        $content = trim((string) $request->input('content', $row->draft_content ?? ''));
        $items = $drafts->validateDraft($content);
        $row->update(['draft_content' => $content, 'validation_json' => json_encode($items, JSON_UNESCAPED_UNICODE)]);

        return $this->success($request, ['validation_items' => $items, 'validation_count' => count($items)]);
    }

    public function restoreRevision(Request $request, int $project, int $revision, EnterpriseKnowledgeDraftService $drafts): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $row = EnterpriseKnowledgeProject::query()->findOrFail($project);
        $revisionRow = EnterpriseKnowledgeRevision::query()->where('enterprise_knowledge_project_id', $project)->findOrFail($revision);

        return IdempotencyService::executeJson($request, 'POST /enterprise-knowledge/{id}/revisions/{revision}/restore', function () use ($request, $row, $revisionRow, $drafts, $admin): JsonResponse {
            $content = (string) $revisionRow->content;
            $row->update(['draft_content' => $content, 'validation_json' => json_encode($drafts->validateDraft($content), JSON_UNESCAPED_UNICODE), 'status' => 'reviewing']);
            $this->recordRevision($row, $content, 'restore', '恢复历史版本', $admin);

            return $this->success($request, ['item' => $this->serializeProject($row->fresh(['revisions.creator']), true)]);
        });
    }

    public function publish(Request $request, int $project, EnterpriseKnowledgeDraftService $drafts): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $row = EnterpriseKnowledgeProject::query()->findOrFail($project);
        $content = trim((string) ($row->draft_content ?? ''));
        if ($content === '') {
            throw new ApiException('content_required', '没有可发布的企业知识草稿', 422);
        }

        return IdempotencyService::executeJson($request, 'POST /enterprise-knowledge/{id}/publish', function () use ($request, $row, $content, $drafts, $admin): JsonResponse {
            $result = $drafts->publishToKnowledgeBase($row, $content);
            $row->update([
                'status' => 'published',
                'published_knowledge_base_id' => (int) $result['knowledge_base']->id,
                'validation_json' => json_encode($drafts->validateDraft($content), JSON_UNESCAPED_UNICODE),
                'error_message' => (string) ($result['chunk_error'] ?? ''),
            ]);
            $this->recordRevision($row, $content, 'publish', '发布企业知识草稿', $admin);

            return $this->success($request, ['item' => $this->serializeProject($row->fresh(['publishedKnowledgeBase', 'revisions.creator']), true), 'chunk_error' => (string) ($result['chunk_error'] ?? '')]);
        });
    }

    public function destroy(Request $request, int $project, KnowledgeSourceParser $parser): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $row = EnterpriseKnowledgeProject::query()->with('sources')->findOrFail($project);

        return IdempotencyService::executeJson($request, 'DELETE /enterprise-knowledge/{id}', function () use ($request, $row, $parser, $admin): JsonResponse {
            $parser->cleanupKnowledgeFiles($row->sources->pluck('file_path')->filter()->map(static fn ($path): string => (string) $path)->values()->all());
            Storage::disk('public')->deleteDirectory('uploads/enterprise-knowledge/'.(int) $row->id);
            $row->delete();
            AdminActivityLogger::logFromRequest($request, $admin, 'enterprise_knowledge.deleted', ['project_id' => (int) $row->id]);

            return $this->success($request, ['id' => (int) $row->id, 'deleted' => true]);
        });
    }

    /** @return array<string,mixed> */
    private function serializeProject(EnterpriseKnowledgeProject $row, bool $includeSources): array
    {
        return [
            'id' => (int) $row->id,
            'name' => (string) $row->name,
            'description' => (string) ($row->description ?? ''),
            'status' => (string) ($row->status ?? 'draft'),
            'draft_content' => $includeSources ? (string) ($row->draft_content ?? '') : null,
            'structured' => $row->structuredData(),
            'validation_items' => $row->validationItems(),
            'error_message' => (string) ($row->error_message ?? ''),
            'retryable_failure' => (bool) ($row->retryable_failure ?? false),
            'published_knowledge_base_id' => $row->published_knowledge_base_id === null ? null : (int) $row->published_knowledge_base_id,
            'sources_count' => isset($row->sources_count) ? (int) $row->sources_count : ($row->relationLoaded('sources') ? $row->sources->count() : null),
            'revisions_count' => isset($row->revisions_count) ? (int) $row->revisions_count : ($row->relationLoaded('revisions') ? $row->revisions->count() : null),
            'created_at' => $row->created_at?->toIso8601String(),
            'updated_at' => $row->updated_at?->toIso8601String(),
            ...($includeSources ? [
                'sources' => $row->relationLoaded('sources') ? $row->sources->map(fn (EnterpriseKnowledgeSource $source): array => [
                    'id' => (int) $source->id,
                    'original_name' => (string) $source->original_name,
                    'file_type' => (string) $source->file_type,
                    'character_count' => (int) $source->character_count,
                    'sort_order' => (int) $source->sort_order,
                ])->values()->all() : [],
                'revisions' => $row->relationLoaded('revisions') ? $row->revisions->map(fn (EnterpriseKnowledgeRevision $revision): array => [
                    'id' => (int) $revision->id,
                    'summary' => (string) ($revision->summary ?? ''),
                    'source' => (string) ($revision->source ?? ''),
                    'content_hash' => (string) $revision->content_hash,
                    'content' => (string) $revision->content,
                    'creator_username' => $revision->creator?->username,
                    'created_at' => $revision->created_at?->toIso8601String(),
                ])->values()->all() : [],
            ] : []),
        ];
    }

    private function recordRevisionIfChanged(EnterpriseKnowledgeProject $project, string $content, string $source, string $summary, Admin $admin): void
    {
        $hash = hash('sha256', $content);
        $latest = (string) $project->revisions()->latest()->value('content_hash');
        if ($latest !== $hash) {
            $this->recordRevision($project, $content, $source, $summary, $admin, $hash);
        }
    }

    private function recordRevision(EnterpriseKnowledgeProject $project, string $content, string $source, string $summary, Admin $admin, ?string $hash = null): void
    {
        EnterpriseKnowledgeRevision::query()->create([
            'enterprise_knowledge_project_id' => (int) $project->id,
            'content' => $content,
            'summary' => $summary,
            'source' => $source,
            'created_by_admin_id' => (int) $admin->id,
            'content_hash' => $hash ?? hash('sha256', $content),
        ]);
    }

    private function translation(string $key, string $fallback): string
    {
        return Lang::has($key) ? (string) __($key) : $fallback;
    }

    private function storeEditorImageFile(UploadedFile $file, int $projectId): array
    {
        if (! $file->isValid()) {
            throw new RuntimeException('上传文件无效');
        }

        $directory = 'uploads/enterprise-knowledge/'.$projectId.'/images/'.now()->format('Y/m');
        $extension = strtolower($file->guessExtension() ?: $file->getClientOriginalExtension() ?: 'jpg');
        $extension = $extension === 'jpeg' ? 'jpg' : $extension;
        if (! in_array($extension, ['jpg', 'png', 'gif', 'webp'], true)) {
            $extension = 'jpg';
        }

        $path = $file->storeAs($directory, bin2hex(random_bytes(16)).'.'.$extension, 'public');
        if (! is_string($path) || $path === '') {
            throw new RuntimeException('图片保存失败');
        }

        $size = @getimagesize($file->getRealPath());

        return [
            'path' => $path,
            'width' => is_array($size) ? (int) ($size[0] ?? 0) : 0,
            'height' => is_array($size) ? (int) ($size[1] ?? 0) : 0,
        ];
    }

    private function readableImageAlt(string $fileName): string
    {
        $name = pathinfo($fileName, PATHINFO_FILENAME);

        return $this->normalizeImageAlt(str_replace(['-', '_'], ' ', $name));
    }

    private function normalizeImageAlt(string $alt): string
    {
        $alt = trim((string) preg_replace('/\s+/u', ' ', $alt));

        return mb_substr($alt, 0, 120, 'UTF-8');
    }

    private function escapeMarkdownAlt(string $alt): string
    {
        return str_replace([']', "\n", "\r"], ['\\]', ' ', ' '], $alt);
    }
}
