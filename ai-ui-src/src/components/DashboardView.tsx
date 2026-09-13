import React from 'react';
import {
  FileText,
  ArrowUpRight,
  Eye,
  Activity,
  AlertTriangle,
  Sparkles,
  ShieldCheck,
} from 'lucide-react';
import { ApiRecord } from '../api/geoflowClient';
import { Article, Task } from '../types';

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
}

/**
 * 总览页。
 *
 * 设计原则（2026-09-13 重构）：
 * 1. **三层，只留客户关心的业务指标** —— GEO 核心表现 / 待处理事项 / 最近变化。
 * 2. **技术指标一律不上首页**（模型数、RAG 切片数、任务状态、爬虫 PV、Provider、Worker）
 *    ——那些是系统指标，不是客户指标。
 * 3. **不重复统计**：同一件事只出现一次。
 * 4. **取不到就显示「暂无数据」**，绝不用 0 或估算值冒充（哥哥 2026-09-13 硬性要求）。
 */
export const DashboardView: React.FC<DashboardViewProps> = ({
  articles,
  tasks,
  onNavigate,
  onSelectArticle,
  lang,
  apiMode = false,
  analyticsOverview,
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

  // —— 第二层：待处理事项（只列真需要用户动手的）——
  const pausedTasks = readNumber(analyticsOverview, 'task_health.paused_tasks') ?? 0;
  const pendingLeads = readNumber(analyticsOverview, 'leads.kpis.pending') ?? 0;
  const distributionFailed = readNumber(analyticsOverview, 'kpis.distribution_failed') ?? 0;
  const pendingItems = [
    { key: 'review', label: zh ? '篇文章待审核' : 'articles to review', count: reviewCount, tab: 'articles' },
    { key: 'paused', label: zh ? '个生成任务已暂停' : 'tasks paused', count: pausedTasks, tab: 'tasks' },
    { key: 'leads', label: zh ? '条线索待处理' : 'leads pending', count: pendingLeads, tab: 'leads' },
    { key: 'dist', label: zh ? '个发布任务失败' : 'publishing failed', count: distributionFailed, tab: 'distribution' },
  ].filter((item) => item.count > 0);

  // —— 「下一步做什么」：由真实状态推导，不写死 ——
  const nextStep = (() => {
    if (reviewCount > 0) {
      return {
        text: zh ? `有 ${reviewCount} 篇文章等你审核，审完就能发布` : `${reviewCount} articles await review`,
        cta: zh ? '去审核' : 'Review now',
        tab: 'articles',
      };
    }
    if ((totalArticles ?? 0) === 0) {
      return {
        text: zh ? '还没有内容。先写第一篇文章吧' : 'No content yet — write your first article',
        cta: zh ? '写文章' : 'Write',
        tab: 'generator',
      };
    }
    return {
      text: zh ? '内容都在处理中，去看看 AI 有没有引用你' : 'Check whether AI cites you',
      cta: zh ? '看效果' : 'View results',
      tab: 'analytics',
    };
  })();

  const recentArticles = [...articles]
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    .slice(0, 5);
  const activeTasks = tasks.filter((t) => t.status === 'running' || t.status === 'paused').slice(0, 5);

  const formatMetric = (value: number | null, suffix = '') =>
    value === null ? (zh ? '暂无数据' : 'No data') : `${value}${suffix}`;

  return (
    <div className="space-y-6">
      {/* 下一步引导：状态驱动，不是静态教程 */}
      <div className="bg-indigo-600/10 border border-indigo-500/30 rounded-2xl p-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Sparkles className="w-5 h-5 text-indigo-300 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-white truncate">{zh ? '下一步' : 'Next step'}</div>
            <div className="text-xs text-slate-300 truncate">{nextStep.text}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onNavigate(nextStep.tab)}
          className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white transition"
        >
          {nextStep.cta}
          <ArrowUpRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ① GEO 核心表现 */}
      <section className="space-y-3">
        <h2 className="text-sm font-bold text-white">{zh ? 'GEO 核心表现' : 'GEO Performance'}</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: zh ? 'AI 提及率' : 'AI mention rate', value: brandVisibility, suffix: '%' },
            { label: zh ? 'Top3 引用率' : 'Top-3 citation rate', value: top3Rate, suffix: '%' },
            { label: zh ? '内容资产（已发布/总数）' : 'Published / total', value: null, text: `${publishedCount} / ${totalArticles ?? articles.length}` },
            { label: zh ? '网站访问（近 30 天）' : 'Site views (30d)', value: pv },
          ].map((tile) => (
            <div key={tile.label} className="bg-slate-900/80 p-4 rounded-2xl border border-slate-800">
              <div className="text-[11px] text-slate-400 mb-1.5">{tile.label}</div>
              <div className={`text-2xl font-black tabular-nums ${tile.text ? 'text-white' : tile.value === null ? 'text-slate-500' : 'text-white'}`}>
                {tile.text ?? formatMetric(tile.value, tile.suffix ?? '')}
              </div>
            </div>
          ))}
        </div>

        {!aiVisibilityConfigured && (
          <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl p-3">
            <AlertTriangle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-xs text-slate-200">
                {zh
                  ? 'AI 可见性监测尚未配置，所以「AI 提及率」和「Top3 引用率」暂时没有数据。配置采集来源后，这里会显示品牌在生成式引擎里的真实表现。'
                  : 'AI visibility monitoring is not configured, so mention and citation rates have no data yet.'}
              </div>
              <button
                type="button"
                onClick={() => onNavigate('ai-models')}
                className="mt-1.5 text-xs font-semibold text-slate-100 underline hover:no-underline"
              >
                {zh ? '去配置采集来源 →' : 'Configure sources →'}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ② 待处理事项 */}
      <section className="space-y-3">
        <h2 className="text-sm font-bold text-white">{zh ? '待处理事项' : 'To do'}</h2>
        {pendingItems.length === 0 ? (
          <div className="flex items-center gap-2.5 bg-slate-900/80 border border-slate-800 rounded-2xl p-4">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="text-xs text-slate-300">{zh ? '没有待处理事项。' : 'Nothing pending.'}</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {pendingItems.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onNavigate(item.tab)}
                className="text-left bg-slate-900/80 hover:bg-slate-800/90 border border-slate-800 hover:border-slate-700 rounded-2xl p-4 transition group"
              >
                <div className="text-2xl font-black tabular-nums text-amber-300">{item.count}</div>
                <div className="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
                  {item.label}
                  <ArrowUpRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition" />
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ③ 最近变化 */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-slate-900/80 p-5 rounded-2xl border border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <FileText className="w-4 h-4 text-slate-400" />
              {zh ? '最近内容' : 'Recent content'}
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('articles')}
              className="text-xs text-indigo-300 hover:text-indigo-200 flex items-center gap-1"
            >
              {zh ? '查看全部' : 'View all'}
              <ArrowUpRight className="w-3 h-3" />
            </button>
          </div>

          {recentArticles.length === 0 ? (
            <div className="text-xs text-slate-500 py-6 text-center">{zh ? '暂无数据' : 'No data'}</div>
          ) : (
            <div className="space-y-1.5">
              {recentArticles.map((art) => (
                <button
                  key={art.id}
                  type="button"
                  onClick={() => onSelectArticle(art)}
                  className="w-full text-left flex items-center justify-between gap-3 px-2.5 py-2 rounded-lg hover:bg-slate-800/70 transition"
                >
                  <span className="text-xs text-slate-200 truncate">{art.title}</span>
                  <span className="shrink-0 flex items-center gap-2">
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        art.status === 'published'
                          ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/50'
                          : 'bg-amber-950/60 text-amber-300 border border-amber-800/50'
                      }`}
                    >
                      {art.status === 'published' ? (zh ? '已发布' : 'Published') : zh ? '待审核' : 'In review'}
                    </span>
                    <span className="text-[10px] text-slate-500 tabular-nums flex items-center gap-1">
                      <Eye className="w-3 h-3" />
                      {art.views ?? 0}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="bg-slate-900/80 p-5 rounded-2xl border border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Activity className="w-4 h-4 text-slate-400" />
              {zh ? '生成任务' : 'Generation tasks'}
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('tasks')}
              className="text-xs text-indigo-300 hover:text-indigo-200 flex items-center gap-1"
            >
              {zh ? '管理' : 'Manage'}
              <ArrowUpRight className="w-3 h-3" />
            </button>
          </div>

          {activeTasks.length === 0 ? (
            <div className="text-xs text-slate-500 py-6 text-center">{zh ? '暂无数据' : 'No data'}</div>
          ) : (
            <div className="space-y-2">
              {activeTasks.map((task) => (
                <div key={task.id} className="flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-300 truncate">{task.name}</span>
                  <span
                    className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${
                      task.status === 'paused'
                        ? 'bg-amber-950/60 text-amber-300 border border-amber-800/50'
                        : 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/50'
                    }`}
                  >
                    {task.status === 'paused' ? (zh ? '已暂停' : 'Paused') : zh ? '运行中' : 'Running'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
