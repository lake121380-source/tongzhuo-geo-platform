import React, { useEffect, useState } from 'react';
import { Check, FileCode2, Globe, RefreshCw, Save, Upload } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { LoadingState } from './LoadingState';
import PermissionNotice from './PermissionNotice';
import { PageHeader } from './PageHeader';
import { describeApiError } from '../api/permissions';

interface SeoConfigurationViewProps {
  /** 合并入口的内层 Tab 渲染：隐藏自身页面标题（由外层 TabbedShell 统一画），只留操作区。 */
  embedded?: boolean;
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  initialTab?: 'robots' | 'sitemap' | 'llms';
  /** SEO/discovery read scope. */
  canRead?: boolean;
  /** SEO/discovery draft and publication write scope. */
  canWrite?: boolean;
}

type DiscoveryConfig = {
  site_title: string;
  summary: string;
  core_directives: string[];
  allow_all_by_default: boolean;
  include_llms_txt: boolean;
  include_sitemap: boolean;
  protected_paths: string[];
  bot_policies: Array<{ id: string; name: string; user_agent: string; action: string; crawl_delay?: number | null }>;
};

const fallback: DiscoveryConfig = {
  site_title: '', summary: '', core_directives: [], allow_all_by_default: true,
  // `/legacy-admin` 已随退役删除（2026-09-12），必须与服务端 `requiredProtectedPaths()` 保持一致——
  // 两边不同步会出现「界面显示保护了、服务端其实没有」这类错位。
  include_llms_txt: true, include_sitemap: true, protected_paths: ['/geo_admin', '/api', '/storage'], bot_policies: [],
};

