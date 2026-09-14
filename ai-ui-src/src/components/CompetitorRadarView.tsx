import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Database, FileText, Loader2, Plus, RefreshCw, Save, Search, ShieldAlert, Trash2 } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { PermissionNotice } from './PermissionNotice';

interface CompetitorRadarViewProps {
  /** 合并入口的内层 Tab 渲染：隐藏自身页面标题（由外层 TabbedShell 统一画），只留操作区。 */
  embedded?: boolean;
  lang: 'zh' | 'en'; onNavigateToDraft?: (topic: string) => void; apiClient?: GeoFlowApiClient; canRead?: boolean; canCollect?: boolean; }
interface CompetitorRow { brand_name: string; is_own_brand: boolean; domains: string[]; configured: boolean; citation_observation_count: number; citation_share_percent: number | null; citation_share_denominator: number; top3_citation_rate_percent: number | null; average_citation_rank: number | null; observed_query_count: number; sentiment_status: string; availability: string; }
interface Blindspot { query: string; winner_brand: string; competitor_citation_count: number; own_citation_count: number; run_ids: number[]; status: string; impact_score: number | null; }
interface RadarData { industry: string; config: { industry: string; own_brand: { name: string; domains: string[] }; competitors: Array<{ name: string; domains: string[] }> }; window: { days: number; start: string; end: string }; summary: ApiRecord; competitors: CompetitorRow[]; blindspots: Blindspot[]; evaluated_engines: string[]; observed_at: string | null; }

const emptyData: RadarData = { industry: '', config: { industry: '', own_brand: { name: '', domains: [] }, competitors: [] }, window: { days: 30, start: '', end: '' }, summary: {}, competitors: [], blindspots: [], evaluated_engines: [], observed_at: null };
const record = (value: unknown): ApiRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
const records = (value: unknown): ApiRecord[] => Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') as ApiRecord[] : [];
const numberValue = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0;
const nullableNumber = (value: unknown): number | null => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const idempotencyKey = (prefix: string): string => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;

