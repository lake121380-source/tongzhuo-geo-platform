import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Eye,
  Globe2,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Tag,
} from 'lucide-react';
import { Article, Category } from '../types';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';

interface SitePreviewViewProps {
  articles: Article[];
  categories: Category[];
  onSelectArticle: (article: Article) => void;
  lang: 'zh' | 'en';
  apiMode?: boolean;
  apiClient?: GeoFlowApiClient;
}

type PreviewPage = 'home' | 'category' | 'article';

interface PreviewSite {
  id: number | null;
  type: 'primary' | 'hosted' | string;
  name: string;
  subtitle?: string;
  description?: string;
  base_url?: string;
  home_url?: string;
  hostname?: string;
  theme?: { id?: string; name?: string; version?: string };
  serving_status?: string;
  indexing_status?: string;
  quality_status?: string;
  channel_status?: string;
  topic?: string;
  locale?: string;
  settings_version?: number | null;
}

interface PreviewArticle {
  id?: number;
  title?: string;
  slug?: string;
  summary?: string;
  body?: string;
  body_format?: string;
  body_truncated?: boolean;
  url?: string;
  category?: { id?: number; name?: string; slug?: string } | null;
  author?: { id?: number; name?: string } | null;
  keywords?: string[];
  view_count?: number;
  is_featured?: boolean;
  is_hot?: boolean;
  published_at?: string | null;
  updated_at?: string | null;
}

interface PreviewError {
  code?: string;
  message?: string;
  severity?: string;
}

interface PreviewProjection extends ApiRecord {
  preview?: {
    source_version?: string;
    generated_at?: string;
    settings_updated_at?: string | null;
    content_updated_at?: string | null;
    dataset?: string;
    read_only?: boolean;
    errors?: PreviewError[];
  };
  page?: { type?: PreviewPage; category_id?: number | null; article_id?: number | null; limit?: number };
  site?: PreviewSite;
  navigation?: { categories?: Array<ApiRecord> };
  content?: {
    title?: string;
    total?: number;
    category?: ApiRecord | null;
    items?: Array<ApiRecord>;
    article?: ApiRecord | null;
    related_items?: Array<ApiRecord>;
  };
  available_sites?: Array<ApiRecord>;
}

function text(value: unknown, fallback = ''): string {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function record(value: unknown): ApiRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
}

