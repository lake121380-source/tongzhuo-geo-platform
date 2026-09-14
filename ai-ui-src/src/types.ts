export interface Article {
  id: string;
  title: string;
  slug: string;
  summary: string;
  content: string;
  category: string;
  author: string;
  status: 'published' | 'draft' | 'review' | 'trash';
  views: number;
  seoTitle?: string;
  seoKeywords: string[];
  seoDescription?: string;
  createdAt: string;
  distributedTo: string[];
  geoScore?: number;
  geoAudit?: GeoAuditReport;
  /** 桐灼GEO API v1 fields retained for review/publish UI adapters. */
  reviewStatus?: string;
  aiQualityStatus?: string;
  /**
   * 质检**判定**（passed / needs_review / blocked）——与 `aiQualityStatus`（跑没跑完）是两回事：
   * 实测 `status=completed` 但 `decision=needs_review` 的文章，界面若只显示「已完成」，
   * 用户会以为通过了，点发布却被门禁拦下（2026-09-14 哥哥报的 bug）。
   */
  aiQualityDecision?: string;
  /** 后端给的人类可读结论（如「AI 质检待人工复核」）——界面直接用，不要自己编词。 */
  aiQualityResultLabel?: string;
  aiQualityScore?: number;
  aiQualityPassScore?: number;
  /** 人工放行的最低分（低于它只能优化/改写，不能放行）。 */
  aiQualityOverrideMinScore?: number;
  aiQualityIsOverridden?: boolean;
  aiQualityReason?: string;
  /** Authoritative 桐灼GEO quality projection (scores, gate reasons, progress). */
  aiQuality?: Record<string, unknown>;
  /** Version required by the optimistic-concurrency guarded recheck endpoint. */
  aiQualityConfigVersion?: number;
  /** Latest server-side optimization run projection, when returned by status. */
  aiOptimization?: Record<string, unknown>;
  /** Raw 桐灼GEO workflow status (draft/published/private), kept separate
   * from the UI-only `status` filter value (`review`). */
  apiStatus?: string;
  apiCategoryId?: number;
  apiAuthorId?: number;
  apiTaskId?: number;
}

export interface GeoAuditCriterion {
  id: string;
  name: string;
  score: number; // 0 - 100
  weight: number;
  passed: boolean;
  status: 'good' | 'warning' | 'critical';
  feedback: string;
  suggestion: string;
}

export interface GeoAuditReport {
  overallScore: number;
  grade: 'A+' | 'A' | 'B' | 'C' | 'D';
  factDensityScore: number;
  extractabilityScore: number;
  schemaReadinessScore: number;
  fluffRatio: number;
  tableCount: number;
  faqCount: number;
  schemaTypesDetected: string[];
  criteria: GeoAuditCriterion[];
  optimizationsAvailable: string[];
}

export interface LlmsTxtConfig {
  siteTitle: string;
  summary: string;
  coreDirectives: string[];
  includedArticleIds: string[];
  includeFullText: boolean;
  customFooterNotes: string;
  lastUpdated: string;
}

export interface AiSandboxCitation {
  id: number;
  title: string;
  url: string;
  /** 未配置被测量品牌时为 null：归属不可计算，不等于「不是你的信源」。 */
  brandMatch: boolean | null;
  snippet: string;
}

export interface AiSandboxSimulation {
  query: string;
  targetEngine: 'perplexity' | 'chatgpt' | 'gemini';
  simulatedAnswer: string;
  citations: AiSandboxCitation[];
  /** 被测量品牌是否已在品牌实体中声明；未声明时以下所有品牌归属字段均为 null。 */
  brandConfigured: boolean;
  /** 被测量品牌名（产品品牌不参与归属判定，这里回传的是运营方声明的客户品牌）。 */
  brandName: string;
  brandMentioned: boolean | null;
  // 情感与信源占有率都需要可核验的标注/分母数据源：后端在缺数据时返回 null 并附带状态，
  // 不再用固定值或 0 冒充测量结果。
  brandSentiment: string | null;
  brandSentimentStatus: string;
  brandRecommendationGrade: '强力推荐' | '客观列举' | '未上榜' | null;
  /** 参与信源归属判定的自有域名（来自品牌实体里显式声明的 officialDomain）。 */
  ownedDomains: string[];
  citationSharePercent: number | null;
  citationShareDenominator: number;
  citationShareStatus: string;
  actionableAdvice: string[];
  timestamp: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  articleCount: number;
}

