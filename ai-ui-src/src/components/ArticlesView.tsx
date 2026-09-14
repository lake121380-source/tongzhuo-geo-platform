import React, { useEffect, useState } from 'react';
import {
  FileText,
  Search,
  Plus,
  Eye,
  Trash2,
  Radio,
  CheckCircle2,
  Clock,
  ExternalLink,
  Edit,
  Tag,
  X,
  Loader2,
  AlertCircle,
  ShieldCheck,
  CheckSquare,
  Sparkles,
} from 'lucide-react';
import { Article, Category, DistributionChannel, KnowledgeBase, Task } from '../types';
import { AiGenerateModal, AiGenerateCatalog } from './AiGenerateModal';
import { ArticleReviewMode } from './ArticleReviewMode';
import { StatusBadge, articleStatusSpec, qualityStatusSpec } from './StatusBadge';
import { Skeleton, SkeletonRows } from './Skeleton';
import { PageHeader } from './PageHeader';
import { Button, EmptyState } from './ui';

interface ArticlesViewProps {
  articles: Article[];
  trashedArticles?: Article[];
  categories: Category[];
  channels: DistributionChannel[];
  onSelectArticle: (article: Article) => void;
  onDeleteArticle: (id: string) => void;
  onDistributeArticle: (id: string, channelIds: string[]) => void;
  onCreateArticle: (art: Partial<Article>) => void | Promise<void>;
  lang: 'zh' | 'en';
  /** Disable client-side demo audit/distribution controls for API mode. */
  apiMode?: boolean;
  distributionAvailable?: boolean;
  /** Batch actions use the governed 桐灼GEO API; demo mode leaves them hidden. */
  onBatchAction?: (action: 'review' | 'reject' | 'publish' | 'trash' | 'restore' | 'retract', ids: string[]) => Promise<unknown>;
  canBatchWrite?: boolean;
  canBatchPublish?: boolean;
  canManageTrash?: boolean;
  onRestoreArticle?: (id: string) => Promise<void>;
  onForceDeleteArticles?: (ids: string[]) => Promise<void>;
  onEmptyTrash?: () => Promise<void>;
  onExportArticles?: (ids: string[]) => Promise<void>;
  /** 「AI 生成」弹窗需要的能力与数据，由 App 层透传。 */
  apiCatalog?: AiGenerateCatalog;
  knowledgeBases?: KnowledgeBase[];
  onCreateTask?: (task: Partial<Task> & Record<string, unknown>) => void | Promise<void>;
  onCheckTitleReadiness?: (params: Record<string, string | number | undefined>) => Promise<Record<string, unknown>>;
  canGenerate?: boolean;
  /** 人工放行（质检判定为「待人工复核」时唯一的出路）。 */
  onReleaseArticle?: (id: string, reason: string) => Promise<unknown>;
  /** 进行中的一次性生成任务；非空时列表顶部显示「生成中」占位。 */
  generatingTasks?: Task[];
  onNavigate?: (tab: string) => void;
  /**
   * 由总览的「开始使用」向导请求直接打开 AI 生成弹窗。
   * App 用一次性令牌传进来、处理完立刻清掉，避免之后每次渲染都重开。
   */
  autoOpenAiGenerate?: boolean;
  onAutoOpenGenerateHandled?: () => void;
  /**
   * 首轮数据是否还在读取。为 true 时表格显示骨架行、计数显示「…」，
   * 而不是把「还没读到」画成「0 篇 / 没有找到符合条件的内容」。
   */
  loading?: boolean;
}

