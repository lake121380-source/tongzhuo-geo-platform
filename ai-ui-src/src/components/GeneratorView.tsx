import React, { useEffect, useState } from 'react';
import {
  Sparkles,
  Bot,
  Check,
  ArrowRight,
  RefreshCw,
  Send,
  BookOpen,
  Layers,
  Wand2,
  FileQuestion,
  HelpCircle,
  Lightbulb,
} from 'lucide-react';
import { Article, KnowledgeBase, Task } from '../types';
import PermissionNotice from './PermissionNotice';
import { describeApiError } from '../api/permissions';

interface GeneratorViewProps {
  knowledgeBases: KnowledgeBase[];
  onSaveArticle: (article: Article) => void;
  lang: 'zh' | 'en';
  apiMode?: boolean;
  apiCatalog?: {
    titleLibraries: Array<{ id: string | number; name: string }>;
    prompts: Array<{ id: string | number; name: string }>;
    qualityPrompts?: Array<{ id: string | number; name: string }>;
    models: Array<{ id: string | number; name: string; type?: string }>;
    categories: Array<{ id: string | number; name: string }>;
    authors: Array<{ id: string | number; name: string }>;
  };
  onCreateTask?: (task: Partial<Task> & Record<string, unknown>) => void | Promise<void>;
  /** Catalog/knowledge read capability required to assemble a real task. */
  canRead?: boolean;
  /** Task/article write capability used by the real API mode. */
  canWrite?: boolean;
}