export interface Task {
  id: string;
  name: string;
  status: 'running' | 'idle' | 'paused' | 'completed';
  targetCategory: string;
  aiModel: string;
  batchLimit: number;
  generatedCount: number;
  schedule: string;
  lastRunAt: string;
  distributionScope: 'all' | 'channels_only' | 'local_only';
  /** Raw 桐灼GEO state is kept so the UI never confuses paused/active with mock states. */
  rawStatus?: string;
  /** Server identifiers retained when the list projection omits display names. */
  apiCategoryId?: number;
  apiModelId?: number;
  /** Configuration identifiers returned by the 桐灼GEO task projection. */
  titleLibraryId?: number;
  promptId?: number;
  authorId?: number;
  knowledgeBaseIds?: number[];
  modelSelectionMode?: 'fixed' | 'smart_failover' | string;
  publishScope?: 'local_and_distribution' | 'distribution_only' | 'local_only' | string;
  categoryMode?: 'smart' | 'fixed' | string;
  isLoop?: boolean;
  autoKeywords?: boolean;
  autoDescription?: boolean;
  aiQualityEnabled?: boolean;
  /** 桐灼GEO's publish_interval is expressed in seconds. */
  publishIntervalSeconds?: number;
  scheduleEnabled?: boolean;
  /** Latest generated batch state and public error projection, when supplied. */
  batchStatus?: string;
  batchErrorMessage?: string;
  /** Latest task_runs record, when the API exposes one. */
  latestJobId?: string;
  latestJobStatus?: string;
  latestJobUpdatedAt?: string;
  latestJobErrorCode?: string;
  needReview?: boolean;
  progress?: Record<string, unknown>;
}

export interface TaskWorker {
  workerId: string;
  status: string;
  statusLabel: string;
  summary: string;
  isStale: boolean;
  currentJobId?: string;
  taskId?: string;
  taskName?: string;
  articleId?: string;
  articleTitle?: string;
  memoryMb?: number;
  peakMemoryMb?: number;
  lastSeenAt?: string;
  lastSeenHuman: string;
}

export interface TaskTitleReadinessIssue {
  code: string;
  severity: 'blocking' | 'warning' | string;
}

export interface TaskTitleReadiness {
  status: 'ready' | 'warning' | 'blocked';
  canSave: boolean;
  canActivate: boolean;
  requiresAcknowledgement: boolean;
  library: {
    id?: number;
    name: string;
    total: number;
    used: number;
    available: number;
  };
  task: {
    id?: number;
    status: string;
    articleLimit: number;
    createdCount: number;
    remaining: number;
    isLoop: boolean;
  };
  shortage: number;
  suggestedArticleLimit: number;
  conflictCount: number;
  redactedConflictCount: number;
  conflicts: Array<{
    id: number;
    name: string;
    remaining: number;
    isLoop: boolean;
  }>;
  issues: TaskTitleReadinessIssue[];
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  /**
   * Counts are optional because the API only guarantees a count when the
   * corresponding field (or paginator) is present.  `undefined` means
   * unknown; it must not be rendered as zero or inferred from content.
   */
  documentCount?: number;
  chunkCount?: number;
  embeddedCount?: number;
  /** Server's native vectorized-chunk projection, when supplied. */
  vectorizedChunkCount?: number;
  /** Source/governance fields are exposed by newer 桐灼GEO projections. */
  sourceName?: string;
  sourceUrl?: string;
  sourceType?: string;
  businessLine?: string;
  effectiveDate?: string;
  riskLevel?: string;
  reviewStatus?: string;
  fileType?: string;
  characterCount?: number;
  wordCount?: number;
  usageCount?: number;
  usedTaskCount?: number;
  chunkSyncStatus?: string;
  chunkSyncedAt?: string;
  revisionCount?: number;
  latestRevision?: number;
  /** `failed` means chunk synchronization reported an error; it is not ready. */
  status: 'ready' | 'processing' | 'indexed' | 'failed';
  syncError?: string;
  updatedAt: string;
}

