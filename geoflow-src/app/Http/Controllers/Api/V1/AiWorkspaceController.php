<?php

namespace App\Http\Controllers\Api\V1;

use App\Exceptions\ApiException;
use App\Models\Admin;
use App\Models\AiConversation;
use App\Models\AiConversationMessage;
use App\Models\KnowledgeMediaAsset;
use App\Services\AiWorkspace\AdminHelpAnswerStream;
use App\Services\AiWorkspace\AdminHelpFeatureRegistry;
use App\Services\AiWorkspace\AdminHelpKnowledgeCatalog;
use App\Services\AiWorkspace\AiConversationRepository;
use App\Services\AiWorkspace\AiWorkspaceModelReadiness;
use App\Services\AiWorkspace\SystemKnowledgeMediaManager;
use App\Services\Api\IdempotencyService;
use App\Support\AdminActivityLogger;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\Validator;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Bearer-authenticated projection of 桐灼GEO's native AI workspace.
 *
 * Conversation persistence, ownership, retrieval, model execution and the
 * generation lease remain owned by the existing workspace services. This
 * controller only adapts them to the API v1 envelope used by the React admin.
 */
final class AiWorkspaceController extends BaseApiController
{
    public function __construct(
        private readonly AiConversationRepository $conversations,
        private readonly AdminHelpAnswerStream $answers,
        private readonly AdminHelpKnowledgeCatalog $catalog,
        private readonly AiWorkspaceModelReadiness $readiness,
    ) {}

    public function status(Request $request): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $runtimeEnabled = (bool) config('ai-workspace.runtime_enabled', false);
        $modelStatus = $this->readiness->status($admin);

