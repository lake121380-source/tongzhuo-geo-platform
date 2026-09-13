<?php

namespace App\Http\Controllers\Api\V1;

use App\Data\Ai\KnowledgeQueryEmbeddingResult;
use App\Exceptions\ApiException;
use App\Models\KnowledgeBase;
use App\Services\GeoFlow\KnowledgeRetrievalService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Schema;

/**
 * Authenticated, read-only knowledge retrieval for API clients.
 *
 * GET is deliberately lexical-only by default.  Remote embedding calls are
 * opt-in through `allow_remote_embedding=true`, because a semantic probe sends
 * the query to an external provider and consumes the configured AI quota.
 */
class KnowledgeSearchController extends BaseApiController
{
    private const DEFAULT_LIMIT = 8;

    private const MAX_LIMIT = 20;

    private const DEFAULT_MAX_CHARS = 6000;

    private const MIN_MAX_CHARS = 256;

    private const MAX_MAX_CHARS = 20000;

    private const MAX_ITEM_CHARS = 4000;

    private const MAX_QUERY_CHARS = 1000;

    private const MAX_GENERATION_CHARS = 64;

    public function show(
        Request $request,
        int $knowledgeBase,
        KnowledgeRetrievalService $retrieval,
    ): JsonResponse {
        $rawQuery = $request->query('query', '');
        $query = is_string($rawQuery) ? trim($rawQuery) : '';
        if ($query === '') {
            throw new ApiException('validation_failed', '参数校验失败', 422, [
                'field_errors' => ['query' => '检索问题不能为空'],
            ]);
        }
        if (mb_strlen($query, 'UTF-8') > self::MAX_QUERY_CHARS) {
            throw new ApiException('validation_failed', '参数校验失败', 422, [
                'field_errors' => ['query' => '检索问题不能超过 '.self::MAX_QUERY_CHARS.' 个字符'],
            ]);
        }

        $knowledge = $this->findKnowledgeBase($knowledgeBase);
        if (! $knowledge instanceof KnowledgeBase) {
            throw new ApiException('knowledge_base_not_found', '知识库不存在', 404);
        }

        $limit = $this->boundedIntegerQuery(
            $request,
            'limit',
            self::DEFAULT_LIMIT,
            1,
            self::MAX_LIMIT,
            clamp: true,
        );
        $maxChars = $this->boundedIntegerQuery(
            $request,
            'max_chars',
            self::DEFAULT_MAX_CHARS,
            self::MIN_MAX_CHARS,
            self::MAX_MAX_CHARS,
            clamp: false,
        );
        $expectedGeneration = $this->expectedGeneration($request);
        $servingGeneration = trim((string) ($knowledge->chunk_serving_generation ?? ''));
        if ($expectedGeneration !== null && ! hash_equals($servingGeneration, $expectedGeneration)) {
            throw new ApiException('knowledge_generation_conflict', '知识库切片代次已变化，请刷新后重试', 409, [
                'expected_generation' => $expectedGeneration,
                'serving_generation' => $servingGeneration !== '' ? $servingGeneration : null,
            ]);
        }

        $allowRemoteEmbedding = $this->booleanQuery($request, 'allow_remote_embedding', false);
        $identity = $allowRemoteEmbedding ? $this->executionAdmin($request) : null;
        $evidence = $retrieval->retrieveEvidence(
            knowledgeBaseId: $knowledgeBase,
            query: $query,
            candidateLimit: $limit,
            allowRemoteEmbedding: $allowRemoteEmbedding,
            expectedServingGeneration: $expectedGeneration,
            identity: $identity,
            retrievalRequestId: $this->requestId($request),
        );

        // The serving generation can be atomically swapped while retrieval is
        // running.  The preflight check above protects the common case, while
        // this second check prevents returning evidence from the caller's
        // expected generation after such a swap has already completed.
        if ($expectedGeneration !== null) {
            $latestKnowledge = $this->findKnowledgeBase($knowledgeBase);
            $latestServingGeneration = trim((string) ($latestKnowledge?->chunk_serving_generation ?? ''));
            if (! $latestKnowledge instanceof KnowledgeBase
                || ! hash_equals($latestServingGeneration, $expectedGeneration)) {
                throw new ApiException('knowledge_generation_conflict', '知识库切片代次已变化，请刷新后重试', 409, [
                    'expected_generation' => $expectedGeneration,
                    'serving_generation' => $latestKnowledge instanceof KnowledgeBase && $latestServingGeneration !== ''
                        ? $latestServingGeneration
                        : null,
                ]);
            }
        }
        $retrievalMetadata = $this->retrievalMetadata($evidence);
        $items = [];
        $remainingChars = $maxChars;
        foreach ($evidence as $item) {
            $serialized = $this->serializeEvidence($item, $remainingChars);
            if ($serialized === null) {
                break;
            }
            $items[] = $serialized;
            $remainingChars -= mb_strlen((string) $serialized['content'], 'UTF-8');
            if ($remainingChars <= 0) {
                break;
            }
        }

        return $this->success($request, [
            'knowledge_base' => [
                'id' => (int) $knowledge->id,
                'name' => (string) $knowledge->name,
                'serving_generation' => $servingGeneration !== '' ? $servingGeneration : null,
                'serving_source_hash' => trim((string) ($knowledge->chunk_serving_source_hash ?? '')) ?: null,
                'chunk_sync_status' => (string) ($knowledge->chunk_sync_status ?? 'idle'),
            ],
            'query' => $query,
            'limit' => $limit,
            'max_chars' => $maxChars,
            'allow_remote_embedding' => $allowRemoteEmbedding,
            'retrieval' => $retrievalMetadata,
            'items' => $items,
        ]);
    }