export const CompetitorRadarView: React.FC<CompetitorRadarViewProps> = ({ lang, onNavigateToDraft, apiClient, canRead = false, canCollect = false, embedded = false }) => {
  const [data, setData] = useState<RadarData>(emptyData);
  const [days, setDays] = useState(30);
  const [query, setQuery] = useState('');
  const [industry, setIndustry] = useState('');
  const [newName, setNewName] = useState('');
  const [newDomains, setNewDomains] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    if (!apiClient || !canRead) return;
    const sequence = ++requestSequence.current;
    setLoading(true); setError('');
    try {
      const raw = record(await apiClient.getCompetitorRadar({ days }));
      if (sequence !== requestSequence.current) return;
      const config = record(raw.config);
      const rows = records(raw.competitors).map((item) => ({
        ...item,
        brand_name: String(item.brand_name || ''), is_own_brand: item.is_own_brand === true,
        domains: Array.isArray(item.domains) ? item.domains.map(String) : [], configured: item.configured === true,
        citation_observation_count: numberValue(item.citation_observation_count), citation_share_percent: nullableNumber(item.citation_share_percent), citation_share_denominator: numberValue(item.citation_share_denominator),
        top3_citation_rate_percent: nullableNumber(item.top3_citation_rate_percent), average_citation_rank: nullableNumber(item.average_citation_rank), observed_query_count: numberValue(item.observed_query_count),
        sentiment_status: String(item.sentiment_status || 'not_collected'), availability: String(item.availability || 'no_citation_records'),
      })) as CompetitorRow[];
      const next = { ...emptyData, ...raw, config: { ...emptyData.config, ...config }, competitors: rows, blindspots: records(raw.blindspots) as unknown as Blindspot[] } as RadarData;
      setData(next); setIndustry(String(next.config.industry || next.industry || ''));
    } catch (e) { if (sequence === requestSequence.current) setError(e instanceof Error ? e.message : (lang === 'zh' ? '竞品雷达加载失败' : 'Failed to load competitor radar')); }
    finally { if (sequence === requestSequence.current) setLoading(false); }
  }, [apiClient, canRead, days, lang]);
  useEffect(() => { void load(); }, [load]);

  const notify = (message: string) => { setToast(message); globalThis.setTimeout(() => setToast(''), 3500); };
  const saveConfig = async (competitors: Array<{ name: string; domains: string[] }>) => {
    if (!apiClient || !canCollect) return;
    setBusy(true); setError('');
    try { await apiClient.saveCompetitorConfig({ industry: industry.trim(), competitors }, { idempotencyKey: idempotencyKey('competitor-config') }); await load(); notify(lang === 'zh' ? '竞品配置已保存。' : 'Competitor configuration saved.'); }
    catch (e) { setError(e instanceof Error ? e.message : (lang === 'zh' ? '竞品配置保存失败' : 'Failed to save competitor configuration')); }
    finally { setBusy(false); }
  };
  const addCompetitor = async () => { const name = newName.trim(); const domains = newDomains.split(/[\n,，]+/).map((value) => value.trim()).filter(Boolean); if (!name || domains.length === 0) return; const existing = data.config.competitors.filter((item) => item.name.toLocaleLowerCase() !== name.toLocaleLowerCase()); await saveConfig([...existing, { name, domains }]); setNewName(''); setNewDomains(''); setShowAddModal(false); };
  const removeCompetitor = async (name: string) => { await saveConfig(data.config.competitors.filter((item) => item.name !== name)); };
  const refresh = async () => {
    if (!apiClient || !canCollect || !query.trim()) return;
    setBusy(true); setError('');
    try { await apiClient.benchmarkCompetitorRadar({ query: query.trim(), days }, { idempotencyKey: idempotencyKey('competitor-benchmark') }); await load(); notify(lang === 'zh' ? `已持久化问题“${query.trim()}”的竞品扫描。` : `Persisted competitor scan for “${query.trim()}”.`); }
    catch (e) { setError(e instanceof Error ? e.message : (lang === 'zh' ? '竞品扫描失败' : 'Competitor scan failed')); }
    finally { setBusy(false); }
  };

  if (!apiClient) return <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center text-sm text-slate-300">{lang === 'zh' ? '竞品雷达只在 桐灼GEO API 模式下可用，不加载演示数据。' : 'Competitor Radar requires 桐灼GEO API mode; demo data is disabled.'}</div>;
  if (!canRead) return <PermissionNotice lang={lang} mode="read" requiredScope="analytics:read" />;
  const own = data.competitors.find((item) => item.is_own_brand); const rivals = data.competitors.filter((item) => !item.is_own_brand); const summary = data.summary;
  const unavailable = lang === 'zh' ? '不可计算' : 'Unavailable';

  return <div className="space-y-6" id="competitor-radar-container">
    {toast && <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg border border-emerald-800 bg-emerald-950 px-4 py-3 text-sm text-emerald-200 shadow-lg"><CheckCircle2 className="h-4 w-4" />{toast}</div>}
    {error && <div className="rounded-lg border border-rose-800 bg-rose-950/40 px-4 py-3 text-xs text-rose-300">{error}</div>}
    <div className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/90 p-6 shadow-sm lg:flex-row lg:items-end lg:justify-between">{!embedded && (<div><div className="flex items-center gap-2 text-xs text-indigo-300"><Database className="h-4 w-4" />{lang === 'zh' ? '竞品对比' : 'Competitors'}</div><h2 className="mt-2 text-xl font-bold text-white">{lang === 'zh' ? '竞品对比' : 'Competitor comparison'}</h2><p className="mt-1 text-sm text-slate-400">{lang === 'zh' ? '同一个问题下，AI 更多引用你还是竞品。数字来自时间窗内的真实采集记录。' : 'Who gets cited more — you or competitors. Real collected records only.'}</p></div>)}<div className="flex flex-wrap items-end gap-2"><label className="text-xs text-slate-400">{lang === 'zh' ? '时间窗' : 'Window'}<select value={days} onChange={(e) => setDays(Number(e.target.value))} className="mt-1 block rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white"><option value={7}>7 {lang === 'zh' ? '天' : 'days'}</option><option value={30}>30 {lang === 'zh' ? '天' : 'days'}</option><option value={90}>90 {lang === 'zh' ? '天' : 'days'}</option></select></label><button onClick={() => setShowAddModal(true)} disabled={!canCollect || busy} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 disabled:opacity-50"><Plus className="h-3.5 w-3.5" />{lang === 'zh' ? '添加竞品' : 'Add competitor'}</button></div></div>
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">{[['已完成运行', numberValue(summary.completed_run_count), 'Completed runs'], ['引用记录', numberValue(summary.citation_observation_count), 'Citation records'], ['盲区问题', numberValue(summary.blindspot_query_count), 'Blindspot queries']].map(([zh, value, en]) => <div key={String(zh)} className="rounded-xl border border-slate-800 bg-slate-900/90 p-5"><div className="text-xs text-slate-400">{lang === 'zh' ? zh : en}</div><div className="mt-2 text-3xl font-bold text-white">{value}</div></div>)}</div>
    <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-5"><div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between"><div><h3 className="text-sm font-semibold text-white">{lang === 'zh' ? '运行一次真实竞品扫描' : 'Run a persisted competitor scan'}</h3><p className="mt-1 text-xs text-slate-400">{lang === 'zh' ? '必须输入实际问题；扫描结果会写入 桐灼GEO 可见性运行表。' : 'Enter an actual query; the scan is persisted as a 桐灼GEO visibility run.'}</p></div><div className="flex w-full gap-2 lg:max-w-xl"><div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={lang === 'zh' ? '例如：企业 GEO 平台如何选型？' : 'e.g. How should an enterprise choose a GEO platform?'} className="w-full rounded-lg border border-slate-700 bg-slate-800 py-2 pl-9 pr-3 text-xs text-white" /></div><button onClick={() => void refresh()} disabled={!canCollect || busy || !query.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-50">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{lang === 'zh' ? '扫描' : 'Scan'}</button></div></div></div>
    <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-5"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold text-white">{lang === 'zh' ? '品牌引用对比' : 'Citation comparison'}</h3><p className="mt-1 text-xs text-slate-500">{lang === 'zh' ? `时间窗：${data.window.days} 天；${data.evaluated_engines.length ? `已观测 ${data.evaluated_engines.join('、')}` : '暂无已观测 Provider'}` : `Window: ${data.window.days} days; ${data.evaluated_engines.length ? data.evaluated_engines.join(', ') : 'No observed providers'}`}</p></div>{loading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}</div><div className="mt-4 space-y-3">{[...(own ? [own] : []), ...rivals].map((item) => <div key={item.brand_name} className="rounded-lg border border-slate-800 bg-slate-950/40 p-4"><div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"><div className="min-w-48"><div className="flex items-center gap-2"><span className="font-semibold text-white">{item.brand_name}</span>{item.is_own_brand && <span className="rounded bg-indigo-600 px-2 py-0.5 text-[10px] font-bold text-white">{lang === 'zh' ? '我方' : 'OWN'}</span>}</div><div className="mt-1 text-[11px] text-slate-500">{item.configured ? item.domains.join(', ') : (lang === 'zh' ? '未配置可核验域名' : 'No verification domains configured')}</div></div><div className="grid flex-1 grid-cols-2 gap-3 text-xs sm:grid-cols-4"><div><div className="text-slate-500">{lang === 'zh' ? '引用占比' : 'Citation share'}</div><div className="mt-1 font-semibold text-white">{item.citation_share_percent === null ? unavailable : `${item.citation_share_percent}%`}<span className="ml-1 text-[10px] text-slate-500">({item.citation_observation_count}/{item.citation_share_denominator})</span></div></div><div><div className="text-slate-500">{lang === 'zh' ? '前三引用率' : 'Top 3 rate'}</div><div className="mt-1 font-semibold text-white">{item.top3_citation_rate_percent === null ? unavailable : `${item.top3_citation_rate_percent}%`}</div></div><div><div className="text-slate-500">{lang === 'zh' ? '平均引用位次' : 'Avg rank'}</div><div className="mt-1 font-semibold text-white">{item.average_citation_rank === null ? unavailable : item.average_citation_rank}</div></div><div><div className="text-slate-500">{lang === 'zh' ? '观测问题数' : 'Observed queries'}</div><div className="mt-1 font-semibold text-white">{item.observed_query_count || '—'}</div></div></div>{!item.is_own_brand && canCollect && <button title={lang === 'zh' ? '删除竞品' : 'Remove competitor'} onClick={() => void removeCompetitor(item.brand_name)} disabled={busy} className="rounded p-2 text-slate-500 hover:bg-slate-800 hover:text-rose-300 disabled:opacity-50"><Trash2 className="h-4 w-4" /></button>}</div>{item.sentiment_status === 'not_collected' && <div className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500"><AlertTriangle className="h-3.5 w-3.5" />{lang === 'zh' ? '情感未采集，未显示推断值。' : 'Sentiment was not collected; no inferred value is shown.'}</div>}</div>)}</div>{!own && rivals.length === 0 && <div className="py-8 text-center text-sm text-slate-500">{lang === 'zh' ? '暂无竞品配置或引用记录。' : 'No competitor configuration or citation records yet.'}</div>}</div>
    <div className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-5"><div className="flex items-start gap-3"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" /><div><h3 className="text-sm font-semibold text-amber-200">{lang === 'zh' ? '真实引用盲区' : 'Observed citation blindspots'}</h3><p className="mt-1 text-xs text-amber-300/80">{lang === 'zh' ? '仅当竞品有真实引用且我方域名没有引用时显示，不生成影响指数或固定建议。' : 'Shown only when a competitor has real citations and owned domains have none.'}</p></div></div><div className="mt-4 space-y-2">{data.blindspots.map((item) => <div key={`${item.query}-${item.winner_brand}`} className="flex flex-col gap-3 rounded-lg border border-amber-900/40 bg-slate-950/30 p-4 md:flex-row md:items-center md:justify-between"><div><div className="font-medium text-white">{item.query}</div><div className="mt-1 text-xs text-slate-400">{item.winner_brand} {lang === 'zh' ? `引用 ${item.competitor_citation_count} 条；我方 ${item.own_citation_count} 条` : `cited ${item.competitor_citation_count}; owned ${item.own_citation_count}`}</div></div>{onNavigateToDraft && <button onClick={() => onNavigateToDraft(item.query)} className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-700 bg-indigo-950/40 px-3 py-2 text-xs font-semibold text-indigo-200"><FileText className="h-3.5 w-3.5" />{lang === 'zh' ? '打开草稿入口' : 'Open draft entry'}</button>}</div>)}{data.blindspots.length === 0 && <div className="py-5 text-center text-xs text-slate-500">{lang === 'zh' ? '当前时间窗没有满足条件的真实盲区。' : 'No observed blindspots match the selected window.'}</div>}</div></div>
    {showAddModal && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"><div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"><h3 className="text-base font-bold text-white">{lang === 'zh' ? '添加监控竞品' : 'Add competitor'}</h3><p className="mt-1 text-xs text-slate-400">{lang === 'zh' ? '域名用于精确匹配引用来源，不能只填写品牌名称。' : 'Domains are required for exact citation matching.'}</p><label className="mt-4 block text-xs font-semibold text-slate-300">{lang === 'zh' ? '名称' : 'Name'}<input value={newName} onChange={(e) => setNewName(e.target.value)} className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white" /></label><label className="mt-3 block text-xs font-semibold text-slate-300">{lang === 'zh' ? '域名（逗号或换行分隔）' : 'Domains (comma or newline separated)'}<textarea value={newDomains} onChange={(e) => setNewDomains(e.target.value)} rows={3} placeholder="competitor.example.com" className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white" /></label><div className="mt-5 flex justify-end gap-2"><button onClick={() => setShowAddModal(false)} className="rounded-lg border border-slate-700 px-4 py-2 text-xs text-slate-300">{lang === 'zh' ? '取消' : 'Cancel'}</button><button onClick={() => void addCompetitor()} disabled={!canCollect || !newName.trim() || !newDomains.trim() || busy} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"><Save className="h-3.5 w-3.5" />{lang === 'zh' ? '保存配置' : 'Save configuration'}</button></div></div></div>}
  </div>;
};
