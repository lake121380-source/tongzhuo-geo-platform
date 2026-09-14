import React, { useState, useEffect } from 'react';
import {
  Award,
  CheckCircle2,
  ExternalLink,
  Plus,
  Trash2,
  Copy,
  Download,
  Save,
  Check,
  Building2,
  Terminal,
  Code2,
} from 'lucide-react';
import { BrandEntityConfig, SameAsLink, EeatAuditReport } from '../types';
import { GeoFlowApiClient } from '../api/geoflowClient';
import { LoadingState } from './LoadingState';

interface BrandEntityEeatViewProps {
  /** 合并入口的内层 Tab 渲染：隐藏自身页面标题（由外层 TabbedShell 统一画），只留操作区。 */
  embedded?: boolean;
  lang: 'zh' | 'en';
  apiClient?: GeoFlowApiClient;
}

/**
 * 空白初始态。此前的初始 state 是 mockData 里的演示品牌（含虚构的百科/Crunchbase
 * 词条、创始人和认证），一旦加载失败就会把演示数据当真实配置展示，点保存还会把它写进真实库。
 * 空态下保存写入的是空配置，不会捏造实体；加载未成功时保存按钮直接禁用。
 */
const EMPTY_BRAND_ENTITY_CONFIG: BrandEntityConfig = {
  organizationName: '',
  alternateName: '',
  legalName: '',
  foundingDate: '',
  officialDomain: '',
  logoUrl: '',
  description: '',
  sameAsLinks: [],
  founders: [],
  awardsAndCertifications: [],
  contactEmail: '',
};