export interface KnowledgeChunk {
  id: string;
  kbId: string;
  title: string;
  content: string;
  tokenCount: number;
  /**
   * Optional because 桐灼GEO API v1's chunk serializer currently omits
   * embedding metadata. `undefined` means "unknown", not "not embedded".
   */
  hasEmbedding?: boolean;
}

export interface DistributionChannel {
  id: string;
  name: string;
  type: 'tongzhuo_geo_agent' | 'wordpress_rest' | 'generic_http' | 'hosted_site';
  targetUrl: string;
  /** 桐灼GEO API field names used when creating a channel. */
  endpoint_url?: string;
  domain?: string;
  channel_type?: 'geoflow_agent' | 'wordpress_rest' | 'generic_http_api' | 'hosted_site';
  /** Backend lifecycle states are preserved instead of collapsing paused or
   * deleting channels into a disconnected presentation. */
  status: 'active' | 'paused' | 'deleting' | 'disconnected' | 'syncing';
  rawStatus?: string;
  articlesCount: number;
  lastSyncedAt: string;
  authMethod: string;
  description?: string;
  lastErrorMessage?: string;
  lastHealthStatus?: string;
  pendingCount?: number;
  failedCount?: number;
}

export interface AiModelConfig {
  id: string;
  name: string;
  /** Provider/model id/default/context are optional because catalog v1 does
   * not expose them.  Unknown values must stay unknown in the UI. */
  provider: 'gemini' | 'openai' | 'custom' | 'unknown';
  modelId?: string;
  isDefault?: boolean;
  contextWindow?: number;
  type: 'chat' | 'embedding';
  version?: string;
  modelType?: string;
  status?: string;
  failoverPriority?: number;
  isAvailable?: boolean;
  isShared?: boolean;
  apiUrl?: string;
  apiKeyConfigured?: boolean;
  dailyLimit?: number;
  maxTokens?: number;
  accessScope?: string;
}

export interface PromptTemplate {
  id: string;
  name: string;
  category: string;
  systemPrompt: string;
  userPromptTemplate: string;
  isDefault: boolean;
  type?: string;
  systemKey?: string | null;
  systemManaged?: boolean;
}

export interface AnalyticsOverview {
  totalPvs: number;
  totalUvs: number;
  articlesGeneratedToday: number;
  aiCrawlersCount: number;
  crawlerBreakdown: { name: string; count: number; percentage: number; color: string }[];
  dailyTraffic: { date: string; pv: number; uv: number; aiBot: number }[];
  topArticles: { title: string; views: number; citations: number }[];
}

export interface GeoEngineVisibility {
  engine: string;
  name: string;
  citationShare: number; // percentage, e.g. 36.4
  citationsCount: number;
  visibilityScore: number; // 0 to 100
  trendChange: number; // e.g. +5.2
  color: string;
}

export interface GeoKeywordRanking {
  id: string;
  keyword: string;
  intent: 'commercial' | 'technical' | 'informational' | 'brand';
  currentRank: number;
  previousRank: number;
  engine: string;
  promptVolume: number;
  citationLikelihood: number; // 0 - 100
  targetArticleTitle: string;
  targetArticleSlug?: string;
  trend: number[]; // e.g. last 5 rankings
}

export interface GeoTrafficTimelinePoint {
  date: string;
  impressions: number;
  referralClicks: number;
  ctr: number;
}

export interface GeoPerformanceMetrics {
  visibilityScore: number;
  visibilityChange: number;
  estimatedMonthlyTraffic: number;
  trafficGrowthRate: number;
  averageCitationCtr: number;
  estimatedOrganicValue: number; // in USD
  rankingDistribution: {
    top3Count: number;
    top10Count: number;
    beyond10Count: number;
  };
  engineVisibility: GeoEngineVisibility[];
  keywordRankings: GeoKeywordRanking[];
  trafficTimeline: GeoTrafficTimelinePoint[];
  topicDistribution: { topic: string; trafficShare: number; citations: number }[];
}

