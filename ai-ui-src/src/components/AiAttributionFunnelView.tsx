import React, { useState, useEffect } from 'react';
import {
  TrendingUp,
  MousePointerClick,
  Filter,
  Users,
  DollarSign,
  Copy,
  Check,
  Sparkles,
  BarChart3,
  Bot,
  Eye,
  Database,
  RefreshCw,
} from 'lucide-react';
import { AiReferralSourceMetric, AiTrafficFunnelStage, UtmCampaignPreset } from '../types';
import { GeoFlowApiClient, GeoFlowApiError, ApiRecord } from '../api/geoflowClient';
import { dataSourceLabel } from '../api/labels';
import { LoadingState } from './LoadingState';
import { PageHeader } from './PageHeader';

interface AiAttributionFunnelViewProps {
  /** 合并入口的内层 Tab 渲染：隐藏自身页面标题（由外层 TabbedShell 统一画），只留操作区。 */
  embedded?: boolean;
  lang: 'zh' | 'en';
  apiClient?: GeoFlowApiClient;
  canRead?: boolean;
  canWrite?: boolean;
  /** 跳到其它页签（用在「AI 可见性明细已并入 AI 可见度栏目」那句提示上）。 */
  onNavigate?: (tab: string) => void;
}

interface RealAttributionViewProps {
  lang: 'zh' | 'en';
  data: ApiRecord | null;
  funnel: ApiRecord | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
  /** 合并入口的内层 Tab 渲染：隐藏自身页面标题（由外层 TabbedShell 统一画）。 */
  embedded?: boolean;
  /** 同上：把「去 AI 可见度栏目」变成可点的。 */
  onNavigate?: (tab: string) => void;
}

