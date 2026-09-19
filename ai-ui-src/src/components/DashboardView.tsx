import React from 'react';
import {
  ArrowUpRight,
  AlertTriangle,
  Activity,
  FileText,
  LayoutDashboard,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { ApiRecord } from '../api/geoflowClient';
import { Article, Task } from '../types';
import { GettingStartedPanel, GettingStartedStep } from './GettingStartedPanel';
import { Skeleton, SkeletonRows } from './Skeleton';
import { Sparkline, BarList } from './ui';

/**
 * 按点号路径从后端投影里取值（`kpis.articles`、`traffic.kpis.pv`）。
 *
 * 这个助手存在的理由：概览大盘的 KPI 曾经**按顶层键**去读 `/analytics/overview`，
 * 而那些键（`total_articles` / `active_ai_models` …）根本不在这个载荷里（它的顶层是
 * `kpis` / `task_health` / `ai_health` / `traffic` …），于是六个格子**全是「—」**，
 * 看起来像「新后台没有这些数据」。按真实路径取值，缺什么就明确显示「暂无数据」。
 */
const readPath = (source: ApiRecord | null | undefined, path: string): unknown => {
  let cursor: unknown = source;
  for (const key of path.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as ApiRecord)[key];
  }
  return cursor;
};

/** 只有拿到有限数值才返回数字；列表、字符串、null 一律返回 null（由调用方显示「暂无数据」）。 */
const readNumber = (source: ApiRecord | null | undefined, path: string): number | null => {
  const raw = readPath(source, path);
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

interface DashboardViewProps {
  stats: any;
  articles: Article[];
  tasks: Task[];
  onNavigate: (tab: string) => void;
  onSelectArticle: (article: Article) => void;
  lang: 'zh' | 'en';
  /** In API mode, only values supplied by 桐灼GEO are shown; no demo formulas. */
  apiMode?: boolean;
  analyticsOverview?: ApiRecord | null;
  /** 「开始使用」清单；由 App 从真实目录/就绪度推导后传入。 */
  gettingStarted?: GettingStartedStep[];
  /**
   * 首轮业务数据是否还在读取（外壳可能先于数据渲染）。
   * 为 true 时数值格显示骨架、清单与「下一步」不渲染——显示 0 / 暂无数据 / 未配置
   * 都是把「还不知道」说成「确认如此」。
   */
  loading?: boolean;
  /** 「AI 生成文章」主操作（跳到文章页并打开生成弹窗）。 */
  onGenerate?: () => void;
}

/**
 * 工作台。
 *
 * 2026-09-18 版式重排（对齐外部设计稿）：**深色首屏横幅 → 核心表现 → 待办清单 + 生成任务
 * 并列 → 最近内容**。与旧版的差别只在版式——横幅把「今天有多少事等你」提到第一眼，
 * 待办从四张卡改成一份清单（同一批数据，一屏能扫完，也更符合「先处理今天要做的」）。
 *
 * 取值原则不变：**取不到就显示「暂无数据」，绝不用 0 或估算值冒充**。
 * `data-todo` 保留：冒烟测试靠它断言「待审磁贴能跳到文章页」。
 */
export const DashboardView: React.FC<DashboardViewProps> = ({
  articles,
  tasks,
  onNavigate,
  onSelectArticle,
  lang,
  apiMode = false,
  analyticsOverview,
  gettingStarted = [],
  loading = false,
  onGenerate,
}) => {
  const zh = lang === 'zh';

  const publishedCount = articles.filter((a) => a.status === 'published').length;
  const reviewCount = articles.filter((a) => a.status === 'review').length;

  // —— 第一层：GEO 核心表现（全部来自后端真实投影，取不到即 null）——
  const brandVisibility = readNumber(analyticsOverview, 'ai_visibility.kpis.brand_visibility');
  const top3Rate = readNumber(analyticsOverview, 'ai_visibility.kpis.top3_rate');
  const aiVisibilityConfigured = readPath(analyticsOverview, 'ai_visibility.configuration.configured') === true;
  const pv = readNumber(analyticsOverview, 'traffic.kpis.pv');
  const totalArticles = readNumber(analyticsOverview, 'kpis.articles');

  // —— 第二层：今天要做什么（只列真需要用户动手的）——
  const pausedTasks = readNumber(analyticsOverview, 'task_health.paused_tasks') ?? 0;
  const pendingLeads = readNumber(analyticsOverview, 'leads.kpis.pending') ?? 0;
  const distributionFailed = readNumber(analyticsOverview, 'kpis.distribution_failed') ?? 0;
  const generatingCount = tasks.filter((t) => t.status === 'running').length;

  /**
   * 图形层的数据源——**全部来自 `/analytics/overview` 的 `traffic` 段，不额外请求**：
   *   `traffic.traffic_trend` 是按天的 { date, pv, unique_ip, ai_bot_pv }
   *   `traffic.bot_breakdown` 是访客构成 { key, label, count }
   * 取不到就返回空数组，由组件自己决定「不渲染」而不是画一条假的平线。
   */
  const trafficTrend = Array.isArray(readPath(analyticsOverview, 'traffic.traffic_trend'))
    ? (readPath(analyticsOverview, 'traffic.traffic_trend') as Array<Record<string, unknown>>)
    : [];
  const pvSeries = trafficTrend.map((row) => Number(row.pv) || 0);
  const aiBotSeries = trafficTrend.map((row) => Number(row.ai_bot_pv) || 0);
  const botBreakdown = Array.isArray(readPath(analyticsOverview, 'traffic.bot_breakdown'))
    ? (readPath(analyticsOverview, 'traffic.bot_breakdown') as Array<Record<string, unknown>>)
    : [];
  const botItems = botBreakdown
    .map((row) => ({ label: String(row.label || row.key || ''), value: Number(row.count) || 0 }))
    .filter((row) => row.label !== '');

  const todoItems = [
    { key: 'review', label: zh ? '篇文章待审核' : 'articles to review', hint: zh ? '审完就能发布' : 'review, then publish', count: reviewCount, tab: 'articles', tone: 'amber' },
    { key: 'paused', label: zh ? '个生成任务已暂停' : 'tasks paused', hint: zh ? '看看为什么停了' : 'check why they stopped', count: pausedTasks, tab: 'tasks', tone: 'amber' },
    { key: 'leads', label: zh ? '条线索待处理' : 'leads pending', hint: zh ? '尽快联系，缩短响应时间' : 'contact them sooner', count: pendingLeads, tab: 'attribution_funnel', tone: 'indigo' },
    { key: 'dist', label: zh ? '个发布任务失败' : 'publishing failed', hint: zh ? '重新投递或检查渠道' : 'retry or check channels', count: distributionFailed, tab: 'distribution', tone: 'rose' },
  ].filter((item) => item.count > 0);

  const recentArticles = [...articles]
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    .slice(0, 6);
  const activeTasks = tasks.filter((t) => t.status === 'running' || t.status === 'paused').slice(0, 6);

  const formatMetric = (value: number | null, suffix = '') =>
    value === null ? (zh ? '暂无数据' : 'No data') : `${value}${suffix}`;

  const toneText: Record<string, string> = {
    amber: 'text-amber-600',
    indigo: 'text-indigo-600',
    rose: 'text-rose-600',
  };
  const toneDot: Record<string, string> = {
    amber: 'bg-amber-500',
    indigo: 'bg-indigo-500',
    rose: 'bg-rose-500',
  };

  const today = new Date();
  const todayLabel = zh
    ? `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日 · 星期${'日一二三四五六'[today.getDay()]}`
    : today.toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      {/* ══ 首屏横幅（深色） ══════════════════════════════════════════════
          把「今天有多少事等你」提到第一眼。深色面的文字色由 .app-dark-surface
          作用域里的反相刻度决定（见 index.css），这里正常写 text-slate-400 即可。 */}
      <div className="app-dark-surface flex flex-wrap items-center justify-between gap-5 rounded-xl px-6 py-5">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            {/* ⚠️ 这里**不能用装饰性色阶**（如 `text-indigo-300`）：收敛层有一条
                `:root:not(.dark) :where(.text-indigo-50 … .text-indigo-400) { color: var(--color-indigo-800) }`，
                会把浅档强制压深——落在深色横幅上就是深字压深底，实测只有 1.21:1、肉眼几乎看不见。
                深色面内的文字一律走 slate 刻度（作用域里已反相）。 */}
            <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-300">
              {zh ? '今日看板' : 'Today'}
            </span>
            <span className="text-[11px] tabular-nums text-slate-400">{todayLabel}</span>
          </div>
          {loading ? (
            <div className="py-1"><Skeleton className="h-6 w-64" label={zh ? '正在读取' : 'Loading'} /></div>
          ) : (
            <h1 className="text-xl font-bold text-white">
              {reviewCount > 0
                ? (zh
                  ? <>今天有 <span className="text-amber-400">{reviewCount} 篇</span>文章等待审核发布</>
                  : <>{reviewCount} article(s) waiting for review</>)
                : (zh ? '今天没有待审文章' : 'Nothing to review today')}
            </h1>
          )}
          <p className="mt-1.5 max-w-2xl text-xs text-slate-400">
            {loading
              ? (zh ? '正在读取待办…' : 'Loading…')
              : todoItems.length > 0
                ? todoItems.map((i) => `${i.count} ${i.label}`).join(' · ')
                : (zh ? '没有待处理事项——没有待审文章、没有暂停的任务、没有待跟进线索。' : 'Nothing needs your attention right now.')}
          </p>
        </div>
        {onGenerate && (
          <button
            type="button"
            onClick={onGenerate}
            className="flex shrink-0 items-center gap-2 rounded-lg bg-white px-4 py-2.5 text-xs font-semibold text-slate-900 transition hover:bg-slate-100"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {zh ? 'AI 生成文章' : 'Generate with AI'}
          </button>
        )}
      </div>

      {/* 「开始使用」清单：还没配齐时出现，配齐了它自己消失。
          加载中不渲染：此刻「未配置」还没被后端确认，显示出来就是假状态。 */}
      {!loading && <GettingStartedPanel steps={gettingStarted} lang={lang} />}

      {/* ══ 核心表现 ═════════════════════════════════════════════════════ */}
      <section className="space-y-3">
        <h2 className="text-section-title">{zh ? 'GEO 核心表现' : 'GEO performance'}</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            /* 四张卡：两张带迷你趋势线（有真实按天序列的才画），两张只有数字。
               **不给没有序列的指标硬画线**——那会是一条假的平线。 */
            { label: zh ? '今日待审核' : 'To review', value: reviewCount, suffix: zh ? ' 篇' : '' },
            { label: zh ? '网站访问（近 30 天）' : 'Site views (30d)', value: pv, series: pvSeries, tone: 'text-slate-200' },
            {
              label: zh ? 'AI 爬虫访问（近 30 天）' : 'AI bot visits (30d)',
              value: aiBotSeries.length ? aiBotSeries.reduce((a, b) => a + b, 0) : null,
              series: aiBotSeries,
              /* 别用 indigo：主色刻度已改成中性灰，画出来是一条灰线 */
              tone: 'text-emerald-500',
            },
            { label: zh ? '内容资产（已发布/总数）' : 'Published / total', value: null, text: `${publishedCount} / ${totalArticles ?? articles.length}` },
          ].map((tile: { label: string; value: number | null; suffix?: string; text?: string; series?: number[]; tone?: string }) => (
            <div key={tile.label} className="rounded-xl border border-slate-800 bg-slate-900 p-5 transition hover:border-slate-700">
              <div className="text-caption">{tile.label}</div>
              {/* 加载中画骨架，不画 0 / 暂无数据：那会把「还没读到」说成「确认是零」。 */}
              {loading ? (
                <Skeleton className="mt-3 h-8 w-24" label={zh ? '正在读取' : 'Loading'} />
              ) : (
                <div className={`mt-2 text-[30px] font-black leading-none tabular-nums ${tile.text ? 'text-white' : tile.value === null ? 'text-slate-500' : 'text-white'}`}>
                  {tile.text ?? formatMetric(tile.value, tile.suffix ?? '')}
                </div>
              )}
              {!loading && tile.series && tile.series.length >= 2 && (
                <div className={`mt-3 h-8 ${tile.tone ?? 'text-slate-500'}`}>
                  <Sparkline
                    values={tile.series}
                    label={zh ? `${tile.label}趋势` : `${tile.label} trend`}
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        {!loading && !aiVisibilityConfigured && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-amber-500/25 bg-amber-500/8 px-5 py-3.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            <span className="text-[13px] text-slate-200">
              {zh
                ? 'AI 可见性监测还没配置，所以「AI 提及率」和「Top3 引用率」暂时没有数据。'
                : 'AI visibility monitoring is not configured yet, so mention rates have no data.'}
            </span>
            <button
              type="button"
              onClick={() => onNavigate('ai-models')}
              className="text-[13px] font-semibold text-indigo-600 hover:underline"
            >
              {zh ? '去配置采集来源 →' : 'Configure sources →'}
            </button>
          </div>
        )}
      </section>

      {/* ══ 待办清单 + 生成任务 ═══════════════════════════════════════════
          待办从「四张卡」改成「一份清单」：同一批数据，一屏能扫完。
          没有待办时给一条明确的「一切正常」，而不是空着让人猜。 */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-section-title flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              {zh ? '今日待办' : 'To do today'}
            </h2>
            {!loading && (
              <span className="text-caption">
                {todoItems.length > 0 ? (zh ? `共 ${todoItems.length} 项` : `${todoItems.length} item(s)`) : (zh ? '没有待办，一切正常' : 'Nothing pending')}
              </span>
            )}
          </div>

          {loading ? (
            <div className="py-4"><SkeletonRows rows={3} /></div>
          ) : todoItems.length === 0 ? (
            <div className="flex items-center gap-3 rounded-xl bg-slate-800/60 px-5 py-4">
              <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-500" />
              <span className="text-body">
                {zh ? '没有待处理事项——没有待审文章、没有暂停的任务、没有待跟进线索。' : 'Nothing needs your attention right now.'}
              </span>
            </div>
          ) : (
            <ul className="space-y-2">
              {todoItems.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    data-todo={item.key}
                    onClick={() => onNavigate(item.tab)}
                    className="group flex w-full items-center gap-4 rounded-xl border border-slate-800 px-4 py-3 text-left transition hover:border-slate-700 hover:bg-slate-800/40"
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${toneDot[item.tone] ?? 'bg-slate-500'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className={`text-lg font-black leading-none tabular-nums ${toneText[item.tone] ?? 'text-white'}`}>
                          {item.count}
                        </span>
                        <span className="truncate text-[13.5px] font-semibold text-white">{item.label}</span>
                      </span>
                      <span className="mt-0.5 block text-caption">{item.hint}</span>
                    </span>
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-500 transition group-hover:text-indigo-600" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-section-title flex items-center gap-2">
              <Activity className="h-[18px] w-[18px] text-slate-400" />
              {zh ? '生成任务' : 'Generation tasks'}
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('tasks')}
              className="flex items-center gap-1 text-[13px] font-semibold text-indigo-600 hover:underline"
            >
              {zh ? '管理' : 'Manage'}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {loading ? (
            <div className="py-4"><SkeletonRows rows={3} /></div>
          ) : activeTasks.length === 0 ? (
            <div className="py-10 text-center text-caption">{zh ? '没有正在跑或暂停的任务' : 'No running or paused tasks'}</div>
          ) : (
            <ul className="divide-y divide-slate-800/70">
              {activeTasks.map((task) => (
                <li key={task.id} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="truncate text-[13.5px] font-medium text-slate-200">{task.name}</span>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold ${
                      task.status === 'paused' ? 'bg-amber-500/10 text-amber-600' : 'bg-emerald-500/10 text-emerald-600'
                    }`}
                  >
                    {task.status === 'paused' ? (zh ? '已暂停' : 'Paused') : zh ? '运行中' : 'Running'}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!loading && generatingCount > 0 && (
            <p className="mt-4 text-caption">
              {zh ? `另外有 ${generatingCount} 条任务正在生成。` : `${generatingCount} task(s) generating.`}
            </p>
          )}
        </div>

        {/* 访问构成（横向条形）——数据来自 `traffic.bot_breakdown`，真访问日志。
            空的时候**整块不渲染**：一张空面板比不显示更让人困惑。 */}
        {!loading && botItems.length > 0 && (
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-section-title flex items-center gap-2">
                <Activity className="h-[18px] w-[18px] text-slate-400" />
                {zh ? '访问构成' : 'Traffic mix'}
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('analytics')}
                className="flex items-center gap-1 text-[13px] font-semibold text-indigo-600 hover:underline"
              >
                {zh ? '明细' : 'Detail'}
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            </div>
            <BarList items={botItems} tone="text-indigo-400" />
          </div>
        )}
        </div>
      </section>

      {/* ══ 最近内容 ═════════════════════════════════════════════════════ */}
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-section-title flex items-center gap-2">
            <FileText className="h-[18px] w-[18px] text-slate-400" />
            {zh ? '最近内容' : 'Recent content'}
          </h2>
          <button
            type="button"
            onClick={() => onNavigate('articles')}
            className="flex items-center gap-1 text-[13px] font-semibold text-indigo-600 hover:underline"
          >
            {zh ? '查看全部' : 'View all'}
            <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {loading ? (
          <div className="py-4"><SkeletonRows rows={4} /></div>
        ) : recentArticles.length === 0 ? (
          <div className="py-10 text-center text-caption">
            {zh ? '还没有文章——点上方「AI 生成文章」写第一篇。' : 'No articles yet.'}
          </div>
        ) : (
          <ul className="divide-y divide-slate-800/70">
            {recentArticles.map((art) => (
              <li key={art.id}>
                <button
                  type="button"
                  onClick={() => onSelectArticle(art)}
                  className="flex w-full items-center justify-between gap-4 py-2.5 text-left transition hover:text-indigo-600"
                >
                  <span className="truncate text-[13.5px] font-medium text-slate-200">{art.title}</span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold ${
                        art.status === 'published' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600'
                      }`}
                    >
                      {art.status === 'published' ? (zh ? '已发布' : 'Published') : zh ? '待审核' : 'In review'}
                    </span>
                    <span className="text-[11.5px] tabular-nums text-slate-500">{art.createdAt}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 快捷入口（照设计稿）：把两条最常用的动线放到底部，省一次侧栏点击。 */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <button
          type="button"
          data-todo="quick-articles"
          onClick={() => onNavigate('articles')}
          className="group flex items-center gap-4 rounded-xl border border-slate-800 bg-slate-900 p-5 text-left transition hover:border-slate-700"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-slate-300">
            <FileText className="h-[20px] w-[20px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold text-white">{zh ? '批量审核文章列表' : 'Batch review list'}</span>
            <span className="mt-0.5 block text-caption">{zh ? '含多选、筛选与状态徽标' : 'Multi-select, filters, status badges'}</span>
          </span>
          <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-500 transition group-hover:text-indigo-600" />
        </button>

        <button
          type="button"
          data-todo="quick-materials"
          onClick={() => onNavigate('materials')}
          className="group flex items-center gap-4 rounded-xl border border-slate-800 bg-slate-900 p-5 text-left transition hover:border-slate-700"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-slate-300">
            <Sparkles className="h-[20px] w-[20px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold text-white">{zh ? '素材与知识库维护' : 'Materials & knowledge'}</span>
            <span className="mt-0.5 block text-caption">{zh ? '标题库、知识库、关键词与图片' : 'Titles, knowledge, keywords, images'}</span>
          </span>
          <ArrowUpRight className="h-4 w-4 shrink-0 text-slate-500 transition group-hover:text-indigo-600" />
        </button>
      </section>
    </div>
  );
};
