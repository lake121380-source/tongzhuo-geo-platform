import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Bot, Database, Filter, RefreshCw, TrendingUp, Users, Workflow, X } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient, GeoFlowApiError } from '../api/geoflowClient';
import { dataSourceLabel } from '../api/labels';
import { hasScope, normalizeScopes } from '../api/permissions';
import { LoadingState } from './LoadingState';
import { PageHeader } from './PageHeader';
import { AiVisibilityJianduSection } from './AiVisibilityJianduSection';
import { EmptyState } from './ui';

interface AnalyticsApiViewProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  /**
   * 当前会话的 scope 列表。筛选控件的候选项来自 tasks/articles/distribution
   * 三条独立边界，缺哪个 scope 就禁用哪个下拉，而不是让它静默返回空列表。
   */
  scopes?: readonly string[];
  /**
   * 切到别的后台页签。用于「下一步该做什么」告警条上的跳转——它指向的
   * `/geo_admin?tab=xxx` 就是本 SPA 自己的深链，交给外层切页签比整页刷新好。
   */
  onNavigate?: (tab: string) => void;
  /**
   * 初始分区。`?tab=jiandu` 的深链落进「AI 可见度」分区用（该页签已并入数据分析页）。
   */
  initialSection?: AnalyticsSection;
}

/** 下拉候选项：`value` 原样作为查询参数发给后端。 */
interface FilterOption {
  value: string;
  label: string;
}

type AnalyticsPayload = ApiRecord;
type AnalyticsSection = 'overview' | 'content' | 'traffic' | 'crawlers' | 'ai_visibility' | 'distribution' | 'leads';

const record = (value: unknown): ApiRecord => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {}
);

const list = (value: unknown): ApiRecord[] => (
  Array.isArray(value) ? value.filter((item): item is ApiRecord => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : []
);

const numberValue = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
};

const displayNumber = (value: unknown): string => {
  const number = numberValue(value);
  return number === null ? '—' : number.toLocaleString();
};

const scalarEntries = (value: unknown): Array<[string, string | number | boolean]> => (
  Object.entries(record(value)).filter((entry): entry is [string, string | number | boolean] => (
    ['string', 'number', 'boolean'].includes(typeof entry[1])
  ))
);

const labelFor = (key: string): string => key.replaceAll('_', ' ');