export const ArticlesView: React.FC<ArticlesViewProps> = ({
  articles,
  trashedArticles = [],
  categories,
  channels,
  onSelectArticle,
  onDeleteArticle,
  onDistributeArticle,
  onCreateArticle,
  lang,
  apiMode = false,
  distributionAvailable = true,
  onBatchAction,
  canBatchWrite = false,
  canBatchPublish = false,
  canManageTrash = false,
  onRestoreArticle,
  onForceDeleteArticles,
  onEmptyTrash,
  onExportArticles,
  apiCatalog,
  knowledgeBases = [],
  onCreateTask,
  onCheckTitleReadiness,
  canGenerate = false,
  onReleaseArticle,
  generatingTasks = [],
  onNavigate,
  autoOpenAiGenerate = false,
  onAutoOpenGenerateHandled,
  loading = false,
}) => {
  const canDistribute = distributionAvailable && channels.length > 0;
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<'all' | 'published' | 'review' | 'draft'>('all');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [distributeTargetArticle, setDistributeTargetArticle] = useState<Article | null>(null);
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [isAiGenerateOpen, setIsAiGenerateOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showTrash, setShowTrash] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState('');
  const [isReviewMode, setIsReviewMode] = useState(false);

  // 总览向导的「创建第一个生成任务」落到这里：打开已有的 AI 生成弹窗，
  // 而不是再造一套表单——那个弹窗已经会自动带入知识库与标题库的首选项。
  useEffect(() => {
    if (!autoOpenAiGenerate) return;
    setIsAiGenerateOpen(true);
    onAutoOpenGenerateHandled?.();
  }, [autoOpenAiGenerate, onAutoOpenGenerateHandled]);

  // New Article Form state
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState('科技资讯');
  const [newContent, setNewContent] = useState('');

  // Automated Tagging & SEO Keywords state
  const [newTags, setNewTags] = useState<string[]>(['GEO优化']);
  const [tagInput, setTagInput] = useState('');
  const [tagError, setTagError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const sourceArticles = showTrash ? trashedArticles : articles;
  const filteredArticles = sourceArticles.filter((art) => {
    if (selectedStatus !== 'all' && art.status !== selectedStatus) return false;
    if (selectedCategory !== 'all' && art.category !== selectedCategory) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      return (
        art.title.toLowerCase().includes(q) ||
        art.summary.toLowerCase().includes(q) ||
        art.seoKeywords.some((k) => k.toLowerCase().includes(q))
      );
    }
    return true;
  });

  const visibleIds = filteredArticles.map((article) => article.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

  /**
   * 加载中的计数显示「…」而不是 0：0 是「确认没有」，而此刻只是「还没读到」。
   * 冒烟测试读这个计数前必须先等数据落定（ui-smoke.mjs 的 waitForDataSettled）。
   */
  const countLabel = (value: number) => (loading ? '…' : String(value));

  const toggleSelected = (id: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const runBatchAction = async (action: 'review' | 'reject' | 'publish' | 'trash' | 'retract') => {
    const ids = visibleIds.filter((id) => selectedIds.has(id));
    if (!onBatchAction || ids.length === 0) return;
    if (action === 'trash' && !window.confirm(lang === 'zh' ? `确定将选中的 ${ids.length} 篇文章移入回收站吗？` : `Move ${ids.length} articles to trash?`)) return;
    // 撤回会把已发布的文章从公开站点撤下来，先说清楚再动手。
    if (action === 'retract' && !window.confirm(lang === 'zh' ? `确定把选中的 ${ids.length} 篇文章撤回为草稿吗？已发布的会从公开站点撤下。` : `Retract ${ids.length} articles to draft? Published ones will be removed from the public site.`)) return;
    setBatchBusy(true);
    setBatchError('');
    try {
      const raw = await onBatchAction(action, ids);
      const result = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const succeeded = Number(result.succeeded_count || 0);
      const failed = Number(result.failed_count || 0);
      window.alert(lang === 'zh'
        ? `批量${action === 'review' ? '审核' : action === 'publish' ? '发布' : action === 'retract' ? '撤回' : '回收'}完成：成功 ${succeeded}，失败 ${failed}`
        : `Batch action complete: ${succeeded} succeeded, ${failed} failed.`);
      setSelectedIds(new Set());
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : (lang === 'zh' ? '批量操作失败' : 'Batch action failed'));
    } finally {
      setBatchBusy(false);
    }
  };

  const runTrashAction = async (action: 'restore' | 'force-delete' | 'empty' | 'export', actionIds?: string[]) => {
    const ids = actionIds || visibleIds.filter((id) => selectedIds.has(id));
    if (action === 'empty') {
      if (!onEmptyTrash || trashedArticles.length === 0) return;
      if (!window.confirm(lang === 'zh' ? '确定永久清空文章回收站吗？此操作不可撤销。' : 'Empty the article trash permanently? This cannot be undone.')) return;
    } else if (ids.length === 0) {
      return;
    } else if (action === 'force-delete' && !window.confirm(lang === 'zh' ? `确定永久删除选中的 ${ids.length} 篇文章吗？` : `Permanently delete ${ids.length} selected articles?`)) {
      return;
    }
    setBatchBusy(true);
    setBatchError('');
    try {
      if (action === 'restore') await Promise.all(ids.map((id) => onRestoreArticle?.(id)));
      if (action === 'force-delete') await onForceDeleteArticles?.(ids);
      if (action === 'empty') await onEmptyTrash?.();
      if (action === 'export') await onExportArticles?.(ids);
      setSelectedIds(new Set());
    } catch (error) {
      setBatchError(error instanceof Error ? error.message : (lang === 'zh' ? '回收站操作失败' : 'Trash action failed'));
    } finally {
      setBatchBusy(false);
    }
  };

  const handleAddTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed || newTags.includes(trimmed)) return;
    setNewTags([...newTags, trimmed]);
    setTagInput('');
    setTagError(null);
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setNewTags(newTags.filter((t) => t !== tagToRemove));
  };

  const handleTagInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      handleAddTag(tagInput);
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      await onCreateArticle({
        title: newTitle,
        category: newCategory,
        content: newContent,
        summary: newContent.slice(0, 140) + '...',
        author: '桐灼GEO 团队',
        status: 'draft',
        seoKeywords: newTags.length > 0 ? newTags : ['GEO优化', newCategory],
      });

      setNewTitle('');
      setNewContent('');
      setNewTags(['GEO优化']);
      setTagInput('');
      setTagError(null);
      setIsNewModalOpen(false);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : (lang === 'zh' ? '创建文章失败' : 'Unable to create article'));
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Header & Stats */}
      <PageHeader
        icon={FileText}
        group={lang === 'zh' ? '内容中心' : 'Content'}
        title={lang === 'zh' ? '文章' : 'Articles'}
        description={lang === 'zh'
          ? 'AI 生成、手动新建、审核、发布——内容都从这一页流转。生成一篇约 1 分钟，完成后会出现在列表里等你审核。'
          : 'Generate, review and publish content. AI generation takes about a minute; the draft then appears here for review.'}
        actions={<>
          {/* 待审核文章数量 > 0 时，显示「开启审核模式」按钮 */}
          {!showTrash && articles.filter((a) => a.status === 'review').length > 0 && (
            <button
              onClick={() => setIsReviewMode(true)}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition"
            >
              <CheckSquare className="w-4 h-4" />
              <span>{lang === 'zh' ? '开启审核模式' : 'Review Mode'}</span>
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-white/20 text-[10px] font-bold">
                {articles.filter((a) => a.status === 'review').length}
              </span>
            </button>
          )}
          {/* 手动新建：把 Markdown 正文粘进来直接建档。少用，放次按钮。 */}
          <button
            onClick={() => {
              setCreateError(null);
              setIsNewModalOpen(true);
            }}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-bold border border-slate-700 bg-slate-800/60 text-slate-200 hover:bg-slate-800 transition"
          >
            <Plus className="w-4 h-4" />
            <span>{lang === 'zh' ? '手动新建' : 'New Article'}</span>
          </button>
          {/* AI 生成：这一页的主操作（产品的主链路就是「让 AI 写」）。 */}
          {canGenerate && (
            <button
              onClick={() => setIsAiGenerateOpen(true)}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm transition"
            >
              <Sparkles className="w-4 h-4" />
              <span>{lang === 'zh' ? 'AI 生成文章' : 'Generate with AI'}</span>
            </button>
          )}
        </>}
      />

      {/* 筛选与搜索：状态用带计数的小胶囊，搜索/分类靠右。
          这一段**不再包卡片**——它属于页头下方的「控制条」，再套一层卡片就是典型的「卡片堆砌」。
          点任意状态页签会**退出回收站视图**（原来点「全部」仍停在回收站，是审计里的 P0 陷阱）。 */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-1 overflow-x-auto rounded-xl bg-slate-800/50 p-1.5">
          {([
            { key: 'all' as const, label: lang === 'zh' ? '全部' : 'All', count: articles.length },
            { key: 'review' as const, label: lang === 'zh' ? '待审核' : 'Review', count: articles.filter((a) => a.status === 'review').length },
            { key: 'published' as const, label: lang === 'zh' ? '已发布' : 'Published', count: articles.filter((a) => a.status === 'published').length },
            { key: 'draft' as const, label: lang === 'zh' ? '草稿' : 'Drafts', count: articles.filter((a) => a.status === 'draft').length },
          ]).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => { setSelectedStatus(tab.key); setShowTrash(false); }}
              className={`whitespace-nowrap rounded-lg px-3.5 py-2 text-[13px] font-semibold transition ${
                !showTrash && selectedStatus === tab.key ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-900'
              }`}
            >
              {tab.label} ({countLabel(tab.count)})
            </button>
          ))}
          {apiMode && canManageTrash && (
            <button
              type="button"
              onClick={() => { setShowTrash(true); setSelectedIds(new Set()); }}
              className={`whitespace-nowrap rounded-lg px-3.5 py-2 text-[13px] font-semibold transition ${showTrash ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-900'}`}
            >
              {lang === 'zh' ? '回收站' : 'Trash'} ({countLabel(trashedArticles.length)})
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="h-10 rounded-xl border border-slate-700 bg-slate-800 px-3 text-[13px] text-slate-200 outline-none transition focus:border-indigo-500"
          >
            <option value="all">{lang === 'zh' ? '全部分类' : 'All Categories'}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>

          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={lang === 'zh' ? '搜索标题、关键词…' : 'Search articles...'}
              className="h-10 w-full rounded-xl border border-slate-700 bg-slate-800 pl-10 pr-3 text-[13px] text-slate-200 outline-none transition focus:border-indigo-500 sm:w-64"
            />
          </div>
        </div>
      </div>

      {apiMode && showTrash && canManageTrash && (
        <div className="flex flex-col gap-2 rounded-xl border border-rose-500/25 bg-rose-500/5 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <Trash2 className="h-4 w-4 text-rose-300" />
            <span>{lang === 'zh' ? `回收站中 ${selectedIds.size} 篇已选择` : `${selectedIds.size} selected in trash`}</span>
            <button type="button" onClick={toggleAllVisible} className="text-rose-300 underline underline-offset-2 hover:text-rose-200">
              {allVisibleSelected ? (lang === 'zh' ? '取消全选' : 'Clear visible') : (lang === 'zh' ? '选择当前列表' : 'Select visible')}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={batchBusy || selectedIds.size === 0} onClick={() => void runTrashAction('restore')} className="rounded-lg border border-emerald-500/30 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-200 disabled:opacity-40">{lang === 'zh' ? '恢复选中' : 'Restore selected'}</button>
            <button type="button" disabled={batchBusy || selectedIds.size === 0} onClick={() => void runTrashAction('export')} className="rounded-lg border border-indigo-500/30 px-2.5 py-1.5 text-[11px] font-semibold text-indigo-200 disabled:opacity-40">{lang === 'zh' ? '导出 Markdown' : 'Export Markdown'}</button>
            <button type="button" disabled={batchBusy || selectedIds.size === 0} onClick={() => void runTrashAction('force-delete')} className="rounded-lg border border-rose-500/30 px-2.5 py-1.5 text-[11px] font-semibold text-rose-200 disabled:opacity-40">{lang === 'zh' ? '永久删除' : 'Delete permanently'}</button>
            <button type="button" disabled={batchBusy || trashedArticles.length === 0} onClick={() => void runTrashAction('empty')} className="rounded-lg bg-rose-600/80 px-2.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-40">{lang === 'zh' ? '清空回收站' : 'Empty trash'}</button>
            <button type="button" onClick={() => { setShowTrash(false); setSelectedIds(new Set()); }} className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-300">{lang === 'zh' ? '返回文章' : 'Back to articles'}</button>
          </div>
        </div>
      )}

      {/* 批量操作条：只在真的选了文章时出现。
          原来「已选择 0 篇 + 一排禁用的按钮」常驻在列表上方，既占地方又像坏了。 */}
      {apiMode && !showTrash && onBatchAction && (canBatchWrite || canBatchPublish) && selectedIds.size > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-indigo-500/25 bg-indigo-500/5 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <CheckSquare className="h-4 w-4 text-indigo-300" />
            <span>{lang === 'zh' ? `已选择 ${selectedIds.size} 篇` : `${selectedIds.size} selected`}</span>
            <button type="button" onClick={toggleAllVisible} className="text-indigo-300 underline underline-offset-2 hover:text-indigo-200">
              {allVisibleSelected ? (lang === 'zh' ? '取消全选' : 'Clear visible') : (lang === 'zh' ? '选择当前列表' : 'Select visible')}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canBatchPublish && <button type="button" disabled={batchBusy || selectedIds.size === 0} onClick={() => void runBatchAction('review')} className="rounded-lg border border-amber-500/30 px-2.5 py-1.5 text-[11px] font-semibold text-amber-200 disabled:opacity-40">{lang === 'zh' ? '批量审核通过' : 'Approve selected'}</button>}
            {canBatchPublish && <button type="button" disabled={batchBusy || selectedIds.size === 0} onClick={() => void runBatchAction('publish')} className="rounded-lg border border-emerald-500/30 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-200 disabled:opacity-40">{lang === 'zh' ? '批量发布' : 'Publish selected'}</button>}
            {/* 撤回成草稿：旧后台有、新后台原先缺失的那条路径（补于 2026-09-12）。
                要注意它和「回收」不是一回事——回收进回收站，撤回是留在列表里改回草稿。 */}
            {canBatchPublish && <button type="button" disabled={batchBusy || selectedIds.size === 0} onClick={() => void runBatchAction('retract')} className="rounded-lg border border-slate-500/40 px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 disabled:opacity-40">{lang === 'zh' ? '撤回为草稿' : 'Retract to draft'}</button>}
            {canBatchWrite && <button type="button" disabled={batchBusy || selectedIds.size === 0} onClick={() => void runBatchAction('trash')} className="rounded-lg border border-rose-500/30 px-2.5 py-1.5 text-[11px] font-semibold text-rose-200 disabled:opacity-40">{batchBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}{lang === 'zh' ? '批量回收' : 'Trash selected'}</button>}
          </div>
        </div>
      )}
      {batchError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{batchError}</div>}

      {/* 「生成中」占位：一次性生成任务还没产出完，就占一条横幅，用户不用去「生成任务」页看进度。 */}
      {!showTrash && generatingTasks.length > 0 && (
        <div className="rounded-xl border border-indigo-500/25 bg-indigo-500/5 p-3 space-y-2">
          {generatingTasks.map((task) => (
            <div key={task.id} className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-slate-300 min-w-0">
                <Loader2 className="h-4 w-4 animate-spin text-indigo-300 shrink-0" />
                <span className="truncate">
                  {lang === 'zh'
                    ? `正在生成 ${Math.max(1, task.batchLimit - task.generatedCount)} 篇 · 「${task.name}」…`
                    : `Generating ${Math.max(1, task.batchLimit - task.generatedCount)} · "${task.name}"…`}
                </span>
              </div>
              {onNavigate && (
                <button
                  type="button"
                  onClick={() => onNavigate('tasks')}
                  className="shrink-0 text-[11px] text-indigo-300 underline underline-offset-2 hover:text-indigo-200"
                >
                  {lang === 'zh' ? '查看任务 →' : 'View task →'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Articles Table */}
      <div className="overflow-hidden rounded-2xl bg-slate-900/80">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="border-b border-slate-800 bg-slate-800/40 text-[12.5px] font-semibold text-slate-400">
              <tr>
                <th className="px-4 py-3.5"><label className="flex items-center gap-2"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label={lang === 'zh' ? '选择当前列表' : 'Select visible'} className="accent-indigo-500" />{lang === 'zh' ? '文章标题' : 'Title'}</label></th>
                <th className="px-3 py-3.5">{lang === 'zh' ? '分类' : 'Category'}</th>
                <th className="px-3 py-3.5">{lang === 'zh' ? '状态' : 'Status'}</th>
                <th className="px-3 py-3.5">{lang === 'zh' ? 'AI 质检' : 'AI Check'}</th>
                <th className="px-3 py-3.5">{lang === 'zh' ? '分发渠道' : 'Distributed'}</th>
                <th className="px-3 py-3.5">{lang === 'zh' ? '浏览' : 'Views'}</th>
                <th className="px-3 py-3.5">{lang === 'zh' ? '更新日期' : 'Date'}</th>
                <th className="px-4 py-3.5 text-right">{lang === 'zh' ? '操作' : 'Actions'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {loading ? (
                /* 首轮数据还没到：骨架行。画「没有找到符合条件的内容」会把
                   「还在读」说成「确认没有」——这正是 P1 修的那类假空态。 */
                <tr>
                  <td colSpan={8} className="py-8 px-6">
                    <SkeletonRows rows={4} />
                  </td>
                </tr>
              ) : filteredArticles.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    {/* 空态给「下一步」：没有内容时直接给生成入口，筛不出来时告诉用户换个条件 */}
                    <EmptyState
                      compact
                      icon={FileText}
                      title={sourceArticles.length === 0 && !showTrash
                        ? (lang === 'zh' ? '还没有文章' : 'No articles yet')
                        : (lang === 'zh' ? '没有符合条件的文章' : 'No matching articles')}
                      description={sourceArticles.length === 0 && !showTrash
                        ? (lang === 'zh' ? 'AI 生成一篇约 1 分钟：选好标题库与知识库即可。' : 'Generating one takes about a minute.')
                        : (lang === 'zh' ? '试试清空搜索词或换一个状态/分类。' : 'Try clearing the search or changing filters.')}
                      action={sourceArticles.length === 0 && !showTrash && canGenerate ? (
                        <Button variant="primary" icon={Sparkles} onClick={() => setIsAiGenerateOpen(true)}>
                          {lang === 'zh' ? 'AI 生成文章' : 'Generate with AI'}
                        </Button>
                      ) : undefined}
                    />
                  </td>
                </tr>
              ) : (
                filteredArticles.map((art) => {
                  return (
                    <tr
                      key={art.id}
                      className={`group transition ${selectedIds.has(art.id) ? 'bg-indigo-500/[0.06]' : 'hover:bg-slate-800/40'}`}
                    >
                      <td className="max-w-sm px-4 py-4 font-medium text-slate-100">
                        <div className="flex items-start gap-2">
                          <input type="checkbox" checked={selectedIds.has(art.id)} onChange={() => toggleSelected(art.id)} aria-label={`${lang === 'zh' ? '选择' : 'Select'} ${art.title}`} className="mt-1 accent-indigo-500" />
                          <div
                          onClick={() => onSelectArticle(art)}
                          className="cursor-pointer truncate text-[14px] font-semibold text-white transition group-hover:text-indigo-600"
                        >
                          {art.title}
                          </div>
                        </div>
                        <div className="mt-1 line-clamp-1 pl-6 text-[12.5px] text-slate-400">
                          {art.summary}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-4">
                        <span className="rounded-md bg-slate-800 px-2 py-1 text-[12px] text-slate-300">
                          {art.category}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-4">
                        <StatusBadge
                          spec={articleStatusSpec(art.status)}
                          lang={lang}
                          icon={art.status === 'published'
                            ? <CheckCircle2 className="w-3 h-3" />
                            : art.status === 'review' ? <Clock className="w-3 h-3" /> : undefined}
                        />
                      </td>
                      <td className="whitespace-nowrap px-3 py-4">
                        <button
                          type="button"
                          onClick={() => onSelectArticle(art)}
                          className="transition hover:opacity-75"
                          title={lang === 'zh' ? '查看服务端质检、复检与优化操作' : 'View server quality, recheck and optimization actions'}
                        >
                          <StatusBadge spec={qualityStatusSpec(art.aiQualityStatus, art.aiQualityDecision)} lang={lang} icon={<ShieldCheck className="w-3 h-3" />} />
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-3 py-4">
                        {art.distributedTo && art.distributedTo.length > 0 ? (
                          <span className="flex items-center gap-1 text-[12.5px] font-semibold text-indigo-600">
                            <Radio className="w-3 h-3" />
                            <span>{art.distributedTo.length} {lang === 'zh' ? '个渠道' : 'nodes'}</span>
                          </span>
                        ) : (
                          <span className="text-slate-400">{lang === 'zh' ? '未分发' : 'None'}</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-4 text-slate-400">
                        {art.views || 0}
                      </td>
                      <td className="whitespace-nowrap px-3 py-4 text-slate-400">
                        {art.createdAt}
                      </td>
                      <td className="px-4 py-4 text-right whitespace-nowrap">
                        {/* 「查看」（原先是 GEO 体检 + 阅读两个图标，点开的是同一个弹窗，合并成一个）。 */}
                        <button
                          onClick={() => onSelectArticle(art)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-white"
                          title={lang === 'zh' ? '查看与编辑（含质检与优化）' : 'View & edit (quality included)'}
                          aria-label={lang === 'zh' ? '查看文章' : 'View article'}
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        {canDistribute && <button
                          onClick={() => setDistributeTargetArticle(art)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-indigo-600"
                          title={lang === 'zh' ? '一键分发到渠道' : 'Distribute'}
                        >
                          <Radio className="w-4 h-4" />
                        </button>}
                        {showTrash ? (
                          <button
                            onClick={() => void runTrashAction('force-delete', [art.id])}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-rose-500/10 hover:text-rose-500"
                            title={lang === 'zh' ? '永久删除' : 'Delete permanently'}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        ) : (
                          <button
                            onClick={() => onDeleteArticle(art.id)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-rose-500/10 hover:text-rose-500"
                            title={lang === 'zh' ? '删除' : 'Delete'}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Distribute Modal */}
      {canDistribute && distributeTargetArticle && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Radio className="w-5 h-5 text-purple-400" />
                <span>{lang === 'zh' ? '多端渠道分发' : 'Distribute Article'}</span>
              </h3>
              <button
                onClick={() => setDistributeTargetArticle(null)}
                className="text-slate-400 hover:text-slate-200 text-sm"
              >
                ✕
              </button>
            </div>

            <div className="text-xs text-slate-300">
              {lang === 'zh' ? '目标文章：' : 'Target:'}{' '}
              <strong className="text-white">{distributeTargetArticle.title}</strong>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-400">
                {lang === 'zh' ? '选择要分发的目标节点：' : 'Select Target Channels:'}
              </label>
              {channels.map((ch) => (
                <div
                  key={ch.id}
                  className="p-3 bg-slate-800/60 border border-slate-700/60 rounded-xl flex items-center justify-between"
                >
                  <div>
                    <div className="text-xs font-bold text-slate-200">{ch.name}</div>
                    <div className="text-[11px] text-slate-400">{ch.targetUrl}</div>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    {ch.type}
                  </span>
                </div>
              ))}
            </div>

            <div className="pt-3 border-t border-slate-800 flex justify-end gap-2">
              <button
                onClick={() => setDistributeTargetArticle(null)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                {lang === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button
                onClick={() => {
                  // 桐灼GEO resolves the task's approved channel set server-side.
                  // Sending every globally visible channel would bypass that task
                  // boundary and can legitimately be rejected by the API.
                  onDistributeArticle(
                    distributeTargetArticle.id,
                    apiMode ? [] : channels.map((c) => c.id),
                  );
                  setDistributeTargetArticle(null);
                }}
                className="px-4 py-1.5 rounded-lg text-xs font-bold bg-purple-600 hover:bg-purple-500 text-white shadow-sm"
              >
                {lang === 'zh' ? '立即全网分发' : 'Push to Channels'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New Article Modal */}
      {isNewModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateSubmit}
            className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Plus className="w-5 h-5 text-indigo-600" />
                <span>{lang === 'zh' ? '手动新建内容' : 'Create Article'}</span>
              </h3>
              <button
                type="button"
                onClick={() => !isCreating && setIsNewModalOpen(false)}
                disabled={isCreating}
                className="text-slate-400 hover:text-slate-200 text-sm"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">
                  {lang === 'zh' ? '标题' : 'Title'} *
                </label>
                <input
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                  placeholder="e.g. 2026年企业级知识库向量化实战"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">
                  {lang === 'zh' ? '分类' : 'Category'}
                </label>
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">
                  {lang === 'zh' ? '文章内容 (支持 GFM Markdown)' : 'Content (Markdown)'} *
                </label>
                <textarea
                  required
                  rows={6}
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500 transition font-mono resize-none"
                  placeholder="# 一级标题&#10;&#10;输入正文 Markdown 内容..."
                />
              </div>

              {/* SEO Keywords & Automated Tagging */}
              <div className="space-y-2.5 bg-slate-950/60 p-4 rounded-xl border border-slate-800">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Tag className="w-4 h-4 text-red-400" />
                    <span className="text-xs font-bold text-slate-200">
                      {lang === 'zh' ? 'SEO / GEO 关键词标签' : 'SEO / GEO Keywords & Tags'}
                    </span>
                    <span className="text-[11px] text-slate-400 font-mono">
                      ({newTags.length})
                    </span>
                  </div>

                  {apiMode && (
                    <span className="text-[11px] text-slate-500">
                      {lang === 'zh'
                        ? '桐灼GEO API v1 未提供自动关键词建议，可手动添加标签'
                        : 'Automatic keyword suggestions are not exposed; add tags manually'}
                    </span>
                  )}
                </div>

                {/* Tag Error notification */}
                {tagError && (
                  <div className="text-xs text-rose-400 bg-rose-950/40 border border-rose-900/50 p-2 rounded-lg flex items-center gap-2">
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>{tagError}</span>
                  </div>
                )}

                {/* Active tags display & tag input */}
                <div className="flex flex-wrap items-center gap-1.5 min-h-[38px] p-2 bg-slate-900/90 rounded-xl border border-slate-800">
                  {newTags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-slate-800 text-slate-200 border border-slate-700/80 group"
                    >
                      <span>{tag}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveTag(tag)}
                        className="text-slate-400 hover:text-red-400 transition"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}

                  <div className="flex items-center gap-1 flex-1 min-w-[140px]">
                    <input
                      type="text"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={handleTagInputKeyDown}
                      placeholder={lang === 'zh' ? '输入标签按回车添加...' : 'Type tag & press Enter...'}
                      className="w-full bg-transparent text-xs text-white placeholder:text-slate-400 focus:outline-none px-1 py-0.5"
                    />
                    {tagInput.trim() && (
                      <button
                        type="button"
                        onClick={() => handleAddTag(tagInput)}
                        className="text-[11px] px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-white transition whitespace-nowrap"
                      >
                        {lang === 'zh' ? '添加' : 'Add'}
                      </button>
                    )}
                  </div>
                </div>

              </div>
            </div>

            <div className="pt-3 border-t border-slate-800 flex justify-end gap-2">
              {createError && (
                <div role="alert" className="mr-auto max-w-[65%] rounded-lg border border-red-500/30 bg-red-950/40 px-3 py-1.5 text-xs text-red-200">
                  {createError}
                </div>
              )}
              <button
                type="button"
                onClick={() => !isCreating && setIsNewModalOpen(false)}
                disabled={isCreating}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                {lang === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={isCreating}
                className="px-4 py-1.5 rounded-lg text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isCreating ? (lang === 'zh' ? '保存中...' : 'Saving...') : (lang === 'zh' ? '保存草稿' : 'Save Draft')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* AI 生成弹窗 */}
      {isAiGenerateOpen && (
        <AiGenerateModal
          knowledgeBases={knowledgeBases}
          apiCatalog={apiCatalog}
          onCreateTask={onCreateTask}
          onCheckTitleReadiness={onCheckTitleReadiness}
          onNavigate={onNavigate}
          onClose={() => setIsAiGenerateOpen(false)}
          canRead={canGenerate}
          canWrite={canGenerate}
          lang={lang}
        />
      )}

      {/* 批量审核模式 */}
      {isReviewMode && onBatchAction && (
        <ArticleReviewMode
          articles={articles.filter((a) => a.status === 'review')}
          // 必须**返回**批量结果：连续审核模式要靠 failed 判据才能不谎报成功。
          onReview={(id, action) => onBatchAction(action === 'approve' ? 'review' : 'reject', [id])}
          onReleaseArticle={onReleaseArticle}
          onClose={() => setIsReviewMode(false)}
          lang={lang}
        />
      )}
    </div>
  );
};
