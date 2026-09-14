import React, { useEffect, useRef, useState } from 'react';
import { Database, Plus, Search, Layers, CheckCircle2, FileCode, Zap, AlertTriangle, RefreshCw, History, ImagePlus, Power } from 'lucide-react';
import { KnowledgeBase, KnowledgeChunk } from '../types';
import PermissionNotice from './PermissionNotice';
import { describeApiError } from '../api/permissions';
import { GeoFlowApiClient } from '../api/geoflowClient';
import { mapKnowledgeBase } from '../api/mappers';
import KnowledgeFactWorkbench from './KnowledgeFactWorkbench';
import EnterpriseKnowledgeView from './EnterpriseKnowledgeView';
import { StatusBadge, kbStatusSpec } from './StatusBadge';
import { PageHeader } from './PageHeader';
import { EmptyState } from './ui';

const EMPTY_KNOWLEDGE_BASES: KnowledgeBase[] = [];
const EMPTY_KNOWLEDGE_CHUNKS: KnowledgeChunk[] = [];

interface KnowledgeViewProps {
  knowledgeBases: KnowledgeBase[];
  chunks: KnowledgeChunk[];
  onCreateKb: (name: string, description: string, content: string) => void | Promise<void>;
  lang: 'zh' | 'en';
  /** In API mode only capabilities exposed by 桐灼GEO are shown as usable. */
  apiMode?: boolean;
  /** Real 桐灼GEO retrieval tester. Omitted only for the legacy demo mode. */
  onSearchKnowledgeBase?: (knowledgeBaseId: string, query: string, limit?: number) => Promise<any[]>;
  /** Per-library errors while loading asynchronously generated chunks. */
  chunkLoadErrors?: Record<string, string>;
  /** Knowledge-base read/search scope. */
  canRead?: boolean;
  /** Knowledge-base and material write scope. */
  canWrite?: boolean;
  /** Server-reported total; omitted means the total is unknown. */
  totalCount?: number;
  /** Server-reported chunk totals keyed by knowledge-base id. */
  chunkTotals?: Record<string, number | undefined>;
  /** Authenticated 桐灼GEO client used by the atomic-fact governance workbench. */
  apiClient?: GeoFlowApiClient;
  /** Refresh the shell's authoritative knowledge-base projection after a mutation. */
  onKnowledgeBasesChanged?: () => void | Promise<void>;
}

