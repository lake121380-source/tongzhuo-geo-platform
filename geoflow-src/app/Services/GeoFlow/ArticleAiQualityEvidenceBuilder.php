<?php

namespace App\Services\GeoFlow;

class ArticleAiQualityEvidenceBuilder
{
    public function __construct(
        private readonly KnowledgeRetrievalService $knowledgeRetrievalService,
        private readonly KnowledgeEvidenceSecurityInspector $securityInspector = new KnowledgeEvidenceSecurityInspector,
    ) {}

    /**
     * @param  list<int>  $knowledgeBaseIds
     * @param  array<string, mixed>  $articleSnapshot
     * @param  list<array<string, mixed>>  $factCandidates
     * @param  list<array<string,mixed>>  $generationEvidenceSnapshot
     * @return array{evidence:list<array<string,mixed>>,fact_candidates:list<array<string,mixed>>,knowledge_coverage:string,generation_evidence_reused_count:int}
     */
    public function build(
        array $knowledgeBaseIds,
        array $articleSnapshot,
        array $factCandidates,
        int $maxEvidence = 12,
        int $maxCharacters = 6000,
        int $maxFactRetrievals = 6,
        array $generationEvidenceSnapshot = [],
        array $servingGenerations = [],
    ): array {
        $genericQuery = trim(implode("\n", array_filter([
            (string) ($articleSnapshot['title'] ?? ''),
            (string) ($articleSnapshot['excerpt'] ?? ''),
            mb_substr((string) ($articleSnapshot['content'] ?? ''), 0, 8000, 'UTF-8'),
        ])));

        $generationEvidence = $this->knowledgeRetrievalService->validateEvidenceSnapshot(
            $generationEvidenceSnapshot,
            $knowledgeBaseIds,
            $servingGenerations,
        );
        $sourceKnowledgeBaseIds = collect($generationEvidence)
            ->pluck('knowledge_base_id')
            ->map(static fn (mixed $id): int => (int) $id)
            ->filter()
            ->unique()
            ->values()
            ->all();
        $evidenceByKey = [];
        foreach ($generationEvidence as $row) {
            $content = trim((string) ($row['content'] ?? ''));
            if ($content === '') {
                continue;
            }
            $knowledgeBaseId = (int) ($row['knowledge_base_id'] ?? 0);
            $contentHash = (string) ($row['content_hash'] ?? hash('sha256', $content));
            $key = $this->stableEvidenceKey($row, $knowledgeBaseId, $contentHash);
            $evidenceByKey[$key] = $this->boundedEvidence($row, $knowledgeBaseId, $contentHash, $key);
        }
        $generationEvidenceKeys = array_fill_keys(array_keys($evidenceByKey), true);
        $factEvidenceKeys = [];
        $attemptedFactIds = [];

        // 先让生成期证据与事实配对，再决定要不要补一次广域检索。
        $this->mapMatchingEvidence($factCandidates, $evidenceByKey, $factEvidenceKeys);

        /*
         * 广域检索（一次覆盖整个知识库）**不能只在"生成时没留证据"时才做**。
         *
         * 2026-09-14 实测（文章 22 / 检查 18）：该文生成时留了 3 条证据，于是这里被跳过，
         * 只剩"逐事实检索"（上限 6 次）；而它有 19 条 high/medium 事实 → 11 条从未被检索过
         * （`retrieval_status=budget_exceeded`）→ `coverage_status=insufficient`
         * → 聚合出 `knowledge_coverage=insufficient` → scorer 判 needs_review
         * → 门禁要求人工放行，**与文章质量、分数都无关**。
         *
         * 生成时留下的证据只有寥寥几条时，恰恰是最需要广域检索兜底的时候。
         */
        $needsBroadRetrieval = $generationEvidence === []
            || $this->materialFactsWithoutEvidence($factCandidates, $factEvidenceKeys) !== [];
        if ($needsBroadRetrieval && $genericQuery !== '') {
            $sourceKnowledgeBaseIds = array_values(array_unique(array_merge(
                $sourceKnowledgeBaseIds,
                array_map('intval', $knowledgeBaseIds),
            )));
            $rows = $this->knowledgeRetrievalService->retrieveEvidenceFromMany(
                $knowledgeBaseIds,
                $genericQuery,
                20,
                false,
                $servingGenerations,
            );
            $this->mergeEvidenceRows($evidenceByKey, $rows);
        }
        $this->mapMatchingEvidence($factCandidates, $evidenceByKey, $factEvidenceKeys);

        $factRetrievals = 0;
        foreach ($factCandidates as $candidate) {
            $factId = trim((string) ($candidate['id'] ?? ''));
            $query = trim((string) ($candidate['normalized_claim'] ?? $candidate['quote'] ?? ''));
            if ($factId === '' || $query === '' || ($factEvidenceKeys[$factId] ?? []) !== []) {
                continue;
            }
            if ($factRetrievals >= max(0, $maxFactRetrievals)) {
                continue;
            }

            $factRetrievals++;
            $attemptedFactIds[$factId] = true;
            $sourceKnowledgeBaseIds = array_values(array_unique(array_merge(
                $sourceKnowledgeBaseIds,
                array_map('intval', $knowledgeBaseIds),
            )));
            $rows = $this->knowledgeRetrievalService->retrieveEvidenceFromMany(
                $knowledgeBaseIds,
                $query,
                4,
                false,
                $servingGenerations,
            );
            $this->mergeEvidenceRows($evidenceByKey, $rows);
            $this->mapMatchingEvidence($factCandidates, $evidenceByKey, $factEvidenceKeys);
        }

        $evidence = [];
        $keyToReference = [];
        $characterCount = 0;
        $characterBudget = max(1000, $maxCharacters);
        $promptInjectionRiskCount = collect($evidenceByKey)
            ->filter(fn (array $row): bool => $this->securityInspector->hasPromptInjectionRisk($row))
            ->count();
        /*
         * 送进模型的证据是**有上限**的（条数 + 字符），而实质事实候选往往多于上限。
         * 按原顺序截断，等于把预算花在"先检索到的"切片上，而不是"能兜住最多实质事实"的切片上。
         *
         * 2026-09-14 实测：一篇**正文就是知识库原文**的文章拿到 100 分，却因为 11 条实质事实里
         * 有 2 条对应的切片被字符预算截掉，判出 `knowledge_coverage=insufficient` → 仍需人工放行。
         * 所以先按"覆盖多少条 high/medium 事实"降序排列，再截断（同权重的保持原顺序，PHP 排序稳定）。
         */
        $coverageWeight = [];
        foreach ($factCandidates as $candidate) {
            if (! in_array((string) ($candidate['materiality'] ?? ''), ['high', 'medium'], true)) {
                continue;
            }
            foreach (array_keys($factEvidenceKeys[(string) ($candidate['id'] ?? '')] ?? []) as $key) {
                $coverageWeight[$key] = (int) ($coverageWeight[$key] ?? 0) + 1;
            }
        }
        $orderedKeys = array_keys($evidenceByKey);
        usort(
            $orderedKeys,
            static fn (string $a, string $b): int => ($coverageWeight[$b] ?? 0) <=> ($coverageWeight[$a] ?? 0),
        );

        foreach ($orderedKeys as $key) {
            $row = $evidenceByKey[$key];
            if ($this->securityInspector->hasPromptInjectionRisk($row)) {
                continue;
            }
            if (count($evidence) >= max(1, $maxEvidence) || $characterCount >= $characterBudget) {
                break;
            }

            $row['content'] = mb_substr(
                (string) $row['content'],
                0,
                $characterBudget - $characterCount,
                'UTF-8',
            );
            $contentLength = mb_strlen((string) $row['content'], 'UTF-8');
            if ($contentLength === 0) {
                continue;
            }
            $row['id'] = 'K'.(count($evidence) + 1);
            $keyToReference[$key] = $row['id'];
            $evidence[] = $row;
            $characterCount += $contentLength;
        }

        $coveredFacts = [];
        foreach ($factCandidates as $candidate) {
            $factId = (string) ($candidate['id'] ?? '');
            $references = [];
            $hasReviewedEvidence = false;
            foreach (array_keys($factEvidenceKeys[$factId] ?? []) as $key) {
                if (! isset($keyToReference[$key])) {
                    continue;
                }

                $references[] = $keyToReference[$key];
                $reviewStatus = strtolower((string) ($evidenceByKey[$key]['metadata']['review_status'] ?? 'unreviewed'));
                $hasReviewedEvidence = $hasReviewedEvidence || in_array($reviewStatus, ['reviewed', 'approved', 'verified'], true);
            }

            $candidate['knowledge_refs'] = array_values(array_unique($references));
            $candidate['coverage_status'] = $hasReviewedEvidence
                ? 'sufficient'
                : ($references === [] ? 'insufficient' : 'partial');
            $candidate['retrieval_status'] = $references !== []
                ? 'evidence_found'
                : (isset($attemptedFactIds[$factId]) ? 'no_evidence' : 'budget_exceeded');
            $coveredFacts[] = $candidate;
        }

        return [
            'evidence' => $evidence,
            'fact_candidates' => $coveredFacts,
            'knowledge_coverage' => $this->aggregateCoverage($coveredFacts, $evidence !== [], $genericQuery !== ''),
            'generation_evidence_reused_count' => count(array_intersect_key($keyToReference, $generationEvidenceKeys)),
            'retrieval_meta' => [
                'prompt_injection_risk_count' => $promptInjectionRiskCount,
                'source_knowledge_base_ids' => ['chunk' => $sourceKnowledgeBaseIds],
            ],
        ];
    }

