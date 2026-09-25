import React, { useEffect, useRef, useState } from 'react';
import { Sparkles, X, BookOpen, RefreshCw, AlertTriangle, CheckCircle2, ChevronDown, Settings2 } from 'lucide-react';
import { KnowledgeBase, Task } from '../types';
import { describeApiError } from '../api/permissions';
import { probeTitleReadiness, TitleLibraryReadiness } from '../api/titleReadiness';

export interface AiGenerateCatalog {
  titleLibraries: Array<{ id: string | number; name: string }>;
  prompts: Array<{ id: string | number; name: string }>;
  qualityPrompts?: Array<{ id: string | number; name: string }>;
  models: Array<{ id: string | number; name: string; type?: string }>;
  categories: Array<{ id: string | number; name: string }>;
  authors: Array<{ id: string | number; name: string }>;
}

interface AiGenerateModalProps {
  knowledgeBases: KnowledgeBase[];
  apiCatalog?: AiGenerateCatalog;
  onCreateTask?: (task: Partial<Task> & Record<string, unknown>) => void | Promise<void>;
  onCheckTitleReadiness?: (params: Record<string, string | number | undefined>) => Promise<Record<string, unknown>>;
  onNavigate?: (tab: string) => void;
  onClose: () => void;
  canRead?: boolean;
  canWrite?: boolean;
  lang: 'zh' | 'en';
}

/**
 * 「文章」页里的 AI 生成弹窗。
 *
 * 它只做一件事：收齐一次「AI 生成一篇文章」所需的配置，建一条一次性任务，
 * 然后给出成功反馈。进度由文章列表顶部的「生成中」占位行负责，不在弹窗里展示
 * （所以没有右侧预览、没有「存为草稿/提交审核/立即发布」那排死按钮）。
 *
 * ## 2026-09-13 重设计：默认只问两件事
 *
 * 旧版把 7 个字段（标题库/提示词/知识库/分类/作者/质检门禁/质检方案）一次摊开，
 * 对运营人员是过载——其中 5 项都有合理默认值（提示词自动挑中文的、分类/作者取目录
 * 第一条、质检方案取第一条）。现在默认只露**标题库**（含可用条数前置显示）与
 * **知识库**，其余收进「高级设置」折叠块。默认路径下用户只需要确认/换两个下拉框。
 *
 * 相比已退役的「写文章」页（GeneratorView），这里刻意砍掉三块：
 *   - 「文章标题 / 核心命题」—— 它其实只被拿去当任务名，生成的正文标题来自标题库；
 *     任务名改为自动生成（`AI 生成 · HH:MM`）。
 *   - 「GEO 核心关键词」—— 不进创建任务的载荷，纯死字段。
 *   - 三个「小白免提示词模板」—— 产出物是标题+关键词，标题半死、关键词全死。
 */
