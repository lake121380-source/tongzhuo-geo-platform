import React, { useEffect, useState } from 'react';
import { KeyRound, Pencil, Plus, Save, Trash2, Loader2, Wifi} from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';
import { LoadingState } from './LoadingState';
import { useConfirm } from './ui';

interface AiSourceProvidersPanelProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  canManage: boolean;
}

const emptyDraft = (): Record<string, string> => ({
  name: '',
  endpoint_url: 'https://open.feedcoopapi.com/search_api/web_search',
  api_key: '',
  daily_limit: '0',
  count: '10',
  status: 'active',
  // 检索选项。以前它们既不上屏也不进保存载荷，而后端对缺失键一律填默认 →
  // 每次「保存」都会把 need_content 抹成 false（可见度检索就不再要正文，二次分析质量
  // 静默下降）、把 sites/block_hosts 清空。现在进草稿、上屏、原样回传。
  need_content: 'false',
  need_summary: 'false',
  need_url: 'true',
  content_formats: 'Markdown',
  auth_info_level: '',
  sites: '',
  block_hosts: '',
});

const asRecord = (value: unknown): ApiRecord => (
  value && typeof value === 'object' ? value as ApiRecord : {}
);

/**
 * System-wide search providers are deliberately kept separate from personal
 * content models. The API remains the authority for endpoint policy, secret
 * encryption, quota and super-administrator authorization.
 */