    /**
     * @param  array<string,mixed>  $item
     * @return array<string,mixed>|null
     */
    private function serializeEvidence(array $item, int $remainingChars): ?array
    {
        $content = trim((string) ($item['content'] ?? ''));
        if ($content === '' || $remainingChars <= 0) {
            return null;
        }
        $content = mb_substr(
            $content,
            0,
            min(self::MAX_ITEM_CHARS, $remainingChars),
            'UTF-8',
        );
        if ($content === '') {
            return null;
        }

        $metadata = is_array($item['metadata'] ?? null) ? $item['metadata'] : [];

        return [
            'chunk_id' => (int) ($item['chunk_id'] ?? 0),
            'chunk_index' => (int) ($item['chunk_index'] ?? 0),
            'generation_key' => (string) ($item['generation_key'] ?? ''),
            'title' => (string) ($item['chunk_title'] ?? ''),
            'section_path' => (string) ($item['section_path'] ?? ''),
            'content' => $content,
            'content_truncated' => mb_strlen($content, 'UTF-8') < mb_strlen(
                trim((string) ($item['content'] ?? '')),
                'UTF-8',
            ),
            'content_hash' => (string) ($item['content_hash'] ?? ''),
            'source_hash' => (string) ($item['source_hash'] ?? ''),
            'score' => round((float) ($item['score'] ?? 0), 6),
            'vector_score' => round((float) ($item['vector_score'] ?? 0), 6),
            'keyword_score' => round((float) ($item['keyword_score'] ?? 0), 6),
            'source' => [
                'name' => (string) ($metadata['source_name'] ?? $metadata['knowledge_base_name'] ?? ''),
                'url' => (string) ($metadata['source_url'] ?? ''),
                'effective_date' => (string) ($metadata['effective_date'] ?? ''),
                'business_line' => (string) ($metadata['business_line'] ?? ''),
                'risk_level' => (string) ($metadata['risk_level'] ?? ''),
                'review_status' => (string) ($metadata['review_status'] ?? ''),
            ],
            'retrieval' => $this->normalizeRetrievalMetadata($item['retrieval_meta'] ?? null),
        ];
    }