        return $this->success($request, [
            'runtime_enabled' => $runtimeEnabled,
            'ready' => $runtimeEnabled && (bool) $modelStatus['ready'],
            'reason' => $runtimeEnabled ? $modelStatus['reason'] : 'AI 工作台运行时尚未启用',
            'model_id' => $modelStatus['model_id'],
            'starter_actions' => $this->catalog->starterActions($admin),
        ]);
    }

    public function conversations(Request $request): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $items = $this->conversations->listForAdmin($admin)->map(
            fn (AiConversation $conversation): array => $this->conversationSummary($conversation)
        )->all();

        return $this->success($request, ['items' => $items]);
    }

    public function storeConversation(Request $request): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        $payload = $this->validated($request, ['title' => ['nullable', 'string', 'max:80']]);

        return IdempotencyService::executeJson($request, 'POST /ai-workspace/conversations', function () use ($request, $admin, $payload): JsonResponse {
            $conversation = $this->conversations->create($admin, isset($payload['title']) ? (string) $payload['title'] : null);
            $this->audit($request, $admin, 'api.ai_workspace.conversation.create', (string) $conversation->id);

            return $this->success($request, ['conversation' => $this->conversationSummary($conversation)], 201);
        });
    }

    public function showConversation(Request $request, string $conversation): JsonResponse
    {
        $admin = $this->executionAdmin($request);
        $model = $this->findConversation($admin, $conversation);
        $pageSize = 100;
        $messageQuery = AiConversationMessage::query()->where('conversation_id', $model->id);
        $before = trim((string) $request->query('before', ''));
        if ($before !== '') {
            if (mb_strlen($before) > 36) {
                throw new ApiException('workspace_cursor_invalid', '会话历史游标无效', 422);
            }
            $cursor = AiConversationMessage::query()
                ->where('conversation_id', $model->id)
                ->whereKey($before)
                ->first();
            if (! $cursor instanceof AiConversationMessage) {
                throw new ApiException('workspace_cursor_not_found', '会话历史游标不存在', 404);
            }
            $messageQuery->where(function ($query) use ($cursor): void {
                $query->where('created_at', '<', $cursor->created_at)
                    ->orWhere(function ($query) use ($cursor): void {
                        $query->where('created_at', $cursor->created_at)->where('id', '<', $cursor->id);
                    });
            });
        }

        $messagePage = $messageQuery
            ->select(['id', 'conversation_id', 'role', 'content', 'meta', 'created_at'])
            ->latest('created_at')
            ->latest('id')
            ->limit($pageSize + 1)
            ->get();
        $hasMoreMessages = $messagePage->count() > $pageSize;
        $messagePage = $messagePage->take($pageSize);

        return $this->success($request, [
            'conversation' => [
                ...$this->conversationSummary($model),
                'messages' => $messagePage->reverse()->values()->map(
                    fn (AiConversationMessage $message): array => $this->messageProjection($message)
                )->all(),
                'message_page' => [
                    'has_more' => $hasMoreMessages,
                    'next_cursor' => $hasMoreMessages ? (string) $messagePage->last()?->id : null,
                ],
            ],
        ]);
    }

    public function archiveConversation(Request $request, string $conversation): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);

        return IdempotencyService::executeJson($request, 'POST /ai-workspace/conversations/{id}/archive', function () use ($request, $admin, $conversation): JsonResponse {
            try {
                $model = $this->conversations->archive($admin, $conversation);
            } catch (ModelNotFoundException) {
                throw new ApiException('workspace_conversation_not_found', '会话不存在', 404);
            }
            $this->audit($request, $admin, 'api.ai_workspace.conversation.archive', (string) $model->id);

            return $this->success($request, ['id' => (string) $model->id, 'archived' => true]);
        });
    }

    public function renameConversation(Request $request, string $conversation): JsonResponse
    {
        $this->requireIdempotencyKey($request);
        $admin = $this->executionAdmin($request);
        $payload = $this->validated($request, ['title' => ['required', 'string', 'max:120']]);

        return IdempotencyService::executeJson($request, 'PATCH /ai-workspace/conversations/{id}', function () use ($request, $admin, $conversation, $payload): JsonResponse {
            try {
                $model = $this->conversations->rename($admin, $conversation, (string) $payload['title']);
            } catch (ModelNotFoundException) {
                throw new ApiException('workspace_conversation_not_found', '会话不存在', 404);
            }
            $this->audit($request, $admin, 'api.ai_workspace.conversation.rename', (string) $model->id);

            return $this->success($request, ['conversation' => $this->conversationSummary($model)]);
        });
    }

    public function sendMessage(Request $request, string $conversation): StreamedResponse
    {
        $admin = $this->executionAdmin($request);
        $payload = $this->validated($request, ['prompt' => ['required', 'string', 'max:4000']]);
        $model = $this->findConversation($admin, $conversation);
        $this->audit($request, $admin, 'api.ai_workspace.message.ask', (string) $model->id, [
            'prompt_length' => mb_strlen((string) $payload['prompt']),
        ]);

        return $this->answers->respond($admin, $model, (string) $payload['prompt']);
    }

    public function media(
        Request $request,
        int $mediaAsset,
        AdminHelpFeatureRegistry $features,
        SystemKnowledgeMediaManager $media,
    ): BinaryFileResponse|Response {
        $admin = $this->executionAdmin($request);
        $asset = KnowledgeMediaAsset::query()->find($mediaAsset);
        if (! $asset instanceof KnowledgeMediaAsset) {
            throw new ApiException('workspace_media_not_found', '知识图片不存在', 404);
        }
        $asset->loadMissing('knowledgeBase.systemBinding');
        if ($asset->knowledgeBase?->isSystemManaged() !== true
            || ! $features->canAccessPath($admin, (string) $asset->tab_path)) {
            throw new ApiException('workspace_media_not_found', '知识图片不存在', 404);
        }
        $thumbnail = $request->query('variant') === 'thumbnail';
        $file = $media->readableFile($asset, $thumbnail);
        if (! is_array($file)) {
            throw new ApiException('workspace_media_not_found', '知识图片不存在', 404);
        }

        $etag = '"'.(string) $file['content_hash'].'"';
        $headers = $this->mediaHeaders((string) $file['mime_type'], $etag);
        if ($request->headers->get('If-None-Match') === $etag) {
            return response('', 304, $headers);
        }

        $path = Storage::disk('local')->path((string) $file['path']);
        $extension = $file['mime_type'] === 'image/webp' ? 'webp' : 'png';

        return response()->file($path, $headers + [
            'Content-Disposition' => 'inline; filename="'.$asset->asset_key.'-v'.$asset->asset_version.($thumbnail ? '-thumbnail' : '').'.'.$extension.'"',
        ]);
    }

    private function findConversation(Admin $admin, string $id): AiConversation
    {
        try {
            return $this->conversations->findForAdmin($admin, $id);
        } catch (ModelNotFoundException) {
            throw new ApiException('workspace_conversation_not_found', '会话不存在', 404);
        }
    }

    /** @return array<string, mixed> */
    private function conversationSummary(AiConversation $conversation): array
    {
        return [
            'id' => (string) $conversation->id,
            'title' => (string) $conversation->title,
            'updated_at' => $conversation->updated_at?->toISOString(),
        ];
    }

    /** @return array<string, mixed> */
    private function messageProjection(AiConversationMessage $message): array
    {
        return [
            'id' => (string) $message->id,
            'role' => (string) $message->role,
            'content' => (string) $message->content,
            'meta' => $message->meta ?? [],
            'created_at' => $message->created_at?->toISOString(),
        ];
    }

    /** @param array<string, list<string>> $rules @return array<string, mixed> */
    private function validated(Request $request, array $rules): array
    {
        $validator = Validator::make($request->all(), $rules);
        if ($validator->fails()) {
            throw new ApiException('validation_failed', '提交内容无效', 422, [
                'field_errors' => $validator->errors()->toArray(),
            ]);
        }

        return $validator->validated();
    }

    private function requireIdempotencyKey(Request $request): void
    {
        if (trim((string) $request->header('X-Idempotency-Key')) === '') {
            throw new ApiException('idempotency_key_required', '缺少 X-Idempotency-Key', 422);
        }
    }

    /** @param array<string, mixed> $details */
    private function audit(Request $request, Admin $admin, string $action, string $conversationId, array $details = []): void
    {
        AdminActivityLogger::log($admin, $action, [
            'request_method' => $request->method(),
            'page' => 'api/v1/ai-workspace',
            'target_type' => 'ai_conversation',
            'target_id' => null,
            'ip_address' => (string) ($request->ip() ?? ''),
            'details' => ['conversation_id' => $conversationId, ...$details],
        ]);
    }

    /** @return array<string, string> */
    private function mediaHeaders(string $mimeType, string $etag): array
    {
        return [
            'Content-Type' => $mimeType,
            'Cache-Control' => 'private, max-age=86400, immutable',
            'ETag' => $etag,
            'X-Content-Type-Options' => 'nosniff',
            'Cross-Origin-Resource-Policy' => 'same-origin',
            'Content-Security-Policy' => "default-src 'none'; sandbox",
        ];
    }
}
