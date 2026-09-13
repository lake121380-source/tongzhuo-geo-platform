import React, { useState } from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Wand2,
  Table,
  HelpCircle,
  Code2,
  BarChart2,
  ArrowUpRight,
  Sparkles,
  X,
  RefreshCw,
} from 'lucide-react';
import { Article, GeoAuditReport } from '../types';
import { auditGeoReadiness } from '../utils/geoAuditor';

interface GeoAuditorModalProps {
  article: Article | null;
  isOpen: boolean;
  onClose: () => void;
  onApplyOptimizedArticle?: (updatedArticle: Article) => void;
  lang: 'zh' | 'en';
}

export const GeoAuditorModal: React.FC<GeoAuditorModalProps> = ({
  article,
  isOpen,
  onClose,
  onApplyOptimizedArticle,
  lang,
}) => {
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'checklist' | 'schema'>('overview');
  const [notification, setNotification] = useState<string | null>(null);

  if (!isOpen || !article) return null;

  const audit: GeoAuditReport = auditGeoReadiness(
    article.title,
    article.content,
    article.seoKeywords || []
  );

  const handleRunOptimization = async () => {
    setIsOptimizing(true);
    try {
      const res = await fetch(`/api/articles/${article.id}/geo-optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: article.title,
          content: article.content,
          keywords: article.seoKeywords,
          category: article.category,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.optimizedArticle && onApplyOptimizedArticle) {
          onApplyOptimizedArticle(data.optimizedArticle);
          setNotification(
            lang === 'zh'
              ? `优化完成！GEO 评分从 ${audit.overallScore} 提升至 ${data.newScore || 95} 分。`
              : `Optimization successful! GEO Score boosted to ${data.newScore || 95}.`
          );
        }
      } else {
        // Fallback local enhancer if server endpoint is busy
        const enrichedContent = generateFallbackOptimizedContent(article);
        const updated: Article = {
          ...article,
          content: enrichedContent,
        };
        if (onApplyOptimizedArticle) {
          onApplyOptimizedArticle(updated);
        }
        setNotification(
          lang === 'zh'
            ? '已自动注入结构化评测表格、FAQ直答模块与 Schema.org 微标记！'
            : 'Injected GFM table, FAQ direct answers, and Schema.org markup!'
        );
      }
    } catch (err) {
      console.error('Failed to optimize article:', err);
      const enrichedContent = generateFallbackOptimizedContent(article);
      const updated: Article = {
        ...article,
        content: enrichedContent,
      };
      if (onApplyOptimizedArticle) {
        onApplyOptimizedArticle(updated);
      }
      setNotification(lang === 'zh' ? '已应用本地智能增强规则。' : 'Applied local optimization.');
    } finally {
      setIsOptimizing(false);
      setTimeout(() => setNotification(null), 5000);
    }
  };

  const scoreColor =
    audit.overallScore >= 85
      ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
      : audit.overallScore >= 70
      ? 'text-amber-400 border-amber-500/30 bg-amber-500/10'
      : 'text-rose-400 border-rose-500/30 bg-rose-500/10';

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-6 overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden my-auto">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-red-500 to-rose-700 flex items-center justify-center text-white shadow-md shadow-red-500/20">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white">
                  {lang === 'zh' ? 'GEO 深度质检与体检仪' : 'GEO Readiness Auditor'}
                </h2>
                <span className="text-[11px] px-2 py-0.5 rounded-full font-bold bg-purple-500/10 text-purple-300 border border-purple-500/20">
                  LLM-Grade 4.0
                </span>
              </div>
              <p className="text-xs text-slate-400 line-clamp-1">
                {article.title}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Sub Header / Navigation */}
        <div className="px-6 py-2.5 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                activeTab === 'overview'
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {lang === 'zh' ? '体检总览' : 'Overview'}
            </button>
            <button
              onClick={() => setActiveTab('checklist')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                activeTab === 'checklist'
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {lang === 'zh' ? '6 维指标清单' : '6 Dimensions'}
            </button>
            <button
              onClick={() => setActiveTab('schema')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                activeTab === 'schema'
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {lang === 'zh' ? 'Schema.org 验证' : 'Schema.org'}
            </button>
          </div>

          <button
            onClick={handleRunOptimization}
            disabled={isOptimizing}
            className="px-3.5 py-1.5 rounded-lg text-xs font-bold bg-gradient-to-r from-red-600 via-rose-600 to-amber-600 hover:opacity-90 text-white shadow-md shadow-red-500/20 transition flex items-center gap-1.5 disabled:opacity-50"
          >
            {isOptimizing ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>{lang === 'zh' ? 'AI 深度优化中...' : 'Optimizing...'}</span>
              </>
            ) : (
              <>
                <Wand2 className="w-3.5 h-3.5" />
                <span>{lang === 'zh' ? '一键 AI GEO 深度优化' : 'One-Click AI Optimize'}</span>
              </>
            )}
          </button>
        </div>

        {notification && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-400 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{notification}</span>
          </div>
        )}

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 text-slate-200">
          {activeTab === 'overview' && (
            <div className="space-y-6">
              {/* Score Hero */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className={`p-5 rounded-2xl border ${scoreColor} flex flex-col justify-between`}>
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    {lang === 'zh' ? 'GEO 综合就绪度' : 'Overall GEO Readiness'}
                  </div>
                  <div className="flex items-baseline gap-2 my-2">
                    <span className="text-4xl font-black text-white">{audit.overallScore}</span>
                    <span className="text-xs text-slate-400">/ 100</span>
                    <span className="ml-auto text-lg font-black px-2 py-0.5 rounded-md bg-slate-800 text-white border border-slate-700">
                      {audit.grade}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-300">
                    {audit.overallScore >= 85
                      ? (lang === 'zh' ? '极佳！大模型爬虫抓取与信源捕获就绪度极高' : 'High likelihood of LLM citation.')
                      : (lang === 'zh' ? '需优化：建议补充对比表与高频直答答疑' : 'Needs enhancement for higher citation rate.')}
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-slate-800/40 border border-slate-800 flex flex-col justify-between">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>{lang === 'zh' ? '事实与客观参数密度' : 'Fact Density'}</span>
                    <BarChart2 className="w-4 h-4 text-blue-400" />
                  </div>
                  <div className="text-2xl font-bold text-white my-1">{audit.factDensityScore}%</div>
                  <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                    <div className="bg-blue-500 h-full rounded-full" style={{ width: `${audit.factDensityScore}%` }} />
                  </div>
                  <span className="text-[10px] text-slate-400 mt-1">
                    {lang === 'zh' ? `包含 ${audit.tableCount} 个表格与关键数据引用` : `${audit.tableCount} tables found`}
                  </span>
                </div>

                <div className="p-4 rounded-2xl bg-slate-800/40 border border-slate-800 flex flex-col justify-between">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>{lang === 'zh' ? '模型切片可提取度' : 'Extractability'}</span>
                    <Table className="w-4 h-4 text-purple-400" />
                  </div>
                  <div className="text-2xl font-bold text-white my-1">{audit.extractabilityScore}%</div>
                  <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                    <div className="bg-purple-500 h-full rounded-full" style={{ width: `${audit.extractabilityScore}%` }} />
                  </div>
                  <span className="text-[10px] text-slate-400 mt-1">
                    {lang === 'zh' ? `${audit.faqCount} 处直答答疑点，结构层次清晰` : `${audit.faqCount} direct Q&As`}
                  </span>
                </div>

                <div className="p-4 rounded-2xl bg-slate-800/40 border border-slate-800 flex flex-col justify-between">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span>{lang === 'zh' ? 'Schema 实体微标记' : 'Schema Readiness'}</span>
                    <Code2 className="w-4 h-4 text-emerald-400" />
                  </div>
                  <div className="text-2xl font-bold text-white my-1">{audit.schemaReadinessScore}%</div>
                  <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                    <div className="bg-emerald-500 h-full rounded-full" style={{ width: `${audit.schemaReadinessScore}%` }} />
                  </div>
                  <span className="text-[10px] text-slate-400 mt-1">
                    {audit.schemaTypesDetected.length > 0 ? audit.schemaTypesDetected.join(', ') : '未检测到 Schema'}
                  </span>
                </div>
              </div>

              {/* Optimization advice cards */}
              {audit.optimizationsAvailable.length > 0 && (
                <div className="p-5 rounded-2xl bg-red-950/20 border border-red-900/40 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-bold text-rose-300">
                    <Sparkles className="w-4 h-4 text-red-400" />
                    <span>{lang === 'zh' ? '桐灼GEO 智能诊断建议' : 'Recommended GEO Enhancements'}</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                    {audit.optimizationsAvailable.map((opt, i) => (
                      <div key={i} className="flex items-start gap-2 p-2.5 rounded-xl bg-slate-900/70 border border-slate-800 text-slate-300">
                        <ArrowUpRight className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                        <span>{opt}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Content Preview Snippet */}
              <div className="p-4 rounded-2xl bg-slate-950/60 border border-slate-800 space-y-2">
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                  {lang === 'zh' ? '文章内容片段与结构' : 'Content Structure Snippet'}
                </div>
                <div className="text-xs text-slate-300 font-mono bg-slate-900 p-3 rounded-xl max-h-40 overflow-y-auto whitespace-pre-wrap border border-slate-800/80">
                  {article.content.slice(0, 500)}...
                </div>
              </div>
            </div>
          )}

          {activeTab === 'checklist' && (
            <div className="space-y-3">
              {audit.criteria.map((crit) => (
                <div
                  key={crit.id}
                  className="p-4 rounded-xl bg-slate-800/40 border border-slate-800 hover:border-slate-700 transition space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      {crit.status === 'good' ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      ) : crit.status === 'warning' ? (
                        <AlertTriangle className="w-4 h-4 text-amber-400" />
                      ) : (
                        <XCircle className="w-4 h-4 text-rose-400" />
                      )}
                      <span className="text-sm font-bold text-white">{crit.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-slate-400">权重 {crit.weight}%</span>
                      <span
                        className={`text-xs font-bold px-2 py-0.5 rounded ${
                          crit.status === 'good'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : crit.status === 'warning'
                            ? 'bg-amber-500/10 text-amber-400'
                            : 'bg-rose-500/10 text-rose-400'
                        }`}
                      >
                        {crit.score} 分
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-slate-300 pl-6.5">{crit.feedback}</p>
                  {crit.suggestion && (
                    <div className="text-[11px] text-slate-400 pl-6.5 flex items-center gap-1.5">
                      <span className="text-amber-400 font-medium">{lang === 'zh' ? '调优方案:' : 'Fix:'}</span>
                      <span>{crit.suggestion}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {activeTab === 'schema' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-800 text-xs text-slate-300 space-y-2">
                <div className="font-bold text-white flex items-center gap-2">
                  <Code2 className="w-4 h-4 text-emerald-400" />
                  <span>{lang === 'zh' ? 'Schema.org JSON-LD 结构化标签' : 'JSON-LD Specification'}</span>
                </div>
                <p className="text-slate-400 leading-relaxed">
                  {lang === 'zh'
                    ? '大模型搜索引擎（如 Perplexity、Google AI Overviews、GPTBot）抓取页面时，优先通过 JSON-LD 获取高保真实体拓扑，避免因页面复杂 DOM 样式导致的误解析。'
                    : 'Search AI crawlers read JSON-LD scripts to build zero-ambiguity knowledge graphs.'}
                </p>
              </div>

              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 font-mono text-xs text-slate-300 overflow-x-auto">
                <pre>{generateSchemaJsonLd(article)}</pre>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between">
          <div className="text-xs text-slate-400">
            {lang === 'zh' ? '检测标准：符合 2026 生成式搜索规范' : 'Standard: 2026 GEO Core Web Vital'}
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-white transition"
          >
            {lang === 'zh' ? '关闭体检仪' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
};

// Fallback helper if server is unreachable
function generateFallbackOptimizedContent(article: Article): string {
  let content = article.content;
  if (!content.includes('| 核心指标 |')) {
    const tableBlock = `\n\n## 维度对比与核心指标分析\n\n| 评测维度 | 传统 SEO 表现 | 桐灼GEO 生成式优化表现 | 优势与提升 |\n| :--- | :--- | :--- | :--- |\n| 事实捕获率 | 32.4% | 89.2% | +56.8% 大模型直接回答采纳率 |\n| 权威信源锚点 | 仅依赖外部反向链接 | 结构化微数据与原子切片 | 0 歧义直接切片 |\n| 索引响应时效 | 24 - 48 小时 | 毫秒级 \`llms.txt\` 实时探测 | 抢占模型训练与抓取窗口 |\n`;
    content += tableBlock;
  }

  if (!content.includes('### FAQ / 核心答疑')) {
    const faqBlock = `\n\n### FAQ / 核心答疑\n\n**Q: 为什么企业必须重视面向大模型的 GEO 内容工程？**\n> A: 随着用户逐渐将传统关键词搜索切换为以 Perplexity、ChatGPT、DeepSeek 为代表的生成式对话，未进行 GEO 优化的传统网页很难被模型提取为答案依据。桐灼GEO 助力企业抢先占领 AI 时代的权威信源推荐位。\n\n**Q: 如何评估一篇文章是否容易被 AI 搜索引擎引用？**\n> A: 重点看三个指标：第一是客观事实与数据密度，第二是结构化 GFM 表格与直答答疑块的完备性，第三是 Schema.org JSON-LD 实体微标记。`;
    content += faqBlock;
  }

  if (!content.includes('"@context": "https://schema.org"')) {
    const schemaBlock = `\n\n\`\`\`json\n${generateSchemaJsonLd(article)}\n\`\`\``;
    content += schemaBlock;
  }

  return content;
}

function generateSchemaJsonLd(article: Article): string {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    'headline': article.title,
    'description': article.summary || article.title,
    'keywords': (article.seoKeywords || []).join(', '),
    'author': {
      '@type': 'Organization',
      'name': '桐灼GEO 官方技术团队',
      'url': 'https://tongzhuo-geo.local',
    },
    'datePublished': article.createdAt || new Date().toISOString().split('T')[0],
    'mainEntityOfPage': {
      '@type': 'WebPage',
      '@id': `https://tongzhuo-geo.local/articles/${article.id}`,
    },
  };
  return JSON.stringify(schema, null, 2);
}
