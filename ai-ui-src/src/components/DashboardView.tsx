import React from 'react';
import {
  FileText,
  Workflow,
  Database,
  Radio,
  BarChart3,
  Sparkles,
  ArrowUpRight,
  Clock,
  Eye,
  CheckCircle2,
  TrendingUp,
  Activity,
} from 'lucide-react';
import { ApiRecord } from '../api/geoflowClient';
import { Article, Task } from '../types';
import { OnboardingGuideCard } from './OnboardingGuideCard';

/**
 * 按点号路径从后端投影里取值（`kpis.articles`、`traffic.kpis.ai_bot_pv`）。
 *
 * 这个助手存在的理由：概览大盘的 KPI 曾经**按顶层键**去读 `/analytics/overview`，
 * 而那些键（`total_articles` / `active_ai_models` …）根本不在这个载荷里（它的顶层是
 * `kpis` / `task_health` / `ai_health` / `traffic` …），于是六个格子**全是「—」**，
 * 看起来像「新后台没有这些数据」。按真实路径取值，缺什么就明确显示「—」。
 */
const readPath = (source: ApiRecord | null | undefined, path: string): unknown => {
  let cursor: unknown = source;
  for (const key of path.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as ApiRecord)[key];
  }
  return cursor;
};

interface DashboardViewProps {
  stats: any;
  articles: Article[];
  tasks: Task[];
  onNavigate: (tab: string) => void;
  onSelectArticle: (article: Article) => void;
  onOpenGlossary?: () => void;
  onOpenDevHandoff?: () => void;
  lang: 'zh' | 'en';
  /** In API mode, only values supplied by 桐灼GEO are shown; no demo formulas. */
  apiMode?: boolean;
  /**
   * `GET analytics/overview` 的真实投影。
   *
   * 之前这个页面的数字只来自 `stats`，而分析服务已经把「文章/发布/浏览/队列/素材」
   * 这一整套算好了放在 `/analytics/overview` 里——数据在，只是没接进来。**不再另算一套**。
   *
   * ⚠️ 2026-09-12 修正：这项「接入」当时**接错了**——六格 KPI 按顶层键
   * （`total_articles` / `active_ai_models` …）去读，而载荷的顶层是
   * `kpis` / `task_health` / `ai_health` / `traffic`，于是六格**全是「—」**，实测确认。
   * 现改为按 `readPath()` 走真实路径；`kpis.*` 是**时间窗内**的数（载荷来自 `preset=30d`），
   * 与下方卡片组的全量计数口径不同，所以 KPI 条上明确标了「近 30 天」。
   */
  analyticsOverview?: ApiRecord | null;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  stats,
  articles,
  tasks,
  onNavigate,
  onSelectArticle,
  onOpenGlossary,
  onOpenDevHandoff,
  lang,
  apiMode = false,
  analyticsOverview,
}) => {
  const publishedCount = stats?.published_articles ?? articles.filter(a => a.status === 'published').length;
  const reviewCount = stats?.pending_review ?? articles.filter(a => a.status === 'review').length;
  const totalTasks = stats?.total_tasks ?? tasks.length;
  const totalArticles = apiMode ? (stats?.total_articles ?? articles.length) : articles.length;
  const totalViews = stats?.total_views ?? articles.reduce((sum, a) => sum + (a.views || 0), 0);
  // AI 爬虫取数：真实来源是 `/analytics/overview` 的 `traffic.kpis.ai_bot_pv`
  // （由 `AnalyticsLogQueryService` 按 `TrafficClassifier::AI_BOT` 从 `view_logs` 统计）。
  // 以前这里读 `stats.ai_crawlers`——**那个键 API 模式下没人写**，于是恒显示「—」，
  // 还配一句「采集接口尚未接入」，把已有的能力说成没有。演示模式才允许按浏览量估算。
  const aiCrawlers = apiMode
    ? readPath(analyticsOverview, 'traffic.kpis.ai_bot_pv')
    : Math.round(totalViews * 0.18);

  const demoJourney = [
    {
      step: '01',
      title: lang === 'zh' ? '准备真实知识资产' : 'Prepare Knowledge Assets',
      desc: lang === 'zh' ? '上传产品白皮书、竞品矩阵与技术文档，生成结构化切片' : 'Upload whitepapers, specs & structured chunks',
      tab: 'knowledge',
      tag: lang === 'zh' ? '语料入库' : 'RAG Assets',
      color: 'emerald',
    },
    {
      step: '02',
      title: lang === 'zh' ? '编排自动化任务' : 'Configure Pipeline Task',
      desc: lang === 'zh' ? '配置关键词、目标分类、提示词模板及生成频次' : 'Set keywords, prompts, schedule & batch rules',
      tab: 'tasks',
      tag: lang === 'zh' ? '流水线' : 'Pipeline',
      color: 'blue',
    },
    {
      step: '03',
      title: lang === 'zh' ? '质量核验与终审' : 'Review & Publish',
      desc: lang === 'zh' ? '人工校验事实准确性，检查 Schema 与 Markdown 规范' : 'Verify factual grounding, schema & markdown',
      tab: 'articles',
      tag: lang === 'zh' ? '防幻觉' : 'Zero Hallucination',
      color: 'amber',
    },
    {
      step: '04',
      title: lang === 'zh' ? '多端渠道分发' : 'Multi-Site Distribution',
      desc: lang === 'zh' ? '通过 桐灼GEO Agent 或 WordPress 渠道一键推送到远端' : 'Push to TongzhuoGEO Agent or WordPress blogs',
      tab: 'distribution',
      tag: lang === 'zh' ? '全网分发' : 'Multi-Site',
      color: 'purple',
    },
    {
      step: '05',
      title: lang === 'zh' ? '观测 AI 爬虫画像' : 'Observe AI Crawlers',
      desc: lang === 'zh' ? '持续监控 GPTBot、ClaudeBot、Bytespider 抓取与引用' : 'Track GPTBot, ClaudeBot & search bot citations',
      tab: 'analytics',
      tag: lang === 'zh' ? 'GEO 收益' : 'GEO Impact',
      color: 'rose',
    },
  ];

  return (
    <div className="space-y-6">
      {analyticsOverview && (
        <div>
          <div className="mb-2 text-[11px] text-slate-500">
            {lang === 'zh'
              ? '近 30 天（后端投影；服务端算不出来的一律显示「—」，不拿 0 冒充）'
              : 'Last 30 days (backend projection; anything the server cannot compute shows “—” rather than 0)'}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {[
              { path: 'kpis.articles', zh: '文章数', en: 'Articles' },
              { path: 'kpis.published', zh: '已发布', en: 'Published' },
              { path: 'kpis.total_views', zh: '浏览', en: 'Views' },
              { path: 'task_health.active_tasks', zh: '启用任务', en: 'Active tasks' },
              // `ai_health.active_models` 是**模型行列表**（还被 limit(5) 截断），不是计数；
              // 真正的计数是这两个相加。直接读列表会得到 NaN。
              { path: 'ai_health.chat_models', plus: 'ai_health.embedding_models', zh: '可用模型', en: 'Active models' },
              { path: 'traffic.kpis.ai_bot_pv', zh: 'AI 爬虫 PV', en: 'AI bot PV' },
            ].map((tile) => {
              const raw = readPath(analyticsOverview, tile.path);
              const extra = tile.plus ? readPath(analyticsOverview, tile.plus) : 0;
              // 只认有限数值：拿到列表、字符串或 undefined 时显示「—」，绝不把 NaN 漏到界面上。
              const total = Number.isFinite(Number(raw)) && Number.isFinite(Number(extra))
                ? Number(raw) + Number(extra)
                : null;
              return (
                <div key={tile.path} className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                  <div className="text-[10px] text-slate-500">{lang === 'zh' ? tile.zh : tile.en}</div>
                  {/* 服务端算不出来的值就是 null——显示「—」而不是 0。 */}
                  <div className={`mt-1 text-xl font-black tabular-nums ${total === null ? 'text-slate-600' : 'text-white'}`}>
                    {total === null ? '—' : total.toLocaleString()}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Top Banner / Hero Intro */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 p-6 rounded-2xl border border-slate-800 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-red-600/10 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20"></div>
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-2 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-500/10 text-red-400 border border-red-500/20">
              <Sparkles className="w-3.5 h-3.5" />
              <span>{lang === 'zh' ? '面向 GEO 场景的内容工程基础设施' : 'Generative Engine Optimization Infrastructure'}</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-white">
              {lang === 'zh' ? '把可信业务资料，沉淀为可被 AI 引用的内容资产' : 'Turn Trusted Knowledge into AI-Citable Content Assets'}
            </h1>
            <p className="text-sm text-slate-300 leading-relaxed">
              {lang === 'zh'
                ? '桐灼GEO 整合知识库 RAG、标题关键词库、AI 智能生成、人工审核道闸、全网多端分发与 AI 爬虫日志分析，助您抢占大语言模型推荐信任入口。'
                : 'TongzhuoGEO unifies Knowledge RAG, content task automation, quality gating, multi-channel distribution, and AI crawler telemetry to establish brand authority in LLM search.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2.5 shrink-0">
            {apiMode ? (
              <>
                <button
                  onClick={() => onNavigate('knowledge')}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20 transition"
                >
                  <Database className="w-4 h-4" />
                  <span>{lang === 'zh' ? '管理知识库' : 'Manage Knowledge'}</span>
                </button>
                <button
                  onClick={() => onNavigate('articles')}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
                >
                  <FileText className="w-4 h-4 text-blue-400" />
                  <span>{lang === 'zh' ? '审核文章' : 'Review Articles'}</span>
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => onNavigate('seo_dashboard')}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/20 transition"
                >
                  <Activity className="w-4 h-4" />
                  <span>{lang === 'zh' ? 'SEO 综合决策大盘' : 'SEO Dashboard'}</span>
                </button>
                <button
                  onClick={() => onNavigate('generator')}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
                >
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  <span>{lang === 'zh' ? 'AI 创作工坊' : 'AI Studio'}</span>
                </button>
                <button
                  onClick={() => onNavigate('preview')}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
                >
                  <Eye className="w-4 h-4 text-rose-400" />
                  <span>{lang === 'zh' ? '浏览前台演示' : 'Preview Live Site'}</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Beginner Fast-Track Onboarding & Visual Impact Showcase */}
      {!apiMode && (
        <OnboardingGuideCard
          onNavigate={onNavigate}
          onOpenGlossary={onOpenGlossary || (() => {})}
          onOpenDevHandoff={onOpenDevHandoff || (() => {})}
          lang={lang}
        />
      )}

      {apiMode && (
        <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 px-4 py-3 text-xs leading-relaxed text-blue-200">
          {lang === 'zh'
            ? '当前为 桐灼GEO API 模式：本页数字全部来自后端真实数据，服务端取不到的一律显示「—」而不是 0。更细的生成、分发与爬虫分析在左侧对应页签里。'
            : '桐灼GEO API mode: every number here comes from real backend data, and anything unavailable shows “—” rather than 0. Detailed generation, distribution and crawler analytics live in their own tabs.'}
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
        <div className="bg-slate-800/60 p-4 rounded-xl border border-slate-700/80">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
            <span>{lang === 'zh' ? '文章总量' : 'Total Articles'}</span>
            <FileText className="w-3.5 h-3.5 text-blue-400" />
          </div>
          <div className="text-2xl font-black text-white">{totalArticles}</div>
          <div className="text-[11px] text-emerald-400 flex items-center gap-0.5 mt-1">
            <CheckCircle2 className="w-3 h-3" />
            <span>{publishedCount} {lang === 'zh' ? '篇已上线' : 'Published'}</span>
          </div>
        </div>

        <div className="bg-slate-800/60 p-4 rounded-xl border border-slate-700/80">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
            <span>{lang === 'zh' ? '待核验草稿' : 'In Review'}</span>
            <Clock className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div className="text-2xl font-black text-white">{reviewCount}</div>
          <div className="text-[11px] text-amber-400 mt-1">
            {lang === 'zh' ? '防幻觉人工道闸' : 'Review Gate'}
          </div>
        </div>

        <div className="bg-slate-800/60 p-4 rounded-xl border border-slate-700/80">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
            <span>{lang === 'zh' ? '自动化任务' : 'Pipelines'}</span>
            <Workflow className="w-3.5 h-3.5 text-indigo-400" />
          </div>
          <div className="text-2xl font-black text-white">{totalTasks}</div>
          <div className="text-[11px] text-slate-400 mt-1">
            {tasks.filter(t => t.status === 'running').length} {lang === 'zh' ? '个常驻活跃' : 'Active'}
          </div>
        </div>

        <div className="bg-slate-800/60 p-4 rounded-xl border border-slate-700/80">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
            <span>{lang === 'zh' ? '知识库切片' : 'RAG Chunks'}</span>
            <Database className="w-3.5 h-3.5 text-emerald-400" />
          </div>
          <div className="text-2xl font-black text-white">
            {apiMode && (stats?.knowledge_chunks === undefined || stats?.knowledge_chunks === null)
              ? '—'
              : (stats?.knowledge_chunks ?? 0)}
          </div>
          <div className="text-[11px] text-emerald-400 mt-1">
            {apiMode
              ? (lang === 'zh' ? '向量同步状态由后端提供' : 'Embedding state is owned by the backend')
              : `100% ${lang === 'zh' ? '向量就绪' : 'Embedded'}`}
          </div>
        </div>

        <div className="bg-slate-800/60 p-4 rounded-xl border border-slate-700/80">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
            <span>{lang === 'zh' ? '分发渠道' : 'Channels'}</span>
            <Radio className="w-3.5 h-3.5 text-purple-400" />
          </div>
          <div className="text-2xl font-black text-white">
            {apiMode && (stats?.distribution_channels === undefined || stats?.distribution_channels === null)
              ? '—'
              : (stats?.distribution_channels ?? 0)}
          </div>
          <div className="text-[11px] text-purple-400 mt-1">
            {apiMode
              ? (lang === 'zh' ? '渠道列表与状态来自真实后端' : 'Channel list and status come from the backend')
              : 'GEO Agent + WP'}
          </div>
        </div>

        <div className="bg-slate-800/60 p-4 rounded-xl border border-slate-700/80">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
            <span>{lang === 'zh' ? 'AI 爬虫抓取' : 'AI Bot Hits'}</span>
            <BarChart3 className="w-3.5 h-3.5 text-rose-400" />
          </div>
          <div className="text-2xl font-black text-white">
            {aiCrawlers === undefined || aiCrawlers === null ? '—' : Number(aiCrawlers).toLocaleString()}
          </div>
          <div className="text-[11px] text-rose-400 flex items-center gap-0.5 mt-1">
            <TrendingUp className="w-3 h-3" />
            <span>{apiMode
              ? (lang === 'zh' ? '近 30 天，来自真实访问日志' : 'Last 30 days, from real view logs')
              : 'GPT & Claude'}</span>
          </div>
        </div>
      </div>

      {/* 5-Step Demo Journey */}
      {!apiMode && <div className="bg-slate-900/80 p-5 rounded-2xl border border-slate-800 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <span className="w-2 h-4 rounded bg-red-500 inline-block"></span>
              {lang === 'zh' ? '桐灼GEO 完整业务落地链路' : 'TongzhuoGEO End-to-End Workflow'}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {lang === 'zh'
                ? '按照标准闭环快速体验：知识语料沉淀 → 任务流水线生成 → 人工核验 → 多站点分发 → 爬虫观测'
                : 'Follow the core loop: Knowledge Grounding → Task Pipeline → Quality Review → Distribution → Telemetry'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {demoJourney.map((item) => (
            <div
              key={item.step}
              onClick={() => onNavigate(item.tab)}
              className="bg-slate-800/40 hover:bg-slate-800/90 border border-slate-700/60 hover:border-slate-600 rounded-xl p-4 transition cursor-pointer flex flex-col justify-between group"
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-mono font-black text-red-400">{item.step}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                    {item.tag}
                  </span>
                </div>
                <h3 className="text-sm font-bold text-slate-100 group-hover:text-red-400 transition mb-1">
                  {item.title}
                </h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  {item.desc}
                </p>
              </div>
              <div className="mt-3 pt-2 border-t border-slate-800/80 flex items-center text-xs font-semibold text-slate-400 group-hover:text-white transition">
                <span>{lang === 'zh' ? '立即前往' : 'Go to step'}</span>
                <ArrowUpRight className="w-3.5 h-3.5 ml-1 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition" />
              </div>
            </div>
          ))}
        </div>
      </div>}

      {/* Two Columns: Recent Articles & Tasks */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Recent Articles */}
        <div className="lg:col-span-2 bg-slate-900/80 p-5 rounded-2xl border border-slate-800 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <span className="w-2 h-4 rounded bg-red-500 inline-block"></span>
              {lang === 'zh' ? '最新生产文章' : 'Recent Articles'}
            </h2>
            <button
              onClick={() => onNavigate('articles')}
              className="text-xs text-red-400 hover:text-red-300 font-semibold flex items-center gap-1"
            >
              {lang === 'zh' ? '查看全部' : 'View All'} ({articles.length}) →
            </button>
          </div>

          <div className="divide-y divide-slate-800/80">
            {articles.slice(0, 4).map((art) => (
              <div
                key={art.id}
                onClick={() => onSelectArticle(art)}
                className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-800/30 px-2 rounded-lg transition cursor-pointer"
              >
                <div className="space-y-1 max-w-xl">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                      {art.category}
                    </span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                        art.status === 'published'
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                          : art.status === 'review'
                          ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                          : 'bg-slate-700 text-slate-300'
                      }`}
                    >
                      {art.status === 'published' ? (lang === 'zh' ? '已发布' : 'Published') : art.status === 'review' ? (lang === 'zh' ? '待审核' : 'Review') : (lang === 'zh' ? '草稿' : 'Draft')}
                    </span>
                    <span className="text-xs text-slate-400">{art.createdAt}</span>
                  </div>
                  <h3 className="text-sm font-bold text-slate-100 hover:text-red-400 transition line-clamp-1">
                    {art.title}
                  </h3>
                  <p className="text-xs text-slate-400 line-clamp-1">
                    {art.summary}
                  </p>
                </div>
                <div className="flex items-center gap-3 self-end sm:self-center shrink-0">
                  <span className="text-xs text-slate-400 flex items-center gap-1">
                    <Eye className="w-3.5 h-3.5 text-slate-400" />
                    {art.views || 0}
                  </span>
                  <button className="text-xs font-semibold text-red-400 hover:underline">
                    {lang === 'zh' ? '阅读' : 'Read'} →
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right Col: Active Automation Pipelines */}
        <div className="bg-slate-900/80 p-5 rounded-2xl border border-slate-800 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <span className="w-2 h-4 rounded bg-red-500 inline-block"></span>
              {lang === 'zh' ? '活跃生成任务' : 'Automation Tasks'}
            </h2>
            <button
              onClick={() => onNavigate('tasks')}
              className="text-xs text-red-400 hover:text-red-300 font-semibold"
            >
              {lang === 'zh' ? '管理' : 'Manage'} →
            </button>
          </div>

          <div className="space-y-3">
            {tasks.map((task) => (
              <div key={task.id} className="p-3.5 rounded-xl bg-slate-800/50 border border-slate-700/60 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-200 line-clamp-1">{task.name}</span>
                  <span
                    className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      task.status === 'running'
                        ? 'bg-blue-500/20 text-blue-400 animate-pulse'
                        : 'bg-slate-700 text-slate-300'
                    }`}
                  >
                    {task.status}
                  </span>
                </div>
                <div className="text-xs text-slate-400 flex items-center justify-between">
                  <span>{task.aiModel}</span>
                  <span>{task.schedule}</span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1 border-t border-slate-700/40">
                  <span>{lang === 'zh' ? '已产出' : 'Generated'}: <strong className="text-slate-200">{task.generatedCount}</strong></span>
                  <span>{lang === 'zh' ? '最后运行' : 'Last'}: {task.lastRunAt.split(' ')[0]}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="pt-2">
            <button
              onClick={() => onNavigate('tasks')}
              className="w-full py-2.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition text-center"
            >
              + {lang === 'zh' ? '新建自动化任务' : 'Create Pipeline Task'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
