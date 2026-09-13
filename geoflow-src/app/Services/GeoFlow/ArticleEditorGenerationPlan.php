<?php

namespace App\Services\GeoFlow;

use App\Data\Ai\DirectAdminAiExecutionContext;
use App\Models\Admin;
use App\Models\AiModel;
use App\Models\KnowledgeBase;
use App\Models\Prompt;

/**
 * 编辑器内联生成的执行计划。
 *
 * {@see ArticleEditorAssistantService::prepare()} 负责把「模型访问边界、知识库证据、
 * 提示词渲染」全部冻结下来，之后 {@see ArticleEditorAssistantService::stream()} 只按
 * 这个计划消费惰性流。两个入口（旧 Blade 后台与 api/v1）共用同一条链路，不做第二套实现。
 */
final readonly class ArticleEditorGenerationPlan
{
    public function __construct(
        public Admin $admin,
        public AiModel $resolvedModel,
        public KnowledgeBase $knowledgeBase,
        public Prompt $prompt,
        public string $title,
        public string $keyword,
        public string $contentPrompt,
        public DirectAdminAiExecutionContext $executionContext,
    ) {}
}