// ================= MODULE A: 竞品 GEO 声量对比雷达 =================
export interface CompetitorBenchmarkItem {
  brandName: string;
  isOwnBrand: boolean;
  shareOfModel: number; // 0 - 100
  winRate: number; // 0 - 100
  avgCitationRank: number; // 1.2, 2.5 etc
  sentiment: 'positive' | 'neutral' | 'critical';
  strengths: string[];
  weaknesses: string[];
  topCitedTopics: string[];
}

export interface CompetitorBlindspot {
  topic: string;
  winnerBrand: string;
  ourStatus: 'absent' | 'lagging' | 'leading';
  impactScore: number;
  recommendedAction: string;
}

export interface CompetitorComparisonResult {
  industry: string;
  evaluatedEngines: string[];
  competitors: CompetitorBenchmarkItem[];
  blindspots: CompetitorBlindspot[];
  headToHead: { dimension: string; ownScore: number; compScores: { [brand: string]: number }; verdict: string }[];
  simulatedAt: string;
}

// ================= MODULE B: AI 搜索高潜问答挖掘器 =================
export interface GeoQueryRadarItem {
  id: string;
  query: string;
  intent: 'comparison' | 'buying_decision' | 'technical' | 'faq' | 'pricing';
  searchVolumeScore: number; // 1 - 100
  citationGapRate: number; // 0 - 100%
  geoOpportunityScore: number; // 0 - 100
  targetEngines: string[];
  recommendedStructure: {
    titleTemplate: string;
    h2s: string[];
    requiredTable: string;
    schemaType: string;
  };
  sampleExcerpt?: string;
  status: 'new' | 'drafted' | 'published';
}

// ================= MODULE C: URL GEO 深度体检器 =================
export interface UrlScanItem {
  dimension: string;
  score: number;
  status: 'pass' | 'warning' | 'fail';
  title: string;
  details: string;
  recommendation: string;
}

export interface UrlScanReport {
  url: string;
  scannedAt: string;
  overallScore: number;
  grade: 'A+' | 'A' | 'B' | 'C' | 'D';
  robotsTxtStatus: {
    accessible: boolean;
    gptBotAllowed: boolean;
    claudeBotAllowed: boolean;
    perplexityAllowed: boolean;
    bytespiderAllowed: boolean;
  };
  llmsTxtStatus: {
    present: boolean;
    formatStandard: boolean;
    urlCount: number;
    hasDirectives: boolean;
  };
  schemaStatus: {
    hasSchema: boolean;
    typesFound: string[];
    jsonLdValid: boolean;
  };
  contentQuality: {
    wordCount: number;
    tableCount: number;
    faqSectionDetected: boolean;
    fluffRatio: number;
  };
  items: UrlScanItem[];
  quickFixPlan: string[];
}

// ================= MODULE D: AI 爬虫防线与 robots.txt 配置器 =================
export interface AiBotPolicy {
  id: string;
  name: string;
  userAgent: string;
  company: string;
  purpose: 'search_rag' | 'training' | 'multimodal';
  action: 'allow' | 'disallow' | 'throttle';
  crawlDelay?: number;
  description: string;
}

export interface RobotsConfig {
  allowAllByDefault: boolean;
  includeLlmsTxt: boolean;
  includeSitemap: boolean;
  sitemapUrl: string;
  llmsTxtUrl: string;
  protectedPaths: string[];
  botPolicies: AiBotPolicy[];
}

// ================= STEP 1: SEO 筑基与双轨 SITEMAP 地图 =================
export interface SitemapUrlEntry {
  loc: string;
  lastmod: string;
  changefreq: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority: number;
  articleId?: string;
  title?: string;
}

export interface DualSitemapConfig {
  baseUrl: string;
  autoSyncWithArticles: boolean;
  includeLlmsTxtLink: boolean;
  enableNewsSitemap: boolean;
  entries: SitemapUrlEntry[];
  lastGenerated: string;
}