export const BrandEntityEeatView: React.FC<BrandEntityEeatViewProps> = ({ lang, apiClient, embedded = false }) => {
  const [config, setConfig] = useState<BrandEntityConfig>(EMPTY_BRAND_ENTITY_CONFIG);
  const [eeatReport, setEeatReport] = useState<EeatAuditReport | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [jsonLdScript, setJsonLdScript] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newPlatformName, setNewPlatformName] = useState('');
  const [newPlatformUrl, setNewPlatformUrl] = useState('');
  const [activeCodeView, setActiveCodeView] = useState<'jsonld' | 'nextjs' | 'html'>('jsonld');
  const [copied, setCopied] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const apply = (data: Record<string, unknown>) => {
      if (!active) return;
      if (data.config) setConfig(data.config as BrandEntityConfig);
      if (data.eeatReport) setEeatReport(data.eeatReport as EeatAuditReport);
      if (data.jsonLdScript) setJsonLdScript(String(data.jsonLdScript));
      setLoadState('ready');
    };
    const fail = (message: string) => {
      if (!active) return;
      // 加载失败时清空而不是保留演示数据：表单为空、报告为 null，页面不展示任何未取到的值。
      setConfig(EMPTY_BRAND_ENTITY_CONFIG);
      setEeatReport(null);
      setJsonLdScript('');
      setLoadState('failed');
      setErrorMsg(message);
    };
    setLoadState('loading');
    if (apiClient) {
      apiClient
        .getBrandEntity()
        .then(apply)
        .catch((error) => fail(error instanceof Error ? error.message : '品牌实体加载失败'));
      return () => { active = false; };
    }
    fetch('/api/brand-entity')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) apply(data); else fail('品牌实体加载失败'); })
      .catch((err) => { console.warn('Fetch brand entity error:', err); fail('品牌实体加载失败'); });
    return () => { active = false; };
  }, [apiClient]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      if (apiClient) {
        const data = await apiClient.saveBrandEntity({ config });
        if (data.jsonLdScript) setJsonLdScript(String(data.jsonLdScript));
        if (data.eeatReport) setEeatReport(data.eeatReport as EeatAuditReport);
        showToast(
          lang === 'zh'
            ? '品牌实体消歧元数据与 Schema.org sameAs 已保存。'
            : 'Brand entity Schema & sameAs anchors saved.'
        );
        return;
      }
      const res = await fetch('/api/brand-entity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }) });
      if (res.ok) {
        const data = await res.json();
        if (data.jsonLdScript) setJsonLdScript(data.jsonLdScript);
        if (data.eeatReport) setEeatReport(data.eeatReport as EeatAuditReport);
        showToast(lang === 'zh' ? '品牌实体消歧元数据与 Schema.org sameAs 已保存。' : 'Brand entity Schema & sameAs anchors saved.');
      } else {
        setErrorMsg(lang === 'zh' ? '保存品牌实体失败' : 'Failed to save brand entity');
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : '保存品牌实体失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddSameAs = () => {
    if (!newPlatformName.trim() || !newPlatformUrl.trim()) return;
    // 只写入可核验的事实：后端仅校验并持久化 url。此前的 authorityWeight: 85 与
    // verified: true 都是本地编造的权威度/核验结论，界面上却当测量值展示。
    const newLink: SameAsLink = {
      id: `sameas-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      platformName: newPlatformName.trim(),
      url: newPlatformUrl.trim(),
    };
    setConfig((prev) => ({
      ...prev,
      sameAsLinks: [...prev.sameAsLinks, newLink],
    }));
    setNewPlatformName('');
    setNewPlatformUrl('');
    setShowAddModal(false);
    showToast(lang === 'zh' ? '已添加外部信源节点，保存后生效。' : 'External source node added; save to apply.');
  };

  // 按位置删除：历史记录可能没有 id，按 id 过滤会把所有缺 id 的链接一起删掉。
  const handleRemoveSameAs = (index: number) => {
    setConfig((prev) => ({
      ...prev,
      sameAsLinks: prev.sameAsLinks.filter((_, i) => i !== index),
    }));
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleDownload = () => {
    const blob = new Blob([jsonLdScript], { type: 'application/ld+json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'brand-organization-schema.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3500);
  };

  const nextJsSnippet = `// app/layout.tsx (Next.js 14+ App Router 品牌实体注入)
export default function RootLayout({ children }: { children: React.ReactNode }) {
  const brandJsonLd = ${jsonLdScript.trim() || '{}'};

  return (
    <html lang="zh-CN">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(brandJsonLd) }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}`;

  const htmlSnippet = `<!-- 放置于官网 index.html <head> 标签内部 -->
<script type="application/ld+json">
${jsonLdScript}
</script>`;

  const getCodeSnippet = () => {
    if (activeCodeView === 'nextjs') return nextJsSnippet;
    if (activeCodeView === 'html') return htmlSnippet;
    return jsonLdScript;
  };

  return (
    <div className="space-y-8" id="brand-entity-container">
      {/* Toast */}
      {toastMsg && (
        <div
          id="brand-toast"
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-lg border border-emerald-500/30 bg-slate-900 px-4 py-3 text-sm font-medium text-emerald-300 shadow-2xl backdrop-blur-md"
        >
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          <span>{toastMsg}</span>
        </div>
      )}
      {errorMsg && <div className="rounded-lg border border-rose-800 bg-rose-950/40 px-4 py-3 text-xs text-rose-300">{errorMsg}</div>}

      {/* Header Banner */}
      <div className={`flex flex-col gap-4 rounded-2xl bg-slate-900/80 p-6 sm:flex-row sm:items-center ${embedded ? 'sm:justify-end' : 'sm:justify-between'}`}>
        {!embedded && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-md bg-indigo-500/20 px-2.5 py-0.5 text-xs font-semibold text-indigo-300 border border-indigo-500/30">
              <Award className="h-3.5 w-3.5" />
              {lang === 'zh' ? '品牌实体' : 'Brand entity'}
            </span>
            <span className="text-caption">
              {lang === 'zh' ? '让 AI 明确「这个品牌名对应哪家公司」' : 'Tell AI which company the brand is'}
            </span>
          </div>
          <h2 className="text-xl font-bold tracking-tight text-white">
            {lang === 'zh' ? '品牌实体' : 'Brand entity'}
          </h2>
          <p className="text-[13px] text-slate-400">
            {lang === 'zh'
              ? '把企业名称、官网、权威页面链接（百科、企查查等）登记在这里。AI 回答里引用你的时候，靠的就是这些信息——填得越全，越不容易被搞混或忽略。'
              : 'Register your legal name, official site and authoritative links so AI engines can identify and trust your brand.'}
          </p>
        </div>
        )}

        <div className="flex flex-col items-end gap-1.5">
          <button
            onClick={handleSave}
            disabled={isSaving || loadState !== 'ready'}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {isSaving
              ? lang === 'zh'
                ? '保存中...'
                : 'Saving...'
              : lang === 'zh'
              ? '保存并应用实体配置'
              : 'Save Entity'}
          </button>
          {loadState !== 'ready' && (
            <span className="text-[12px] text-amber-300">
              {loadState === 'loading'
                ? <LoadingState lang={lang} variant="inline" label={lang === 'zh' ? '正在读取现有配置…' : 'Loading current configuration…'} />
                : lang === 'zh' ? '未取到现有配置，已禁用保存以免覆盖线上实体' : 'Existing configuration unavailable; saving is disabled to avoid overwriting it'}
            </span>
          )}
        </div>
      </div>

      {/* E-E-A-T 不计算总分：只展示可核验的配置完整度与真实计数，不给维度打分。 */}
      {eeatReport === null ? (
        <div className="rounded-2xl bg-slate-900/80 p-4 text-[13px] text-slate-400">
          {loadState === 'loading'
            ? <LoadingState lang={lang} variant="inline" label={lang === 'zh' ? '正在读取品牌实体报告…' : 'Loading brand entity report…'} />
            : lang === 'zh'
              ? '未取到品牌实体报告，因此不展示任何配置完整度或计数（不显示演示数据）。'
              : 'Brand entity report unavailable, so no completeness or count data is shown.'}
        </div>
      ) : (
        <>
          <div className="rounded-2xl bg-slate-900/80 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px] font-bold text-slate-300">
                {lang === 'zh' ? 'E-E-A-T 评分口径' : 'E-E-A-T scoring basis'}
              </span>
              <span className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[12px] font-bold text-slate-300">
                {lang === 'zh' ? '不计算总分' : 'No composite score'}
              </span>
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-slate-400">
              {String(eeatReport.score_reason || (lang === 'zh' ? '未提供口径说明。' : 'No basis provided.'))}
            </p>
            {Array.isArray(eeatReport.missing_fields) && eeatReport.missing_fields.length > 0 && (
              <p className="mt-2 text-[12.5px] leading-relaxed text-amber-300">
                {lang === 'zh' ? '尚未配置：' : 'Not configured: '}
                {eeatReport.missing_fields.join('、')}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                title: lang === 'zh' ? 'E · 一线实操经验 (Experience)' : 'Experience',
                value: `${eeatReport.counts?.published_article_count ?? 0}`,
                unit: lang === 'zh' ? '篇已发布内容' : 'published articles',
                detail: lang === 'zh' ? '来自 articles 表的真实计数' : 'Real count from the articles table',
              },
              {
                title: lang === 'zh' ? 'E · 技术领域专业度 (Expertise)' : 'Expertise',
                value: eeatReport.configured_fields?.description ? (lang === 'zh' ? '已配置' : 'Set') : (lang === 'zh' ? '未配置' : 'Missing'),
                unit: lang === 'zh' ? '官网描述' : 'site description',
                detail: lang === 'zh' ? '仅反映是否填写，不代表专业度高低' : 'Presence only, not a quality judgement',
              },
              {
                title: lang === 'zh' ? 'A · 外部权威性 (Authoritativeness)' : 'Authoritativeness',
                value: `${eeatReport.counts?.same_as_link_count ?? 0}`,
                unit: lang === 'zh' ? '个 sameAs 外部实体' : 'sameAs links',
                detail: lang === 'zh' ? 'JSON-LD 中真实写入的链接数' : 'Links actually emitted in the JSON-LD',
              },
              {
                title: lang === 'zh' ? 'T · 综合可信赖度 (Trustworthiness)' : 'Trustworthiness',
                value: `${[eeatReport.configured_fields?.legalName, eeatReport.configured_fields?.contactEmail, eeatReport.configured_fields?.logoUrl].filter(Boolean).length}/3`,
                unit: lang === 'zh' ? '法定名称 / 邮箱 / Logo' : 'legal name / email / logo',
                detail: lang === 'zh' ? '仅反映是否填写，不代表可信度高低' : 'Presence only, not a trust judgement',
              },
            ].map((card) => (
              <div key={card.title} className="rounded-2xl bg-slate-900/80 p-5">
                <span className="text-[12.5px] font-semibold text-slate-400">{card.title}</span>
                <div className="mt-2 text-sm font-bold text-white">
                  {card.value} <span className="text-[12px] font-normal text-slate-400">{card.unit}</span>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-slate-500">{card.detail}</p>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Main Grid: Form on Left (6 cols), Preview & DevOps on Right (6 cols) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left Column (6 cols) */}
        <div className="space-y-6 lg:col-span-6">
          {/* Base Entity Profile */}
          <div className="rounded-2xl bg-slate-900/80 p-5">
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-indigo-400" />
              <h3 className="text-section-title">
                {lang === 'zh' ? '企业实体基础信息档案' : 'Organization Entity Profile'}
              </h3>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2 text-xs">
              <div>
                <label className="font-semibold text-slate-300">
                  {lang === 'zh' ? '企业品牌通用名称' : 'Organization Name'}
                </label>
                <input
                  type="text"
                  value={config.organizationName}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, organizationName: e.target.value }))
                  }
                  className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white placeholder:text-slate-400 outline-none transition focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="font-semibold text-slate-300">
                  {lang === 'zh' ? '简称或代称 (Alternate Name)' : 'Alternate Name'}
                </label>
                <input
                  type="text"
                  value={config.alternateName}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, alternateName: e.target.value }))
                  }
                  className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white placeholder:text-slate-400 outline-none transition focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="font-semibold text-slate-300">
                  {lang === 'zh' ? '工商注册法人全称 (Legal Name)' : 'Legal Name'}
                </label>
                <input
                  type="text"
                  value={config.legalName}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, legalName: e.target.value }))
                  }
                  className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white placeholder:text-slate-400 outline-none transition focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="font-semibold text-slate-300">
                  {lang === 'zh' ? '官方唯一根域名' : 'Official Domain'}
                </label>
                <input
                  type="url"
                  value={config.officialDomain}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, officialDomain: e.target.value }))
                  }
                  className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white placeholder:text-slate-400 outline-none transition focus:border-indigo-500"
                />
              </div>
            </div>
          </div>

          {/* SameAs Authority Anchors */}
          <div className="rounded-2xl bg-slate-900/80 p-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-section-title">
                  {lang === 'zh' ? 'Schema sameAs 外部权威信源锚定列表' : 'sameAs Authority Node Anchors'}
                </h3>
                <p className="text-caption mt-0.5">
                  {lang === 'zh'
                    ? '大模型知识图谱会定期交叉比对以下外部实体，确认你的品牌真实存在且权威可信。'
                    : 'Entities cross-referenced by LLMs to verify organizational authenticity.'}
                </p>
              </div>
              <button
                onClick={() => setShowAddModal(true)}
                className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800"
              >
                <Plus className="h-3 w-3" />
                {lang === 'zh' ? '添加节点' : 'Add Node'}
              </button>
            </div>

            <div className="mt-4 space-y-2.5">
              {config.sameAsLinks.length === 0 && (
                <p className="rounded-xl bg-slate-950/40 px-4 py-3 text-[13px] text-slate-400">
                  {lang === 'zh'
                    ? '尚未配置 sameAs 外部实体。这些链接会原样写入 JSON-LD 的 sameAs 数组，需逐条人工核验后再填写。'
                    : 'No sameAs entity configured yet. These links are emitted verbatim into the JSON-LD sameAs array.'}
                </p>
              )}
              {config.sameAsLinks.map((item, idx) => (
                <div
                  key={item.id || item.url || `sameas-item-${idx}`}
                  className="flex items-center justify-between rounded-xl bg-slate-950/40 px-4 py-3 text-[13px] transition hover:bg-slate-800/40"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white">
                        {item.platformName || item.url}
                      </span>
                    </div>
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[12px] text-indigo-400 hover:underline"
                    >
                      <span className="truncate max-w-[280px]">{item.url}</span>
                      <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                    </a>
                  </div>

                  <button
                    onClick={() => handleRemoveSameAs(idx)}
                    title={lang === 'zh' ? '移除该信源' : 'Remove this source'}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-rose-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: Live Schema.org JSON-LD Code & DevOps Injection (6 cols) */}
        <div className="space-y-4 lg:col-span-6">
          <div className="overflow-hidden rounded-2xl bg-slate-950 shadow-md">
            <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/90 px-4 py-3">
              <div className="flex items-center gap-2">
                <div className="flex gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-rose-500/80 inline-block"></span>
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80 inline-block"></span>
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80 inline-block"></span>
                </div>
                <div className="flex items-center gap-1 ml-2">
                  <button
                    onClick={() => setActiveCodeView('jsonld')}
                    className={`px-2 py-0.5 text-[12px] rounded transition-colors ${
                      activeCodeView === 'jsonld'
                        ? 'bg-slate-800 text-indigo-400 font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Schema.jsonld
                  </button>
                  <button
                    onClick={() => setActiveCodeView('nextjs')}
                    className={`px-2 py-0.5 text-[12px] rounded transition-colors ${
                      activeCodeView === 'nextjs'
                        ? 'bg-slate-800 text-indigo-400 font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Next.js (layout.tsx)
                  </button>
                  <button
                    onClick={() => setActiveCodeView('html')}
                    className={`px-2 py-0.5 text-[12px] rounded transition-colors ${
                      activeCodeView === 'html'
                        ? 'bg-slate-800 text-indigo-400 font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    HTML Head
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleCopy(getCodeSnippet())}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 text-[12px] font-semibold text-slate-200 transition hover:bg-slate-800"
                >
                  {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  {copied ? (lang === 'zh' ? '已复制' : 'Copied') : (lang === 'zh' ? '复制' : 'Copy')}
                </button>
                {activeCodeView === 'jsonld' && (
                  <button
                    onClick={handleDownload}
                    className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 text-[12px] font-semibold text-slate-200 transition hover:bg-slate-800"
                  >
                    <Download className="h-3 w-3" />
                    {lang === 'zh' ? '下载' : 'Download'}
                  </button>
                )}
              </div>
            </div>

            <div className="p-4 bg-slate-950 font-mono text-xs text-indigo-300/90 overflow-x-auto max-h-[500px] leading-relaxed select-all">
              <pre className="whitespace-pre">
                {getCodeSnippet()
                  .split('\n')
                  .map((line, idx) => (
                    <div key={idx} className="hover:bg-slate-900/60 px-1 rounded flex">
                      <span className="w-8 select-none text-slate-400 text-right pr-3 tabular-nums">
                        {idx + 1}
                      </span>
                      <span>{line}</span>
                    </div>
                  ))}
              </pre>
            </div>
          </div>
        </div>
      </div>

      {/* Add SameAs Node Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-slate-900 p-6 shadow-2xl">
            <h3 className="text-base font-bold text-white">
              {lang === 'zh' ? '添加权威外部实体节点 (sameAs)' : 'Add Authority Node'}
            </h3>
            <p className="mt-1 text-[13px] text-slate-400">
              {lang === 'zh'
                ? '例如维基百科、百度百科、企查查、Crunchbase、GitHub 或官方社交媒体机构主页。'
                : 'Enter authoritative external profile URL to anchor.'}
            </p>

            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300">
                  {lang === 'zh' ? '平台名称与类型' : 'Platform Name'}
                </label>
                <input
                  type="text"
                  value={newPlatformName}
                  onChange={(e) => setNewPlatformName(e.target.value)}
                  placeholder={lang === 'zh' ? '例如: 维基百科英文词条 / 企查查官方核准' : 'e.g. Wikipedia / Crunchbase'}
                  className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white placeholder:text-slate-400 outline-none transition focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300">
                  {lang === 'zh' ? '权威主页或词条 URL' : 'Entity URL'}
                </label>
                <input
                  type="url"
                  value={newPlatformUrl}
                  onChange={(e) => setNewPlatformUrl(e.target.value)}
                  placeholder="https://en.wikipedia.org/wiki/..."
                  className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white placeholder:text-slate-400 outline-none transition focus:border-indigo-500"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2.5">
              <button
                onClick={() => setShowAddModal(false)}
                className="inline-flex h-9 items-center rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800 cursor-pointer"
              >
                {lang === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button
                onClick={handleAddSameAs}
                disabled={!newPlatformName.trim() || !newPlatformUrl.trim()}
                className="inline-flex h-9 items-center rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white transition hover:bg-indigo-500 disabled:opacity-50 cursor-pointer"
              >
                {lang === 'zh' ? '确认添加' : 'Add Node'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