export const KnowledgeView: React.FC<KnowledgeViewProps> = ({
  knowledgeBases,
  chunks,
  onCreateKb,
  lang,
  apiMode = false,
  onSearchKnowledgeBase,
  chunkLoadErrors = {},
  canRead = true,
  canWrite = true,
  totalCount,
  chunkTotals,
  apiClient,
  onKnowledgeBasesChanged,
}) => {
  const [selectedKbId, setSelectedKbId] = useState(knowledgeBases[0]?.id || '');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newContent, setNewContent] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [assetDetails, setAssetDetails] = useState<any>(null);
  const [assetError, setAssetError] = useState('');
  const [assetBusy, setAssetBusy] = useState('');
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState<number | null>(null);
  const [mediaForm, setMediaForm] = useState({ asset_key: '', section_key: '', route_name: '', title: '', alt_text: '', caption: '', keywords: '' });
  // 切片生成中的轮询计时器；见下方 kbPollTimer 对应的 effect。
  const kbPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 回调存进 ref：父组件每次渲染都会生成新的内联函数，写进依赖会不停重置计时器。
  const knowledgeChangedRef = useRef(onKnowledgeBasesChanged);
  useEffect(() => { knowledgeChangedRef.current = onKnowledgeBasesChanged; }, [onKnowledgeBasesChanged]);

  // Semantic Search Tester
  const [searchQuery, setSearchQuery] = useState('HubSpot 对比传统 CRM');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  // Never render data that may have been left in parent state after a token
  // loses materials:read.  The API gate is still enforced server-side; this
  // projection keeps the UI from flashing stale private content.
  const visibleKnowledgeBases = canRead ? knowledgeBases : EMPTY_KNOWLEDGE_BASES;
  const visibleChunks = canRead ? chunks : EMPTY_KNOWLEDGE_CHUNKS;
  const activeKb = visibleKnowledgeBases.find((k) => k.id === selectedKbId) || visibleKnowledgeBases[0];
  const activeChunkId = activeKb?.id || selectedKbId;
  const activeChunks = visibleChunks.filter((c) => c.kbId === activeChunkId);
  const activeChunkLoadError = activeKb ? chunkLoadErrors[activeKb.id] : undefined;
  const activeChunkTotal = activeKb && chunkTotals && Object.prototype.hasOwnProperty.call(chunkTotals, activeKb.id)
    ? chunkTotals[activeKb.id]
    : chunkTotals
      ? undefined
      : activeChunks.length;
  const canRestoreActiveKnowledgeBase = Boolean(assetDetails?.item?.is_system_managed);

  const formatCount = (count: number | undefined): string => count === undefined ? '—' : String(count);

  // Lists are loaded asynchronously in API mode; keep the selected item in
  // sync instead of leaving the right-hand pane permanently empty after the
  // initial render.
  useEffect(() => {
    if (visibleKnowledgeBases.length === 0) {
      setSelectedKbId('');
      return;
    }
    if (!visibleKnowledgeBases.some((base) => base.id === selectedKbId)) {
      setSelectedKbId(visibleKnowledgeBases[0].id);
    }
  }, [visibleKnowledgeBases, selectedKbId]);

  useEffect(() => {
    if (!apiMode || !apiClient || !activeKb?.id || !canRead) {
      setAssetDetails(null);
      return;
    }
    let cancelled = false;
    setAssetError('');
    void apiClient.getKnowledgeBase(activeKb.id)
      .then((value) => { if (!cancelled) setAssetDetails(value); })
      .catch((error) => { if (!cancelled) setAssetError(describeApiError(error, lang === 'zh' ? '无法读取知识资产详情' : 'Unable to load knowledge assets', lang)); });
    return () => { cancelled = true; };
  }, [activeKb?.id, apiClient, apiMode, canRead, lang]);

  /**
   * 「重建切片」只 reload 一次，状态会停在 processing，文案却是「请稍后刷新」——
   * 用户不会一直手动刷，界面就永远停在「切片正在由后端生成」。
   *
   * processing 期间轮询单条详情：后端跑完（状态离开 processing）就停，并同步一次外壳，
   * 让列表状态和新切片落到界面上。
   *
   * 刻意不拿 onKnowledgeBasesChanged 当每轮的刷新源：它会整页重载并弹出启动遮罩，
   * 每 3s 闪一次比状态不动更糟。轮询只用一次轻量 GET，收敛后才同步一次。
   */
  useEffect(() => {
    if (kbPollTimer.current) clearTimeout(kbPollTimer.current);
    kbPollTimer.current = null;
    if (!apiMode || !apiClient || !canRead || !activeKb?.id || activeKb.status !== 'processing') return undefined;
    const kbId = activeKb.id;
    const client = apiClient;
    let cancelled = false;
    const poll = async () => {
      try {
        const value = await client.getKnowledgeBase(kbId);
        if (cancelled) return;
        const item = value && typeof value === 'object' && !Array.isArray(value) ? value.item : undefined;
        const status = mapKnowledgeBase(item && typeof item === 'object' ? item as Record<string, unknown> : {}).status;
        if (status !== 'processing') {
          await knowledgeChangedRef.current?.();
          return;
        }
      } catch {
        // 单轮读取失败不该把面板打成错误态；下一轮再试。
      }
      if (!cancelled) kbPollTimer.current = setTimeout(() => void poll(), 3000);
    };
    kbPollTimer.current = setTimeout(() => void poll(), 3000);
    return () => {
      cancelled = true;
      if (kbPollTimer.current) clearTimeout(kbPollTimer.current);
      kbPollTimer.current = null;
    };
  }, [activeKb?.id, activeKb?.status, apiClient, apiMode, canRead]);

  const handleTestSearch = async () => {
    if (!canRead) {
      setSearchError(lang === 'zh' ? '权限不足（403）：知识检索需要「materials:read」权限。' : 'Permission denied (403): knowledge search requires the “materials:read” scope.');
      return;
    }
    if (!searchQuery.trim() || !activeKb?.id) return;
    setIsSearching(true);
    setSearchError('');
    try {
      if (apiMode) {
        if (!onSearchKnowledgeBase) {
          throw new Error(lang === 'zh' ? '当前未配置知识检索接口' : 'Knowledge search is not configured');
        }
        setSearchResults(await onSearchKnowledgeBase(activeKb.id, searchQuery.trim(), 8));
      } else {
        const res = await fetch('/api/knowledge-bases/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: searchQuery }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setSearchResults(data.results || []);
      }
    } catch (err) {
      console.error('Search test failed:', err);
      setSearchResults([]);
      setSearchError(describeApiError(err, lang === 'zh' ? '检索失败' : 'Search failed', lang));
    } finally {
      setIsSearching(false);
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) {
      setCreateError(lang === 'zh' ? '权限不足（403）：创建知识库需要「materials:write」权限。' : 'Permission denied (403): creating a knowledge base requires the “materials:write” scope.');
      return;
    }
    if (!newName.trim()) return;
    if (apiMode && !newContent.trim() && !selectedFile) return;
    setIsCreating(true);
    setCreateError('');
    try {
      if (apiMode && apiClient && selectedFile) {
        const formData = new FormData();
        formData.set('name', newName.trim());
        formData.set('description', newDesc.trim());
        formData.set('content', newContent.trim());
        formData.set('knowledge_file', selectedFile);
        await apiClient.uploadKnowledgeBase(formData, { idempotencyKey: `knowledge-upload-${Date.now()}` });
        await onKnowledgeBasesChanged?.();
      } else {
        await onCreateKb(newName, newDesc, newContent);
      }
      setNewName('');
      setNewDesc('');
      setNewContent('');
      setSelectedFile(null);
      setIsModalOpen(false);
    } catch (error) {
      setCreateError(describeApiError(error, lang === 'zh' ? '创建知识库失败' : 'Unable to create knowledge base', lang));
    } finally {
      setIsCreating(false);
    }
  };

  const refreshActiveKnowledgeBase = async () => {
    if (!apiClient || !activeKb?.id) return;
    setAssetBusy('refresh');
    setAssetError('');
    try {
      await apiClient.refreshKnowledgeBase(activeKb.id, { idempotencyKey: `knowledge-refresh-${activeKb.id}-${Date.now()}` });
      await onKnowledgeBasesChanged?.();
      setAssetDetails(await apiClient.getKnowledgeBase(activeKb.id));
    } catch (error) {
      setAssetError(describeApiError(error, lang === 'zh' ? '请求重建切片失败' : 'Unable to rebuild chunks', lang));
    } finally { setAssetBusy(''); }
  };

  const restoreRevision = async (revisionId: number) => {
    if (!apiClient || !activeKb?.id) return;
    setAssetBusy(`restore-${revisionId}`);
    setAssetError('');
    try {
      await apiClient.restoreKnowledgeBaseRevision(activeKb.id, revisionId, { idempotencyKey: `knowledge-restore-${revisionId}-${Date.now()}` });
      await onKnowledgeBasesChanged?.();
      setAssetDetails(await apiClient.getKnowledgeBase(activeKb.id));
    } catch (error) {
      setAssetError(describeApiError(error, lang === 'zh' ? '恢复知识库版本失败' : 'Unable to restore revision', lang));
    } finally { setAssetBusy(''); }
  };

  const uploadMedia = async () => {
    if (!apiClient || !activeKb?.id || !mediaFile) return;
    setAssetBusy('media');
    setAssetError('');
    try {
      const formData = new FormData();
      formData.set('image', mediaFile);
      Object.entries(mediaForm).forEach(([key, value]) => formData.set(key, value));
      const result = await apiClient.uploadKnowledgeBaseMedia(activeKb.id, formData, { idempotencyKey: `knowledge-media-${Date.now()}` });
      setAssetDetails((previous: any) => ({ ...(previous || {}), media: [((result as any).item), ...(((previous || {}).media) || [])] }));
      setMediaFile(null);
    } catch (error) {
      setAssetError(describeApiError(error, lang === 'zh' ? '上传知识媒体失败' : 'Unable to upload knowledge media', lang));
    } finally { setAssetBusy(''); }
  };

  const toggleMedia = async (mediaId: number, active: boolean) => {
    if (!apiClient || !activeKb?.id) return;
    setAssetBusy(`media-${mediaId}`);
    try {
      const result = await apiClient.toggleKnowledgeBaseMedia(activeKb.id, mediaId, active, { idempotencyKey: `knowledge-media-toggle-${mediaId}-${Date.now()}` });
      const item = (result as any).item;
      setAssetDetails((previous: any) => ({ ...(previous || {}), media: (((previous || {}).media) || []).map((entry: any) => entry.id === mediaId ? item : entry) }));
    } catch (error) {
      setAssetError(describeApiError(error, lang === 'zh' ? '更新媒体状态失败' : 'Unable to update media status', lang));
    } finally { setAssetBusy(''); }
  };

  const replaceMedia = async (mediaId: number) => {
    if (!apiClient || !activeKb?.id || !mediaFile) return;
    setAssetBusy(`replace-${mediaId}`);
    setAssetError('');
    try {
      const formData = new FormData();
      formData.set('image', mediaFile);
      const result = await apiClient.replaceKnowledgeBaseMedia(activeKb.id, mediaId, formData, { idempotencyKey: `knowledge-media-replace-${mediaId}-${Date.now()}` });
      const item = (result as any).item;
      setAssetDetails((previous: any) => {
        const existing = Array.isArray(previous?.media) ? previous.media : [];
        return { ...(previous || {}), media: [item, ...existing.filter((entry: any) => entry.id !== mediaId)] };
      });
      setMediaFile(null);
    } catch (error) {
      setAssetError(describeApiError(error, lang === 'zh' ? '替换知识媒体失败' : 'Unable to replace knowledge media', lang));
    } finally { setAssetBusy(''); }
  };

  const updateMediaMetadata = async () => {
    if (!apiClient || !activeKb?.id || !selectedMediaId) return;
    setAssetBusy(`update-media-${selectedMediaId}`);
    setAssetError('');
    try {
      const result = await apiClient.updateKnowledgeBaseMedia(activeKb.id, selectedMediaId, mediaForm, { idempotencyKey: `knowledge-media-update-${selectedMediaId}-${Date.now()}` });
      const item = (result as any).item;
      setAssetDetails((previous: any) => {
        const existing = Array.isArray(previous?.media) ? previous.media : [];
        return { ...(previous || {}), media: existing.map((entry: any) => entry.id === selectedMediaId ? item : entry) };
      });
    } catch (error) {
      setAssetError(describeApiError(error, lang === 'zh' ? '保存媒体元数据失败' : 'Unable to save media metadata', lang));
    } finally { setAssetBusy(''); }
  };

  return (
    <div className="space-y-8">
      <PageHeader
        icon={Database}
        group={lang === 'zh' ? '内容中心' : 'Content'}
        title={lang === 'zh' ? '知识库' : 'Knowledge Bases'}
        description={lang === 'zh'
          ? 'AI 写作的事实来源：把产品资料、白皮书等放进来，生成文章时它会优先引用这里的内容，少瞎编。'
          : 'The factual source for AI writing: add product docs and whitepapers so generated articles cite them.'}
        actions={<>
          {!canRead && <PermissionNotice lang={lang} mode="read" requiredScope="materials:read" className="sm:col-span-2" />}
          {canRead && !canWrite && <PermissionNotice lang={lang} requiredScope="materials:write" className="sm:col-span-2" />}
          {canWrite && <button
            onClick={() => {
              setCreateError('');
              setIsModalOpen(true);
            }}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white shadow-sm transition hover:bg-indigo-500"
          >
            <Plus className="w-4 h-4" />
            <span>{lang === 'zh' ? '新建知识库' : 'New Knowledge Base'}</span>
          </button>}
        </>}
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Knowledge Bases List (4 cols) */}
        <div className="lg:col-span-4 space-y-3">
          <div className="text-section-title px-1">
            {lang === 'zh' ? '知识库列表' : 'Repositories'} ({formatCount(totalCount ?? (apiMode ? undefined : visibleKnowledgeBases.length))})
          </div>

          <div className="space-y-2.5">
            {visibleKnowledgeBases.map((kb) => {
              const isSelected = kb.id === selectedKbId;
              return (
                <div
                  key={kb.id}
                  onClick={() => setSelectedKbId(kb.id)}
                  className={`cursor-pointer rounded-2xl border p-4 transition ${
                    isSelected
                      ? 'border-emerald-500 bg-slate-800 shadow-md shadow-emerald-500/10'
                      : 'border-transparent bg-slate-900/80 hover:bg-slate-800/40'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-card-title line-clamp-1">{kb.name}</h3>
                    {/* 后端枚举（indexed / processing / failed / ready）翻成中文语义。 */}
                    <StatusBadge spec={kbStatusSpec(kb.status)} lang={lang} className="!text-[12px] shrink-0" />
                  </div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-slate-400 line-clamp-2">
                    {kb.description || (lang === 'zh' ? '暂无描述' : 'No description')}
                  </p>
                  <div className="mt-3 flex items-center justify-between border-t border-slate-700/40 pt-3 text-caption">
                    <span>
                      {/*
                        只显示**后端确实提供了**的计数。`/api/v1/materials/knowledge-bases` 的投影里
                        没有 `document_count`，也没有 `vectorized_chunk_count`（只有 `chunk_count`），
                        所以「份文档」「向量」以前恒显示「—」，看起来像页面坏了。这里改为缺就不显示，
                        而不是摆一个破折号占位；哪天后端补上这两个字段，它们会自动出现。
                      */}
                      {[
                        kb.documentCount === undefined ? null : `${formatCount(kb.documentCount)} ${lang === 'zh' ? '份文档' : 'docs'}`,
                        kb.chunkCount === undefined ? null : `${formatCount(kb.chunkCount)} ${lang === 'zh' ? '切片' : 'chunks'}`,
                        kb.embeddedCount === undefined ? null : `${formatCount(kb.embeddedCount)} ${lang === 'zh' ? '向量' : 'vectors'}`,
                      ].filter((part): part is string => part !== null).join(' · ')}
                    </span>
                    <span>{kb.updatedAt}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Chunks & RAG Semantic Tester (8 cols) */}
        <div className="lg:col-span-8 space-y-6">
          {/* Active Knowledge Base Info & Chunks */}
          <div className="space-y-4 rounded-2xl bg-slate-900/80 p-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="flex items-center gap-2 text-section-title">
                  <Layers className="h-4 w-4 text-emerald-400" />
                  <span>{activeKb?.name}</span>
                </h3>
                <span className="text-caption">
                  {lang === 'zh' ? '包含切片' : 'Chunks'}: {formatCount(activeChunkTotal)} {lang === 'zh' ? '段' : 'items'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {apiMode && activeKb?.id && canWrite && <button type="button" onClick={() => void refreshActiveKnowledgeBase()} disabled={assetBusy !== ''} className="inline-flex h-9 items-center gap-1 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${assetBusy === 'refresh' ? 'animate-spin' : ''}`} />{lang === 'zh' ? '重建切片' : 'Rebuild chunks'}</button>}
                <span className="rounded-lg bg-slate-800 px-2 py-1 text-[12px] text-slate-300">
                  {apiMode
                    ? (lang === 'zh' ? '向量状态由后端同步任务决定' : 'Embedding state is owned by the backend')
                    : '100% Vector Embedded'}
                </span>
              </div>
            </div>

            <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
              {activeChunkLoadError ? (
                <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-950/30 px-3 py-3 text-xs leading-relaxed text-rose-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                  <span>{lang === 'zh' ? '切片加载失败：' : 'Chunk loading failed: '}{activeChunkLoadError}</span>
                </div>
              ) : activeChunks.length === 0 ? (
                activeKb?.status === 'processing' ? (
                  <div className="py-8 text-center text-[13px] text-slate-400">
                    {lang === 'zh' ? '切片正在由后端生成，请稍后刷新' : 'Chunks are being generated by the backend'}
                  </div>
                ) : activeKb?.status === 'failed' ? (
                  <div className="py-8 text-center text-[13px] text-rose-300">
                    {lang === 'zh' ? `切片同步失败${activeKb.syncError ? `：${activeKb.syncError}` : ''}` : `Chunk synchronization failed${activeKb.syncError ? `: ${activeKb.syncError}` : ''}`}
                  </div>
                ) : (
                  <EmptyState
                    compact
                    icon={Layers}
                    title={lang === 'zh' ? '暂无独立切片' : 'No chunks yet'}
                    description={lang === 'zh' ? '新知识库创建后由后端异步切片；也可以点上方「重建切片」重新生成。' : 'New libraries are chunked asynchronously; use “Rebuild chunks” to regenerate.'}
                  />
                )
              ) : (
                activeChunks.map((chk) => (
                  <div
                    key={chk.id}
                    className="space-y-1.5 rounded-xl bg-slate-950/40 px-4 py-3"
                  >
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-bold text-slate-200">{chk.title}</h4>
                      <span className="font-mono text-caption">{chk.tokenCount} tokens</span>
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed font-sans">{chk.content}</p>
                  </div>
                ))
              )}
            </div>

            {apiMode && assetError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{assetError}</div>}

            {apiMode && assetDetails && (
              <div className="grid grid-cols-1 gap-4 border-t border-slate-800 pt-4 xl:grid-cols-2">
                <section className="rounded-xl bg-slate-950/40 px-4 py-3">
                  <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-slate-300"><History className="h-3.5 w-3.5 text-indigo-300" />{lang === 'zh' ? '知识库版本' : 'Revisions'}</div>
                  <div className="max-h-36 space-y-1.5 overflow-y-auto">
                    {Array.isArray(assetDetails.revisions) && assetDetails.revisions.length > 0 ? assetDetails.revisions.map((revision: any) => (
                      <div key={revision.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-900/50 px-2.5 py-2 text-[12px]">
                        <span className="text-slate-400">v{revision.revision_number} · {revision.source} · {revision.creator_username || 'system'}</span>
                        {canWrite && canRestoreActiveKnowledgeBase && <button type="button" onClick={() => void restoreRevision(Number(revision.id))} disabled={assetBusy !== ''} className="rounded-lg border border-indigo-500/30 px-2 py-1 text-[12px] font-semibold text-indigo-300 hover:bg-indigo-500/10 disabled:opacity-50">{assetBusy === `restore-${revision.id}` ? '…' : (lang === 'zh' ? '恢复' : 'Restore')}</button>}
                      </div>
                    )) : <p className="text-[12px] text-slate-500">{lang === 'zh' ? '暂无历史版本' : 'No revisions yet'}</p>}
                  </div>
                  {!canRestoreActiveKnowledgeBase && Array.isArray(assetDetails.revisions) && assetDetails.revisions.length > 0 && <p className="mt-2 text-[12px] text-slate-500">{lang === 'zh' ? '此知识库仅保留版本记录；恢复仅适用于系统托管知识库。' : 'This library keeps revision history; restoration is available only for system-managed knowledge bases.'}</p>}
                </section>

                <section className="rounded-xl bg-slate-950/40 px-4 py-3">
                  <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-slate-300"><ImagePlus className="h-3.5 w-3.5 text-indigo-300" />{lang === 'zh' ? '知识媒体资产' : 'Knowledge media'}</div>
                  <div className="max-h-36 space-y-1.5 overflow-y-auto">
                    {Array.isArray(assetDetails.media) && assetDetails.media.length > 0 ? assetDetails.media.map((media: any) => (
                      <div key={media.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-900/50 px-2.5 py-2 text-[12px]">
                        <button type="button" onClick={() => { setSelectedMediaId(Number(media.id)); setMediaForm((previous) => ({ ...previous, asset_key: String(media.asset_key || ''), section_key: String(media.section_key || ''), route_name: String(media.route_name || ''), title: String(media.title || ''), alt_text: String(media.alt_text || ''), caption: String(media.caption || ''), keywords: Array.isArray(media.keywords) ? media.keywords.join(', ') : String(media.keywords || '') })); }} className={`min-w-0 truncate text-left ${selectedMediaId === Number(media.id) ? 'text-indigo-300' : 'text-slate-400'}`}>{media.title || media.asset_key} · v{media.asset_version}</button>
                        {canWrite && <div className="flex shrink-0 items-center gap-1"><button type="button" onClick={() => void toggleMedia(Number(media.id), !Boolean(media.is_active))} disabled={assetBusy !== ''} className={`inline-flex items-center gap-1 rounded border px-2 py-1 ${media.is_active ? 'border-emerald-500/30 text-emerald-300' : 'border-slate-700 text-slate-500'}`}><Power className="h-3 w-3" />{media.is_active ? (lang === 'zh' ? '启用' : 'Active') : (lang === 'zh' ? '停用' : 'Inactive')}</button>{mediaFile && <button type="button" onClick={() => void replaceMedia(Number(media.id))} disabled={assetBusy !== ''} className="rounded-lg border border-indigo-500/30 px-2 py-1 text-[12px] font-semibold text-indigo-300 disabled:opacity-50">{assetBusy === `replace-${media.id}` ? '…' : (lang === 'zh' ? '替换' : 'Replace')}</button>}</div>}
                      </div>
                    )) : <p className="text-[12px] text-slate-500">{lang === 'zh' ? '暂无媒体资产（系统知识媒体需 PNG/WebP 和受控入口）' : 'No media assets'}</p>}
                  </div>
                  {canWrite && <div className="mt-3 space-y-2 border-t border-slate-800 pt-3">
                    <input type="file" accept="image/png,image/webp" onChange={(event) => setMediaFile(event.target.files?.[0] || null)} className="block w-full text-[12px] text-slate-400 file:mr-2 file:rounded file:border-0 file:bg-slate-800 file:px-2 file:py-1 file:text-[12px] file:text-slate-300" />
                    <div className="grid grid-cols-2 gap-2">
                      {(['asset_key', 'section_key', 'route_name', 'title', 'alt_text', 'caption'] as const).map((field) => <input key={field} value={mediaForm[field]} onChange={(event) => setMediaForm((previous) => ({ ...previous, [field]: event.target.value }))} placeholder={field} className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" />)}
                    </div>
                    <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void uploadMedia()} disabled={!mediaFile || assetBusy !== ''} className="inline-flex h-9 items-center rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50">{assetBusy === 'media' ? (lang === 'zh' ? '上传中…' : 'Uploading…') : (lang === 'zh' ? '上传媒体' : 'Upload media')}</button>{selectedMediaId && <button type="button" onClick={() => void updateMediaMetadata()} disabled={assetBusy !== ''} className="inline-flex h-9 items-center rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50">{assetBusy === `update-media-${selectedMediaId}` ? '…' : (lang === 'zh' ? '保存元数据' : 'Save metadata')}</button>}</div>
                  </div>}
                </section>
              </div>
            )}
          </div>

          {/* RAG Semantic Retrieval Tester */}
          <div className="space-y-4 rounded-2xl bg-slate-900/80 p-5">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-section-title">
                <Zap className="h-4 w-4 text-amber-400" />
                <span>{lang === 'zh' ? '检索测试' : 'Retrieval test'}</span>
                <span className="text-caption font-normal">
                  {lang === 'zh' ? '（问一个问题，看看 AI 会从知识库里找到哪几段）' : '(see which chunks the AI would retrieve)'}
                </span>
              </h3>
              <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[12px] text-amber-400">
                {apiMode ? (lang === 'zh' ? '后端混合召回' : 'Backend hybrid retrieval') : 'Cosine Similarity'}
              </span>
            </div>

            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  disabled={!canRead}
                  placeholder={lang === 'zh' ? '输入自然语言问题测试向量语义召回...' : 'Enter query to test retrieval...'}
                  className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900 pl-10 pr-3 text-[13px] text-white outline-none transition focus:border-indigo-500"
                />
              </div>
              <button
                onClick={handleTestSearch}
                disabled={!canRead || isSearching || !activeKb?.id}
                className="inline-flex h-9 shrink-0 items-center rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50"
              >
                {isSearching ? (lang === 'zh' ? '检索中...' : 'Searching...') : (lang === 'zh' ? '测试召回' : 'Test Search')}
              </button>
            </div>

            {searchError && (
              <p role="alert" className="rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2 text-xs text-red-200">
                {searchError}
              </p>
            )}

            {searchResults.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-slate-800">
                <div className="text-caption font-semibold">
                  {lang === 'zh' ? '召回 Top 切片：' : 'Top Retrieved Chunks:'}
                </div>
                {searchResults.map((res, i) => (
                  <div
                    key={res.chunk_id || res.id || i}
                    className="space-y-1 rounded-xl bg-slate-950/40 px-4 py-3"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-slate-200">{res.title || res.chunk_title || `Chunk ${res.chunk_index ?? i}`}</span>
                      {typeof (res.score ?? res.similarity) === 'number' && (
                        <span className="font-mono text-[12px] font-bold text-emerald-400">
                          Score: {Number(res.score ?? res.similarity).toFixed(3)}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">{res.content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {apiMode && apiClient && activeKb?.id && (
        <KnowledgeFactWorkbench
          apiClient={apiClient}
          knowledgeBaseId={activeKb.id}
          chunks={activeChunks.map((chunk) => ({ id: chunk.id, title: chunk.title, content: chunk.content }))}
          lang={lang}
          canRead={canRead}
          canWrite={canWrite}
        />
      )}

      {apiMode && apiClient && (
        <EnterpriseKnowledgeView
          apiClient={apiClient}
          lang={lang}
          canRead={canRead}
          canWrite={canWrite}
        />
      )}

      {/* New KB Modal */}
      {isModalOpen && canWrite && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form
            onSubmit={handleCreateSubmit}
            className="w-full max-w-md space-y-4 rounded-2xl bg-slate-900 p-6 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Database className="w-5 h-5 text-indigo-600" />
                <span>{lang === 'zh' ? '新建私有知识库' : 'Create Knowledge Base'}</span>
              </h3>
              <button
                type="button"
                onClick={() => !isCreating && setIsModalOpen(false)}
                disabled={isCreating || !canWrite}
                className="text-sm text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">
                  {lang === 'zh' ? '知识库名称' : 'Repository Name'} *
                </label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"
                  placeholder="e.g. 2026年企业营销系统竞品评测库"
                />
              </div>

              {apiMode && (
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-300">{lang === 'zh' ? '或上传知识文件（TXT / Markdown / DOCX）' : 'Or upload a knowledge file (TXT / Markdown / DOCX)'}</label>
                  <input type="file" accept=".txt,.md,.markdown,.docx" onChange={(event) => setSelectedFile(event.target.files?.[0] || null)} className="block w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-[13px] text-slate-300 file:mr-2 file:rounded file:border-0 file:bg-slate-700 file:px-2 file:py-1 file:text-[12px] file:text-slate-200" />
                  {selectedFile && <p className="text-[12px] text-emerald-300">{selectedFile.name}</p>}
                </div>
              )}

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">
                  {lang === 'zh'
                    ? (apiMode ? '知识库正文（与文件至少填写一项）' : '知识库正文（Markdown / 纯文本）')
                    : (apiMode ? 'Source content (provide this or a file)' : 'Source content (Markdown / plain text)')}{apiMode ? ' *' : ''}
                </label>
                <textarea
                  rows={6}
                  required={apiMode && !selectedFile}
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-[13px] text-white outline-none transition focus:border-indigo-500 resize-y"
                  placeholder={lang === 'zh' ? '粘贴经过审核的企业资料；创建后由 桐灼GEO 异步切片。' : 'Paste reviewed enterprise material; 桐灼GEO will chunk it asynchronously.'}
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">
                  {lang === 'zh' ? '知识库描述' : 'Description'}
                </label>
                <textarea
                  rows={3}
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-[13px] text-white outline-none transition focus:border-indigo-500 resize-none"
                  placeholder="描述语料覆盖范围、文档类型及防幻觉标准..."
                />
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
                onClick={() => !isCreating && setIsModalOpen(false)}
                disabled={isCreating}
                className="inline-flex h-9 items-center rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                {lang === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={isCreating}
                className="inline-flex h-9 items-center rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white shadow-sm transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isCreating ? (lang === 'zh' ? '创建中...' : 'Creating...') : (lang === 'zh' ? '创建并切片' : 'Create & Index')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
