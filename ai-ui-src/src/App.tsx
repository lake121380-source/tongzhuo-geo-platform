import { hasScope, isSuperAdminRole } from './api/permissions';
import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { readTabFromUrl, writeTabToUrl } from './tabs';
import { LoadingState } from './components/LoadingState';
import { DashboardView } from './components/DashboardView';
import { GeneratorView } from './components/GeneratorView';
import { ArticlesView } from './components/ArticlesView';
import { ArticleModal } from './components/ArticleModal';
import { TasksView } from './components/TasksView';
import { KnowledgeView } from './components/KnowledgeView';
import { MaterialsView } from './components/MaterialsView';
import { DistributionView } from './components/DistributionView';
import ManualPublicationsView from './components/ManualPublicationsView';
import { AnalyticsApiView } from './components/AnalyticsApiView';
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
import { ExecutiveScorecardModal } from './components/ExecutiveScorecardModal';
import { PlainGlossaryModal } from './components/PlainGlossaryModal';
import { DevHandoffModal } from './components/DevHandoffModal';
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
  const [apiError, setApiError] = useState<GeoFlowApiError | null>(null);
  const [apiReloadToken, setApiReloadToken] = useState(0);
  const [apiCatalog, setApiCatalog] = useState<CatalogResponse>(() => emptyCatalog());

  // 页签可由 URL 深链指定（`/geo_admin?tab=articles`）。AI 助手返回的「站内入口」
  // 用的就是这个格式，旧后台退役后它取代了原先的 Laravel 路由名。
  const [currentTab, setCurrentTab] = useState(() => readTabFromUrl());

  // 页签变化时同步到地址栏（replaceState，不堆历史记录），让深链始终反映当前页。
  useEffect(() => { writeTabToUrl(currentTab); }, [currentTab]);
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
  const [showScorecardModal, setShowScorecardModal] = useState(false);
  const [showGlossaryModal, setShowGlossaryModal] = useState(false);
  const [showDevHandoffModal, setShowDevHandoffModal] = useState(false);
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
      setApiError(null);
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
        if (!cancelled) setApiBooting(false);
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
    if (!confirm(lang === 'zh' ? '确定要删除该文章吗？' : 'Delete this article?')) return;
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

  type BatchArticleAction = 'review' | 'publish' | 'trash' | 'restore' | 'retract';
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
      setApiReloadToken((value) => value + 1);
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

  const handleDistributeArticle = async (id: string, channelIds?: string[]) => {
    if (apiEnabled) {
      try {
        const result = asRecord(await apiClient.distributeArticle(id, channelIds || []));
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
        alert(lang === 'zh' ? `已将文章加入 ${items.length || distributedTo.length} 个渠道的分发队列。` : 'The article was queued for distribution.');
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
        alert(lang === 'zh' ? '分发成功！远端站点已接收并触发静态页编译。' : 'Distributed successfully!');
      }
    } catch (error) {
      console.error(error);
    }
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
        alert(lang === 'zh' ? '任务已提交 桐灼GEO 队列，文章将在后台生成并经过质量门禁。' : 'Task queued in 桐灼GEO; generated articles will pass the quality gate.');
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
        alert(data.message || (lang === 'zh' ? '任务已执行完成！' : 'Task executed!'));
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
        alert(data.message || (lang === 'zh' ? '同步已完成！' : 'Synced!'));
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
    if (apiEnabled && API_DISABLED_TABS.includes(tab)) {
      reportApiError(new GeoFlowApiError('桐灼GEO API v1 尚未提供此功能', 0, 'unsupported_capability'), '当前部署尚未提供此功能');
      return;
    }
    setCurrentTab(tab);
  };

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
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Header */}
      <Header
        lang={lang}
        setLang={setLang}
        hasGeminiKey={hasGeminiKey}
        mode="geoflow"
        adminName={apiSession?.admin.display_name || apiSession?.admin.username}
        adminRole={apiSession?.admin.role}
        onLogout={apiEnabled ? handleApiLogout : undefined}
        onQuickGenerate={() => navigateToTab('generator')}
        onOpenPreview={() => navigateToTab('preview')}
        onOpenScorecard={apiEnabled ? undefined : () => setShowScorecardModal(true)}
        onOpenGlossary={apiEnabled ? undefined : () => setShowGlossaryModal(true)}
        onOpenDevHandoff={apiEnabled ? undefined : () => setShowDevHandoffModal(true)}
      />

      {/* Main Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <Sidebar
          currentTab={currentTab}
          onSelectTab={navigateToTab}
          lang={lang}
          mode="geoflow"
          disabledTabs={apiEnabled ? API_DISABLED_TABS : []}
          badgeCounts={{
            articles: articles.filter((a) => a.status === 'review').length,
            tasks: tasks.filter((t) => t.status === 'running').length,
            channels: channels.length,
          }}
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
                onOpenGlossary={() => setShowGlossaryModal(true)}
                onOpenDevHandoff={() => setShowDevHandoffModal(true)}
                lang={lang}
                apiMode={apiEnabled}
                analyticsOverview={analyticsOverview}
              />
            )}

            {currentTab === 'generator' && (
              <GeneratorView
                knowledgeBases={knowledgeBases}
                onSaveArticle={handleSaveArticle}
                lang={lang}
                apiMode={apiEnabled}
                apiCatalog={apiTaskCatalog}
                onCreateTask={apiEnabled ? handleCreateTask : undefined}
                onCheckTitleReadiness={apiEnabled ? handleCheckTaskTitleReadiness : undefined}
                onNavigate={navigateToTab}
                canRead={hasScope(apiSession, 'catalog:read')}
                canWrite={hasScope(apiSession, 'tasks:write')}
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
                lang={lang}
                apiMode={apiEnabled}
                scopes={apiSession?.scopes}
                apiCatalog={apiTaskCatalog}
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
              />
            )}

            {currentTab === 'distribution' && (
              <DistributionView
                channels={channels}
                hostedSites={hostedSites}
                distributionJobs={distributionJobs}
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

            {currentTab === 'competitor' && (
              <CompetitorRadarView
                lang={lang}
                apiClient={apiEnabled ? apiClient : undefined}
                canRead={hasScope(apiSession, 'analytics:read')}
                canCollect={hasScope(apiSession, 'analytics:collect')}
                onNavigateToDraft={() => setCurrentTab('generator')}
              />
            )}

            {currentTab === 'query_radar' && (
              <QueryRadarView
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
            )}

            {currentTab === 'url_scanner' && (
              <UrlScannerView
                lang={lang}
                apiClient={apiEnabled ? apiClient : undefined}
                canRead={hasScope(apiSession, 'materials:read')}
                canWrite={hasScope(apiSession, 'materials:write')}
              />
            )}




            {currentTab === 'brand_entity' && (
              <BrandEntityEeatView
                lang={lang}
                apiClient={apiEnabled ? apiClient : undefined}
              />
            )}

            {currentTab === 'attribution_funnel' && (
              <AiAttributionFunnelView
                lang={lang}
                apiClient={apiEnabled ? apiClient : undefined}
                canRead={hasScope(apiSession, 'analytics:read')}
                canWrite={hasScope(apiSession, 'analytics:write')}
              />
            )}


            {currentTab === 'sandbox' && (
              <AiSandboxView
                lang={lang}
                apiClient={apiEnabled ? apiClient : undefined}
              />
            )}

            {apiEnabled && currentTab === 'analytics' && (
              <AnalyticsApiView apiClient={apiClient} lang={lang} scopes={apiSession?.scopes} onNavigate={navigateToTab} />
            )}

            {apiEnabled && currentTab === 'leads' && (
              <LeadManagementView
                apiClient={apiClient}
                lang={lang}
                canRead={hasScope(apiSession, 'leads:read')}
                canWrite={hasScope(apiSession, 'leads:write')}
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
            {apiEnabled && currentTab === 'seo_foundation' && (
              <SeoConfigurationView apiClient={apiClient} lang={lang} initialTab="sitemap"
                canRead={hasScope(apiSession, 'seo:read')} canWrite={hasScope(apiSession, 'seo:write')} />
            )}
            {apiEnabled && currentTab === 'llmstxt' && (
              <SeoConfigurationView apiClient={apiClient} lang={lang} initialTab="llms"
                canRead={hasScope(apiSession, 'seo:read')} canWrite={hasScope(apiSession, 'seo:write')} />
            )}
            {apiEnabled && currentTab === 'seo_dashboard' && (
              <RealSeoDashboardView lang={lang} apiClient={apiClient} onNavigate={(tab) => setCurrentTab(tab)} />
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
        onArticleStateChange={apiEnabled ? ((updated) => {
          setArticles((prev) => prev.map((item) => item.id === updated.id ? updated : item));
          setActiveArticleModal(updated);
        }) : undefined}
        lang={lang}
        apiMode={apiEnabled}
      />

      {/* Global Executive Scorecard Modal */}
      <ExecutiveScorecardModal
        isOpen={showScorecardModal}
        onClose={() => setShowScorecardModal(false)}
        lang={lang}
        onNavigateTab={navigateToTab}
      />

      {/* Beginner Plain Glossary Modal */}
      <PlainGlossaryModal
        isOpen={showGlossaryModal}
        onClose={() => setShowGlossaryModal(false)}
        lang={lang}
      />

      {/* Developer Handoff Package Modal */}
      <DevHandoffModal
        isOpen={showDevHandoffModal}
        onClose={() => setShowDevHandoffModal(false)}
        lang={lang}
      />
    </div>
  );
}
