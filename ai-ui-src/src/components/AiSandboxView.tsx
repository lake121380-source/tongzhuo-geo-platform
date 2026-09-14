import React, { useState } from 'react';
import {
  Compass,
  Search,
  Sparkles,
  ExternalLink,
  Bot,
  CheckCircle2,
  AlertCircle,
  Lightbulb,
  ArrowRight,
  TrendingUp,
  RefreshCw,
  ShieldCheck,
  Globe,
  Share2,
} from 'lucide-react';
import { AiSandboxSimulation } from '../types';
import { GeoFlowApiClient } from '../api/geoflowClient';
import { PageHeader } from './PageHeader';

interface AiSandboxViewProps {
  /** 合并入口的内层 Tab 渲染：隐藏自身页面标题（由外层 TabbedShell 统一画），只留操作区。 */
  embedded?: boolean;
  lang: 'zh' | 'en';
  apiClient?: GeoFlowApiClient;
}

const PRESET_QUERIES = [
  '企业做GEO内容优化有哪些比较好的专业平台推荐？',
  '生成式引擎优化 (GEO) 与传统搜索引擎优化 (SEO) 有何核心区别？',
  '如何规范编写 /llms.txt 文件以引导大模型抓取与引用？',
  '国内大模型与 Perplexity 搜索引用企业官网时优先看重哪些结构？',
];

/** 信源占有率不可计算时说明原因：把后端的状态码直接展示给用户没有意义。 */
function citationShareReason(status: string, lang: 'zh' | 'en'): string {
  const zh = lang === 'zh';
  switch (status) {
    case 'owned_domains_not_configured':
      return zh ? '尚未在品牌实体中声明官方域名' : 'No official domain declared in the brand entity';
    case 'no_citation_records':
      return zh ? '本次回答没有引用记录' : 'This answer has no citations';
    default:
      return zh ? '不可计算' : 'Unavailable';
  }
}

