import React, { useState, useEffect } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, Radar, Bot, Link2, TrendingUp } from 'lucide-react';
import { GeoFlowApiClient, GeoFlowApiError } from '../api/geoflowClient';
import { LoadingState } from './LoadingState';
import { PageHeader } from './PageHeader';
import { TrendChart } from './ui';

interface RealSeoDashboardViewProps {
  /** 合并入口的内层 Tab 渲染：隐藏自身页面标题（由外层 TabbedShell 统一画），只留操作区。 */
  embedded?: boolean;
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
 *
 * 2026-09-19 版式对齐设计稿：**顶部四张 KPI 大卡 + 下方 2/3 与 1/3 分栏**。
 * ⚠️ 只有版式照搬——设计稿那四张卡的数（累计引用 28,450 / 首推占比 41.2% /
 * 权威置信度 94.8 / 召回率 99.1%）**全是编的**，真实系统里没有这些指标。
 * 这里换成四个**真有的**：品牌提及率、自有引用份额、我方缺席的问题、AI 爬虫访问。
 * 取不到就显示「不可计算」（例如没声明品牌实体时），**不用 0 或估算值冒充**。
 */
export const RealSeoDashboardView: React.FC<RealSeoDashboardViewProps> = ({ lang, apiClient, onNavigate, embedded = false }) => {
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
  const radarSummary = record(radar?.summary);
  /**
   * 站点级「品牌提及率」。
   *
   * 后端 `summary` 已经把**所有问题合起来**的分子分母算成 `mention_rate_percent` /
   * `mention_availability`（2026-09-25 起）。以前这里拿 `items[0]` 的提及率当站点数：
   * 第一个问题恰好没跑出回答就整张卡「不可计算」（哪怕其余 99 个问题都有数据），
   * 而且第一个问题一变、站点数字就跟着跳。后端没给才退回旧来源。
   */
  const siteMentionRate = radarSummary.mention_rate_percent;
  const mentionAvailability = String(
    radarSummary.mention_availability
      ?? (record(radarItems[0]).mentions ? record(record(radarItems[0]).mentions).availability : ''),
  );
  const siteMentionPercent = siteMentionRate === null || siteMentionRate === undefined
    ? num(record(record(radarItems[0]).mentions).mention_rate_percent)
    : Number(siteMentionRate);
  const competitorSummary = record(competitor?.summary);
  const funnelStages = list(funnel?.stages);

  // 首屏取数期间（五个接口都还没回来）才整块占位；已有任一数据后刷新不再替换。
  const firstLoad = loading && !audit && !traffic && !radar && !competitor && !funnel;

  const card = 'rounded-xl border border-slate-800 bg-slate-900 p-5';
  const sectionTitle = 'flex items-center gap-2 text-section-title';
  const subCard = 'rounded-lg bg-slate-800/40 px-4 py-3';

  const mentionReady = mentionAvailability === 'available';
  const ownShare = competitorSummary.own_citation_share_percent;
  const shareReady = ownShare !== null && ownShare !== undefined;

  /**
   * 趋势图数据。`/analytics/traffic` 的按天序列，两种位置都试一下
   * （有的投影把 `traffic_trend` 放在根、有的放在 `summary` 里）——**取不到就空数组**，
   * 由组件自己决定「不渲染」，不画假线。
   */
  const trendRows = (() => {
    const direct = traffic?.traffic_trend;
    if (Array.isArray(direct)) return direct as Array<Record<string, unknown>>;
    const nested = record(traffic?.summary).traffic_trend;
    return Array.isArray(nested) ? (nested as Array<Record<string, unknown>>) : [];
  })();
  const trendLabels = trendRows.map((row) => String(row.date ?? '').slice(5)); // 只留 MM-DD
  const trendSeries = trendRows.length >= 2 ? [
    /* ⚠️ 不能写 `text-indigo-400`：本项目的主色刻度已被改成中性灰
       （主色是墨黑，indigo 槽位整条让给了中性档），画出来是一条浅灰线。
       第一条用近黑的 slate-200 承担「主指标」的视觉重量，第二条用绿。 */
    { name: zh ? '总访问量' : 'Total PV', values: trendRows.map((r) => num(r.pv)), tone: 'text-slate-200' },
    { name: zh ? 'AI 爬虫访问' : 'AI bot PV', values: trendRows.map((r) => num(r.ai_bot_pv)), tone: 'text-emerald-500' },
  ] : [];

  return (
    <div className="space-y-6" id="seo-dashboard-container">
      <div className={`flex flex-col gap-3 sm:flex-row sm:items-center ${embedded ? 'sm:justify-end' : 'sm:justify-between'}`}>
        <PageHeader
          embedded={embedded}
          icon={Radar}
          group={zh ? 'GEO 诊断' : 'Diagnosis'}
          title={zh ? 'SEO 总览' : 'SEO Overview'}
          description={zh ? '一条链看全：能不能被 AI 抓到 → 有没有被抓 → 有没有被引用 → 带来了什么。数字只来自真实配置与日志。' : 'One chain: crawlable → crawled → cited → converted — persisted data only.'}
        />
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs text-slate-400">
            <Bot className="h-3.5 w-3.5 text-slate-500" />
            <span>{zh ? '近 30 天表现' : 'Last 30 days'}</span>
          </div>
          <button
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            disabled={loading}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            {zh ? '刷新' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</div>}

      {firstLoad ? (
        <LoadingState lang={lang} variant="panel" label={zh ? '正在读取 SEO 诊断…' : 'Loading SEO diagnostics…'} />
      ) : (
        <>
      {/* ══ KPI 大卡行（设计稿版式；四项全部来自真实接口） ══════════════════ */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <div className="text-xs text-slate-400">{zh ? '品牌提及率' : 'Mention rate'}</div>
          <div className={`mt-1 text-2xl font-extrabold ${mentionReady ? 'text-white' : 'text-slate-500'}`}>
            {mentionReady ? `${siteMentionPercent}%` : (zh ? '不可计算' : 'Unavailable')}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {brand.configured === true
              ? (zh ? `品牌：${text(brand.names && (brand.names as unknown[])[0])}` : `Brand: ${text(brand.names && (brand.names as unknown[])[0])}`)
              : (zh ? '尚未声明品牌实体' : 'No brand declared')}
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <div className="text-xs text-slate-400">{zh ? '自有引用份额' : 'Own citation share'}</div>
          <div className={`mt-1 text-2xl font-extrabold ${shareReady ? 'text-white' : 'text-slate-500'}`}>
            {shareReady ? `${num(ownShare)}%` : (zh ? '不可计算' : 'Unavailable')}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">{zh ? '竞品 ' : 'Competitors '}{num(competitorSummary.configured_competitor_count)}</div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <div className="text-xs text-slate-400">{zh ? '我方缺席的问题' : 'Blind-spot queries'}</div>
          <div className="mt-1 text-2xl font-extrabold text-white">{num(competitorSummary.blindspot_query_count)}</div>
          <div className="mt-1 text-[11px] text-slate-500">{zh ? '已观测引用 ' : 'Citations '}{num(competitorSummary.citation_observation_count)}</div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <div className="text-xs text-slate-400">{zh ? 'AI 爬虫访问（近 30 天）' : 'AI bot visits (30d)'}</div>
          <div className={`mt-1 text-2xl font-extrabold ${trafficSummary.has_data === true ? 'text-white' : 'text-slate-500'}`}>
            {trafficSummary.has_data === true ? num(trafficKpis.ai_bot_pv) : (zh ? '不可计算' : 'Unavailable')}
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            {trafficSummary.has_data === true ? (zh ? `总访问量 ${num(trafficKpis.pv)}` : `PV ${num(trafficKpis.pv)}`) : (zh ? '时间窗内没有访问日志' : 'No access logs')}
          </div>
        </div>
      </div>

      {/* ══ 抓取与访问趋势（设计稿那一屏的核心图形） ═══════════════════════
          数据是 `/analytics/traffic` 的按天序列，**真访问日志**。
          设计稿这里画的是「各搜索引擎引用曝光趋势」——那个数据我们没有，
          所以画的是**我们真有的**：总访问量与 AI 爬虫访问。
          序列不足两个点、或时间窗内没有日志时，整块不渲染。 */}
      {trendSeries.length > 0 && (
        <section className={card}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className={sectionTitle}>{zh ? '抓取与访问趋势' : 'Crawl & traffic trend'}</h2>
              <p className="mt-1 text-[12px] text-slate-500">{zh ? '按天的访问与 AI 爬虫到达（近 30 天）' : 'Daily PV and AI bot reach (30d)'}</p>
            </div>
            <div className="flex items-center gap-3 text-[12px]">
              {trendSeries.map((s) => (
                <span key={s.name} className={`flex items-center gap-1.5 font-medium ${s.tone}`}>
                  <span className="h-2.5 w-2.5 rounded-full bg-current" />
                  {s.name}
                </span>
              ))}
            </div>
          </div>
          <TrendChart labels={trendLabels} series={trendSeries} height={200} className="text-slate-400" />
        </section>
      )}

      {/* ══ 2/3 + 1/3 分栏（设计稿版式） ═════════════════════════════════ */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* ① 可发现性体检 */}
        <section className={`${card} lg:col-span-2`}>
          <div className="flex items-center justify-between">
            <h2 className={sectionTitle}><ShieldCheck className="h-4 w-4 text-emerald-400" />{zh ? '① 可发现性体检' : '① Discoverability audit'}</h2>
            <button type="button" onClick={() => onNavigate('seo_foundation')} className="text-[12.5px] text-indigo-400 hover:underline">{zh ? '去改配置' : 'Edit config'}</button>
          </div>
          {findings.length === 0 ? (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" />{zh ? '当前生效配置没有发现问题。' : 'No issues in the effective configuration.'}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {findings.map((finding, index) => (
                <li key={String(finding.key || index)} className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[13px] text-amber-100">
                  <span className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-3.5 w-3.5" />{text(finding.title)}</span>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-amber-200/80">{text(finding.detail, '')}</p>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className={subCard}>
              <div className="text-[12px] text-slate-400">llms.txt</div>
              <div className={`mt-1 text-sm font-bold ${llms.enabled ? 'text-emerald-300' : 'text-amber-300'}`}>{llms.enabled ? (zh ? '已启用' : 'Enabled') : (zh ? '未启用' : 'Disabled')}</div>
              <div className="text-[12px] text-slate-500">{zh ? '已发布文章 ' : 'Published '}{num(llms.published_article_count)}</div>
            </div>
            <div className={subCard}>
              <div className="text-[12px] text-slate-400">sitemap</div>
              <div className={`mt-1 text-sm font-bold ${sitemap.enabled ? 'text-emerald-300' : 'text-amber-300'}`}>{sitemap.enabled ? (zh ? '已启用' : 'Enabled') : (zh ? '未启用' : 'Disabled')}</div>
              <div className="text-[12px] text-slate-500">{zh ? '已发布文章 ' : 'Published '}{num(sitemap.published_article_count)}</div>
            </div>
            <div className={subCard}>
              <div className="text-[12px] text-slate-400">{zh ? 'AI 爬虫放行情况' : 'AI crawler access'}</div>
              <div className={`mt-1 text-sm font-bold ${blockedBots.length > 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
                {blockedBots.length > 0 ? (zh ? `被挡 ${blockedBots.length} 个` : `${blockedBots.length} blocked`) : (zh ? '全部放行' : 'All allowed')}
              </div>
              <div className="text-[12px] text-slate-500">
                {botPolicies.filter((p) => p.is_ai_crawler === true).map((p) => `${text(p.name)}:${text(p.action)}`).join(' · ') || '—'}
              </div>
            </div>
          </div>
        </section>

        {/* ② 抓取到达 */}
        <section className={card}>
          <div className="flex items-center justify-between">
            <h2 className={sectionTitle}><Bot className="h-4 w-4 text-indigo-400" />{zh ? '② AI 爬虫到达' : '② Crawler reach'}</h2>
            <button type="button" onClick={() => onNavigate('analytics')} className="text-[12.5px] text-indigo-400 hover:underline">{zh ? '流量明细' : 'Traffic'}</button>
          </div>
          {trafficSummary.has_data === true ? (
            <div className="mt-4 space-y-3">
              <div className={subCard}><div className="text-[12px] text-slate-400">{zh ? '总访问量（近 30 天）' : 'Total PV (30d)'}</div><div className="mt-1 text-xl font-black text-white">{num(trafficKpis.pv)}</div></div>
              <div className={subCard}><div className="text-[12px] text-slate-400">{zh ? '独立 IP' : 'Unique IP'}</div><div className="mt-1 text-xl font-black text-white">{num(trafficKpis.unique_ip)}</div></div>
            </div>
          ) : (
            <p className="mt-3 text-[13px] text-slate-400">{zh ? '时间窗内没有访问日志，AI 爬虫到达情况不可计算。' : 'No access logs in this window; crawler reach is not computable.'}</p>
          )}
        </section>
      </div>

      {/* ══ ③ 被引用与提及 ═══════════════════════════════════════════════ */}
      <section className={card}>
        <div className="flex items-center justify-between">
          <h2 className={sectionTitle}><Link2 className="h-4 w-4 text-indigo-400" />{zh ? '③ 被引用与提及' : '③ Citations & mentions'}</h2>
          <div className="flex gap-2">
            <button type="button" onClick={() => onNavigate('query_radar')} className="text-[12.5px] text-indigo-400 hover:underline">{zh ? '查询雷达' : 'Query radar'}</button>
            <button type="button" onClick={() => onNavigate('competitor')} className="text-[12.5px] text-indigo-400 hover:underline">{zh ? '竞品雷达' : 'Competitor'}</button>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className={subCard}>
            <div className="text-[12px] text-slate-400">{zh ? '品牌提及率' : 'Mention rate'}</div>
            <div className={`mt-1 text-xl font-black ${mentionReady ? 'text-white' : 'text-slate-500'}`}>
              {mentionReady ? `${siteMentionPercent}%` : (zh ? '不可计算' : 'Unavailable')}
            </div>
            <div className="text-[12px] text-slate-500">
              {brand.configured === true ? (zh ? `品牌：${text(brand.names && (brand.names as unknown[])[0])}` : `Brand: ${text(brand.names && (brand.names as unknown[])[0])}`) : (zh ? '尚未声明品牌' : 'No brand declared')}
            </div>
          </div>
          <div className={subCard}>
            <div className="text-[12px] text-slate-400">{zh ? '自有引用份额' : 'Own citation share'}</div>
            <div className={`mt-1 text-xl font-black ${shareReady ? 'text-white' : 'text-slate-500'}`}>
              {shareReady ? `${num(ownShare)}%` : (zh ? '不可计算' : 'Unavailable')}
            </div>
            <div className="text-[12px] text-slate-500">{zh ? '竞品 ' : 'Competitors '}{num(competitorSummary.configured_competitor_count)}</div>
          </div>
          <div className={subCard}>
            <div className="text-[12px] text-slate-400">{zh ? '我方缺席的问题' : 'Blind-spot queries'}</div>
            <div className="mt-1 text-xl font-black text-white">{num(competitorSummary.blindspot_query_count)}</div>
            <div className="text-[12px] text-slate-500">{zh ? '已观测引用 ' : 'Citations '}{num(competitorSummary.citation_observation_count)}</div>
          </div>
        </div>
      </section>

      {/* ══ ④ 结果 ═══════════════════════════════════════════════════════ */}
      <section className={card}>
        <div className="flex items-center justify-between">
          <h2 className={sectionTitle}><TrendingUp className="h-4 w-4 text-emerald-400" />{zh ? '④ AI 引荐带来的结果' : '④ What referrals produced'}</h2>
          <button type="button" onClick={() => onNavigate('attribution_funnel')} className="text-[12.5px] text-indigo-400 hover:underline">{zh ? '看归因漏斗' : 'Attribution'}</button>
        </div>
        {funnelStages.length === 0 ? (
          <p className="mt-3 text-[13px] text-slate-400">{zh ? '时间窗内没有可归因的 AI 引荐，结果不可计算。' : 'No attributable AI referrals in this window.'}</p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            {funnelStages.map((stage, index) => (
              <div key={String(stage.key || index)} className={subCard}>
                <div className="text-[12px] text-slate-400">{text(stage.label, '')}</div>
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
