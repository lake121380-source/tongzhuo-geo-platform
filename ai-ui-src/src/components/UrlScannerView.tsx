import React, { useCallback, useEffect, useState } from 'react';
import {
  Globe,
  Search,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  FileCheck,
  Download,
  Copy,
  Sparkles,
  Bot,
  FileText,
  Table,
  Cpu,
  Layers,
  Check,
} from 'lucide-react';
import { UrlScanReport, UrlScanItem } from '../types';
import { GeoFlowApiClient, GeoFlowApiError, UrlScanSummary } from '../api/geoflowClient';
import { LoadingState } from './LoadingState';
import { EmptyState } from './ui';

interface UrlScannerViewProps {
  /** 合并入口的内层 Tab 渲染：隐藏自身页面标题（由外层 TabbedShell 统一画），只留操作区。 */
  embedded?: boolean;
  lang: 'zh' | 'en';
  apiClient?: GeoFlowApiClient;
  canRead?: boolean;
  canWrite?: boolean;
}

const emptyReport: UrlScanReport = {
  url: '', scannedAt: '', overallScore: 0, grade: 'D',
  robotsTxtStatus: { accessible: false, gptBotAllowed: false, claudeBotAllowed: false, perplexityAllowed: false, bytespiderAllowed: false },
  llmsTxtStatus: { present: false, formatStandard: false, urlCount: 0, hasDirectives: false },
  schemaStatus: { hasSchema: false, typesFound: [], jsonLdValid: false },
  contentQuality: { wordCount: 0, tableCount: 0, faqSectionDetected: false, fluffRatio: 0 },
  items: [], quickFixPlan: [],
};

function mapReport(value: unknown): UrlScanReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const report = value as Record<string, any>;
  const robots = report.robots_txt_status || {};
  const llms = report.llms_txt_status || {};
  const schema = report.schema_status || {};
  const content = report.content_quality || {};
  return {
    url: String(report.url || ''), scannedAt: String(report.scanned_at || ''),
    overallScore: Number(report.overall_score || 0), grade: (report.grade || 'D') as UrlScanReport['grade'],
    robotsTxtStatus: { accessible: Boolean(robots.accessible), gptBotAllowed: Boolean(robots.gpt_bot_allowed), claudeBotAllowed: Boolean(robots.claude_bot_allowed), perplexityAllowed: Boolean(robots.perplexity_allowed), bytespiderAllowed: Boolean(robots.bytespider_allowed) },
    llmsTxtStatus: { present: Boolean(llms.present), formatStandard: Boolean(llms.format_standard), urlCount: Number(llms.url_count || 0), hasDirectives: Boolean(llms.has_directives) },
    schemaStatus: { hasSchema: Boolean(schema.has_schema), typesFound: Array.isArray(schema.types_found) ? schema.types_found.map(String) : [], jsonLdValid: Boolean(schema.json_ld_valid) },
    contentQuality: { wordCount: Number(content.word_count || 0), tableCount: Number(content.table_count || 0), faqSectionDetected: Boolean(content.faq_section_detected), fluffRatio: Number(content.fluff_ratio || 0) },
    items: Array.isArray(report.items) ? report.items as UrlScanItem[] : [],
    quickFixPlan: Array.isArray(report.quick_fix_plan) ? report.quick_fix_plan.map(String) : [],
  };
}

