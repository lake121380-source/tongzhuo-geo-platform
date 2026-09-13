<?php

namespace App\Services\GeoFlow;

class ArticleAiQualityScorer
{
    private const DIMENSION_MAXIMUMS = [
        'knowledge_consistency' => 35,
        'data_traceability' => 25,
        'advertising_compliance' => 30,
        'content_integrity' => 10,
    ];

    private const CODE_DIMENSIONS = [
        'knowledge_contradiction' => 'knowledge_consistency',
        'unsupported_claim' => 'knowledge_consistency',
        'data_mismatch' => 'data_traceability',
        'citation_missing' => 'data_traceability',
        'citation_scope_mismatch' => 'data_traceability',
        'ad_absolute_claim' => 'advertising_compliance',
        'ad_false_or_misleading' => 'advertising_compliance',
        'ad_industry_specific' => 'advertising_compliance',
        'ad_identifiability' => 'advertising_compliance',
        'content_integrity' => 'content_integrity',
    ];

    private const SEVERITY_DEDUCTIONS = [
        'critical' => 20,
        'high' => 12,
        'medium' => 6,
        'low' => 2,
    ];

    /**
     * @param  array<string, mixed>  $modelResult
     * @return array{score:int,dimension_scores:array<string,int>,decision:string,issues:list<array<string,mixed>>,uncertainties:list<array<string,mixed>>}
     */
    public function score(array $modelResult, int $passScore = 85, int $manualOverrideMinScore = 70): array
    {
        if ($manualOverrideMinScore < 0 || $manualOverrideMinScore >= $passScore || $passScore > 100) {
            throw new \InvalidArgumentException('AI quality thresholds are invalid.');
        }

        $issues = $this->uniqueIssues(is_array($modelResult['issues'] ?? null) ? $modelResult['issues'] : []);
        $uncertainties = array_values(is_array($modelResult['uncertainties'] ?? null) ? $modelResult['uncertainties'] : []);
        $dimensionScores = self::DIMENSION_MAXIMUMS;
        $hasCriticalIssue = false;
        $hasHighSeverityIssue = false;

        $hasUnrecognizedIssue = false;

        foreach ($issues as $issue) {
            // 白名单外的 code：不让整次质检崩掉（崩掉等于门禁永久失效），但也**不能静默放过**。
            // 照常按它自报的严重度扣分，并强制人工复核——保持 fail-closed，避免模型换个 code
            // 写法就把高危问题带过门禁。
            if (($issue['code_recognized'] ?? true) === false) {
                $hasUnrecognizedIssue = true;
            }
            $code = (string) ($issue['code'] ?? '');
            $severity = (string) ($issue['severity'] ?? 'medium');
            $dimension = self::CODE_DIMENSIONS[$code] ?? 'content_integrity';
            $deduction = self::SEVERITY_DEDUCTIONS[$severity] ?? self::SEVERITY_DEDUCTIONS['medium'];
            $dimensionScores[$dimension] = max(0, $dimensionScores[$dimension] - $deduction);
            $hasCriticalIssue = $hasCriticalIssue || $severity === 'critical';
            $hasHighSeverityIssue = $hasHighSeverityIssue || $severity === 'high';
        }

        $score = array_sum($dimensionScores);
        $requiresManualReview = in_array(
            (string) ($modelResult['knowledge_coverage'] ?? 'insufficient'),
            ['partial', 'insufficient'],
            true,
        ) || $this->hasMaterialUncertainty($uncertainties)
            || $this->hasUnresolvedEvidence($issues)
            || $hasHighSeverityIssue
            || $hasUnrecognizedIssue
            || $this->hasUncertainPromotionContext($modelResult, $issues);

        $decision = match (true) {
            $hasCriticalIssue, $score < $manualOverrideMinScore => 'blocked',
            $requiresManualReview, $score < $passScore => 'needs_review',
            default => 'passed',
        };

        return [
            'score' => $score,
            'dimension_scores' => $dimensionScores,
            'decision' => $decision,
            'issues' => $issues,
            'uncertainties' => $uncertainties,
        ];
    }

    /**
     * @param  array<int, mixed>  $issues
     * @return list<array<string, mixed>>
     */
    private function uniqueIssues(array $issues): array
    {
        $unique = [];

        foreach ($issues as $issue) {
            if (! is_array($issue)) {
                continue;
            }

            // 模型偶尔会返回白名单以外的 code。这只是格式偏差，不能让整次质检作废——
            // 否则质检门禁会永远失败、文章永远发不出去。保留该问题并按既有约定归到
            // content_integrity 维度，同时打标，便于后续收敛提示词时定位。
            $issue['code_recognized'] = array_key_exists((string) ($issue['code'] ?? ''), self::CODE_DIMENSIONS);

            $knowledgeRefs = is_array($issue['knowledge_refs'] ?? null) ? $issue['knowledge_refs'] : [];
            sort($knowledgeRefs);
            $key = hash('sha256', json_encode([
                (string) ($issue['code'] ?? ''),
                (string) ($issue['field'] ?? ''),
                (string) ($issue['quote'] ?? ''),
                $knowledgeRefs,
            ], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
            $unique[$key] ??= $issue;
        }

        return array_values($unique);
    }

    /** @param list<array<string, mixed>> $uncertainties */
    private function hasMaterialUncertainty(array $uncertainties): bool
    {
        foreach ($uncertainties as $uncertainty) {
            if (($uncertainty['materiality'] ?? null) === 'high') {
                return true;
            }
        }

        return false;
    }

    /** @param list<array<string, mixed>> $issues */
    private function hasUnresolvedEvidence(array $issues): bool
    {
        foreach ($issues as $issue) {
            if (($issue['location_status'] ?? 'resolved') === 'unresolved'
                || ($issue['references_valid'] ?? true) !== true) {
                return true;
            }
        }

        return false;
    }

    /** @param list<array<string, mixed>> $issues */
    private function hasUncertainPromotionContext(array $modelResult, array $issues): bool
    {
        if (($modelResult['promotion_context'] ?? null) !== 'uncertain') {
            return false;
        }

        foreach ($issues as $issue) {
            if (str_starts_with((string) ($issue['code'] ?? ''), 'ad_')) {
                return true;
            }
        }

        return false;
    }
}