export const GeneratorView: React.FC<GeneratorViewProps> = ({
  knowledgeBases,
  onSaveArticle,
  lang,
  apiMode = false,
  apiCatalog,
  onCreateTask,
  canRead = true,
  canWrite = true,
}) => {
  // 演示数据只在非 API（离线预览）模式出现；接入真实后端的部署里一律留空，
  // 由运营方填写真实标题与关键词，不能用样例内容冒充已配置的生成参数。
  const catalogCategories = apiCatalog?.categories ?? [];
  const catalogAuthors = apiCatalog?.authors ?? [];
  const catalogPrompts = apiCatalog?.prompts ?? [];
  const [title, setTitle] = useState('');
  const [keywords, setKeywords] = useState('');
  const [selectedKbId, setSelectedKbId] = useState(knowledgeBases[0]?.id || '');
  const [category, setCategory] = useState(String(catalogCategories[0]?.id ?? ''));
  const [author, setAuthor] = useState(String(catalogAuthors[0]?.id ?? ''));
  const [promptId, setPromptId] = useState('');
  const [qualityPromptId, setQualityPromptId] = useState('');
  // 质检门禁默认开启：关掉它意味着生成的文章可以绕过质检直接审核发布。
  const [qualityEnabled, setQualityEnabled] = useState(true);
  const catalogQualityPrompts = apiCatalog?.qualityPrompts ?? [];

  // 真实目录是异步加载的，到达后补上首选项，避免选择器停在空值。
  useEffect(() => {
    if (!apiMode || !apiCatalog) return;
    if (!category && catalogCategories.length > 0) setCategory(String(catalogCategories[0].id));
    if (!author && catalogAuthors.length > 0) setAuthor(String(catalogAuthors[0].id));
    if (!selectedKbId && knowledgeBases.length > 0) setSelectedKbId(knowledgeBases[0].id);
  }, [apiMode, apiCatalog, category, author, selectedKbId, catalogCategories, catalogAuthors, knowledgeBases]);

  // 目录按 name 排序，英文提示词排在中文字符之前，直接取第一条会让中文任务生成英文正文。
  // 中文界面下优先挑名称里带中日韩字符的提示词；运营者仍可在下方手动切换。
  useEffect(() => {
    if (!apiMode || !apiCatalog || promptId || catalogPrompts.length === 0) return;
    const preferred = lang === 'zh'
      ? catalogPrompts.find((item) => /[一-鿿]/.test(String(item.name))) ?? catalogPrompts[0]
      : catalogPrompts[0];
    setPromptId(String(preferred.id));
  }, [apiMode, apiCatalog, promptId, lang, catalogPrompts]);

  // 质检方案默认取第一条；开启质检时后端要求必须指定方案。
  useEffect(() => {
    if (!apiMode || !apiCatalog || qualityPromptId || catalogQualityPrompts.length === 0) return;
    setQualityPromptId(String(catalogQualityPrompts[0].id));
  }, [apiMode, apiCatalog, qualityPromptId, catalogQualityPrompts]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedResult, setGeneratedResult] = useState<any | null>(null);
  const [viewMode, setViewMode] = useState<'preview' | 'markdown' | 'seo'>('preview');
  const [generationError, setGenerationError] = useState('');

  // Beginner Template Wizard State
  const [activeTemplate, setActiveTemplate] = useState<'none' | 'comparison' | 'definition' | 'faq'>('none');
  const [tplBrand, setTplBrand] = useState('');
  const [tplCompetitor, setTplCompetitor] = useState('');
  const [tplFeature, setTplFeature] = useState('');
  const [tplConcept, setTplConcept] = useState('');
  const [tplFaqQuestion, setTplFaqQuestion] = useState('');

  const applyComparisonTemplate = () => {
    if (!tplBrand.trim() || !tplCompetitor.trim()) {
      setGenerationError(lang === 'zh' ? '请先填写品牌名与对比对象，再一键生成标题。' : 'Fill in the brand and competitor fields before generating a title.');
      return;
    }
    setTitle(`${tplBrand} 与 ${tplCompetitor} 深度选型对比：面向大模型推荐的核心差异与落地实测`);
    setKeywords(`${tplBrand}, 选型对比, 竞品评测, GEO优化, ${tplFeature.split('、')[0]}`);
    setActiveTemplate('none');
  };

  const applyDefinitionTemplate = () => {
    if (!tplConcept.trim()) {
      setGenerationError(lang === 'zh' ? '请先填写行业核心概念，再一键生成标题。' : 'Fill in the core concept before generating a title.');
      return;
    }
    setTitle(`什么是 ${tplConcept}？企业构建高可靠 AI 第一信源的标准落地指南`);
    setKeywords(`${tplConcept}, 行业权威定义, E-E-A-T, 大模型收录, 落地指南`);
    setActiveTemplate('none');
  };

  const applyFaqTemplate = () => {
    if (!tplFaqQuestion.trim()) {
      setGenerationError(lang === 'zh' ? '请先填写要解答的问题，再一键生成标题。' : 'Fill in the question before generating a title.');
      return;
    }
    setTitle(`【官方答疑】${tplFaqQuestion}：从蜘蛛爬虫到知识切片的5个排查关键点`);
    setKeywords(`技术答疑, robots.txt, llms.txt, AI爬虫排查, 权威解答`);
    setActiveTemplate('none');
  };

  const handleGenerate = async () => {
    if (!canRead) {
      setGenerationError(lang === 'zh' ? '权限不足（403）：读取生成目录需要「catalog:read」权限。' : 'Permission denied (403): loading the generation catalog requires the “catalog:read” scope.');
      return;
    }
    if (!canWrite) {
      setGenerationError(lang === 'zh' ? '权限不足（403）：生成任务需要「tasks:write」权限。' : 'Permission denied (403): generating a task requires the “tasks:write” scope.');
      return;
    }
    if (!title.trim()) return;
    setIsGenerating(true);
    setGeneratedResult(null);
    setGenerationError('');

    try {
      if (apiMode) {
        const titleLibrary = apiCatalog?.titleLibraries[0];
        const prompt = catalogPrompts.find((item) => String(item.id) === promptId) ?? catalogPrompts[0];
        const model = apiCatalog?.models.find((item) => !item.type || item.type === 'chat') || apiCatalog?.models[0];
        const categoryRecord = catalogCategories.find((item) => String(item.id) === category) ?? catalogCategories[0];
        const authorRecord = catalogAuthors.find((item) => String(item.id) === author) ?? catalogAuthors[0];
        if (!onCreateTask || !titleLibrary || !prompt || !model) {
          throw new Error('桐灼GEO 目录缺少标题库、提示词或内容模型，无法创建生成任务');
        }
        if (qualityEnabled && !qualityPromptId) {
          throw new Error('已开启 AI 质检但目录没有可用的质检方案，请先在提示词中配置质检方案');
        }
        if (qualityEnabled && !selectedKbId) {
          throw new Error('开启 AI 质检后必须挂载至少一个知识库，否则质检无法比对事实');
        }

        await onCreateTask({
          name: title.trim(),
          title_library_id: Number(titleLibrary.id),
          prompt_id: Number(prompt.id),
          ai_model_id: Number(model.id),
          fixed_category_id: categoryRecord ? Number(categoryRecord.id) : null,
          author_id: authorRecord ? Number(authorRecord.id) : null,
          knowledge_base_ids: selectedKbId ? [Number(selectedKbId)] : [],
          // 传的是**后端词汇**（`active`/`paused`），而前端 `Task.status` 是另一套
          // （`running`/`idle`/`paused`/`completed`，`mapTask` 把后端的 active 映射成 running）。
          // 这个字段属于「发给 API 的原始载荷」、不属于前端模型，所以在调用点跨过类型。
          // 注意 `paused` 在两边拼写恰好相同——当初写死 `paused` 因此编译通过、错得毫无声响。
          status: 'active' as unknown as Task['status'],
          article_limit: 1,
          draft_limit: 1,
          publish_interval: 3600,
          publish_scope: 'local_only',
          category_mode: categoryRecord ? 'fixed' : 'smart',
          ai_quality_enabled: qualityEnabled,
          ...(qualityEnabled ? { ai_quality_prompt_id: Number(qualityPromptId) } : {}),
        });
        setGeneratedResult({
          title: title.trim(),
          summary: '任务已创建并启用。调度器会在一分钟内开始生成：检索知识库、写草稿、过质量门禁。',
          // 这句必须与真实行为一致：任务建成后是 `active`，产出会落到「内容与审核」并停在「待审核」。
          // 原先写的是「生成成功后，文章会出现在文章列表中」——而当时任务是 `paused`，永远不会生成。
          content: '这是任务创建确认，不是文章正文。任务已启用，生成完成后文章会出现在「内容与审核」中、状态为「待审核」，需要人工放行才会发布。若标题库可用标题不足，创建会直接报错并说明原因。',
          seoKeywords: keywords.split(/[,，\s]+/).filter(Boolean),
          provider: '桐灼GEO Task Queue',
          queued: true,
        });
        return;
      }

      const res = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          keywords,
          kbId: selectedKbId,
          category,
        }),
      });
      const data = await res.json();
      setGeneratedResult(data);
    } catch (err) {
      console.error('Generation error:', err);
      setGenerationError(describeApiError(err, lang === 'zh' ? '生成任务失败' : 'Generation failed', lang));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCommit = (status: 'published' | 'draft' | 'review') => {
    if (!canWrite) {
      setGenerationError(lang === 'zh' ? '权限不足（403）：保存文章需要「articles:write」权限。' : 'Permission denied (403): saving an article requires the “articles:write” scope.');
      return;
    }
    if (!generatedResult) return;
    if (generatedResult.queued) return;
    const newArt: Article = {
      id: `art-${Date.now()}`,
      title: generatedResult.title,
      slug: generatedResult.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').slice(0, 50),
      summary: generatedResult.summary,
      content: generatedResult.content,
      category,
      author,
      status,
      views: 0,
      seoTitle: `${generatedResult.title} - GEO 权威信源`,
      seoKeywords: keywords.split(/[,，\s]+/).filter(Boolean),
      seoDescription: generatedResult.summary,
      createdAt: new Date().toISOString().split('T')[0],
      distributedTo: status === 'published' ? ['agent-channel-1'] : [],
    };

    onSaveArticle(newArt);
    alert(lang === 'zh' ? `文章已成功保存为【${status === 'published' ? '已发布' : status === 'review' ? '待审核' : '草稿'}】！` : `Saved as ${status}!`);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-white flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-red-500" />
            {lang === 'zh' ? 'AI 内容工坊与 GEO 深度生成' : 'AI Content Studio & GEO Engine'}
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            {lang === 'zh'
              ? '结合业务私有知识库，自动召回事实片段，由大模型生成符合 GEO 标准的权威深度长文与 Schema 结构。'
              : 'Synthesize verified knowledge chunks into SEO/GEO-optimized longform articles with schema tags.'}
          </p>
        </div>
      </div>
      {!canRead && <PermissionNotice lang={lang} mode="read" requiredScope="catalog:read" />}
      {canRead && !canWrite && <PermissionNotice lang={lang} requiredScope={apiMode ? 'tasks:write' : 'articles:write'} />}
      {generationError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{generationError}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Inputs (5 cols) */}
        <div className="lg:col-span-5 bg-slate-900/80 p-5 rounded-2xl border border-slate-800 space-y-4">
          {/* Beginner Fast-track Templates */}
          <div className="p-3.5 rounded-xl bg-gradient-to-br from-indigo-950/40 via-slate-900 to-indigo-950/30 border border-indigo-500/25 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wand2 className="w-4 h-4 text-indigo-400" />
                <span className="text-xs font-bold text-white">
                  {lang === 'zh' ? '小白免提示词模版 (填空即成高分 GEO 文)' : 'Beginner Template Wizard'}
                </span>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 font-semibold">
                {lang === 'zh' ? '高采纳率' : 'High CTR'}
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              {lang === 'zh'
                ? '不知道该写什么？点击下方 3 大高频被 AI 检索的模版，只需填空即可自动生成：'
                : 'Choose a template below to auto-populate high-density GEO keywords and title:'}
            </p>
            <div className="grid grid-cols-3 gap-1.5 text-xs">
              <button
                type="button"
                onClick={() => setActiveTemplate(activeTemplate === 'comparison' ? 'none' : 'comparison')}
                className={`p-2 rounded-lg border text-center transition ${
                  activeTemplate === 'comparison'
                    ? 'bg-indigo-600 text-white border-indigo-400 font-semibold'
                    : 'bg-slate-800/80 hover:bg-slate-750 text-slate-300 border-slate-700'
                }`}
              >
                <div className="text-[11px] font-bold">1. 竞品对比</div>
                <div className="text-[9px] text-slate-400 mt-0.5">防竞品截流</div>
              </button>
              <button
                type="button"
                onClick={() => setActiveTemplate(activeTemplate === 'definition' ? 'none' : 'definition')}
                className={`p-2 rounded-lg border text-center transition ${
                  activeTemplate === 'definition'
                    ? 'bg-indigo-600 text-white border-indigo-400 font-semibold'
                    : 'bg-slate-800/80 hover:bg-slate-750 text-slate-300 border-slate-700'
                }`}
              >
                <div className="text-[11px] font-bold">2. 行业定义</div>
                <div className="text-[9px] text-slate-400 mt-0.5">树立第一权威</div>
              </button>
              <button
                type="button"
                onClick={() => setActiveTemplate(activeTemplate === 'faq' ? 'none' : 'faq')}
                className={`p-2 rounded-lg border text-center transition ${
                  activeTemplate === 'faq'
                    ? 'bg-indigo-600 text-white border-indigo-400 font-semibold'
                    : 'bg-slate-800/80 hover:bg-slate-750 text-slate-300 border-slate-700'
                }`}
              >
                <div className="text-[11px] font-bold">3. 痛点答疑</div>
                <div className="text-[9px] text-slate-400 mt-0.5">FAQ高频引用</div>
              </button>
            </div>

            {/* Template Form Inputs */}
            {activeTemplate === 'comparison' && (
              <div className="p-3 bg-slate-950/80 rounded-lg border border-indigo-500/30 space-y-2 text-xs animate-in fade-in">
                <div className="font-semibold text-indigo-300 flex items-center gap-1.5">
                  <Lightbulb className="w-3.5 h-3.5" />
                  <span>【竞品横评模版】：专攻潜在客户做采购选型时的对比检索</span>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-400">我司品牌 / 产品名：</label>
                  <input
                    type="text"
                    value={tplBrand}
                    onChange={e => setTplBrand(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-400">对标的竞品或传统方案（逗号分隔）：</label>
                  <input
                    type="text"
                    value={tplCompetitor}
                    onChange={e => setTplCompetitor(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-400">我司核心独特差异化优势：</label>
                  <input
                    type="text"
                    value={tplFeature}
                    onChange={e => setTplFeature(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white text-xs"
                  />
                </div>
                <button
                  type="button"
                  onClick={applyComparisonTemplate}
                  className="w-full py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-bold text-xs shadow transition mt-1"
                >
                  ✓ 一键生成标题与核心词
                </button>
              </div>
            )}

            {activeTemplate === 'definition' && (
              <div className="p-3 bg-slate-950/80 rounded-lg border border-indigo-500/30 space-y-2 text-xs animate-in fade-in">
                <div className="font-semibold text-indigo-300 flex items-center gap-1.5">
                  <Lightbulb className="w-3.5 h-3.5" />
                  <span>【行业定义指南】：成为大语言模型在回答“什么是XX”时的权威词典</span>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-400">行业核心概念 / 术语词汇：</label>
                  <input
                    type="text"
                    value={tplConcept}
                    onChange={e => setTplConcept(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white text-xs"
                  />
                </div>
                <button
                  type="button"
                  onClick={applyDefinitionTemplate}
                  className="w-full py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-bold text-xs shadow transition mt-1"
                >
                  ✓ 一键生成标题与核心词
                </button>
              </div>
            )}

            {activeTemplate === 'faq' && (
              <div className="p-3 bg-slate-950/80 rounded-lg border border-indigo-500/30 space-y-2 text-xs animate-in fade-in">
                <div className="font-semibold text-indigo-300 flex items-center gap-1.5">
                  <Lightbulb className="w-3.5 h-3.5" />
                  <span>【痛点答疑模版】：捕获客户具体的长尾技术疑难提问</span>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-slate-400">客户常问的疑难问题：</label>
                  <input
                    type="text"
                    value={tplFaqQuestion}
                    onChange={e => setTplFaqQuestion(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white text-xs"
                  />
                </div>
                <button
                  type="button"
                  onClick={applyFaqTemplate}
                  className="w-full py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-bold text-xs shadow transition mt-1"
                >
                  ✓ 一键生成标题与核心词
                </button>
              </div>
            )}
          </div>

          <h2 className="text-sm font-bold text-white flex items-center gap-2 border-b border-slate-800 pb-2">
            <Layers className="w-4 h-4 text-red-400" />
            {lang === 'zh' ? '生成参数配置' : 'Generation Parameters'}
          </h2>

          {/* Title */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-300">
                {lang === 'zh' ? '文章标题 / 核心命题' : 'Title / Focus Topic'} *
              </label>
            </div>
            <textarea
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              rows={2}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500 transition resize-none"
              placeholder={lang === 'zh' ? '输入文章标题或核心命题...' : 'Enter title or prompt topic...'}
            />
          </div>

          {/* Keywords */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-300">
              {lang === 'zh' ? 'GEO 核心关键词（逗号分隔）' : 'Target Keywords (comma separated)'}
            </label>
            <input
              type="text"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500 transition"
              placeholder="e.g. GEO, AI信源, RAG知识库"
            />
          </div>

          {/* Knowledge Base Selector */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
              {lang === 'zh' ? '挂载私有知识库（RAG 事实检索）' : 'Grounding Knowledge Base (RAG)'}
            </label>
            <select
              value={selectedKbId}
              onChange={(e) => setSelectedKbId(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500 transition"
            >
              {knowledgeBases.map((kb) => (
                <option key={kb.id} value={kb.id}>
                  {kb.name} ({kb.chunkCount} {lang === 'zh' ? '切片' : 'chunks'})
                </option>
              ))}
            </select>
            <p className="text-[11px] text-slate-400">
              {lang === 'zh' ? '大模型将严格参考选定知识库中的客观切片进行撰写，保障事实可信度。' : 'Grounds the output on authentic factual fragments to eliminate hallucinations.'}
            </p>
          </div>

          {/* Category & Author */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-300">{lang === 'zh' ? '分类' : 'Category'}</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition"
              >
                {apiMode ? (
                  catalogCategories.length === 0
                    ? <option value="">{lang === 'zh' ? '暂无可用分类' : 'No categories available'}</option>
                    : catalogCategories.map((item) => <option key={String(item.id)} value={String(item.id)}>{item.name}</option>)
                ) : (
                  <>
                    <option value="科技资讯">{lang === 'zh' ? '科技资讯' : 'Tech News'}</option>
                    <option value="AI互联网">{lang === 'zh' ? 'AI互联网' : 'AI & Internet'}</option>
                    <option value="人工智能">{lang === 'zh' ? '人工智能' : 'AI Deep'}</option>
                    <option value="行业洞察">{lang === 'zh' ? '行业洞察' : 'Insights'}</option>
                  </>
                )}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-300">{lang === 'zh' ? '署名作者' : 'Author'}</label>
              {apiMode ? (
                <select
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition"
                >
                  {catalogAuthors.length === 0
                    ? <option value="">{lang === 'zh' ? '暂无可用作者' : 'No authors available'}</option>
                    : catalogAuthors.map((item) => <option key={String(item.id)} value={String(item.id)}>{item.name}</option>)}
                </select>
              ) : (
                <input
                  type="text"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition"
                />
              )}
            </div>
          </div>

          {/* Prompt */}
          {apiMode && (
            <div className="space-y-1">
              <label className="text-xs font-semibold text-slate-300">{lang === 'zh' ? '生成提示词' : 'Generation prompt'}</label>
              <select
                value={promptId}
                onChange={(e) => setPromptId(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition"
              >
                {catalogPrompts.length === 0
                  ? <option value="">{lang === 'zh' ? '暂无可用提示词' : 'No prompts available'}</option>
                  : catalogPrompts.map((item) => <option key={String(item.id)} value={String(item.id)}>{item.name}</option>)}
              </select>
              <p className="text-[10px] text-slate-500">{lang === 'zh' ? '提示词决定正文语言与写法；默认已按界面语言预选。' : 'The prompt decides the article language and style; a language-matched default is preselected.'}</p>
            </div>
          )}

          {/* AI quality gate */}
          {apiMode && (
            <div className="space-y-1 rounded-xl border border-slate-700 bg-slate-950/40 p-3">
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <input
                  type="checkbox"
                  checked={qualityEnabled}
                  onChange={(e) => setQualityEnabled(e.target.checked)}
                  className="h-3.5 w-3.5 accent-red-500"
                />
                {lang === 'zh' ? '开启 AI 质检门禁' : 'Enable AI quality gate'}
              </label>
              {qualityEnabled ? (
                <select
                  value={qualityPromptId}
                  onChange={(e) => setQualityPromptId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition"
                >
                  {catalogQualityPrompts.length === 0
                    ? <option value="">{lang === 'zh' ? '暂无质检方案' : 'No quality scheme'}</option>
                    : catalogQualityPrompts.map((item) => <option key={String(item.id)} value={String(item.id)}>{item.name}</option>)}
                </select>
              ) : (
                <p className="text-[10px] text-amber-300">{lang === 'zh' ? '已关闭：该任务产出的文章不会被质检拦下，可直接审核发布。' : 'Disabled: articles from this task skip the quality gate and can be approved directly.'}</p>
              )}
              {qualityEnabled && <p className="text-[10px] text-slate-500">{lang === 'zh' ? '未达质检分数的文章会被门禁拦在审核/发布之外，需人工放行。' : 'Articles below the quality score are blocked from review/publish until manually released.'}</p>}
            </div>
          )}

          {/* Generate Button */}
          <div className="pt-2">
            <button
              onClick={handleGenerate}
              disabled={!canRead || !canWrite || isGenerating || !title.trim()}
              className="w-full py-3 rounded-xl text-sm font-bold bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 disabled:opacity-50 text-white shadow-lg shadow-red-600/20 transition flex items-center justify-center gap-2"
            >
              {isGenerating ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>{lang === 'zh' ? 'AI 正在检索事实并生成文章...' : 'Synthesizing with AI & RAG...'}</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>{lang === 'zh' ? '立即开始 AI 生成' : 'Generate Article Now'}</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Right Output Area (7 cols) */}
        <div className="lg:col-span-7 bg-slate-900/80 p-5 rounded-2xl border border-slate-800 flex flex-col justify-between min-h-[500px]">
          {isGenerating ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-4">
              <div className="w-14 h-14 rounded-2xl bg-red-600/10 border border-red-500/20 flex items-center justify-center text-red-400 animate-pulse">
                <Bot className="w-8 h-8 animate-bounce" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">
                  {lang === 'zh' ? '正在执行 GEO 知识增强生成' : 'Executing GEO Knowledge Synthesis'}
                </h3>
                <p className="text-xs text-slate-400 mt-1 max-w-sm">
                  {lang === 'zh'
                    ? '系统正在切片召回高相关性语料，组织二级标题，并生成规范的 Markdown 表格与 Schema 标记...'
                    : 'Retrieving knowledge vectors, drafting GFM markdown, creating comparative tables and schema LD...'}
                </p>
              </div>
            </div>
          ) : generatedResult ? (
            <div className="flex-1 flex flex-col justify-between space-y-4">
              {/* Output Header */}
              <div>
                <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-200">{lang === 'zh' ? '生成结果预览' : 'Generated Preview'}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                      {generatedResult.provider}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 bg-slate-800 p-1 rounded-lg border border-slate-700">
                    <button
                      onClick={() => setViewMode('preview')}
                      className={`text-xs px-2.5 py-1 rounded-md font-medium transition ${
                        viewMode === 'preview' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {lang === 'zh' ? '排版预览' : 'Rich View'}
                    </button>
                    <button
                      onClick={() => setViewMode('markdown')}
                      className={`text-xs px-2.5 py-1 rounded-md font-medium transition ${
                        viewMode === 'markdown' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Markdown
                    </button>
                    <button
                      onClick={() => setViewMode('seo')}
                      className={`text-xs px-2.5 py-1 rounded-md font-medium transition ${
                        viewMode === 'seo' ? 'bg-red-600 text-white' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      SEO & Schema
                    </button>
                  </div>
                </div>

                {/* Content Display */}
                <div className="bg-slate-950/60 rounded-xl p-4 border border-slate-800/80 max-h-[420px] overflow-y-auto text-sm text-slate-200 space-y-3">
                  {viewMode === 'preview' && (
                    <div className="prose prose-invert max-w-none text-xs sm:text-sm leading-relaxed whitespace-pre-wrap font-sans">
                      {generatedResult.content}
                    </div>
                  )}

                  {viewMode === 'markdown' && (
                    <pre className="font-mono text-xs text-slate-300 whitespace-pre-wrap">
                      {generatedResult.content}
                    </pre>
                  )}

                  {viewMode === 'seo' && (
                    <div className="space-y-3 text-xs">
                      <div>
                        <span className="text-slate-400 block mb-1">SEO Title:</span>
                        <div className="p-2 rounded bg-slate-900 border border-slate-800 font-mono text-slate-200">
                          {generatedResult.title} - 桐灼GEO 权威信源
                        </div>
                      </div>
                      <div>
                        <span className="text-slate-400 block mb-1">SEO Keywords:</span>
                        <div className="flex flex-wrap gap-1">
                          {generatedResult.seoKeywords.map((k: string) => (
                            <span key={k} className="px-2 py-0.5 bg-slate-900 rounded border border-slate-800 text-slate-300">
                              {k}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div>
                        <span className="text-slate-400 block mb-1">SEO Summary:</span>
                        <div className="p-2 rounded bg-slate-900 border border-slate-800 text-slate-300">
                          {generatedResult.summary}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Action Bar */}
              <div className="pt-4 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs text-slate-400">
                  {lang === 'zh' ? '请核验事实后执行保存或分发：' : 'Actions:'}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleCommit('draft')}
                    disabled={!canWrite || Boolean(generatedResult.queued)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
                  >
                    {lang === 'zh' ? '存为草稿' : 'Save Draft'}
                  </button>
                  <button
                    onClick={() => handleCommit('review')}
                    disabled={!canWrite || Boolean(generatedResult.queued)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/30 transition"
                  >
                    {lang === 'zh' ? '提交人工审核' : 'Mark for Review'}
                  </button>
                  <button
                    onClick={() => handleCommit('published')}
                    disabled={!canWrite || Boolean(generatedResult.queued)}
                    className="px-4 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition flex items-center gap-1.5"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>{lang === 'zh' ? '立即发布并分发' : 'Publish & Distribute'}</span>
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-3">
              <div className="w-12 h-12 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-400">
                <Sparkles className="w-6 h-6 text-slate-400" />
              </div>
              <h3 className="text-sm font-bold text-slate-300">
                {lang === 'zh' ? '尚未开始生成' : 'No article generated yet'}
              </h3>
              <p className="text-xs text-slate-400 max-w-sm">
                {lang === 'zh'
                  ? '在左侧配置标题、关键词与知识库后，点击“立即开始 AI 生成”即可实时产出 GEO 规范文章。'
                  : 'Configure the topic on the left and click Generate to see the grounded GEO article.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
