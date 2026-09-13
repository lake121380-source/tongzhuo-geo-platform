import React from 'react';
import {
  ShieldCheck,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Layers,
  Award,
  FileCode2,
  Globe,
  Sparkles,
  X,
  ArrowRight,
} from 'lucide-react';

interface ExecutiveScorecardModalProps {
  isOpen: boolean;
  onClose: () => void;
  lang: 'zh' | 'en';
  onNavigateTab: (tab: string) => void;
}

export const ExecutiveScorecardModal: React.FC<ExecutiveScorecardModalProps> = ({
  isOpen,
  onClose,
  lang,
  onNavigateTab,
}) => {
  if (!isOpen) return null;

  const overallScore = 94;

  const scoreDimensions = [
    {
      id: 'ssr_renderability',
      title: lang === 'zh' ? 'SSR 纯静态 HTML 可读性' : 'SSR Static HTML Delivery',
      score: 98,
      status: 'pass',
      description:
        lang === 'zh'
          ? '全站正文均由服务端直接吐出纯静态文本，杜绝客户端 CSR 空白挂载，大模型 RAG 爬虫 100% 抓取。'
          : 'Zero blank CSR div#root tags. RAG spiders retrieve full textual corpus directly.',
      tabKey: 'seo_foundation',
      icon: Globe,
    },
    {
      id: 'robots_policy',
      title: lang === 'zh' ? '主流 AI 爬虫准入放行' : 'AI Crawler Directives (robots.txt)',
      score: 95,
      status: 'pass',
      description:
        lang === 'zh'
          ? '已对 GPTBot、PerplexityBot、Bytespider、Google-Extended 精确设置准入规则并声明 /llms.txt。'
          : 'Explicitly white-listed reputable LLM spiders with transparent llms.txt directives.',
      tabKey: 'robots_policy',
      icon: ShieldCheck,
    },
    {
      id: 'entity_disambiguation',
      title: lang === 'zh' ? '品牌实体消歧与 sameAs 锚定' : 'Brand Entity Disambiguation (EEAT)',
      score: 92,
      status: 'pass',
      description:
        lang === 'zh'
          ? '已通过 Schema.org Organization 绑定 4 处权威机构节点（维基、企查查、Crunchbase），消除模型歧义。'
          : 'Anchored 4 high-authority entity nodes via Schema.org sameAs properties.',
      tabKey: 'brand_entity',
      icon: Award,
    },
    {
      id: 'atomic_chunks',
      title: lang === 'zh' ? '语料原子切片与高事实密度' : 'Atomic Chunks & Fact Density',
      score: 89,
      status: 'pass',
      description:
        lang === 'zh'
          ? '核心文章已全部解耦为独立可验证的 Fact Chunks，规避代词与空洞营销套话，利于向量检索召回。'
          : 'Content library decomposed into self-contained factual chunks without ambiguity.',
      tabKey: 'llmstxt',
      icon: FileCode2,
    },
    {
      id: 'dual_sitemap',
      title: lang === 'zh' ? '双轨 Sitemap 与 /llms.txt 同步' : 'Dual Sitemap & /llms.txt Sync',
      score: 96,
      status: 'pass',
      description:
        lang === 'zh'
          ? 'Googlebot 抓取 sitemap.xml，AI 爬虫抓取 /llms.txt，双轨映射实时同步且已全网部署。'
          : 'Unified dual-track indexing deployed at root level for both classic & generative crawlers.',
      tabKey: 'seo_foundation',
      icon: Layers,
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-6 border-b border-slate-800 flex items-center justify-between bg-gradient-to-r from-slate-900 via-slate-800/80 to-slate-900">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <span>{lang === 'zh' ? '全站 GEO / SEO 综合就绪度记分卡' : 'GEO & SEO Readiness Scorecard'}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold">
                  {lang === 'zh' ? '卓越等级' : 'Grade A+'}
                </span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {lang === 'zh'
                  ? '权威衡量企业落地页面向新一代生成式 AI 搜索引擎的准入召回率'
                  : 'Holistic evaluation of website crawlability and citation readiness for LLM engines'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Big Scorecard Banner */}
        <div className="p-6 border-b border-slate-800/80 bg-slate-950/50 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-emerald-400 to-indigo-400 font-mono tabular-nums">
              {overallScore}
              <span className="text-base text-slate-400 font-normal"> / 100</span>
            </div>
            <div className="text-xs space-y-1">
              <div className="text-emerald-400 font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" />
                <span>{lang === 'zh' ? '已达到顶级生成式引擎直接引用标准' : 'Fully Qualified for LLM Citation'}</span>
              </div>
              <div className="text-slate-400">
                {lang === 'zh'
                  ? '已完成“底层合规 → 事实语料 → 归因转化”三大流水线落地'
                  : 'Covering compliance, atomic knowledge grounding, and attribution'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <div className="px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 text-slate-300">
              {lang === 'zh' ? '检测耗时：' : 'Time: '}<span className="font-mono text-emerald-400">120ms</span>
            </div>
            <div className="px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 text-slate-300">
              {lang === 'zh' ? '覆盖引擎：' : 'Engines: '}<span className="font-mono text-indigo-400">6家顶级大模型</span>
            </div>
          </div>
        </div>

        {/* Score Dimensions List */}
        <div className="p-6 space-y-3 overflow-y-auto flex-1 custom-scrollbar">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            {lang === 'zh' ? '五大核心指标诊断详情' : 'Detailed Diagnostics'}
          </div>

          {scoreDimensions.map((dim) => {
            const Icon = dim.icon;
            return (
              <div
                key={dim.id}
                className="p-3.5 rounded-xl border border-slate-800 bg-slate-800/40 hover:bg-slate-800/70 transition-colors flex items-start justify-between gap-3"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300 shrink-0 mt-0.5">
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-white">{dim.title}</span>
                      <span className="text-[11px] font-mono text-emerald-400 bg-emerald-950/60 px-1.5 py-0.2 rounded border border-emerald-800/40 tabular-nums">
                        {dim.score} 分
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      {dim.description}
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => {
                    onNavigateTab(dim.tabKey);
                    onClose();
                  }}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300 shrink-0 mt-1"
                >
                  <span>{lang === 'zh' ? '前往优化' : 'Inspect'}</span>
                  <ArrowRight className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>

        {/* Footer actions */}
        <div className="p-4 border-t border-slate-800 bg-slate-900 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
          >
            {lang === 'zh' ? '关闭' : 'Close'}
          </button>
          <button
            onClick={() => {
              onNavigateTab('seo_foundation');
              onClose();
            }}
            className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-sm transition-colors"
          >
            {lang === 'zh' ? '深入 SEO 筑基工程' : 'Go to SEO Foundation'}
          </button>
        </div>
      </div>
    </div>
  );
};
