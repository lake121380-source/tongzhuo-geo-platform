import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Compass,
  Database,
  FileText,
  Link2,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Article } from '../types';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { PermissionNotice } from './PermissionNotice';

interface QueryRadarViewProps {
  lang: 'zh' | 'en';
  onArticleCreated?: (newArticle: Article) => void;
  onOpenArticleModal?: (article: Article) => void;
  apiClient?: GeoFlowApiClient;
  canRead?: boolean;
  canCollect?: boolean;
  canDraft?: boolean;
  categories?: ApiRecord[];
  authors?: ApiRecord[];
}

interface QueryRadarItem extends ApiRecord {
  id: string;
  keyword_id: number;
  query: string;
  sample: ApiRecord;
  observations: ApiRecord;
  providers: ApiRecord[];
  citations: ApiRecord;
  mentions: ApiRecord;
  latest_answer: ApiRecord | null;
  draft: ApiRecord | null;
  status: string;
  draft_ready: boolean;
}

function record(value: unknown): ApiRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
}

function records(value: unknown): ApiRecord[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') as ApiRecord[] : [];
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateText(value: unknown, lang: 'zh' | 'en'): string {
  if (!value) return '—';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US');
}

function idempotencyKey(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function statusText(status: string, lang: 'zh' | 'en'): string {
  const labels: Record<string, [string, string]> = {
    not_collected: ['未采集', 'Not collected'],
    collection_failed: ['采集失败', 'Collection failed'],
    collected: ['已采集', 'Collected'],
    drafted: ['已有证据草稿', 'Evidence draft created'],
    published: ['草稿已发布', 'Draft published'],
  };
  const label = labels[status] || [status || '未知', status || 'Unknown'];
  return lang === 'zh' ? label[0] : label[1];
}

export const QueryRadarView: React.FC<QueryRadarViewProps> = ({
  lang,
  onArticleCreated,
  onOpenArticleModal,
  apiClient,
  canRead = false,
  canCollect = false,
  canDraft = false,
  categories = [],
  authors = [],
}) => {
  const [queries, setQueries] = useState<QueryRadarItem[]>([]);
  const [summary, setSummary] = useState<ApiRecord>({});
  const [windowData, setWindowData] = useState<ApiRecord>({});
  const [ownership, setOwnership] = useState<ApiRecord>({});
  const [brand, setBrand] = useState<ApiRecord>({});
  const [definitions, setDefinitions] = useState<ApiRecord>({});
  const [days, setDays] = useState(30);
  const [searchFilter, setSearchFilter] = useState('');
  const [busyId, setBusyId] = useState('');
  const [loading, setLoading] = useState(false);
  const [toastMsg, setToastMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [draftCategoryId, setDraftCategoryId] = useState('');
  const [draftAuthorId, setDraftAuthorId] = useState('');
  const requestSequence = useRef(0);

  const load = useCallback(async () => {
    if (!apiClient || !canRead) return;
    const sequence = ++requestSequence.current;
    setLoading(true);
    setErrorMsg('');
    try {
      const data = record(await apiClient.getQueryRadar({ days }));
      if (sequence !== requestSequence.current) return;
      const rows = records(data.items).map((item) => ({
        ...item,
        id: String(item.id || ''),
        keyword_id: numberValue(item.keyword_id),
        query: String(item.query || ''),
        sample: record(item.sample),
        observations: record(item.observations),
        providers: records(item.providers),
        citations: record(item.citations),
        latest_answer: Object.keys(record(item.latest_answer)).length > 0 ? record(item.latest_answer) : null,
        draft: Object.keys(record(item.draft)).length > 0 ? record(item.draft) : null,
        // The projection returns `mentions` per row; dropping it here made the
        // brand-mention-rate card read "不可计算" even when the server had data.
        mentions: record(item.mentions),
        status: String(item.status || 'not_collected'),
        draft_ready: item.draft_ready === true,
      }));
      setQueries(rows);
      setSummary(record(data.summary));
      setWindowData(record(data.window));
      setOwnership(record(data.ownership));
      setBrand(record(data.brand));
      setDefinitions(record(data.definitions));
    } catch (error) {
      if (sequence === requestSequence.current) {
        setErrorMsg(error instanceof Error ? error.message : (lang === 'zh' ? '查询雷达加载失败' : 'Failed to load query observations'));
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [apiClient, canRead, days, lang]);

  useEffect(() => {
    void load();
  }, [load]);

  const showToast = (message: string) => {
    setToastMsg(message);
    globalThis.setTimeout(() => setToastMsg(''), 3500);
  };

  const collectQuery = async (item: QueryRadarItem) => {
    if (!apiClient || !canCollect) return;
    setBusyId(`collect-${item.id}`);
    setErrorMsg('');
    try {
      const result = record(await apiClient.collectQueryRadar({
        query: item.query,
        keyword_id: item.keyword_id,
      }, { idempotencyKey: idempotencyKey('query-radar-collect') }));
      const runs = records(result.runs);
      showToast(lang === 'zh' ? `真实采集完成，已保存 ${runs.length} 条运行记录。` : `Collection completed and persisted ${runs.length} run(s).`);
      await load();
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : (lang === 'zh' ? '问题采集失败' : 'Query collection failed'));
    } finally {
      setBusyId('');
    }
  };

  const generateDraft = async (item: QueryRadarItem) => {
    if (!apiClient || !canDraft || !item.draft_ready) return;
    setBusyId(`draft-${item.id}`);
    setErrorMsg('');
    try {
      const result = record(await apiClient.generateQueryRadarDraft({
        query: item.query,
        keyword_id: item.keyword_id,
        category_id: Number(draftCategoryId),
        author_id: Number(draftAuthorId),
        days,
      }, { idempotencyKey: idempotencyKey('query-radar-draft') }));
      const article = record(result.article) as unknown as Article;
      if (article && onArticleCreated) onArticleCreated(article);
      showToast(lang === 'zh' ? '已生成带运行记录与引用快照的待审核草稿。' : 'An evidence-linked review draft was created.');
      await load();
      if (article && onOpenArticleModal) onOpenArticleModal(article);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : (lang === 'zh' ? '证据草稿生成失败' : 'Failed to create evidence draft'));
    } finally {
      setBusyId('');
    }
  };

  if (!apiClient) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center text-sm text-slate-300">
        {lang === 'zh' ? '查询雷达只在 桐灼GEO API 模式下可用，不加载演示问题或固定指标。' : 'Query Radar requires 桐灼GEO API mode. Demo queries and fixed metrics are disabled.'}
      </div>
    );
  }

  if (!canRead) {
    return <PermissionNotice lang={lang} mode="read" requiredScope="analytics:read" />;
  }

  const filteredQueries = queries.filter((item) => {
    const needle = searchFilter.trim().toLocaleLowerCase();
    if (!needle) return true;
    const providerText = item.providers.map((provider) => `${provider.provider_key || ''} ${provider.model_id || ''}`).join(' ');
    return `${item.query} ${item.sample.library_name || ''} ${providerText}`.toLocaleLowerCase().includes(needle);
  });

  return (
    <div className="space-y-6" id="query-radar-container">
      {toastMsg && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg border border-emerald-800 bg-emerald-950 px-4 py-3 text-sm text-emerald-200 shadow-lg">
          <CheckCircle2 className="h-4 w-4" />{toastMsg}
        </div>
      )}

      <section className="rounded-2xl border border-slate-800 bg-slate-900/90 p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-md border border-indigo-800/50 bg-indigo-950/60 px-2.5 py-1 text-xs font-semibold text-indigo-300">
              <Compass className="h-3.5 w-3.5" />{lang === 'zh' ? '查询采集与引用账本' : 'Query collection and citation ledger'}
            </div>
            <h2 className="mt-3 text-xl font-bold text-white">{lang === 'zh' ? '查询雷达' : 'Query Radar'}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              {lang === 'zh'
                ? '问题来自 桐灼GEO 关键词库；运行、模型、回答和引用来自真实 AI 可见性采集，品牌提及率按已配置的品牌名称在回答文本中匹配，未配置时不可计算。未接入外部问题量时不显示搜索热度，也不计算公式化机会指数。'
                : 'Queries come from the 桐灼GEO keyword library. Runs, models, answers and citations come from persisted AI visibility collection; brand mention rate matches the configured brand names in answer text and stays unavailable until configured. External volume and formula-based opportunity scores are not fabricated.'}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              [lang === 'zh' ? '问题样本' : 'Queries', summary.configured_query_count],
              [lang === 'zh' ? '已观察问题' : 'Observed', summary.observed_query_count],
              [lang === 'zh' ? '完成运行' : 'Completed', summary.completed_run_count],
              [lang === 'zh' ? '引用记录' : 'Citations', summary.citation_observation_count],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-center">
                <div className="text-[10px] text-slate-500">{String(label)}</div>
                <div className="mt-1 text-lg font-bold text-white">{numberValue(value)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {ownership.configured !== true && (
        <div className="flex gap-3 rounded-xl border border-amber-800/60 bg-amber-950/30 p-4 text-xs leading-5 text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{lang === 'zh' ? '尚未配置可核验的正式域名，因此“自有引用份额”显示不可计算；请先在品牌/站点配置中设置正式域名。' : 'No verifiable owned hostname is configured, so owned citation share is unavailable.'}</span>
        </div>
      )}

      {brand.configured !== true && (
        <div className="flex gap-3 rounded-xl border border-amber-800/60 bg-amber-950/30 p-4 text-xs leading-5 text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{lang === 'zh' ? '尚未配置品牌实体名称，因此“品牌提及率”显示不可计算；系统不会用内置默认名代替你的品牌名做匹配，请先在品牌实体中填写组织名称。' : 'No brand name is configured, so brand mention rate is unavailable. The built-in default name is never used as your brand.'}</span>
        </div>
      )}

      {errorMsg && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-rose-800 bg-rose-950/40 px-4 py-3 text-xs text-rose-200">
          <span>{errorMsg}</span>
          <button type="button" onClick={() => void load()} className="rounded-md border border-rose-700 px-3 py-1.5 font-semibold">{lang === 'zh' ? '重试' : 'Retry'}</button>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-md">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
          <input value={searchFilter} onChange={(event) => setSearchFilter(event.target.value)} placeholder={lang === 'zh' ? '筛选问题、词库、Provider 或模型…' : 'Filter query, library, provider or model…'} className="w-full rounded-lg border border-slate-700 bg-slate-900 py-2 pl-9 pr-3 text-xs text-white outline-none focus:border-indigo-500" />
        </div>
        <div className="flex items-center gap-2">
          <select value={days} onChange={(event) => setDays(Number(event.target.value))} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white">
            <option value={7}>{lang === 'zh' ? '近 7 天' : 'Last 7 days'}</option>
            <option value={30}>{lang === 'zh' ? '近 30 天' : 'Last 30 days'}</option>
            <option value={90}>{lang === 'zh' ? '近 90 天' : 'Last 90 days'}</option>
          </select>
          <button type="button" disabled={loading} onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 disabled:opacity-40">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />{lang === 'zh' ? '刷新' : 'Refresh'}
          </button>
        </div>
      </div>

      {canDraft && (
        <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-4 sm:flex-row sm:items-center">
          <span className="text-xs font-semibold text-slate-300">{lang === 'zh' ? '证据草稿归档到' : 'Evidence draft metadata'}</span>
          <select value={draftCategoryId} onChange={(event) => setDraftCategoryId(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white" aria-label={lang === 'zh' ? '文章分类' : 'Article category'}>
            <option value="">{lang === 'zh' ? '选择分类' : 'Select category'}</option>
            {categories.map((category) => <option key={String(category.id)} value={String(category.id)}>{String(category.name || category.id)}</option>)}
          </select>
          <select value={draftAuthorId} onChange={(event) => setDraftAuthorId(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white" aria-label={lang === 'zh' ? '文章作者' : 'Article author'}>
            <option value="">{lang === 'zh' ? '选择作者' : 'Select author'}</option>
            {authors.map((author) => <option key={String(author.id)} value={String(author.id)}>{String(author.name || author.id)}</option>)}
          </select>
          {(categories.length === 0 || authors.length === 0) && <span className="text-[11px] text-amber-300">{lang === 'zh' ? '目录中缺少分类或作者，无法创建真实文章草稿。' : 'A real category and author are required.'}</span>}
        </div>
      )}

      {loading && queries.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-slate-800 bg-slate-900 p-12 text-sm text-slate-400"><Loader2 className="h-5 w-5 animate-spin" />{lang === 'zh' ? '读取真实采集记录…' : 'Loading persisted observations…'}</div>
      ) : filteredQueries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/60 p-10 text-center">
          <Database className="mx-auto h-8 w-8 text-slate-600" />
          <p className="mt-3 text-sm text-slate-300">{queries.length === 0 ? (lang === 'zh' ? '关键词库中还没有问题样本。请先建立关键词，再回来采集。' : 'No query samples exist in the keyword library.') : (lang === 'zh' ? '没有匹配的真实问题样本。' : 'No matching query samples.')}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredQueries.map((item) => {
            const observations = item.observations;
            const citations = item.citations;
            const mentions = record(item.mentions);
            const latest = item.latest_answer;
            const sources = records(latest?.sources);
            const ownedShare = citations.owned_share_percent;
            const mentionRate = mentions.mention_rate_percent;
            return (
              <article key={item.id} className="rounded-xl border border-slate-800 bg-slate-900/90 p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-bold text-white">{item.query}</h3>
                      <span className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">{statusText(item.status, lang)}</span>
                      {item.sample.library_name && <span className="text-[10px] text-slate-500">{String(item.sample.library_name)}</span>}
                    </div>

                    <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
                      <Metric label={lang === 'zh' ? '外部问题量' : 'External volume'} value={lang === 'zh' ? '未采集' : 'Not collected'} detail={lang === 'zh' ? '不使用内部次数冒充热度' : 'Internal counts are not search volume'} />
                      <Metric label={lang === 'zh' ? '采集运行' : 'Collection runs'} value={`${numberValue(observations.completed_run_count)} / ${numberValue(observations.run_count)}`} detail={`${lang === 'zh' ? '失败' : 'Failed'} ${numberValue(observations.failed_run_count)} · ${lang === 'zh' ? '等待' : 'Pending'} ${numberValue(observations.pending_run_count)}`} />
                      <Metric label={lang === 'zh' ? '品牌提及率' : 'Brand mention rate'} value={mentionRate === null || mentionRate === undefined ? (lang === 'zh' ? '不可计算' : 'Unavailable') : `${numberValue(mentionRate)}%`} detail={mentionRate === null || mentionRate === undefined ? String(mentions.availability || '') : `${numberValue(mentions.mentioned_answer_count)} / ${numberValue(mentions.denominator)}`} />
                      <Metric label={lang === 'zh' ? '引用记录' : 'Citation observations'} value={String(numberValue(citations.observation_count))} detail={`${lang === 'zh' ? '唯一信源' : 'Unique sources'} ${numberValue(citations.unique_source_count)}`} />
                      <Metric label={lang === 'zh' ? '自有引用份额' : 'Owned citation share'} value={ownedShare === null || ownedShare === undefined ? (lang === 'zh' ? '不可计算' : 'Unavailable') : `${numberValue(ownedShare)}%`} detail={ownedShare === null || ownedShare === undefined ? String(citations.availability || '') : `${numberValue(citations.owned_observation_count)} / ${numberValue(citations.denominator)}`} />
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {item.providers.length === 0 ? <span className="text-[11px] text-slate-500">{lang === 'zh' ? '尚无 Provider/模型运行记录' : 'No provider/model observations'}</span> : item.providers.map((provider, index) => (
                        <span key={`${String(provider.provider_key)}-${String(provider.model_id)}-${index}`} className="inline-flex items-center gap-1 rounded-md border border-indigo-900/70 bg-indigo-950/30 px-2 py-1 text-[10px] text-indigo-200">
                          <Bot className="h-3 w-3" />{String(provider.provider_key || provider.provider_type || 'unknown')} · {String(provider.model_id || (lang === 'zh' ? '模型未记录' : 'model unrecorded'))} · {numberValue(provider.run_count)}
                        </span>
                      ))}
                    </div>

                    {latest ? (
                      <details className="mt-4 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                        <summary className="cursor-pointer text-xs font-semibold text-slate-200">{lang === 'zh' ? '查看最近一次真实回答与引用' : 'View latest persisted answer and citations'} · {dateText(latest.completed_at, lang)}</summary>
                        <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-300">{String(latest.answer_text || '')}</pre>
                        <div className="mt-3 space-y-2">
                          {sources.length === 0 ? <p className="text-[11px] text-amber-300">{lang === 'zh' ? '该回答没有持久化引用记录。' : 'This answer has no persisted citations.'}</p> : sources.map((source) => (
                            <div key={String(source.id)} className="flex items-start gap-2 text-[11px] text-slate-400"><Link2 className="mt-0.5 h-3 w-3 shrink-0" /><div className="min-w-0"><div className="text-slate-200">{String(source.title || source.domain || source.url || 'source')}</div><div className="break-all">{String(source.url || source.domain || '')} · rank {String(source.rank ?? '—')} · {source.owned === true ? (lang === 'zh' ? '自有域名' : 'owned') : source.owned === false ? (lang === 'zh' ? '外部域名' : 'external') : (lang === 'zh' ? '归属不可计算' : 'ownership unavailable')}</div></div></div>
                          ))}
                        </div>
                      </details>
                    ) : <p className="mt-4 text-xs text-slate-500">{lang === 'zh' ? '当前时间窗没有已完成的真实回答。' : 'No completed persisted answer exists in this window.'}</p>}
                  </div>

                  <div className="flex shrink-0 flex-row gap-2 lg:w-44 lg:flex-col">
                    <button type="button" disabled={!canCollect || Boolean(busyId)} onClick={() => void collectQuery(item)} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-indigo-700 px-3 py-2 text-xs font-semibold text-indigo-200 disabled:opacity-40">
                      {busyId === `collect-${item.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{lang === 'zh' ? '真实采集' : 'Collect'}
                    </button>
                    <button type="button" disabled={!canDraft || !item.draft_ready || !draftCategoryId || !draftAuthorId || Boolean(busyId)} onClick={() => void generateDraft(item)} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40" title={!item.draft_ready ? (lang === 'zh' ? '需要已完成回答和引用记录' : 'Requires a completed answer and citations') : (!draftCategoryId || !draftAuthorId ? (lang === 'zh' ? '请先选择分类和作者' : 'Select a category and author first') : '')}>
                      {busyId === `draft-${item.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}{item.draft ? (lang === 'zh' ? '生成新证据草稿' : 'Create another draft') : (lang === 'zh' ? '生成证据草稿' : 'Create evidence draft')}
                    </button>
                    {!canCollect && <p className="text-[10px] text-slate-500">analytics:collect</p>}
                    {!canDraft && <p className="text-[10px] text-slate-500">articles:write</p>}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-[11px] leading-5 text-slate-400">
        <div className="flex items-center gap-2 font-semibold text-slate-200"><Database className="h-3.5 w-3.5" />{lang === 'zh' ? '数据口径' : 'Data definitions'}</div>
        <p className="mt-2">{String(definitions.query_sample || '')}</p>
        <p>{String(definitions.external_volume || '')}</p>
        <p>{String(definitions.owned_share_percent || '')}</p>
        <p>{String(definitions.brand_mention_rate_percent || '')}</p>
        <p>{String(definitions.brand_names || '')}</p>
        <p>{String(definitions.opportunity_score || '')}</p>
        <p className="mt-2 text-slate-500">{dateText(windowData.start, lang)} — {dateText(windowData.end, lang)}</p>
      </section>
    </div>
  );
};

const Metric: React.FC<{ label: string; value: string; detail: string }> = ({ label, value, detail }) => (
  <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
    <div className="text-[10px] text-slate-500">{label}</div>
    <div className="mt-1 text-sm font-bold text-white">{value}</div>
    <div className="mt-1 text-[9px] text-slate-600">{detail}</div>
  </div>
);
