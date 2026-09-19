import { hasScope, isSuperAdminRole } from './api/permissions';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Activity, Award, Compass, ContactRound, Flame, Globe, Inbox, Layers, Search, TrendingUp } from 'lucide-react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { readTabFromUrl, readViewFromUrl, defaultViewOf, writeNavToUrl } from './tabs';
import { TabbedShell, useConfirm, useToast } from './components/ui';
import { DesktopOnlyNotice } from './components/DesktopOnlyNotice';
import { LoadingState } from './components/LoadingState';
import { DashboardView } from './components/DashboardView';
import { GettingStartedStep } from './components/GettingStartedPanel';
import { probeTitleReadiness, TitleLibraryReadiness } from './api/titleReadiness';
import { ArticlesView } from './components/ArticlesView';
import { ArticleModal } from './components/ArticleModal';
import { TasksView } from './components/TasksView';
import { KnowledgeView } from './components/KnowledgeView';
import { MaterialsView } from './components/MaterialsView';
import { DistributionView } from './components/DistributionView';
import ManualPublicationsView from './components/ManualPublicationsView';
import { AnalyticsApiView } from './components/AnalyticsApiView';
import { JianduView } from './components/JianduView';
import { LeadManagementView } from './components/LeadManagementView';
import { AiWorkspaceView } from './components/AiWorkspaceView';
import { AiModelsView } from './components/AiModelsView';
import AdminSettingsView from './components/AdminSettingsView';
import SystemUpdatesView from './components/SystemUpdatesView';
import SiteSettingsPanel from './components/SiteSettingsPanel';
import { SitePreviewView } from './components/SitePreviewView';
import { AiSandboxView } from './components/AiSandboxView';
import { CompetitorRadarView } from './components/CompetitorRadarView';
import { QueryRadarView } from './components/QueryRadarView';
import { UrlScannerView } from './components/UrlScannerView';
import { SeoConfigurationView } from './components/SeoConfigurationView';
import { RealSeoDashboardView } from './components/RealSeoDashboardView';
import { BrandEntityEeatView } from './components/BrandEntityEeatView';
import { AiAttributionFunnelView } from './components/AiAttributionFunnelView';
import { Article, Category, Task, KnowledgeBase, KnowledgeChunk, DistributionChannel, AiModelConfig, PromptTemplate, AnalyticsOverview } from './types';
import { LoginView } from './components/LoginView';
import { ApiUnavailableView } from './components/ApiUnavailableView';
import {
  ApiAuthSession,
  ApiRecord,
  CatalogResponse,
  GeoFlowApiClient,
  GeoFlowApiError,
  PaginatedResponse,
} from './api/geoflowClient';
import { createGeoFlowApiClient, isGeoFlowApiEnabled } from './api/config';
import {
  emptyCatalog,
  mapArticle,
  mapArticles,
  mapCatalogCategories,
  mapCatalogKnowledgeBases,
  mapCatalogModels,
  mapCatalogPrompts,
  mapApiPrompt,
  mapDistributionChannel,
  getPageItems,
  getPaginationMeta,
  mapKnowledgeBase,
  mapKnowledgeChunks,
  mapTask,
  mapTasks,
} from './api/mappers';
import { NormalizedPagination } from './api/mappers';
import {
  hasRawWorkflowStatus,
  isPublishedWorkflow,
  publicationAction,
  reviewStatus,
  workflowStatus,
} from './api/articleWorkflow';

/**
 * Keep surfaces with unverified data semantics closed in real deployments.
 * They may only be reopened after their metrics, source evidence and failure
 * states have passed the product-level acceptance gate.
 *
 * 2026-09-11 四个标签全部解除禁用，`API_DISABLED_TABS` 现已清空：
 * · brand_entity 不依赖外部 Provider，投影已改为只输出可核验事实（配置完整度 + 真实计数）；
 * · sandbox 后端已改为诚实口径，并把失败态改为原样透出后端错误；
 * · attribution_funnel 接入新的真实投影 `GET /ai-research/attribution`（view_logs.referer ×
 *   lead_submissions，按 IP 关联并在页面上写明「会低估、属下界」）；
 * · seo_dashboard 改为真实的「可发现性 → 抓取 → 被引用 → 结果」汇总页，数据来自
 *   `GET /site/seo-audit`（配置 × AI 爬虫名单对撞）、analytics/traffic、查询雷达、竞品雷达与归因；
 *   不做关键词排名/搜索量/外链这类没有可核验数据源的指标。
 * 保留这个常量是为了让「未验收页面不得开放」的机制继续可用，将来新增页面照旧登记。
 */
const API_DISABLED_TABS: string[] = [];

function asRecord(value: unknown): ApiRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ApiRecord
    : {};
}

function recordId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function catalogOption(item: ApiRecord): { id: string | number; name: string } {
  return {
    id: (item.id as string | number | undefined) ?? '',
    name: String(item.name ?? '未命名'),
  };
}

function mergeCatalogOptions(
  ...groups: Array<Array<{ id: string | number; name: string }>>
): Array<{ id: string | number; name: string }> {
  const byId = new Map<string, { id: string | number; name: string }>();
  groups.flat().forEach((item) => {
    const key = String(item.id);
    if (key && key !== 'undefined' && key !== 'null' && !byId.has(key)) {
      byId.set(key, item);
    }
  });
  return Array.from(byId.values());
}

/**
 * A restricted API token must be able to open the shell even when it cannot
 * read one of the optional data domains.  Keep the fallback shape identical
 * to the Laravel paginator so a missing scope is represented as an empty
 * projection instead of turning the whole boot request into a 403 error.
 */
function emptyApiPage(): PaginatedResponse<ApiRecord> {
  return {
    items: [],
    pagination: { page: 1, per_page: 100, total: 0, total_pages: 0 },
  };
}