    /** @param array<string, mixed> $row */
    private function boundedEvidence(
        array $row,
        int $knowledgeBaseId,
        string $contentHash,
        string $stableKey,
    ): array {
        $metadata = is_array($row['metadata'] ?? null) ? $row['metadata'] : [];

        return [
            'knowledge_base_id' => $knowledgeBaseId,
            'chunk_id' => (int) ($row['chunk_id'] ?? 0),
            'chunk_index' => (int) ($row['chunk_index'] ?? 0),
            'stable_key' => $stableKey,
            'content' => mb_substr(trim((string) ($row['content'] ?? '')), 0, 4000, 'UTF-8'),
            'content_hash' => $contentHash,
            'source_hash' => (string) ($row['source_hash'] ?? ''),
            'chunk_title' => mb_substr(trim((string) ($row['chunk_title'] ?? '')), 0, 300, 'UTF-8'),
            'section_path' => mb_substr(trim((string) ($row['section_path'] ?? '')), 0, 500, 'UTF-8'),
            'metadata' => array_intersect_key($metadata, array_flip([
                'knowledge_base_id', 'knowledge_base_name', 'source_name', 'source_url', 'source_type',
                'business_line', 'effective_date', 'risk_level', 'review_status',
            ])),
        ];
    }

    /** @param array<string, mixed> $row */
    private function stableEvidenceKey(array $row, int $knowledgeBaseId, string $contentHash): string
    {
        $chunkId = (int) ($row['chunk_id'] ?? 0);
        if ($chunkId <= 0) {
            $chunkId = (int) ($row['chunk_index'] ?? 0);
        }

        return $knowledgeBaseId.':'.$chunkId.':'.$contentHash;
    }

