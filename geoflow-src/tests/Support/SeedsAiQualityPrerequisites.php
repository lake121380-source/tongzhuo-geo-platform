<?php

namespace Tests\Support;

use App\Models\AiModel;
use App\Models\Article;
use App\Models\ArticleAiQualityCheck;
use App\Models\KnowledgeBase;
use App\Models\Prompt;
use App\Models\Task;
use App\Services\GeoFlow\ArticleAiQualityInspectionService;

/**
 * 给测试补上「发布前的质检前置」。
 *
 * **为什么需要它**：2026-09-20 起发布门禁是 **fail-closed** —— 任务没开质检时回落到兜底策略
 * （`required` 恒 true），发布/分发前必须有「质检提示词 + 质检模型 + 知识库」这套配置，
 * 且文章上要有一条**指纹匹配**的已通过质检记录（指纹由 `ArticleAiQualityInspectionService`
 * 按正文/规则/算法版本算出来，手写的记录一定对不上 → 门禁会认为需要重新质检）。
 *
 * 一批用例是在那之前写的（当时「直接就能发布」），fixture 里没有这些前置，于是整个
 * 「发布」链路在测试里静默返回 null / 直接被门禁拦下 —— 那是门禁在要求先质检，不是产品坏了。
 * 用这个 trait 把前置补齐，让那些用例继续表达「一次配置正常、质检已通过的发布流程」。
 *
 * 两条路径对应 resolver 的两种来源：
 * - **有任务**：配置挂在任务上（`fromTaskQualityBaseline`，缺失时回落系统默认）；
 * - **没有任务**：配置走文章的 `ai_quality_policy_snapshot` + 文章级知识库（`fromIndependentArticle`）。
 *   `makeArticleQualityReady()` 会自动判断走哪条。
 */
trait SeedsAiQualityPrerequisites
{
    /**
     * 把**任务**补成「质检配置完整」：系统质检提示词 + 对话模型 + 知识库。
     *
     * 与 `ArticleAiQualityGateTest::qualityArticle()` 用的是同一套前置（那边是当前仍然通过的用例）。
     */
    protected function makeTaskQualityReady(Task $task, ?AiModel $model = null): AiModel
    {
        // 同一条任务上常会造多篇文章 → 只补一次，别反复建模型/知识库。
        $existingModel = $task->ai_model_id !== null ? AiModel::query()->find((int) $task->ai_model_id) : null;
        if ($existingModel instanceof AiModel
            && $task->ai_quality_prompt_id !== null
            && $task->knowledgeBases()->exists()) {
            return $existingModel;
        }

        $prompt = $this->defaultQualityPrompt();
        $model ??= $this->ensureActiveChatModel();
        $knowledgeBase = $this->createQualityKnowledgeBase();

        $task->forceFill([
            'ai_quality_enabled' => true,
            'ai_quality_prompt_id' => $prompt->id,
            'ai_model_id' => $model->id,
            'ai_quality_pass_score' => 85,
            'ai_quality_manual_override_min_score' => 70,
        ])->save();
        $task->knowledgeBases()->syncWithoutDetaching([$knowledgeBase->id => ['sort_order' => 0]]);

        return $model;
    }

    /**
     * 不管文章有没有任务，都把「发布前必须有的那套质检配置」补齐。
     *
     * 有任务 → 挂到任务上；没有任务（独立文章）→ 写进策略快照 + 文章级知识库。
     */
    protected function makeArticleQualityReady(Article $article): void
    {
        $task = $article->task_id ? Task::query()->find((int) $article->task_id) : null;

        if ($task instanceof Task) {
            $this->makeTaskQualityReady($task);
        } else {
            $prompt = $this->defaultQualityPrompt();
            $model = $this->ensureActiveChatModel();
            $knowledgeBase = $this->createQualityKnowledgeBase();

            $snapshot = is_array($article->ai_quality_policy_snapshot) ? $article->ai_quality_policy_snapshot : [];
            $article->forceFill([
                'ai_quality_policy_snapshot' => array_merge($snapshot, [
                    'prompt_id' => $prompt->id,
                    'model_id' => $model->id,
                ]),
            ])->save();
            $article->aiQualityKnowledgeBases()->syncWithoutDetaching([$knowledgeBase->id => ['sort_order' => 0]]);
        }

        $this->seedPassedQualityCheck($article->fresh());
    }

    /** 造一条「已完成且通过」的质检记录（指纹交给服务算，然后只改结论）。 */
    protected function seedPassedQualityCheck(Article $article, int $score = 100): ArticleAiQualityCheck
    {
        $inspection = app(ArticleAiQualityInspectionService::class);
        $check = $inspection->createOrReuse($article, dispatch: false);
        $check->forceFill([
            'status' => 'completed',
            'decision' => 'passed',
            'score' => $score,
            'active_dedupe_key' => null,
            // 与 `ArticleAiQualityGateTest` 保持一致：测试环境没有执行上下文，走 legacy 算法版本。
            'algorithm_version' => 'exec=legacy;ret=1;prompt=1;score=1',
            'advertising_rules_snapshot' => $inspection->rules(),
        ])->save();

        return $check->refresh();
    }

    /** 一步到位（任务版）：任务补配置 + 文章造一条通过的质检。 */
    protected function makeReadyToPublish(Task $task, Article $article): void
    {
        $this->makeTaskQualityReady($task);
        $this->seedPassedQualityCheck($article);
    }

    private function defaultQualityPrompt(): Prompt
    {
        return Prompt::query()
            ->where('system_key', 'article_quality.cn_ads_knowledge.v1')
            ->where('type', 'quality_check')
            ->firstOrFail();
    }

    /** 系统里得有一个可用的对话模型：兜底策略会拿它当质检模型。 */
    private function ensureActiveChatModel(): AiModel
    {
        $existing = AiModel::query()
            ->where('status', 'active')
            ->where(function ($query): void {
                $query->whereNull('model_type')->orWhere('model_type', '')->orWhere('model_type', 'chat');
            })
            ->orderBy('id')
            ->first();
        if ($existing instanceof AiModel) {
            return $existing;
        }

        return AiModel::query()->create([
            'name' => '质检模型 '.uniqid(),
            'version' => '1',
            'api_key' => 'test',
            'model_id' => 'quality-model',
            'api_url' => 'https://example.test',
            'model_type' => 'chat',
            'status' => 'active',
        ]);
    }

    private function createQualityKnowledgeBase(): KnowledgeBase
    {
        return KnowledgeBase::query()->create([
            'name' => '质检知识库 '.uniqid(),
            'content' => '待检查正文的核验依据。',
        ]);
    }
}
