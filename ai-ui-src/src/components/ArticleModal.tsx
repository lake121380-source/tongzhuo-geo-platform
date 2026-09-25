import React, { useEffect, useRef, useState } from 'react';
import { FileText, Eye, Send, CheckCircle2, X, Tag, ShieldCheck, Loader2, Pencil, Save, RefreshCw, Copy, Upload, Sparkles, Square } from 'lucide-react';
import { Article } from '../types';
import { GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';
import { useConfirm } from './ui';
import { ArticleQualityPanel } from './ArticleQualityPanel';
import { StatusBadge, qualityStatusSpec } from './StatusBadge';

/** 内联助手在编辑器里需要的最小选项集（由 App 从真实 catalog 注入）。 */
export interface EditorAssistantCatalog {
  knowledgeBases: Array<{ id: string; name: string }>;
  prompts: Array<{ id: string; name: string }>;
  models: Array<{ id: string; name: string }>;
}

interface ArticleModalProps {
  article: Article | null;
  onClose: () => void;
  onPublish: (id: string) => void | Promise<void>;
  onDistribute: (id: string) => void;
  onUpdateArticle?: (updated: Article) => void | Article | Promise<void | Article>;
  lang: 'zh' | 'en';
  apiMode?: boolean;
  /** Authenticated 桐灼GEO client used by the real quality/optimization panel. */
  apiClient?: GeoFlowApiClient;
  /** Replace local shell state after a server-side apply/rollback mutation. */
  onArticleStateChange?: (updated: Article) => void | Promise<void>;
  onRiskRecheck?: (id: string) => Promise<unknown>;
  onExportWeChatHtml?: (content: string) => Promise<unknown>;
  onUploadEditorImage?: (id: string, file: File, alt?: string) => Promise<unknown>;
  /** 编辑器内联助手：候选标题（「换一个推荐标题」）。 */
  onListEditorTitles?: (params?: Record<string, string | number | undefined>) => Promise<{ items: Array<Record<string, unknown>>; pagination: Record<string, unknown> }>;
  /**
   * 编辑器内联助手：当场生成正文。实现负责把流式增量交给 `onDelta`，
   * 并以最终清理后的正文作为返回值（服务端已在流内给出 replacement 帧）。
   */
  onEditorGenerate?: (
    payload: Record<string, unknown>,
    onDelta: (chunk: string) => void,
    signal?: AbortSignal,
  ) => Promise<string>;
  /** 生成所需的真实选项；缺省时生成入口不渲染（而不是给一个假的空下拉）。 */
  editorAssistantCatalog?: EditorAssistantCatalog;
  /**
   * 该部署有没有可用的分发渠道。一条都没有时整个「发布并分发」按钮不渲染——
   * 与其给一个必然失败的按钮，不如不给。
   */
  hasDistributionChannels?: boolean;
  /**
   * 「发布并分发」：先过发布门禁，再投递到**文章所属任务已绑定的启用渠道**。
   *
   * 刻意不在这里收渠道参数：`POST /articles/{id}/distribute` 只接受「已绑到该任务且
   * 启用中」的渠道 id（否则 409 `distribution_channel_not_bound`），而前端拿不到那份
   * 绑定清单。传空数组时服务端按任务边界自己解析——这是唯一不会 409 的正确调用方式。
   */
  onPublishAndDistribute?: (articleId: string) => Promise<void>;
}

export const ArticleModal: React.FC<ArticleModalProps> = ({
  article,
  onClose,
  onPublish,
  onDistribute,
  onUpdateArticle,
  lang,
  apiMode = false,
  apiClient,
  onArticleStateChange,
  onRiskRecheck,
  onExportWeChatHtml,
  onUploadEditorImage,
  onListEditorTitles,
  onEditorGenerate,
  editorAssistantCatalog,
  hasDistributionChannels = false,
  onPublishAndDistribute,
}) => {
  const [isPublishing, setIsPublishing] = useState(false);
  const confirmDialog = useConfirm();
  const [publishError, setPublishError] = useState('');
  /** 质检面板的位置，供「发布被拦下」时把用户带过去。 */
  const qualitySectionRef = useRef<HTMLDivElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const [actionBusy, setActionBusy] = useState<'risk' | 'wechat' | 'image' | 'publish-and-distribute' | null>(null);
  /** 「发布并分发」成功后延时关窗；卸载时清掉，免得定时器在已关闭的弹窗上再关一次。 */
  const closeTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);
  const [draft, setDraft] = useState({
    title: '',
    summary: '',
    content: '',
    keywords: '',
    description: '',
  });
  const [assistant, setAssistant] = useState({ knowledgeBaseId: '', promptId: '', modelId: '' });
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantError, setAssistantError] = useState('');
  const [assistantNotice, setAssistantNotice] = useState('');
  const [titleCandidates, setTitleCandidates] = useState<Array<{ id: number; title: string; keyword: string }>>([]);
  const [titlesBusy, setTitlesBusy] = useState(false);
  const generateAbort = useRef<AbortController | null>(null);

  // 生成入口只在真实契约齐备时渲染：没有 catalog 就不给一个假的下拉。
  const assistantEnabled = apiMode && typeof onEditorGenerate === 'function' && Boolean(editorAssistantCatalog);

  useEffect(() => {
    if (!article) {
      setIsEditing(false);
      return;
    }
    setDraft({
      title: article.title,
      summary: article.summary || '',
      content: article.content || '',
      keywords: (article.seoKeywords || []).join(', '),
      description: article.seoDescription || '',
    });
    setIsEditing(false);
    setEditError('');
    setPublishError('');
    setActionNotice('');
  }, [article?.id]);

  if (!article) return null;

  const loadTitleCandidates = async () => {
    if (typeof onListEditorTitles !== 'function') return;
    setTitlesBusy(true);
    setAssistantError('');
    try {
      const result = await onListEditorTitles({ usage: 'unused' });
      setTitleCandidates((result.items || []).map((row) => ({
        id: Number(row.id),
        title: String(row.title ?? ''),
        keyword: String(row.keyword ?? ''),
      })).filter((row) => row.id > 0 && row.title !== ''));
      setAssistantNotice(lang === 'zh' ? '已从标题库读取候选标题' : 'Candidate titles loaded');
    } catch (error) {
      setAssistantError(describeApiError(error, lang === 'zh' ? '候选标题读取失败' : 'Unable to load candidate titles', lang));
    } finally {
      setTitlesBusy(false);
    }
  };

  const cancelGeneration = () => {
    generateAbort.current?.abort();
  };

  const runGeneration = async () => {
    if (typeof onEditorGenerate !== 'function') return;
    if (!assistant.knowledgeBaseId || !assistant.promptId) {
      setAssistantError(lang === 'zh' ? '请先选择知识库与内容提示词。' : 'Pick a knowledge base and a content prompt first.');
      return;
    }
    // 生成是「替换正文」，不是追加——有内容时先说清楚再动手。
    if (draft.content.trim() !== '' && !(await confirmDialog({
      title: lang === 'zh' ? 'AI 生成会覆盖当前正文' : 'AI generation replaces the current content',
      description: lang === 'zh' ? '当前正文会被新生成的内容替换。' : 'The current content will be replaced.',
      confirmLabel: lang === 'zh' ? '继续生成' : 'Continue',
      tone: 'danger',
    }))) return;

    setAssistantBusy(true);
    setAssistantError('');
    setAssistantNotice('');
    const controller = new AbortController();
    generateAbort.current = controller;
    let streamed = '';
    try {
      const firstKeyword = draft.keywords.split(/[,，\n]/).map((part) => part.trim()).filter(Boolean)[0] || '';
      const finalContent = await onEditorGenerate(
        {
          title: draft.title,
          keyword: firstKeyword,
          knowledge_base_id: Number(assistant.knowledgeBaseId),
          prompt_id: Number(assistant.promptId),
          ...(assistant.modelId ? { ai_model_id: Number(assistant.modelId) } : {}),
        },
        (chunk) => {
          streamed += chunk;
          setDraft((current) => ({ ...current, content: streamed }));
        },
        controller.signal,
      );
      setDraft((current) => ({ ...current, content: finalContent }));
      setAssistantNotice(lang === 'zh' ? '正文已生成，确认后再保存。' : 'Content generated; review before saving.');
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setAssistantError(describeApiError(error, lang === 'zh' ? '生成失败' : 'Generation failed', lang));
      }
    } finally {
      setAssistantBusy(false);
      generateAbort.current = null;
    }
  };

  const beginEditing = () => {
    if (!article || !onUpdateArticle) return;
    setDraft({
      title: article.title,
      summary: article.summary || '',
      content: article.content || '',
      keywords: (article.seoKeywords || []).join(', '),
      description: article.seoDescription || '',
    });
    setEditError('');
    setIsEditing(true);
  };

  const cancelEditing = () => {
    if (isSaving) return;
    setIsEditing(false);
    setEditError('');
  };

  const handleSave = async () => {
    if (!article || !onUpdateArticle || isSaving) return;
    const title = draft.title.trim();
    const content = draft.content.trim();
    if (!title || !content) {
      setEditError(lang === 'zh' ? '标题和正文不能为空。' : 'Title and content are required.');
      return;
    }
    const seoKeywords = draft.keywords
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    const updated: Article = {
      ...article,
      title,
      summary: draft.summary.trim(),
      content,
      seoKeywords,
      seoDescription: draft.description.trim(),
    };

    setIsSaving(true);
    setEditError('');
    try {
      const result = await onUpdateArticle(updated);
      if (result && typeof result === 'object') {
        setDraft({
          title: result.title,
          summary: result.summary || '',
          content: result.content || '',
          keywords: (result.seoKeywords || []).join(', '),
          description: result.seoDescription || '',
        });
      }
      setIsEditing(false);
    } catch (error) {
      setEditError(error instanceof Error
        ? error.message
        : (lang === 'zh' ? '保存失败，请检查后端返回。' : 'Save failed. Check the server response.'));
    } finally {
      setIsSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!article || isPublishing) return;
    setIsPublishing(true);
    setPublishError('');
    try {
      await onPublish(article.id);
      onClose();
    } catch (error) {
      // Keep the article context open when a server quality/risk gate rejects
      // the transition so the operator can inspect the failure.
      setPublishError(error instanceof Error ? error.message : (lang === 'zh' ? '发布失败，请稍后重试。' : 'Unable to publish the article.'));
    } finally {
      setIsPublishing(false);
    }
  };

  const handlePublishAndDistribute = async () => {
    if (!article || actionBusy || !onPublishAndDistribute) return;
    setActionBusy('publish-and-distribute');
    setPublishError('');
    try {
      await onPublishAndDistribute(article.id);
      setActionNotice(lang === 'zh'
        ? '已发布，并已加入该任务已绑定渠道的分发队列。'
        : 'Published and queued for the task’s bound channels.');
      closeTimer.current = window.setTimeout(() => onClose(), 1500);
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : (lang === 'zh' ? '发布或分发失败' : 'Publish or distribution failed'));
    } finally {
      setActionBusy(null);
    }
  };

  const handleRiskRecheck = async () => {
    if (!onRiskRecheck || actionBusy) return;
    setActionBusy('risk'); setActionNotice('');
    try {
      const result = await onRiskRecheck(article.id);
      /**
       * 后端已经把「命中什么、命中几处、文章有没有被降级」都返回来（`scan.matches[]`
       * 里有 word/field/count/severity/snippet），只是这里以前固定只说一句「风险扫描已完成」。
       *
       * 后果很具体：命中敏感词时后端会**把已发布文章降级成草稿**，而运营只看到「已完成」，
       * 回头发现文章状态莫名其妙变成了草稿——不知道是谁、也不知道为什么。
       */
      const payload = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
      const scan = (payload.scan && typeof payload.scan === 'object') ? payload.scan as Record<string, unknown> : {};
      const matchCount = Number(scan.match_count ?? 0);
      const matches = Array.isArray(scan.matches) ? scan.matches as Array<Record<string, unknown>> : [];
      const words = [...new Set(matches.map((row) => String(row.word ?? '')).filter(Boolean))].slice(0, 6);
      const sealed = payload.downgraded === true;

      const parts: string[] = [];
      if (matchCount > 0) {
        parts.push(lang === 'zh'
          ? `命中 ${matchCount} 处风险${words.length ? `：${words.join('、')}` : ''}`
          : `${matchCount} risk hit(s)${words.length ? `: ${words.join(', ')}` : ''}`);
      } else {
        parts.push(lang === 'zh' ? '未发现风险内容。' : 'No risky content found.');
      }
      if (sealed) {
        parts.push(lang === 'zh'
          ? '文章已被降级为草稿——改掉命中内容后重新扫描，再过质检才能重新发布。'
          : 'The article was downgraded to draft: fix the hits, re-scan and re-check before publishing.');
      }
      setActionNotice(parts.join(lang === 'zh' ? ' ' : ' '));
    } catch (error) {
      setEditError(error instanceof Error ? error.message : (lang === 'zh' ? '风险扫描失败。' : 'Risk scan failed.'));
    } finally { setActionBusy(null); }
  };

  const handleWeChatExport = async () => {
    if (!onExportWeChatHtml || actionBusy) return;
    setActionBusy('wechat'); setActionNotice('');
    try {
      const raw = await onExportWeChatHtml(isEditing ? draft.content : article.content);
      const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const html = String(value.html || '');
      if (!html) throw new Error(lang === 'zh' ? '转换接口未返回 HTML。' : 'The converter returned no HTML.');
      await navigator.clipboard?.writeText(html);
      setActionNotice(lang === 'zh' ? '微信 HTML 已复制到剪贴板。' : 'WeChat HTML copied to clipboard.');
    } catch (error) {
      setEditError(error instanceof Error ? error.message : (lang === 'zh' ? '微信转换失败。' : 'WeChat export failed.'));
    } finally { setActionBusy(null); }
  };

  const handleImageUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !onUploadEditorImage || actionBusy) return;
    setActionBusy('image'); setEditError('');
    try {
      const raw = await onUploadEditorImage(article.id, file, file.name);
      const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const url = String(value.url || value.image_url || value.src || '');
      if (!url) throw new Error(lang === 'zh' ? '上传接口未返回图片地址。' : 'The upload returned no image URL.');
      setDraft((current) => ({ ...current, content: `${current.content}${current.content.endsWith('\n') ? '' : '\n\n'}![${file.name}](${url})\n` }));
      setIsEditing(true);
      setActionNotice(lang === 'zh' ? '图片已上传并插入正文。' : 'Image uploaded and inserted into content.');
    } catch (error) {
      setEditError(error instanceof Error ? error.message : (lang === 'zh' ? '图片上传失败。' : 'Image upload failed.'));
    } finally { setActionBusy(null); }
  };

  return (
    <>
      {/* 2026-09-19 版式对齐设计稿：**整屏左右分栏**（原来是居中弹窗 max-w-3xl）。
          左栏正文可滚动、右栏质检面板常驻——审核时「看正文」和「看判定依据」
          不用来回滚动、也不用记住刚才那个分数。
          仍保留覆盖层形态：它能从文章列表和总览「最近内容」两处打开，
          改成路由页会牵动两处调用方，收益不抵风险。 */}
      <div className="fixed inset-0 z-50 bg-slate-950 flex flex-col">
        <div className="flex h-full w-full flex-col overflow-hidden bg-slate-900">
          {/* Modal Header */}
          <div className="p-4 sm:p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/40">
            <div className="flex items-center gap-2">
              <span className="text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-medium">
                {article.category}
              </span>
              <span
                className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                  article.status === 'published'
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                }`}
              >
                {article.status}
              </span>
              {/* 质检徽标必须按「判定」显示：原来直接渲染 status（`completed`），
                  用户看到英文枚举，也分不清"跑完了"与"通过了"（2026-09-14）。 */}
              <StatusBadge
                spec={qualityStatusSpec(article.aiQualityStatus, article.aiQualityDecision, { degraded: article.aiQualityDegraded === true })}
                lang={lang}
                icon={<ShieldCheck className="w-3.5 h-3.5" />}
                className="!text-[11px]"
              />
              {apiMode && onRiskRecheck && (
                <button type="button" onClick={() => void handleRiskRecheck()} disabled={actionBusy !== null} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50" title={lang === 'zh' ? '重新执行风险扫描' : 'Run risk scan again'}>
                  {actionBusy === 'risk' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  <span>{lang === 'zh' ? '风险复扫' : 'Rescan risk'}</span>
                </button>
              )}
              <span className="text-xs text-slate-400 ml-1">{article.createdAt}</span>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* 2 栏：左正文 / 右质检面板 */}
          <div className="flex flex-1 overflow-hidden">
            <div className="flex-1 space-y-6 overflow-y-auto p-6 text-slate-200">
            <div>
              <div className="flex items-start justify-between gap-4">
                {isEditing ? (
                  <input
                    value={draft.title}
                    onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xl font-black leading-tight text-white focus:border-indigo-500 focus:outline-none"
                    aria-label={lang === 'zh' ? '文章标题' : 'Article title'}
                  />
                ) : (
                  <h1 className="text-xl sm:text-2xl font-black text-white leading-tight">
                    {article.title}
                  </h1>
                )}
              </div>
              <div className="flex items-center gap-4 text-xs text-slate-400 mt-2">
                <span>{lang === 'zh' ? '作者' : 'Author'}: {article.author}</span>
                <span>{lang === 'zh' ? '阅读量' : 'Views'}: {article.views || 0}</span>
                {article.distributedTo?.length > 0 && (
                  <span className="text-purple-400">
                    {lang === 'zh' ? '已分发至' : 'Synced to'} {article.distributedTo.length} {lang === 'zh' ? '个渠道' : 'channels'}
                  </span>
                )}
              </div>
            </div>

            {/* Keywords */}
            {isEditing ? (
              <div className="space-y-1.5 pt-2">
                <label className="text-xs font-semibold text-slate-300">{lang === 'zh' ? '关键词（逗号或换行分隔）' : 'Keywords (comma or newline separated)'}</label>
                <textarea
                  rows={2}
                  value={draft.keywords}
                  onChange={(event) => setDraft((current) => ({ ...current, keywords: event.target.value }))}
                  className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>
            ) : article.seoKeywords?.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-2">
                <Tag className="w-3.5 h-3.5 text-red-400 mr-1" />
                {article.seoKeywords.map((kw) => (
                  <span key={kw} className="text-[11px] px-2 py-0.5 bg-slate-800/80 rounded-md border border-slate-700/60 text-slate-300">
                    {kw}
                  </span>
                ))}
              </div>
            )}

            {/* Markdown Content Display / Editor */}
            {isEditing ? (
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2"><label className="text-xs font-semibold text-slate-300">{lang === 'zh' ? '正文' : 'Content'}</label><div className="flex flex-wrap items-center gap-1.5">{assistantEnabled && (assistantBusy
                  ? <button type="button" onClick={cancelGeneration} className="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 px-2 py-1 text-[10px] text-rose-200 hover:bg-rose-500/10"><Square className="h-3 w-3" /><span>{lang === 'zh' ? '停止生成' : 'Stop'}</span></button>
                  : <button type="button" onClick={() => void runGeneration()} className="inline-flex items-center gap-1 rounded-lg border border-violet-500/40 px-2 py-1 text-[10px] text-violet-200 hover:bg-violet-500/10"><Sparkles className="h-3 w-3" /><span>{lang === 'zh' ? 'AI 生成正文' : 'Generate with AI'}</span></button>)}{apiMode && onUploadEditorImage && <label className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-800"><Upload className="h-3 w-3" /><span>{actionBusy === 'image' ? (lang === 'zh' ? '上传中' : 'Uploading') : (lang === 'zh' ? '上传图片' : 'Upload image')}</span><input type="file" accept="image/*" className="hidden" onChange={(event) => void handleImageUpload(event)} disabled={actionBusy !== null} /></label>}</div></div>
                {assistantEnabled && <div className="space-y-2 rounded-xl border border-violet-500/25 bg-violet-950/10 p-2.5"><div className="grid gap-2 sm:grid-cols-3"><label className="text-[10px] text-slate-400">{lang === 'zh' ? '知识库（证据来源）' : 'Knowledge base'}<select value={assistant.knowledgeBaseId} disabled={assistantBusy} onChange={(event) => setAssistant((current) => ({ ...current, knowledgeBaseId: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white disabled:opacity-50"><option value="">{lang === 'zh' ? '请选择…' : 'Select…'}</option>{(editorAssistantCatalog?.knowledgeBases || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="text-[10px] text-slate-400">{lang === 'zh' ? '内容提示词' : 'Content prompt'}<select value={assistant.promptId} disabled={assistantBusy} onChange={(event) => setAssistant((current) => ({ ...current, promptId: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white disabled:opacity-50"><option value="">{lang === 'zh' ? '请选择…' : 'Select…'}</option>{(editorAssistantCatalog?.prompts || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="text-[10px] text-slate-400">{lang === 'zh' ? '模型（留空用默认）' : 'Model (optional)'}<select value={assistant.modelId} disabled={assistantBusy} onChange={(event) => setAssistant((current) => ({ ...current, modelId: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white disabled:opacity-50"><option value="">{lang === 'zh' ? '默认模型' : 'Default'}</option>{(editorAssistantCatalog?.models || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div><div className="flex flex-wrap items-center gap-2">{typeof onListEditorTitles === 'function' && <button type="button" onClick={() => void loadTitleCandidates()} disabled={titlesBusy || assistantBusy} className="rounded-lg border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-50">{titlesBusy ? (lang === 'zh' ? '读取中…' : 'Loading…') : (lang === 'zh' ? '从标题库取候选标题' : 'Load candidate titles')}</button>}{titleCandidates.length > 0 && <select value="" disabled={assistantBusy} onChange={(event) => { const picked = titleCandidates.find((row) => String(row.id) === event.target.value); if (picked) setDraft((current) => ({ ...current, title: picked.title, keywords: current.keywords.trim() === '' && picked.keyword ? picked.keyword : current.keywords })); event.currentTarget.value = ''; }} className="min-w-[200px] rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[10px] text-white disabled:opacity-50"><option value="">{lang === 'zh' ? `换一个推荐标题（${titleCandidates.length}）…` : `Use a candidate title (${titleCandidates.length})…`}</option>{titleCandidates.map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}</select>}<span className="text-[10px] text-slate-500">{lang === 'zh' ? '生成会替换当前正文，不会自动保存。' : 'Generation replaces the content; nothing is saved automatically.'}</span></div>{assistantError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-2 py-1.5 text-[10px] text-rose-200">{assistantError}</div>}{assistantNotice && <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-2 py-1.5 text-[10px] text-emerald-200">{assistantNotice}</div>}</div>}
                <textarea
                  rows={14}
                  value={draft.content}
                  onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950/80 p-4 text-xs leading-relaxed text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </div>
            ) : (
              <div className="p-5 rounded-xl bg-slate-950/80 border border-slate-800/80 prose prose-invert max-w-none text-xs sm:text-sm whitespace-pre-wrap leading-relaxed">
                {article.content}
              </div>
            )}

            {/* SEO Metadata Box */}
            <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-800 text-xs space-y-2">
              <div className="font-bold text-slate-300">{lang === 'zh' ? 'SEO / GEO 元信息' : 'SEO & GEO Metadata'}</div>
              {isEditing ? (
                <div className="space-y-2">
                  <textarea
                    rows={3}
                    value={draft.summary}
                    onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
                    placeholder={lang === 'zh' ? '文章摘要' : 'Excerpt'}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
                  />
                  <textarea
                    rows={2}
                    value={draft.description}
                    onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                    placeholder={lang === 'zh' ? 'Meta description（可选）' : 'Meta description (optional)'}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              ) : (
                <div className="text-slate-400">
                  <strong className="text-slate-300">Summary: </strong>
                  {article.summary}
                </div>
              )}
            </div>

            </div>

            {/* 右栏：质检面板常驻。`apiMode` 关掉时整栏不渲染（而不是留一条空白列）。 */}
            {apiMode && apiClient && (
              <aside className="w-[360px] shrink-0 overflow-y-auto border-l border-slate-800 bg-slate-950/30 p-5">
              <div ref={qualitySectionRef}>
                <ArticleQualityPanel
                  article={article}
                  apiClient={apiClient}
                  onArticleStateChange={onArticleStateChange}
                  lang={lang}
                />
              </div>
              </aside>
            )}
          </div>

          {/*
            发布被门禁拦下时：给出**原因 + 出口**。
            原先这条只渲染在页脚右侧一个 max-w-xs 的小红框里，用户只看到一句
            「AI 质检发现严重问题，文章禁止发布」，既不知道去哪改、也不知道怎么改。
          */}
          {publishError && (
            <div
              role="alert"
              aria-live="polite"
              className="mx-4 mb-3 rounded-xl border border-amber-500/40 bg-amber-950/20 px-4 py-3"
            >
              <div className="text-sm font-bold text-amber-100">
                {lang === 'zh' ? '这篇文章现在还不能发布' : 'This article cannot be published yet'}
              </div>
              <div className="mt-1 text-xs leading-relaxed text-amber-100">{publishError}</div>
              <div className="mt-2 text-xs leading-relaxed text-amber-100">
                {/* 处理建议必须与质检**判定**一致：判定是「待人工复核」时，出路是人工放行，
                    不是"去优化"——原来两句都写"去优化"，用户会一直绕圈（2026-09-14 哥哥报的 bug）。 */}
                {article.aiQualityDecision === 'needs_review'
                  ? (lang === 'zh'
                    ? '质检结论是「待人工复核」——到下方「AI 质检」区填写理由后点『人工放行』，再回来发布；也可以先点『启动 AI 优化』重写后复检。'
                    : 'The verdict is “needs review”: release it manually in the AI quality section below (a reason is required), or optimize and re-check first.')
                  : (lang === 'zh'
                    ? '可以这样处理：① 到下方「AI 质检」区点『启动 AI 优化』，让模型重写正文后重新质检；② 或点『编辑文章』自己改；③ 处理完再回来点一次「通过终审并上线」。'
                    : 'Next steps: ① open the AI quality section below and click "Start AI optimization" to rewrite and re-check; ② or click "Edit article" to fix it yourself; ③ then press "Approve & Publish" again.')}
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => qualitySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                  className="rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs font-semibold text-amber-100 transition hover:bg-amber-900/40"
                >
                  {article.aiQualityDecision === 'needs_review'
                    ? (lang === 'zh' ? '去 AI 质检区放行 →' : 'Go to AI quality →')
                    : (lang === 'zh' ? '去 AI 质检区优化 →' : 'Go to AI quality →')}
                </button>
                <button
                  type="button"
                  onClick={beginEditing}
                  className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700/60"
                >
                  {lang === 'zh' ? '编辑文章' : 'Edit article'}
                </button>
              </div>
            </div>
          )}

          {/* Modal Footer */}
          <div className="p-4 border-t border-slate-800 bg-slate-950/40 flex items-center justify-between">
            <div className="text-xs text-slate-400">ID: {article.id}</div>
            <div className="flex items-center gap-2">
              {(editError || actionNotice) && (
                <div role="alert" aria-live="polite" className="max-w-xs rounded-lg border border-red-500/30 bg-red-950/40 px-3 py-1.5 text-xs text-red-200">
                  {editError || actionNotice}
                </div>
              )}
              {isEditing ? (
                <>
                  {apiMode && onExportWeChatHtml && <button type="button" onClick={() => void handleWeChatExport()} disabled={actionBusy !== null} className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-1.5 text-xs font-bold text-indigo-200 hover:bg-indigo-500/20 disabled:opacity-50"><Copy className="h-3.5 w-3.5" /><span>{lang === 'zh' ? '复制微信 HTML' : 'Copy WeChat HTML'}</span></button>}
                  <button
                    onClick={cancelEditing}
                    disabled={isSaving}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 transition disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {lang === 'zh' ? '取消' : 'Cancel'}
                  </button>
                  <button
                    onClick={() => void handleSave()}
                    disabled={isSaving}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white shadow-sm transition flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                    <span>{isSaving ? (lang === 'zh' ? '保存中...' : 'Saving...') : (lang === 'zh' ? '保存修改' : 'Save changes')}</span>
                  </button>
                </>
              ) : (
                <>
                  {/* 回收站里的文章只读：先恢复，再谈编辑/发布。 */}
                  {article.status === 'trash' && (
                    <span className="self-center text-[12px] font-semibold text-amber-300">
                      {lang === 'zh'
                        ? '这篇文章在回收站里——先恢复它，才能编辑或发布。'
                        : 'This article is in the trash — restore it first.'}
                    </span>
                  )}
                  {apiMode && onUpdateArticle && article.status !== 'trash' && (
                    <button
                      onClick={beginEditing}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition flex items-center gap-1.5"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      <span>{lang === 'zh' ? '编辑文章' : 'Edit article'}</span>
                    </button>
                  )}
                  {article.status !== 'published' && article.status !== 'trash' && (
                    <>
                      <button
                        onClick={() => void handlePublish()}
                        disabled={isPublishing}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm transition flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isPublishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                        <span>{isPublishing ? (lang === 'zh' ? '发布中...' : 'Publishing...') : (lang === 'zh' ? '通过终审并上线' : 'Approve & Publish')}</span>
                      </button>

                      {/* 发布并分发：渠道由服务端按文章所属任务的绑定解析，所以这里不选渠道。
                          按钮上写明去向，避免用户以为它发到了全部渠道。 */}
                      {hasDistributionChannels && onPublishAndDistribute && (
                        <button
                          onClick={() => void handlePublishAndDistribute()}
                          disabled={actionBusy === 'publish-and-distribute' || isPublishing}
                          title={lang === 'zh'
                            ? '发布后投递到本任务已绑定的启用渠道（不改变任务的渠道配置）'
                            : 'Publish, then deliver to this task’s bound active channels'}
                          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {actionBusy === 'publish-and-distribute' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                          <span>{actionBusy === 'publish-and-distribute'
                            ? (lang === 'zh' ? '发布并分发中...' : 'Publishing & distributing...')
                            : (lang === 'zh' ? '发布并分发到已绑渠道' : 'Publish & distribute')}</span>
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