export interface BaselineSeoCheckResult {
  url: string;
  status: 'passed' | 'warning' | 'critical';
  overallScore: number;
  checks: {
    canonical: { status: 'pass' | 'fail'; value: string; tip: string };
    metaRobots: { status: 'pass' | 'warn' | 'fail'; value: string; tip: string };
    titleTag: { status: 'pass' | 'warn'; length: number; value: string; tip: string };
    metaDescription: { status: 'pass' | 'warn'; length: number; value: string; tip: string };
    openGraph: { status: 'pass' | 'fail'; ogTitle: boolean; ogImage: boolean; ogType: boolean; tip: string };
    ssrHtmlRenderability: {
      status: 'pass' | 'warn' | 'fail';
      isSpaBlankDom: boolean;
      rawHtmlH1Present: boolean;
      rawTextBytes: number;
      tip: string;
    };
    headingsHierarchy: { status: 'pass' | 'warn'; h1Count: number; tip: string };
  };
}

// ================= STEP 2: 品牌实体消歧与 E-E-A-T 权威锚定 =================
export interface SameAsLink {
  /** 界面本地生成；后端只校验并持久化 url，经 API 直接写入的历史记录可能没有 id。 */
  id?: string;
  platformName?: string;
  url: string;
}

export interface BrandEntityConfig {
  organizationName: string;
  alternateName: string;
  legalName: string;
  foundingDate: string;
  officialDomain: string;
  logoUrl: string;
  description: string;
  sameAsLinks: SameAsLink[];
  founders: { name: string; title: string; profileUrl?: string }[];
  awardsAndCertifications: string[];
  contactEmail: string;
}

export interface EeatAuditReport {
  // E-E-A-T 没有可核验的评分模型与分母，后端不再输出总分与维度分（恒为 null）。
  brandOverallScore: number | null;
  score_status: string;
  score_reason: string;
  configured_fields: Record<string, boolean>;
  missing_fields: string[];
  counts: {
    published_article_count: number;
    same_as_link_count: number;
    founder_count: number;
  };
  jsonLdScriptPreview: string;
}

// ================= STEP 3: AI 引流归因与咨询转化漏斗 =================
export interface AiReferralSourceMetric {
  engine: 'Perplexity' | 'ChatGPT / SearchGPT' | 'Claude' | 'Gemini' | 'Kimi' | 'Doubao' | 'Others';
  iconColor: string;
  referralClicks: number;
  bounceRate: number; // 0 - 100%
  avgDwellSeconds: number;
  inquiriesGenerated: number;
  conversionRate: number; // 0 - 100%
  pipelineRevenue: number; // in RMB/currency
}

export interface AiTrafficFunnelStage {
  stage: string;
  count: number;
  conversionRateFromPrev: number;
  dropoffNote: string;
}

export interface UtmCampaignPreset {
  id: string;
  campaignName: string;
  targetEngine: string;
  landingPage: string;
  fullUtmUrl: string;
  generatedClicks: number;
  inquiries: number;
}

// ================= SEO 综合决策大盘 =================
export interface SeoDashboardActionItem {
  id: string;
  priority: 'P0' | 'P1' | 'P2';
  category: 'competitor' | 'query' | 'sitemap' | 'entity';
  title: string;
  description: string;
  impactScore: number;
  completed: boolean;
  actionLabel: string;
  targetTab: string;
  prefillQuery?: string;
}

export interface SeoDashboardAggregateData {
  healthScore: number;
  healthGrade: string;
  competitorSummary: {
    ownShare: number;
    winRate: number;
    leadMargin: number;
    rivalCount: number;
    blindspotsCount: number;
  };
  queryRadarSummary: {
    totalQueries: number;
    highPotentialCount: number;
    avgCitationGap: number;
    avgOpportunityScore: number;
  };
  sitemapSummary: {
    totalUrls: number;
    lastSynced: string;
    autoSyncEnabled: boolean;
    llmsTxtLinked: boolean;
    crawlersAllowedCount: number;
  };
}
