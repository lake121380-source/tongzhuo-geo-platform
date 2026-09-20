<?php

namespace App\Services\GeoFlow;

use App\Data\Admin\SharedAiModelData;
use App\Models\Admin;
use App\Models\AiModel;
use App\Models\Author;
use App\Models\Category;
use App\Models\ImageLibrary;
use App\Models\KeywordLibrary;
use App\Models\KnowledgeBase;
use App\Models\Prompt;
use App\Models\TitleLibrary;
use App\Services\Admin\AdminAiModelAccessResolver;

class CatalogGeoFlowService
{
    public function __construct(private readonly AdminAiModelAccessResolver $modelAccessResolver) {}

    /**
     * @return array<string, mixed>
     */
    public function getCatalog(Admin|int $actor): array
    {
        $models = $this->catalogModels($actor);

        $prompts = Prompt::query()
            ->where('type', 'content')
            ->orderBy('name')
            ->get(['id', 'name', 'type'])
            ->map(fn (Prompt $p) => $p->getAttributes())
            ->all();

        // 质检方案必须一并返回：开启 AI 质检时后端要求 ai_quality_prompt_id 必填，
        // 只暴露 content 类型会让新建任务无法选择质检方案，质检门禁形同虚设。
        $qualityPrompts = Prompt::query()
            ->where('type', 'quality_check')
            ->orderBy('name')
            ->get(['id', 'name', 'type', 'system_key'])
            ->map(fn (Prompt $p) => $p->getAttributes())
            ->all();

        $titleLibraries = TitleLibrary::query()
            ->withCount(['titles as title_count'])
            ->orderBy('name')
            ->get(['id', 'name'])
            ->map(fn (TitleLibrary $tl) => [
                'id' => $tl->id,
                'name' => $tl->name,
                'title_count' => (int) ($tl->title_count ?? 0),
            ])
            ->all();

        $keywordLibraries = KeywordLibrary::query()
            ->withCount(['keywords as keyword_count'])
            ->orderBy('name')
            ->get(['id', 'name'])
            ->map(fn (KeywordLibrary $kl) => [
                'id' => $kl->id,
                'name' => $kl->name,
                'keyword_count' => (int) ($kl->keyword_count ?? 0),
            ])
            ->all();

        $imageLibraries = ImageLibrary::query()
            ->withCount(['images as image_count'])
            ->orderBy('name')
            ->get(['id', 'name'])
            ->map(fn (ImageLibrary $il) => [
                'id' => $il->id,
                'name' => $il->name,
                'image_count' => (int) ($il->image_count ?? 0),
            ])
            ->all();

        $knowledgeBases = KnowledgeBase::query()
            ->orderBy('name')
            ->get(['id', 'name'])
            ->map(fn (KnowledgeBase $k) => $k->getAttributes())
            ->all();

        $authors = Author::query()
            ->orderBy('name')
            ->get(['id', 'name'])
            ->map(fn (Author $a) => $a->getAttributes())
            ->all();

        $categories = Category::query()
            ->orderBy('sort_order')
            ->orderBy('name')
            ->get(['id', 'name', 'slug'])
            ->map(fn (Category $c) => $c->getAttributes())
            ->all();

        return [
            'models' => $models,
            'prompts' => $prompts,
            'quality_prompts' => $qualityPrompts,
            'keyword_libraries' => $keywordLibraries,
            'title_libraries' => $titleLibraries,
            'image_libraries' => $imageLibraries,
            'knowledge_bases' => $knowledgeBases,
            'authors' => $authors,
            'categories' => $categories,
            // 功能开关随目录一起下发：Hosted Site 关闭时它的路由按设计返回 404，
            // 前端若照常请求，只会在控制台留下一条无意义的 404（页面本身没问题）。
            'features' => [
                'hosted_sites' => (bool) config('geoflow.hosted_sites.enabled', false),
            ],
        ];
    }

    /** @return list<array<string, int|string|bool>> */
    private function catalogModels(Admin|int $actor): array
    {
        $admin = $actor instanceof Admin
            ? $actor
            : Admin::query()->findOrFail($actor);

        return $this->modelAccessResolver
            ->usableQuery($admin)
            ->where(function ($query): void {
                $query->whereIn('model_type', ['chat', 'embedding'])
                    ->orWhereNull('model_type')
                    ->orWhere('model_type', '');
            })
            ->get()
            ->map(static fn (AiModel $model): array => SharedAiModelData::fromModel(
                $model,
                (int) $model->owner_admin_id !== (int) $admin->getKey(),
            )->toArray())
            ->all();
    }
}