const displayScalar = (value: string | number | boolean): string => {
  if (typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return value || '—';
};

/**
 * 候选列表的显示名。任务/分类/渠道给 `name`，文章给 `title`；都没有时退回
 * `#id`，宁可显示得难看也不要丢掉一条真实可选的记录。
 */
const optionFrom = (item: ApiRecord, keys: readonly string[]): FilterOption | null => {
  const id = numberValue(item.id);
  if (id === null) return null;
  for (const key of keys) {
    const label = typeof item[key] === 'string' ? (item[key] as string).trim() : '';
    if (label !== '') return { value: String(id), label };
  }
  return { value: String(id), label: `#${id}` };
};

const optionsFrom = (items: unknown, keys: readonly string[]): FilterOption[] => (
  list(items)
    .map((item) => optionFrom(item, keys))
    .filter((option): option is FilterOption => option !== null)
);

/** 候选项一次取这么多；服务端若还有更多，界面上要如实说明被截断。 */
const OPTION_PAGE_SIZE = 100;

/**
 * 取一页候选项，并把「服务端总数是否多于本页」一并带出来。
 * 不能只看「本页是否满页」——正好整页时无法区分「刚好这么多」和「还有下一页」。
 */
const slicePage = (
  page: { items?: unknown; pagination?: unknown; meta?: unknown },
  keys: readonly string[],
): { options: FilterOption[]; truncated: boolean } => {
  const options = optionsFrom(page.items, keys);
  const pagination = record(page.pagination);
  const total = numberValue(pagination.total) ?? numberValue(record(page.meta).total);

  return { options, truncated: total !== null && total > options.length };
};

export const AnalyticsApiView: React.FC<AnalyticsApiViewProps> = ({ apiClient, lang, scopes, onNavigate, initialSection }) => {
  const [preset, setPreset] = useState<'7d' | '30d' | '90d'>('7d');
  const [section, setSection] = useState<AnalyticsSection>(initialSection ?? 'overview');
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /**
   * 「增长总览 + 下一步该做什么的告警条」（旧 Blade analytics 首页的版面）。
   * 它自带 60 天窗口、不吃筛选参数，所以与分区数据分开取；取不到时只在它自己的位置
   * 说明原因，**不影响**下面各分区的展示。
   */
  const [growth, setGrowth] = useState<ApiRecord | null>(null);
  const [growthError, setGrowthError] = useState('');

  // 四个实体筛选器与后端 query 参数同名，空串表示不筛选。
  const [taskId, setTaskId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [articleId, setArticleId] = useState('');
  const [channelId, setChannelId] = useState('');
  /** 已生效的 AI 关键词（精确匹配后端 ai_visibility_runs.keyword）。 */
  const [aiKeyword, setAiKeyword] = useState('');
  /** 输入框草稿：回车/点「应用」才提交，避免每敲一个字打一次接口。 */
  const [keywordDraft, setKeywordDraft] = useState('');
  /** 候选项只在「没有关键词筛选」的响应里采集，否则会自我收缩成一个选项。 */
  const [keywordSuggestions, setKeywordSuggestions] = useState<string[]>([]);
  const [options, setOptions] = useState<Record<'tasks' | 'categories' | 'articles' | 'channels', FilterOption[]>>({
    tasks: [],
    categories: [],
    articles: [],
    channels: [],
  });
  /** 候选项取不到时的原因（缺 scope 或请求失败），用于禁用并解释。 */
  const [optionNotes, setOptionNotes] = useState<Record<string, string>>({});
  /** 候选列表被服务端截断等**非阻塞**提示：控件仍可用，但不能假装列全了。 */
  const [optionHints, setOptionHints] = useState<string[]>([]);

  // scopes 每次渲染都可能是新数组，归一化后按字符串做依赖，避免 effect 自激；
  // `allowed` 只引用归一化结果，所以它本身是稳定的。
  const scopeKey = useMemo(() => normalizeScopes(scopes).join(','), [scopes]);
  const scopeList = useMemo(() => normalizeScopes(scopes), [scopeKey]);
  const scoped = scopes !== undefined;
  const allowed = useCallback(
    (scope: string) => !scoped || hasScope(scopeList, scope),
    [scoped, scopeList],
  );

  useEffect(() => {
    let cancelled = false;

    const loadOptions = async (): Promise<void> => {
      const denyNote = (scope: string): string => (
        lang === 'zh' ? `需要「${scope}」权限，无法列出候选项` : `Requires the “${scope}” scope to list options`
      );
      const failNote = lang === 'zh' ? '候选项加载失败' : 'Unable to load options';

      const attempt = async (
        scope: string,
        label: string,
        fetchOptions: () => Promise<{ options: FilterOption[]; truncated: boolean }>,
      ): Promise<{ options: FilterOption[]; note?: string; hint?: string }> => {
        if (!allowed(scope)) return { options: [], note: denyNote(scope) };
        try {
          const { options, truncated } = await fetchOptions();
          // 服务端还有更多记录时必须说出来：静默截断会被读成「一共就这些」。
          return truncated
            ? { options, hint: lang === 'zh'
              ? `${label}候选只列出前 ${OPTION_PAGE_SIZE} 条，其余未列出`
              : `Only the first ${OPTION_PAGE_SIZE} ${label} options are listed` }
            : { options };
        } catch {
          return { options: [], note: failNote };
        }
      };

      const [tasks, categories, articles, channels] = await Promise.all([
        attempt('tasks:read', lang === 'zh' ? '任务' : 'task', async () => slicePage(
          await apiClient.listTasks({ page: 1, per_page: OPTION_PAGE_SIZE }),
          ['name', 'title'],
        )),
        attempt('catalog:read', lang === 'zh' ? '分类' : 'category', async () => ({
          options: optionsFrom((await apiClient.catalog()).categories, ['name', 'title']),
          // catalog 一次性返回全部分类，不存在分页截断。
          truncated: false,
        })),
        attempt('articles:read', lang === 'zh' ? '文章' : 'article', async () => slicePage(
          await apiClient.listArticles({ page: 1, per_page: OPTION_PAGE_SIZE }),
          ['title', 'name'],
        )),
        attempt('distribution:read', lang === 'zh' ? '渠道' : 'channel', async () => slicePage(
          await apiClient.listDistributionChannels({ page: 1, per_page: OPTION_PAGE_SIZE }),
          ['name', 'title'],
        )),
      ]);

      if (cancelled) return;
      setOptions({ tasks: tasks.options, categories: categories.options, articles: articles.options, channels: channels.options });
      const notes: Record<string, string> = {};
      const hints: string[] = [];
      ([['tasks', tasks], ['categories', categories], ['articles', articles], ['channels', channels]] as const)
        .forEach(([key, result]) => {
          if (result.note) notes[key] = result.note;
          if (result.hint) hints.push(result.hint);
        });
      setOptionNotes(notes);
      setOptionHints(hints);
    };

    void loadOptions();

    return () => { cancelled = true; };
  }, [apiClient, allowed, lang]);

  const activeFilterCount = [taskId, categoryId, articleId, channelId, aiKeyword].filter((value) => value !== '').length;

  /**
   * AI 关键词控件已整体退役（2026-09-20）：AI 可见度切换为见度数据后以「问题」
   * 为口径，后端不再消费 `ai_keyword`（总览卡片同源）。留 `false` 而不是删 JSX，
   * 是为了下次要恢复旧采集视图时改动最小。
   */
  const keywordFilterVisible = false;

  const clearFilters = useCallback(() => {
    setTaskId('');
    setCategoryId('');
    setArticleId('');
    setChannelId('');
    setAiKeyword('');
    setKeywordDraft('');
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const params: Record<string, string | number | undefined> = { preset };
      if (taskId !== '') params.task_id = taskId;
      if (categoryId !== '') params.category_id = categoryId;
      if (articleId !== '') params.article_id = articleId;
      if (channelId !== '') params.channel_id = channelId;
      // ai_keyword 只被 ai-visibility 端点消费，其余端点会忽略它。
      if (aiKeyword !== '') params.ai_keyword = aiKeyword;

      const response = section === 'overview' ? await apiClient.getAnalyticsOverview(params)
        : section === 'content' ? await apiClient.getAnalyticsContent(params)
          : section === 'traffic' ? await apiClient.getAnalyticsTraffic(params)
            : section === 'crawlers' ? await apiClient.getAnalyticsCrawlers(params)
              : section === 'ai_visibility' ? await apiClient.getAiVisibilityAnalytics(params)
                : section === 'distribution' ? await apiClient.getDistributionAnalytics(params)
                  : await apiClient.getLeadAnalytics(params);
      setData(response);
      // 增长总览与分区数据并行取；它失败不该把整个分析页打成错误页。
      try {
        setGrowth(await apiClient.getGrowthOverview());
        setGrowthError('');
      } catch (reason) {
        setGrowth(null);
        setGrowthError(reason instanceof Error
          ? reason.message
          : (lang === 'zh' ? '增长总览加载失败' : 'Unable to load the growth overview'));
      }
      // ai-visibility 的响应把关键词放在 `overview.keywords`；此刻没有施加关键词
      // 筛选，所以这一份是当前时间窗内的候选。注意后端 `keywordMetrics()` 有
      // `take(8)`，**这不是全量**——它只是输入提示，输入框接受任意精确关键词。
      // 关键词行没有 `id`，所以直接取 `keyword` 字段本身。
      if (section === 'ai_visibility' && aiKeyword === '') {
        const overview = record(record(response).overview);
        const keywordRows = list(overview.keywords ?? record(response).keywords);
        setKeywordSuggestions(keywordRows
          .map((row) => (typeof row.keyword === 'string' ? row.keyword.trim() : ''))
          .filter((keyword) => keyword !== ''));
      }
    } catch (reason) {
      const message = reason instanceof GeoFlowApiError || reason instanceof Error
        ? reason.message
        : (lang === 'zh' ? '分析数据加载失败' : 'Unable to load analytics');
      setError(message);
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [aiKeyword, apiClient, articleId, categoryId, channelId, lang, preset, section, taskId]);

  useEffect(() => { void load(); }, [load]);

  const kpis = record(data?.kpis);
  const traffic = record(data?.traffic);
  const trafficKpis = record(traffic.kpis);
  const visibility = record(record(data?.ai_visibility).kpis);
  const distribution = record(record(data?.distribution).kpis);
  const leads = record(record(data?.leads).kpis);
  const trend = list(traffic.traffic_trend);
  const botBreakdown = list(traffic.bot_breakdown);
  const source = record(data?.source);

  const detailRoot = section === 'ai_visibility' ? record(data?.overview)
    : section === 'distribution' || section === 'leads' ? record(data?.summary)
      : section === 'traffic' || section === 'crawlers' ? record(data?.summary)
        : data || {};
  const detailKpis = record(detailRoot.kpis);
  const detailTrend = section === 'content' ? list(detailRoot.publication_trend)
    : section === 'traffic' || section === 'crawlers' ? list(detailRoot.traffic_trend)
      : list(detailRoot.trend);
  const detailRows = section === 'content' ? list(detailRoot.top_content)
    : section === 'traffic' ? list(detailRoot.top_paths)
      : section === 'crawlers' ? list(detailRoot.bot_breakdown)
        : section === 'ai_visibility' ? list(detailRoot.keywords)
          : section === 'distribution' ? list(detailRoot.channels)
            : list(detailRoot.sources);

  const sections: Array<{ key: AnalyticsSection; zh: string; en: string }> = [
    { key: 'overview', zh: '总览', en: 'Overview' },
    { key: 'content', zh: '内容', en: 'Content' },
    { key: 'traffic', zh: '流量', en: 'Traffic' },
    { key: 'crawlers', zh: '爬虫', en: 'Crawlers' },
    { key: 'ai_visibility', zh: 'AI 可见度', en: 'AI visibility' },
    { key: 'distribution', zh: '分发', en: 'Distribution' },
    { key: 'leads', zh: '线索', en: 'Leads' },
  ];

  const cards = useMemo(() => [
    { label: lang === 'zh' ? '时间范围文章' : 'Articles in range', value: displayNumber(kpis.articles), icon: Database, tone: 'text-indigo-400' },
    { label: lang === 'zh' ? '已发布' : 'Published', value: displayNumber(kpis.published), icon: TrendingUp, tone: 'text-emerald-400' },
    { label: lang === 'zh' ? '运行任务' : 'Running tasks', value: displayNumber(kpis.running_tasks), icon: Workflow, tone: 'text-indigo-400' },
    { label: 'PV', value: displayNumber(trafficKpis.pv), icon: BarChart3, tone: 'text-amber-400' },
    { label: lang === 'zh' ? 'AI 爬虫 PV' : 'AI bot PV', value: displayNumber(trafficKpis.ai_bot_pv), icon: Bot, tone: 'text-rose-400' },
    { label: lang === 'zh' ? 'AI 可见度' : 'AI visibility', value: visibility.brand_visibility === undefined || visibility.brand_visibility === null ? '—' : `${displayNumber(visibility.brand_visibility)}%`, icon: Users, tone: 'text-slate-400' },
  ], [kpis, lang, trafficKpis, visibility]);

  /**
   * 「下一步该做什么」告警条的文案。与 `lang/{zh_CN,en}/admin.php` 里
   * `admin.analytics.alerts.*` 同一套措辞（React 侧不读 Laravel 语言包，所以按既有惯例内联）。
   */
  const growthAlertCopy: Record<string, { zh: [string, string]; en: [string, string] }> = {
    new_leads: { zh: [':count 条新线索等待处理', '优先联系刚提交信息的访客，缩短首次响应时间。'], en: [':count new leads need attention', 'Contact recent visitors promptly to shorten first-response time.'] },
    distribution_failed: { zh: [':count 条分发记录失败', '检查失败原因并处理需要重试的渠道任务。'], en: [':count distribution records failed', 'Review failures and retry the channel tasks that need it.'] },
    content_failed: { zh: [':count 个内容任务失败', '查看失败任务和错误信息，恢复内容生产流程。'], en: [':count content tasks failed', 'Review failed tasks and errors to restore content production.'] },
    no_forms: { zh: ['当前没有启用的表单', '启用或创建转化表单后，前台访客才能提交线索。'], en: ['No forms are active', 'Activate or create a conversion form so visitors can submit leads.'] },
    ai_unconfigured: { zh: ['AI 可见性尚未配置', '完成搜索与分析提供商配置后开始积累品牌观测数据。'], en: ['AI visibility is not configured', 'Configure a search and analysis provider to start collecting brand observations.'] },
  };

  const growthMetrics = record(growth?.metrics);
  const growthMetricTiles = [
    { label: lang === 'zh' ? '今日真实访问' : 'Visits today', value: displayNumber(growthMetrics.today_visits) },
    { label: lang === 'zh' ? '近 7 日发布' : 'Published (7d)', value: displayNumber(growthMetrics.published_7d) },
    // 未声明品牌/自有域名时后端给 null（不可计算），必须显示「—」而不是 0.0%。
    { label: lang === 'zh' ? '近 60 日品牌可见率' : 'Brand visibility (60d)', value: growthMetrics.brand_visibility_60d === null || growthMetrics.brand_visibility_60d === undefined ? '—' : `${displayNumber(growthMetrics.brand_visibility_60d)}%` },
    { label: lang === 'zh' ? '当前新线索' : 'New leads', value: displayNumber(growthMetrics.new_leads) },
    { label: lang === 'zh' ? '当前待跟进' : 'Pending follow-ups', value: displayNumber(growthMetrics.pending_followups) },
  ];

  // 加载完成前 `growth` 是 null，这里必须始终得到对象——否则 `growthAlert.type` 会直接抛
  // （typecheck 没拦住：这个项目的 tsconfig 没开 strictNullChecks，靠类型挡不住这类错）。
  const growthAlert = record((growth ?? {}).alert ?? null);
  const growthAlertType = String(growthAlert.type || '');
  const growthAlertCopyEntry = growthAlertCopy[growthAlertType];
  const growthAlertHref = String(growthAlert.href || '');
  const growthAlertTab = growthAlertHref.includes('?') ? (new URLSearchParams(growthAlertHref.split('?')[1]).get('tab') || '') : '';

  return (
    <div className="space-y-8">
      <PageHeader
        icon={BarChart3}
        group={lang === 'zh' ? 'GEO 效果' : 'Results'}
        title={lang === 'zh' ? '数据分析' : 'Analytics'}
        description={lang === 'zh' ? '内容、流量、爬虫、线索的真实数据都在这里；数字来自本部署数据库，不做估算。' : 'Real numbers for content, traffic, crawlers and leads — straight from this deployment.'}
        actions={<>
          <div className="flex rounded-xl bg-slate-800/50 p-1">
            {(['7d', '30d', '90d'] as const).map((item) => (
              <button key={item} type="button" onClick={() => setPreset(item)} className={`rounded-lg px-2.5 py-1.5 text-[12.5px] font-semibold transition ${preset === item ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}>{item}</button>
            ))}
          </div>
          <button type="button" onClick={() => void load()} disabled={busy} className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700 bg-slate-800/60 text-slate-200 transition hover:bg-slate-800 disabled:opacity-50" aria-label={lang === 'zh' ? '刷新分析' : 'Refresh analytics'}><RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /></button>
        </>}
      />

      {/* 「增长总览 + 下一步该做什么」：旧 Blade analytics 首页的版面，退役时失去了入口，
          哥哥拍板补回。它自带 60 天窗口、不吃上面的筛选参数，所以与分区数据分开取。 */}
      {(growth !== null || growthError !== '') && (
        <div className="space-y-3">
          {growthError !== '' && (
            <p className="rounded-xl border border-amber-500/30 bg-amber-950/20 px-4 py-3 text-[13px] text-slate-200">
              {lang === 'zh' ? `增长总览暂不可用：${growthError}` : `Growth overview unavailable: ${growthError}`}
            </p>
          )}
          {growthAlertCopyEntry !== undefined && (
            <div className="flex flex-col gap-3 rounded-2xl border border-amber-500/30 bg-amber-950/20 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[13px] font-semibold text-amber-200">
                  {(lang === 'zh' ? growthAlertCopyEntry.zh[0] : growthAlertCopyEntry.en[0]).replace(':count', displayNumber(growthAlert.count))}
                </p>
                <p className="mt-1 text-[12.5px] text-slate-300">{lang === 'zh' ? growthAlertCopyEntry.zh[1] : growthAlertCopyEntry.en[1]}</p>
              </div>
              <a
                href={growthAlertHref === '' ? undefined : growthAlertHref}
                onClick={(event) => {
                  // 告警指向的就是本 SPA 自己的页签深链；能切页签就别整页刷新。
                  if (growthAlertTab !== '' && onNavigate) { event.preventDefault(); onNavigate(growthAlertTab); }
                }}
                className="inline-flex h-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/40 px-3.5 text-[13px] font-semibold text-amber-200 transition hover:bg-amber-500/10"
              >
                {lang === 'zh' ? '立即处理' : 'Handle now'}
              </a>
            </div>
          )}
          {growth !== null && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {growthMetricTiles.map((tile) => (
                <div key={tile.label} className="rounded-2xl bg-slate-900/80 p-5 transition hover:shadow-md">
                  <p className="text-caption">{tile.label}</p>
                  <p className="mt-1.5 text-[24px] font-black leading-none tabular-nums text-white">{tile.value}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 rounded-xl bg-slate-800/50 p-1.5">
        {sections.map((item) => <button key={item.key} type="button" onClick={() => setSection(item.key)} className={`rounded-lg px-3.5 py-2 text-[12.5px] font-semibold transition ${section === item.key ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>{lang === 'zh' ? item.zh : item.en}</button>)}
      </div>

      {/* 筛选条服务于本站各数据分区；AI 可见度分区展示的是见度数据，这些筛选对它
          不起作用——与其摆一排按了没反应的控件，不如不显示（本项目的家规）。 */}
      {section !== 'ai_visibility' && (
      <div className="rounded-2xl bg-slate-900/80 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <span className="flex items-center gap-1.5 pb-2.5 text-caption font-semibold"><Filter className="h-3.5 w-3.5" />{lang === 'zh' ? '筛选' : 'Filters'}</span>
          <FilterSelect label={lang === 'zh' ? '任务' : 'Task'} anyLabel={lang === 'zh' ? '全部任务' : 'All tasks'} value={taskId} options={options.tasks} note={optionNotes.tasks} onChange={setTaskId} />
          <FilterSelect label={lang === 'zh' ? '分类' : 'Category'} anyLabel={lang === 'zh' ? '全部分类' : 'All categories'} value={categoryId} options={options.categories} note={optionNotes.categories} onChange={setCategoryId} />
          <FilterSelect label={lang === 'zh' ? '文章' : 'Article'} anyLabel={lang === 'zh' ? '全部文章' : 'All articles'} value={articleId} options={options.articles} note={optionNotes.articles} onChange={setArticleId} />
          <FilterSelect label={lang === 'zh' ? '渠道' : 'Channel'} anyLabel={lang === 'zh' ? '全部渠道' : 'All channels'} value={channelId} options={options.channels} note={optionNotes.channels} onChange={setChannelId} />
          {keywordFilterVisible && (
            <label className="flex flex-col gap-1 text-caption">
              <span>{lang === 'zh' ? 'AI 关键词' : 'AI keyword'}</span>
              <span className="flex items-center gap-1.5">
                <input
                  list="analytics-ai-keyword-options"
                  value={keywordDraft}
                  onChange={(event) => setKeywordDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') setAiKeyword(keywordDraft.trim()); }}
                  placeholder={lang === 'zh' ? '与采集关键词完全一致' : 'Exact collected keyword'}
                  className="h-10 w-56 rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition placeholder:text-slate-500 focus:border-indigo-500"
                />
                <datalist id="analytics-ai-keyword-options">{keywordSuggestions.map((keyword) => <option key={keyword} value={keyword} />)}</datalist>
                <button type="button" onClick={() => setAiKeyword(keywordDraft.trim())} className="inline-flex h-9 shrink-0 items-center rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800">{lang === 'zh' ? '应用' : 'Apply'}</button>
              </span>
            </label>
          )}
          {activeFilterCount > 0 && (
            <button type="button" onClick={clearFilters} className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 transition hover:bg-slate-800">
              <X className="h-3.5 w-3.5" />{lang === 'zh' ? `清除筛选（${activeFilterCount}）` : `Clear filters (${activeFilterCount})`}
            </button>
          )}
        </div>
        {keywordFilterVisible && aiKeyword !== '' && (
          <p className="mt-3 text-caption">{lang === 'zh' ? `AI 关键词为精确匹配，当前只看「${aiKeyword}」这一条采集关键词的样本（总览的 AI 可见度卡片也一并收窄）。` : `AI keyword is an exact match; only samples for “${aiKeyword}” are shown (the overview AI-visibility card is narrowed too).`}</p>
        )}
        {optionHints.length > 0 && (
          <p className="mt-2 text-[12.5px] text-amber-400/80">{optionHints.join(lang === 'zh' ? '；' : '; ')}</p>
        )}
        {keywordFilterVisible && keywordSuggestions.length > 0 && (
          <p className="mt-1 text-caption">{lang === 'zh'
            ? `AI 关键词候选只是后端返回的前 ${keywordSuggestions.length} 条提示，不是全部；可直接输入任意精确关键词。`
            : `AI keyword suggestions are only the first ${keywordSuggestions.length} returned, not the full set; any exact keyword can be typed.`}</p>
        )}
      </div>
      )}

      {error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-[13px] text-rose-200">{error}<button type="button" onClick={() => void load()} className="ml-3 font-semibold underline">{lang === 'zh' ? '重试' : 'Retry'}</button></div>}

      {busy && !data ? <LoadingState lang={lang} label={lang === 'zh' ? '正在读取真实分析数据…' : 'Loading persisted analytics…'} /> : data && section === 'overview' && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            {cards.map(({ label, value, icon: Icon, tone }) => <div key={label} className="rounded-2xl bg-slate-900/80 p-5 transition hover:shadow-md"><div className="flex items-center justify-between text-caption"><span>{label}</span><Icon className={`h-[18px] w-[18px] ${tone}`} /></div><div className="mt-2 text-[30px] font-black leading-none tabular-nums text-white">{value}</div></div>)}
          </div>

          {/* 2:1（对齐设计稿「主图表 + 侧榜」）：访问趋势是 7 行四列的宽表、爬虫分类是窄列表，
              1:1 时表格被挤、右侧列表留着大片空。 */}
          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-3">
            <section className="rounded-2xl bg-slate-900/80 p-5 lg:col-span-2">
              <div className="mb-4 flex items-center justify-between"><h2 className="text-section-title">{lang === 'zh' ? '访问趋势' : 'Traffic trend'}</h2><span className="text-caption">{dataSourceLabel(source, lang)}</span></div>
              {trend.length === 0 ? <EmptyState compact icon={TrendingUp} title={lang === 'zh' ? '该时间范围暂无访问日志' : 'No traffic logs in this range'} description={lang === 'zh' ? '换个时间范围（7 / 30 / 90 天），或清空筛选后再看。' : 'Try another range (7 / 30 / 90 days) or clear the filters.'} /> : <div className="overflow-x-auto"><table className="w-full text-left text-[13px] text-slate-300"><thead className="border-b border-slate-800 bg-slate-800/40 text-[12.5px] font-semibold text-slate-400"><tr><th className="px-3 py-3.5">{lang === 'zh' ? '日期' : 'Date'}</th><th className="px-3 py-3.5">PV</th><th className="px-3 py-3.5">UV</th><th className="px-3 py-3.5">AI Bot</th></tr></thead><tbody className="divide-y divide-slate-800/60">{trend.map((row) => <tr key={String(row.date)} className="transition hover:bg-slate-800/40"><td className="px-3 py-4">{String(row.date || '')}</td><td className="px-3 py-4">{displayNumber(row.pv)}</td><td className="px-3 py-4">{displayNumber(row.unique_ip)}</td><td className="px-3 py-4 text-rose-300">{displayNumber(row.ai_bot_pv)}</td></tr>)}</tbody></table></div>}
            </section>
            <section className="rounded-2xl bg-slate-900/80 p-5">
              <h2 className="mb-4 text-section-title">{lang === 'zh' ? '爬虫分类' : 'Crawler breakdown'}</h2>
              {botBreakdown.length === 0 ? <EmptyState compact icon={Bot} title={lang === 'zh' ? '暂无爬虫分类数据' : 'No crawler data'} description={lang === 'zh' ? '换个时间范围或清空筛选后再看。' : 'Try another range or clear the filters.'} /> : <div className="space-y-2">{botBreakdown.map((row) => <div key={String(row.key)} className="flex items-center justify-between rounded-xl bg-slate-950/40 px-4 py-3 text-[13px]"><span className="text-slate-300">{String(row.label || row.key || '')}</span><span className="font-mono text-slate-400">{displayNumber(row.count)}</span></div>)}</div>}
              <div className="mt-4 grid grid-cols-2 gap-3"><div className="rounded-xl bg-slate-950/40 px-4 py-3"><div className="text-caption">{lang === 'zh' ? '分发成功' : 'Distribution synced'}</div><div className="mt-1.5 text-[20px] font-black leading-none tabular-nums text-emerald-300">{displayNumber(distribution.synced)}</div></div><div className="rounded-xl bg-slate-950/40 px-4 py-3"><div className="text-caption">{lang === 'zh' ? '新线索' : 'New leads'}</div><div className="mt-1.5 text-[20px] font-black leading-none tabular-nums text-indigo-300">{displayNumber(leads.new)}</div></div></div>
            </section>
          </div>
        </>
      )}
      {data && section === 'ai_visibility' && (
        <AiVisibilityJianduSection payload={record(data.overview)} lang={lang} onNavigate={onNavigate} />
      )}
      {data && section !== 'overview' && section !== 'ai_visibility' && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-caption">
            <span className="rounded-lg bg-slate-800/60 px-2.5 py-1 text-slate-300">{dataSourceLabel(data.source, lang)}</span>
            <span>{record(data.source).estimated === false ? (lang === 'zh' ? '非估算数据' : 'Not estimated') : (lang === 'zh' ? '来源状态未知' : 'Unknown source status')}</span>
            {detailRoot.ready === false && <span className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-amber-300">{lang === 'zh' ? '数据表或采集尚未就绪' : 'Data source is not ready'}</span>}
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
            {scalarEntries(detailKpis).map(([key, value]) => <div key={key} className="rounded-2xl bg-slate-900/80 p-5 transition hover:shadow-md"><div className="text-caption">{labelFor(key)}</div><div className="mt-1.5 text-[24px] font-black leading-none tabular-nums text-white">{displayScalar(value)}</div></div>)}
            {scalarEntries(detailKpis).length === 0 && <div className="col-span-full"><EmptyState compact icon={BarChart3} title={lang === 'zh' ? '当前接口没有 KPI 数据' : 'No KPI data is available'} description={lang === 'zh' ? '这个分区的接口没有返回指标；换个分区或点右上角刷新重试。' : 'This section returned no metrics; try another section or refresh.'} /></div>}
          </div>
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <AnalyticsTable title={lang === 'zh' ? '趋势' : 'Trend'} rows={detailTrend} emptyText={lang === 'zh' ? '当前时间范围暂无趋势数据' : 'No trend data in this range'} emptyHint={lang === 'zh' ? '换个时间范围（7 / 30 / 90 天），或清空筛选后再看。' : 'Try another range (7 / 30 / 90 days) or clear the filters.'} />
            <AnalyticsTable title={section === 'content' ? (lang === 'zh' ? '热门内容' : 'Top content') : section === 'traffic' ? (lang === 'zh' ? '热门路径' : 'Top paths') : section === 'crawlers' ? (lang === 'zh' ? '爬虫分类' : 'Crawler breakdown') : section === 'distribution' ? (lang === 'zh' ? '渠道' : 'Channels') : (lang === 'zh' ? '线索来源' : 'Lead sources')} rows={detailRows} emptyText={lang === 'zh' ? '当前时间范围暂无明细' : 'No detail rows in this range'} emptyHint={lang === 'zh' ? '换个时间范围或清空筛选后再看。' : 'Try another range or clear the filters.'} />
          </div>
        </>
      )}
    </div>
  );
};

const FilterSelect: React.FC<{
  label: string;
  anyLabel: string;
  value: string;
  options: FilterOption[];
  /** 取不到候选项的原因：有值时下拉禁用并把原因显示出来，而不是装作「没有数据」。 */
  note?: string;
  onChange: (value: string) => void;
}> = ({ label, anyLabel, value, options, note, onChange }) => (
  <label className="flex flex-col gap-1 text-caption">
    <span>{label}</span>
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={Boolean(note)}
      title={note}
      className="h-10 w-44 rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500 disabled:opacity-50"
    >
      <option value="">{anyLabel}</option>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    {note && <span className="max-w-44 text-[12.5px] text-amber-400/80">{note}</span>}
  </label>
);

const AnalyticsTable: React.FC<{ title: string; rows: ApiRecord[]; emptyText: string; emptyHint?: string }> = ({ title, rows, emptyText, emptyHint }) => {
  const columns = rows.length === 0 ? [] : Object.keys(rows[0]).filter((key) => {
    const value = rows[0][key];
    return value === null || ['string', 'number', 'boolean'].includes(typeof value);
  }).slice(0, 6);

  return <section className="rounded-2xl bg-slate-900/80 p-5"><h2 className="mb-4 text-section-title">{title}</h2>{rows.length === 0 ? <EmptyState compact icon={Database} title={emptyText} description={emptyHint} /> : <div className="overflow-x-auto"><table className="w-full text-left text-[13px] text-slate-300"><thead className="border-b border-slate-800 bg-slate-800/40 text-[12.5px] font-semibold text-slate-400"><tr>{columns.map((column) => <th key={column} className="whitespace-nowrap px-3 py-3.5">{labelFor(column)}</th>)}</tr></thead><tbody className="divide-y divide-slate-800/60">{rows.map((row, index) => <tr key={String(row.id || row.date || row.key || row.name || row.source || index)} className="transition hover:bg-slate-800/40">{columns.map((column) => <td key={column} className="max-w-64 truncate px-3 py-4">{row[column] === null || row[column] === undefined ? '—' : String(row[column])}</td>)}</tr>)}</tbody></table></div>}</section>;
};
