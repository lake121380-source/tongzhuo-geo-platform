import React, { useState, useMemo } from 'react';
import {
  TrendingUp,
  Search,
  Eye,
  Globe,
  Sparkles,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Filter,
  RefreshCw,
  Zap,
  Target,
  BarChart2,
  CheckCircle2,
  HelpCircle,
  ExternalLink,
  Layers,
  Award,
  SlidersHorizontal,
} from 'lucide-react';
import { GeoPerformanceMetrics, GeoKeywordRanking, GeoEngineVisibility } from '../types';

interface GeoPerformanceDashboardProps {
  initialMetrics?: GeoPerformanceMetrics;
  lang: 'zh' | 'en';
  onNavigateToArticle?: (slugOrTitle: string) => void;
}

export const GeoPerformanceDashboard: React.FC<GeoPerformanceDashboardProps> = ({
  initialMetrics,
  lang,
  onNavigateToArticle,
}) => {
  const [metrics, setMetrics] = useState<GeoPerformanceMetrics | null>(initialMetrics || null);
  const [loading, setLoading] = useState(false);
  const [selectedTimeframe, setSelectedTimeframe] = useState<'7d' | '14d' | '30d'>('14d');
  const [selectedEngine, setSelectedEngine] = useState<string>('all');
  const [keywordSearch, setKeywordSearch] = useState('');
  const [selectedIntent, setSelectedIntent] = useState<string>('all');
  const [hoveredDataPoint, setHoveredDataPoint] = useState<number | null>(null);

  // Fetch metrics if not provided or on refresh
  const fetchMetrics = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/analytics/geo-performance');
      if (res.ok) {
        const data = await res.json();
        setMetrics(data);
      }
    } catch (e) {
      console.error('Failed to load GEO metrics:', e);
    } finally {
      setTimeout(() => setLoading(false), 400);
    }
  };

  React.useEffect(() => {
    if (!metrics) {
      fetchMetrics();
    }
  }, []);

  const data = metrics || {
    visibilityScore: 86.4,
    visibilityChange: 7.8,
    estimatedMonthlyTraffic: 52400,
    trafficGrowthRate: 24.6,
    averageCitationCtr: 8.2,
    estimatedOrganicValue: 22400,
    rankingDistribution: { top3Count: 19, top10Count: 34, beyond10Count: 11 },
    engineVisibility: [],
    keywordRankings: [],
    trafficTimeline: [],
    topicDistribution: [],
  };

  // Filtered keywords
  const filteredKeywords = useMemo(() => {
    return (data.keywordRankings || []).filter((kw) => {
      const matchesSearch =
        kw.keyword.toLowerCase().includes(keywordSearch.toLowerCase()) ||
        kw.targetArticleTitle.toLowerCase().includes(keywordSearch.toLowerCase());
      const matchesIntent = selectedIntent === 'all' || kw.intent === selectedIntent;
      const matchesEngine =
        selectedEngine === 'all' ||
        kw.engine.toLowerCase().includes(selectedEngine.toLowerCase()) ||
        kw.engine.includes('All');
      return matchesSearch && matchesIntent && matchesEngine;
    });
  }, [data.keywordRankings, keywordSearch, selectedIntent, selectedEngine]);

  // Timeline points according to timeframe
  const timelinePoints = useMemo(() => {
    const list = data.trafficTimeline || [];
    if (selectedTimeframe === '7d') return list.slice(-7);
    if (selectedTimeframe === '14d') return list.slice(-14);
    return list;
  }, [data.trafficTimeline, selectedTimeframe]);

  // Max values for SVG chart scaling
  const maxImpressions = useMemo(() => {
    if (!timelinePoints.length) return 30000;
    return Math.max(...timelinePoints.map((p) => p.impressions)) * 1.15;
  }, [timelinePoints]);

  const maxClicks = useMemo(() => {
    if (!timelinePoints.length) return 3000;
    return Math.max(...timelinePoints.map((p) => p.referralClicks)) * 1.15;
  }, [timelinePoints]);

  // Intent label mapping
  const getIntentBadge = (intent: GeoKeywordRanking['intent']) => {
    switch (intent) {
      case 'commercial':
        return {
          label: lang === 'zh' ? '商业决策' : 'Commercial',
          bg: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
        };
      case 'technical':
        return {
          label: lang === 'zh' ? '技术架构' : 'Technical',
          bg: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30',
        };
      case 'brand':
        return {
          label: lang === 'zh' ? '品牌信源' : 'Brand',
          bg: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
        };
      case 'informational':
      default:
        return {
          label: lang === 'zh' ? '信息认知' : 'Info',
          bg: 'bg-blue-500/10 text-blue-300 border-blue-500/30',
        };
    }
  };

  return (
    <div className="space-y-6" id="geo-performance-dashboard">
      {/* Top Header & Overview Title */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl sm:text-2xl font-black text-white flex items-center gap-2">
                <span>{lang === 'zh' ? 'GEO 引擎表现大盘' : 'GEO Performance Dashboard'}</span>
                <span className="text-[11px] px-2 py-0.5 rounded-full font-mono font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40">
                  {lang === 'zh' ? '大模型搜索优化' : 'Generative Engine'}
                </span>
              </h1>
              <p className="text-xs text-slate-400 mt-1">
                {lang === 'zh'
                  ? '全面追踪网站内容在 Perplexity、ChatGPT Search、Google AI Overviews 等大模型中的可见度、关键词排名及自然引用流量。'
                  : 'Monitor search visibility, generative keyword rankings, and organic referral traffic across AI search engines.'}
              </p>
            </div>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2.5 self-start md:self-auto">
          {/* Timeframe Selector */}
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-xl p-1">
            {(['7d', '14d', '30d'] as const).map((tf) => (
              <button
                key={tf}
                type="button"
                onClick={() => setSelectedTimeframe(tf)}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition ${
                  selectedTimeframe === tf
                    ? 'bg-red-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                {tf.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Refresh Button */}
          <button
            type="button"
            onClick={fetchMetrics}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-slate-200 border border-slate-800 transition disabled:opacity-50 cursor-pointer"
            title={lang === 'zh' ? '重新拉取实时 GEO 指标数据' : 'Refresh live GEO telemetry'}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-rose-400' : ''}`} />
            <span>{lang === 'zh' ? '刷新大盘' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* Primary KPI Metrics Cards (4 Columns) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Metric 1: GEO Search Visibility Index */}
        <div className="bg-slate-900/80 p-5 rounded-2xl border border-slate-800 relative overflow-hidden group hover:border-slate-700/80 transition">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
            <span className="font-semibold flex items-center gap-1.5">
              <Eye className="w-4 h-4 text-rose-400" />
              <span>{lang === 'zh' ? 'GEO 搜索可见度指数' : 'GEO Search Visibility'}</span>
            </span>
            <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
              Score / 100
            </span>
          </div>
          <div className="flex items-baseline gap-2.5">
            <span className="text-3xl font-black text-white font-mono">{data.visibilityScore}</span>
            <span className="text-xs font-bold text-emerald-400 flex items-center">
              <ArrowUpRight className="w-3.5 h-3.5" />
              +{data.visibilityChange}%
            </span>
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400 border-t border-slate-800/80 pt-2.5">
            <span>{lang === 'zh' ? '大模型综合采纳率' : 'Citation Authority'}</span>
            <span className="text-emerald-400 font-bold">{lang === 'zh' ? '卓越 (Tier 1)' : 'Excellent'}</span>
          </div>
        </div>

        {/* Metric 2: Estimated Monthly AI Traffic */}
        <div className="bg-slate-900/80 p-5 rounded-2xl border border-slate-800 relative overflow-hidden group hover:border-slate-700/80 transition">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
            <span className="font-semibold flex items-center gap-1.5">
              <Globe className="w-4 h-4 text-emerald-400" />
              <span>{lang === 'zh' ? '月度预估自然流量' : 'Est. Monthly Traffic'}</span>
            </span>
            <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
              Visits
            </span>
          </div>
          <div className="flex items-baseline gap-2.5">
            <span className="text-3xl font-black text-white font-mono">
              {data.estimatedMonthlyTraffic.toLocaleString()}
            </span>
            <span className="text-xs font-bold text-emerald-400 flex items-center">
              <ArrowUpRight className="w-3.5 h-3.5" />
              +{data.trafficGrowthRate}%
            </span>
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400 border-t border-slate-800/80 pt-2.5">
            <span>{lang === 'zh' ? '对应等效广告价值' : 'Est. Organic Value'}</span>
            <span className="text-amber-300 font-mono font-bold">${data.estimatedOrganicValue.toLocaleString()}</span>
          </div>
        </div>

        {/* Metric 3: Top 3 & Top 10 Keywords */}
        <div className="bg-slate-900/80 p-5 rounded-2xl border border-slate-800 relative overflow-hidden group hover:border-slate-700/80 transition">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
            <span className="font-semibold flex items-center gap-1.5">
              <Award className="w-4 h-4 text-amber-400" />
              <span>{lang === 'zh' ? '核心关键词排名分布' : 'Keyword Rankings'}</span>
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
              Top Tier
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-black text-white font-mono">{data.rankingDistribution.top3Count}</span>
            <span className="text-xs text-slate-400">{lang === 'zh' ? '个词位居前三' : 'in Top 3'}</span>
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400 border-t border-slate-800/80 pt-2.5">
            <span>{lang === 'zh' ? '前 10 名核心收录' : 'Top 10 Rankings'}</span>
            <span className="text-slate-200 font-mono font-bold">
              {data.rankingDistribution.top10Count}{' '}
              <span className="text-[10px] text-slate-400 font-normal">
                ({lang === 'zh' ? '总计 64 个监控词' : 'of 64 terms'})
              </span>
            </span>
          </div>
        </div>

        {/* Metric 4: AI Citation CTR */}
        <div className="bg-slate-900/80 p-5 rounded-2xl border border-slate-800 relative overflow-hidden group hover:border-slate-700/80 transition">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
            <span className="font-semibold flex items-center gap-1.5">
              <Target className="w-4 h-4 text-indigo-400" />
              <span>{lang === 'zh' ? 'AI 答案引用点击率 (CTR)' : 'AI Citation CTR'}</span>
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
              GEO vs SEO
            </span>
          </div>
          <div className="flex items-baseline gap-2.5">
            <span className="text-3xl font-black text-white font-mono">{data.averageCitationCtr}%</span>
            <span className="text-xs font-bold text-emerald-400 flex items-center">
              <ArrowUpRight className="w-3.5 h-3.5" />
              3.1x
            </span>
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400 border-t border-slate-800/80 pt-2.5">
            <span>{lang === 'zh' ? '行业传统搜索基准' : 'Industry Baseline'}</span>
            <span className="text-slate-400 font-mono">~2.6% CTR</span>
          </div>
        </div>
      </div>

      {/* Section: Organic Traffic Estimation Timeline & Engine Visibility (2-Column Grid) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Organic Traffic Estimation Timeline Chart (7 Cols) */}
        <div className="lg:col-span-7 bg-slate-900/80 p-5 rounded-2xl border border-slate-800 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-rose-500" />
                <span>{lang === 'zh' ? '自然流量与 AI 引用转化预估趋势' : 'Organic Traffic & Impression Estimation'}</span>
              </h2>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {lang === 'zh'
                  ? '对比各大模型生成的回答曝光量（Impressions）与最终点击跳转量（Referral Clicks）'
                  : 'Estimated generative answer impressions vs actual referral clicks.'}
              </p>
            </div>

            {/* Legend */}
            <div className="flex items-center gap-3 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-rose-500"></span>
                <span className="text-slate-300">{lang === 'zh' ? 'AI 答案曝光 (PV)' : 'Impressions'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
                <span className="text-slate-300">{lang === 'zh' ? '引用点击 (Clicks)' : 'Clicks'}</span>
              </div>
            </div>
          </div>

          {/* Interactive SVG Timeline Graph */}
          <div className="h-56 w-full pt-3 relative flex flex-col justify-end">
            <svg
              className="w-full h-44 overflow-visible"
              viewBox={`0 0 ${timelinePoints.length * 50} 150`}
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="impressionGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f43f5e" stopOpacity="0.3" />
                  <stop offset="100%" stopColor="#f43f5e" stopOpacity="0.0" />
                </linearGradient>
                <linearGradient id="clicksGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#34d399" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#34d399" stopOpacity="0.0" />
                </linearGradient>
              </defs>

              {/* Horizontal Gridlines */}
              {[30, 75, 120].map((y) => (
                <line
                  key={y}
                  x1="0"
                  y1={y}
                  x2={timelinePoints.length * 50}
                  y2={y}
                  stroke="#1e293b"
                  strokeDasharray="4 4"
                  strokeWidth="1"
                />
              ))}

              {/* Impressions Area & Line */}
              {timelinePoints.length > 1 && (
                <>
                  <path
                    d={`M 0 150 ${timelinePoints
                      .map((p, i) => `L ${i * 50 + 25} ${140 - (p.impressions / maxImpressions) * 125}`)
                      .join(' ')} L ${(timelinePoints.length - 1) * 50 + 25} 150 Z`}
                    fill="url(#impressionGradient)"
                  />
                  <path
                    d={`M 25 ${140 - (timelinePoints[0].impressions / maxImpressions) * 125} ${timelinePoints
                      .slice(1)
                      .map((p, i) => `L ${(i + 1) * 50 + 25} ${140 - (p.impressions / maxImpressions) * 125}`)
                      .join(' ')}`}
                    fill="none"
                    stroke="#f43f5e"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </>
              )}

              {/* Clicks Area & Line */}
              {timelinePoints.length > 1 && (
                <>
                  <path
                    d={`M 0 150 ${timelinePoints
                      .map((p, i) => `L ${i * 50 + 25} ${140 - (p.referralClicks / maxClicks) * 125}`)
                      .join(' ')} L ${(timelinePoints.length - 1) * 50 + 25} 150 Z`}
                    fill="url(#clicksGradient)"
                  />
                  <path
                    d={`M 25 ${140 - (timelinePoints[0].referralClicks / maxClicks) * 125} ${timelinePoints
                      .slice(1)
                      .map((p, i) => `L ${(i + 1) * 50 + 25} ${140 - (p.referralClicks / maxClicks) * 125}`)
                      .join(' ')}`}
                    fill="none"
                    stroke="#34d399"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </>
              )}

              {/* Data points (dots) */}
              {timelinePoints.map((p, i) => {
                const cx = i * 50 + 25;
                const cyImp = 140 - (p.impressions / maxImpressions) * 125;
                const cyClk = 140 - (p.referralClicks / maxClicks) * 125;
                const isHovered = hoveredDataPoint === i;

                return (
                  <g key={p.date} onMouseEnter={() => setHoveredDataPoint(i)} onMouseLeave={() => setHoveredDataPoint(null)}>
                    {isHovered && (
                      <line x1={cx} y1="0" x2={cx} y2="150" stroke="#475569" strokeWidth="1" strokeDasharray="2 2" />
                    )}
                    <circle
                      cx={cx}
                      cy={cyImp}
                      r={isHovered ? 5 : 3.5}
                      fill="#f43f5e"
                      stroke="#0f172a"
                      strokeWidth="2"
                      className="cursor-pointer transition-all"
                    />
                    <circle
                      cx={cx}
                      cy={cyClk}
                      r={isHovered ? 5 : 3.5}
                      fill="#34d399"
                      stroke="#0f172a"
                      strokeWidth="2"
                      className="cursor-pointer transition-all"
                    />
                  </g>
                );
              })}
            </svg>

            {/* X-axis labels */}
            <div className="flex justify-between items-center text-[10px] font-mono text-slate-400 pt-2 border-t border-slate-800">
              {timelinePoints.map((p, i) => (
                <span
                  key={p.date}
                  className={`text-center ${hoveredDataPoint === i ? 'text-white font-bold' : ''}`}
                  style={{ width: `${100 / timelinePoints.length}%` }}
                >
                  {p.date}
                </span>
              ))}
            </div>

            {/* Hover Tooltip Popup */}
            {hoveredDataPoint !== null && timelinePoints[hoveredDataPoint] && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-slate-950/95 border border-slate-700 shadow-2xl rounded-xl p-2.5 text-xs z-20 pointer-events-none flex items-center gap-4">
                <div>
                  <div className="text-slate-400 font-mono text-[10px]">{timelinePoints[hoveredDataPoint].date}</div>
                  <div className="font-bold text-white mt-0.5">
                    CTR: <span className="text-emerald-400">{timelinePoints[hoveredDataPoint].ctr}%</span>
                  </div>
                </div>
                <div className="h-6 w-px bg-slate-800"></div>
                <div className="space-y-0.5 font-mono text-[11px]">
                  <div className="text-rose-400 flex items-center gap-1">
                    <span>曝光:</span>
                    <span className="font-bold">{timelinePoints[hoveredDataPoint].impressions.toLocaleString()}</span>
                  </div>
                  <div className="text-emerald-400 flex items-center gap-1">
                    <span>点击:</span>
                    <span className="font-bold">{timelinePoints[hoveredDataPoint].referralClicks.toLocaleString()}</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Topics Traffic Distribution Mini-shelf */}
          <div className="pt-2 border-t border-slate-800/80">
            <div className="text-xs font-bold text-slate-300 mb-2">
              {lang === 'zh' ? '主题域自然流量贡献度' : 'Traffic Contribution by Subject Cluster'}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {data.topicDistribution.map((t) => (
                <div key={t.topic} className="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/80">
                  <div className="text-[11px] font-semibold text-slate-200 truncate">{t.topic}</div>
                  <div className="flex items-baseline justify-between mt-1 text-xs">
                    <span className="text-rose-400 font-bold font-mono">{t.trafficShare}%</span>
                    <span className="text-[10px] text-slate-400">{t.citations} {lang === 'zh' ? '次引用' : 'cites'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Search Engine Visibility Share (5 Cols) */}
        <div className="lg:col-span-5 bg-slate-900/80 p-5 rounded-2xl border border-slate-800 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Layers className="w-4 h-4 text-purple-400" />
              <span>{lang === 'zh' ? '各主流大模型引用与可见度' : 'Engine Citation Share'}</span>
            </h2>
            <span className="text-[10px] text-slate-400 font-mono">SoV (Share of Voice)</span>
          </div>

          <div className="space-y-3 pt-1">
            {data.engineVisibility.map((item) => (
              <div
                key={item.engine}
                onClick={() => setSelectedEngine(selectedEngine === item.engine ? 'all' : item.engine)}
                className={`p-3 rounded-xl border transition cursor-pointer ${
                  selectedEngine === item.engine
                    ? 'bg-slate-800/80 border-rose-500/60 shadow-lg shadow-rose-950/30'
                    : 'bg-slate-950/50 border-slate-800/80 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: item.color }}></span>
                    <span className="font-bold text-slate-200">{item.name}</span>
                  </div>
                  <div className="flex items-center gap-2 font-mono">
                    <span className="text-slate-300 font-bold">{item.citationShare}%</span>
                    <span className="text-[10px] text-emerald-400 font-semibold">+{item.trendChange}%</span>
                  </div>
                </div>

                <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden mb-2">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${item.citationShare}%`, backgroundColor: item.color }}
                  ></div>
                </div>

                <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
                  <span>{item.citationsCount.toLocaleString()} {lang === 'zh' ? '次答案引用' : 'citations'}</span>
                  <span>{lang === 'zh' ? '可见度得分:' : 'Visibility:'} <strong className="text-white">{item.visibilityScore}</strong>/100</span>
                </div>
              </div>
            ))}
          </div>

          {/* GEO Diagnostic Quality Factors */}
          <div className="p-3.5 bg-slate-950/70 rounded-xl border border-slate-800/80 space-y-2">
            <div className="text-xs font-bold text-slate-300 flex items-center justify-between">
              <span>{lang === 'zh' ? 'GEO 权威信源健康诊断' : 'GEO Technical Readiness'}</span>
              <span className="text-[10px] text-emerald-400 font-mono font-bold">94/100 PASS</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400 pt-1">
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>/llms.txt 实时索引规范</span>
              </div>
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>JSON-LD Schema 标记覆盖</span>
              </div>
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>事实数据原子化度量 (&gt;88%)</span>
              </div>
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>更新时效信源广播</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Section: Keyword Ranking Trends (Full-Width Card) */}
      <div className="bg-slate-900/80 p-5 sm:p-6 rounded-2xl border border-slate-800 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Target className="w-5 h-5 text-amber-400" />
              <span>{lang === 'zh' ? '大模型关键词排名走势与收录' : 'Keyword Ranking Trends & Model Positions'}</span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {lang === 'zh'
                ? '追踪高意图搜索词在生成式大模型回答中的排位（第 1 顺位为核心事实源），以及触发引用的概率。'
                : 'Tracks generative prompt rankings and likelihood of citation in primary model outputs.'}
            </p>
          </div>

          {/* Search and Filters */}
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Search Input */}
            <div className="relative min-w-[200px]">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={keywordSearch}
                onChange={(e) => setKeywordSearch(e.target.value)}
                placeholder={lang === 'zh' ? '搜索关键词或目标文章...' : 'Search keyword or target...'}
                className="w-full bg-slate-800/80 border border-slate-700 rounded-xl pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-slate-400 focus:outline-none focus:border-red-500 transition"
              />
            </div>

            {/* Intent Filter */}
            <div className="flex items-center gap-1 bg-slate-800/60 p-1 rounded-xl border border-slate-700/80 text-xs">
              <Filter className="w-3.5 h-3.5 text-slate-400 ml-1.5" />
              {(['all', 'commercial', 'technical', 'brand', 'informational'] as const).map((intentKey) => (
                <button
                  key={intentKey}
                  type="button"
                  onClick={() => setSelectedIntent(intentKey)}
                  className={`px-2 py-1 rounded-lg text-xs transition ${
                    selectedIntent === intentKey
                      ? 'bg-red-600 text-white font-bold shadow-sm'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {intentKey === 'all'
                    ? lang === 'zh'
                      ? '全部'
                      : 'All'
                    : intentKey === 'commercial'
                    ? lang === 'zh'
                      ? '商业'
                      : 'Comm'
                    : intentKey === 'technical'
                    ? lang === 'zh'
                      ? '技术'
                      : 'Tech'
                    : intentKey === 'brand'
                    ? lang === 'zh'
                      ? '品牌'
                      : 'Brand'
                    : lang === 'zh'
                    ? '资讯'
                    : 'Info'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Keyword Table */}
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800 font-semibold">
              <tr>
                <th className="py-3 px-4">{lang === 'zh' ? '关键词 / 实体查询' : 'Keyword / Entity'}</th>
                <th className="py-3 px-3 text-center">{lang === 'zh' ? 'AI 排名' : 'AI Rank'}</th>
                <th className="py-3 px-3">{lang === 'zh' ? '首要引用大模型' : 'Primary Engine'}</th>
                <th className="py-3 px-3">{lang === 'zh' ? '月度提问量' : 'Prompt Vol'}</th>
                <th className="py-3 px-3">{lang === 'zh' ? '引用采纳概率' : 'Citation Probability'}</th>
                <th className="py-3 px-4">{lang === 'zh' ? '归属落地文章' : 'Target Article'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 bg-slate-900/40 font-mono">
              {filteredKeywords.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-400 font-sans">
                    {lang === 'zh' ? '暂未匹配到符合条件的关键词数据' : 'No keywords matching current filter'}
                  </td>
                </tr>
              ) : (
                filteredKeywords.map((kw) => {
                  const intentBadge = getIntentBadge(kw.intent);
                  const rankDiff = kw.previousRank - kw.currentRank;

                  return (
                    <tr key={kw.id} className="hover:bg-slate-800/40 transition">
                      {/* Keyword + Intent */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white font-sans">{kw.keyword}</span>
                          <span className={`text-[10px] px-2 py-0.5 rounded border font-sans ${intentBadge.bg}`}>
                            {intentBadge.label}
                          </span>
                        </div>
                      </td>

                      {/* Rank & Movement */}
                      <td className="py-3 px-3 text-center">
                        <div className="inline-flex items-center gap-1.5">
                          <span
                            className={`w-6 h-6 rounded-lg flex items-center justify-center font-bold text-xs ${
                              kw.currentRank === 1
                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                : kw.currentRank <= 3
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                : 'bg-slate-800 text-slate-300 border border-slate-700'
                            }`}
                          >
                            #{kw.currentRank}
                          </span>
                          <span
                            className={`text-[11px] font-bold ${
                              rankDiff > 0
                                ? 'text-emerald-400'
                                : rankDiff < 0
                                ? 'text-rose-400'
                                : 'text-slate-400'
                            }`}
                          >
                            {rankDiff > 0 ? `↑${rankDiff}` : rankDiff < 0 ? `↓${Math.abs(rankDiff)}` : '='}
                          </span>
                        </div>
                      </td>

                      {/* Primary Engine */}
                      <td className="py-3 px-3 font-sans">
                        <span className="text-slate-200 text-xs px-2 py-1 rounded-md bg-slate-800 border border-slate-700/60">
                          {kw.engine}
                        </span>
                      </td>

                      {/* Prompt Volume */}
                      <td className="py-3 px-3 font-mono text-slate-300">
                        {kw.promptVolume.toLocaleString()} / mo
                      </td>

                      {/* Citation Probability */}
                      <td className="py-3 px-3 font-sans">
                        <div className="space-y-1 max-w-[140px]">
                          <div className="flex justify-between text-[11px] font-mono">
                            <span className="text-slate-400">Likelihood</span>
                            <span className="font-bold text-emerald-400">{kw.citationLikelihood}%</span>
                          </div>
                          <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-emerald-400"
                              style={{ width: `${kw.citationLikelihood}%` }}
                            ></div>
                          </div>
                        </div>
                      </td>

                      {/* Target Article */}
                      <td className="py-3 px-4 font-sans">
                        <button
                          type="button"
                          onClick={() => onNavigateToArticle && onNavigateToArticle(kw.targetArticleTitle)}
                          className="text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1.5 transition text-left line-clamp-1 group cursor-pointer"
                        >
                          <span className="underline-offset-2 hover:underline">{kw.targetArticleTitle}</span>
                          <ArrowUpRight className="w-3.5 h-3.5 opacity-60 group-hover:opacity-100 shrink-0" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer Summary Insight */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-2 text-xs text-slate-400 bg-slate-950/60 p-3 rounded-xl border border-slate-800/80">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong className="text-slate-200">{lang === 'zh' ? 'GEO 排名洞察：' : 'GEO Strategy: '}</strong>
              {lang === 'zh'
                ? '当前有 19 个商业与架构核心词位于大模型引用第 1 顺位，预估占全网同类问题 36.4% 的品牌信源曝光率。'
                : '19 high-intent commercial keywords maintain #1 citation authority across generative platforms.'}
            </span>
          </div>
          <span className="text-[11px] text-slate-400 shrink-0">
            {lang === 'zh' ? '下次自动复核：4小时后' : 'Next audit: in 4h'}
          </span>
        </div>
      </div>
    </div>
  );
};