export const AiSandboxView: React.FC<AiSandboxViewProps> = ({ lang, apiClient, embedded = false }) => {
  const [query, setQuery] = useState(PRESET_QUERIES[0]);
  const [targetEngine, setTargetEngine] = useState<'perplexity' | 'chatgpt' | 'gemini'>('perplexity');
  const [isRunning, setIsRunning] = useState(false);
  const [simulation, setSimulation] = useState<AiSandboxSimulation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRunSimulation = async (selectedQuery?: string) => {
    const q = selectedQuery || query;
    if (!q.trim()) return;

    setIsRunning(true);
    setError(null);

    try {
      if (apiClient) {
        const data = await apiClient.runAiSandbox({ query: q, targetEngine });
        setSimulation(data as unknown as AiSandboxSimulation);
      } else {
        const res = await fetch('/api/sandbox/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, targetEngine }) });
        if (res.ok) {
          const data = await res.json();
          setSimulation(data);
        } else {
          const err = await res.json().catch(() => ({ error: 'Simulation failed' }));
          setError(err.error || '模拟请求异常');
        }
      }
    } catch (err) {
      console.error('Simulation error:', err);
      // 必须原样显示后端错误：未配置搜索源时后端返回的是可操作的 422
      // （例如「问题采集失败：…」），笼统的「无法连接沙盒计算节点」会把它盖成假故障。
      setError(err instanceof Error ? err.message : '沙盒请求失败');
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        embedded={embedded}
        icon={Compass}
        group={lang === 'zh' ? 'GEO 效果' : 'Results'}
        title={lang === 'zh' ? '引用测试' : 'Citation test'}
        description={lang === 'zh' ? '拿一个真实问题去问主流 AI 搜索引擎，看它们会不会引用你、提到你——用真实调用评测，不造假结果。' : 'Ask mainstream AI engines a real question and see whether they cite or mention your brand.'}
      />

      {/* Query Bar & Presets */}
      <div className="bg-slate-900/80 p-5 rounded-2xl border border-slate-800 space-y-4">
        {/* Engine Selection Tabs */}
        <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
          <span className="text-xs text-slate-400 font-semibold mr-2">
            {lang === 'zh' ? '目标大模型引擎:' : 'Target Engine:'}
          </span>
          <button
            onClick={() => setTargetEngine('perplexity')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
              targetEngine === 'perplexity'
                ? 'bg-indigo-100 text-indigo-700 border border-indigo-500/30 dark:bg-indigo-600/20 dark:text-indigo-300'
                : 'bg-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            <Bot className="w-3.5 h-3.5" />
            <span>Perplexity AI</span>
          </button>
          <button
            onClick={() => setTargetEngine('chatgpt')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
              targetEngine === 'chatgpt'
                ? 'bg-indigo-100 text-indigo-700 border border-indigo-500/30 dark:bg-indigo-600/20 dark:text-indigo-300'
                : 'bg-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            <Bot className="w-3.5 h-3.5" />
            <span>SearchGPT (OpenAI)</span>
          </button>
          <button
            onClick={() => setTargetEngine('gemini')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
              targetEngine === 'gemini'
                ? 'bg-indigo-100 text-indigo-700 border border-indigo-500/30 dark:bg-indigo-600/20 dark:text-indigo-300'
                : 'bg-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            <Bot className="w-3.5 h-3.5" />
            <span>Google AI Overview (Gemini)</span>
          </button>
        </div>

        {/* Input Bar */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRunSimulation()}
              placeholder={lang === 'zh' ? '输入用户在 AI 搜索中可能提问的自然语言问题...' : 'Enter search query...'}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-xl pl-10 pr-4 py-2.5 text-xs text-white focus:outline-none focus:border-indigo-500 transition"
            />
          </div>

          <button
            onClick={() => handleRunSimulation()}
            disabled={isRunning || !query.trim()}
            className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-xs font-bold text-white shadow-sm transition flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isRunning ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>{lang === 'zh' ? '大模型推理仿真中...' : 'Simulating...'}</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                <span>{lang === 'zh' ? '开始模拟检索' : 'Run Simulation'}</span>
              </>
            )}
          </button>
        </div>

        {/* Presets */}
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <span className="text-[11px] text-slate-400 font-semibold">{lang === 'zh' ? '预设高频提问:' : 'Presets:'}</span>
          {PRESET_QUERIES.map((p, idx) => (
            <button
              key={idx}
              onClick={() => {
                setQuery(p);
                handleRunSimulation(p);
              }}
              className="text-[11px] px-2.5 py-1 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700/60 transition"
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-400 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Simulation Results */}
      {simulation && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Main Answer Card (8 cols) */}
          <div className="lg:col-span-8 bg-slate-900/80 p-6 rounded-2xl border border-slate-800 space-y-5">
            {/* Header info */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
                  <Bot className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-bold text-white capitalize">
                    {simulation.targetEngine} 实时检索切片与回答
                  </div>
                  <div className="text-[10px] text-slate-400">{simulation.timestamp}</div>
                </div>
              </div>

              {/* Status Pill */}
              <div className="flex items-center gap-2">
                <span
                  className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full flex items-center gap-1 ${
                    simulation.brandMentioned === true
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                      : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                  }`}
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>
                    {simulation.brandMentioned === null
                      ? (lang === 'zh' ? '未配置品牌，提及不可计算' : 'Brand not configured; mention unavailable')
                      : simulation.brandMentioned
                        ? (lang === 'zh' ? '品牌已成功被模型推荐' : 'Brand Cited')
                        : (lang === 'zh' ? '未直接捕获品牌' : 'No Brand Mention')}
                  </span>
                </span>
              </div>
            </div>

            {/* Answer Content */}
            <div className="prose prose-invert max-w-none text-xs sm:text-sm text-slate-200 leading-relaxed whitespace-pre-wrap bg-slate-950 p-5 rounded-xl border border-slate-800/80 font-normal">
              {simulation.simulatedAnswer}
            </div>

            {/* Citations List */}
            <div className="space-y-3 pt-2">
              <div className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                <Globe className="w-4 h-4 text-red-400" />
                <span>{lang === 'zh' ? '模型引用的底层信源列表' : 'Cited Sources'}</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {simulation.citations.map((c) => (
                  <div
                    key={c.id}
                    className={`p-3 rounded-xl border transition ${
                      c.brandMatch
                        ? 'bg-red-950/20 border-red-500/30'
                        : 'bg-slate-950 border-slate-800'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="w-4 h-4 rounded-full bg-slate-800 text-[10px] font-bold text-white flex items-center justify-center shrink-0">
                          {c.id}
                        </span>
                        <div className="text-xs font-bold text-white line-clamp-1">
                          {c.title}
                        </div>
                      </div>
                      {c.brandMatch === true && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30 font-semibold shrink-0">
                          {lang === 'zh' ? `${simulation.brandName} 信源` : `${simulation.brandName} source`}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 line-clamp-2 mt-1.5">
                      {c.snippet}
                    </p>
                    <div className="text-[10px] text-slate-400 mt-2 truncate font-mono">
                      {c.url}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right Metrics & Tips (4 cols) */}
          <div className="lg:col-span-4 space-y-4">
            {/* Stats Card */}
            <div className="bg-slate-900/80 p-5 rounded-2xl border border-slate-800 space-y-4">
              <h3 className="text-sm font-bold text-white flex items-center gap-2 border-b border-slate-800 pb-2">
                <TrendingUp className="w-4 h-4 text-emerald-400" />
                <span>{lang === 'zh' ? '沙盒评测核心指标' : 'Sandbox Metrics'}</span>
              </h3>

              <div className="space-y-3">
                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
                  <span className="text-xs text-slate-400">{lang === 'zh' ? '信源占有率' : 'Citation Share'}</span>
                  <div className="text-right">
                    <div className="text-lg font-black text-emerald-400">
                      {simulation.citationSharePercent === null
                        ? (lang === 'zh' ? '不可计算' : 'Unavailable')
                        : `${simulation.citationSharePercent}%`}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {simulation.citationSharePercent === null
                        ? citationShareReason(simulation.citationShareStatus, lang)
                        : `${simulation.citations.filter((c) => c.brandMatch === true).length} / ${simulation.citationShareDenominator}`}
                    </div>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
                  <span className="text-xs text-slate-400">{lang === 'zh' ? '品牌态度画像' : 'Brand Sentiment'}</span>
                  {simulation.brandSentiment === null ? (
                    <span className="text-xs font-medium text-slate-400">
                      {lang === 'zh' ? '未采集' : 'Not collected'}
                    </span>
                  ) : (
                    <span className="text-xs font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      {simulation.brandSentiment}
                    </span>
                  )}
                </div>

                <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
                  <span className="text-xs text-slate-400">{lang === 'zh' ? '回答采纳情况' : 'Answer inclusion'}</span>
                  <span className="text-xs font-bold text-white">
                    {simulation.brandRecommendationGrade
                      ?? (lang === 'zh' ? '不可计算（未配置品牌）' : 'Unavailable (brand not configured)')}
                  </span>
                </div>
              </div>
            </div>

            {/* Actionable Advice Card */}
            <div className="bg-slate-900/80 p-5 rounded-2xl border border-slate-800 space-y-4">
              <h3 className="text-sm font-bold text-white flex items-center gap-2 border-b border-slate-800 pb-2">
                <Lightbulb className="w-4 h-4 text-amber-400" />
                <span>{lang === 'zh' ? '针对该词的 GEO 优化策略' : 'Actionable Advice'}</span>
              </h3>

              <div className="space-y-2.5 text-xs text-slate-300">
                {simulation.actionableAdvice.map((advice, idx) => (
                  <div key={idx} className="flex items-start gap-2 p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                    <ArrowRight className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                    <span>{advice}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