    /** @param array<string,array<string,mixed>> $evidenceByKey @param list<array<string,mixed>> $rows */
    private function mergeEvidenceRows(array &$evidenceByKey, array $rows): void
    {
        foreach ($rows as $row) {
            $content = trim((string) ($row['content'] ?? ''));
            if ($content === '') {
                continue;
            }

            $knowledgeBaseId = (int) ($row['knowledge_base_id'] ?? ($row['metadata']['knowledge_base_id'] ?? 0));
            $contentHash = (string) ($row['content_hash'] ?? hash('sha256', $content));
            $key = $this->stableEvidenceKey($row, $knowledgeBaseId, $contentHash);
            $evidenceByKey[$key] ??= $this->boundedEvidence($row, $knowledgeBaseId, $contentHash, $key);
        }
    }

    /**
     * @param  list<array<string,mixed>>  $factCandidates
     * @param  array<string,array<string,mixed>>  $evidenceByKey
     * @param  array<string,array<string,bool>>  $factEvidenceKeys
     */
    /**
     * 还没找到任何证据的 high/medium 事实候选（只关心实质事实：low 不参与覆盖度判定）。
     *
     * @param  list<array<string,mixed>>  $factCandidates
     * @param  array<string,array<string,bool>>  $factEvidenceKeys
     * @return list<string>
     */
    private function materialFactsWithoutEvidence(array $factCandidates, array $factEvidenceKeys): array
    {
        $factIds = [];
        foreach ($factCandidates as $candidate) {
            $factId = trim((string) ($candidate['id'] ?? ''));
            if ($factId === '' || ($factEvidenceKeys[$factId] ?? []) !== []) {
                continue;
            }
            if (! in_array((string) ($candidate['materiality'] ?? ''), ['high', 'medium'], true)) {
                continue;
            }
            $factIds[] = $factId;
        }

        return $factIds;
    }

