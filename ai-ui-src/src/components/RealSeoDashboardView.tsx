import React, { useState, useEffect } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, Radar, Bot, Link2, TrendingUp } from 'lucide-react';
import { GeoFlowApiClient, GeoFlowApiError } from '../api/geoflowClient';
import { LoadingState } from './LoadingState';

interface RealSeoDashboardViewProps {
  lang: 'zh' | 'en';
  apiClient: GeoFlowApiClient;
  onNavigate: (tab: string) => void;
}

type ApiRecord = Record<string, unknown>;
const record = (value: unknown): ApiRecord => (value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {});
const list = (value: unknown): ApiRecord[] => (Array.isArray(value) ? value.filter((item): item is ApiRecord => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : []);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : Number(value ?? 0) || 0);
const text = (value: unknown, fallback = '—'): string => (value === null || value === undefined || value === '' ? fallback : String(value));

/**
 * SEO / AI 可发现性大盘（API 模式）。
 *
 * 只回答一条因果链：**能不能被抓到 → 有没有被抓 → 有没有被引用 → 带来了什么**。
 * 不做传统 SEO 指标（关键词排名、搜索量、外链）——这些没有可核验的数据源。
 * 每一段都直接读真实接口，失败时保留错误原文，不留演示数据。
 */
export const RealSeoDashboardView: React.FC<RealSeoDashboardViewProps> = ({ lang, apiClient, onNavigate }) => {
  const zh = lang === 'zh';
  const [audit, setAudit] = useState<ApiRecord | null>(null);
  const [traffic, setTraffic] = useState<ApiRecord | null>(null);
  const [radar, setRadar] = useState<ApiRecord | null>(null);
  const [competitor, setCompetitor] = useState<ApiRecord | null>(null);
  const [funnel, setFunnel] = useState<ApiRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const fail = (reason: unknown) => {
      if (cancelled) return;
      setError(reason instanceof GeoFlowApiError || reason instanceof Error ? reason.message : (zh ? 'SEO 数据加载失败' : 'Unable to load SEO data'));
    };
    Promise.allSettled([
      apiClient.getSeoAudit(),
      apiClient.getAnalyticsTraffic({ preset: '30d' }),
      apiClient.getQueryRadar({ days: 30 }),
      apiClient.getCompetitorRadar({ days: 30 }),
      apiClient.getAttributionFunnel(30),
    ]).then(([a, t, r, c, f]) => {
      if (cancelled) return;
      if (a.status === 'fulfilled') setAudit(record(a.value)); else fail(a.reason);
      if (t.status === 'fulfilled') setTraffic(record(t.value)); else fail(t.reason);
      if (r.status === 'fulfilled') setRadar(record(r.value)); else fail(r.reason);
      if (c.status === 'fulfilled') setCompetitor(record(c.value)); else fail(c.reason);
      if (f.status === 'fulfilled') setFunnel(record(f.value)); else fail(f.reason);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [apiClient, reloadKey, zh]);

  const findings = list(audit?.findings);
  const robots = record(audit?.robots);
  const botPolicies = list(robots.bot_policies);
  const blockedBots = list(robots.blocked_ai_crawlers);
  const llms = record(audit?.llms_txt);
  const sitemap = record(audit?.sitemap);

  const trafficSummary = record(traffic?.summary);
  const trafficKpis = record(trafficSummary.kpis);

  const brand = record(radar?.brand);
  const radarItems = list(radar?.items);
  const mentionAvailability = String(record(radarItems[0]).mentions ? record(record(radarItems[0]).mentions).availability : '');
  const competitorSummary = record(competitor?.summary);
  const funnelStages = list(funnel?.stages);

  // 首屏取数期间（五个接口都还没回来）才整块占位；已有任一数据后刷新不再替换。
  const firstLoad = loading && !audit && !traffic && !radar && !competitor && !funnel;

  const card = 'rounded-xl border border-slate-800 bg-slate-900/80 p-5';
  const sectionTitle = 'flex items-center gap-2 text-sm font-bold text-white';

  return (
    <div className="space-y-6" id="seo-dashboard-container">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-black text-white">
            <Radar className="h-6 w-6 text-violet-400" />
            {zh ? 'AI 可发现性大盘' : 'AI Discoverability'}
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            {zh
              ? '只看一条链：能不能被抓到 → 有没有被抓 → 有没有被引用 → 带来了什么。全部来自已持久化的配置与日志，不做排名/搜索量/外链这类没有数据源的指标。'
              : 'One chain only: crawlable → crawled → cited → converted. Everything comes from persisted configuration and logs; no ranking, volume, or backlink metrics we cannot source.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadKey((key) => key + 1)}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300 hover:text-white disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          {zh ? '刷新' : 'Refresh'}
        </button>
      </div>

      {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</div>}

      {firstLoad ? (
        <LoadingState lang={lang} variant="panel" label={zh ? '正在读取 SEO 诊断…' : 'Loading SEO diagnostics…'} />
      ) : (
        <>
      {/* ① 可发现性 */}
      <section className={card}>
        <div className="flex items-center justify-between">
          <h2 className={sectionTitle}><ShieldCheck className="h-4 w-4 text-emerald-400" />{zh ? '① 可发现性体检' : '① Discoverability audit'}</h2>
          <button type="button" onClick={() => onNavigate('seo_foundation')} className="text-[11px] text-indigo-400 hover:underline">{zh ? '去改配置' : 'Edit config'}</button>
        </div>
        {findings.length === 0 ? (
          <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" />{zh ? '当前生效配置没有发现问题。' : 'No issues in the effective configuration.'}</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {findings.map((finding, index) => (
              <li key={String(finding.key || index)} className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-100">
                <span className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-3.5 w-3.5" />{text(finding.title)}</span>
                <p className="mt-1 text-[11px] leading-relaxed text-amber-200/80">{text(finding.detail, '')}</p>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <div className="text-[11px] text-slate-400">llms.txt</div>
            <div className={`mt-1 text-sm font-bold ${llms.enabled ? 'text-emerald-300' : 'text-amber-300'}`}>{llms.enabled ? (zh ? '已启用' : 'Enabled') : (zh ? '未启用' : 'Disabled')}</div>
            <div className="text-[11px] text-slate-500">{zh ? '已发布文章 ' : 'Published '}{num(llms.published_article_count)}</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <div className="text-[11px] text-slate-400">sitemap</div>
            <div className={`mt-1 text-sm font-bold ${sitemap.enabled ? 'text-emerald-300' : 'text-amber-300'}`}>{sitemap.enabled ? (zh ? '已启用' : 'Enabled') : (zh ? '未启用' : 'Disabled')}</div>
            <div className="text-[11px] text-slate-500">{zh ? '已发布文章 ' : 'Published '}{num(sitemap.published_article_count)}</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <div className="text-[11px] text-slate-400">{zh ? 'AI 爬虫放行情况' : 'AI crawler access'}</div>
            <div className={`mt-1 text-sm font-bold ${blockedBots.length > 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
              {blockedBots.length > 0 ? (zh ? `被挡 ${blockedBots.length} 个` : `${blockedBots.length} blocked`) : (zh ? '全部放行' : 'All allowed')}
            </div>
            <div className="text-[11px] text-slate-500">
              {botPolicies.filter((p) => p.is_ai_crawler === true).map((p) => `${text(p.name)}:${text(p.action)}`).join(' · ') || '—'}
            </div>
          </div>
        </div>
      </section>

      {/* ② 抓取到达 */}
      <section className={card}>
        <div className="flex items-center justify-between">
          <h2 className={sectionTitle}><Bot className="h-4 w-4 text-sky-400" />{zh ? '② AI 爬虫到达（近 30 天）' : '② AI crawler reach (30d)'}</h2>
          <button type="button" onClick={() => onNavigate('analytics')} className="text-[11px] text-indigo-400 hover:underline">{zh ? '看流量明细' : 'Traffic detail'}</button>
        </div>
        {trafficSummary.has_data === true ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[11px] text-slate-400">{zh ? 'AI 爬虫访问' : 'AI bot visits'}</div><div className="mt-1 text-xl font-black text-white">{num(trafficKpis.ai_bot_pv)}</div></div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[11px] text-slate-400">{zh ? '总访问量' : 'Total PV'}</div><div className="mt-1 text-xl font-black text-white">{num(trafficKpis.pv)}</div></div>
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[11px] text-slate-400">{zh ? '独立 IP' : 'Unique IP'}</div><div className="mt-1 text-xl font-black text-white">{num(trafficKpis.unique_ip)}</div></div>
          </div>
        ) : (
          <p className="mt-3 text-xs text-slate-400">{zh ? '时间窗内没有访问日志，AI 爬虫到达情况不可计算。' : 'No access logs in this window; crawler reach is not computable.'}</p>
        )}
      </section>

      {/* ③ 可见性（只汇总，深入看各自标签） */}
      <section className={card}>
        <div className="flex items-center justify-between">
          <h2 className={sectionTitle}><Link2 className="h-4 w-4 text-violet-400" />{zh ? '③ 被引用与提及' : '③ Citations & mentions'}</h2>
          <div className="flex gap-2">
            <button type="button" onClick={() => onNavigate('query_radar')} className="text-[11px] text-indigo-400 hover:underline">{zh ? '查询雷达' : 'Query radar'}</button>
            <button type="button" onClick={() => onNavigate('competitor')} className="text-[11px] text-indigo-400 hover:underline">{zh ? '竞品雷达' : 'Competitor'}</button>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <div className="text-[11px] text-slate-400">{zh ? '品牌提及率' : 'Mention rate'}</div>
            <div className="mt-1 text-xl font-black text-white">
              {mentionAvailability === 'available' ? `${num(record(record(radarItems[0]).mentions).mention_rate_percent)}%` : (zh ? '不可计算' : 'Unavailable')}
            </div>
            <div className="text-[11px] text-slate-500">
              {brand.configured === true ? (zh ? `品牌：${text(brand.names && (brand.names as unknown[])[0])}` : `Brand: ${text(brand.names && (brand.names as unknown[])[0])}`) : (zh ? '尚未声明品牌' : 'No brand declared')}
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <div className="text-[11px] text-slate-400">{zh ? '自有引用份额' : 'Own citation share'}</div>
            <div className="mt-1 text-xl font-black text-white">
              {competitorSummary.own_citation_share_percent === null || competitorSummary.own_citation_share_percent === undefined
                ? (zh ? '不可计算' : 'Unavailable')
                : `${num(competitorSummary.own_citation_share_percent)}%`}
            </div>
            <div className="text-[11px] text-slate-500">{zh ? '竞品 ' : 'Competitors '}{num(competitorSummary.configured_competitor_count)}</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
            <div className="text-[11px] text-slate-400">{zh ? '我方缺席的问题' : 'Blind-spot queries'}</div>
            <div className="mt-1 text-xl font-black text-white">{num(competitorSummary.blindspot_query_count)}</div>
            <div className="text-[11px] text-slate-500">{zh ? '已观测引用 ' : 'Citations '}{num(competitorSummary.citation_observation_count)}</div>
          </div>
        </div>
      </section>

      {/* ④ 结果 */}
      <section className={card}>
        <div className="flex items-center justify-between">
          <h2 className={sectionTitle}><TrendingUp className="h-4 w-4 text-emerald-400" />{zh ? '④ AI 引荐带来的结果' : '④ What referrals produced'}</h2>
          <button type="button" onClick={() => onNavigate('attribution_funnel')} className="text-[11px] text-indigo-400 hover:underline">{zh ? '看归因漏斗' : 'Attribution'}</button>
        </div>
        {funnelStages.length === 0 ? (
          <p className="mt-3 text-xs text-slate-400">{zh ? '时间窗内没有可归因的 AI 引荐，结果不可计算。' : 'No attributable AI referrals in this window.'}</p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            {funnelStages.map((stage, index) => (
              <div key={String(stage.key || index)} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                <div className="text-[11px] text-slate-400">{text(stage.label, '')}</div>
                <div className="mt-1 text-xl font-black text-white">{num(stage.count)}</div>
              </div>
            ))}
          </div>
        )}
      </section>
        </>
      )}
    </div>
  );
};