export const AiSourceProvidersPanel: React.FC<AiSourceProvidersPanelProps> = ({ apiClient, lang, canManage }) => {
  const [providers, setProviders] = useState<ApiRecord[]>([]);
  const confirmDialog = useConfirm();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState('');
  const [notice, setNotice] = useState('');
  /** 首屏取数中。没有它时，等待期间会直接显示「尚未配置来源 Provider」，分不清加载与无数据。 */
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const result = await apiClient.listAiSourceProviders();
      setProviders(result.items || []);
    } catch (error) {
      setNotice(describeApiError(error, lang === 'zh' ? '无法读取来源 Provider' : 'Unable to load source providers', lang));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (canManage) void load();
  }, [canManage]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = (key: string) => String(draft?.[key] ?? '');
  const setValue = (key: string, next: string) => setDraft((current) => ({ ...(current || emptyDraft()), [key]: next }));

  const beginEdit = (provider: ApiRecord) => {
    const options = asRecord(provider.options);
    setEditingId(String(provider.id));
    setDraft({
      name: String(provider.name || ''),
      endpoint_url: String(provider.endpoint_url || ''),
      api_key: '',
      daily_limit: String(provider.daily_limit ?? 0),
      count: String(options.count ?? 10),
      status: String(provider.status || 'active'),
      need_content: String(options.need_content === true),
      need_summary: String(options.need_summary === true),
      need_url: String(options.need_url !== false),
      content_formats: String(options.content_formats || 'Markdown'),
      auth_info_level: String(options.auth_info_level || ''),
      sites: Array.isArray(options.sites) ? options.sites.join(',') : '',
      block_hosts: Array.isArray(options.block_hosts) ? options.block_hosts.join(',') : '',
    });
    setNotice('');
  };

  const save = async () => {
    if (!draft || !draft.name.trim() || !draft.endpoint_url.trim() || (!editingId && !draft.api_key.trim())) return;
    setBusy(true);
    setNotice('');
    const payload: ApiRecord = {
      name: draft.name.trim(), endpoint_url: draft.endpoint_url.trim(), daily_limit: Number(draft.daily_limit || 0),
      count: Number(draft.count || 10), status: draft.status,
      // 选项字段原样回传：后端现在也只会覆盖传上来的键，这里是第二道保险。
      need_content: draft.need_content === 'true',
      need_summary: draft.need_summary === 'true',
      need_url: draft.need_url !== 'false',
      content_formats: draft.content_formats || 'Markdown',
      auth_info_level: draft.auth_info_level,
      sites: draft.sites,
      block_hosts: draft.block_hosts,
    };
    if (draft.api_key.trim()) payload.api_key = draft.api_key.trim();
    try {
      const result = editingId
        ? await apiClient.updateAiSourceProvider(editingId, payload)
        : await apiClient.createAiSourceProvider(payload);
      const provider = asRecord(result.provider || result);
      setProviders((current) => editingId
        ? current.map((item) => String(item.id) === editingId ? { ...item, ...provider } : item)
        : [provider, ...current]);
      setDraft(null);
      setEditingId(null);
      setNotice(lang === 'zh' ? '来源 Provider 已保存；密钥不会回显。' : 'Source provider saved; its key is never shown again.');
    } catch (error) {
      setNotice(describeApiError(error, lang === 'zh' ? '保存来源 Provider 失败' : 'Unable to save source provider', lang));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 真实出站探活。
   *
   * 这是运营方在跑可见度之前**唯一**能确认 Provider 还能用的手段——旧后台一直有这个按钮。
   * 会消耗一次额度，所以做成明确的按钮，不跟页面自动跑。
   */
  const probe = async (id: string) => {
    if (probing) return;
    setProbing(id); setNotice('');
    try {
      const result = await apiClient.testAiSourceProvider(id, '桐灼GEO', { idempotencyKey: `probe-provider-${id}-${Date.now()}` });
      setNotice(lang === 'zh'
        ? `探活成功：返回 ${Number(result.source_count ?? 0)} 条结果，耗时 ${Number(result.latency_ms ?? 0)}ms。`
        : `Probe OK: ${Number(result.source_count ?? 0)} results in ${Number(result.latency_ms ?? 0)}ms.`);
    } catch (error) {
      setNotice(describeApiError(error, lang === 'zh' ? '探活失败' : 'Probe failed', lang));
    } finally {
      setProbing('');
    }
  };

  const remove = async (id: string) => {
    if (!(await confirmDialog({
      title: lang === 'zh' ? '删除此来源 Provider？' : 'Delete this source provider?',
      description: lang === 'zh' ? '已有关联可见度记录时后端会拒绝删除。' : 'The server rejects providers that still have visibility records.',
      confirmLabel: lang === 'zh' ? '删除' : 'Delete',
      tone: 'danger',
    }))) return;
    setBusy(true);
    setNotice('');
    try {
      await apiClient.deleteAiSourceProvider(id);
      setProviders((current) => current.filter((provider) => String(provider.id) !== id));
      setNotice(lang === 'zh' ? '来源 Provider 已删除。' : 'Source provider deleted.');
    } catch (error) {
      setNotice(describeApiError(error, lang === 'zh' ? '删除来源 Provider 失败' : 'Unable to delete source provider', lang));
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) return null;

  return (
    <section className="space-y-3 rounded-2xl border border-violet-500/20 bg-slate-900/80 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold text-white"><KeyRound className="h-4 w-4 text-violet-300" />{lang === 'zh' ? '来源 Provider（系统级）' : 'Source Providers (system)'}</h2>
          <p className="mt-1 text-[11px] text-slate-400">{lang === 'zh' ? '仅超级管理员可配置。API Key 仅写入后端加密存储，不会回显。' : 'Super-admin only. API keys are encrypted server-side and never displayed.'}</p>
        </div>
        {!draft && <button type="button" onClick={() => { setDraft(emptyDraft()); setEditingId(null); setNotice(''); }} className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white"><Plus className="h-3.5 w-3.5" />{lang === 'zh' ? '新增 Provider' : 'Add provider'}</button>}
      </div>
      {notice && <div role="status" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200">{notice}</div>}
      {draft && <div className="grid gap-2 rounded-xl border border-violet-500/20 bg-slate-950 p-3 md:grid-cols-2">
        <label className="text-xs text-slate-400">{lang === 'zh' ? '名称' : 'Name'}<input value={value('name')} onChange={(event) => setValue('name', event.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" /></label>
        <label className="text-xs text-slate-400">Endpoint URL<input value={value('endpoint_url')} onChange={(event) => setValue('endpoint_url', event.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" /></label>
        <label className="text-xs text-slate-400">API Key（{editingId ? (lang === 'zh' ? '留空保留原值' : 'blank keeps current') : (lang === 'zh' ? '必填' : 'required')}）<input type="password" value={value('api_key')} onChange={(event) => setValue('api_key', event.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" /></label>
        {/*
          检索选项以前既不上屏也不回传，保存时被后端按「缺失即默认」抹掉：
          need_content 变 false（检索不再取正文）、sites/block_hosts 清空。
          现在可见可改，并原样回传。
        */}
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={value('need_content') === 'true'} onChange={(event) => setValue('need_content', String(event.target.checked))} />
            {lang === 'zh' ? '取正文' : 'Fetch content'}
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={value('need_summary') === 'true'} onChange={(event) => setValue('need_summary', String(event.target.checked))} />
            {lang === 'zh' ? '取摘要' : 'Fetch summary'}
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={value('need_url') !== 'false'} onChange={(event) => setValue('need_url', String(event.target.checked))} />
            {lang === 'zh' ? '取链接' : 'Fetch URLs'}
          </label>
          <label className="text-xs text-slate-400">
            {lang === 'zh' ? '正文格式' : 'Format'}
            <select value={value('content_formats')} onChange={(event) => setValue('content_formats', event.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white">
              <option value="Markdown">Markdown</option>
              <option value="Text">Text</option>
            </select>
          </label>
        </div>
        <p className="text-[11px] leading-relaxed text-slate-500">
          {lang === 'zh'
            ? '「取正文」不勾选时，可见度分析只能拿到标题与链接，二次判断会明显变差。'
            : 'Without “Fetch content”, visibility analysis only sees titles and URLs and its judgement degrades noticeably.'}
        </p>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          <label className="text-xs text-slate-400">
            {lang === 'zh' ? '限定站点（逗号分隔）' : 'Sites (comma separated)'}
            <input value={value('sites')} onChange={(event) => setValue('sites', event.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" />
          </label>
          <label className="text-xs text-slate-400">
            {lang === 'zh' ? '屏蔽站点（逗号分隔）' : 'Blocked hosts'}
            <input value={value('block_hosts')} onChange={(event) => setValue('block_hosts', event.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" />
          </label>
          <label className="text-xs text-slate-400">
            {lang === 'zh' ? '权威信息等级（高级，可留空）' : 'Auth level (advanced)'}
            <input value={value('auth_info_level')} onChange={(event) => setValue('auth_info_level', event.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" />
          </label>
        </div>
        <div className="grid grid-cols-3 gap-2"><label className="text-xs text-slate-400">{lang === 'zh' ? '日额度' : 'Daily limit'}<input type="number" min="0" value={value('daily_limit')} onChange={(event) => setValue('daily_limit', event.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" /></label><label className="text-xs text-slate-400">{lang === 'zh' ? '结果数' : 'Count'}<input type="number" min="1" max="20" value={value('count')} onChange={(event) => setValue('count', event.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" /></label><label className="text-xs text-slate-400">{lang === 'zh' ? '状态' : 'Status'}<select value={value('status')} onChange={(event) => setValue('status', event.target.value)} className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white"><option value="active">active</option><option value="inactive">inactive</option></select></label></div>
        <div className="flex gap-2 md:col-span-2"><button type="button" disabled={busy} onClick={() => void save()} className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"><Save className="h-3.5 w-3.5" />{busy ? '…' : (lang === 'zh' ? '保存' : 'Save')}</button><button type="button" disabled={busy} onClick={() => { setDraft(null); setEditingId(null); }} className="text-xs text-slate-400">{lang === 'zh' ? '取消' : 'Cancel'}</button></div>
      </div>}
      <div className="space-y-2">{loading && providers.length === 0 ? <LoadingState lang={lang} variant="inline" label={lang === 'zh' ? '正在读取来源 Provider…' : 'Loading source providers…'} /> : providers.length === 0 ? <p className="py-3 text-xs text-slate-500">{lang === 'zh' ? '尚未配置来源 Provider。' : 'No source providers configured.'}</p> : providers.map((provider) => <div key={String(provider.id)} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3"><div><div className="text-xs font-semibold text-white">{String(provider.name || 'Provider')} <span className="ml-1 text-[10px] text-slate-500">{String(provider.status || 'unknown')}</span></div><div className="mt-1 break-all text-[10px] text-slate-400">{String(provider.endpoint_url || '—')} · {lang === 'zh' ? '今日用量' : 'Used today'} {String(provider.used_today ?? 0)} / {String(provider.daily_limit ?? 0)}</div></div><div className="flex items-center gap-2"><button type="button" disabled={probing === String(provider.id)} onClick={() => void probe(String(provider.id))} className="text-xs text-emerald-300 disabled:opacity-50" title={lang === 'zh' ? '测试连接（会消耗一次额度）' : 'Test connection (uses quota)'}>{probing === String(provider.id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}</button><button type="button" onClick={() => beginEdit(provider)} className="text-xs text-slate-300"><Pencil className="h-3.5 w-3.5" /></button><button type="button" disabled={busy} onClick={() => void remove(String(provider.id))} className="text-xs text-rose-300 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /></button></div></div>)}</div>
    </section>
  );
};