const record = (value: unknown): ApiRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
const list = (value: unknown): ApiRecord[] => Array.isArray(value) ? value.filter((item): item is ApiRecord => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : [];
const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : Number(value || 0) || 0;

const displayNumber = (value: unknown): string => num(value).toLocaleString();

const displayPercent = (value: unknown): string => `${num(value).toFixed(1)}%`;

/** 漏斗不可计算时说明原因，而不是显示成一排 0。 */
const funnelAvailabilityText = (availability: string, lang: 'zh' | 'en'): string => {
  const zh = lang === 'zh';
  switch (availability) {
    case 'not_installed':
      return zh ? '本站未启用访问日志或线索模块，归因不可计算。' : 'Visit logs or leads are not available in this deployment.';
    case 'no_view_logs':
      return zh ? '时间窗内没有任何站点访问记录，归因不可计算。' : 'No site visits were recorded in this window.';
    case 'no_ai_referrals':
      return zh ? '时间窗内有站点访问，但来源里没有已登记的 AI 引擎，归因不可计算。' : 'There were visits, but none came from a registered AI engine.';
    case '':
      return zh ? '正在读取归因漏斗…' : 'Loading the attribution funnel…';
    default:
      return zh ? '归因漏斗不可计算。' : 'The attribution funnel is unavailable.';
  }
};

/** 品牌类指标在未声明品牌名/自有域名时后端返回 null：显示「不可计算」，不得回落成 0.0%。 */
const displayPercentOrUnavailable = (value: unknown, lang: 'zh' | 'en'): string =>
  (value === null || value === undefined ? (lang === 'zh' ? '不可计算' : 'Unavailable') : displayPercent(value));

const RealAttributionView: React.FC<RealAttributionViewProps> = ({ lang, data, funnel, loading, error, onRetry, embedded = false, onNavigate }) => {
  const funnelStages = list(funnel?.stages);
  const funnelAvailability = String(funnel?.availability || '');
  const funnelDefinitions = record(funnel?.definitions);
  const visibility = record(data?.ai_visibility);
  const visibilityKpis = record(visibility.kpis);
  const traffic = record(record(data?.traffic).summary);
  const trafficKpis = record(traffic.kpis);
  const leads = record(data?.leads);
  const leadKpis = record(leads.kpis);
  const trafficTrend = list(traffic.traffic_trend);
  const leadSources = list(leads.sources);
  const botBreakdown = list(traffic.bot_breakdown);
  const source = record(data?.source);

  const cards = [
    { label: lang === 'zh' ? '品牌 AI 可见度' : 'Brand AI visibility', value: displayPercentOrUnavailable(visibilityKpis.brand_visibility, lang), icon: Eye, tone: 'text-indigo-400' },
    // 「Top 1 率」与「已采样运行」两张卡删掉了：它们读的是 `ai_visibility.polling.sampled_runs`
    // 与 `kpis.top1_rate`，而 2026-09-20「整体切换为见度数据」之后后端只在这些位置给
    // `kpis.brand_visibility`（其余键永远不存在）——摆在那里就是恒 0 / 恒「不可计算」，
    // 而同一页的「品牌 AI 可见度」拿的是见度真实数据，两者并列只会让人更困惑。
    // 见度的样本数/推荐率在「数据分析 → AI 可见度」栏目，页内已给跳转提示。
    { label: lang === 'zh' ? '网站 PV' : 'Site PV', value: displayNumber(trafficKpis.pv), icon: MousePointerClick, tone: 'text-amber-400' },
    { label: lang === 'zh' ? 'AI 爬虫 PV' : 'AI crawler PV', value: displayNumber(trafficKpis.ai_bot_pv), icon: Bot, tone: 'text-rose-400' },
    // 零样本时后端给 null，这里必须用 OrUnavailable：同页其它卡都是这么做的，
    // 而 displayPercent 会把 null 折成 0 → 屏幕上出现「线索转化率 0.0%」，
    // 把「没有线索数据」说成「转化率是零」。
    { label: lang === 'zh' ? '线索转化率' : 'Lead conversion', value: displayPercentOrUnavailable(leadKpis.conversion_rate, lang), icon: Users, tone: 'text-emerald-400' },
  ];

  return (
    <div className="space-y-8" id="attribution-funnel-container">
      <PageHeader
        embedded={embedded}
        icon={BarChart3}
        group={lang === 'zh' ? 'GEO 效果' : 'Results'}
        title={lang === 'zh' ? 'AI 引流与转化' : 'AI Traffic & Conversion'}
        description={lang === 'zh' ? '从 AI 侧来的访问和线索：数据只算本部署已记录的部分，算不出来的就明确写「不可计算」，不编数字。' : 'Traffic and leads coming from AI engines — only what this deployment actually recorded.'}
        actions={
          <button type="button" onClick={onRetry} disabled={loading} className="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50" aria-label={lang === 'zh' ? '刷新数据' : 'Refresh data'}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />{lang === 'zh' ? '刷新' : 'Refresh'}
          </button>
        }
      />

      {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}<button type="button" onClick={onRetry} className="ml-3 underline">{lang === 'zh' ? '重试' : 'Retry'}</button></div>}
      {loading && !data && <LoadingState lang={lang} label={lang === 'zh' ? '正在读取归因漏斗数据…' : 'Loading the attribution funnel…'} />}

      {data && <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          {cards.map(({ label, value, icon: Icon, tone }) => <div key={label} className="rounded-2xl bg-slate-900/80 p-5"><div className="flex items-center justify-between text-xs text-slate-400"><span>{label}</span><Icon className={`h-4 w-4 ${tone}`} /></div><div className="mt-2 text-2xl font-black text-white">{value}</div></div>)}
        </div>

        <div className="rounded-2xl bg-slate-900/80 p-5">
          <h2 className="text-section-title">{lang === 'zh' ? 'AI 引流归因漏斗' : 'AI referral funnel'}</h2>
          <p className="mt-1 text-caption">{String(funnelDefinitions.ip_join || (lang === 'zh' ? '访问与线索按 IP 关联，会低估，属真实下界。' : 'Visits and leads are joined by IP; this under-counts and is a lower bound.'))}</p>
          {funnelAvailability !== 'available' ? (
            <p className="mt-3 text-[13px] text-slate-400">{funnelAvailabilityText(funnelAvailability, lang)}</p>
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {funnelStages.map((stage, index) => (
                <div key={String(stage.key || index)} className="rounded-xl bg-slate-950/40 px-4 py-3">
                  <div className="text-[12.5px] text-slate-400">{String(stage.label || '')}</div>
                  <div className="mt-2 text-xl font-black text-white">{displayNumber(stage.count)}</div>
                  <div className="mt-1 text-caption">
                    {stage.denominator === null || stage.denominator === undefined
                      ? (lang === 'zh' ? '基准阶段' : 'Baseline stage')
                      : `${displayNumber(stage.denominator)} ${lang === 'zh' ? '为分母' : 'as denominator'}`}
                  </div>
                  <p className="mt-1 text-caption leading-relaxed">{String(stage.detail || '')}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-100">
          {lang === 'zh' ? '当前数据边界：桐灼GEO 已记录 AI 爬虫访问和 AI 可见性采样，但尚未建立按 ChatGPT、Perplexity 等人类访问来源拆分的 referer/UTM 归因，也没有商机金额字段。' : 'Data boundary: 桐灼GEO records AI crawler visits and visibility samples, but does not yet persist human referral attribution by engine, UTM presets, or pipeline amounts.'}
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <section className="rounded-2xl bg-slate-900/80 p-5">
            <div className="mb-3 flex items-center justify-between"><h2 className="text-section-title">{lang === 'zh' ? '访问趋势' : 'Traffic trend'}</h2><span className="text-caption">{dataSourceLabel(source, lang)}</span></div>
            {trafficTrend.length === 0 ? <p className="text-[13px] text-slate-400">{lang === 'zh' ? '该时间范围暂无访问日志。' : 'No traffic logs in this range.'}</p> : <div className="overflow-x-auto"><table className="w-full text-left text-[13px] text-slate-300"><thead className="border-b border-slate-800 bg-slate-800/40 text-[12.5px] font-semibold text-slate-400"><tr><th className="px-3 py-3">{lang === 'zh' ? '日期' : 'Date'}</th><th className="px-3 py-3">PV</th><th className="px-3 py-3">UV</th><th className="px-3 py-3">AI Bot</th></tr></thead><tbody>{trafficTrend.slice(-10).map((row) => <tr key={String(row.date)} className="border-t border-slate-800 hover:bg-slate-800/40"><td className="px-3 py-4">{String(row.date || '')}</td><td className="px-3 py-4">{displayNumber(row.pv)}</td><td className="px-3 py-4">{displayNumber(row.unique_ip)}</td><td className="px-3 py-4 text-rose-300">{displayNumber(row.ai_bot_pv)}</td></tr>)}</tbody></table></div>}
          </section>

          <section className="rounded-2xl bg-slate-900/80 p-5">
            <h2 className="mb-3 text-section-title">{lang === 'zh' ? '线索来源（已记录 URL）' : 'Recorded lead sources'}</h2>
            {leadSources.length === 0 ? <p className="text-[13px] text-slate-400">{lang === 'zh' ? '该时间范围暂无线索来源记录。' : 'No lead source records in this range.'}</p> : <div className="space-y-2">{leadSources.map((row, index) => <div key={`${String(row.source)}-${index}`} className="flex items-center justify-between gap-3 rounded-xl bg-slate-950/40 px-4 py-3 text-[13px]"><span className="truncate text-slate-300">{String(row.source || (lang === 'zh' ? '未填写来源' : 'No source'))}</span><span className="shrink-0 font-mono text-slate-400">{displayNumber(row.submissions)} / {displayNumber(row.converted)}</span></div>)}</div>}
          </section>
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <section className="rounded-2xl bg-slate-900/80 p-5 lg:col-span-2">
            {/*
              「AI 可见性关键词」与「AI 可见性关注来源」两块整段删掉了：
              它们渲染的是 `ai_visibility.keywords[]` / `ai_visibility.attention_sources[]`，
              而 2026-09-20「整体切换为见度数据」之后 `/analytics/overview` 的 ai_visibility
              只给 `kpis`（且只可能含 brand_visibility）——这两块永远是「暂无…」，
              让运营以为「采集没跑」，实际上数据在另一个栏目里。
            */}
            <h2 className="mb-3 text-section-title">{lang === 'zh' ? 'AI 可见性明细' : 'AI visibility detail'}</h2>
            <p className="text-[13px] leading-relaxed text-slate-400">
              {lang === 'zh'
                ? '关键词、平台分布、批次与报告这些明细已并入「数据分析 → AI 可见度」栏目（数据源为见度检测、每天 01:10 自动跑）。本页只保留归因相关的指标。'
                : 'Keyword, platform, batch and report detail moved to Analytics → AI visibility (sourced from Jiandu, running daily at 01:10). This page keeps attribution metrics only.'}
            </p>
            {onNavigate && (
              <button
                type="button"
                onClick={() => onNavigate('analytics')}
                className="mt-3 inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-[12.5px] font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                {lang === 'zh' ? '去 AI 可见度栏目 →' : 'Open AI visibility →'}
              </button>
            )}
          </section>
        </div>

        <section className="rounded-2xl bg-slate-900/80 p-5">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-section-title">{lang === 'zh' ? '访问分类' : 'Traffic classification'}</h2><span className="text-caption">{lang === 'zh' ? '来自访问日志 User-Agent 分类' : 'Classified from access-log user agents'}</span></div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{botBreakdown.map((row) => <div key={String(row.key)} className="rounded-xl bg-slate-950/40 px-4 py-3 text-[13px]"><div className="truncate text-slate-400">{String(row.label || row.key || '')}</div><div className="mt-1 text-lg font-bold text-slate-200">{displayNumber(row.count)}</div></div>)}</div>
        </section>
      </>}
    </div>
  );
};

export const AiAttributionFunnelView: React.FC<AiAttributionFunnelViewProps> = ({ lang, apiClient, canRead = true, canWrite = true, embedded = false, onNavigate }) => {
  const [sources, setSources] = useState<AiReferralSourceMetric[]>([]);
  const [funnel, setFunnel] = useState<AiTrafficFunnelStage[]>([]);
  const [utmPresets, setUtmPresets] = useState<UtmCampaignPreset[]>([]);
  const [summary, setSummary] = useState({
    totalClicks: 13850,
    totalInquiries: 462,
    totalPipeline: 1845000,
    avgConversionRate: 3.34,
  });

  // UTM generator states
  const [campaignName, setCampaignName] = useState('GEO白皮书-AI引用');
  const [targetEngine, setTargetEngine] = useState('Perplexity AI');
  const [landingPage, setLandingPage] = useState('https://tongzhuo-geo.local/articles/hubspot-vs-crm-geo-content-trust');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [apiLoading, setApiLoading] = useState(Boolean(apiClient));
  const [apiError, setApiError] = useState('');
  const [apiData, setApiData] = useState<ApiRecord | null>(null);
  const [apiFunnel, setApiFunnel] = useState<ApiRecord | null>(null);

  useEffect(() => {
    if (apiClient) {
      if (!canRead) {
        setApiLoading(false);
        setApiError(lang === 'zh' ? '当前令牌缺少 analytics:read，无法读取归因数据。' : 'The current token lacks analytics:read.');
        return;
      }
      let cancelled = false;
      setApiLoading(true);
      setApiError('');
      apiClient.getAnalyticsOverview({ preset: '30d' }).then((payload) => {
        if (cancelled) return;
        setApiData(record(payload));
        setApiLoading(false);
      }).catch((reason) => {
        if (cancelled) return;
        setApiLoading(false);
        setApiData(null);
        setApiError(reason instanceof GeoFlowApiError || reason instanceof Error ? reason.message : (lang === 'zh' ? '归因数据加载失败' : 'Unable to load attribution data'));
      });
      // 漏斗是独立接口（基于 view_logs.referer 与 lead_submissions）。它失败不影响上面那块，
      // 但必须把失败原因留在页面上，不能静默显示成「没有数据」。
      apiClient.getAttributionFunnel(30).then((payload) => {
        if (cancelled) return;
        setApiFunnel(record(payload));
      }).catch((reason) => {
        if (cancelled) return;
        setApiFunnel(null);
        setApiError(reason instanceof GeoFlowApiError || reason instanceof Error ? reason.message : (lang === 'zh' ? '归因漏斗加载失败' : 'Unable to load the attribution funnel'));
      });
      return () => { cancelled = true; };
    }
  }, [apiClient, canRead, lang]);

  if (apiClient) {
    return (
      <RealAttributionView
        embedded={embedded}
        lang={lang}
        data={apiData}
        funnel={apiFunnel}
        loading={apiLoading}
        error={apiError}
        onNavigate={onNavigate}
        onRetry={() => {
          setApiData(null);
          setApiLoading(true);
          setApiError('');
          apiClient.getAnalyticsOverview({ preset: '30d' }).then((payload) => {
            setApiData(record(payload));
            setApiLoading(false);
          }).catch((reason) => {
            setApiLoading(false);
            setApiError(reason instanceof GeoFlowApiError || reason instanceof Error ? reason.message : (lang === 'zh' ? '分析数据加载失败' : 'Unable to load analytics'));
          });
        }}
      />
    );
  }

  const handleGenerateUtm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (apiClient) {
      setApiError(lang === 'zh' ? '桐灼GEO 当前未提供 UTM 预设持久化接口，已停用演示写入。' : '桐灼GEO does not expose a persisted UTM contract yet.');
      return;
    }
    if (!campaignName.trim() || !landingPage.trim()) return;

    try {
      const res = await fetch('/api/attribution/utm-generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignName, targetEngine, landingPage }),
      });
      if (res.ok) {
        const newPreset = await res.json();
        setUtmPresets((prev) => [newPreset, ...prev]);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleCopyLink = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2500);
  };

  return (
    <div className="space-y-8" id="attribution-funnel-container">
      {apiLoading && (
        <div className="rounded-2xl bg-slate-900/80 px-4 py-3">
          <LoadingState lang={lang} variant="inline" className="text-sm text-slate-400" label={lang === 'zh' ? '正在读取真实归因数据…' : 'Loading persisted attribution data…'} />
        </div>
      )}
      {apiError && <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">{apiError}</div>}
      {/* Header Banner */}
      <div className="flex flex-col gap-4 rounded-2xl bg-slate-900/80 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-md bg-indigo-500/20 px-2.5 py-0.5 text-xs font-semibold text-indigo-300 border border-indigo-500/30">
              <TrendingUp className="h-3.5 w-3.5" />
              {lang === 'zh' ? '阶段 3 · 价值闭环' : 'Phase 3 · Business Value'}
            </span>
            <span className="text-xs text-slate-400">
              {lang === 'zh' ? 'AI 流量引流归因与高意向商机转化全链路' : 'AI Referral & Conversion Funnel'}
            </span>
          </div>
          <h2 className="text-xl font-bold tracking-tight text-white">
            {lang === 'zh' ? 'AI 引流归因与咨询转化漏斗分析' : 'AI Referral Attribution & Conversion Funnel'}
          </h2>
          <p className="text-[13px] text-slate-400">
            {lang === 'zh'
              ? '做好官网 SEO 与 GEO 优化的终极目的，是捕获来自 Perplexity、ChatGPT、Kimi 等新一代生成式引擎的高意向商业流量，并精准归因至线索与成单。'
              : 'Track and attribute every high-intent visit referred by Perplexity, SearchGPT, Kimi, and Gemini citations directly into revenue pipeline.'}
          </p>
        </div>
      </div>

      {/* KPI Cards with Tabular Nums */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl bg-slate-900/80 p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">
              {lang === 'zh' ? '大模型引用带来独立访客' : 'AI Referral Visits'}
            </span>
            <MousePointerClick className="h-4 w-4 text-indigo-400" />
          </div>
          <div className="mt-2 text-2xl font-bold text-white font-mono tabular-nums">
            {summary.totalClicks.toLocaleString()}
          </div>
          <p className="mt-1 text-xs text-emerald-400 font-mono tabular-nums">
            ↑ 48.5% {lang === 'zh' ? '较传统自然搜索增幅' : 'vs Organic Search'}
          </p>
        </div>

        <div className="rounded-2xl bg-slate-900/80 p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">
              {lang === 'zh' ? 'AI 意向商机与咨询数' : 'Qualified AI Leads'}
            </span>
            <Users className="h-4 w-4 text-indigo-400" />
          </div>
          <div className="mt-2 text-2xl font-bold text-white font-mono tabular-nums">
            {summary.totalInquiries.toLocaleString()}
          </div>
          <p className="mt-1 text-xs text-indigo-400">
            {lang === 'zh' ? '高意向精准决策者' : 'High Purchase Intent'}
          </p>
        </div>

        <div className="rounded-2xl bg-slate-900/80 p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">
              {lang === 'zh' ? '平均咨询转化率' : 'Avg Conversion Rate'}
            </span>
            <Filter className="h-4 w-4 text-indigo-400" />
          </div>
          <div className="mt-2 text-2xl font-bold text-white font-mono tabular-nums">
            {summary.avgConversionRate}%
          </div>
          <p className="mt-1 text-xs text-slate-400 font-mono tabular-nums">
            {lang === 'zh' ? '传统SEO引流通常仅为 1.1%' : 'Industry benchmark ~1.1%'}
          </p>
        </div>

        <div className="rounded-2xl bg-slate-900/80 p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-slate-400">
              {lang === 'zh' ? '已促成商机管道金额' : 'Influenced Pipeline'}
            </span>
            <DollarSign className="h-4 w-4 text-emerald-400" />
          </div>
          <div className="mt-2 text-2xl font-bold text-emerald-400 font-mono tabular-nums">
            {summary.totalPipeline > 0 ? `¥${(summary.totalPipeline / 10000).toFixed(1)}万` : '—'}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {summary.totalPipeline > 0 ? (lang === 'zh' ? '来自已记录的商机管道' : 'From recorded pipeline data') : (lang === 'zh' ? '桐灼GEO 当前未提供管道金额字段' : 'Pipeline amount is not exposed by 桐灼GEO')}
          </p>
        </div>
      </div>

      {/* 5-Stage Visual Conversion Funnel with High Contrast */}
      {!apiClient && <div className="rounded-2xl bg-slate-900/80 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-section-title">
              {lang === 'zh' ? 'AI 引用全链路转化漏斗' : 'End-to-End AI Citation Funnel'}
            </h3>
            <p className="mt-1 text-caption">
              {lang === 'zh'
                ? '从大模型生成答案中曝光 [1] 引用角标，到用户点击回流并最终留下咨询联系方式的全流程损耗分析。'
                : 'Step-by-step conversion drop-off analysis from AI citation answer impression to business lead.'}
            </p>
          </div>
          <span className="text-xs px-2.5 py-1 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-semibold font-mono tabular-nums">
            {lang === 'zh' ? '综合转化率 3.34%' : '3.34% Overall'}
          </span>
        </div>

        <div className="mt-6 space-y-3">
          {funnel.map((stage, idx) => {
            const widthPct = Math.max(12, Math.round((stage.count / (funnel[0]?.count || 1)) * 100));
            const uniqueStageKey = `funnel-stage-${idx}-${stage.stage}`;
            return (
              <div key={uniqueStageKey} className="space-y-1 text-xs">
                <div className="flex items-center justify-between font-medium">
                  <span className="text-slate-200 flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-mono text-[11px] text-slate-300 font-semibold">
                      {idx + 1}
                    </span>
                    <span>{stage.stage}</span>
                  </span>
                  <div className="flex items-center gap-3 font-mono tabular-nums">
                    <span className="font-bold text-white">
                      {stage.count.toLocaleString()} 次
                    </span>
                    <span className="text-caption">
                      (环节转化率 {stage.conversionRateFromPrev}%)
                    </span>
                  </div>
                </div>

                <div className="h-3 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-indigo-600 transition-all duration-500"
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>}

      {/* Breakdown by AI Source with Tabular Nums */}
      <div className="rounded-2xl bg-slate-900/80 p-6">
        <h3 className="text-section-title">
          {lang === 'zh' ? '各 AI 搜索引擎引流与成单贡献榜' : 'Traffic & Inquiries by Engine'}
        </h3>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-slate-800 bg-slate-800/40 text-[12.5px] font-semibold text-slate-400">
              <tr>
                <th className="px-3 py-3 font-semibold">{lang === 'zh' ? '搜索引擎来源' : 'Engine'}</th>
                <th className="px-3 py-3 font-semibold font-mono">{lang === 'zh' ? '引流点击数' : 'Clicks'}</th>
                <th className="px-3 py-3 font-semibold font-mono">{lang === 'zh' ? '平均停留时间' : 'Dwell Time'}</th>
                <th className="px-3 py-3 font-semibold font-mono">{lang === 'zh' ? '意向咨询数' : 'Inquiries'}</th>
                <th className="px-3 py-3 font-semibold font-mono">{lang === 'zh' ? '咨询转化率' : 'Conv. Rate'}</th>
                <th className="px-3 py-3 font-semibold font-mono">{lang === 'zh' ? '促成商机金额' : 'Pipeline'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 text-slate-300">
              {sources.map((item, idx) => {
                const uniqueSourceKey = `source-engine-${idx}-${item.engine}`;
                return (
                  <tr key={uniqueSourceKey} className="hover:bg-slate-800/40 transition-colors">
                    <td className="px-3 py-4 font-medium text-white">
                      <div className="flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 rounded-full shrink-0 bg-indigo-600"
                        />
                        <span>{item.engine}</span>
                      </div>
                    </td>
                    <td className="px-3 py-4 font-semibold text-indigo-400 font-mono tabular-nums">
                      {item.referralClicks.toLocaleString()}
                    </td>
                    <td className="px-3 py-4 font-mono tabular-nums">{item.avgDwellSeconds} 秒</td>
                    <td className="px-3 py-4 font-bold text-white font-mono tabular-nums">
                      {item.inquiriesGenerated}
                    </td>
                    <td className="px-3 py-4 font-mono tabular-nums">
                      <span className="rounded bg-emerald-500/20 border border-emerald-500/30 px-1.5 py-0.5 text-[12px] font-semibold text-emerald-300">
                        {item.conversionRate}%
                      </span>
                    </td>
                    <td className="px-3 py-4 font-medium text-emerald-400 font-mono tabular-nums">
                      ¥{(item.pipelineRevenue / 10000).toFixed(1)}万
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* UTM Campaign Generator for AI Citation */}
      <div className="rounded-2xl bg-slate-900/80 p-6">
        <h3 className="text-section-title">
          {lang === 'zh' ? 'AI 引用专用 UTM 跟踪短链生成器' : 'AI Citation UTM Tracking Link Generator'}
        </h3>
        <p className="mt-1 text-caption">
          {lang === 'zh'
            ? '将带专属追踪标签的落地页链接嵌入 /llms.txt 或发布在白皮书中，大模型在引用该文章时将保留这些参数，从而在 Google Analytics 或神策数据中准确追踪 AI 来源。'
            : 'Generate standardized URLs tagged with utm_medium=ai_citation to track attribution across your analytics platform.'}
        </p>

        <form onSubmit={handleGenerateUtm} className="mt-4 grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-3">
          <div>
            <label className="font-semibold text-slate-300">
              {lang === 'zh' ? '推广活动 / 页面名称' : 'Campaign Name'}
            </label>
            <input
              type="text"
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white placeholder:text-slate-400 outline-none transition focus:border-indigo-500"
            />
          </div>

          <div>
            <label className="font-semibold text-slate-300">
              {lang === 'zh' ? '目标大模型搜索引擎' : 'Target AI Engine'}
            </label>
            <select
              value={targetEngine}
              onChange={(e) => setTargetEngine(e.target.value)}
              className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"
            >
              <option value="Perplexity AI">Perplexity AI</option>
              <option value="OpenAI SearchGPT">OpenAI SearchGPT</option>
              <option value="Kimi (Moonshot)">Kimi (月之暗面)</option>
              <option value="Google Gemini">Google Gemini</option>
              <option value="Claude 3.7">Claude 3.7</option>
              <option value="ByteDance Doubao">字节跳动 豆包</option>
            </select>
          </div>

          <div className="flex items-end">
            <button
              type="submit"
              className="h-9 w-full rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white transition hover:bg-indigo-500"
            >
              {lang === 'zh' ? '生成带标追踪链接' : 'Generate Tracked URL'}
            </button>
          </div>
        </form>

        {/* List of active UTM campaigns with Tabular Nums */}
        <div className="mt-6 space-y-2">
          <h4 className="text-caption font-semibold">
            {lang === 'zh' ? '已生成的 AI 引流监测预设：' : 'Generated AI Presets:'}
          </h4>
          {utmPresets.map((preset, idx) => {
            const uniqueUtmKey = `utm-preset-${preset.id || idx}-${preset.campaignName}`;
            return (
              <div
                key={uniqueUtmKey}
                className="flex flex-col gap-2 rounded-xl bg-slate-950/40 px-4 py-3 text-[13px] sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-0.5 overflow-hidden">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-white">
                      {preset.campaignName}
                    </span>
                    <span className="rounded-md bg-indigo-500/20 px-1.5 py-0.5 text-[12px] font-semibold text-indigo-300">
                      {preset.targetEngine}
                    </span>
                  </div>
                  <div className="truncate font-mono text-[12.5px] text-slate-400">
                    {preset.fullUtmUrl}
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-[12.5px] text-slate-400 font-mono tabular-nums">
                    {preset.generatedClicks} 点击 · {preset.inquiries} 咨询
                  </div>
                  <button
                    onClick={() => handleCopyLink(preset.fullUtmUrl, preset.id || `utm-${idx}`)}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 text-[12px] font-semibold text-slate-200 transition hover:bg-slate-800"
                  >
                    {copiedId === (preset.id || `utm-${idx}`) ? (
                      <Check className="h-3 w-3 text-emerald-400" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    {copiedId === (preset.id || `utm-${idx}`)
                      ? lang === 'zh'
                        ? '已复制'
                        : 'Copied'
                      : lang === 'zh'
                      ? '复制链接'
                      : 'Copy'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