export const SeoConfigurationView: React.FC<SeoConfigurationViewProps> = ({ apiClient, lang, initialTab = 'llms', canRead = true, canWrite = true, embedded = false }) => {
  const [config, setConfig] = useState<DiscoveryConfig>(fallback);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [preview, setPreview] = useState('');
  const [variant, setVariant] = useState<'short' | 'full'>('short');
  const [tab, setTab] = useState(initialTab);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [directiveDraft, setDirectiveDraft] = useState('');

  const load = async () => {
    if (!canRead) {
      setLoading(false);
      setMessage(lang === 'zh' ? '权限不足（403）：此页面需要「seo:read」权限。' : 'Permission denied (403): this page requires the “seo:read” scope.');
      return;
    }
    setLoading(true);
    try {
      // 配置与预览**互不依赖**，并行取。原先串行两个来回，而 dev 环境下单请求基线约 2 秒
      // （`php artisan serve` + CLI opcache 关闭），用户要多等一倍。预览自身的错误由
      // `refreshPreview` 内部捕获，不会连累配置展示。
      const [record] = await Promise.all([
        apiClient.getSiteSeoConfig(),
        refreshPreview(tab, variant),
      ]);
      const next = (record.config || fallback) as Partial<DiscoveryConfig>;
      setConfig({ ...fallback, ...next, core_directives: Array.isArray(next.core_directives) ? next.core_directives : [], protected_paths: Array.isArray(next.protected_paths) ? next.protected_paths : [], bot_policies: Array.isArray(next.bot_policies) ? next.bot_policies : [] });
      setPublishedAt(record.published_at ? String(record.published_at) : null);
    } catch (error) {
      setMessage(describeApiError(error, '加载 SEO 配置失败', lang));
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [canRead]);

  const refreshPreview = async (kind = tab, requestedVariant = variant) => {
    if (!canRead) {
      setMessage(lang === 'zh' ? '权限不足（403）：预览需要「seo:read」权限。' : 'Permission denied (403): previews require the “seo:read” scope.');
      return;
    }
    setBusy('preview');
    try {
      const record = kind === 'robots'
        ? await apiClient.previewRobots()
        : kind === 'sitemap'
          ? await apiClient.previewSitemap()
          : await apiClient.previewLlms(requestedVariant);
      setPreview(String(record.content || ''));
    } catch (error) { setMessage(describeApiError(error, '读取预览失败', lang)); }
    finally { setBusy(''); }
  };
  const save = async () => {
    if (!canWrite) {
      setMessage(lang === 'zh' ? '权限不足（403）：保存草稿需要「seo:write」权限。' : 'Permission denied (403): saving a draft requires the “seo:write” scope.');
      return;
    }
    setBusy('save');
    try { await apiClient.updateSiteSeoConfig(config as unknown as ApiRecord); setMessage(lang === 'zh' ? '草稿已保存，尚未发布' : 'Draft saved; not published'); }
    catch (error) { setMessage(describeApiError(error, '保存失败', lang)); }
    finally { setBusy(''); }
  };
  const publish = async () => {
    if (!canWrite) {
      setMessage(lang === 'zh' ? '权限不足（403）：发布输出需要「seo:write」权限。' : 'Permission denied (403): publishing output requires the “seo:write” scope.');
      return;
    }
    setBusy('publish');
    try { const record = await apiClient.publishLlms(); setPublishedAt(String(record.published_at || new Date().toISOString())); setPreview(String(tab === 'robots' ? record.robots : tab === 'sitemap' ? record.sitemap : record.content || '')); setMessage(lang === 'zh' ? '发布配置已保存，公开输出将使用新配置' : 'Published configuration saved; public outputs will use it'); }
    catch (error) { setMessage(describeApiError(error, '发布失败', lang)); }
    finally { setBusy(''); }
  };
  const rebuildSitemap = async () => {
    if (!canWrite) {
      setMessage(lang === 'zh' ? '权限不足（403）：重建 Sitemap 需要「seo:write」权限。' : 'Permission denied (403): rebuilding the sitemap requires the “seo:write” scope.');
      return;
    }
    setBusy('rebuild');
    try {
      const record = await apiClient.rebuildSitemap();
      const content = String(record.content || record.sitemap || '');
      if (content) setPreview(content);
      setMessage(lang === 'zh'
        ? 'Sitemap 预览已由后端重新生成；草稿配置仍需发布才会用于公开输出'
        : 'The sitemap preview was regenerated by the backend; publish the draft to use it for public output');
    } catch (error) {
      setMessage(describeApiError(error, 'Sitemap 重建失败', lang));
    } finally { setBusy(''); }
  };
  const switchTab = (next: 'robots' | 'sitemap' | 'llms') => { setTab(next); void refreshPreview(next, variant); };

  if (loading) return (
    <div className="p-6">
      <LoadingState lang={lang} label={lang === 'zh' ? '正在读取 SEO 配置与预览…' : 'Loading SEO configuration and preview…'} />
    </div>
  );
  if (!canRead) return (
    <div className="space-y-8">
      <PageHeader
        embedded={embedded}
        icon={Globe}
        group={lang === 'zh' ? 'GEO 诊断' : 'Diagnosis'}
        title={lang === 'zh' ? '站点 SEO' : 'Site SEO'}
        description={lang === 'zh' ? 'robots.txt、sitemap.xml、llms.txt——告诉搜索引擎和 AI 爬虫：有哪些页面、允不允许抓、给 AI 的导读怎么写。改完要点「发布生效」才会真正上线。' : 'robots.txt, sitemap.xml and llms.txt — how crawlers and AI engines see your site. Changes go live only after “Publish”.'}
      />
      <PermissionNotice lang={lang} mode="read" requiredScope="seo:read" />
    </div>
  );
  return (
    <div className="space-y-8">
      <PageHeader
        embedded={embedded}
        icon={Globe}
        group={lang === 'zh' ? 'GEO 诊断' : 'Diagnosis'}
        title={lang === 'zh' ? '站点 SEO' : 'Site SEO'}
        description={lang === 'zh' ? 'robots.txt、sitemap.xml、llms.txt——告诉搜索引擎和 AI 爬虫：有哪些页面、允不允许抓、给 AI 的导读怎么写。改完要点「发布生效」才会真正上线。' : 'robots.txt, sitemap.xml and llms.txt — how crawlers and AI engines see your site. Changes go live only after “Publish”.'}
        actions={<>
          {canWrite && <button onClick={() => void save()} disabled={busy !== ''} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800" title={lang === 'zh' ? '只保存草稿，访客与爬虫看不到' : 'Save a draft; not visible to crawlers'}><Save className="w-3 h-3" />{lang === 'zh' ? '保存草稿' : 'Save draft'}</button>}
          {tab === 'sitemap' && canWrite && <button onClick={() => void rebuildSitemap()} disabled={busy !== ''} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800"><RefreshCw className={'w-3 h-3 ' + (busy === 'rebuild' ? 'animate-spin' : '')} />{lang === 'zh' ? '重新生成预览' : 'Rebuild preview'}</button>}
          {canWrite && <button onClick={() => void publish()} disabled={busy !== ''} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white transition hover:bg-indigo-500" title={lang === 'zh' ? '把当前配置发布到线上，爬虫立刻可读' : 'Publish the current configuration'}><Upload className="w-3 h-3" />{lang === 'zh' ? '发布生效' : 'Publish'}</button>}
        </>}
      />
      {!canWrite && <PermissionNotice lang={lang} requiredScope="seo:write" />}
      {message && <div className="rounded-xl bg-indigo-500/8 px-4 py-3 text-[13px] text-indigo-200">{message}{publishedAt && <span className="ml-2 text-slate-400">最后发布：{publishedAt}</span>}</div>}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        <div className="lg:col-span-2 rounded-2xl bg-slate-900/80 p-4 space-y-3">
          <label className="block text-[12.5px] text-slate-400">站点标题<input disabled={!canWrite} value={config.site_title} onChange={(e) => setConfig({ ...config, site_title: e.target.value })} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500 disabled:opacity-60" /></label>
          <label className="block text-[12.5px] text-slate-400">站点摘要<textarea disabled={!canWrite} value={config.summary} onChange={(e) => setConfig({ ...config, summary: e.target.value })} rows={3} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-[13px] text-white outline-none transition focus:border-indigo-500 disabled:opacity-60" /></label>
          <label className="flex items-center justify-between text-[13px] text-slate-300">默认允许抓取<input disabled={!canWrite} type="checkbox" checked={config.allow_all_by_default} onChange={(e) => setConfig({ ...config, allow_all_by_default: e.target.checked })} /></label>
          <label className="flex items-center justify-between text-[13px] text-slate-300">启用 sitemap<input disabled={!canWrite} type="checkbox" checked={config.include_sitemap} onChange={(e) => setConfig({ ...config, include_sitemap: e.target.checked })} /></label>
          <label className="flex items-center justify-between text-[13px] text-slate-300">启用 llms.txt<input disabled={!canWrite} type="checkbox" checked={config.include_llms_txt} onChange={(e) => setConfig({ ...config, include_llms_txt: e.target.checked })} /></label>
          <div><div className="text-[12.5px] text-slate-400 mb-1">AI 引用规则</div><div className="flex gap-1"><input disabled={!canWrite} value={directiveDraft} onChange={(e) => setDirectiveDraft(e.target.value)} className="h-10 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500 disabled:opacity-60" /><button disabled={!canWrite} onClick={() => { if (directiveDraft.trim()) setConfig({ ...config, core_directives: [...config.core_directives, directiveDraft.trim()] }); setDirectiveDraft(''); }} className="inline-flex h-10 items-center rounded-xl border border-slate-700 bg-slate-800/60 px-3 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-40">添加</button></div><div className="mt-2 space-y-1">{config.core_directives.map((item, index) => <div key={index} className="flex justify-between text-[13px] text-slate-200 bg-slate-950/40 rounded-lg px-2 py-1"><span>{item}</span>{canWrite && <button onClick={() => setConfig({ ...config, core_directives: config.core_directives.filter((_, i) => i !== index) })} className="text-rose-300">×</button>}</div>)}</div></div>
        </div>
        <div className="lg:col-span-3 rounded-2xl bg-slate-950 overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-800 p-3"><div className="flex gap-1">{(['robots', 'sitemap', 'llms'] as const).map((item) => <button key={item} onClick={() => switchTab(item)} className={'text-xs px-3 py-1.5 rounded ' + (tab === item ? 'bg-indigo-600 text-white' : 'bg-slate-900 text-slate-400')}>{item === 'robots' ? 'robots.txt' : item === 'sitemap' ? 'sitemap.xml' : 'llms.txt'}</button>)}</div><button onClick={() => void refreshPreview()} className="text-slate-400"><RefreshCw className={'w-3.5 h-3.5 ' + (busy === 'preview' ? 'animate-spin' : '')} /></button></div>
          {tab === 'llms' && <div className="flex gap-2 px-3 pt-3"><button onClick={() => { setVariant('short'); void refreshPreview('llms', 'short'); }} className={'text-xs ' + (variant === 'short' ? 'text-indigo-300' : 'text-slate-500')}>short</button><button onClick={() => { setVariant('full'); void refreshPreview('llms', 'full'); }} className={'text-xs ' + (variant === 'full' ? 'text-indigo-300' : 'text-slate-500')}>full</button></div>}
          <pre className="max-h-[560px] overflow-auto p-4 text-xs leading-5 text-emerald-300 whitespace-pre-wrap">{preview || '暂无预览内容'}</pre>
          <div className="border-t border-slate-800 p-3 text-xs text-slate-500 flex items-center gap-1"><FileCode2 className="w-3 h-3" />{busy ? '处理中…' : <><Check className="w-3 h-3 text-emerald-400" />预览来自真实后端当前已发布配置</>}</div>
        </div>
      </div>
    </div>
  );
};
