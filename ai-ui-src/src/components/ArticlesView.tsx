import React, { useState } from 'react';
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
} from 'lucide-react';
import { Article, Category, DistributionChannel } from '../types';

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
  onBatchAction?: (action: 'review' | 'publish' | 'trash' | 'restore' | 'retract', ids: string[]) => Promise<unknown>;
  canBatchWrite?: boolean;
  canBatchPublish?: boolean;
  canManageTrash?: boolean;
  onRestoreArticle?: (id: string) => Promise<void>;
  onForceDeleteArticles?: (ids: string[]) => Promise<void>;
  onEmptyTrash?: () => Promise<void>;
  onExportArticles?: (ids: string[]) => Promise<void>;
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
}) => {
  const canDistribute = distributionAvailable && channels.length > 0;
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<'all' | 'published' | 'review' | 'draft'>('all');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [distributeTargetArticle, setDistributeTargetArticle] = useState<Article | null>(null);
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showTrash, setShowTrash] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState('');

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

  const runBatchAction = async (action: 'review' | 'publish' | 'trash' | 'retract') => {
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
    <div className="space-y-6">
      {/* Header & Stats */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-white flex items-center gap-2">
            <FileText className="w-6 h-6 text-red-500" />
            {lang === 'zh' ? '内容库与质量审核' : 'Content Management & Review'}
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            {lang === 'zh'
              ? '管理已生成文章、把关人工审核道闸（防幻觉），并一键分发到远端 GEO 节点与博客。'
              : 'Audit generated articles, verify factual grounding, and distribute to multi-site endpoints.'}
          </p>
        </div>

        <button
          onClick={() => {
            setCreateError(null);
            setIsNewModalOpen(true);
          }}
          className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/20 transition self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          <span>{lang === 'zh' ? '新建内容' : 'New Article'}</span>
        </button>
      </div>

      {/* Filter Toolbar */}
      <div className="bg-slate-900/80 p-4 rounded-2xl border border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-3">
        {/* Status Tabs */}
        <div className="flex items-center gap-1 bg-slate-800/80 p-1 rounded-xl border border-slate-700/60 overflow-x-auto">
          <button
            onClick={() => setSelectedStatus('all')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition ${
              selectedStatus === 'all' ? 'bg-red-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {lang === 'zh' ? '全部' : 'All'} ({articles.length})
          </button>
          <button
            onClick={() => setSelectedStatus('published')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition ${
              selectedStatus === 'published' ? 'bg-red-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {lang === 'zh' ? '已发布' : 'Published'} ({articles.filter((a) => a.status === 'published').length})
          </button>
          <button
            onClick={() => setSelectedStatus('review')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition ${
              selectedStatus === 'review' ? 'bg-red-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {lang === 'zh' ? '待审核' : 'Review'} ({articles.filter((a) => a.status === 'review').length})
          </button>
          <button
            onClick={() => setSelectedStatus('draft')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition ${
              selectedStatus === 'draft' ? 'bg-red-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {lang === 'zh' ? '草稿' : 'Drafts'} ({articles.filter((a) => a.status === 'draft').length})
          </button>
          {apiMode && canManageTrash && (
            <button
              onClick={() => { setShowTrash(true); setSelectedIds(new Set()); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition ${showTrash ? 'bg-red-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {lang === 'zh' ? '回收站' : 'Trash'} ({trashedArticles.length})
            </button>
          )}
        </div>

        {/* Search & Category */}
        <div className="flex items-center gap-2">
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-xs text-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:border-red-500 transition"
          >
            <option value="all">{lang === 'zh' ? '全部分类' : 'All Categories'}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={lang === 'zh' ? '搜索标题、关键词...' : 'Search articles...'}
              className="bg-slate-800 border border-slate-700 text-xs text-slate-200 rounded-xl pl-8 pr-3 py-2 w-48 sm:w-60 focus:outline-none focus:border-red-500 transition"
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

      {apiMode && !showTrash && onBatchAction && (canBatchWrite || canBatchPublish) && (
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

      {/* Articles Table */}
      <div className="bg-slate-900/80 rounded-2xl border border-slate-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-800/60 text-[11px] font-bold text-slate-400 uppercase tracking-wider border-b border-slate-800">
              <tr>
                <th className="py-3 px-4"><label className="flex items-center gap-2"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label={lang === 'zh' ? '选择当前列表' : 'Select visible'} className="accent-indigo-500" />{lang === 'zh' ? '文章标题' : 'Title'}</label></th>
                <th className="py-3 px-3">{lang === 'zh' ? '分类' : 'Category'}</th>
                <th className="py-3 px-3">{lang === 'zh' ? '状态' : 'Status'}</th>
                <th className="py-3 px-3">{lang === 'zh' ? 'GEO 体检' : 'GEO Score'}</th>
                <th className="py-3 px-3">{lang === 'zh' ? '分发渠道' : 'Distributed'}</th>
                <th className="py-3 px-3">{lang === 'zh' ? '浏览' : 'Views'}</th>
                <th className="py-3 px-3">{lang === 'zh' ? '更新日期' : 'Date'}</th>
                <th className="py-3 px-4 text-right">{lang === 'zh' ? '操作' : 'Actions'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {filteredArticles.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">
                    {lang === 'zh' ? '没有找到符合条件的内容' : 'No articles found'}
                  </td>
                </tr>
              ) : (
                filteredArticles.map((art) => {
                  return (
                    <tr
                      key={art.id}
                      className="hover:bg-slate-800/40 transition group"
                    >
                      <td className="py-3.5 px-4 font-medium text-slate-100 max-w-sm">
                        <div className="flex items-start gap-2">
                          <input type="checkbox" checked={selectedIds.has(art.id)} onChange={() => toggleSelected(art.id)} aria-label={`${lang === 'zh' ? '选择' : 'Select'} ${art.title}`} className="mt-1 accent-indigo-500" />
                          <div
                          onClick={() => onSelectArticle(art)}
                          className="cursor-pointer group-hover:text-red-400 transition font-bold line-clamp-1"
                        >
                          {art.title}
                          </div>
                        </div>
                        <div className="pl-6 text-[11px] text-slate-400 line-clamp-1 mt-0.5">
                          {art.summary}
                        </div>
                      </td>
                      <td className="py-3.5 px-3 whitespace-nowrap">
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                          {art.category}
                        </span>
                      </td>
                      <td className="py-3.5 px-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full ${
                            art.status === 'published'
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                              : art.status === 'review'
                              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                              : 'bg-slate-700/60 text-slate-300'
                          }`}
                        >
                          {art.status === 'published' ? (
                            <>
                              <CheckCircle2 className="w-3 h-3" />
                              <span>{lang === 'zh' ? '已上线' : 'Live'}</span>
                            </>
                          ) : art.status === 'review' ? (
                            <>
                              <Clock className="w-3 h-3" />
                              <span>{lang === 'zh' ? '待审核' : 'Review'}</span>
                            </>
                          ) : (
                            <span>{lang === 'zh' ? '草稿' : 'Draft'}</span>
                          )}
                        </span>
                      </td>
                      <td className="py-3.5 px-3 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => onSelectArticle(art)}
                          className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border border-slate-700 text-slate-400 transition hover:border-red-500/40 hover:text-red-300"
                          title={lang === 'zh' ? '查看服务端质检、复检与优化操作' : 'View server quality, recheck and optimization actions'}
                        >
                          <ShieldCheck className="w-3 h-3" />
                          <span>{art.aiQualityStatus || (lang === 'zh' ? '后端未质检' : 'Not inspected')}</span>
                        </button>
                      </td>
                      <td className="py-3.5 px-3 whitespace-nowrap">
                        {art.distributedTo && art.distributedTo.length > 0 ? (
                          <span className="text-purple-400 flex items-center gap-1 font-semibold">
                            <Radio className="w-3 h-3" />
                            <span>{art.distributedTo.length} {lang === 'zh' ? '个渠道' : 'nodes'}</span>
                          </span>
                        ) : (
                          <span className="text-slate-400">{lang === 'zh' ? '未分发' : 'None'}</span>
                        )}
                      </td>
                      <td className="py-3.5 px-3 text-slate-400 whitespace-nowrap">
                        {art.views || 0}
                      </td>
                      <td className="py-3.5 px-3 text-slate-400 whitespace-nowrap">
                        {art.createdAt}
                      </td>
                      <td className="py-3.5 px-4 text-right whitespace-nowrap space-x-2">
                        <button
                          onClick={() => onSelectArticle(art)}
                          className="text-blue-400 hover:text-blue-300 p-1 hover:bg-slate-800 rounded transition"
                          title={lang === 'zh' ? 'GEO 深度体检与一键优化' : 'GEO Auditor'}
                        >
                          <ShieldCheck className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => onSelectArticle(art)}
                          className="text-slate-300 hover:text-white p-1 hover:bg-slate-800 rounded transition"
                          title={lang === 'zh' ? '查看与阅读' : 'Read'}
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        {canDistribute && <button
                          onClick={() => setDistributeTargetArticle(art)}
                          className="text-purple-400 hover:text-purple-300 p-1 hover:bg-slate-800 rounded transition"
                          title={lang === 'zh' ? '一键分发到渠道' : 'Distribute'}
                        >
                          <Radio className="w-4 h-4" />
                        </button>}
                        {showTrash ? (
                          <button
                            onClick={() => void runTrashAction('force-delete', [art.id])}
                            className="text-slate-400 hover:text-rose-400 p-1 hover:bg-slate-800 rounded transition"
                            title={lang === 'zh' ? '永久删除' : 'Delete permanently'}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        ) : (
                          <button
                            onClick={() => onDeleteArticle(art.id)}
                            className="text-slate-400 hover:text-rose-400 p-1 hover:bg-slate-800 rounded transition"
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
                <Plus className="w-5 h-5 text-red-500" />
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
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition"
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
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition"
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
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 transition font-mono resize-none"
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
                className="px-4 py-1.5 rounded-lg text-xs font-bold bg-red-600 hover:bg-red-500 text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isCreating ? (lang === 'zh' ? '保存中...' : 'Saving...') : (lang === 'zh' ? '保存草稿' : 'Save Draft')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