export const UrlScannerView: React.FC<UrlScannerViewProps> = ({ lang, apiClient, canRead = true, canWrite = true, embedded = false }) => {
  const [urlInput, setUrlInput] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [report, setReport] = useState<UrlScanReport | null>(null);
  const [scanId, setScanId] = useState<number | null>(null);
  const [history, setHistory] = useState<UrlScanSummary[]>([]);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    if (!apiClient || !canRead) return;
    try {
      const result = await apiClient.listUrlScans({ page: 1, per_page: 20 });
      setHistory(result.items || []);
    } catch (reason) {
      setError(reason instanceof GeoFlowApiError || reason instanceof Error ? reason.message : '扫描记录加载失败');
    } finally {
      setLoading(false);
    }
  }, [apiClient, canRead]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const activeReport = report || emptyReport;

  const handleScan = async (overrideUrl?: string) => {
    const target = overrideUrl || urlInput;
    if (!target.trim()) return;
    if (!canWrite) return;
    setIsScanning(true);
    setError('');
    setScanId(null);
    setReport(null);

    try {
      if (apiClient) {
        const result = await apiClient.createUrlScan(target);
        const id = Number(result.scan?.id || 0);
        setScanId(id || null);
        setReport(mapReport(result.scan?.report));
        await loadHistory();
      }
    } catch (reason) {
      // `reason instanceof GeoFlowApiError` is a boolean; the error object
      // itself is what carries `details`, and `true.details` used to throw
      // inside this catch block and mask the real failure.
      const apiError = reason instanceof GeoFlowApiError ? reason : null;
      const failedId = apiError ? Number(apiError.details.scan_id || 0) : 0;
      if (failedId) setScanId(failedId);
      setError(reason instanceof Error ? reason.message : '扫描失败，请稍后重试');
    } finally {
      setIsScanning(false);
    }
  };

  const handleRetry = async () => {
    if (!apiClient || !scanId || !canWrite) return;
    setIsScanning(true); setError('');
    try {
      const result = await apiClient.retryUrlScan(scanId);
      setReport(mapReport(result.scan?.report));
      await loadHistory();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '重试失败');
    } finally { setIsScanning(false); }
  };

  const handleOpenHistory = async (item: UrlScanSummary) => {
    if (!apiClient) return;
    setError('');
    setReport(null);
    try {
      const result = await apiClient.getUrlScan(item.id);
      setScanId(item.id);
      setUrlInput(String(result.scan.url || item.url));
      setReport(mapReport(result.scan.report));
      if (result.scan.status === 'failed') setError(result.scan.error_message || '该次扫描失败，可以重试');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '扫描报告加载失败');
    }
  };

  const handleCopyReport = () => {
    let md = `# GEO 深度体检诊断报告\n`;
    md += `测试网址: ${activeReport.url}\n`;
    md += `体检时间: ${activeReport.scannedAt}\n`;
    md += `综合得分: ${activeReport.overallScore} / 100 (评级: ${activeReport.grade})\n\n`;
    md += `## 核心工程指标诊断\n`;
    activeReport.items.forEach((item) => {
      md += `### [${item.status.toUpperCase()}] ${item.dimension} - ${item.score}分\n`;
      md += `- 详情: ${item.details}\n`;
      md += `- 优化建议: ${item.recommendation}\n\n`;
    });
    md += `## 优先级修复方案\n`;
    activeReport.quickFixPlan.forEach((plan, i) => {
      md += `${i + 1}. ${plan}\n`;
    });

    void navigator.clipboard.writeText(md);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleDownloadReport = () => {
    if (apiClient && scanId) {
      void apiClient.downloadUrlScanReport(scanId).then((blob) => {
        const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `geo-scan-report-${scanId}.md`; link.click(); URL.revokeObjectURL(link.href);
      }).catch((reason) => setError(reason instanceof Error ? reason.message : '报告下载失败'));
      return;
    }
    let md = `# GEO 深度体检诊断报告\n`;
    md += `测试网址: ${activeReport.url}\n`;
    md += `体检时间: ${activeReport.scannedAt}\n`;
    md += `综合得分: ${activeReport.overallScore} / 100 (评级: ${activeReport.grade})\n\n`;
    activeReport.items.forEach((item) => {
      md += `### [${item.status.toUpperCase()}] ${item.dimension} - ${item.score}分\n`;
      md += `- 详情: ${item.details}\n`;
      md += `- 优化建议: ${item.recommendation}\n\n`;
    });
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `geo-scan-report-${Date.now()}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-8" id="url-scanner-container">
      {/* Header Banner */}
      <div className={`flex flex-col gap-4 rounded-2xl bg-slate-900/80 p-6 sm:flex-row ${embedded ? 'sm:items-center sm:justify-end' : 'sm:items-center sm:justify-between'}`}>
        {!embedded && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-md bg-indigo-950/60 px-2.5 py-0.5 text-xs font-semibold text-indigo-300 border border-indigo-800/50">
              <Globe className="h-3.5 w-3.5" />
              {lang === 'zh' ? '页面体检' : 'Page inspector'}
            </span>
            <span className="text-caption">
              {lang === 'zh' ? '检查一个网址能不能被 AI 正常抓取' : 'Check whether AI crawlers can read a URL'}
            </span>
          </div>
          <h2 className="text-xl font-bold tracking-tight text-white">
            {lang === 'zh' ? '页面体检' : 'Page inspector'}
          </h2>
          <p className="text-[13px] text-slate-400">
            {lang === 'zh'
              ? '输入任意网址，检查 AI 爬虫能不能抓、llms.txt 写得规不规范、结构化数据全不全。报告会保存下来，可复制或导出。'
              : 'Scan any URL for AI crawler readiness, llms.txt and structured data. Reports are persisted and exportable.'}
          </p>
        </div>
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={handleCopyReport}
            disabled={!report}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? (lang === 'zh' ? '已复制报告' : 'Copied!') : (lang === 'zh' ? '复制诊断书' : 'Copy Report')}
          </button>
          <button
            onClick={handleDownloadReport}
            disabled={!report || Boolean(apiClient && !canRead)}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800"
          >
            <Download className="h-3.5 w-3.5" />
            {lang === 'zh' ? '导出报告 (MD)' : 'Export MD'}
          </button>
        </div>
      </div>

      {/* URL Input & Presets Box */}
      <div className="rounded-2xl bg-slate-900/80 p-5">
        <label className="block text-[12.5px] font-semibold text-slate-300">
          {lang === 'zh' ? '目标网站或落地页完整 URL' : 'Target Domain or Page URL'}
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Globe className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://example.com/page-to-test"
              className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900 pl-9 pr-3 text-[13px] text-white placeholder:text-slate-400 outline-none transition focus:border-indigo-500"
            />
          </div>
          <button
            onClick={() => handleScan()}
            disabled={isScanning || !urlInput.trim() || !canWrite}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 text-[13px] font-bold text-white transition hover:bg-indigo-500 disabled:opacity-50 cursor-pointer"
          >
            <Search className={`h-4 w-4 ${isScanning ? 'animate-spin' : ''}`} />
            {isScanning
              ? lang === 'zh'
                ? '深度诊断中...'
                : 'Inspecting...'
              : lang === 'zh'
              ? '立即深度体检'
              : 'Inspect URL'}
          </button>
        </div>

        {!apiClient && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>{lang === 'zh' ? '快速测试预设：' : 'Quick Samples:'}</span>
            <button
              onClick={() => {
                const u = 'https://tongzhuo-geo.local/articles/hubspot-vs-crm-geo-content-trust';
                setUrlInput(u);
                handleScan(u);
              }}
              className="rounded bg-indigo-950/60 px-2 py-0.5 text-indigo-300 border border-indigo-800/50 hover:bg-indigo-900/60 transition"
            >
              {lang === 'zh' ? '本站规范文章 (桐灼GEO 标杆)' : 'Our Standard Article (Benchmark)'}
            </button>
            <button
              onClick={() => {
                const u = 'https://example-legacy-seo.com/blog/article-1';
                setUrlInput(u);
                handleScan(u);
              }}
              className="rounded bg-slate-800 px-2 py-0.5 text-slate-300 border border-slate-700 hover:bg-slate-700 transition"
            >
              {lang === 'zh' ? '传统SEO低分页面 (竞品/未优化站)' : 'Legacy SEO Site (Unoptimized)'}
            </button>
          </div>
        )}

        {!canWrite && apiClient && <p className="mt-3 text-xs text-amber-300">当前令牌缺少 materials:write，URL 扫描为只读模式。</p>}
        {!canRead && apiClient && <p className="mt-3 text-xs text-amber-300">当前令牌缺少 materials:read，无法读取或导出已保存的扫描报告。</p>}
        {error && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
            <span>{error}</span>
            {scanId && canWrite && <button type="button" onClick={() => void handleRetry()} disabled={isScanning} className="rounded border border-rose-700 px-2 py-1 font-semibold hover:bg-rose-900/50 disabled:opacity-50">{lang === 'zh' ? '重试' : 'Retry'}</button>}
          </div>
        )}
      </div>

      {apiClient && canRead && (
        <div className="rounded-2xl bg-slate-900/80 p-4">
          <div className="mb-3 flex items-center justify-between"><h3 className="text-section-title">{lang === 'zh' ? '最近扫描记录' : 'Recent scans'}</h3><button type="button" onClick={() => void loadHistory()} className="text-[12.5px] text-indigo-400 hover:underline">{lang === 'zh' ? '刷新' : 'Refresh'}</button></div>
          {loading && history.length === 0 ? <LoadingState lang={lang} variant="inline" label={lang === 'zh' ? '正在读取扫描记录…' : 'Loading scan history…'} /> : history.length === 0 ? (
            <EmptyState
              compact
              icon={Bot}
              title={lang === 'zh' ? '还没有扫描记录' : 'No scans yet'}
              description={lang === 'zh' ? '在上面输入一个网址做一次体检，记录会保存到这里。' : 'Run a scan above and it will be saved here.'}
            />
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {history.slice(0, 6).map((item) => <button type="button" key={item.id} onClick={() => void handleOpenHistory(item)} className="flex items-center justify-between rounded-xl bg-slate-950/40 px-4 py-3 text-left transition hover:bg-slate-800/40"><span className="min-w-0"><span className="block truncate text-[13px] font-medium text-slate-200">{item.url}</span><span className="text-[12px] text-slate-500">{item.scanned_at || item.created_at || '—'}</span></span><span className={`ml-3 text-[13px] font-bold ${item.status === 'failed' ? 'text-rose-400' : 'text-indigo-300'}`}>{item.status === 'failed' ? (lang === 'zh' ? '失败' : 'Failed') : `${item.overall_score} · ${item.grade}`}</span></button>)}
            </div>
          )}
        </div>
      )}

      {!report && (isScanning ? (
        <LoadingState lang={lang} variant="panel" label={lang === 'zh' ? '正在扫描…' : 'Scanning…'} />
      ) : (
        <EmptyState
          icon={Globe}
          title={lang === 'zh' ? '还没有扫描结果' : 'No scan report yet'}
          description={lang === 'zh' ? '在上方输入一个公开网址，点「立即深度体检」开始；报告会自动保存，可复制或导出。' : 'Enter a public URL above and run the scan; the report is saved and exportable.'}
        />
      ))}

      {/* Score Overview Cards */}
      {report && <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {/* Overall Score */}
        <div className="rounded-2xl bg-slate-900/80 p-5 lg:col-span-1">
          <div className="text-caption">
            {lang === 'zh' ? '综合 GEO 就绪得分' : 'GEO Readiness Score'}
          </div>
          <div className="mt-3 flex items-baseline gap-2">
            <span
              className={`text-4xl font-extrabold tracking-tight ${
                activeReport.overallScore >= 85
                  ? 'text-emerald-400'
                  : activeReport.overallScore >= 70
                  ? 'text-amber-400'
                  : 'text-rose-400'
              }`}
            >
              {activeReport.overallScore}
            </span>
            <span className="text-sm font-semibold text-slate-400">/ 100</span>
            <span
              className={`rounded px-1.5 py-0.5 text-xs font-bold ${
                activeReport.overallScore >= 85
                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/40'
                  : activeReport.overallScore >= 70
                  ? 'bg-amber-950 text-amber-300 border border-amber-800/40'
                  : 'bg-rose-950 text-rose-300 border border-rose-800/40'
              }`}
            >
              {activeReport.grade}
            </span>
          </div>
          <p className="mt-2 text-[12.5px] text-slate-400">
            {activeReport.overallScore >= 85
              ? lang === 'zh'
                ? '表现卓越，极利于大模型首屏推荐引用'
                : 'Excellent, primed for LLM citations'
              : lang === 'zh'
              ? '存在明显短板，极易被大模型过滤'
              : 'Has critical gaps affecting citation'}
          </p>
        </div>

        {/* robots.txt status */}
        <div className="rounded-2xl bg-slate-900/80 p-4">
          <div className="flex items-center gap-1.5 text-caption">
            <Bot className="h-3.5 w-3.5 text-slate-400" />
            <span>robots.txt 放行</span>
          </div>
          <div className="mt-2 flex items-center gap-1.5 font-bold text-white text-sm">
            {activeReport.robotsTxtStatus.gptBotAllowed ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            ) : (
              <XCircle className="h-4 w-4 text-rose-400" />
            )}
            <span>{activeReport.robotsTxtStatus.gptBotAllowed ? '放行 GPT/Perplexity' : '存在阻拦'}</span>
          </div>
          <p className="mt-1 text-[12px] text-slate-400">
            ByteSpider: {activeReport.robotsTxtStatus.bytespiderAllowed ? '已允许' : '未明确放行'}
          </p>
        </div>

        {/* llms.txt status */}
        <div className="rounded-2xl bg-slate-900/80 p-4">
          <div className="flex items-center gap-1.5 text-caption">
            <FileCheck className="h-3.5 w-3.5 text-slate-400" />
            <span>/llms.txt 规范</span>
          </div>
          <div className="mt-2 flex items-center gap-1.5 font-bold text-white text-sm">
            {activeReport.llmsTxtStatus.present ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            ) : (
              <XCircle className="h-4 w-4 text-rose-400" />
            )}
            <span>{activeReport.llmsTxtStatus.present ? '已规范部署' : '未检测到索引'}</span>
          </div>
          <p className="mt-1 text-[12px] text-slate-400">
            {activeReport.llmsTxtStatus.present
              ? `${activeReport.llmsTxtStatus.urlCount} 篇语料 · 指令完备`
              : '大模型需耗巨量Token抓取'}
          </p>
        </div>

        {/* Schema.org status */}
        <div className="rounded-2xl bg-slate-900/80 p-4">
          <div className="flex items-center gap-1.5 text-caption">
            <Layers className="h-3.5 w-3.5 text-slate-400" />
            <span>Schema.org 标记</span>
          </div>
          <div className="mt-2 flex items-center gap-1.5 font-bold text-white text-sm">
            {activeReport.schemaStatus.hasSchema ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-amber-400" />
            )}
            <span>{activeReport.schemaStatus.hasSchema ? 'JSON-LD 完备' : '标记缺失'}</span>
          </div>
          <p className="mt-1 text-[12px] text-slate-400">
            {activeReport.schemaStatus.typesFound.join(', ')}
          </p>
        </div>

        {/* Tables & Fluff */}
        <div className="rounded-2xl bg-slate-900/80 p-4">
          <div className="flex items-center gap-1.5 text-caption">
            <Table className="h-3.5 w-3.5 text-slate-400" />
            <span>表格与废话比</span>
          </div>
          <div className="mt-2 flex items-center gap-1.5 font-bold text-white text-sm">
            <span>{activeReport.contentQuality.tableCount} 个GFM表格</span>
          </div>
          <p className="mt-1 text-[12px] text-slate-400">
            废话虚词占比: {activeReport.contentQuality.fluffRatio}% ({activeReport.contentQuality.fluffRatio < 10 ? '优' : '偏高'})
          </p>
        </div>
      </div>}

      {/* Detailed Diagnostic Items */}
      {report && <div className="space-y-4">
        <h3 className="text-section-title">
          {lang === 'zh' ? '5 维度细粒度体检结果与诊断' : 'Detailed Dimension Diagnostics'}
        </h3>

        <div className="space-y-3">
          {activeReport.items.map((item, idx) => (
            <div
              key={idx}
              className="rounded-2xl bg-slate-900/80 p-5"
            >
              <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
                <div className="flex items-center gap-2">
                  {item.status === 'pass' ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  ) : item.status === 'warning' ? (
                    <AlertTriangle className="h-4 w-4 text-amber-400" />
                  ) : (
                    <XCircle className="h-4 w-4 text-rose-400" />
                  )}
                  <span className="font-semibold text-white text-sm">
                    {item.dimension}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.2 text-[11px] font-bold ${
                      item.status === 'pass'
                        ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/40'
                        : item.status === 'warning'
                        ? 'bg-amber-950 text-amber-300 border border-amber-800/40'
                        : 'bg-rose-950 text-rose-300 border border-rose-800/40'
                    }`}
                  >
                    {item.score}分
                  </span>
                </div>
              </div>

              <div className="mt-2 text-[13px] font-medium text-slate-200">
                {item.title}
              </div>

              <div className="mt-1.5 text-[13px] text-slate-400">
                {item.details}
              </div>

              <div className="mt-2.5 rounded-xl bg-slate-950/40 px-4 py-3 text-[13px]">
                <span className="font-semibold text-indigo-400">
                  {lang === 'zh' ? '💡 针对性修复建议: ' : '💡 Recommendation: '}
                </span>
                <span className="text-slate-300">{item.recommendation}</span>
              </div>
            </div>
          ))}
        </div>
      </div>}

      {/* Priority Action Plan */}
      {report && <div className="rounded-2xl bg-indigo-500/8 p-5">
        <h4 className="text-[13.5px] font-bold text-indigo-200">
          {lang === 'zh' ? '优先级修复行动清单 (Action Plan)' : 'Remediation Action Plan'}
        </h4>
        <ul className="mt-3 space-y-2 text-[13px] text-indigo-300">
          {activeReport.quickFixPlan.map((plan, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-bold text-white">
                {i + 1}
              </span>
              <span>{plan}</span>
            </li>
          ))}
        </ul>
      </div>}
    </div>
  );
};