    /** @param array<string,mixed> $evidence @return array<string,mixed> */
    private function retrievalMetadata(array $evidence): array
    {
        foreach ($evidence as $item) {
            if (is_array($item['retrieval_meta'] ?? null)) {
                return $this->normalizeRetrievalMetadata($item['retrieval_meta']);
            }
        }

        return KnowledgeQueryEmbeddingResult::incompatible('no_evidence')->safeMetadata();
    }

    /** @param mixed $metadata @return array<string,mixed> */
    private function normalizeRetrievalMetadata(mixed $metadata): array
    {
        $metadata = is_array($metadata) ? $metadata : [];

        return [
            'embedding_mode' => (string) ($metadata['embedding_mode'] ?? $metadata['mode'] ?? 'keyword_fallback'),
            'embedding_model_id' => isset($metadata['embedding_model_id'])
                ? (int) $metadata['embedding_model_id']
                : null,
            'embedding_model_source' => isset($metadata['embedding_model_source'])
                ? (string) $metadata['embedding_model_source']
                : null,
            'error_code' => isset($metadata['error_code']) ? (string) $metadata['error_code'] : null,
            'reason' => isset($metadata['reason']) ? (string) $metadata['reason'] : null,
        ];
    }

    private function expectedGeneration(Request $request): ?string
    {
        if (! $request->has('expected_generation')) {
            return null;
        }

        $raw = $request->query('expected_generation');
        $value = is_string($raw) ? trim($raw) : '';
        if ($value === '' || mb_strlen($value, 'UTF-8') > self::MAX_GENERATION_CHARS) {
            throw new ApiException('validation_failed', '参数校验失败', 422, [
                'field_errors' => ['expected_generation' => 'expected_generation 必须是 1-'.self::MAX_GENERATION_CHARS.' 个字符'],
            ]);
        }

        return $value;
    }

    private function findKnowledgeBase(int $id): ?KnowledgeBase
    {
        $columns = ['id', 'name'];
        foreach ([
            'chunk_serving_generation',
            'chunk_serving_source_hash',
            'chunk_sync_status',
        ] as $column) {
            if (Schema::hasColumn('knowledge_bases', $column)) {
                $columns[] = $column;
            }
        }

        /** @var KnowledgeBase|null $knowledge */
        $knowledge = KnowledgeBase::query()->find($id, $columns);

        return $knowledge;
    }

    private function booleanQuery(Request $request, string $key, bool $default): bool
    {
        if (! $request->has($key)) {
            return $default;
        }

        $raw = $request->query($key);
        if (is_bool($raw)) {
            return $raw;
        }
        if (is_string($raw)) {
            $normalized = strtolower(trim($raw));
            if (in_array($normalized, ['1', 'true', 'yes', 'on'], true)) {
                return true;
            }
            if (in_array($normalized, ['0', 'false', 'no', 'off'], true)) {
                return false;
            }
        }

        throw new ApiException('validation_failed', '参数校验失败', 422, [
            'field_errors' => [$key => $key.' 必须是 true 或 false'],
        ]);
    }

    private function boundedIntegerQuery(
        Request $request,
        string $key,
        int $default,
        int $minimum,
        int $maximum,
        bool $clamp,
    ): int {
        if (! $request->has($key)) {
            return $default;
        }

        $raw = $request->query($key);
        $value = is_string($raw) && filter_var($raw, FILTER_VALIDATE_INT) !== false
            ? (int) $raw
            : (is_int($raw) ? $raw : null);
        if ($value === null) {
            throw new ApiException('validation_failed', '参数校验失败', 422, [
                'field_errors' => [$key => $key.' 必须是整数'],
            ]);
        }
        if ($clamp) {
            return max($minimum, min($maximum, $value));
        }
        if ($value < $minimum || $value > $maximum) {
            throw new ApiException('validation_failed', '参数校验失败', 422, [
                'field_errors' => [$key => $key.' 必须在 '.$minimum.'-'.$maximum.' 之间'],
            ]);
        }

        return $value;
    }
}