export default function App() {
  const apiEnabled = isGeoFlowApiEnabled;
  const [apiSession, setApiSession] = useState<ApiAuthSession | null>(null);
  const [apiClient] = useState<GeoFlowApiClient>(() => createGeoFlowApiClient({
    onUnauthorized: () => setApiSession(null),
  }));
  const [apiBooting, setApiBooting] = useState(apiEnabled);
  /**
   * 首轮业务数据还没到（外壳可能已放行）。
   *
   * 为什么与 `apiBooting` 分开：`bootDeadline` 会在 1.5 秒后放行外壳，此时
   * `articles` / `tasks` 还是空数组——列表页会把「还没加载」画成「0 条 / 暂无数据」，
   * 用户分不清「还在读」和「真的没有」（实测登录后 3 秒内仪表盘显示 `0 / 0`，
   * 6 秒才变成真实值）。这个状态让页面在**首次取数期间**显示骨架而不是假空态；
   * 已有数据时的刷新不受影响（各页只在「加载中且自己没有数据」时才显示骨架）。
   */
  const [bootDataLoading, setBootDataLoading] = useState(apiEnabled);
  const [apiError, setApiError] = useState<GeoFlowApiError | null>(null);
  const [apiReloadToken, setApiReloadToken] = useState(0);
  const [apiCatalog, setApiCatalog] = useState<CatalogResponse>(() => emptyCatalog());

  // 页签可由 URL 深链指定（`/geo_admin?tab=articles`）。AI 助手返回的「站内入口」
  // 用的就是这个格式，旧后台退役后它取代了原先的 Laravel 路由名。
  const [currentTab, setCurrentTab] = useState(() => readTabFromUrl());

  /**
   * 合并入口的**内层视图**（`?tab=<宿主>&view=<key>`）。
   *
   * 例：`?tab=competitor` 打开的是「AI 引用监测」页的竞品对比 Tab——
   * 高亮落在合并后的入口上，内容仍是原来那一页。非合并页签恒为 null。
   */
  const [currentView, setCurrentView] = useState<string | null>(() => readViewFromUrl() ?? defaultViewOf(readTabFromUrl()));

  /** 全局操作反馈：成功给「下一步」，失败给「为什么 + 怎么办」（原来这些位置是 window.alert）。 */
  const toast = useToast();
  /** 统一的确认对话框（原生 confirm 在内嵌浏览器里不渲染，见 AGENTS.md）。 */
  const confirmAction = useConfirm();

  // 页签/内层视图变化时同步到地址栏（replaceState，不堆历史记录），让深链始终反映当前页。
  // 合并入口写成 `?tab=<宿主>&view=<key>`：复制给同事落到的仍是同一个子视图。
  useEffect(() => { writeNavToUrl(currentTab, currentView); }, [currentTab, currentView]);
  const [lang, setLang] = useState<'zh' | 'en'>('zh');
  const [hasGeminiKey, setHasGeminiKey] = useState(false);

  // Core Data States
  const [stats, setStats] = useState<any>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [trashedArticles, setTrashedArticles] = useState<Article[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([]);
  const [chunkLoadErrors, setChunkLoadErrors] = useState<Record<string, string>>({});
  const [channels, setChannels] = useState<DistributionChannel[]>([]);
  const [hostedSites, setHostedSites] = useState<ApiRecord[]>([]);
  const [distributionJobs, setDistributionJobs] = useState<ApiRecord[]>([]);
  const [models, setModels] = useState<AiModelConfig[]>([]);
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  /** 「概览大盘」用的真实分析投影；取不到就保持 null，界面显示「—」。 */
  const [analyticsOverview, setAnalyticsOverview] = useState<ApiRecord | null>(null);
  /**
   * 本部署有没有 AI 助手（`GET ai-workspace/status` 的 `runtime_enabled`）。
   *
   * 这是**特性开关**控制的能力：生产默认关（`GEOFLOW_AI_WORKSPACE_RUNTIME_ENABLED`），
   * 关掉的部署连入口都不该有——「有入口却用不了」比没有入口更糟。
   *
   * **刻意看 `runtime_enabled` 而不看 `ready`**：两者含义不同。`runtime_enabled=false`
   * 是「这个部署根本没有这个能力」（隐藏入口）；`ready=false` 是「能力在、但模型还没配好」，
   * 那种情况该把入口留着，由页面自己说明原因并指向模型配置——藏起来用户就无从知道要配什么。
   *
   * **三态**：`null` = 还没问到，`true` / `false` = 后端已明确回答。必须区分「还不知道」
   * 与「关掉了」，见下面那个 effect。
   */
  const [aiWorkspaceEnabled, setAiWorkspaceEnabled] = useState<boolean | null>(null);

  /**
   * 上面那次探测**没问到**（请求失败），与「后端明确回答没开」是两件事。
   *
   * 两者对**入口显隐**的处理相同（都藏起来），对**深链**的处理相反：明确没开就该退回总览，
   * 没问到则必须原样保留——否则一次网络抖动就会把用户粘贴的入口链接改写成总览。
   * 这个状态同时也是给冒烟测试的钩子：它要能区分「后端说没开」和「没问到」。
   */
  const [aiWorkspaceProbeFailed, setAiWorkspaceProbeFailed] = useState(false);

  // 深链落在「本部署已关闭」的 AI 助手上时退回总览——否则用户会停在一个导航里根本
  // 没有入口的页面上。**只在后端明确回答「关了」时才退**：深链
  // `/geo_admin?tab=ai-workspace`（也正是后端助手回复里给出的入口格式）在**登录页**
  // 就会渲染一次，那时开关状态无从得知，若把「未问到」当成「关掉了」，地址栏会被
  // 立刻改写成 `?tab=dashboard`，链接在用户登录之前就永久失效。
  useEffect(() => {
    if (aiWorkspaceEnabled === false && currentTab === 'ai-workspace') {
      setCurrentTab('dashboard');
    }
  }, [aiWorkspaceEnabled, currentTab]);
  // 演示数据已删除：初值只能是空投影，真实数据由 API 引导后写入。
  const [analytics, setAnalytics] = useState<AnalyticsOverview>({
    totalPvs: 0,
    totalUvs: 0,
    articlesGeneratedToday: 0,
    aiCrawlersCount: 0,
    crawlerBreakdown: [],
    dailyTraffic: [],
    topArticles: [],
  });

  // Selected Article for modal reader
  const [activeArticleModal, setActiveArticleModal] = useState<Article | null>(null);
  const taskPollTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const taskPollAttempts = useRef<Map<string, number>>(new Map());
  const taskPollFailures = useRef<Map<string, number>>(new Map());

  // Restore only a session that was issued by 桐灼GEO.  A bare/stale token is
  // discarded instead of rendering an unaudited shell with unknown identity.
  useEffect(() => {
    const storedSession = apiClient.session;
    if (storedSession) {
      setApiSession(storedSession);
      return;
    }
    if (apiClient.authenticated) apiClient.clearToken();
    setApiBooting(false);
  }, [apiClient, apiEnabled]);

  // Fetch initial data from server endpoints
  useEffect(() => {
    if (apiEnabled) return;

    const fetchData = async () => {
      try {
        const healthRes = await fetch('/api/health');
        if (healthRes.ok) {
          const hData = await healthRes.json();
          setHasGeminiKey(Boolean(hData.hasGeminiKey));
        }

        const statsRes = await fetch('/api/dashboard/stats');
        if (statsRes.ok) {
          const sData = await statsRes.json();
          setStats(sData);
        }

        const artsRes = await fetch('/api/articles');
        if (artsRes.ok) {
          const aData = await artsRes.json();
          if (aData.data) setArticles(aData.data);
        }

        const tasksRes = await fetch('/api/tasks');
        if (tasksRes.ok) {
          const tData = await tasksRes.json();
          if (tData.data) setTasks(tData.data);
        }

        const kbRes = await fetch('/api/knowledge-bases');
        if (kbRes.ok) {
          const kData = await kbRes.json();
          if (kData.data) setKnowledgeBases(kData.data);
        }

        const chRes = await fetch('/api/distribution');
        if (chRes.ok) {
          const cData = await chRes.json();
          if (cData.data) setChannels(cData.data);
        }

        const modRes = await fetch('/api/models');
        if (modRes.ok) {
          const mData = await modRes.json();
          if (mData.data) setModels(mData.data);
        }

        const anRes = await fetch('/api/analytics');
        if (anRes.ok) {
          const anData = await anRes.json();
          setAnalytics(anData);
        }
      } catch (err) {
        console.warn('Using local fallback state during initial load:', err);
      }
    };

    fetchData();
  }, [apiEnabled]);

  useEffect(() => {
    if (!apiSession || !apiClient.authenticated) {
      setApiBooting(false);
      return;
    }

    let cancelled = false;
    // Never block the entire admin shell indefinitely on one slow optional
    // projection.  The request continues in the background and page-level
    // states are updated as each response arrives.
    const bootDeadline = window.setTimeout(() => {
      if (!cancelled) setApiBooting(false);
    }, 1500);
    const fetchApiData = async () => {
      setApiBooting(true);
      setBootDataLoading(true);
      setApiError(null);
      // AI 助手是**特性开关**控制的能力（GEOFLOW_AI_WORKSPACE_RUNTIME_ENABLED）。
      // **单独发、不并在下面那批里**：入口的可见性不该等那批里最慢的请求——排进批次
      // 就会跟着一起等（实测 dev 下外壳放行数秒后入口才出现，用户看到的是「导航先少
      // 一项、过一会儿又冒出来」）。取不到就当作未启用（对可选功能宁可不显示），
      // 但**不抛出去**，免得一个可选功能的失败拖垮整批启动请求。
      apiClient.getAiWorkspaceStatus()
        .then((status) => {
          if (!cancelled) setAiWorkspaceEnabled(asRecord(status).runtime_enabled === true);
        })
        .catch(() => {
          // **探测失败 ≠ 后端说「这个部署没有这个能力」**，所以保持 `null`（还不知道），
          // 不写 `false`。入口的显隐不受影响（只有 `=== true` 才渲染），但深链的命运不同：
          // 下面那个 effect 只在**明确回答「关了」**时才把地址改写成总览。
          // 本机实测过这条路径：同一个部署两次加载，一次探到 true、一次因为连接被重置
          // 探失败——若把失败写成 false，用户粘贴的 `?tab=ai-workspace` 就会被悄悄改掉。
          if (!cancelled) {
            setAiWorkspaceEnabled(null);
            setAiWorkspaceProbeFailed(true);
          }
        });
      try {
        const canReadCatalog = hasScope(apiSession, 'catalog:read');
        const canReadArticles = hasScope(apiSession, 'articles:read');
        const canReadTasks = hasScope(apiSession, 'tasks:read');
        const canReadMaterials = hasScope(apiSession, 'materials:read');
        const canReadDistribution = hasScope(apiSession, 'distribution:read');
        const canReadModels = hasScope(apiSession, 'models:read');
        const canReadAnalytics = hasScope(apiSession, 'analytics:read');
        const [catalog, articlePage, trashArticlePage, taskPage, knowledgePage, distributionPage, distributionJobsPage, hostedSitesPage, aiModelsPage, promptsPage, analyticsOverviewData] = await Promise.all([
          canReadCatalog ? apiClient.catalog() : Promise.resolve(emptyCatalog()),
          canReadArticles ? apiClient.listArticles({ page: 1, per_page: 100 }) : Promise.resolve(emptyApiPage()),
          canReadArticles ? apiClient.listArticles({ page: 1, per_page: 100, trash: 'only' }) : Promise.resolve(emptyApiPage()),
          canReadTasks ? apiClient.listTasks({ page: 1, per_page: 100 }) : Promise.resolve(emptyApiPage()),
          canReadMaterials ? apiClient.listMaterials('knowledge-bases', { page: 1, per_page: 100 }) : Promise.resolve(emptyApiPage()),
          canReadDistribution ? apiClient.listDistributionChannels() : Promise.resolve(emptyApiPage()),
          canReadDistribution ? apiClient.listDistributionJobs({ page: 1, per_page: 100 }) : Promise.resolve(emptyApiPage()),
          // 托管站点是**特性开关**控制的能力（GEOFLOW_HOSTED_SITES_ENABLED）：关掉的部署里
          // 后端按设计返回 404 —— 那是「这个实例没开这个功能」，不是故障，不该把整页打成
          // 「请求无法完成」（它在 Promise.all 里，会把上面十来个请求一起拖垮）。
          canReadDistribution && apiSession?.admin.role === 'super_admin'
            ? apiClient.listHostedSites({ page: 1, per_page: 100 }).catch((reason: unknown) => {
              if (reason instanceof GeoFlowApiError && reason.status === 404) return emptyApiPage();
              throw reason;
            })
            : Promise.resolve(emptyApiPage()),
          canReadModels ? apiClient.listAiModels() : Promise.resolve(emptyApiPage()),
          canReadModels ? apiClient.listPrompts() : Promise.resolve(emptyApiPage()),
          // 「概览大盘」的真实数字来源；取不到就保持 null，界面显示「—」。
          canReadAnalytics ? apiClient.getAnalyticsOverview({ preset: '30d' }) : Promise.resolve(null),
        ]);
        if (cancelled) return;

        const mappedArticles = mapArticles(articlePage);
        const mappedTrashedArticles = mapArticles(trashArticlePage);
        const mappedTasks = mapTasks(taskPage);
        const mappedKnowledge = (knowledgePage.items || []).map(mapKnowledgeBase);
        const mappedChannels = (distributionPage.items || []).map(mapDistributionChannel);
        const mappedModels = (aiModelsPage.items || [])
          .map((item) => mapCatalogModels([item])[0])
          .filter((item): item is AiModelConfig => Boolean(item));
        const mappedPrompts = (promptsPage.items || []).map(mapApiPrompt);
        const resolvedKnowledge = canReadMaterials && mappedKnowledge.length > 0
          ? mappedKnowledge
          : canReadMaterials ? mapCatalogKnowledgeBases(catalog.knowledge_bases) : [];
        setApiCatalog(catalog);
        setCategories(mapCatalogCategories(catalog.categories));
        setModels(mappedModels.length > 0 ? mappedModels : mapCatalogModels(catalog.models));
        setPrompts(mappedPrompts.length > 0 ? mappedPrompts : mapCatalogPrompts(catalog.prompts));
        setArticles(mappedArticles);
        setTrashedArticles(mappedTrashedArticles);
        setTasks(mappedTasks);
        setKnowledgeBases(resolvedKnowledge);
        setChannels(mappedChannels);
        setHostedSites(hostedSitesPage.items || []);
        setDistributionJobs(distributionJobsPage.items || []);
        setAnalyticsOverview(analyticsOverviewData ? asRecord(analyticsOverviewData) : null);
        setChunkLoadErrors({});

        // The shell and primary lists are usable before the optional chunk
        // hydration finishes.  Do not keep the whole application behind a
        // full-screen spinner while a slow knowledge-base item endpoint is
        // loading; the knowledge pane reports its own loading/error state.
        setApiBooting(false);

        // Load each knowledge base's chunks so selecting another base never
        // leaves the right-hand pane showing the first base's data.
        const chunkPages = canReadMaterials ? await Promise.all(resolvedKnowledge.map(async (base) => {
          try {
            return {
              id: base.id,
              page: await apiClient.listMaterialItems('knowledge-bases', base.id, {
                page: 1,
                per_page: 100,
              }),
            };
          } catch (error) {
            // Authentication failures must reach the outer handler.  Other
            // failures are retained per library so “no chunks” is never shown
            // as if the backend had returned an empty result.
            if (error instanceof GeoFlowApiError && error.status === 401) throw error;
            return {
              id: base.id,
              page: undefined,
              error: error instanceof Error ? error.message : '读取切片失败',
            };
          }
        })) : [];
        if (!cancelled) {
          setChunks(chunkPages.flatMap(({ id, page }) => mapKnowledgeChunks(page, id)));
          const errors = Object.fromEntries(
            chunkPages
              .filter((entry) => Boolean(entry.error))
              .map((entry) => [entry.id, String(entry.error)]),
          );
          setChunkLoadErrors(errors);
          if (Object.keys(errors).length > 0) {
            setApiError(new GeoFlowApiError(
              lang === 'zh' ? '部分知识库切片加载失败' : 'Some knowledge chunks could not be loaded',
              0,
              'chunk_load_failed',
              { knowledge_base_ids: Object.keys(errors) },
            ));
          }
        }

        setStats({
          total_articles: Number(articlePage.pagination?.total ?? mappedArticles.length),
          published_articles: mappedArticles.filter((article) => article.status === 'published').length,
          pending_review: mappedArticles.filter((article) => article.reviewStatus === 'pending').length,
          total_tasks: Number(taskPage.pagination?.total ?? mappedTasks.length),
          active_tasks: mappedTasks.filter((task) => task.status === 'running').length,
          knowledge_bases: Number(knowledgePage.pagination?.total ?? resolvedKnowledge.length),
          knowledge_chunks: resolvedKnowledge.reduce((total, base) => total + base.chunkCount, 0),
          // 「分发渠道」卡片此前读的键没人写，恒显示「—」。真实来源就是渠道列表的总数。
          distribution_channels: Number(distributionPage.pagination?.total ?? mappedChannels.length),
        });
      } catch (error) {
        if (cancelled) return;
        const apiFailure = error instanceof GeoFlowApiError
          ? error
          : new GeoFlowApiError(lang === 'zh' ? '无法读取 桐灼GEO 数据' : 'Unable to load 桐灼GEO data', 0);
        setApiError(apiFailure);
        if (apiFailure.status === 401) setApiSession(null);
      } finally {
        window.clearTimeout(bootDeadline);
        if (!cancelled) {
          setApiBooting(false);
          setBootDataLoading(false);
        }
      }
    };

    fetchApiData();
    return () => {
      cancelled = true;
      window.clearTimeout(bootDeadline);
    };
  }, [apiClient, apiEnabled, apiReloadToken, apiSession, lang]);

  const reportApiError = (error: unknown, fallbackMessage: string): GeoFlowApiError => {
    const failure = error instanceof GeoFlowApiError
      ? error
      : new GeoFlowApiError(fallbackMessage, 0, 'client_error');
    setApiError(failure);
    if (failure.status === 401) setApiSession(null);
    return failure;
  };

  const stopTaskJobPolling = (taskId: string) => {
    const timer = taskPollTimers.current.get(taskId);
    if (timer) clearTimeout(timer);
    taskPollTimers.current.delete(taskId);
    taskPollAttempts.current.delete(taskId);
    taskPollFailures.current.delete(taskId);
  };

  /**
   * Poll a concrete task_runs record after start/enqueue.  Task list snapshots
   * are intentionally not treated as a completed job: the worker may still be
   * generating, waiting on quality gates, or have failed asynchronously.
   */
  const startTaskJobPolling = (taskId: string, jobId: string) => {
    if (!jobId) return;
    stopTaskJobPolling(taskId);
    taskPollAttempts.current.set(taskId, 0);
    taskPollFailures.current.set(taskId, 0);

    const terminalStatuses = new Set(['completed', 'succeeded', 'success', 'failed', 'cancelled', 'canceled']);
    const poll = async () => {
      if (!apiClient.authenticated) {
        stopTaskJobPolling(taskId);
        return;
      }

      const attempts = (taskPollAttempts.current.get(taskId) || 0) + 1;
      taskPollAttempts.current.set(taskId, attempts);
      if (attempts > 60) {
        stopTaskJobPolling(taskId);
        reportApiError(new GeoFlowApiError('任务作业轮询已超时，请稍后手动刷新', 0, 'job_poll_timeout'), '任务作业轮询已超时');
        return;
      }

      try {
        const job = asRecord(await apiClient.getJob(jobId));
        if (!taskPollAttempts.current.has(taskId)) return;
        taskPollFailures.current.set(taskId, 0);
        const status = String(job.status || '').trim().toLowerCase();
        const errorCode = String(job.error_code || '').trim();
        const errorMessage = String(job.error_message || '').trim();
        setTasks((prev) => prev.map((task) => task.id === taskId
          ? {
              ...task,
              latestJobId: String(job.id || jobId),
              latestJobStatus: status || task.latestJobStatus,
              batchStatus: status || task.batchStatus,
              latestJobErrorCode: errorCode || task.latestJobErrorCode,
              batchErrorMessage: errorMessage || task.batchErrorMessage,
            }
          : task));

        if (terminalStatuses.has(status)) {
          stopTaskJobPolling(taskId);
          // Pull the authoritative task/article projection once the worker has
          // reached a terminal state so generated articles and counters appear.
          setApiReloadToken((value) => value + 1);
          return;
        }
      } catch (error) {
        if (!taskPollAttempts.current.has(taskId)) return;
        const failures = (taskPollFailures.current.get(taskId) || 0) + 1;
        taskPollFailures.current.set(taskId, failures);
        if (failures >= 3) {
          stopTaskJobPolling(taskId);
          reportApiError(error, '无法读取任务作业状态');
          return;
        }
      }

      if (!taskPollAttempts.current.has(taskId)) return;
      const timer = setTimeout(() => void poll(), 3000);
      taskPollTimers.current.set(taskId, timer);
    };

    void poll();
  };

  const startLatestTaskJobPolling = async (taskId: string, jobId?: string) => {
    let resolvedJobId = jobId;
    if (!resolvedJobId) {
      try {
        const result = asRecord(await apiClient.listTaskJobs(taskId, { limit: 1 }));
        const items = Array.isArray(result.items) ? result.items : [];
        const latest = asRecord(items[0]);
        if (latest.id !== undefined && latest.id !== null) resolvedJobId = String(latest.id);
      } catch {
        // The task projection remains useful even if the optional job lookup
        // is temporarily unavailable; the next page reload can retry it.
      }
    }
    if (resolvedJobId) {
      startTaskJobPolling(taskId, resolvedJobId);
    }
  };

  useEffect(() => () => {
    taskPollTimers.current.forEach((timer) => clearTimeout(timer));
    taskPollTimers.current.clear();
    taskPollAttempts.current.clear();
    taskPollFailures.current.clear();
  }, []);

  // Handlers: 只有一种模式——全部经 GeoFlowApiClient 走 GEOFlow API。
  // 历史的 Express 演示分支已随演示层一并删除（见 api/config.ts 的说明）。
  const handleSaveArticle = async (newArt: Partial<Article>) => {
    if (apiEnabled) {
      try {
        const title = String(newArt.title || '').trim();
        const content = String(newArt.content || '').trim();
        const category = categories.find((item) => item.name === newArt.category)
          || categories[0];
        const authorRecord = apiCatalog.authors[0];
        const categoryId = recordId(newArt.apiCategoryId) || recordId(category?.id);
        const authorId = recordId(newArt.apiAuthorId) || recordId(authorRecord?.id);
        if (!title || !content) {
          throw new GeoFlowApiError('文章标题和正文不能为空', 422, 'validation_failed');
        }
        if (!categoryId || !authorId) {
          throw new GeoFlowApiError('桐灼GEO 目录缺少可用的分类或作者，暂时无法创建文章', 422, 'missing_catalog_dependency');
        }

        const payload: ApiRecord = {
          title,
          content,
          excerpt: String(newArt.summary || content.slice(0, 200)),
          keywords: Array.isArray(newArt.seoKeywords) ? newArt.seoKeywords.join(', ') : '',
          meta_description: String(newArt.seoDescription || newArt.summary || ''),
          category_id: categoryId,
          author_id: authorId,
          status: 'draft',
          review_status: 'pending',
          is_ai_generated: false,
        };
        const taskId = recordId(newArt.apiTaskId);
        if (taskId) payload.task_id = taskId;
        if (newArt.slug) payload.slug = String(newArt.slug).trim();

        const saved = mapArticle(await apiClient.createArticle(payload));
        setArticles((prev) => [saved, ...prev.filter((item) => item.id !== saved.id)]);
        setApiError(null);
      } catch (error) {
        reportApiError(error, '无法创建文章');
        throw error;
      }
      return;
    }

    try {
      const res = await fetch('/api/articles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newArt),
      });
      if (res.ok) {
        const saved = await res.json();
        setArticles((prev) => [saved, ...prev]);
      } else {
        setArticles((prev) => [newArt as Article, ...prev]);
      }
    } catch {
      setArticles((prev) => [newArt as Article, ...prev]);
    }
  };

  const handleDeleteArticle = async (id: string) => {
    const confirmed = await confirmAction({
      title: lang === 'zh' ? '删除这篇文章？' : 'Delete this article?',
      description: lang === 'zh'
        ? '文章会移入回收站，之后仍可恢复；不会立刻永久删除。'
        : 'The article moves to trash and can still be restored.',
      confirmLabel: lang === 'zh' ? '移入回收站' : 'Move to trash',
      tone: 'danger',
    });
    if (!confirmed) return;
    if (apiEnabled) {
      try {
        await apiClient.trashArticle(id);
        setArticles((prev) => prev.filter((article) => article.id !== id));
        setApiError(null);
      } catch (error) {
        reportApiError(error, '无法删除文章');
      }
      return;
    }
    try {
      await fetch(`/api/articles/${id}`, { method: 'DELETE' });
    } catch (error) {
      console.error(error);
    }
    setArticles((prev) => prev.filter((article) => article.id !== id));
  };

  const handleRestoreArticle = async (id: string) => {
    try {
      const restored = mapArticle(await apiClient.restoreArticle(id));
      setTrashedArticles((prev) => prev.filter((article) => article.id !== id));
      setArticles((prev) => [restored, ...prev.filter((article) => article.id !== id)]);
      setApiError(null);
      setApiReloadToken((value) => value + 1);
    } catch (error) {
      reportApiError(error, '文章恢复失败');
      throw error;
    }
  };

  const handleForceDeleteArticles = async (ids: string[]) => {
    try {
      await apiClient.batchForceDeleteArticles(ids);
      setTrashedArticles((prev) => prev.filter((article) => !ids.includes(article.id)));
      setApiError(null);
      setApiReloadToken((value) => value + 1);
    } catch (error) {
      reportApiError(error, '文章彻底删除失败');
      throw error;
    }
  };

  const handleEmptyArticleTrash = async () => {
    try {
      await apiClient.emptyArticleTrash();
      setTrashedArticles([]);
      setApiError(null);
      setApiReloadToken((value) => value + 1);
    } catch (error) {
      reportApiError(error, '清空回收站失败');
      throw error;
    }
  };

  const handleExportArticles = async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      const result = asRecord(await apiClient.prepareArticleMarkdownExport(ids));
      const url = String(result.download_url || '');
      if (!url) throw new GeoFlowApiError('导出接口未返回下载地址', 502, 'article_export_invalid_response');
      const absoluteUrl = new URL(url, window.location.origin).toString();
      const blob = await apiClient.downloadArticleMarkdownExport(absoluteUrl);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = String(result.filename || 'geoflow-articles.zip');
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      setApiError(null);
    } catch (error) {
      reportApiError(error, '文章导出失败');
      throw error;
    }
  };

  type BatchArticleAction = 'review' | 'reject' | 'publish' | 'trash' | 'restore' | 'retract';
  const handleBatchArticleAction = async (
    action: BatchArticleAction,
    ids: string[],
  ): Promise<ApiRecord> => {
    if (ids.length === 0) {
      throw new GeoFlowApiError('请至少选择一篇文章', 422, 'validation_failed');
    }

    try {
      const result = action === 'review'
        ? await apiClient.batchReviewArticles(ids, {
            review_status: 'approved',
            review_note: '管理员从内容列表提交批量审核',
          })
        // 「退回修改」是审核结论，不是删除：文章回到草稿、留在列表里等改稿。
        // 早先这里错接成 `trash`，把待改的文章扔进了回收站——那是不可见的破坏。
        : action === 'reject'
          ? await apiClient.batchReviewArticles(ids, {
              review_status: 'rejected',
              review_note: '管理员从连续审核模式退回修改',
            })
        : action === 'publish'
          ? await apiClient.batchPublishArticles(ids)
          : action === 'trash'
            ? await apiClient.batchTrashArticles(ids)
            : action === 'retract'
              // 撤回成草稿：旧后台有、新后台原先缺失的那条路径（补于 2026-09-12）。
              ? await apiClient.batchUpdateArticleStatus(ids, 'draft')
              : await apiClient.batchRestoreArticles(ids);

      // The batch response contains authoritative per-item projections. Apply
      // successful rows immediately, then reload the list so soft-deleted or
      // restored records follow the server's filtering rules.
      const succeeded = Array.isArray(result.succeeded) ? result.succeeded : [];
      const succeededIds = succeeded
        .map((entry) => String(asRecord(entry).article_id || ''))
        .filter(Boolean);
      if (action === 'trash' && succeededIds.length > 0) {
        // Trash results intentionally contain only an audit-safe id/status;
        // never map that small response into a fake article projection.
        setArticles((prev) => prev.filter((article) => !succeededIds.includes(article.id)));
      } else {
        const mapped = succeeded
          .map((entry) => asRecord(asRecord(entry).result))
          .filter((entry) => typeof entry.title === 'string' || typeof entry.status === 'string')
          .map(mapArticle);
        if (mapped.length > 0) {
          setArticles((prev) => prev.map((article) => mapped.find((next) => next.id === article.id) || article));
        }
      }
      setApiError(null);
      // **只有「服务端过滤规则会改变列表成员」的动作才整页重载**：回收站与恢复的逐条
      // 返回里刻意只带审计安全的 id/status（见上），列表得重新向服务端要一遍。
      //
      // 审核 / 发布 / 撤回的响应带的是**完整文章投影**，上面已经逐条应用，再重载一次不只是
      // 多余——重载会把整个外壳换成启动遮罩（`apiBooting` 时 App 提前 return），文章页连同
      // 它挂着的「连续审核模式」一起被卸载、本地 state 归零。实测后果就是**每审一篇就被
      // 弹出审核模式**，计划里承诺的「连续过审」根本连续不起来。
      if (action === 'trash' || action === 'restore') {
        setApiReloadToken((value) => value + 1);
      }
      return result;
    } catch (error) {
      reportApiError(error, '文章批量操作失败');
      throw error;
    }
  };

  const handlePublishArticle = async (id: string) => {
    if (apiEnabled) {
      const replaceArticle = (next: Article) => {
        setArticles((prev) => prev.map((article) => (article.id === id ? next : article)));
        setActiveArticleModal(next);
      };
      const invalidWorkflowResponse = (stage: 'review' | 'publish', article?: Article) => new GeoFlowApiError(
        stage === 'review'
          ? '审核接口返回的状态不可继续发布，请刷新后重试'
          : '发布接口未确认文章已上线，请刷新后确认',
        502,
        stage === 'review' ? 'article_review_incomplete' : 'article_publish_incomplete',
        {
          stage,
          article_status: article ? workflowStatus(article) : null,
          review_status: article ? reviewStatus(article) : null,
        },
      );

      try {
        // A previous attempt may have completed review but lost the publish
        // response.  The local projection then already says approved/draft;
        // continue with publish directly instead of recording another review.
        let current = articles.find((article) => article.id === id);
        let action = publicationAction(current);

        // If a list projection is incomplete or has an unknown state, refresh
        // the authoritative detail before choosing a mutation.  This prevents
        // a malformed/stale display value from issuing an unsafe publish call.
        if (current && (action === 'invalid' || !hasRawWorkflowStatus(current))) {
          current = mapArticle(await apiClient.getArticle(id));
          replaceArticle(current);
          action = publicationAction(current);
        }

        if (action === 'done') {
          // The server already reports a terminal published state.  There is
          // no second mutation to issue; this also covers a stale modal click.
          if (current && isPublishedWorkflow(current)) replaceArticle(current);
          setApiError(null);
          return;
        }

        let candidate = current;
        if (action === 'review') {
          // Publishing is a two-step governed transition.  The review call is
          // intentionally explicit so risk and AI quality gates can reject it.
          candidate = mapArticle(await apiClient.reviewArticle(id, {
            review_status: 'approved',
            review_note: '管理员从内容审核页提交发布',
          }));
          const reviewedAction = publicationAction(candidate, 'after_review');
          // Keep an approved draft in local state even when the following
          // publish request fails; a retry can then call publish only.
          replaceArticle(candidate);
          if (reviewedAction === 'done') {
            // 桐灼GEO may complete the workflow during review when the linked
            // task has need_review disabled.  Do not re-run publish gates.
            setApiError(null);
            return;
          }
          if (reviewedAction !== 'publish') {
            throw invalidWorkflowResponse('review', candidate);
          }
        } else if (action !== 'publish' || !candidate) {
          throw invalidWorkflowResponse('review', candidate);
        }

        const published = mapArticle(await apiClient.publishArticle(id));
        if (publicationAction(published, 'after_review') !== 'done') {
          replaceArticle(published);
          throw invalidWorkflowResponse('publish', published);
        }
        replaceArticle(published);
        setApiError(null);
      } catch (error) {
        reportApiError(error, '文章未通过 桐灼GEO 质量或风险门禁');
        // ArticleModal awaits this handler so it can keep the article open and
        // show the gate failure instead of closing on a rejected publish.
        throw error;
      }
      return;
    }
    try {
      await fetch(`/api/articles/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'published' }),
      });
    } catch (error) {
      console.error(error);
    }
    setArticles((prev) => prev.map((article) => (article.id === id ? { ...article, status: 'published' } : article)));
  };

  const handleUpdateArticle = async (updated: Article): Promise<Article | void> => {
    if (apiEnabled) {
      try {
        const payload: ApiRecord = {
          title: updated.title,
          content: updated.content,
          excerpt: updated.summary,
          keywords: updated.seoKeywords.join(', '),
          meta_description: updated.seoDescription || updated.summary,
        };
        if (updated.apiCategoryId) payload.category_id = updated.apiCategoryId;
        if (updated.apiAuthorId) payload.author_id = updated.apiAuthorId;
        const saved = mapArticle(await apiClient.updateArticle(updated.id, payload));
        setArticles((prev) => prev.map((article) => (article.id === saved.id ? saved : article)));
        setActiveArticleModal(saved);
        setApiError(null);
        return saved;
      } catch (error) {
        reportApiError(error, '无法保存文章修改');
        // The modal needs a rejected promise to keep the edit form and the
        // unsaved values visible after a quality/risk gate or validation error.
        throw error;
      }
      return undefined;
    }
    await handleSaveArticle(updated);
    setActiveArticleModal(updated);
    return updated;
  };

  /**
   * 把文章加入分发队列，并把结果写回本地状态。**失败会抛出。**
   *
   * 拆出来是因为存在两种调用方：列表行上的「分发」点了就走（失败弹一条错误提示就够了），
   * 而文章弹窗里的「发布并分发」必须知道分发到底成没成——它要显示的是一条
   * 「已发布并分发到 N 个渠道」的结论文案，吞掉失败就等于给了一句假承诺。
   */
  const queueArticleDistribution = async (id: string, channelIds: string[]): Promise<number> => {
    const result = asRecord(await apiClient.distributeArticle(id, channelIds));
    const items = Array.isArray(result.items) ? result.items as ApiRecord[] : [];
    const distributedTo = items
      .map((item) => asRecord(asRecord(item.channel)))
      .map((channel) => String(channel.name || channel.domain || '').trim())
      .filter(Boolean);
    setArticles((prev) => prev.map((article) => (article.id === id
      ? { ...article, distributedTo: distributedTo.length > 0 ? distributedTo : article.distributedTo }
      : article)));
    setApiError(null);
    const refreshedJobs = await apiClient.listDistributionJobs({ page: 1, per_page: 100 });
    setDistributionJobs(refreshedJobs.items || []);
    return items.length || distributedTo.length;
  };

  const handleDistributeArticle = async (id: string, channelIds?: string[]) => {
    if (apiEnabled) {
      try {
        const queued = await queueArticleDistribution(id, channelIds || []);
        toast.success(
          lang === 'zh' ? '已加入分发队列' : 'Queued for distribution',
          lang === 'zh' ? `将投递到 ${queued} 个渠道；到「分发渠道」页可以看投递结果。` : `Delivering to ${queued} channels; track it on the Channels page.`,
        );
      } catch (error) {
        reportApiError(error, '文章分发入队失败');
      }
      return;
    }
    try {
      const res = await fetch(`/api/articles/${id}/distribute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelIds }),
      });
      if (res.ok) {
        const data = await res.json();
        setArticles((prev) => prev.map((article) => (article.id === id ? { ...article, distributedTo: data.distributedTo } : article)));
        toast.success(lang === 'zh' ? '分发成功' : 'Distributed', lang === 'zh' ? '远端站点已接收并触发静态页编译。' : 'The remote site accepted it and started building.');
      }
    } catch (error) {
      console.error(error);
    }
  };

  /**
   * 文章弹窗的「发布并分发」：先过发布门禁，再让服务端按文章所属任务已绑定的启用渠道投递。
   *
   * 渠道列表传空数组是**刻意的**：`POST articles/{id}/distribute` 只接受「已绑到该任务且
   * 启用中」的渠道 id（否则 409 `distribution_channel_not_bound`），而那份绑定清单前端拿不到
   * ——传空数组时服务端按任务边界自己解析，也是既有调用点一直在用的方式。
   *
   * 两步都**不做错误兜底**：任何一步失败都往上抛给弹窗显示（尤其渠道为空时后端会明确报
   * 「没有可用的活动分发渠道，请先配置并关联渠道」）。这里刻意不复用
   * `handleDistributeArticle`——那个函数成功后会 alert，而弹窗自己会给出结论文案，
   * 两条提示叠在一起只会让人以为发了两遍。
   */
  const handlePublishAndDistributeArticle = async (id: string): Promise<void> => {
    await handlePublishArticle(id);
    await queueArticleDistribution(id, []);
  };

  const handleRetryDistribution = async (id: string) => {
    try {
      const result = asRecord(await apiClient.retryDistribution(id));
      const retried = asRecord(result.job || result);
      setDistributionJobs((prev) => prev.map((job) => String(job.id) === String(retried.id || id) ? { ...job, ...retried } : job));
      setApiError(null);
    } catch (error) {
      reportApiError(error, '分发任务重试失败');
    }
  };

  /**
   * 分发任务列表的轮询读取入口。
   *
   * 「排队中/发送中」的任务不会自己走到终态，而列表只在启动和用户操作时刷新，
   * 所以 DistributionView 在存在未终态任务时按需调用这里重新拉取（请求与启动一致）。
   */
  const handleRefreshDistributionJobs = async () => {
    const page = await apiClient.listDistributionJobs({ page: 1, per_page: 100 });
    setDistributionJobs(page.items || []);
  };

  const handleCreateTask = async (taskData: Partial<Task> & Record<string, unknown>) => {
    if (apiEnabled) {
      try {
        const created = mapTask(await apiClient.createTask(taskData));
        setTasks((prev) => [created, ...prev.filter((task) => task.id !== created.id)]);
        setApiError(null);
      } catch (error) {
        reportApiError(error, '无法创建任务');
        throw error;
      }
      return;
    }
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskData),
      });
      if (res.ok) {
        const newTask = await res.json();
        setTasks((prev) => [newTask, ...prev]);
      }
    } catch (error) {
      console.error(error);
    }
  };

  const handleUpdateTask = async (taskId: string, taskData: Record<string, unknown>) => {
    try {
      const result = asRecord(await apiClient.updateTask(taskId, taskData));
      const projected = asRecord(result.task || result);
      const updated = mapTask(projected);
      setTasks((prev) => prev.map((task) => (task.id === updated.id ? { ...task, ...updated } : task)));
      setApiError(null);
    } catch (error) {
      reportApiError(error, '任务更新失败');
      throw error;
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    try {
      await apiClient.deleteTask(taskId);
      stopTaskJobPolling(taskId);
      setTasks((prev) => prev.filter((task) => task.id !== taskId));
      setApiError(null);
    } catch (error) {
      reportApiError(error, '任务删除失败');
      throw error;
    }
  };

  /**
   * 人工放行某篇文章的 AI 质检（判定为「待人工复核」时唯一的出路）。
   * 放行后立刻刷新这篇文章的投影，让连续审核模式/详情面板马上看到 is_overridden。
   */
  const handleReleaseArticleAiQuality = async (id: string, reason: string) => {
    const result = await apiClient.overrideArticleAiQuality(id, reason);
    try {
      const detail = mapArticle(await apiClient.getArticle(id));
      if (detail.id) {
        setArticles((prev) => prev.map((article) => (article.id === detail.id ? detail : article)));
        setActiveArticleModal((current) => (current && current.id === detail.id ? detail : current));
      }
    } catch {
      // 投影刷新失败不影响放行本身（后端已记录），下次刷新会补齐。
    }
    return result;
  };

  const handleRunTask = async (taskId: string) => {
    if (apiEnabled) {
      try {
        const result = asRecord(await apiClient.startTask(taskId, true));
        const projected = asRecord(result.task || result);
        const updated = mapTask(projected);
        const startedJobId = recordId(result.started_job_id) || recordId(projected.started_job_id);
        setTasks((prev) => prev.map((task) => (task.id === updated.id
          ? {
              ...task,
              ...updated,
              ...(startedJobId ? {
                latestJobId: String(startedJobId),
                latestJobStatus: 'pending',
                batchStatus: 'pending',
              } : {}),
            }
          : task)));
        if (startedJobId) {
          startTaskJobPolling(taskId, String(startedJobId));
        } else {
          void startLatestTaskJobPolling(taskId);
        }
        setApiError(null);
        toast.success(
          lang === 'zh' ? '已提交生成队列' : 'Queued for generation',
          lang === 'zh' ? '文章会在后台生成并过质检门禁，约 1 分钟后到「文章与审核」查看。' : 'The article appears in Articles & Review in about a minute.',
        );
      } catch (error) {
        reportApiError(error, '任务未能启动');
      }
      return;
    }
    try {
      const res = await fetch(`/api/tasks/${taskId}/run`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.article) setArticles((prev) => [data.article, ...prev]);
        if (data.task) setTasks((prev) => prev.map((task) => (task.id === taskId ? data.task : task)));
        toast.success(data.message ? String(data.message) : (lang === 'zh' ? '任务已执行完成' : 'Task executed'));
      }
    } catch (error) {
      console.error('Task run failed:', error);
    }
  };

  const handleStopTask = async (taskId: string) => {
    try {
      const result = asRecord(await apiClient.stopTask(taskId));
      const projected = asRecord(result.task || result);
      const updated = mapTask(projected);
      stopTaskJobPolling(taskId);
      setTasks((prev) => prev.map((task) => (task.id === updated.id ? { ...task, ...updated } : task)));
      setApiError(null);
    } catch (error) {
      reportApiError(error, '任务未能停止');
    }
  };

  const handleEnqueueTask = async (taskId: string) => {
    try {
      const result = asRecord(await apiClient.enqueueTask(taskId));
      const queuedJobId = recordId(result.job_id);
      const queuedStatus = String(result.status || 'pending');
      setTasks((prev) => prev.map((task) => (task.id === taskId
        ? {
            ...task,
            latestJobId: queuedJobId ? String(queuedJobId) : task.latestJobId,
            latestJobStatus: queuedStatus,
            batchStatus: queuedStatus,
            batchErrorMessage: undefined,
          }
        : task)));
      if (queuedJobId) startTaskJobPolling(taskId, String(queuedJobId));
      else void startLatestTaskJobPolling(taskId);
      setApiError(null);
    } catch (error) {
      reportApiError(error, '任务未能入队');
    }
  };

  /** Read-only task operations used by the task page's monitoring panels. */
  const handleLoadTaskWorkers = async (): Promise<ApiRecord> => {
    try {
      const result = await apiClient.getTaskWorkers({ page: 1, per_page: 50 });
      setApiError(null);
      return result;
    } catch (error) {
      reportApiError(error, '无法读取 Worker 状态');
      throw error;
    }
  };

  const handleLoadTaskTrash = async (
    params: Record<string, string | number | undefined> = {},
  ): Promise<ApiRecord> => {
    try {
      const result = await apiClient.listTrashedTasks(params);
      setApiError(null);
      return result;
    } catch (error) {
      reportApiError(error, '无法读取任务回收站');
      throw error;
    }
  };

  const handleRestoreTask = async (taskId: string, trashSequence: number): Promise<void> => {
    try {
      await apiClient.restoreTask(taskId, trashSequence);
      setApiError(null);
      setApiReloadToken((value) => value + 1);
    } catch (error) {
      reportApiError(error, '任务恢复失败');
      throw error;
    }
  };

  const handleCheckTaskTitleReadiness = async (
    params: Record<string, string | number | undefined>,
  ): Promise<ApiRecord> => {
    try {
      const result = await apiClient.getTaskTitleReadiness(params);
      setApiError(null);
      return result;
    } catch (error) {
      reportApiError(error, '无法检查标题库就绪度');
      throw error;
    }
  };

  const handleCreateKb = async (name: string, description: string, content = '') => {
    if (apiEnabled) {
      try {
        const result = asRecord(await apiClient.createMaterial('knowledge-bases', {
          name: name.trim(),
          description: description.trim(),
          content,
          file_type: 'markdown',
        }));
        const item = asRecord(result.item || result);
        const created = mapKnowledgeBase(item);
        setKnowledgeBases((prev) => [created, ...prev.filter((base) => base.id !== created.id)]);
        setApiCatalog((prev) => ({
          ...prev,
          knowledge_bases: [item, ...prev.knowledge_bases.filter((base) => String(base.id) !== created.id)],
        }));
        // Chunk indexing is asynchronous; leave the pane empty until the
        // backend reports real chunks on the next reload.
        setApiError(null);
      } catch (error) {
        reportApiError(error, '无法创建知识库');
        throw error;
      }
      return;
    }
    try {
      const res = await fetch('/api/knowledge-bases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description }),
      });
      if (res.ok) {
        const newKb = await res.json();
        setKnowledgeBases((prev) => [newKb, ...prev]);
        setChunks((prev) => [...prev, {
          id: `chk-${Date.now()}`,
          kbId: newKb.id,
          title: `${name} 核心概述`,
          content: `${name} 包含了企业业务标准、核心服务指标以及对外公示的技术白皮书语料。`,
          tokenCount: 96,
          hasEmbedding: true,
        }]);
      }
    } catch (error) {
      console.error(error);
    }
  };

  const handleSearchKnowledgeBase = async (knowledgeBaseId: string, query: string, limit = 8) => {
    try {
      const result = await apiClient.searchKnowledgeBase(knowledgeBaseId, query, limit);
      setApiError(null);
      return result.items;
    } catch (error) {
      reportApiError(error, '知识库检索失败');
      throw error;
    }
  };

  const handleApiLogin = async (username: string, password: string) => {
    setApiError(null);
    try {
      const session = await apiClient.login(username, password);
      // Only enter the app-level loading gate after credentials have been
      // accepted; setting it before the request would unmount LoginView and
      // hide its field-level error when authentication fails.
      setApiBooting(true);
      setApiSession(session);
      setCurrentTab('dashboard');
      setApiReloadToken((value) => value + 1);
    } catch (error) {
      setApiBooting(false);
      reportApiError(error, lang === 'zh' ? '登录 桐灼GEO 失败' : 'Unable to sign in to 桐灼GEO');
      throw error;
    }
  };

  const clearApiSession = () => {
    apiClient.clearToken();
    taskPollTimers.current.forEach((timer) => clearTimeout(timer));
    taskPollTimers.current.clear();
    taskPollAttempts.current.clear();
    taskPollFailures.current.clear();
    setApiSession(null);
    setApiError(null);
    setCurrentTab('dashboard');
    setArticles([]);
    setTasks([]);
    setKnowledgeBases([]);
    setChunks([]);
    setChunkLoadErrors({});
    setCategories([]);
    setModels([]);
    setPrompts([]);
    setDistributionJobs([]);
    setHostedSites([]);
    setStats(null);
  };

  const handleApiLogout = async () => {
    try {
      await apiClient.logout();
    } finally {
      clearApiSession();
    }
  };

  /**
   * 编辑器内联助手：把 SSE 帧翻译成「增量回调 + 最终正文」。
   * 流内的 error 帧不能从回调里抛出，所以先记下来、等流结束再抛。
   */
  const handleEditorGenerate = async (
    payload: Record<string, unknown>,
    onDelta: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<string> => {
    let replacement = '';
    let streamed = '';
    let failure: string | null = null;
    await apiClient.streamEditorGeneration(payload, (frame) => {
      if (frame.event === 'delta') {
        const chunk = String(frame.data.content ?? '');
        if (chunk !== '') { streamed += chunk; onDelta(chunk); }
      } else if (frame.event === 'replacement') {
        replacement = String(frame.data.content ?? '');
      } else if (frame.event === 'error') {
        failure = String(frame.data.error_code ?? 'ai_model_unavailable');
      }
    }, { signal });
    if (failure) throw new GeoFlowApiError('编辑器生成中断', 0, failure);
    return replacement !== '' ? replacement : streamed;
  };

  const handleAddChannel = async (channelData: Partial<DistributionChannel>): Promise<{ one_time_secret?: { key_id: string; secret: string } } | undefined> => {
    if (apiEnabled) {
      try {
        const result = asRecord(await apiClient.createDistributionChannel({
          name: channelData.name || '',
          domain: channelData.domain || '',
          endpoint_url: channelData.endpoint_url || channelData.targetUrl || '',
          channel_type: 'geoflow_agent',
          status: channelData.status === 'paused' ? 'paused' : 'active',
        }));
        const created = asRecord(result.channel || result);
        const mapped = mapDistributionChannel(created);
        setChannels((prev) => [mapped, ...prev]);
        setApiError(null);
        return { one_time_secret: (() => {
          const secret = asRecord(result.one_time_secret);
          const keyId = typeof secret.key_id === 'string' ? secret.key_id : '';
          const value = typeof secret.secret === 'string' ? secret.secret : '';
          return keyId && value ? { key_id: keyId, secret: value } : undefined;
        })() };
      } catch (error) {
        reportApiError(error, '创建分发渠道失败');
        throw error;
      }
    }
    try {
      const res = await fetch('/api/distribution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(channelData),
      });
      if (res.ok) {
        const newChannel = await res.json();
        setChannels((prev) => [...prev, newChannel]);
      }
    } catch (error) {
      console.error(error);
    }
  };

  const handleUpdateChannel = async (id: string, payload: ApiRecord): Promise<void> => {
    try {
      const result = asRecord(await apiClient.updateDistributionChannel(id, payload));
      const updated = mapDistributionChannel(asRecord(result.channel || result));
      setChannels((prev) => prev.map((channel) => channel.id === updated.id ? updated : channel));
      setApiError(null);
    } catch (error) {
      reportApiError(error, '更新分发渠道失败');
      throw error;
    }
  };

  const handleSetChannelStatus = async (id: string, active: boolean): Promise<void> => {
    try {
      const result = asRecord(await (active
        ? apiClient.activateDistributionChannel(id)
        : apiClient.pauseDistributionChannel(id)));
      const updated = mapDistributionChannel(asRecord(result.channel || result));
      setChannels((prev) => prev.map((channel) => channel.id === updated.id ? updated : channel));
      setApiError(null);
    } catch (error) {
      reportApiError(error, active ? '启用分发渠道失败' : '暂停分发渠道失败');
      throw error;
    }
  };

  /**
   * 查看渠道密钥明文。门禁是**超管 + 二次密码**，密码错了服务端回 403，
   * 这里原样透出错误而不是把它说成「网络问题」。
   */
  const handleRevealChannelSecret = async (id: string, password: string): Promise<{ key_id: string; secret: string; endpoint_url?: string } | undefined> => {
    try {
      const result = asRecord(await apiClient.revealDistributionChannelSecret(id, password));
      setApiError(null);
      return {
        key_id: String(result.key_id ?? ''),
        secret: String(result.secret ?? ''),
        ...(typeof result.endpoint_url === 'string' ? { endpoint_url: result.endpoint_url } : {}),
      };
    } catch (error) {
      reportApiError(error, '查看分发渠道密钥失败');
      throw error;
    }
  };

  const handleDownloadChannelPackage = async (id: string, password: string): Promise<void> => {
    try {
      const blob = await apiClient.downloadDistributionChannelPackage(id, password);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `distribution-channel-${id}-package.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      setApiError(null);
    } catch (error) {
      reportApiError(error, '下载渠道接入包失败');
      throw error;
    }
  };

  /**
   * 同步「站点设置 → 渠道前端」。预览与执行**必须用同一个 scope**，
   * 否则会出现「预览看的是 A、同步下去的是 B」。
   */
  const handlePreviewSettingsSync = async (scope: 'all' | 'selected', channelIds: string[]): Promise<Record<string, unknown>> => {
    try {
      const result = asRecord(await apiClient.previewDistributionSettingsSync(
        scope,
        scope === 'selected' ? { channel_ids: channelIds.map(Number) } : {},
      ));
      setApiError(null);
      return asRecord(result.report ?? result);
    } catch (error) {
      reportApiError(error, '同步预览失败');
      throw error;
    }
  };

  const handleSyncSettings = async (scope: 'all' | 'selected', channelIds: string[], confirmed: boolean): Promise<Record<string, unknown>> => {
    try {
      const payload = { frontend_sync_confirmed: confirmed };
      const result = scope === 'all'
        ? asRecord(await apiClient.syncAllDistributionSettings(payload))
        : asRecord(await apiClient.syncSelectedDistributionSettings(channelIds, payload));
      setApiError(null);
      return asRecord(result.report ?? result);
    } catch (error) {
      reportApiError(error, '站点设置同步失败');
      throw error;
    }
  };

  /** 取文章快照给「修正分发内容」预填——分发记录列表里没有正文。 */
  const handleLoadArticleSnapshot = async (articleId: string): Promise<Record<string, unknown>> => {
    try {
      const result = asRecord(await apiClient.getArticle(articleId));
      const article = asRecord(result.article ?? result);
      setApiError(null);
      return article;
    } catch (error) {
      reportApiError(error, '读取文章内容失败');
      throw error;
    }
  };

  const handleUpdateDistributionJob = async (id: string, payload: Record<string, unknown>): Promise<void> => {
    try {
      await apiClient.updateDistributionJob(id, payload, { idempotencyKey: `${id}-${Date.now()}` });
      setApiError(null);
    } catch (error) {
      reportApiError(error, '修正分发内容失败');
      throw error;
    }
  };

  const handleDeleteDistributionJob = async (id: string): Promise<void> => {
    try {
      await apiClient.deleteDistributionJob(id, { idempotencyKey: `${id}-${Date.now()}` });
      setDistributionJobs((previous) => previous.filter((job) => String(job.id) !== id));
      setApiError(null);
    } catch (error) {
      reportApiError(error, '删除分发记录失败');
      throw error;
    }
  };

  const handleRefreshChannelCapabilities = async (id: string): Promise<void> => {
    try {
      await apiClient.refreshDistributionChannelCapabilities(id);
      setApiError(null);
    } catch (error) {
      reportApiError(error, '刷新渠道前端能力失败');
      throw error;
    }
  };

  const handleRotateChannelSecret = async (id: string): Promise<{ key_id: string; secret: string } | undefined> => {
    try {
      const result = asRecord(await apiClient.rotateDistributionChannelSecret(id));
      const updated = mapDistributionChannel(asRecord(result.channel || result));
      setChannels((prev) => prev.map((channel) => channel.id === updated.id ? updated : channel));
      const secret = asRecord(result.one_time_secret);
      const keyId = typeof secret.key_id === 'string' ? secret.key_id : '';
      const value = typeof secret.secret === 'string' ? secret.secret : '';
      setApiError(null);
      return keyId && value ? { key_id: keyId, secret: value } : undefined;
    } catch (error) {
      reportApiError(error, '轮换分发渠道密钥失败');
      throw error;
    }
  };

  const handlePreviewChannelDeletion = async (id: string): Promise<ApiRecord> => {
    try {
      const result = asRecord(await apiClient.previewDistributionChannelDeletion(id));
      setApiError(null);
      return result;
    } catch (error) {
      reportApiError(error, '无法读取渠道删除影响');
      throw error;
    }
  };

  const handlePrepareChannelDeletion = async (id: string): Promise<ApiRecord> => {
    try {
      const result = asRecord(await apiClient.prepareDistributionChannelDeletion(id));
      const updated = mapDistributionChannel(asRecord(result.channel || result));
      setChannels((prev) => prev.map((channel) => channel.id === updated.id ? updated : channel));
      setApiError(null);
      return result;
    } catch (error) {
      reportApiError(error, '准备删除分发渠道失败');
      throw error;
    }
  };

  const handleCancelChannelDeletion = async (id: string): Promise<ApiRecord> => {
    try {
      const result = asRecord(await apiClient.cancelDistributionChannelDeletion(id));
      const updated = mapDistributionChannel(asRecord(result.channel || result));
      setChannels((prev) => prev.map((channel) => channel.id === updated.id ? updated : channel));
      setApiError(null);
      return result;
    } catch (error) {
      reportApiError(error, '取消删除分发渠道失败');
      throw error;
    }
  };

  const handleDeleteChannel = async (id: string, payload: ApiRecord): Promise<ApiRecord> => {
    try {
      const result = asRecord(await apiClient.deleteDistributionChannel(id, payload));
      setChannels((prev) => prev.filter((channel) => channel.id !== id));
      setDistributionJobs((prev) => prev.filter((job) => String(job.channel_id || asRecord(job.channel).id) !== id));
      setApiError(null);
      return result;
    } catch (error) {
      reportApiError(error, '删除分发渠道失败');
      throw error;
    }
  };

  const handleSyncChannel = async (id: string) => {
    if (apiEnabled) {
      try {
        const result = asRecord(await apiClient.healthDistributionChannel(id));
        const updated = mapDistributionChannel(asRecord(result.channel || result));
        setChannels((prev) => prev.map((channel) => channel.id === updated.id ? updated : channel));
        setApiError(null);
      } catch (error) {
        reportApiError(error, '渠道健康检查失败');
      }
      return;
    }
    try {
      const res = await fetch(`/api/distribution/${id}/sync`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setChannels((prev) => prev.map((channel) => (channel.id === id ? { ...channel, lastSyncedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) } : channel)));
        toast.success(data.message ? String(data.message) : (lang === 'zh' ? '同步已完成' : 'Synced'));
      }
    } catch (error) {
      console.error(error);
    }
  };

  const handleSelectDefaultModel = async (id: string) => {
    if (apiEnabled) {
      try {
        const result = asRecord(await apiClient.setDefaultAiModel(id));
        const selectedId = String(asRecord(result.model).id || id);
        setModels((prev) => prev.map((model) => ({
          ...model,
          isDefault: model.id === selectedId,
        })));
        setApiError(null);
      } catch (error) {
        reportApiError(error, '切换默认模型失败');
      }
      return;
    }
    try {
      await fetch('/api/models/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      setModels((prev) => prev.map((model) => ({ ...model, isDefault: model.id === id })));
    } catch (error) {
      console.error(error);
    }
  };

  const handleCreateAiModel = async (payload: Record<string, unknown>) => {
    const record = await apiClient.createAiModel(payload);
    const model = mapCatalogModels([asRecord(record.model || record)])[0];
    if (model) setModels((prev) => [...prev, model]);
  };

  const handleUpdateAiModel = async (id: string, payload: Record<string, unknown>) => {
    const record = await apiClient.updateAiModel(id, payload);
    const model = mapCatalogModels([asRecord(record.model || record)])[0];
    if (model) setModels((prev) => prev.map((item) => item.id === model.id ? model : item));
  };

  const handleDeleteAiModel = async (id: string) => {
    await apiClient.deleteAiModel(id);
    setModels((prev) => prev.filter((item) => item.id !== id));
  };

  const handleTestAiModel = async (id: string) => {
    return apiClient.testAiModel(id);
  };

  const handleCreatePrompt = async (payload: Record<string, unknown>) => {
    const record = await apiClient.createPrompt(payload);
    const prompt = mapApiPrompt(asRecord(record.prompt || record));
    setPrompts((prev) => [...prev, prompt]);
  };

  const handleUpdatePrompt = async (id: string, payload: Record<string, unknown>) => {
    const record = await apiClient.updatePrompt(id, payload);
    const prompt = mapApiPrompt(asRecord(record.prompt || record));
    setPrompts((prev) => prev.map((item) => item.id === prompt.id ? prompt : item));
  };

  const handleDeletePrompt = async (id: string) => {
    await apiClient.deletePrompt(id);
    setPrompts((prev) => prev.filter((item) => item.id !== id));
  };

  /**
   * 复制提示词。
   *
   * 系统内置提示词在 api/v1 里是只读的（PATCH/DELETE 都回 409），
   * **复制是改它们的唯一途径**——所以这个入口对系统条目也要可用。
   */
  const handleCopyPrompt = async (id: string) => {
    const record = await apiClient.copyPrompt(id);
    const prompt = mapApiPrompt(asRecord(record.prompt || record));
    setPrompts((prev) => [prompt, ...prev]);
  };

  const handleSelectArticle = async (article: Article) => {
    setActiveArticleModal(article);
    try {
      const detail = mapArticle(await apiClient.getArticle(article.id));
      setArticles((prev) => prev.map((item) => (item.id === detail.id ? detail : item)));
      setActiveArticleModal(detail);
      setApiError(null);
    } catch (error) {
      reportApiError(error, '无法读取文章详情');
    }
  };

  const navigateToTab = (tab: string) => {
    // `materials:titles` —— 带子视图的导航：直接落在素材库的「标题库」页签。
    // 生成弹窗的「去补充标题 →」用它，用户看到的就该是标题库本身（前置条件的去处）。
    // **意图只对这一次导航有效**：不复位的话，此后每次进素材库都会粘在标题库
    // （复核工作流抓到的 P2——MaterialsView 每次挂载都读初值，而它随页签切换重新挂载）。
    const [baseTab, subView] = tab.split(':');
    setMaterialsTypeIntent(baseTab === 'materials' && subView === 'titles' ? 'title-libraries' : null);
    if (apiEnabled && API_DISABLED_TABS.includes(baseTab)) {
      reportApiError(new GeoFlowApiError('桐灼GEO API v1 尚未提供此功能', 0, 'unsupported_capability'), '当前部署尚未提供此功能');
      return;
    }
    setCurrentTab(baseTab);
    // 点侧栏 = 回到该入口的默认视角：合并入口不要停在上次看过的内层 Tab 上
    // （否则「点了 AI 引用监测 却还停在竞品对比」）。深链进来时仍按 URL 的 view 走。
    setCurrentView(defaultViewOf(baseTab));
  };

  /**
   * 顶栏「AI 创作」/ 总览「开始生成」共用的入口：跳到文章页并**直接打开生成弹窗**。
   * 只跳页不弹窗会让用户落在列表上自己找按钮（旧行为），与按钮名字（创作）不符。
   */
  const openAiGenerate = () => {
    setAiGenerateIntent(true);
    navigateToTab('articles');
  };

  /** 素材库被要求打开的具体资产类型（`materials:titles` 导航设置，此后一直生效到下次导航）。 */
  const [materialsTypeIntent, setMaterialsTypeIntent] = useState<string | null>(null);

  const handleNavigateToArticle = (slugOrTitle: string) => {
    const found = articles.find(
      (article) => article.title === slugOrTitle || article.slug === slugOrTitle || article.title.includes(slugOrTitle),
    );
    if (found) {
      void handleSelectArticle(found);
    } else {
      navigateToTab('articles');
    }
  };

  const apiTaskCatalog = {
    titleLibraries: apiCatalog.title_libraries.map(catalogOption),
    prompts: apiCatalog.prompts.map(catalogOption),
    qualityPrompts: (apiCatalog.quality_prompts || []).map(catalogOption),
    models: models.map((model) => ({ id: model.id, name: model.name, type: model.type })),
    categories: apiCatalog.categories.map(catalogOption),
    authors: apiCatalog.authors.map(catalogOption),
    knowledgeBases: mergeCatalogOptions(
      apiCatalog.knowledge_bases.map(catalogOption),
      knowledgeBases.map((base) => ({ id: base.id, name: base.name })),
    ),
  };

  // 进行中的一次性生成任务：AI 生成弹窗建的任务（非循环、还没产够 article_limit 篇）。
  // 有它在跑，文章页顶部就显示「生成中」占位，并触发下面的轮询。
  const generatingTasks = useMemo(
    () => tasks.filter((task) => task.status === 'running' && task.isLoop !== true && task.generatedCount < task.batchLimit),
    [tasks],
  );

  // —— 总览页「开始使用」清单 ——
  // 每一步的 done 都从**真实数据**推导：目录里有没有可用的内容模型/提示词、有没有知识库、
  // 标题库还有没有可用标题、有没有产出过第一篇文章。刻意不引入「用户点过下一步」这类伪状态，
  // 否则换个浏览器就出现「向导说你没配、页面说你配好了」。
  const [onboardingTitleReadiness, setOnboardingTitleReadiness] = useState<Record<string, TitleLibraryReadiness>>({});
  /**
   * 上面那次探测走到哪一步了。
   *
   * 需要它是因为「正在检查」和「这次没取到」在界面上必须分开：`probeTitleReadiness` 会吞掉
   * 单个库的失败，若每个库都失败，`onboardingTitleReadiness` 就是空的——只按数据判断的话
   * 界面会**永远停在「正在检查标题库存…」**，没人能知道它其实是失败了。
   */
  const [onboardingTitleProbe, setOnboardingTitleProbe] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  /** 从总览向导跳去「文章」页时，直接打开 AI 生成弹窗；处理完立刻清掉。 */
  const [aiGenerateIntent, setAiGenerateIntent] = useState(false);

  // 标题库的可用条数只有后端知道，且**只在真的打开总览、且还没产出过内容时才问**——
  // 清单一旦不会出现，这几个请求就是纯浪费（本地 dev 每个请求要几秒）。
  const onboardingLibraryKey = apiTaskCatalog.titleLibraries.map((library) => String(library.id)).join(',');
  useEffect(() => {
    if (!apiEnabled || !apiClient.authenticated || currentTab !== 'dashboard') return;
    if (articles.length > 0 || tasks.length > 0) return;
    if (onboardingLibraryKey === '') {
      setOnboardingTitleReadiness({});
      return;
    }
    let cancelled = false;
    setOnboardingTitleProbe('loading');
    void (async () => {
      const next = await probeTitleReadiness(
        (params) => apiClient.getTaskTitleReadiness(params),
        apiTaskCatalog.titleLibraries,
      );
      if (cancelled) return;
      setOnboardingTitleReadiness(next);
      // 一个库都没问到 = 这次没取到，界面要说得出这句话，而不是永远转在「正在检查」上。
      setOnboardingTitleProbe(Object.keys(next).length > 0 ? 'ready' : 'failed');
    })();
    return () => { cancelled = true; };
    // apiTaskCatalog 每次渲染都是新对象，用它的 id 清单当依赖（清单变了才重问）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiEnabled, apiClient, currentTab, onboardingLibraryKey]);

  const canGenerateArticle = apiEnabled
    && hasScope(apiSession, 'catalog:read')
    && hasScope(apiSession, 'tasks:write');

  const gettingStartedSteps = useMemo<GettingStartedStep[]>(() => {
    if (!apiEnabled) return [];
    const zh = lang === 'zh';

    // **只要产出过内容就不再显示这张清单。**
    // 它的目标读者是「还没开工的人」；判据一旦放宽到「每一项都配好」，一个用完了标题的
    // 标题库就会让清单在成熟部署上永久常驻——那是噪音，而且会把已经会用的用户当成新手。
    // 清单消失后由下面那条「下一步」横幅接手，两者不会同时出现。
    if (articles.length > 0 || tasks.length > 0) return [];

    // 判据一律取「AI 生成弹窗自己用的那一份数据」（apiTaskCatalog），
    // 这样清单和弹窗不可能一个说能用、一个说缺东西。
    const chatModels = apiTaskCatalog.models.filter((model) => !model.type || model.type === 'chat');
    const contentPrompts = apiTaskCatalog.prompts;
    const qualityPrompts = apiTaskCatalog.qualityPrompts ?? [];

    const libraries = apiTaskCatalog.titleLibraries;
    const usableTitles = libraries.reduce(
      (sum, library) => sum + (onboardingTitleReadiness[String(library.id)]?.available ?? 0),
      0,
    );
    // 「还在问」「问到了」「没问到」三态必须分开：把一次取数失败说成「标题用完了」
    // 会让人去补一批并不需要的标题，而永远显示「正在检查」则是一个走不到终态的进行中状态。
    const titleProbeFailed = libraries.length > 0 && onboardingTitleProbe === 'failed';

    const openGenerate = () => {
      setAiGenerateIntent(true);
      navigateToTab('articles');
    };

    return [
      {
        key: 'model',
        title: zh ? '配置内容模型' : 'Configure a content model',
        detail: chatModels.length > 0
          ? (zh ? `已配置 ${chatModels.length} 个可用于生成正文的对话模型` : `${chatModels.length} chat models available`)
          : (zh ? '还没有可用于生成正文的对话模型，AI 无法写文章' : 'No chat model available for generation'),
        done: chatModels.length > 0,
        action: { label: zh ? '去配置 →' : 'Configure →', onClick: () => navigateToTab('ai-models') },
      },
      {
        key: 'prompt',
        title: zh ? '配置生成提示词' : 'Configure a generation prompt',
        detail: contentPrompts.length > 0
          ? (zh
              ? `已配置 ${contentPrompts.length} 条生成提示词${qualityPrompts.length === 0 ? '；仍缺质检方案，开启质检门禁前必须补上' : ''}`
              : `${contentPrompts.length} generation prompts`)
          : (zh ? '没有生成提示词，新建生成任务时选不到东西' : 'No generation prompt exists'),
        done: contentPrompts.length > 0,
        action: { label: zh ? '去配置 →' : 'Configure →', onClick: () => navigateToTab('ai-models') },
      },
      {
        key: 'knowledge',
        title: zh ? '准备知识库' : 'Prepare a knowledge base',
        detail: knowledgeBases.length > 0
          ? (zh ? `已有 ${knowledgeBases.length} 个知识库可供正文引用` : `${knowledgeBases.length} knowledge bases`)
          : (zh ? '正文要靠知识库事实支撑，没有它只能凭空写' : 'No knowledge base to ground the content'),
        done: knowledgeBases.length > 0,
        action: { label: zh ? '去新建 →' : 'Create →', onClick: () => navigateToTab('knowledge') },
      },
      {
        key: 'title-library',
        title: zh ? '准备标题库' : 'Prepare a title library',
        detail: libraries.length === 0
          ? (zh ? '还没有标题库，生成任务不知道每篇文章该写什么' : 'No title library yet')
          : usableTitles > 0
            ? (zh ? `可用标题 ${usableTitles} 条` : `${usableTitles} titles available`)
            : titleProbeFailed
              ? (zh ? '这次没读到标题库存量，去素材库确认还有没有可用标题' : 'Could not read title availability')
              : onboardingTitleProbe === 'ready'
                ? (zh ? '标题已全部用完，先补充标题再生成' : 'All titles are used up')
                : (zh ? '正在检查标题库存…' : 'Checking title availability…'),
        done: usableTitles > 0,
        action: { label: zh ? '去补充 →' : 'Add titles →', onClick: () => navigateToTab('materials') },
      },
      {
        key: 'first-article',
        title: zh ? '生成第一篇文章' : 'Generate your first article',
        detail: articles.length > 0 || tasks.length > 0
          ? (zh ? `已有 ${articles.length} 篇文章、${tasks.length} 个任务` : `${articles.length} articles, ${tasks.length} tasks`)
          : (zh ? '上面几步齐了就能开工：选标题库与知识库，建一条生成任务' : 'Once the steps above are green, create a generation task'),
        done: articles.length > 0 || tasks.length > 0,
        action: { label: zh ? '开始生成 →' : 'Generate →', onClick: openGenerate },
        blockedReason: canGenerateArticle
          ? undefined
          : (zh ? '当前账号没有「catalog:read + tasks:write」权限，无法创建生成任务' : 'Missing catalog:read / tasks:write scope'),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiEnabled, lang, apiTaskCatalog, knowledgeBases, articles.length, tasks.length, onboardingTitleReadiness, onboardingTitleProbe, canGenerateArticle]);

  // 有一次性生成任务在跑时，轻量轮询文章与任务列表，让「生成中」占位行自动走到终态、
  // 新文章自动冒出来。刻意不调 setApiReloadToken（那会整页重载、弹出启动遮罩，每 3 秒闪一次
  // 比状态不动更糟）；只用两条 GET，任务跑完（generatingTaskKey 变空）轮询自然停。
  const generatingTaskKey = generatingTasks.map((task) => task.id).join(',');
  useEffect(() => {
    if (!apiEnabled || generatingTaskKey === '' || !apiClient.authenticated) return;
    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      if (attempts > 100) return; // 约 5 分钟兜底，避免任务卡死时无限轮询
      try {
        const [taskPage, articlePage] = await Promise.all([
          apiClient.listTasks({ page: 1, per_page: 100 }),
          apiClient.listArticles({ page: 1, per_page: 100 }),
        ]);
        if (cancelled) return;
        setTasks(mapTasks(taskPage));
        setArticles(mapArticles(articlePage));
      } catch {
        // 单轮读取失败不打断，下一轮再试。
      }
      if (!cancelled) setTimeout(() => void poll(), 3000);
    };
    const timer = setTimeout(() => void poll(), 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [apiEnabled, apiClient, generatingTaskKey]);

  // 编辑器内联助手需要的真实选项：catalog 里的 prompts 服务端已按 type=content 过滤。
  const editorAssistantCatalog = apiEnabled ? {
    knowledgeBases: apiCatalog.knowledge_bases
      .map(catalogOption)
      .map((option) => ({ id: String(option.id), name: option.name })),
    prompts: apiCatalog.prompts
      .map(catalogOption)
      .map((option) => ({ id: String(option.id), name: option.name })),
    // 生成是对话式补全，embedding 模型选了也会被后端拒绝，所以这里只给 chat。
    models: models
      .filter((model) => !model.type || model.type === 'chat')
      .map((model) => ({ id: String(model.id), name: model.name })),
  } : undefined;

  if (apiEnabled && apiBooting) {
    return (
      <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 px-5 py-5 text-center">
          {/* 启动阶段会挡住整个界面直到首屏请求全部返回。dev 环境下单请求基线约 2 秒
              （`php artisan serve` + CLI opcache 关闭），并发排队后更久——没有转圈时
              操作员分不清「在加载」和「卡住了」。 */}
          <LoadingState
            lang={lang}
            variant="inline"
            className="justify-center text-sm text-slate-300"
            label={apiSession
              ? (lang === 'zh' ? '正在从后端读取站点数据…' : 'Loading site data from the backend…')
              : (lang === 'zh' ? '正在检查登录状态…' : 'Checking the session…')}
          />
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            {lang === 'zh'
              ? '首次加载要取文章、任务、知识库、分析等多项数据，稍等一下；期间界面不会显示任何估算值。'
              : 'The first load fetches articles, tasks, knowledge bases and analytics; nothing estimated is ever shown while waiting.'}
          </p>
        </div>
      </main>
    );
  }

  if (apiEnabled && !apiSession) {
    return <LoginView lang={lang} onLogin={handleApiLogin} />;
  }

  const renderUnavailableTab = () => (
    <ApiUnavailableView
      lang={lang}
      title={lang === 'zh' ? '功能正在核验，暂未开放' : 'Capability under verification'}
      description={lang === 'zh'
        ? '当前实现的数据口径或业务语义尚未通过验收。系统不会用演示数字、公式估算或夸大结论代替真实结果。'
        : 'The current data contract or business semantics have not passed acceptance. Demo values and formula-based estimates will not be shown as real results.'}
    />
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex font-sans">
      {/* 窄屏守卫：<1024px 时盖一层「请用桌面浏览器」的受控提示（见组件注释）。 */}
      <DesktopOnlyNotice />

      {/* 2026-09-18 布局重排：设计稿是「侧栏通高、品牌嵌在侧栏顶部、顶栏只盖内容区」，
          原来这里是「顶栏横跨整宽 + 下面一行放侧栏与内容」——品牌会留在顶栏左边的白条上，
          而侧栏顶部空着。现在把侧栏提到最外层、顶栏下移到右侧列。
          收尾结构（main → div → div）没动，只改了开头的嵌套顺序。 */}
      <Sidebar
        currentTab={currentTab}
        onSelectTab={navigateToTab}
        lang={lang}
        mode="geoflow"
        disabledTabs={apiEnabled ? API_DISABLED_TABS : []}
        aiWorkspaceEnabled={aiWorkspaceEnabled}
        aiWorkspaceProbeFailed={aiWorkspaceProbeFailed}
        badgeCounts={{
          articles: articles.filter((a) => a.status === 'review').length,
          tasks: tasks.filter((t) => t.status === 'running').length,
          channels: channels.length,
        }}
        badgesLoading={apiEnabled && bootDataLoading}
      />

      {/* 右侧列：顶栏 + 内容 */}
      <div className="flex-1 flex flex-col overflow-hidden">
      <Header
        lang={lang}
        setLang={setLang}
        hasGeminiKey={hasGeminiKey}
        mode="geoflow"
        adminName={apiSession?.admin.display_name || apiSession?.admin.username}
        adminRole={apiSession?.admin.role}
        onLogout={apiEnabled ? handleApiLogout : undefined}
        onQuickGenerate={apiEnabled && hasScope(apiSession, 'catalog:read') && hasScope(apiSession, 'tasks:write') ? openAiGenerate : undefined}
        onOpenPreview={() => navigateToTab('preview')}
      />

        {/* Content View Container */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 bg-slate-950/90">
          <div className="max-w-7xl mx-auto">
            {apiError && (
              <div className="mb-5 flex flex-col gap-2 rounded-lg border border-red-500/30 bg-red-950/30 px-4 py-3 text-sm text-red-100 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p>{apiError.message}</p>
                  {apiError.requestId && <p className="mt-1 break-all font-mono text-[10px] text-red-300/70">Request ID: {apiError.requestId}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => setApiReloadToken((value) => value + 1)}
                  className="shrink-0 rounded-md border border-red-400/40 px-3 py-1.5 text-xs font-semibold text-red-100 transition hover:bg-red-900/50"
                >
                  {lang === 'zh' ? '重试' : 'Retry'}
                </button>
              </div>
            )}

            {apiEnabled && API_DISABLED_TABS.includes(currentTab)
              ? renderUnavailableTab()
              : currentTab === 'dashboard' && (
              <DashboardView
                stats={stats}
                articles={articles}
                tasks={tasks}
                onNavigate={navigateToTab}
                onSelectArticle={handleSelectArticle}
                lang={lang}
                apiMode={apiEnabled}
                analyticsOverview={analyticsOverview}
                gettingStarted={gettingStartedSteps}
                loading={apiEnabled && bootDataLoading && articles.length === 0}
                onGenerate={apiEnabled && hasScope(apiSession, 'catalog:read') && hasScope(apiSession, 'tasks:write') ? openAiGenerate : undefined}
              />
            )}

            {apiEnabled && currentTab === 'ai-workspace' && (
              <AiWorkspaceView
                apiClient={apiClient}
                lang={lang}
                canRead={hasScope(apiSession, 'workspace:read')}
                canWrite={hasScope(apiSession, 'workspace:write')}
                onNavigate={navigateToTab}
              />
            )}

            {currentTab === 'articles' && (
              <ArticlesView
                articles={articles}
                trashedArticles={trashedArticles}
                categories={categories}
                channels={channels}
                onSelectArticle={handleSelectArticle}
                onDeleteArticle={handleDeleteArticle}
                onBatchAction={apiEnabled ? handleBatchArticleAction : undefined}
                canBatchWrite={hasScope(apiSession, 'articles:write')}
                canBatchPublish={hasScope(apiSession, 'articles:publish')}
                canManageTrash={Boolean(apiSession?.admin && ['super_admin', 'superadmin'].includes(String(apiSession.admin.role).toLowerCase()))}
                onRestoreArticle={apiEnabled ? handleRestoreArticle : undefined}
                onForceDeleteArticles={apiEnabled ? handleForceDeleteArticles : undefined}
                onEmptyTrash={apiEnabled ? handleEmptyArticleTrash : undefined}
                onExportArticles={apiEnabled ? handleExportArticles : undefined}
                onDistributeArticle={handleDistributeArticle}
                onCreateArticle={handleSaveArticle}
                lang={lang}
                apiMode={apiEnabled}
                distributionAvailable={channels.length > 0}
                apiCatalog={apiTaskCatalog}
                knowledgeBases={knowledgeBases}
                onCreateTask={apiEnabled ? handleCreateTask : undefined}
                onCheckTitleReadiness={apiEnabled ? handleCheckTaskTitleReadiness : undefined}
                canGenerate={apiEnabled && hasScope(apiSession, 'catalog:read') && hasScope(apiSession, 'tasks:write')}
                generatingTasks={generatingTasks}
                onNavigate={navigateToTab}
                onReleaseArticle={apiEnabled ? handleReleaseArticleAiQuality : undefined}
                autoOpenAiGenerate={aiGenerateIntent}
                onAutoOpenGenerateHandled={() => setAiGenerateIntent(false)}
                loading={apiEnabled && bootDataLoading && articles.length === 0}
              />
            )}

            {currentTab === 'tasks' && (
              <TasksView
                tasks={tasks}
                categories={categories}
                onCreateTask={handleCreateTask}
                onRunTask={handleRunTask}
                onStopTask={apiEnabled ? handleStopTask : undefined}
                onEnqueueTask={apiEnabled ? handleEnqueueTask : undefined}
                onUpdateTask={apiEnabled ? handleUpdateTask : undefined}
                onDeleteTask={apiEnabled ? handleDeleteTask : undefined}
                onLoadWorkers={apiEnabled ? handleLoadTaskWorkers : undefined}
                onLoadTrash={apiEnabled ? handleLoadTaskTrash : undefined}
                onLoadHealth={apiEnabled ? async () => asRecord(await apiClient.getTaskHealth(1)) : undefined}
                onLoadRecentRuns={apiEnabled ? async () => asRecord(await apiClient.listRecentTaskRuns({ per_page: 10 })) : undefined}
                onRestoreTask={apiEnabled ? handleRestoreTask : undefined}
                onCheckTitleReadiness={apiEnabled ? handleCheckTaskTitleReadiness : undefined}
                onOpenAiGenerate={apiEnabled && hasScope(apiSession, 'catalog:read') && hasScope(apiSession, 'tasks:write') ? openAiGenerate : undefined}
                lang={lang}
                apiMode={apiEnabled}
                scopes={apiSession?.scopes}
                apiCatalog={apiTaskCatalog}
                loading={apiEnabled && bootDataLoading && tasks.length === 0}
              />
            )}

            {currentTab === 'knowledge' && (
              <KnowledgeView
                knowledgeBases={knowledgeBases}
                chunks={chunks}
                onCreateKb={handleCreateKb}
                lang={lang}
                apiMode={apiEnabled}
                // 服务端返回的分页总数（`pagination.total`）。此前没传，apiMode 下列表标题的
                // 计数只能显示「—」，而接口其实是给了这个数的。
                totalCount={apiEnabled ? (stats?.knowledge_bases as number | undefined) : undefined}
                onSearchKnowledgeBase={apiEnabled ? handleSearchKnowledgeBase : undefined}
                chunkLoadErrors={chunkLoadErrors}
                canRead={hasScope(apiSession, 'materials:read')}
                canWrite={hasScope(apiSession, 'materials:write')}
                apiClient={apiEnabled ? apiClient : undefined}
                onKnowledgeBasesChanged={apiEnabled ? async () => { setApiReloadToken((value) => value + 1); } : undefined}
              />
            )}
            {apiEnabled && currentTab === 'materials' && (
              <MaterialsView
                apiClient={apiClient}
                lang={lang}
                canRead={hasScope(apiSession, 'materials:read')}
                canWrite={hasScope(apiSession, 'materials:write')}
                initialType={materialsTypeIntent === 'title-libraries' ? 'title-libraries' : undefined}
              />
            )}

            {currentTab === 'distribution' && (
              <DistributionView
                channels={channels}
                hostedSites={hostedSites}
                distributionJobs={distributionJobs}
                onRefreshDistributionJobs={apiEnabled ? handleRefreshDistributionJobs : undefined}
                onAddChannel={handleAddChannel}
                onSyncChannel={handleSyncChannel}
                onRetryDistribution={handleRetryDistribution}
                onUpdateChannel={apiEnabled ? handleUpdateChannel : undefined}
                onSetChannelStatus={apiEnabled ? handleSetChannelStatus : undefined}
                onRotateChannelSecret={apiEnabled ? handleRotateChannelSecret : undefined}
                onRevealChannelSecret={apiEnabled ? handleRevealChannelSecret : undefined}
                onDownloadChannelPackage={apiEnabled ? handleDownloadChannelPackage : undefined}
                onRefreshChannelCapabilities={apiEnabled ? handleRefreshChannelCapabilities : undefined}
                onPreviewSettingsSync={apiEnabled && isSuperAdminRole(apiSession?.admin.role) ? handlePreviewSettingsSync : undefined}
                onSyncSettings={apiEnabled && isSuperAdminRole(apiSession?.admin.role) ? handleSyncSettings : undefined}
                onLoadArticleSnapshot={apiEnabled ? handleLoadArticleSnapshot : undefined}
                onUpdateDistributionJob={apiEnabled && isSuperAdminRole(apiSession?.admin.role) ? handleUpdateDistributionJob : undefined}
                onDeleteDistributionJob={apiEnabled && isSuperAdminRole(apiSession?.admin.role) ? handleDeleteDistributionJob : undefined}
                onPreviewChannelDeletion={apiEnabled ? handlePreviewChannelDeletion : undefined}
                onPrepareChannelDeletion={apiEnabled ? handlePrepareChannelDeletion : undefined}
                onCancelChannelDeletion={apiEnabled ? handleCancelChannelDeletion : undefined}
                onDeleteChannel={apiEnabled ? handleDeleteChannel : undefined}
                onCreateHostedSite={apiEnabled ? async (payload) => {
                  const result = asRecord(await apiClient.createHostedSite(payload));
                  const site = asRecord(result.hosted_site || result);
                  setHostedSites((prev) => [site, ...prev]);
                  return result;
                } : undefined}
                onHostedSiteAction={apiEnabled ? async (id, action, payload) => {
                  let result: ApiRecord;
                  if (action === 'archive') result = await apiClient.archiveHostedSite(id, String(payload?.hostname || ''), {});
                  else if (action === 'indexing') result = await apiClient.setHostedSiteIndexing(id, payload || {});
                  else if (action === 'preflight') result = await apiClient.preflightHostedSite(id);
                  else if (action === 'activate') result = await apiClient.activateHostedSite(id);
                  else if (action === 'pause') result = await apiClient.pauseHostedSite(id);
                  else result = await apiClient.maintainHostedSite(id);
                  const site = asRecord(result.hosted_site || result);
                  if (Object.keys(site).length > 0) setHostedSites((prev) => prev.map((item) => String(item.id) === String(id) ? { ...item, ...site } : item));
                  return result;
                } : undefined}
                onUpdateHostedSite={apiEnabled ? async (id, payload) => {
                  const result = asRecord(await apiClient.updateHostedSite(id, payload));
                  const site = asRecord(result.hosted_site || result);
                  setHostedSites((prev) => prev.map((item) => String(item.id) === String(id) ? { ...item, ...site } : item));
                  return result;
                } : undefined}
                onAssignHostedArticle={apiEnabled ? async (id, articleId) => apiClient.assignHostedSiteArticle(id, articleId) : undefined}
                canRead={hasScope(apiSession, 'distribution:read')}
                canWrite={hasScope(apiSession, 'distribution:write')}
                canManageSecrets={(hasScope(apiSession, 'distribution:write') && apiSession?.admin.role === 'super_admin')}
                canManageDestructive={(hasScope(apiSession, 'distribution:write') && apiSession?.admin.role === 'super_admin')}
                canManageHostedSites={(hasScope(apiSession, 'distribution:write') && apiSession?.admin.role === 'super_admin')}
                lang={lang}
                apiMode={apiEnabled}
              />
            )}

            {apiEnabled && currentTab === 'manual-publications' && (
              <ManualPublicationsView
                apiClient={apiClient}
                articles={articles}
                lang={lang}
                canRead={hasScope(apiSession, 'articles:read')}
                canWrite={hasScope(apiSession, 'articles:write')}
                isSuperAdmin={isSuperAdminRole(apiSession?.admin.role)}
              />
            )}

            {/* ── GEO 效果 · AI 引用监测：三个同源页面合成一个入口，内部 Tab 切换 ──
                （原「AI 问答监测 / 竞品对比 / 引用测试」三个侧栏入口；三个 id 的深链仍有效） */}
            {(currentTab === 'query_radar' || currentTab === 'competitor' || currentTab === 'sandbox') && (
              <TabbedShell
                icon={Search}
                group={lang === 'zh' ? 'GEO 效果' : 'Results'}
                title={lang === 'zh' ? 'AI 引用监测' : 'AI citations'}
                description={lang === 'zh'
                  ? '看 AI 在回答里怎么提到你：自己的问题有没有被提及、竞品被引用得多不多、换一个问法会不会引用你。'
                  : 'How AI answers treat your brand: mentions, competitor citations, and citation tests.'}
                view={currentView}
                onViewChange={setCurrentView}
                tabs={[
                  {
                    key: 'query_radar', label: lang === 'zh' ? '问答监测' : 'Tracking', icon: Search,
                    render: () => (
                      <QueryRadarView
                        embedded
                        onNavigate={navigateToTab}
                        lang={lang}
                        apiClient={apiEnabled ? apiClient : undefined}
                        canRead={hasScope(apiSession, 'analytics:read')}
                        canCollect={hasScope(apiSession, 'analytics:collect')}
                        canDraft={hasScope(apiSession, 'articles:write')}
                        categories={apiCatalog.categories}
                        authors={apiCatalog.authors}
                        onArticleCreated={(newArt) => {
                          setArticles((prev) => [newArt, ...prev]);
                        }}
                        onOpenArticleModal={(art) => setActiveArticleModal(art)}
                      />
                    ),
                  },
                  {
                    key: 'competitor', label: lang === 'zh' ? '竞品对比' : 'Competitors', icon: Flame,
                    render: () => (
                      <CompetitorRadarView
                        embedded
                        lang={lang}
                        apiClient={apiEnabled ? apiClient : undefined}
                        canRead={hasScope(apiSession, 'analytics:read')}
                        canCollect={hasScope(apiSession, 'analytics:collect')}
                        onNavigateToDraft={() => setCurrentTab('articles')}
                      />
                    ),
                  },
                  {
                    key: 'sandbox', label: lang === 'zh' ? '引用测试' : 'Citation test', icon: Compass,
                    render: () => (
                      <AiSandboxView embedded lang={lang} apiClient={apiEnabled ? apiClient : undefined} />
                    ),
                  },
                ]}
              />
            )}

            {/* ── GEO 诊断 · 可发现性总览：总览 + 页面体检 ── */}
            {apiEnabled && (currentTab === 'seo_dashboard' || currentTab === 'url_scanner') && (
              <TabbedShell
                icon={Activity}
                group={lang === 'zh' ? 'GEO 诊断' : 'Diagnosis'}
                title={lang === 'zh' ? '可发现性总览' : 'Discoverability'}
                description={lang === 'zh'
                  ? '一条链看全：能不能被 AI 抓到 → 有没有被抓 → 有没有被引用 → 带来了什么；也可以拿任意网址单独体检。'
                  : 'Crawlable → crawled → cited → converted; plus a per-URL inspection.'}
                view={currentView}
                onViewChange={setCurrentView}
                tabs={[
                  {
                    key: 'overview', label: lang === 'zh' ? '总览' : 'Overview', icon: Activity,
                    // onNavigate 必须走 navigateToTab：它同时重置内层视图（currentView），
                    // 否则页内的「竞品雷达」会落在合并页的第一个 Tab 上（复核工作流抓到的 P1）。
                    render: () => (
                      <RealSeoDashboardView embedded lang={lang} apiClient={apiClient} onNavigate={navigateToTab} />
                    ),
                  },
                  {
                    key: 'scanner', label: lang === 'zh' ? '页面体检' : 'Page inspector', icon: Globe,
                    render: () => (
                      <UrlScannerView
                        embedded
                        lang={lang}
                        apiClient={apiEnabled ? apiClient : undefined}
                        canRead={hasScope(apiSession, 'materials:read')}
                        canWrite={hasScope(apiSession, 'materials:write')}
                      />
                    ),
                  },
                ]}
              />
            )}




            {apiEnabled && currentTab === 'analytics' && (
              <AnalyticsApiView apiClient={apiClient} lang={lang} scopes={apiSession?.scopes} onNavigate={navigateToTab} />
            )}

            {/* ── GEO 效果 · 见度检测：外部见度GEO 检测系统的数据接入 ── */}
            {apiEnabled && currentTab === 'jiandu' && (
              <JianduView apiClient={apiClient} lang={lang} scopes={apiSession?.scopes} />
            )}

            {/* ── GEO 效果 · 转化与线索：AI 引流归因 + 线索跟进（同一件事的两段） ── */}
            {apiEnabled && (currentTab === 'attribution_funnel' || currentTab === 'leads') && (
              <TabbedShell
                icon={ContactRound}
                group={lang === 'zh' ? 'GEO 效果' : 'Results'}
                title={lang === 'zh' ? '转化与线索' : 'Conversion & leads'}
                description={lang === 'zh'
                  ? 'AI 带来的访问有没有变成客户：先看归因漏斗，再跟进每一条线索。'
                  : 'Whether AI traffic turns into customers: attribution funnel first, then each lead.'}
                view={currentView}
                onViewChange={setCurrentView}
                tabs={[
                  {
                    key: 'funnel', label: lang === 'zh' ? '引流与转化' : 'Traffic & conversion', icon: TrendingUp,
                    render: () => (
                      <AiAttributionFunnelView
                        embedded
                        lang={lang}
                        apiClient={apiEnabled ? apiClient : undefined}
                        canRead={hasScope(apiSession, 'analytics:read')}
                        canWrite={hasScope(apiSession, 'analytics:write')}
                      />
                    ),
                  },
                  {
                    key: 'leads', label: lang === 'zh' ? '线索' : 'Leads', icon: Inbox,
                    render: () => (
                      <LeadManagementView
                        embedded
                        apiClient={apiClient}
                        lang={lang}
                        canRead={hasScope(apiSession, 'leads:read')}
                        canWrite={hasScope(apiSession, 'leads:write')}
                      />
                    ),
                  },
                ]}
              />
            )}

            {currentTab === 'ai-models' && (
              <AiModelsView
                models={models}
                prompts={prompts}
                onSelectDefaultModel={handleSelectDefaultModel}
                lang={lang}
                apiMode={apiEnabled}
                onCreateModel={handleCreateAiModel}
                onUpdateModel={handleUpdateAiModel}
                onDeleteModel={handleDeleteAiModel}
                onTestModel={handleTestAiModel}
                onCreatePrompt={handleCreatePrompt}
                onUpdatePrompt={handleUpdatePrompt}
                onDeletePrompt={handleDeletePrompt}
                onCopyPrompt={apiEnabled ? handleCopyPrompt : undefined}
                canRead={hasScope(apiSession, 'models:read')}
                canWrite={hasScope(apiSession, 'models:write')}
                canManageSourceProviders={(hasScope(apiSession, 'models:read') && hasScope(apiSession, 'models:write') && isSuperAdminRole(apiSession?.admin.role))}
                apiClient={apiEnabled ? apiClient : undefined}
              />
            )}


            {apiEnabled && currentTab === 'admin-settings' && (
              <div className="space-y-6"><AdminSettingsView
                apiClient={apiClient} lang={lang}
                canReadProfile={hasScope(apiSession, 'account:read')} canWriteProfile={hasScope(apiSession, 'account:write')}
                onPasswordChanged={clearApiSession} canReadTokens={hasScope(apiSession, 'tokens:read')} canWriteTokens={hasScope(apiSession, 'tokens:write')}
                canReadAudit={hasScope(apiSession, 'audit:read')} isSuperAdmin={isSuperAdminRole(apiSession?.admin.role)}
              /><SiteSettingsPanel apiClient={apiClient} lang={lang} canRead={hasScope(apiSession, 'seo:read')} canWrite={hasScope(apiSession, 'seo:write')} isSuperAdmin={isSuperAdminRole(apiSession?.admin.role)} /></div>
            )}

            {apiEnabled && currentTab === 'system-updates' && (
              <SystemUpdatesView
                apiClient={apiClient}
                lang={lang}
                canRead={hasScope(apiSession, 'system:read')}
                canWrite={hasScope(apiSession, 'system:write')}
                isSuperAdmin={isSuperAdminRole(apiSession?.admin.role)}
              />
            )}

            {apiEnabled && currentTab === 'robots_policy' && (
              <SeoConfigurationView apiClient={apiClient} lang={lang} initialTab="robots"
                canRead={hasScope(apiSession, 'seo:read')} canWrite={hasScope(apiSession, 'seo:write')} />
            )}
            {/* llmstxt 也必须有自己的分支：它在 ADMIN_TABS 里、后端帮助目录也引用它，
                少了这条「深链进来是空白页」（复核工作流抓到的 P1 回归）。 */}
            {apiEnabled && currentTab === 'llmstxt' && (
              <SeoConfigurationView apiClient={apiClient} lang={lang} initialTab="llms"
                canRead={hasScope(apiSession, 'seo:read')} canWrite={hasScope(apiSession, 'seo:write')} />
            )}
            {/* ── GEO 诊断 · 站点与品牌设置：站点级 SEO（robots/sitemap/llms.txt）+ 品牌实体 ── */}
            {apiEnabled && (currentTab === 'seo_foundation' || currentTab === 'brand_entity') && (
              <TabbedShell
                icon={Layers}
                group={lang === 'zh' ? 'GEO 诊断' : 'Diagnosis'}
                title={lang === 'zh' ? '站点与品牌设置' : 'Site & brand'}
                description={lang === 'zh'
                  ? '给搜索引擎和 AI「交代清楚你是谁」：站点抓取规则（robots / sitemap / llms.txt）+ 品牌实体的权威信息。'
                  : 'What crawlers and AI engines should know: crawler files plus authoritative brand entity data.'}
                view={currentView}
                onViewChange={setCurrentView}
                tabs={[
                  {
                    key: 'site', label: lang === 'zh' ? '站点 SEO' : 'Site SEO', icon: Globe,
                    render: () => (
                      <SeoConfigurationView embedded apiClient={apiClient} lang={lang} initialTab="sitemap"
                        canRead={hasScope(apiSession, 'seo:read')} canWrite={hasScope(apiSession, 'seo:write')} />
                    ),
                  },
                  {
                    key: 'brand', label: lang === 'zh' ? '品牌实体' : 'Brand entity', icon: Award,
                    render: () => (
                      <BrandEntityEeatView embedded lang={lang} apiClient={apiEnabled ? apiClient : undefined} />
                    ),
                  },
                ]}
              />
            )}

            {currentTab === 'preview' && (
              <SitePreviewView
                articles={articles}
                categories={categories}
                onSelectArticle={handleSelectArticle}
                lang={lang}
                apiMode={apiEnabled}
                apiClient={apiEnabled ? apiClient : undefined}
              />
            )}
          </div>
        </main>
      </div>

      {/* Full-view Article Modal */}
      <ArticleModal
        article={activeArticleModal}
        onClose={() => setActiveArticleModal(null)}
        onPublish={handlePublishArticle}
        onDistribute={(id) => handleDistributeArticle(id)}
        onUpdateArticle={handleUpdateArticle}
        apiClient={apiEnabled ? apiClient : undefined}
        onRiskRecheck={apiEnabled ? async (id) => {
          const result = await apiClient.recheckArticleRisk(id);
          const updated = asRecord(result.article);
          if (updated.status) {
            setArticles((prev) => prev.map((item) => item.id === id ? { ...item, apiStatus: String(updated.status), status: String(updated.status) === 'published' ? 'published' : 'draft' } : item));
          }
          return result;
        } : undefined}
        onExportWeChatHtml={apiEnabled ? async (content) => apiClient.exportArticleWeChatHtml(content) : undefined}
        onUploadEditorImage={apiEnabled ? async (id, file, alt) => apiClient.uploadArticleEditorImage(id, file, alt) : undefined}
        onListEditorTitles={apiEnabled ? (params) => apiClient.listEditorTitles(params) : undefined}
        onEditorGenerate={apiEnabled ? handleEditorGenerate : undefined}
        editorAssistantCatalog={editorAssistantCatalog}
        hasDistributionChannels={channels.length > 0}
        onPublishAndDistribute={apiEnabled ? handlePublishAndDistributeArticle : undefined}
        onArticleStateChange={apiEnabled ? ((updated) => {
          setArticles((prev) => prev.map((item) => item.id === updated.id ? updated : item));
          setActiveArticleModal(updated);
        }) : undefined}
        lang={lang}
        apiMode={apiEnabled}
      />
    </div>
  );
}
