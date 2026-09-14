import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, Download, Edit3, ExternalLink, Plus, RefreshCw, Save, Send, X } from 'lucide-react';
import { Article } from '../types';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';
import PermissionNotice from './PermissionNotice';
import { LoadingState } from './LoadingState';
import ManualPublicationSettingsPanel from './ManualPublicationSettingsPanel';
import BrowserConnectPanel from './BrowserConnectPanel';
import { PageHeader } from './PageHeader';
import { EmptyState } from './ui';

interface ManualPublicationsViewProps {
  apiClient: GeoFlowApiClient;
  articles: Article[];
  lang: 'zh' | 'en';
  canRead: boolean;
  canWrite: boolean;
  /** 账号与人设的维护是超管专属（服务端另判）。 */
  isSuperAdmin?: boolean;
}

type PublicationForm = {
  type: string;
  article_id: string;
  persona_id: string;
  account_id: string;
  assigned_admin_id: string;
  platform: string;
  custom_platform: string;
  target_url: string;
  target_context: string;
  content: string;
  scheduled_at: string;
  status: string;
};

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿', ready: '待执行', in_progress: '执行中', completed: '已完成',
  failed: '失败', skipped: '已跳过', cancelled: '已取消', outcome_unknown: '结果未知',
};

const TYPE_LABELS: Record<string, string> = { post: '文章发布', comment: '评论/问答' };

function record(value: unknown): ApiRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function formFrom(item?: ApiRecord): PublicationForm {
  return {
    type: text(item?.type) || 'post',
    article_id: text(item?.article_id),
    persona_id: text(item?.persona_id),
    account_id: text(item?.account_id),
    assigned_admin_id: text(item?.assigned_admin_id),
    platform: text(item?.platform) || 'custom',
    custom_platform: text(item?.custom_platform),
    target_url: text(item?.target_url),
    target_context: text(item?.target_context),
    content: text(item?.content),
    scheduled_at: text(item?.scheduled_at).slice(0, 16),
    status: text(item?.status) || 'draft',
  };
}

function optionLabel(item: ApiRecord, fallback: string): string {
  return text(item.name) || text(item.account_name) || text(item.display_name) || fallback;
}