function formatDate(value: unknown, lang: 'zh' | 'en'): string {
  const raw = text(value);
  if (!raw) return '—';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function statusLabel(value: unknown, lang: 'zh' | 'en'): string {
  const status = text(value).toLowerCase();
  const labels: Record<string, [string, string]> = {
    online: ['在线', 'Online'],
    maintenance: ['维护中', 'Maintenance'],
    archived: ['已归档', 'Archived'],
    index: ['允许索引', 'Indexable'],
    noindex: ['禁止索引', 'No index'],
    passed: ['质量通过', 'Quality passed'],
    pending: ['待质检', 'Quality pending'],
    blocked: ['质量阻断', 'Quality blocked'],
    active: ['渠道启用', 'Channel active'],
    paused: ['渠道暂停', 'Channel paused'],
  };
  return labels[status]?.[lang === 'zh' ? 0 : 1] || (status || '—');
}

function severityClass(severity: string): string {
  return severity === 'error'
    ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
    : 'border-amber-500/40 bg-amber-500/10 text-amber-100';
}

export const SitePreviewView: React.FC<SitePreviewViewProps> = ({
  articles,
  categories,
  onSelectArticle,
  lang,
  apiMode = false,
  apiClient,
}) => {
  const [page, setPage] = useState<PreviewPage>('home');
  const [categoryId, setCategoryId] = useState<number | undefined>();
  const [articleId, setArticleId] = useState<number | undefined>();
  const [selectedSiteId, setSelectedSiteId] = useState<number | undefined>();
  const [projection, setProjection] = useState<PreviewProjection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!apiMode || !apiClient) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    const params: {
      page: PreviewPage;
      category_id?: number;
      article_id?: number;
      hosted_site_id?: number;
      limit: number;
    } = { page, limit: 12 };
    if (categoryId) params.category_id = categoryId;
    if (articleId) params.article_id = articleId;
    if (selectedSiteId) params.hosted_site_id = selectedSiteId;
    void apiClient.getSitePreview(params)
      .then((data) => {
        if (!cancelled) setProjection(data as PreviewProjection);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : (lang === 'zh' ? '读取站点预览失败' : 'Unable to load site preview'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [apiClient, apiMode, articleId, categoryId, lang, page, reloadKey, selectedSiteId]);

  const site = (projection?.site || {}) as PreviewSite;
  const previewMeta = projection?.preview || {};
  const content = projection?.content || {};
  const contentItems = useMemo(() => (Array.isArray(content.items) ? content.items : []).map(record), [content.items]);
  const relatedItems = useMemo(() => (Array.isArray(content.related_items) ? content.related_items : []).map(record), [content.related_items]);
  const navCategories = useMemo(() => (Array.isArray(projection?.navigation?.categories) ? projection.navigation.categories : []).map(record), [projection?.navigation?.categories]);
  const availableSites = useMemo(() => (Array.isArray(projection?.available_sites) ? projection.available_sites : []).map(record), [projection?.available_sites]);
  const previewErrors = Array.isArray(previewMeta.errors) ? previewMeta.errors : [];
  const articleDetail = content.article ? record(content.article) as PreviewArticle : null;

  const openCategory = (nextId?: number) => {
    setArticleId(undefined);
    setCategoryId(nextId);
    setPage(nextId ? 'category' : 'home');
  };

  const openArticle = (item: ApiRecord) => {
    const id = number(item.id);
    if (!id || !apiMode) {
      const fallback = articles.find((candidate) => candidate.id === String(id));
      if (fallback) onSelectArticle(fallback);
      return;
    }
    setCategoryId(undefined);
    setArticleId(id);
    setPage('article');
  };

  const selectedSiteLabel = selectedSiteId
    ? availableSites.find((item) => number(item.id) === selectedSiteId)
    : availableSites.find((item) => item.id === null || item.id === undefined);

  if (!apiMode) {
    const published = articles.filter((article) => article.status === 'published');
    const fallbackItems = categoryId
      ? published.filter((article) => article.category === categories.find((candidate) => candidate.id === String(categoryId))?.name)
      : published;
    return (
      <div className="space-y-6">
        <PreviewHeader lang={lang} site={{ id: null, name: '站点预览', type: 'primary' }} />
        <PreviewShell lang={lang} site={{ id: null, name: '站点预览', type: 'primary' }} themeId="local" pageTitle="最新发布" total={fallbackItems.length}>
          <div className="space-y-3">
            {fallbackItems.map((article) => (
              <PreviewArticleCard
                key={article.id}
                item={{
                  ...article,
                  id: Number(article.id),
                  summary: article.summary,
                  category: { name: article.category },
                  author: { name: article.author },
                  keywords: article.seoKeywords,
                  view_count: article.views,
                  published_at: article.createdAt,
                }}
                onOpen={(item) => onSelectArticle(articleFromFallback(item, article))}
                lang={lang}
              />
            ))}
            {fallbackItems.length === 0 && <EmptyState lang={lang} />}
          </div>
        </PreviewShell>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PreviewHeader
        lang={lang}
        site={site}
        loading={loading}
        onReload={() => setReloadKey((value) => value + 1)}
        homeUrl={site.home_url || site.base_url}
      />

      <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex min-w-0 items-center gap-2 text-xs text-slate-300">
          <Globe2 className="h-4 w-4 shrink-0 text-indigo-300" />
          <span className="shrink-0">{lang === 'zh' ? '预览站点' : 'Preview site'}</span>
          <select
            value={selectedSiteId ? String(selectedSiteId) : ''}
            onChange={(event) => {
              const value = Number(event.target.value);
              setSelectedSiteId(Number.isInteger(value) && value > 0 ? value : undefined);
              setPage('home');
              setCategoryId(undefined);
              setArticleId(undefined);
            }}
            className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-xs text-white outline-none focus:border-indigo-400"
          >
            {availableSites.length === 0 && <option value="">{lang === 'zh' ? '正在读取…' : 'Loading…'}</option>}
            {availableSites.map((item) => (
              <option key={item.id == null ? 'primary' : String(item.id)} value={item.id == null ? '' : String(item.id)}>
                {text(item.name, text(item.hostname, item.type === 'hosted' ? 'Hosted Site' : '主站'))} · {text(item.hostname)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          {selectedSiteLabel && <span>{text(selectedSiteLabel.hostname)}</span>}
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-200">{lang === 'zh' ? '只读 · 已发布数据' : 'Read-only · published data'}</span>
        </div>
      </div>

      {error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
      {previewErrors.map((item, index) => (
        <div key={`${text(item.code)}-${index}`} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${severityClass(text(item.severity))}`}>
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{text(item.message, text(item.code, lang === 'zh' ? '站点状态需要注意' : 'Site status needs attention'))}</span>
        </div>
      ))}

      {loading && !projection ? (
        <div className="flex min-h-64 items-center justify-center rounded-2xl border border-slate-800 bg-slate-950/80 text-sm text-slate-400"><Loader2 className="mr-2 h-5 w-5 animate-spin" />{lang === 'zh' ? '正在读取真实站点数据…' : 'Loading published site data…'}</div>
      ) : (
        <PreviewShell
          lang={lang}
          site={site}
          themeId={text(site.theme?.id, 'default')}
          pageTitle={text(content.title, page === 'article' ? text(articleDetail?.title, '文章') : '最新发布')}
          total={number(content.total, contentItems.length)}
          page={page}
          onBack={() => openCategory()}
          updatedAt={previewMeta.content_updated_at || previewMeta.generated_at}
          sourceVersion={previewMeta.source_version}
          navCategories={navCategories}
          categoryId={categoryId}
          onCategory={openCategory}
        >
          {page === 'article' && articleDetail ? (
            <PreviewArticleDetail item={articleDetail} siteName={site.name} lang={lang} onOpen={openArticle} relatedItems={relatedItems} onBack={() => openCategory()} />
          ) : (
            <div className="space-y-3">
              {contentItems.map((item) => <PreviewArticleCard key={String(item.id)} item={item} onOpen={openArticle} lang={lang} />)}
              {contentItems.length === 0 && <EmptyState lang={lang} />}
            </div>
          )}
        </PreviewShell>
      )}
    </div>
  );
};

function articleFromFallback(item: ApiRecord, fallback: Article): Article {
  return { ...fallback, id: String(number(item.id, Number(fallback.id))) };
}

interface PreviewHeaderProps {
  lang: 'zh' | 'en';
  site: PreviewSite;
  loading?: boolean;
  onReload?: () => void;
  homeUrl?: string;
}

const PreviewHeader: React.FC<PreviewHeaderProps> = ({ lang, site, loading = false, onReload, homeUrl }) => (
  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
    <div>
      <h1 className="flex items-center gap-2 text-xl font-black text-white sm:text-2xl"><Eye className="h-6 w-6 text-indigo-300" />{lang === 'zh' ? '公开站点前台实时预览' : 'Public site preview'}</h1>
      <p className="mt-1 text-xs text-slate-400">{lang === 'zh' ? '预览后端当前公开发布的数据、主题和站点状态，不使用本地演示文章。' : 'Preview the published backend projection, theme and site status without demo content.'}</p>
    </div>
    <div className="flex items-center gap-2">
      {homeUrl && <a href={homeUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-slate-800"><ExternalLink className="h-3.5 w-3.5" />{lang === 'zh' ? '打开线上站点' : 'Open live site'}</a>}
      {onReload && <button onClick={onReload} disabled={loading} className="flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />{lang === 'zh' ? '刷新' : 'Refresh'}</button>}
    </div>
  </div>
);

interface PreviewShellProps {
  lang: 'zh' | 'en';
  site: PreviewSite;
  themeId: string;
  pageTitle: string;
  total: number;
  children: React.ReactNode;
  page?: PreviewPage;
  onBack?: () => void;
  updatedAt?: unknown;
  sourceVersion?: string;
  navCategories?: ApiRecord[];
  categoryId?: number;
  onCategory?: (id?: number) => void;
}

const PreviewShell: React.FC<PreviewShellProps> = ({ lang, site, themeId, pageTitle, total, children, page = 'home', onBack, updatedAt, sourceVersion, navCategories = [], categoryId, onCategory }) => {
  const initials = text(site.name, 'G').slice(0, 1).toUpperCase();
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 text-slate-100 shadow-2xl">
      <header className="border-b border-slate-800 bg-slate-900/95 px-4 py-4 sm:px-7">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-lg font-black text-white">{initials}</div>
          <div className="min-w-0"><div className="truncate text-base font-black text-white">{text(site.name, lang === 'zh' ? '未命名站点' : 'Unnamed site')}</div><div className="truncate text-[11px] text-slate-400">{text(site.subtitle, text(site.hostname))}</div></div>
          <div className="ml-auto hidden items-center gap-1.5 text-[10px] text-slate-500 sm:flex"><span className="rounded border border-slate-700 px-1.5 py-0.5">{text(site.theme?.name, themeId)}</span>{site.theme?.version && <span>v{site.theme.version}</span>}</div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button onClick={() => onCategory?.()} className={`rounded-full px-3 py-1 text-xs font-semibold ${page === 'home' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}>{lang === 'zh' ? '最新发布' : 'Latest'}</button>
          {navCategories.map((item) => {
            const id = number(item.id);
            return <button key={String(item.id)} onClick={() => onCategory?.(id)} className={`rounded-full px-3 py-1 text-xs font-semibold ${categoryId === id ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'}`}>{text(item.name, `#${id}`)}</button>;
          })}
        </div>
      </header>
      <div className="grid grid-cols-1 gap-6 p-4 sm:p-7 lg:grid-cols-[minmax(0,1fr)_260px]">
        <main className="min-w-0">
          {page === 'article' && onBack && <button onClick={onBack} className="mb-3 flex items-center gap-1 text-xs font-semibold text-indigo-300 hover:text-indigo-200"><ArrowLeft className="h-3.5 w-3.5" />{lang === 'zh' ? '返回文章列表' : 'Back to articles'}</button>}
          <div className="mb-4 flex items-end justify-between border-b border-slate-800 pb-2"><div><div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{text(site.topic, lang === 'zh' ? '公开内容' : 'Public content')}</div><h2 className="mt-1 text-lg font-black text-white">{pageTitle}</h2></div><span className="text-xs text-slate-500">{total} {lang === 'zh' ? '篇' : 'items'}</span></div>
          {children}
        </main>
        <aside className="space-y-3">
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4"><div className="mb-3 flex items-center gap-2 text-xs font-bold text-white"><CheckCircle2 className="h-4 w-4 text-emerald-300" />{lang === 'zh' ? '站点状态' : 'Site status'}</div><div className="space-y-2 text-[11px] text-slate-400"><StatusRow label={lang === 'zh' ? '服务' : 'Serving'} value={statusLabel(site.serving_status, lang)} /><StatusRow label={lang === 'zh' ? '索引' : 'Indexing'} value={statusLabel(site.indexing_status, lang)} /><StatusRow label={lang === 'zh' ? '质量' : 'Quality'} value={statusLabel(site.quality_status, lang)} />{site.channel_status && <StatusRow label={lang === 'zh' ? '渠道' : 'Channel'} value={statusLabel(site.channel_status, lang)} />}</div></div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-[11px] text-slate-500"><div className="mb-2 flex items-center gap-2 font-semibold text-slate-300"><Clock3 className="h-3.5 w-3.5" />{lang === 'zh' ? '数据版本' : 'Data version'}</div><div>{lang === 'zh' ? '内容更新时间：' : 'Content updated: '}{formatDate(updatedAt, lang)}</div>{sourceVersion && <div className="mt-1 break-all font-mono text-[9px] text-slate-600">{sourceVersion}</div>}<div className="mt-2 flex items-center gap-1 text-emerald-300"><ShieldAlert className="h-3.5 w-3.5" />{lang === 'zh' ? '只读公开数据' : 'Read-only published data'}</div></div>
        </aside>
      </div>
    </div>
  );
};

const StatusRow: React.FC<{ label: string; value: string }> = ({ label, value }) => <div className="flex items-center justify-between gap-2"><span>{label}</span><span className="font-semibold text-slate-300">{value}</span></div>;

const PreviewArticleCard: React.FC<{ item: PreviewArticle | ApiRecord; lang: 'zh' | 'en'; onOpen: (item: ApiRecord) => void; }> = ({ item, lang, onOpen }) => {
  const normalized = item as PreviewArticle;
  const title = text(normalized.title, '未命名文章');
  const summary = text(normalized.summary);
  const categoryName = text(normalized.category?.name, '未分类');
  const authorName = text(normalized.author?.name, '未署名');
  const keywords = Array.isArray(normalized.keywords) ? normalized.keywords : [];
  return (
    <article className="group cursor-pointer rounded-xl border border-slate-800 bg-slate-900/40 p-4 transition hover:border-indigo-500/50 hover:bg-slate-900" onClick={() => onOpen(record(item))}>
      <div className="flex items-center gap-2 text-[11px] text-slate-500"><span className="rounded bg-indigo-500/15 px-2 py-0.5 font-semibold text-indigo-200">{categoryName}</span><span>{authorName}</span><span>·</span><span>{formatDate(normalized.published_at || normalized.updated_at, lang)}</span></div>
      <h3 className="mt-2 line-clamp-2 text-base font-bold leading-snug text-white group-hover:text-indigo-200">{title}</h3>
      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-400">{summary || (lang === 'zh' ? '暂无摘要' : 'No summary')}</p>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-800 pt-2"><div className="flex min-w-0 gap-1 overflow-hidden">{keywords.slice(0, 3).map((keyword) => <span key={String(keyword)} className="flex items-center gap-0.5 whitespace-nowrap rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400"><Tag className="h-2.5 w-2.5" />{String(keyword)}</span>)}</div><span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold text-indigo-300">{lang === 'zh' ? '查看' : 'Open'}<ArrowRight className="h-3.5 w-3.5" /></span></div>
    </article>
  );
};

const PreviewArticleDetail: React.FC<{ item: PreviewArticle; siteName: string; lang: 'zh' | 'en'; onOpen: (item: ApiRecord) => void; relatedItems: ApiRecord[]; onBack: () => void; }> = ({ item, siteName, lang, onOpen, relatedItems, onBack }) => (
  <article>
    <div className="mb-5 flex items-center gap-2 text-[11px] text-slate-500"><BookOpen className="h-4 w-4 text-indigo-300" />{text(item.category?.name, lang === 'zh' ? '文章' : 'Article')} · {text(item.author?.name, lang === 'zh' ? '未署名' : 'Unknown author')} · {formatDate(item.published_at, lang)}</div>
    <h1 className="text-2xl font-black leading-tight text-white">{text(item.title, '未命名文章')}</h1>
    <p className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm leading-relaxed text-slate-300">{text(item.summary, lang === 'zh' ? '暂无摘要' : 'No summary')}</p>
    <div className="mt-5 whitespace-pre-wrap break-words rounded-xl border border-slate-800 bg-slate-950/80 p-5 text-sm leading-7 text-slate-200">{text(item.body, text(item.summary))}</div>
    {item.body_truncated && <div className="mt-2 text-[11px] text-amber-200">{lang === 'zh' ? '正文已按预览上限截断。' : 'The body was truncated to the preview limit.'}</div>}
    <div className="mt-5 flex flex-wrap items-center gap-2 text-xs text-slate-500"><span>{siteName}</span><span>·</span><span>{number(item.view_count)} {lang === 'zh' ? '阅读' : 'views'}</span>{Array.isArray(item.keywords) && item.keywords.slice(0, 5).map((keyword) => <span key={String(keyword)} className="rounded bg-slate-800 px-2 py-1 text-slate-400">#{String(keyword)}</span>)}</div>
    {relatedItems.length > 0 && <div className="mt-8 border-t border-slate-800 pt-4"><div className="mb-3 text-xs font-bold text-slate-300">{lang === 'zh' ? '同类文章' : 'Related articles'}</div><div className="space-y-2">{relatedItems.map((related) => <button key={String(related.id)} onClick={() => onOpen(related)} className="flex w-full items-center justify-between rounded-lg border border-slate-800 px-3 py-2 text-left text-xs text-slate-300 hover:border-indigo-500/50 hover:text-indigo-200"><span className="line-clamp-1">{text(related.title)}</span><ArrowRight className="h-3.5 w-3.5 shrink-0" /></button>)}</div></div>}
    <button onClick={onBack} className="mt-5 flex items-center gap-1 text-xs font-semibold text-indigo-300 hover:text-indigo-200"><ArrowLeft className="h-3.5 w-3.5" />{lang === 'zh' ? '返回列表' : 'Back to list'}</button>
  </article>
);

const EmptyState: React.FC<{ lang: 'zh' | 'en' }> = ({ lang }) => <div className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 text-center text-xs text-slate-500"><BookOpen className="mb-2 h-5 w-5 text-slate-600" />{lang === 'zh' ? '当前站点没有可公开预览的文章。' : 'No published articles are available for this site.'}</div>;