    private function mapMatchingEvidence(array $factCandidates, array $evidenceByKey, array &$factEvidenceKeys): void
    {
        foreach ($factCandidates as $candidate) {
            $factId = trim((string) ($candidate['id'] ?? ''));
            if ($factId === '') {
                continue;
            }
            foreach ($evidenceByKey as $key => $evidence) {
                if ($this->evidenceMatchesClaim($candidate, (string) ($evidence['content'] ?? ''))) {
                    $factEvidenceKeys[$factId][$key] = true;
                }
            }
        }
    }

    /** @param array<string,mixed> $candidate */
    private function evidenceMatchesClaim(array $candidate, string $evidence): bool
    {
        $claim = $this->normalizeForMatching((string) ($candidate['normalized_claim'] ?? $candidate['quote'] ?? ''));
        $evidence = $this->normalizeForMatching($evidence);
        if ($claim === '' || $evidence === '') {
            return false;
        }
        if (str_contains($evidence, $claim)) {
            return true;
        }

        preg_match_all('/\d+(?:[.,]\d+)?/u', $claim, $claimMatches);
        preg_match_all('/\d+(?:[.,]\d+)?/u', $evidence, $evidenceMatches);
        $claimNumbers = array_values(array_unique(array_map(
            static fn (string $value): string => str_replace(',', '', $value),
            $claimMatches[0] ?? [],
        )));
        $evidenceNumbers = array_values(array_unique(array_map(
            static fn (string $value): string => str_replace(',', '', $value),
            $evidenceMatches[0] ?? [],
        )));
        if ($claimNumbers !== [] && array_diff($claimNumbers, $evidenceNumbers) !== []) {
            return false;
        }

        $claimText = preg_replace('/\d+(?:[.,]\d+)?/u', '', $claim) ?? $claim;
        $evidenceText = preg_replace('/\d+(?:[.,]\d+)?/u', '', $evidence) ?? $evidence;
        $claimGrams = $this->bigrams($claimText);
        if ($claimGrams === []) {
            return $claimNumbers !== [];
        }

        $overlap = count(array_intersect($claimGrams, $this->bigrams($evidenceText))) / count($claimGrams);

        return $overlap >= ($claimNumbers === [] ? 0.45 : 0.2);
    }

    private function normalizeForMatching(string $value): string
    {
        $value = mb_strtolower(trim($value), 'UTF-8');

        return preg_replace('/[\s\p{P}\p{S}]+/u', '', $value) ?? $value;
    }

    /** @return list<string> */
    private function bigrams(string $value): array
    {
        $characters = mb_str_split($value, 1, 'UTF-8');
        if (count($characters) < 2) {
            return $characters;
        }

        $grams = [];
        for ($index = 0; $index < count($characters) - 1; $index++) {
            $grams[] = $characters[$index].$characters[$index + 1];
        }

        return array_values(array_unique($grams));
    }

    /** @param list<array<string, mixed>> $factCandidates */
    private function aggregateCoverage(array $factCandidates, bool $hasEvidence, bool $hasArticleContent): string
    {
        $material = array_values(array_filter(
            $factCandidates,
            static fn (array $candidate): bool => in_array((string) ($candidate['materiality'] ?? ''), ['high', 'medium'], true),
        ));
        if ($material === []) {
            return 'sufficient';
        }
        if ($hasArticleContent && ! $hasEvidence) {
            return 'insufficient';
        }

        $statuses = array_column($material, 'coverage_status');
        if (in_array('insufficient', $statuses, true)) {
            return 'insufficient';
        }

        return in_array('partial', $statuses, true) ? 'partial' : 'sufficient';
    }
}