export const ManualPublicationsView: React.FC<ManualPublicationsViewProps> = ({
  apiClient, articles, lang, canRead, canWrite, isSuperAdmin = false,
}) => {
  const zh = lang === 'zh';
  const [items, setItems] = useState<ApiRecord[]>([]);
  const [stats, setStats] = useState<ApiRecord>({});
  const [pagination, setPagination] = useState<ApiRecord>({});
  const [options, setOptions] = useState<ApiRecord>({});
  const [statusFilter, setStatusFilter] = useState('');
  // 与旧后台对齐的另外六个筛选维度（服务端的 filteredQuery 与导出共用同一组参数）。
  const [typeFilter, setTypeFilter] = useState('');
  const [platformFilter, setPlatformFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [articleFilter, setArticleFilter] = useState('');
  const [scheduledFrom, setScheduledFrom] = useState('');
  const [scheduledTo, setScheduledTo] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ApiRecord | null>(null);
  const [transitions, setTransitions] = useState<ApiRecord[]>([]);
  const [form, setForm] = useState<PublicationForm>(() => formFrom());
  const [editing, setEditing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [transitionStatus, setTransitionStatus] = useState('');
  const [completionUrl, setCompletionUrl] = useState('');
  const [resultNote, setResultNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const personas = useMemo(() => Array.isArray(options.personas) ? options.personas.map(record) : [], [options.personas]);
  const accounts = useMemo(() => Array.isArray(options.accounts) ? options.accounts.map(record) : [], [options.accounts]);
  const admins = useMemo(() => Array.isArray(options.admins) ? options.admins.map(record) : [], [options.admins]);
  const platforms = useMemo(() => Array.isArray(options.platforms) ? options.platforms.map(text) : ['custom'], [options.platforms]);
  const statuses = useMemo(() => Array.isArray(options.statuses) ? options.statuses.map(text) : Object.keys(STATUS_LABELS), [options.statuses]);

  /**
   * 导出工单。
   *
   * **筛选参数必须与列表逐字一致**：只按「当前页」的参数导，拿到的可能是全量，
   * 于是「筛完再导出」就变成了假动作。服务端两边共用同一个 filteredQuery，
   * 前端这边也不能自作主张少传。
   */
  const exportOrders = async () => {
    if (busy) return;
    setBusy('export');
    setError('');
    try {
      const blob = await apiClient.exportManualPublications(filterParams());
      const url = URL.createObjectURL(blob);
      const anchorEl = document.createElement('a');
      anchorEl.href = url;
      anchorEl.download = `manual-publications-${new Date().toISOString().slice(0, 10)}.csv`;
      anchorEl.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(describeApiError(cause, zh ? '导出失败' : 'Export failed', lang));
    } finally {
      setBusy('');
    }
  };

  /**
   * 当前筛选条件。
   *
   * **列表与导出必须共用这一份**——各拼一遍就会出现「界面上筛过、导出却是全量」。
   */
  const filterParams = useCallback((): Record<string, string | number | undefined> => ({
    status: statusFilter || undefined,
    type: typeFilter || undefined,
    platform: platformFilter || undefined,
    assigned_admin_id: assigneeFilter || undefined,
    article_id: articleFilter || undefined,
    scheduled_from: scheduledFrom || undefined,
    scheduled_to: scheduledTo || undefined,
    search: search.trim() || undefined,
  }), [articleFilter, assigneeFilter, platformFilter, scheduledFrom, scheduledTo, search, statusFilter, typeFilter]);

  const load = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    setError('');
    try {
      const result = record(await apiClient.listManualPublications({
        ...filterParams(),
        page: 1,
        per_page: 50,
      }));
      setItems(Array.isArray(result.items) ? result.items.map(record) : []);
      setStats(record(result.stats));
      setPagination(record(result.pagination));
      setOptions(record(result.options));
    } catch (cause) {
      setError(describeApiError(cause, zh ? '无法读取手动发布工单' : 'Unable to load manual publications', lang));
    } finally {
      setLoading(false);
    }
  }, [apiClient, canRead, filterParams, lang, zh]);

  useEffect(() => { void load(); }, [load]);

  const openDetail = async (item: ApiRecord) => {
    setBusy(`detail-${item.id}`);
    setError('');
    try {
      const result = record(await apiClient.getManualPublication(text(item.id)));
      setSelected(record(result.publication || result));
      setTransitions(Array.isArray(result.transitions) ? result.transitions.map(record) : []);
      setTransitionStatus('');
    } catch (cause) {
      setError(describeApiError(cause, zh ? '无法读取工单详情' : 'Unable to load work order', lang));
    } finally {
      setBusy('');
    }
  };

  const startCreate = () => {
    setSelected(null);
    setEditing(false);
    setForm(formFrom({ persona_id: personas[0]?.id, assigned_admin_id: admins[0]?.id }));
    setShowForm(true);
    setError('');
  };

  const startEdit = () => {
    if (!selected || !canWrite) return;
    setForm(formFrom(selected));
    setEditing(true);
    setShowForm(true);
  };

  const updateForm = (key: keyof PublicationForm, value: string) => setForm((current) => ({ ...current, [key]: value }));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite || busy) return;
    if (!form.persona_id || !form.content.trim()) {
      setError(zh ? '请选择身份并填写发布内容。' : 'Choose a persona and provide content.');
      return;
    }
    const payload: ApiRecord = {
      type: form.type,
      article_id: form.article_id ? Number(form.article_id) : null,
      persona_id: Number(form.persona_id),
      account_id: form.account_id ? Number(form.account_id) : null,
      assigned_admin_id: form.assigned_admin_id ? Number(form.assigned_admin_id) : null,
      platform: form.platform,
      custom_platform: form.custom_platform.trim() || null,
      target_url: form.target_url.trim() || null,
      target_context: form.target_context.trim() || null,
      content: form.content,
      scheduled_at: form.scheduled_at || null,
    };
    if (!editing) payload.status = form.status === 'ready' ? 'ready' : 'draft';
    if (editing && selected) payload.revision = Number(selected.revision || 0);
    setBusy('save');
    setError('');
    try {
      const result = record(editing && selected
        ? await apiClient.updateManualPublication(text(selected.id), payload)
        : await apiClient.createManualPublication(payload));
      const publication = record(result.publication || result);
      setSelected(publication);
      setShowForm(false);
      setEditing(false);
      await load();
    } catch (cause) {
      setError(describeApiError(cause, zh ? '保存手动发布工单失败' : 'Unable to save work order', lang));
    } finally {
      setBusy('');
    }
  };

  const transition = async () => {
    if (!selected || !transitionStatus || !canWrite) return;
    setBusy('transition');
    setError('');
    try {
      const result = record(await apiClient.transitionManualPublication(text(selected.id), {
        target_status: transitionStatus,
        revision: Number(selected.revision || 0),
        completion_url: completionUrl.trim() || null,
        result_note: resultNote.trim() || null,
      }));
      const publication = record(result.publication || result);
      setSelected(publication);
      setTransitionStatus('');
      setCompletionUrl('');
      setResultNote('');
      await load();
    } catch (cause) {
      setError(describeApiError(cause, zh ? '状态流转失败，可能是版本已变化' : 'Status transition failed; the revision may be stale', lang));
    } finally {
      setBusy('');
    }
  };

  if (!canRead) {
    return <PermissionNotice lang={lang} mode="read" requiredScope="articles:read" className="mt-4" />;
  }

  const allowedNext = Array.isArray(selected?.allowed_next_statuses) ? selected.allowed_next_statuses.map(text) : [];
  const selectedArticle = articles.find((article) => String(article.id) === String(form.article_id));

  return (
    <div className="space-y-8">
      <PageHeader
        icon={ClipboardCheck}
        group={zh ? '发布中心' : 'Publishing'}
        title={zh ? '手动发布' : 'Manual publishing'}
        description={zh ? '有些平台没有接口，需要人工去发。这里生成发布工单：谁去发、发什么、发到哪，发完回来登记结果。' : 'For platforms without an API: assign a person to publish an article and record the receipt.'}
        actions={<>
          <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />{zh ? '刷新' : 'Refresh'}</button>
          <button type="button" onClick={() => void exportOrders()} disabled={busy === 'export' || !canRead} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50"><Download className="h-3.5 w-3.5" />{zh ? '导出' : 'Export'}</button>
          <button type="button" onClick={startCreate} disabled={!canWrite} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"><Plus className="h-3.5 w-3.5" />{zh ? '新建工单' : 'New work order'}</button>
        </>}
      />

      {!canWrite && <PermissionNotice lang={lang} requiredScope="articles:write" />}
      {error && <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-950/30 px-3 py-2 text-[13px] text-rose-200">{error}</div>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[['total', '全部'], ['ready', '待执行'], ['in_progress', '执行中'], ['completed', '已完成']].map(([key, label]) => (
          <div key={key} className="rounded-2xl bg-slate-900/80 p-5"><div className="text-caption">{zh ? label : key.replace('_', ' ')}</div><div className="mt-1 text-[26px] font-black leading-none text-white">{Number(stats[key] || 0)}</div></div>
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={zh ? '搜索内容、目标 URL、文章或账号' : 'Search content, URL, article or account'} className="h-10 min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" />
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-10 rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"><option value="">{zh ? '全部状态' : 'All statuses'}</option>{statuses.map((status) => <option key={status} value={status}>{STATUS_LABELS[status] || status}</option>)}</select>
      </div>

      {/* 其余筛选维度：与旧后台对齐，列表与导出共用同一份参数 */}
      <div className="flex flex-wrap gap-2">
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500">
          <option value="">{zh ? '全部类型' : 'All types'}</option>
          {(Array.isArray(options.types) ? options.types.map(text) : ['post', 'comment']).map((type) => <option key={type} value={type}>{TYPE_LABELS[type] || type}</option>)}
        </select>
        <select value={platformFilter} onChange={(event) => setPlatformFilter(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500">
          <option value="">{zh ? '全部平台' : 'All platforms'}</option>
          {platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
        </select>
        <select value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500">
          <option value="">{zh ? '全部执行人' : 'All assignees'}</option>
          {admins.map((admin) => <option key={String(admin.id)} value={String(admin.id)}>{optionLabel(admin, 'Admin')}</option>)}
        </select>
        <select value={articleFilter} onChange={(event) => setArticleFilter(event.target.value)} className="min-w-[180px] rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500">
          <option value="">{zh ? '全部文章' : 'All articles'}</option>
          {articles.map((article) => <option key={article.id} value={article.id}>{article.title}</option>)}
        </select>
        <label className="inline-flex items-center gap-1 text-[12px] text-slate-400">{zh ? '计划时间从' : 'Scheduled from'}
          <input type="date" value={scheduledFrom} onChange={(event) => setScheduledFrom(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" />
        </label>
        <label className="inline-flex items-center gap-1 text-[12px] text-slate-400">{zh ? '到' : 'to'}
          <input type="date" value={scheduledTo} onChange={(event) => setScheduledTo(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" />
        </label>
        <button type="button" onClick={() => void load()} className="inline-flex h-10 items-center rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800">{zh ? '应用筛选' : 'Apply'}</button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.8fr)]">
        <div className="overflow-hidden rounded-2xl bg-slate-900/80">
          {items.length === 0 ? (loading ? <div className="px-4 py-12 text-center"><LoadingState lang={lang} variant="inline" label={zh ? '正在读取发布工单…' : 'Loading work orders…'} /></div> : <EmptyState compact icon={ClipboardCheck} title={zh ? '还没有发布工单' : 'No manual publication work orders'} description={zh ? '点右上角「新建工单」创建第一个。' : 'Create the first work order from the top-right button.'} />) : <div className="divide-y divide-slate-800/80">{items.map((item) => {
            const isSelected = String(selected?.id) === String(item.id);
            return <button type="button" key={String(item.id)} onClick={() => void openDetail(item)} className={`block w-full px-4 py-3 text-left transition hover:bg-slate-800/60 ${isSelected ? 'bg-indigo-950/40' : ''}`}>
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate text-sm font-semibold text-white">{text(record(item.article).title) || TYPE_LABELS[text(item.type)] || text(item.content).slice(0, 80)}</div><div className="mt-1 truncate text-[12px] text-slate-400">{TYPE_LABELS[text(item.type)] || text(item.type)} · {text(record(item.account).name) || text(record(item.persona).name) || '—'} · #{text(item.id)}</div></div><span className="shrink-0 rounded-full border border-slate-700 px-2 py-0.5 text-[12px] text-slate-300">{STATUS_LABELS[text(item.status)] || text(item.status)}</span></div>
              <div className="mt-2 line-clamp-2 text-[13px] text-slate-300">{text(item.content)}</div>
            </button>;
          })}</div>}
          {Number(pagination.total || 0) > items.length && <div className="border-t border-slate-800 px-4 py-2 text-[12px] text-slate-500">{zh ? `共 ${pagination.total} 条，当前显示前 ${items.length} 条` : `${pagination.total} total; showing ${items.length}`}</div>}
        </div>

        <div className="rounded-2xl bg-slate-900/80 p-5">
          {!selected ? <EmptyState compact icon={ClipboardCheck} title={zh ? '选择左侧工单' : 'Select a work order'} description={zh ? '选中后这里显示详情、状态与流转记录。' : 'Select a work order to inspect and transition it'} /> : <div className="space-y-4">
            <div className="flex items-start justify-between gap-3"><div><div className="text-[12px] text-indigo-300">#{text(selected.id)} · {TYPE_LABELS[text(selected.type)] || text(selected.type)}</div><h2 className="mt-1 text-base font-bold text-white">{text(record(selected.article).title) || text(selected.target_url) || 'Manual publication'}</h2></div>{canWrite && ['draft', 'ready'].includes(text(selected.status)) && <button type="button" onClick={startEdit} className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 text-[12px] font-semibold text-slate-200 transition hover:bg-slate-800"><Edit3 className="h-3.5 w-3.5" />{zh ? '编辑' : 'Edit'}</button>}</div>
            <div className="grid grid-cols-2 gap-2 text-[13px]"><div className="rounded-xl bg-slate-950/40 px-3 py-2"><span className="text-slate-500">{zh ? '状态' : 'Status'}</span><div className="mt-1 font-semibold text-white">{STATUS_LABELS[text(selected.status)] || text(selected.status)}</div></div><div className="rounded-xl bg-slate-950/40 px-3 py-2"><span className="text-slate-500">Revision</span><div className="mt-1 font-semibold text-white">{text(selected.revision)}</div></div><div className="rounded-xl bg-slate-950/40 px-3 py-2"><span className="text-slate-500">{zh ? '平台' : 'Platform'}</span><div className="mt-1 font-semibold text-white">{text(selected.platform) === 'custom' ? text(selected.custom_platform) : text(selected.platform)}</div></div><div className="rounded-xl bg-slate-950/40 px-3 py-2"><span className="text-slate-500">{zh ? '执行人' : 'Assignee'}</span><div className="mt-1 truncate font-semibold text-white">{text(record(selected.assigned_admin).display_name) || '—'}</div></div></div>
            <div className="whitespace-pre-wrap rounded-xl bg-slate-950/40 px-4 py-3 text-[13px] leading-relaxed text-slate-200">{text(selected.content)}</div>
            {selected.target_url && <a href={text(selected.target_url)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] text-indigo-300 hover:text-indigo-200"><ExternalLink className="h-3.5 w-3.5" />{text(selected.target_url)}</a>}
            {canWrite && allowedNext.length > 0 && <div className="space-y-2 border-t border-slate-800 pt-3"><div className="text-[13px] font-semibold text-slate-300">{zh ? '推进状态' : 'Transition status'}</div><div className="flex gap-2"><select value={transitionStatus} onChange={(event) => setTransitionStatus(event.target.value)} className="h-10 min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"><option value="">{zh ? '选择下一状态' : 'Choose next status'}</option>{allowedNext.map((status) => <option key={status} value={status}>{STATUS_LABELS[status] || status}</option>)}</select><button type="button" disabled={!transitionStatus || busy === 'transition'} onClick={() => void transition()} className="inline-flex h-9 items-center gap-1 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white transition hover:bg-indigo-500 disabled:opacity-50"><Send className="h-3.5 w-3.5" />{zh ? '提交' : 'Apply'}</button></div>{transitionStatus === 'completed' && <input value={completionUrl} onChange={(event) => setCompletionUrl(event.target.value)} placeholder={zh ? '完成后的公开 URL（必填）' : 'Completion URL (required)'} className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" />}<textarea value={resultNote} onChange={(event) => setResultNote(event.target.value)} placeholder={zh ? '执行备注（可选）' : 'Result note (optional)'} rows={2} className="w-full resize-y rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-[13px] text-white outline-none transition focus:border-indigo-500" /></div>}
            {transitions.length > 0 && <div className="border-t border-slate-800 pt-3"><div className="mb-2 text-[13px] font-semibold text-slate-300">{zh ? '状态记录' : 'Transition history'}</div><div className="space-y-1 text-[12px] text-slate-400">{transitions.slice(0, 8).map((entry) => <div key={String(entry.id)} className="flex justify-between gap-2"><span>{STATUS_LABELS[text(entry.from_status)] || '初始'} → {STATUS_LABELS[text(entry.to_status)] || text(entry.to_status)}</span><span>{text(entry.created_at).slice(0, 16)}</span></div>)}</div></div>}
          </div>}
        </div>
      </div>

      {showForm && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><form onSubmit={save} className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"><div className="mb-4 flex items-center justify-between"><h2 className="text-base font-bold text-white">{editing ? (zh ? '编辑手动发布工单' : 'Edit work order') : (zh ? '新建手动发布工单' : 'New work order')}</h2><button type="button" onClick={() => setShowForm(false)} className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"><X className="h-4 w-4" /></button></div><div className="grid gap-3 sm:grid-cols-2"><label className="text-[13px] text-slate-300">{zh ? '工单类型' : 'Type'}<select value={form.type} onChange={(event) => updateForm('type', event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500">{(Array.isArray(options.types) ? options.types.map(text) : ['post', 'comment']).map((type) => <option key={type} value={type}>{TYPE_LABELS[type] || type}</option>)}</select></label><label className="text-[13px] text-slate-300">{zh ? '文章（post 必选）' : 'Article (required for post)'}<select value={form.article_id} onChange={(event) => updateForm('article_id', event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"><option value="">{zh ? '选择文章' : 'Choose article'}</option>{articles.map((article) => <option key={article.id} value={article.id}>{article.title}{article.reviewStatus !== 'approved' ? ` (${article.reviewStatus || article.status})` : ''}</option>)}</select>{selectedArticle && selectedArticle.reviewStatus !== 'approved' && <span className="mt-1 block text-[12px] text-amber-300">{zh ? '文章需通过审核门禁后才能进入待执行状态。' : 'The article must pass the quality gate before execution.'}</span>}</label><label className="text-[13px] text-slate-300">{zh ? '身份 Persona' : 'Persona'}<select required value={form.persona_id} onChange={(event) => updateForm('persona_id', event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"><option value="">{zh ? '选择身份' : 'Choose persona'}</option>{personas.map((item) => <option key={String(item.id)} value={String(item.id)}>{optionLabel(item, 'Persona')}</option>)}</select></label><label className="text-[13px] text-slate-300">{zh ? '账号' : 'Account'}<select value={form.account_id} onChange={(event) => updateForm('account_id', event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"><option value="">{zh ? '不绑定账号' : 'No account'}</option>{accounts.map((item) => <option key={String(item.id)} value={String(item.id)}>{optionLabel(item, 'Account')} · {text(item.platform)}</option>)}</select></label><label className="text-[13px] text-slate-300">{zh ? '执行人' : 'Assignee'}<select value={form.assigned_admin_id} onChange={(event) => updateForm('assigned_admin_id', event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"><option value="">{zh ? '未指定（仅草稿）' : 'Unassigned (draft only)'}</option>{admins.map((item) => <option key={String(item.id)} value={String(item.id)}>{optionLabel(item, 'Admin')}</option>)}</select></label><label className="text-[13px] text-slate-300">{zh ? '平台' : 'Platform'}<select value={form.platform} onChange={(event) => updateForm('platform', event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500">{platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}</select></label></div>{form.platform === 'custom' && <input value={form.custom_platform} onChange={(event) => updateForm('custom_platform', event.target.value)} placeholder={zh ? '自定义平台名称' : 'Custom platform name'} className="mt-3 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" />}<div className="mt-3 grid gap-3 sm:grid-cols-2"><input value={form.target_url} onChange={(event) => updateForm('target_url', event.target.value)} placeholder={zh ? '目标 URL（评论类型必填）' : 'Target URL (required for comments)'} className="h-10 rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" /><input value={form.scheduled_at} onChange={(event) => updateForm('scheduled_at', event.target.value)} type="datetime-local" className="h-10 rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" /></div><textarea value={form.target_context} onChange={(event) => updateForm('target_context', event.target.value)} placeholder={zh ? '目标页面上下文（评论类型必填）' : 'Target context (required for comments)'} rows={3} className="mt-3 w-full resize-y rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-[13px] text-white outline-none transition focus:border-indigo-500" /><textarea required value={form.content} onChange={(event) => updateForm('content', event.target.value)} placeholder={zh ? '发布内容' : 'Publication content'} rows={8} className="mt-3 w-full resize-y rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-[13px] text-white outline-none transition focus:border-indigo-500" /><div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><label className="text-[13px] text-slate-300">{zh ? '初始状态' : 'Initial status'}<select disabled={editing} value={form.status} onChange={(event) => updateForm('status', event.target.value)} className="ml-2 h-10 rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"><option value="draft">{zh ? '草稿' : 'Draft'}</option><option value="ready">{zh ? '待执行' : 'Ready'}</option></select></label><div className="flex justify-end gap-2"><button type="button" onClick={() => setShowForm(false)} className="h-9 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800">{zh ? '取消' : 'Cancel'}</button><button type="submit" disabled={busy === 'save'} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white transition hover:bg-indigo-500 disabled:opacity-50"><Save className="h-3.5 w-3.5" />{busy === 'save' ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save')}</button></div></div></form></div>}

      <div className="space-y-4">
        <BrowserConnectPanel apiClient={apiClient} lang={lang} canRead={canRead} canWrite={canWrite} />
        <ManualPublicationSettingsPanel
          apiClient={apiClient}
          lang={lang}
          canRead={canRead}
          canWrite={canWrite}
          isSuperAdmin={isSuperAdmin}
        />
      </div>
    </div>
  );
};

export default ManualPublicationsView;
