import React, { useCallback, useEffect, useState } from 'react';
import { Archive, Copy, Download, ExternalLink, Globe2, LayoutTemplate, Play, RefreshCw, RotateCcw, Save, Trash2, WandSparkles } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient, ThemeReplicationRecord } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';
import PermissionNotice from './PermissionNotice';
import { LoadingState } from './LoadingState';
import SensitiveWordsPanel from './SensitiveWordsPanel';

interface Props { apiClient: GeoFlowApiClient; lang: 'zh' | 'en'; canRead: boolean; canWrite: boolean; isSuperAdmin?: boolean; }
const key = (prefix: string) => `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
const record = (v: unknown): ApiRecord => v && typeof v === 'object' && !Array.isArray(v) ? v as ApiRecord : {};

type CarouselSlide = { image_url: string; title: string; link_url: string; enabled: boolean };
const MAX_CAROUSEL_SLIDES = 3;
const emptySlide = (): CarouselSlide => ({ image_url: '', title: '', link_url: '', enabled: true });

/**
 * `GET site-settings` returns `home_carousel_slides` as a JSON *string* (the
 * server stringifies every setting), so the panel has to decode it before it
 * can edit slides — and re-encode it as an array on the way back.
 */
function parseCarousel(raw: unknown): CarouselSlide[] {
  const source = Array.isArray(raw) ? raw : (() => {
    const text = String(raw ?? '').trim();
    if (text === '') return [];
    try { return JSON.parse(text); } catch { return []; }
  })();
  if (!Array.isArray(source)) return [];
  return source.slice(0, MAX_CAROUSEL_SLIDES).map((slide) => {
    const row = record(slide);
    return {
      image_url: String(row.image_url ?? ''),
      title: String(row.title ?? ''),
      link_url: String(row.link_url ?? ''),
      enabled: row.enabled === undefined ? true : Boolean(row.enabled),
    };
  });
}

export default function SiteSettingsPanel({ apiClient, lang, canRead, canWrite, isSuperAdmin = false }: Props) {
  const zh = lang === 'zh';
  const [settings, setSettings] = useState<ApiRecord>({});
  const [themes, setThemes] = useState<ApiRecord[]>([]);
  const [homepage, setHomepage] = useState<ApiRecord>({ style: {}, modules: [], presets: [] });
  const [draft, setDraft] = useState({ site_name: '', site_subtitle: '', site_description: '', site_keywords: '', copyright_info: '', filing_info: '', filing_url: '', site_logo: '', site_favicon: '', seo_title_template: '', seo_description_template: '', featured_limit: '6', per_page: '12', analytics_code: '', company_legal_name: '', company_tagline: '', company_services: '', company_services_title: '', contact_email: '', contact_phone: '', company_address: '', company_founded: '', about_title: '', about_content: '' });
  const [carousel, setCarousel] = useState<CarouselSlide[]>([]);
  const [theme, setTheme] = useState('');
  const [homepageJson, setHomepageJson] = useState('{\n  "style": {},\n  "modules": []\n}');
  const [preset, setPreset] = useState('');
  const [busy, setBusy] = useState('');
  // 首屏取数态：初始 true，load() 收尾置 false；只在还没有 settings 时占位。
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [replications, setReplications] = useState<ThemeReplicationRecord[]>([]);
  const [replicationThemes, setReplicationThemes] = useState<ApiRecord[]>([]);
  const [replicationModels, setReplicationModels] = useState<ApiRecord[]>([]);
  const [replicationForm, setReplicationForm] = useState({ name: '', theme_id: '', ai_model_id: '', home_url: '', category_url: '', article_url: '', style_preference: 'content_site', compliance_ack: true });
  const [feedback, setFeedback] = useState<Record<number, string>>({});
  const [copyForm, setCopyForm] = useState<Record<number, { name: string; theme_id: string }>>({});

  const hydrate = useCallback((data: ApiRecord) => {
    const next = record(data.settings);
    setSettings(next); setThemes(Array.isArray(data.themes) ? data.themes.map(record) : []);
    const nextHomepage = record(data.homepage); setHomepage(nextHomepage);
    setTheme(String(next.active_theme || ''));
    setHomepageJson(JSON.stringify({ style: nextHomepage.style || {}, modules: nextHomepage.modules || [] }, null, 2));
    setDraft((current) => Object.fromEntries(Object.keys(current).map((field) => [field, String(next[field] ?? current[field] ?? '')])) as typeof current);
    setCarousel(parseCarousel(next.home_carousel_slides));
  }, []);
  const load = useCallback(async () => {
    if (!canRead) return;
    setBusy('load'); setNotice('');
    try { hydrate(record(await apiClient.getSiteSettings())); }
    catch (error) { setNotice(describeApiError(error, zh ? '无法读取站点设置' : 'Unable to load site settings', lang)); }
    finally { setBusy(''); setLoading(false); }
  }, [apiClient, canRead, hydrate, lang, zh]);
  useEffect(() => { void load(); }, [load]);

  const loadReplications = useCallback(async () => {
    if (!canRead || !isSuperAdmin) return;
    try {
      const data = await apiClient.listThemeReplications();
      setReplications(Array.isArray(data.items) ? data.items : []);
      setReplicationThemes(Array.isArray(data.themes) ? data.themes : []);
      setReplicationModels(Array.isArray(data.models) ? data.models : []);
    } catch (error) {
      setNotice(describeApiError(error, zh ? '无法读取主题复制任务' : 'Unable to load theme replication tasks', lang));
    }
  }, [apiClient, canRead, isSuperAdmin, lang, zh]);
  useEffect(() => { void loadReplications(); }, [loadReplications]);
  useEffect(() => {
    if (!replications.some((item) => !['ready', 'published', 'archived', 'failed'].includes(String(item.status)))) return undefined;
    const timer = window.setInterval(() => { void loadReplications(); }, 4000);
    return () => window.clearInterval(timer);
  }, [loadReplications, replications]);

  const saveBase = async () => {
    setBusy('base'); setNotice('');
    // The server rejects the whole payload when a field the caller is not
    // allowed to write is present, so `analytics_code` goes out only for super
    // administrators — for everyone else it is neither shown nor sent.
    const payload: ApiRecord = { ...draft, home_carousel_slides: carousel };
    if (!isSuperAdmin) delete payload.analytics_code;
    try { hydrate(record(await apiClient.updateSiteSettings(payload, { idempotencyKey: key('site-settings') }))); setNotice(zh ? '站点设置已保存' : 'Site settings saved'); }
    catch (error) { setNotice(describeApiError(error, zh ? '站点设置保存失败' : 'Unable to save site settings', lang)); }
    finally { setBusy(''); }
  };
  const saveTheme = async () => {
    setBusy('theme'); setNotice('');
    try { hydrate(record(await apiClient.updateSiteTheme(theme, { idempotencyKey: key('site-theme') }))); setNotice(zh ? '主题已切换' : 'Theme updated'); }
    catch (error) { setNotice(describeApiError(error, zh ? '主题保存失败' : 'Unable to update theme', lang)); }
    finally { setBusy(''); }
  };
  const saveHomepage = async () => {
    setBusy('homepage'); setNotice('');
    try { const parsed = JSON.parse(homepageJson) as ApiRecord; hydrate(record(await apiClient.updateHomepageSettings({ homepage_style: parsed.style || {}, homepage_modules: parsed.modules || [] }, { idempotencyKey: key('homepage') }))); setNotice(zh ? '首页编排已保存' : 'Homepage saved'); }
    catch (error) { setNotice(error instanceof SyntaxError ? (zh ? '首页 JSON 格式不正确' : 'Homepage JSON is invalid') : describeApiError(error, zh ? '首页保存失败' : 'Unable to save homepage', lang)); }
    finally { setBusy(''); }
  };
  const applyPreset = async () => {
    if (!preset) return;
    setBusy('preset'); setNotice('');
    try { hydrate(record(await apiClient.applyHomepagePreset(preset, 'replace', { idempotencyKey: key('preset') }))); setNotice(zh ? '首页预设已套用' : 'Homepage preset applied'); }
    catch (error) { setNotice(describeApiError(error, zh ? '预设套用失败' : 'Unable to apply preset', lang)); }
    finally { setBusy(''); }
  };
  const importDesign = async () => {
    setBusy('import'); setNotice('');
    try { const parsed = JSON.parse(homepageJson) as ApiRecord; hydrate(record(await apiClient.importHomepageDesign(parsed, 'replace', { idempotencyKey: key('import') }))); setNotice(zh ? '首页设计已导入' : 'Homepage design imported'); }
    catch (error) { setNotice(error instanceof SyntaxError ? (zh ? '首页 JSON 格式不正确' : 'Homepage JSON is invalid') : describeApiError(error, zh ? '导入失败' : 'Unable to import design', lang)); }
    finally { setBusy(''); }
  };
  const refreshReplication = async (id: number) => {
    const result = await apiClient.getThemeReplication(id);
    setReplications((current) => current.map((item) => item.id === id ? result.replication : item));
  };
  const createReplication = async () => {
    setBusy('replication-create'); setNotice('');
    try {
      const result = await apiClient.createThemeReplication({ ...replicationForm, ai_model_id: Number(replicationForm.ai_model_id), compliance_ack: true }, { idempotencyKey: key('theme-replication') });
      setReplications((current) => [result.replication, ...current]);
      setReplicationForm((current) => ({ ...current, name: '', theme_id: '' }));
      setNotice(zh ? '主题复制任务已创建并进入队列' : 'Theme replication queued');
    } catch (error) { setNotice(describeApiError(error, zh ? '主题复制创建失败' : 'Unable to create theme replication', lang)); }
    finally { setBusy(''); }
  };
  const replicationAction = async (item: ThemeReplicationRecord, action: 'retry' | 'publish' | 'archive' | 'delete-drafts') => {
    setBusy(`replication-${action}-${item.id}`); setNotice('');
    try {
      if (action === 'retry') await apiClient.retryThemeReplication(item.id, { idempotencyKey: key('theme-retry') });
      else await apiClient.actOnThemeReplication(item.id, action, { idempotencyKey: key(`theme-${action}`) });
      await refreshReplication(item.id);
      setNotice(zh ? '主题复制操作已完成' : 'Theme replication action completed');
    } catch (error) { setNotice(describeApiError(error, zh ? '主题复制操作失败' : 'Theme replication action failed', lang)); }
    finally { setBusy(''); }
  };
  const iterateReplication = async (item: ThemeReplicationRecord) => {
    const text = String(feedback[item.id] || '').trim();
    if (!text) return;
    setBusy(`replication-iterate-${item.id}`); setNotice('');
    try { await apiClient.iterateThemeReplication(item.id, text, { idempotencyKey: key('theme-iterate') }); setFeedback((current) => ({ ...current, [item.id]: '' })); await refreshReplication(item.id); setNotice(zh ? '迭代反馈已入队' : 'Iteration feedback queued'); }
    catch (error) { setNotice(describeApiError(error, zh ? '迭代提交失败' : 'Unable to submit iteration', lang)); }
    finally { setBusy(''); }
  };
  const downloadReplication = async (item: ThemeReplicationRecord) => {
    setBusy(`replication-download-${item.id}`); setNotice('');
    try { const blob = await apiClient.downloadThemeReplicationPackage(item.id); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${item.theme_id}.zip`; anchor.click(); URL.revokeObjectURL(url); }
    catch (error) { setNotice(describeApiError(error, zh ? '主题包下载失败' : 'Unable to download theme package', lang)); }
    finally { setBusy(''); }
  };
  const openPreview = async (item: ThemeReplicationRecord, page: 'home' | 'category' | 'article') => {
    setBusy(`replication-preview-${item.id}`); setNotice('');
    try { const blob = await apiClient.previewThemeReplication(item.id, page); const url = URL.createObjectURL(blob); window.open(url, '_blank', 'noopener,noreferrer'); window.setTimeout(() => URL.revokeObjectURL(url), 60_000); }
    catch (error) { setNotice(describeApiError(error, zh ? '预览加载失败' : 'Unable to load preview', lang)); }
    finally { setBusy(''); }
  };
  const copyReplication = async (item: ThemeReplicationRecord) => {
    const form = copyForm[item.id];
    if (!form?.name.trim() || !form.theme_id.trim()) return;
    setBusy(`replication-copy-${item.id}`); setNotice('');
    try { const result = await apiClient.copyThemeReplication(item.id, { name: form.name.trim(), theme_id: form.theme_id.trim() }, { idempotencyKey: key('theme-copy') }); setReplications((current) => [result.replication, ...current]); setNotice(zh ? '已复制为新主题' : 'Copied as a new theme'); }
    catch (error) { setNotice(describeApiError(error, zh ? '复制主题失败' : 'Unable to copy theme', lang)); }
    finally { setBusy(''); }
  };

  const updateSlide = (index: number, patch: Partial<CarouselSlide>) => setCarousel((current) => current.map((slide, position) => position === index ? { ...slide, ...patch } : slide));

  return <section className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-sm font-bold text-white"><Globe2 className="h-4 w-4 text-cyan-400" />{zh ? '站点与首页设置' : 'Site & Homepage'}</h2><p className="mt-1 text-xs text-slate-500">{zh ? '与 桐灼GEO 官网共用的真实站点配置、主题和首页编排。' : 'Real site settings, themes and homepage composition shared with 桐灼GEO.'}</p></div><button type="button" onClick={() => void load()} disabled={!canRead || busy === 'load'} className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 disabled:opacity-50"><RefreshCw className={busy === 'load' ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />{zh ? '刷新' : 'Refresh'}</button></div>
    {notice && <div role="status" className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200">{notice}</div>}
    {!canRead ? <PermissionNotice lang={lang} mode="read" requiredScope="seo:read" /> : <>
      {loading && Object.keys(settings).length === 0
        ? <LoadingState lang={lang} variant="panel" label={zh ? '正在读取站点设置…' : 'Loading site settings…'} />
        : <>
      <div className="grid gap-3 md:grid-cols-2">{[['site_name', zh ? '站点名称' : 'Site name'], ['site_subtitle', zh ? '副标题' : 'Subtitle'], ['site_keywords', zh ? '关键词' : 'Keywords'], ['copyright_info', zh ? '版权信息' : 'Copyright'], ['filing_info', zh ? '备案信息' : 'Filing info'], ['filing_url', zh ? '备案链接' : 'Filing URL'], ['site_logo', zh ? 'Logo URL' : 'Logo URL'], ['site_favicon', zh ? 'Favicon URL' : 'Favicon URL'], ['seo_title_template', zh ? 'SEO 标题模板' : 'SEO title template'], ['seo_description_template', zh ? 'SEO 描述模板' : 'SEO description template']].map(([field, label]) => <label key={field} className="text-xs text-slate-400">{label}<input value={String(draft[field as keyof typeof draft] || '')} disabled={!canWrite} onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white disabled:opacity-50" /></label>)}</div>
      <label className="block text-xs text-slate-400">{zh ? '站点描述' : 'Site description'}<textarea rows={3} value={draft.site_description} disabled={!canWrite} onChange={(event) => setDraft((current) => ({ ...current, site_description: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white disabled:opacity-50" /></label>
      {/* 公司实体：同一份事实同时供三处使用——首页/关于页（人看）、Organization 结构化数据（机器读）、
          llms.txt（AI 读）。填了这里，三个出口一起生效；不填则整段结构化数据不输出，不会产生空壳。 */}
      <div className="border-t border-slate-800 pt-4">
        <h3 className="text-xs font-bold text-white">{zh ? '公司实体信息' : 'Company profile'}</h3>
        <p className="mt-1 text-[11px] text-slate-500">
          {zh
            ? '这份信息会同时用于：首页与关于页、搜索引擎的 Organization 结构化数据、llms.txt。填了就有，不填不会输出空壳。'
            : 'Used by the homepage/about page, the Organization structured data and llms.txt.'}
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {[
            ['company_legal_name', zh ? '公司全称' : 'Legal name'],
            ['company_tagline', zh ? '一句话定位' : 'One-line positioning'],
            ['contact_email', zh ? '联系邮箱' : 'Contact email'],
            ['contact_phone', zh ? '联系电话' : 'Contact phone'],
            ['company_address', zh ? '公司地址' : 'Address'],
            ['company_founded', zh ? '成立日期（如 2025-09-19）' : 'Founding date'],
          ].map(([field, label]) => (
            <label key={field} className="text-xs text-slate-400">
              {label}
              <input
                value={String(draft[field as keyof typeof draft] || '')}
                disabled={!canWrite}
                onChange={(event) => setDraft((current) => ({ ...current, [field]: event.target.value }))}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white disabled:opacity-50"
              />
            </label>
          ))}
        </div>
        <label className="mt-3 block text-xs text-slate-400">
          {zh ? '服务清单（一行一项，格式：名称|一句话说明，最多 12 项）' : 'Services (one per line: name|description, max 12)'}
          <textarea
            rows={4}
            value={draft.company_services}
            disabled={!canWrite}
            onChange={(event) => setDraft((current) => ({ ...current, company_services: event.target.value }))}
            placeholder={zh ? 'GEO 优化|让企业信息能被搜索引擎与 AI 准确理解并引用' : 'GEO optimization|Make your business citable by search and AI'}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white disabled:opacity-50"
          />
        </label>
      </div>
      <div className="border-t border-slate-800 pt-4">
        <h3 className="text-xs font-bold text-white">{zh ? '关于页与服务页' : 'About & services pages'}</h3>
        <p className="mt-1 text-[11px] text-slate-500">
          {zh
            ? '这两页的正文此前写死在模板里（改一句话要动代码），现在收在这里。正文用 Markdown；单独一行写 {{services}} 表示「服务清单插在这里」，不写就不显示清单；全部留空则回落到系统内置文案。'
            : 'These pages used to be hard-coded. Body uses Markdown; a lone {{services}} line inserts the service list; leaving everything empty falls back to the built-in copy.'}
        </p>
        <label className="mt-3 block text-xs text-slate-400">
          {zh ? '关于页标题（留空显示「关于 站点名」）' : 'About page title'}
          <input
            value={draft.about_title}
            disabled={!canWrite}
            onChange={(event) => setDraft((current) => ({ ...current, about_title: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white disabled:opacity-50"
            placeholder={zh ? '关于 桐灼GEO' : 'About'}
          />
        </label>
        <label className="mt-3 block text-xs text-slate-400">
          {zh ? '关于页正文（Markdown）' : 'About page body (Markdown)'}
          <textarea
            rows={10}
            value={draft.about_content}
            disabled={!canWrite}
            onChange={(event) => setDraft((current) => ({ ...current, about_content: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white disabled:opacity-50"
            placeholder={zh ? '## 我们是谁\n\n……\n\n{{services}}\n\n## 怎么开始\n\n……' : '## Who we are'}
          />
        </label>
        <label className="mt-3 block text-xs text-slate-400">
          {zh ? '服务页标题（留空显示「我们提供的服务」）' : 'Services page title'}
          <input
            value={draft.company_services_title}
            disabled={!canWrite}
            onChange={(event) => setDraft((current) => ({ ...current, company_services_title: event.target.value }))}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white disabled:opacity-50"
            placeholder={zh ? '我们提供的服务' : 'Our services'}
          />
        </label>
      </div>
      <div className="border-t border-slate-800 pt-4">
        <h3 className="text-xs font-bold text-white">{zh ? '统计代码' : 'Analytics code'}</h3>
        <p className="mt-1 text-[11px] text-slate-500">{zh ? '整段注入公开页面的 <head>；只有超级管理员可以修改。' : 'Injected into the public <head>; only super administrators may change it.'}</p>
        {isSuperAdmin
          ? <textarea rows={4} value={draft.analytics_code} disabled={!canWrite} onChange={(event) => setDraft((current) => ({ ...current, analytics_code: event.target.value }))} placeholder={zh ? '留空表示不注入' : 'Leave empty to inject nothing'} className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white disabled:opacity-50" />
          : <p className="mt-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-500">{zh ? '当前账号不是超级管理员，此项只读且保存时不会提交。' : 'Read-only: your account is not a super administrator, so this value is never submitted.'}</p>}
      </div>

      <div className="border-t border-slate-800 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-xs font-bold text-white">{zh ? '首页轮播' : 'Home carousel'}</h3>
            <p className="mt-1 text-[11px] text-slate-500">{zh ? `最多 ${MAX_CAROUSEL_SLIDES} 屏；标题与图片同时为空的行由服务端丢弃。` : `Up to ${MAX_CAROUSEL_SLIDES} slides; the server drops rows with neither a title nor an image.`}</p>
          </div>
          {canWrite && carousel.length < MAX_CAROUSEL_SLIDES && <button type="button" onClick={() => setCarousel((current) => [...current, emptySlide()])} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200 disabled:opacity-50">+ {zh ? '添加一屏' : 'Add slide'}</button>}
        </div>
        <div className="mt-3 space-y-2">
          {carousel.length === 0
            ? <p className="rounded-lg border border-dashed border-slate-700 px-3 py-4 text-center text-[11px] text-slate-500">{zh ? '未配置轮播图' : 'No carousel slides configured'}</p>
            : carousel.map((slide, index) => (
              <div key={index} className="grid gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2 md:grid-cols-12">
                <input value={slide.image_url} disabled={!canWrite} onChange={(event) => updateSlide(index, { image_url: event.target.value })} placeholder={zh ? '图片 URL' : 'Image URL'} className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white disabled:opacity-50 md:col-span-4" />
                <input value={slide.title} disabled={!canWrite} onChange={(event) => updateSlide(index, { title: event.target.value })} placeholder={zh ? '标题' : 'Title'} className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white disabled:opacity-50 md:col-span-3" />
                <input value={slide.link_url} disabled={!canWrite} onChange={(event) => updateSlide(index, { link_url: event.target.value })} placeholder={zh ? '跳转链接' : 'Link URL'} className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white disabled:opacity-50 md:col-span-3" />
                <label className="flex items-center gap-1.5 text-[11px] text-slate-300 md:col-span-1"><input type="checkbox" checked={slide.enabled} disabled={!canWrite} onChange={(event) => updateSlide(index, { enabled: event.target.checked })} className="accent-cyan-500" />{zh ? '启用' : 'On'}</label>
                {canWrite && <button type="button" onClick={() => setCarousel((current) => current.filter((_, position) => position !== index))} className="rounded border border-red-500/30 px-2 py-1.5 text-[11px] text-red-200 md:col-span-1">{zh ? '删除' : 'Remove'}</button>}
              </div>
            ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void saveBase()} disabled={!canWrite || busy === 'base'} className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"><Save className="h-3.5 w-3.5" />{zh ? '保存站点信息' : 'Save site info'}</button>{!canWrite && <PermissionNotice lang={lang} requiredScope="seo:write" />}</div>
      <div className="border-t border-slate-800 pt-4"><h3 className="mb-3 flex items-center gap-2 text-xs font-bold text-white"><LayoutTemplate className="h-4 w-4 text-indigo-400" />{zh ? '当前主题' : 'Active theme'}</h3><div className="flex flex-wrap gap-2"><select value={theme} disabled={!canWrite} onChange={(event) => setTheme(event.target.value)} className="min-w-[240px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white disabled:opacity-50"><option value="">{zh ? '默认主题' : 'Default theme'}</option>{themes.map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.name || item.id)}</option>)}</select><button type="button" onClick={() => void saveTheme()} disabled={!canWrite || busy === 'theme'} className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"><Save className="h-3.5 w-3.5" />{zh ? '应用主题' : 'Apply theme'}</button></div></div>
      <div className="border-t border-slate-800 pt-4"><h3 className="mb-3 text-xs font-bold text-white">{zh ? '首页模块编排' : 'Homepage composition'}</h3><textarea rows={12} value={homepageJson} disabled={!canWrite} onChange={(event) => setHomepageJson(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white disabled:opacity-50" /><div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void saveHomepage()} disabled={!canWrite || busy === 'homepage'} className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"><Save className="h-3.5 w-3.5" />{zh ? '保存编排' : 'Save composition'}</button><button type="button" onClick={() => void importDesign()} disabled={!canWrite || busy === 'import'} className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 disabled:opacity-50"><WandSparkles className="h-3.5 w-3.5" />{zh ? '导入设计 JSON' : 'Import design JSON'}</button><select value={preset} disabled={!canWrite} onChange={(event) => setPreset(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white disabled:opacity-50"><option value="">{zh ? '选择首页预设' : 'Choose preset'}</option>{(Array.isArray(homepage.presets) ? homepage.presets : []).map((item) => <option key={String(item)} value={String(item)}>{String(item)}</option>)}</select><button type="button" onClick={() => void applyPreset()} disabled={!canWrite || !preset || busy === 'preset'} className="flex items-center gap-1.5 rounded-lg border border-indigo-500/40 px-3 py-2 text-xs text-indigo-200 disabled:opacity-50"><WandSparkles className="h-3.5 w-3.5" />{zh ? '套用预设' : 'Apply preset'}</button></div></div>
      {isSuperAdmin && <div className="border-t border-slate-800 pt-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="mb-1 flex items-center gap-2 text-xs font-bold text-white"><WandSparkles className="h-4 w-4 text-fuchsia-400" />{zh ? 'AI 主题复制' : 'AI theme replication'}</h3><p className="text-[11px] text-slate-500">{zh ? '复用 桐灼GEO 的抓取、生成、合规扫描、预览与发布队列。' : 'Uses 桐灼GEO fetch, generation, compliance, preview and publishing queues.'}</p></div><button type="button" onClick={() => void loadReplications()} disabled={busy === 'load-replications'} className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" />{zh ? '刷新任务' : 'Refresh tasks'}</button></div>
        <div className="mt-3 grid gap-2 md:grid-cols-2"><input placeholder={zh ? '任务名称' : 'Task name'} value={replicationForm.name} disabled={!canWrite} onChange={(event) => setReplicationForm((current) => ({ ...current, name: event.target.value }))} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white" /><input placeholder={zh ? '新主题 ID' : 'New theme ID'} value={replicationForm.theme_id} disabled={!canWrite} onChange={(event) => setReplicationForm((current) => ({ ...current, theme_id: event.target.value }))} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white" /><select value={replicationForm.ai_model_id} disabled={!canWrite} onChange={(event) => setReplicationForm((current) => ({ ...current, ai_model_id: event.target.value }))} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"><option value="">{zh ? '选择聊天模型' : 'Choose chat model'}</option>{replicationModels.map((model) => <option key={String(model.id)} value={String(model.id)}>{String(model.name || model.model_id)}</option>)}</select><select value={replicationForm.style_preference} disabled={!canWrite} onChange={(event) => setReplicationForm((current) => ({ ...current, style_preference: event.target.value }))} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"><option value="content_site">{zh ? '内容站' : 'Content site'}</option><option value="brand_site">{zh ? '品牌站' : 'Brand site'}</option><option value="news_site">{zh ? '新闻站' : 'News site'}</option></select><input type="url" placeholder="https://example.com/" value={replicationForm.home_url} disabled={!canWrite} onChange={(event) => setReplicationForm((current) => ({ ...current, home_url: event.target.value }))} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white" /><input type="url" placeholder="https://example.com/category" value={replicationForm.category_url} disabled={!canWrite} onChange={(event) => setReplicationForm((current) => ({ ...current, category_url: event.target.value }))} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white" /><input type="url" placeholder="https://example.com/article" value={replicationForm.article_url} disabled={!canWrite} onChange={(event) => setReplicationForm((current) => ({ ...current, article_url: event.target.value }))} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white md:col-span-2" /></div><button type="button" onClick={() => void createReplication()} disabled={!canWrite || busy === 'replication-create' || !replicationForm.name || !replicationForm.theme_id || !replicationForm.ai_model_id || !replicationForm.home_url || !replicationForm.category_url || !replicationForm.article_url} className="mt-2 flex items-center gap-1.5 rounded-lg bg-fuchsia-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"><Play className="h-3.5 w-3.5" />{zh ? '创建复制任务' : 'Create replication'}</button>
        <div className="mt-4 space-y-3">{replications.map((item) => { const status = String(item.status); const copy = copyForm[item.id] || { name: '', theme_id: '' }; return <div key={item.id} className="rounded-xl border border-slate-800 bg-slate-950/60 p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><div className="text-sm font-semibold text-white">{item.name} <span className="ml-2 rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">{status}</span></div><div className="mt-1 text-[11px] text-slate-500">{item.theme_id} · v{item.current_version || 0}{item.error_message ? ` · ${item.error_message}` : ''}</div></div><div className="flex flex-wrap gap-1.5">{status === 'failed' && <button type="button" onClick={() => void replicationAction(item, 'retry')} disabled={busy !== ''} title={zh ? '重试' : 'Retry'} className="rounded border border-amber-500/40 p-1.5 text-amber-200 disabled:opacity-50"><RotateCcw className="h-3.5 w-3.5" /></button>}{item.can_publish && <button type="button" onClick={() => void replicationAction(item, 'publish')} disabled={busy !== ''} title={zh ? '发布' : 'Publish'} className="rounded border border-emerald-500/40 p-1.5 text-emerald-200 disabled:opacity-50"><Play className="h-3.5 w-3.5" /></button>}{item.can_package && <button type="button" onClick={() => void downloadReplication(item)} disabled={busy !== ''} title={zh ? '下载主题包' : 'Download package'} className="rounded border border-cyan-500/40 p-1.5 text-cyan-200 disabled:opacity-50"><Download className="h-3.5 w-3.5" /></button>}{item.can_archive && <button type="button" onClick={() => void replicationAction(item, 'archive')} disabled={busy !== ''} title={zh ? '归档' : 'Archive'} className="rounded border border-slate-700 p-1.5 text-slate-300 disabled:opacity-50"><Archive className="h-3.5 w-3.5" /></button>}{item.can_delete_drafts && <button type="button" onClick={() => void replicationAction(item, 'delete-drafts')} disabled={busy !== ''} title={zh ? '删除草稿文件' : 'Delete drafts'} className="rounded border border-red-500/40 p-1.5 text-red-200 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /></button>}</div></div>{item.progress && <div className="mt-2 text-[11px] text-slate-400">{String((item.progress as ApiRecord).current_step_label || '')} · {String((item.progress as ApiRecord).progress_percent || 0)}%</div>} {(status === 'ready' || status === 'published') && <><div className="mt-2 flex flex-wrap gap-1.5">{(['home', 'category', 'article'] as const).map((page) => <button key={page} type="button" onClick={() => void openPreview(item, page)} disabled={busy !== ''} title={zh ? `预览 ${page}` : `Preview ${page}`} className="flex items-center gap-1 rounded border border-indigo-500/40 px-2 py-1 text-[11px] text-indigo-200 disabled:opacity-50"><ExternalLink className="h-3 w-3" />{page}</button>)}</div><div className="mt-2 flex flex-wrap gap-1.5"><input placeholder={zh ? '迭代反馈' : 'Iteration feedback'} value={feedback[item.id] || ''} onChange={(event) => setFeedback((current) => ({ ...current, [item.id]: event.target.value }))} className="min-w-[220px] flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-white" /><button type="button" onClick={() => void iterateReplication(item)} disabled={busy !== '' || !String(feedback[item.id] || '').trim()} className="rounded border border-fuchsia-500/40 px-2 py-1 text-[11px] text-fuchsia-200 disabled:opacity-50">{zh ? '提交迭代' : 'Iterate'}</button></div><div className="mt-2 flex flex-wrap gap-1.5"><input placeholder={zh ? '复制名称' : 'Copy name'} value={copy.name} onChange={(event) => setCopyForm((current) => ({ ...current, [item.id]: { ...copy, name: event.target.value } }))} className="min-w-[150px] rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-white" /><input placeholder={zh ? '复制主题 ID' : 'Copy theme ID'} value={copy.theme_id} onChange={(event) => setCopyForm((current) => ({ ...current, [item.id]: { ...copy, theme_id: event.target.value } }))} className="min-w-[150px] rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-white" /><button type="button" onClick={() => void copyReplication(item)} disabled={busy !== '' || !copy.name.trim() || !copy.theme_id.trim()} className="flex items-center gap-1 rounded border border-cyan-500/40 px-2 py-1 text-[11px] text-cyan-200 disabled:opacity-50"><Copy className="h-3 w-3" />{zh ? '复制为新主题' : 'Copy theme'}</button></div></>}</div>; })}</div>
      </div>}

      </>}
      {/* 敏感词规则是文章质检的真实输入，单独一块；写操作另有超管边界。 */}
      <div className="border-t border-slate-800 pt-4">
        <SensitiveWordsPanel apiClient={apiClient} lang={lang} canRead={canRead} canWrite={canWrite} isSuperAdmin={isSuperAdmin} />
      </div>
    </>}
  </section>;
}