export const AiGenerateModal: React.FC<AiGenerateModalProps> = ({
  knowledgeBases,
  apiCatalog,
  onCreateTask,
  onCheckTitleReadiness,
  onNavigate,
  onClose,
  canRead = true,
  canWrite = true,
  lang,
}) => {
  const zh = lang === 'zh';
  const [titleReadiness, setTitleReadiness] = useState<Record<string, TitleLibraryReadiness>>({});
  const [selectedLibraryId, setSelectedLibraryId] = useState<string | null>(null);
  const [selectedKbId, setSelectedKbId] = useState(knowledgeBases[0]?.id || '');
  const [category, setCategory] = useState('');
  const [author, setAuthor] = useState('');
  const [promptId, setPromptId] = useState('');
  const [qualityPromptId, setQualityPromptId] = useState('');
  const [qualityEnabled, setQualityEnabled] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState('');
  /** 创建成功后的反馈态：告诉用户「接下来会发生什么」，而不是静默关窗。 */
  const [createdTaskName, setCreatedTaskName] = useState('');
  const closeTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);

  const catalogCategories = apiCatalog?.categories ?? [];
  const catalogAuthors = apiCatalog?.authors ?? [];
  const catalogPrompts = apiCatalog?.prompts ?? [];
  const catalogQualityPrompts = apiCatalog?.qualityPrompts ?? [];
  const titleLibraries = apiCatalog?.titleLibraries ?? [];

  // 用「库 id 列表」当依赖，避免 apiCatalog 每次渲染换引用导致重复请求。
  const libraryKey = titleLibraries.map((library) => String(library.id)).join(',');

  // 打开弹窗即把每个标题库都预检一遍，把「可用标题」前置到下拉选项上。
  useEffect(() => {
    if (!onCheckTitleReadiness || titleLibraries.length === 0) {
      setTitleReadiness({});
      return;
    }
    let alive = true;
    void (async () => {
      const next = await probeTitleReadiness(onCheckTitleReadiness, titleLibraries);
      if (!alive) return;
      setTitleReadiness(next);
      setSelectedLibraryId((current) => {
        // 选中的库还在目录里就保持不动：探测失败（结果里没有它）不该把用户的选择改掉。
        if (current && titleLibraries.some((library) => String(library.id) === current)) return current;
        const usable = titleLibraries.find((library) => (next[String(library.id)]?.available ?? 0) > 0);
        return String((usable ?? titleLibraries[0]).id);
      });
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCheckTitleReadiness, libraryKey]);

  // 真实目录异步到达后补上首选项，避免选择器停在空值。
  useEffect(() => {
    if (!apiCatalog) return;
    if (!category && catalogCategories.length > 0) setCategory(String(catalogCategories[0].id));
    if (!author && catalogAuthors.length > 0) setAuthor(String(catalogAuthors[0].id));
    if (!selectedKbId && knowledgeBases.length > 0) setSelectedKbId(knowledgeBases[0].id);
  }, [apiCatalog, category, author, selectedKbId, catalogCategories, catalogAuthors, knowledgeBases]);

  // 中文界面下优先挑带中日韩字符的提示词，避免生成英文正文。
  useEffect(() => {
    if (!apiCatalog || promptId || catalogPrompts.length === 0) return;
    const preferred = lang === 'zh'
      ? catalogPrompts.find((item) => /[一-鿿]/.test(String(item.name))) ?? catalogPrompts[0]
      : catalogPrompts[0];
    setPromptId(String(preferred.id));
  }, [apiCatalog, promptId, lang, catalogPrompts]);

  // 质检方案默认取第一条；开启质检时后端要求必须指定方案。
  useEffect(() => {
    if (!apiCatalog || qualityPromptId || catalogQualityPrompts.length === 0) return;
    setQualityPromptId(String(catalogQualityPrompts[0].id));
  }, [apiCatalog, qualityPromptId, catalogQualityPrompts]);

  // 目录里根本没有质检方案时自动关闭门禁——开着它必然在提交时被后端拒绝。
  // 用户仍可在「高级设置」里手动打开（那时开关下方会说明后果）。
  useEffect(() => {
    if (!apiCatalog) return;
    if (catalogQualityPrompts.length === 0) setQualityEnabled(false);
  }, [apiCatalog, catalogQualityPrompts.length]);

  /**
   * 某个标题库的可用条数。**取不到就是「未知」，不是 0。**
   *
   * `probeTitleReadiness` 的契约写明：单个库探测失败就跳过它，调用方读到的 `undefined`
   * 表示「不知道」（`titleReadiness.ts`）。以前这里 `?? 0`，探测一失败每个库都标成
   * 「可用 0」、下面写「共 0 条标题」——运营会跑去补一批并不需要的标题。
   */
  const availableOf = (libraryId: string | number): number | null =>
    typeof titleReadiness[String(libraryId)]?.available === 'number'
      ? (titleReadiness[String(libraryId)]?.available as number)
      : null;
  const activeReadiness = selectedLibraryId ? titleReadiness[selectedLibraryId] : undefined;
  /** 同上：探测没回来时不谎报「共 0 条」。 */
  const readinessKnown = typeof activeReadiness?.total === 'number';
  const readinessTotal = readinessKnown ? (activeReadiness?.total as number) : null;
  const readinessBlocked = activeReadiness?.blocked ?? false;

  const handleGenerate = async () => {
    if (!canRead || !canWrite) {
      setGenerationError(zh
        ? '权限不足（403）：AI 生成需要「catalog:read」与「tasks:write」权限。'
        : 'Permission denied (403): AI generation needs “catalog:read” and “tasks:write”.');
      return;
    }
    setIsGenerating(true);
    setGenerationError('');
    try {
      const titleLibrary =
        titleLibraries.find((item) => String(item.id) === selectedLibraryId) ?? titleLibraries[0];
      const prompt = catalogPrompts.find((item) => String(item.id) === promptId) ?? catalogPrompts[0];
      const model = apiCatalog?.models.find((item) => !item.type || item.type === 'chat') || apiCatalog?.models[0];
      const categoryRecord = catalogCategories.find((item) => String(item.id) === category) ?? catalogCategories[0];
      const authorRecord = catalogAuthors.find((item) => String(item.id) === author) ?? catalogAuthors[0];
      if (!onCreateTask || !titleLibrary || !prompt || !model) {
        throw new Error(zh ? '桐灼GEO 目录缺少标题库、提示词或内容模型，无法创建生成任务' : 'Catalog is missing a title library, prompt, or content model');
      }
      if (qualityEnabled && !qualityPromptId) {
        throw new Error(zh ? '已开启 AI 质检但目录没有可用的质检方案' : 'The quality gate is enabled but no quality prompt is available');
      }
      if (qualityEnabled && !selectedKbId) {
        throw new Error(zh ? '开启 AI 质检后必须挂载至少一个知识库' : 'The quality gate requires at least one knowledge base');
      }

      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const taskName = zh ? `AI 生成 · ${hhmm}` : `AI generation · ${hhmm}`;
      await onCreateTask({
        name: taskName,
        title_library_id: Number(titleLibrary.id),
        prompt_id: Number(prompt.id),
        ai_model_id: Number(model.id),
        fixed_category_id: categoryRecord ? Number(categoryRecord.id) : null,
        author_id: authorRecord ? Number(authorRecord.id) : null,
        knowledge_base_ids: selectedKbId ? [Number(selectedKbId)] : [],
        status: 'active' as unknown as Task['status'],
        article_limit: 1,
        draft_limit: 1,
        is_loop: 0,
        publish_interval: 3600,
        publish_scope: 'local_only',
        category_mode: categoryRecord ? 'fixed' : 'smart',
        ai_quality_enabled: qualityEnabled,
        ...(qualityEnabled ? { ai_quality_prompt_id: Number(qualityPromptId) } : {}),
      });
      // 不再静默关窗：先让用户看到「任务已建、大约多久出稿、去哪看」。
      setCreatedTaskName(taskName);
      closeTimer.current = window.setTimeout(() => onClose(), 4000);
    } catch (err) {
      setGenerationError(describeApiError(err, zh ? '生成任务失败' : 'Generation failed', lang));
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full max-h-[90vh] overflow-y-auto p-6 space-y-4 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-indigo-600" />
            <span>{zh ? 'AI 生成文章' : 'Generate with AI'}</span>
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={isGenerating}
            className="text-slate-400 hover:text-slate-200 text-sm"
            aria-label={zh ? '关闭' : 'Close'}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {createdTaskName ? (
          /* ── 成功反馈：说清楚「接下来会发生什么」── */
          <div className="space-y-3 py-2" data-generate-success>
            <div className="flex items-start gap-2.5">
              <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-400 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-bold text-white">{zh ? '已开始生成' : 'Generation started'}</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-300">
                  {zh
                    ? `任务「${createdTaskName}」已创建，大约 1 分钟后文章会出现在本页列表里，顶部也会显示生成进度。产出的文章先是「待审核」，确认没问题再发布。`
                    : `Task “${createdTaskName}” created. The article appears in the list in about a minute; drafts start as “In review”.`}
                </p>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-1.5 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm"
              >
                {zh ? '知道了' : 'Got it'}
              </button>
            </div>
          </div>
        ) : (
        <>
        <p className="text-xs text-slate-400">
          {zh
            ? '选一个标题库，AI 会从里面挑标题；再选一个知识库作为事实来源，写出的内容才有据可依。'
            : 'Pick a title library for the headline and a knowledge base to ground the facts.'}
        </p>

        <div className="space-y-3">
          {/* 标题库 + 前置条件（默认路径的第一件事） */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-300">{zh ? '标题库' : 'Title library'}</label>
            {titleLibraries.length === 0 ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300 leading-relaxed">
                {zh ? '还没有标题库。标题库就是「这一批要写哪些题」，先去素材库建一个并录入标题。' : 'No title library yet; create one in Materials first.'}
                {onNavigate && (
                  <button
                    type="button"
                    onClick={() => { onClose(); onNavigate('materials:titles'); }}
                    className="ml-1 font-semibold underline underline-offset-2 hover:no-underline"
                  >
                    {zh ? '去素材库 →' : 'Go to Materials →'}
                  </button>
                )}
              </div>
            ) : (
              <>
                <select
                  value={selectedLibraryId ?? ''}
                  onChange={(event) => setSelectedLibraryId(event.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                >
                  {titleLibraries.map((library) => (
                    <option key={String(library.id)} value={String(library.id)}>
                      {library.name}
                      {(() => {
                        const available = availableOf(library.id);
                        if (available === null) return zh ? '（可用数未知）' : ' (availability unknown)';
                        return zh ? `（可用 ${available}）` : ` (${available} available)`;
                      })()}
                    </option>
                  ))}
                </select>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-500 tabular-nums">
                    {readinessTotal === null
                      ? (zh ? '可用标题数未知（探测失败，可点「检查就绪度」重试）' : 'Title availability unknown (retry readiness check)')
                      : (zh ? `共 ${readinessTotal} 条标题` : `${readinessTotal} titles`)}
                  </span>
                  {readinessBlocked && onNavigate && (
                    <button
                      type="button"
                      onClick={() => { onClose(); onNavigate('materials:titles'); }}
                      className="text-[11px] font-semibold text-amber-300 underline underline-offset-2 hover:no-underline"
                    >
                      {zh ? '去补充标题 →' : 'Add titles →'}
                    </button>
                  )}
                </div>
                {readinessBlocked && (
                  <div className="flex items-start gap-1.5 text-[11px] text-amber-300 leading-relaxed">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>
                      {zh
                        ? `「${activeReadiness?.name ?? ''}」可用标题已用完，换一个标题库或先补充标题。`
                        : `"${activeReadiness?.name ?? ''}" has no unused titles left.`}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* 知识库（默认路径的第二件事） */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
              {zh ? '事实来源知识库' : 'Grounding knowledge base'}
            </label>
            <select
              value={selectedKbId}
              onChange={(event) => setSelectedKbId(event.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
            >
              <option value="">{zh ? '不挂知识库（AI 只能凭常识写）' : 'None (write from general knowledge)'}</option>
              {knowledgeBases.map((kb) => (
                <option key={kb.id} value={kb.id}>
                  {kb.name} ({kb.chunkCount} {zh ? '切片' : 'chunks'})
                </option>
              ))}
            </select>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              {zh
                ? 'AI 会优先引用知识库里的资料，写得有依据、少瞎编。没有知识库也能生成，但质检门禁会关掉。'
                : 'The AI grounds its writing in this knowledge base. Without one, the quality gate is unavailable.'}
            </p>
          </div>

          {/* 高级设置：有合理默认值的字段收在这里，默认不打扰 */}
          <details className="group rounded-xl border border-slate-800 bg-slate-950/40">
            <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2.5 text-xs font-semibold text-slate-300 [&::-webkit-details-marker]:hidden">
              <Settings2 className="w-3.5 h-3.5 text-slate-400" />
              {zh ? '高级设置' : 'Advanced'}
              <span className="text-[10px] font-normal text-slate-500">
                {zh ? '提示词 / 分类 / 作者 / 质检' : 'prompt / category / author / quality'}
              </span>
              <ChevronDown className="ml-auto w-3.5 h-3.5 text-slate-500 transition-transform group-open:rotate-180" />
            </summary>
            <div className="space-y-3 border-t border-slate-800 px-3 py-3">
              {/* 生成提示词 */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">{zh ? '生成提示词' : 'Generation prompt'}</label>
                <select
                  value={promptId}
                  onChange={(event) => setPromptId(event.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                >
                  {catalogPrompts.length === 0
                    ? <option value="">{zh ? '暂无可用提示词' : 'No prompts available'}</option>
                    : catalogPrompts.map((item) => <option key={String(item.id)} value={String(item.id)}>{item.name}</option>)}
                </select>
              </div>

              {/* 分类 & 作者 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-300">{zh ? '分类' : 'Category'}</label>
                  <select
                    value={category}
                    onChange={(event) => setCategory(event.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                  >
                    {catalogCategories.length === 0
                      ? <option value="">{zh ? '暂无可用分类' : 'No categories'}</option>
                      : catalogCategories.map((item) => <option key={String(item.id)} value={String(item.id)}>{item.name}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-300">{zh ? '署名作者' : 'Author'}</label>
                  <select
                    value={author}
                    onChange={(event) => setAuthor(event.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                  >
                    {catalogAuthors.length === 0
                      ? <option value="">{zh ? '暂无可用作者' : 'No authors'}</option>
                      : catalogAuthors.map((item) => <option key={String(item.id)} value={String(item.id)}>{item.name}</option>)}
                  </select>
                </div>
              </div>

              {/* 质检门禁 */}
              <div className="space-y-2 rounded-xl border border-slate-700 bg-slate-950/40 p-3">
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                  <input
                    type="checkbox"
                    checked={qualityEnabled}
                    onChange={(event) => setQualityEnabled(event.target.checked)}
                    className="h-3.5 w-3.5 accent-red-500"
                  />
                  {zh ? '生成后自动质检' : 'AI quality check after generation'}
                </label>
                {qualityEnabled ? (
                  <>
                    <select
                      value={qualityPromptId}
                      onChange={(event) => setQualityPromptId(event.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                    >
                      {catalogQualityPrompts.length === 0
                        ? <option value="">{zh ? '暂无质检方案' : 'No quality scheme'}</option>
                        : catalogQualityPrompts.map((item) => <option key={String(item.id)} value={String(item.id)}>{item.name}</option>)}
                    </select>
                    <p className="text-[10px] text-slate-500">{zh ? '没达到分数的文章会被拦下，需要人工处理（优化或改写）后才能发布。' : 'Articles below the score are held for manual handling before publish.'}</p>
                    {catalogQualityPrompts.length === 0 && (
                      <p role="alert" className="text-[10px] text-amber-300">
                        {zh
                          ? '目录里没有质检方案，开着这项会被后端拒绝。请先到「AI 模型与提示词」配置质检提示词，或关掉上面的开关。'
                          : 'No quality scheme exists, so the gate would be rejected.'}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-[10px] text-slate-500">
                    {zh
                      ? (catalogQualityPrompts.length === 0
                        ? '未开启：目录里没有可用的质检方案，已自动关闭。'
                        : '未开启：文章不会被质检拦下，可直接进入审核。')
                      : 'Disabled: articles skip the quality gate.'}
                  </p>
                )}
              </div>
            </div>
          </details>
        </div>

        {generationError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{generationError}</div>}

        <div className="pt-3 border-t border-slate-800 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isGenerating}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-50"
          >
            {zh ? '取消' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={!canRead || !canWrite || isGenerating || readinessBlocked || titleLibraries.length === 0}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm disabled:opacity-50"
          >
            {isGenerating ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>{zh ? '创建中…' : 'Creating…'}</span>
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5" />
                <span>{zh ? '开始生成' : 'Generate'}</span>
              </>
            )}
          </button>
        </div>
        </>
        )}
      </div>
    </div>
  );
};
