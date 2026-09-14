import {
  AiModelConfig,
  Article,
  Category,
  KnowledgeBase,
  KnowledgeChunk,
  DistributionChannel,
  PromptTemplate,
  Task,
  TaskTitleReadiness,
  TaskWorker,
} from '../types';
import { ApiRecord, CatalogResponse, PaginatedResponse } from './geoflowClient';

function value(record: ApiRecord | undefined, ...keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function text(record: ApiRecord | undefined, ...keys: string[]): string {
  const item = value(record, ...keys);
  return item === undefined || item === null ? '' : String(item);
}

function numberValue(record: ApiRecord | undefined, ...keys: string[]): number {
  const item = Number(value(record, ...keys));
  return Number.isFinite(item) ? item : 0;
}

/**
 * Read a numeric field without turning an omitted/null/empty value into zero.
 * Counts in the API are projections, not values that the client is allowed to
 * derive from the current page or from the source text.
 */
function optionalNumericValue(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '' || typeof raw === 'boolean') {
    return undefined;
  }
  const parsed = typeof raw === 'number'
    ? raw
    : typeof raw === 'string' && raw.trim() !== ''
      ? Number(raw)
      : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalNumberValue(record: ApiRecord | undefined, ...keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const parsed = optionalNumericValue(record[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function recordValue(raw: unknown): ApiRecord | undefined {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as ApiRecord : undefined;
}

function firstNumericField(record: ApiRecord | undefined, keys: string[]): number | undefined {
  return optionalNumberValue(record, ...keys);
}

/**
 * Normalize pagination metadata from 桐灼GEO's canonical shape and the
 * Laravel paginator shape used by a few older projections.  The returned
 * object is deliberately sparse: an absent server value remains undefined.
 */
export interface NormalizedPagination {
  page?: number;
  perPage?: number;
  total?: number;
  totalPages?: number;
  from?: number | null;
  to?: number | null;
}

export function getPaginationMeta(input: unknown): NormalizedPagination | undefined {
  const root = recordValue(input);
  if (!root) return undefined;

  const nestedData = recordValue(root.data);
  const meta = recordValue(root.meta);
  const candidates: ApiRecord[] = [
    recordValue(root.pagination),
    recordValue(meta?.pagination),
    recordValue(nestedData?.pagination),
    meta,
    nestedData,
    root,
  ].filter((candidate): candidate is ApiRecord => Boolean(candidate));

  let page: number | undefined;
  let perPage: number | undefined;
  let total: number | undefined;
  let totalPages: number | undefined;
  let from: number | null | undefined;
  let to: number | null | undefined;

  for (const candidate of candidates) {
    page ??= firstNumericField(candidate, ['page', 'current_page', 'currentPage']);
    perPage ??= firstNumericField(candidate, ['per_page', 'perPage', 'page_size', 'pageSize']);
    total ??= firstNumericField(candidate, ['total', 'total_count', 'totalCount']);
    totalPages ??= firstNumericField(candidate, ['total_pages', 'last_page', 'totalPages', 'lastPage']);
    if (from === undefined && Object.prototype.hasOwnProperty.call(candidate, 'from')) {
      from = candidate.from === null ? null : optionalNumericValue(candidate.from) ?? null;
    }
    if (to === undefined && Object.prototype.hasOwnProperty.call(candidate, 'to')) {
      to = candidate.to === null ? null : optionalNumericValue(candidate.to) ?? null;
    }
  }

  if (page === undefined && perPage === undefined && total === undefined
    && totalPages === undefined && from === undefined && to === undefined) {
    return undefined;
  }

  return {
    ...(page === undefined ? {} : { page }),
    ...(perPage === undefined ? {} : { perPage }),
    ...(total === undefined ? {} : { total }),
    ...(totalPages === undefined ? {} : { totalPages }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

/** Return the rows from a paginated response without inventing a fallback. */
export function getPageItems<T>(input: PaginatedResponse<T> | unknown): T[] {
  const root = recordValue(input);
  if (!root) return [];
  if (Array.isArray(root.items)) return root.items as T[];
  const nestedData = recordValue(root.data);
  if (nestedData && Array.isArray(nestedData.items)) return nestedData.items as T[];
  return [];
}

/**
 * Parse a flag without treating the string "false" as truthy.  Laravel's
 * JSON responses normally contain real booleans, but this keeps the adapter
 * safe when a legacy driver serializes tinyint values as strings.
 */
function booleanValue(record: ApiRecord | undefined, ...keys: string[]): boolean | undefined {
  const raw = value(record, ...keys);
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
  }
  return undefined;
}

function list(valueToNormalize: unknown): string[] {
  if (Array.isArray(valueToNormalize)) return valueToNormalize.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof valueToNormalize === 'string') {
    return valueToNormalize.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function dateText(record: ApiRecord | undefined, ...keys: string[]): string {
  const raw = text(record, ...keys);
  return raw || '—';
}

function intervalText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds % 86400 === 0) return `每 ${seconds / 86400} 天`;
  if (seconds % 3600 === 0) return `每 ${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `每 ${seconds / 60} 分钟`;
  return `每 ${seconds} 秒`;
}

export function mapCatalogCategories(items: Array<ApiRecord> = []): Category[] {
  return items.map((item) => ({
    id: text(item, 'id'),
    name: text(item, 'name') || '未命名分类',
    slug: text(item, 'slug'),
    articleCount: numberValue(item, 'article_count', 'articles_count'),
  }));
}

export function mapCatalogModels(items: Array<ApiRecord> = []): AiModelConfig[] {
  return items.map((item) => {
    const modelType = text(item, 'model_type', 'type');
    const provider = text(item, 'provider', 'provider_name').toLowerCase();
    const normalizedProvider: AiModelConfig['provider'] = provider.includes('gemini')
      ? 'gemini'
      : provider.includes('openai')
        ? 'openai'
        : provider !== ''
          ? 'custom'
          : 'unknown';
    const modelId = text(item, 'model_id', 'model').trim();
    const contextWindow = numberValue(item, 'context_window', 'context_length');
    const defaultFlag = booleanValue(item, 'is_default', 'default');
    return {
      id: text(item, 'id'),
      name: text(item, 'name') || text(item, 'model_id') || '未命名模型',
      provider: normalizedProvider,
      ...(modelId ? { modelId } : {}),
      ...(defaultFlag === undefined ? {} : { isDefault: defaultFlag }),
      ...(contextWindow > 0 ? { contextWindow } : {}),
      type: modelType === 'embedding' ? 'embedding' : 'chat',
      ...(text(item, 'version') ? { version: text(item, 'version') } : {}),
      ...(modelType ? { modelType } : {}),
      ...(text(item, 'status') ? { status: text(item, 'status') } : {}),
      ...(value(item, 'failover_priority') !== undefined
        ? { failoverPriority: numberValue(item, 'failover_priority') }
        : {}),
      ...(booleanValue(item, 'is_available') === undefined
        ? {}
        : { isAvailable: booleanValue(item, 'is_available') }),
      ...(booleanValue(item, 'is_shared') === undefined
        ? {}
        : { isShared: booleanValue(item, 'is_shared') }),
      ...(text(item, 'api_url') ? { apiUrl: text(item, 'api_url') } : {}),
      ...(booleanValue(item, 'api_key_configured') === undefined
        ? {}
        : { apiKeyConfigured: booleanValue(item, 'api_key_configured') }),
      ...(value(item, 'daily_limit') !== undefined ? { dailyLimit: numberValue(item, 'daily_limit') } : {}),
      ...(value(item, 'max_tokens') !== undefined && value(item, 'max_tokens') !== null
        ? { maxTokens: numberValue(item, 'max_tokens') }
        : {}),
      ...(text(item, 'access_scope') ? { accessScope: text(item, 'access_scope') } : {}),
    };
  });
}

export function mapCatalogPrompts(items: Array<ApiRecord> = []): PromptTemplate[] {
  return items.map((item) => ({
    id: text(item, 'id'),
    name: text(item, 'name') || '未命名提示词',
    category: text(item, 'type', 'category') || 'content',
    // `/catalog` intentionally exposes only id/name/type.  Do not surface a
    // legacy `content` field here as if it were the authoritative prompt
    // body; the API has no prompt read endpoint in v1.
    systemPrompt: '',
    userPromptTemplate: '',
    isDefault: booleanValue(item, 'is_default', 'default') ?? false,
  }));
}

/** Map the authenticated prompt projection, including body fields omitted by catalog. */
export function mapApiPrompt(item: ApiRecord): PromptTemplate {
  const content = text(item, 'content');
  return {
    id: text(item, 'id'),
    name: text(item, 'name') || '未命名提示词',
    category: text(item, 'type', 'category') || 'content',
    systemPrompt: content,
    userPromptTemplate: '',
    isDefault: booleanValue(item, 'is_default', 'default') ?? false,
    type: text(item, 'type', 'category') || 'content',
    systemKey: value(item, 'system_key') === null ? null : text(item, 'system_key') || null,
    systemManaged: booleanValue(item, 'system_managed') ?? Boolean(text(item, 'system_key')),
  };
}

export function mapCatalogKnowledgeBases(items: Array<ApiRecord> = []): KnowledgeBase[] {
  return items.map((item) => mapKnowledgeBase(item));
}

export function mapKnowledgeBase(item: ApiRecord): KnowledgeBase {
  const syncStatus = text(item, 'chunk_sync_status', 'status').toLowerCase();
  const syncError = text(item, 'chunk_sync_error', 'sync_error').trim();
  const documentCount = optionalNumberValue(item, 'document_count', 'documents_count', 'source_document_count');
  const chunkCount = optionalNumberValue(item, 'chunk_count', 'chunks_count');
  // 桐灼GEO's admin projection calls this `vectorized_chunk_count`; accept
  // the newer aliases too, but never assume every chunk has an embedding.
  const vectorizedChunkCount = optionalNumberValue(
    item,
    'vectorized_chunk_count',
    'vectorized_count',
    'embedded_count',
    'embedding_count',
  );
  const status: KnowledgeBase['status'] = syncError !== '' || syncStatus.includes('fail') || syncStatus.includes('error')
    ? 'failed'
    : syncStatus.includes('process') || syncStatus === 'pending'
    ? 'processing'
    : syncStatus.includes('index') || syncStatus === 'ready' || syncStatus === 'active'
      ? 'indexed'
      : 'ready';
  return {
    id: text(item, 'id'),
    name: text(item, 'name') || '未命名知识库',
    description: text(item, 'description'),
    ...(documentCount === undefined ? {} : { documentCount }),
    ...(chunkCount === undefined ? {} : { chunkCount }),
    ...(vectorizedChunkCount === undefined ? {} : {
      embeddedCount: vectorizedChunkCount,
      vectorizedChunkCount,
    }),
    ...(text(item, 'source_name') ? { sourceName: text(item, 'source_name') } : {}),
    ...(text(item, 'source_url') ? { sourceUrl: text(item, 'source_url') } : {}),
    ...(text(item, 'source_type') ? { sourceType: text(item, 'source_type') } : {}),
    ...(text(item, 'business_line') ? { businessLine: text(item, 'business_line') } : {}),
    ...(text(item, 'effective_date') ? { effectiveDate: text(item, 'effective_date') } : {}),
    ...(text(item, 'risk_level') ? { riskLevel: text(item, 'risk_level') } : {}),
    ...(text(item, 'review_status') ? { reviewStatus: text(item, 'review_status') } : {}),
    ...(text(item, 'file_type') ? { fileType: text(item, 'file_type') } : {}),
    ...(optionalNumberValue(item, 'character_count') === undefined ? {} : {
      characterCount: optionalNumberValue(item, 'character_count'),
    }),
    ...(optionalNumberValue(item, 'word_count') === undefined ? {} : {
      wordCount: optionalNumberValue(item, 'word_count'),
    }),
    ...(optionalNumberValue(item, 'usage_count') === undefined ? {} : {
      usageCount: optionalNumberValue(item, 'usage_count'),
    }),
    ...(optionalNumberValue(item, 'used_task_count') === undefined ? {} : {
      usedTaskCount: optionalNumberValue(item, 'used_task_count'),
    }),
    ...(text(item, 'chunk_sync_status') ? { chunkSyncStatus: text(item, 'chunk_sync_status') } : {}),
    ...(text(item, 'chunk_synced_at') ? { chunkSyncedAt: text(item, 'chunk_synced_at') } : {}),
    ...(optionalNumberValue(item, 'revision_count') === undefined ? {} : {
      revisionCount: optionalNumberValue(item, 'revision_count'),
    }),
    ...(optionalNumberValue(item, 'latest_revision', 'latest_revision_number') === undefined ? {} : {
      latestRevision: optionalNumberValue(item, 'latest_revision', 'latest_revision_number'),
    }),
    status,
    ...(syncError ? { syncError } : {}),
    updatedAt: dateText(item, 'updated_at', 'created_at'),
  };
}

export function mapArticle(item: ApiRecord): Article {
  const reviewStatus = text(item, 'review_status').toLowerCase();
  const rawStatus = text(item, 'workflow_status', 'status').toLowerCase();
  const isTrashed = Boolean(text(item, 'deleted_at')) || text(item, 'status').toLowerCase() === 'trash';
  const status: Article['status'] = isTrashed
    ? 'trash'
    : rawStatus === 'published'
    ? 'published'
    : rawStatus === 'trash' || rawStatus === 'trashed' || rawStatus === 'deleted'
      ? 'trash'
      : reviewStatus === 'pending'
        ? 'review'
        : 'draft';
  const qualityValue = value(item, 'ai_quality');
  const quality = qualityValue && typeof qualityValue === 'object' && !Array.isArray(qualityValue)
    ? qualityValue as ApiRecord
    : undefined;
  const optimizationValue = value(quality, 'optimization') ?? value(item, 'optimization');
  const optimization = optimizationValue && typeof optimizationValue === 'object' && !Array.isArray(optimizationValue)
    ? optimizationValue as ApiRecord
    : undefined;
  const qualityConfigVersion = numberValue(quality, 'config_version');
  return {
    id: text(item, 'id'),
    title: text(item, 'title') || '未命名文章',
    slug: text(item, 'slug'),
    summary: text(item, 'excerpt', 'summary'),
    content: text(item, 'content'),
    category: text(item, 'category_name', 'category') || '未分类',
    author: text(item, 'author_name', 'author') || '未署名',
    status,
    apiStatus: rawStatus || undefined,
    views: numberValue(item, 'views', 'view_count'),
    seoTitle: text(item, 'seo_title', 'meta_title') || text(item, 'title'),
    seoKeywords: list(value(item, 'keywords', 'seo_keywords')),
    seoDescription: text(item, 'meta_description', 'seo_description', 'excerpt'),
    createdAt: dateText(item, 'created_at', 'published_at'),
    distributedTo: list(value(item, 'distributed_to')),
    geoScore: numberValue(quality, 'score', 'overall_score') || undefined,
    reviewStatus: reviewStatus || undefined,
    aiQualityStatus: text(quality, 'status') || undefined,
    aiQualityDecision: text(quality, 'decision') || undefined,
    aiQualityResultLabel: text(quality, 'result_label') || undefined,
    aiQualityScore: optionalNumberValue(quality, 'score'),
    aiQualityPassScore: optionalNumberValue(quality, 'pass_score'),
    aiQualityOverrideMinScore: optionalNumberValue(quality, 'manual_override_min_score'),
    aiQualityIsOverridden: booleanValue(quality, 'is_overridden') ?? undefined,
    aiQualityReason: text(quality, 'summary') || undefined,
    ...(quality ? { aiQuality: quality } : {}),
    ...(qualityConfigVersion > 0 ? { aiQualityConfigVersion: qualityConfigVersion } : {}),
    ...(optimization ? { aiOptimization: optimization } : {}),
    apiCategoryId: numberValue(item, 'category_id') || undefined,
    apiAuthorId: numberValue(item, 'author_id') || undefined,
    apiTaskId: numberValue(item, 'task_id') || undefined,
  };
}

export function mapArticles(page: PaginatedResponse<ApiRecord> | undefined): Article[] {
  return getPageItems<ApiRecord>(page).map(mapArticle);
}

export function mapTask(item: ApiRecord): Task {
  const rawStatus = text(item, 'status').toLowerCase();
  const status: Task['status'] = rawStatus === 'active' || rawStatus === 'running'
    ? 'running'
    : rawStatus === 'paused' || rawStatus === 'stopped'
      ? 'paused'
      : rawStatus === 'completed' || rawStatus === 'done'
        ? 'completed'
        : 'idle';
  const publishScope = text(item, 'publish_scope', 'distribution_scope');
  const distributionScope: Task['distributionScope'] = publishScope === 'distribution_only' || publishScope === 'channels_only'
    ? 'channels_only'
    : publishScope === 'local_only'
      ? 'local_only'
      : 'all';
  const fixedCategoryId = numberValue(item, 'fixed_category_id') || undefined;
  const modelId = numberValue(item, 'ai_model_id') || undefined;
  const publishIntervalSeconds = numberValue(item, 'publish_interval') || undefined;
  const taskProgress = value(item, 'task_progress');
  const progress = taskProgress && typeof taskProgress === 'object' && !Array.isArray(taskProgress)
    ? taskProgress as ApiRecord
    : undefined;
  const explicitSchedule = text(item, 'schedule_description', 'schedule');
  const schedule = explicitSchedule || intervalText(publishIntervalSeconds || 0) || '按计划执行';
  const categoryName = text(item, 'fixed_category_name', 'category_name', 'target_category');
  // `updated_at` changes for configuration edits and must not masquerade as
  // an execution timestamp. Prefer the explicit batch field, then the
  // structured progress snapshot, and only use record timestamps as a final
  // display fallback when the server has no run information at all.
  const explicitLastRun = text(item, 'batch_last_run', 'last_run_at');
  const progressLastRun = text(progress, 'last_run_at');
  const lastRunAt = explicitLastRun || progressLastRun || text(item, 'updated_at', 'created_at') || '—';
  return {
    id: text(item, 'id'),
    name: text(item, 'name') || '未命名任务',
    status,
    // Task list projections currently expose fixed_category_id but not its
    // category name.  Keep that fact visible instead of claiming a smart
    // category was selected; the UI can replace the ID with a catalog name.
    targetCategory: categoryName || (fixedCategoryId ? `分类 #${fixedCategoryId}` : '智能分类'),
    aiModel: text(item, 'ai_model_name', 'model_name', 'ai_model_id') || '未配置模型',
    batchLimit: numberValue(item, 'article_limit', 'batch_limit', 'draft_limit') || 1,
    generatedCount: numberValue(item, 'created_count', 'generated_count', 'article_count'),
    schedule,
    lastRunAt,
    distributionScope,
    rawStatus,
    apiCategoryId: fixedCategoryId,
    apiModelId: modelId,
    titleLibraryId: numberValue(item, 'title_library_id') || undefined,
    promptId: numberValue(item, 'prompt_id') || undefined,
    authorId: numberValue(item, 'author_id') || undefined,
    knowledgeBaseIds: list(value(item, 'knowledge_base_ids'))
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0),
    modelSelectionMode: text(item, 'model_selection_mode') || undefined,
    publishScope: publishScope || undefined,
    categoryMode: text(item, 'category_mode') || undefined,
    isLoop: booleanValue(item, 'is_loop'),
    autoKeywords: booleanValue(item, 'auto_keywords'),
    autoDescription: booleanValue(item, 'auto_description'),
    aiQualityEnabled: booleanValue(item, 'ai_quality_enabled'),
    // 改质检字段时后端要求回传这个版本号（乐观并发）。列表与详情投影都给了它，
    // 只是以前没人读——于是保存任务必然 409「请提供当前任务 AI 质检配置版本」。
    aiQualityConfigVersion: numberValue(item, 'config_version', 'ai_quality_config_version') || undefined,
    publishIntervalSeconds,
    scheduleEnabled: booleanValue(item, 'schedule_enabled'),
    batchStatus: text(item, 'batch_status', 'latest_job_status') || undefined,
    batchErrorMessage: text(item, 'batch_error_message') || undefined,
    latestJobId: text(item, 'latest_job_id') || undefined,
    latestJobStatus: text(item, 'latest_job_status') || undefined,
    latestJobUpdatedAt: dateText(item, 'latest_job_updated_at') === '—'
      ? undefined
      : dateText(item, 'latest_job_updated_at'),
    latestJobErrorCode: text(item, 'latest_job_error_code') || undefined,
    needReview: booleanValue(item, 'need_review') ?? false,
    progress,
  };
}

export function mapTasks(page: PaginatedResponse<ApiRecord> | undefined): Task[] {
  return getPageItems<ApiRecord>(page).map(mapTask);
}

function optionalPositiveId(record: ApiRecord | undefined, ...keys: string[]): number | undefined {
  const normalized = numberValue(record, ...keys);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : undefined;
}

export function mapTaskWorker(item: ApiRecord): TaskWorker {
  const status = text(item, 'status').toLowerCase() || 'unknown';
  const memoryMb = Number(value(item, 'memory_mb'));
  const peakMemoryMb = Number(value(item, 'peak_memory_mb'));
  const currentJobId = optionalPositiveId(item, 'current_job_id');
  const taskId = optionalPositiveId(item, 'task_id');
  const articleId = optionalPositiveId(item, 'article_id');
  return {
    workerId: text(item, 'worker_id') || 'unknown',
    status,
    statusLabel: text(item, 'status_label') || status,
    summary: text(item, 'summary'),
    isStale: booleanValue(item, 'is_stale') ?? status === 'stale',
    ...(currentJobId ? { currentJobId: String(currentJobId) } : {}),
    ...(taskId ? { taskId: String(taskId) } : {}),
    ...(text(item, 'task_name') ? { taskName: text(item, 'task_name') } : {}),
    ...(articleId ? { articleId: String(articleId) } : {}),
    ...(text(item, 'article_title') ? { articleTitle: text(item, 'article_title') } : {}),
    ...(Number.isFinite(memoryMb) && value(item, 'memory_mb') !== null ? { memoryMb } : {}),
    ...(Number.isFinite(peakMemoryMb) && value(item, 'peak_memory_mb') !== null ? { peakMemoryMb } : {}),
    ...(text(item, 'last_seen_at') ? { lastSeenAt: text(item, 'last_seen_at') } : {}),
    lastSeenHuman: text(item, 'last_seen_human') || '—',
  };
}

export function mapTaskWorkers(data: ApiRecord | undefined): TaskWorker[] {
  const items = value(data, 'items');
  return Array.isArray(items)
    ? items.filter((item): item is ApiRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item)).map(mapTaskWorker)
    : [];
}

export function mapTaskTitleReadiness(data: ApiRecord): TaskTitleReadiness {
  const library = value(data, 'library');
  const libraryRecord = library && typeof library === 'object' && !Array.isArray(library)
    ? library as ApiRecord
    : {};
  const task = value(data, 'task');
  const taskRecord = task && typeof task === 'object' && !Array.isArray(task)
    ? task as ApiRecord
    : {};
  const rawIssues = value(data, 'issues');
  const rawConflicts = value(data, 'conflicts');
  const rawStatus = text(data, 'status').toLowerCase();
  const status: TaskTitleReadiness['status'] = rawStatus === 'ready' || rawStatus === 'warning'
    ? rawStatus
    : 'blocked';

  return {
    status,
    canSave: booleanValue(data, 'can_save') ?? false,
    canActivate: booleanValue(data, 'can_activate') ?? false,
    requiresAcknowledgement: booleanValue(data, 'requires_acknowledgement') ?? false,
    library: {
      ...(optionalPositiveId(libraryRecord, 'id') ? { id: optionalPositiveId(libraryRecord, 'id') } : {}),
      name: text(libraryRecord, 'name'),
      total: numberValue(libraryRecord, 'total'),
      used: numberValue(libraryRecord, 'used'),
      available: numberValue(libraryRecord, 'available'),
    },
    task: {
      ...(optionalPositiveId(taskRecord, 'id') ? { id: optionalPositiveId(taskRecord, 'id') } : {}),
      status: text(taskRecord, 'status'),
      articleLimit: numberValue(taskRecord, 'article_limit'),
      createdCount: numberValue(taskRecord, 'created_count'),
      remaining: numberValue(taskRecord, 'remaining'),
      isLoop: booleanValue(taskRecord, 'is_loop') ?? false,
    },
    shortage: numberValue(data, 'shortage'),
    suggestedArticleLimit: numberValue(data, 'suggested_article_limit'),
    conflictCount: numberValue(data, 'conflict_count'),
    redactedConflictCount: numberValue(data, 'redacted_conflict_count'),
    conflicts: Array.isArray(rawConflicts)
      ? rawConflicts
          .filter((item): item is ApiRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
          .map((item) => ({
            id: numberValue(item, 'id'),
            name: text(item, 'name'),
            remaining: numberValue(item, 'remaining'),
            isLoop: booleanValue(item, 'is_loop') ?? false,
          }))
      : [],
    issues: Array.isArray(rawIssues)
      ? rawIssues
          .filter((item): item is ApiRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
          .map((item) => ({
            code: text(item, 'code'),
            severity: text(item, 'severity'),
          }))
          .filter((item) => item.code !== '')
      : [],
  };
}

export function mapKnowledgeChunks(page: PaginatedResponse<ApiRecord> | undefined, fallbackKbId = ''): KnowledgeChunk[] {
  return getPageItems<ApiRecord>(page).map((item) => ({
    id: text(item, 'id'),
    kbId: text(item, 'knowledge_base_id', 'kb_id') || fallbackKbId,
    title: text(item, 'title') || `切片 ${text(item, 'chunk_index') || text(item, 'id')}`,
    content: text(item, 'content'),
    tokenCount: numberValue(item, 'token_count', 'tokens'),
    // The v1 chunk serializer does not expose embedding state.  Keep the
    // property undefined in that case instead of claiming every chunk is
    // embedded (or claiming that none are).
    ...(booleanValue(item, 'has_embedding', 'embedded', 'embedding') === undefined
      ? {}
      : { hasEmbedding: booleanValue(item, 'has_embedding', 'embedded', 'embedding') }),
  }));
}

export function mapDistributionChannel(item: ApiRecord): DistributionChannel {
  const rawType = text(item, 'channel_type') || 'geoflow_agent';
  const type: DistributionChannel['type'] = rawType === 'wordpress_rest'
    ? 'wordpress_rest'
    : rawType === 'generic_http_api'
      ? 'generic_http'
      : rawType === 'hosted_site'
        ? 'hosted_site'
      : 'tongzhuo_geo_agent';
  const rawStatus = text(item, 'status') || 'paused';
  const status: DistributionChannel['status'] = rawStatus === 'active'
    || rawStatus === 'paused'
    || rawStatus === 'deleting'
    || rawStatus === 'syncing'
    || rawStatus === 'disconnected'
    ? rawStatus
    : 'disconnected';
  return {
    id: text(item, 'id'),
    name: text(item, 'name') || '未命名渠道',
    type,
    endpoint_url: text(item, 'endpoint_url'),
    domain: text(item, 'domain'),
    channel_type: rawType === 'wordpress_rest' || rawType === 'generic_http_api' || rawType === 'geoflow_agent' || rawType === 'hosted_site'
      ? rawType
      : 'geoflow_agent',
    targetUrl: text(item, 'endpoint_url', 'domain'),
    status,
    rawStatus,
    articlesCount: numberValue(item, 'articles_count'),
    lastSyncedAt: text(item, 'last_health_checked_at'),
    authMethod: type === 'wordpress_rest' ? 'WordPress REST' : type === 'generic_http' ? 'HTTP API' : type === 'hosted_site' ? 'Hosted Site' : '桐灼GEO HMAC',
    description: text(item, 'description'),
    lastHealthStatus: text(item, 'last_health_status') || 'not_checked',
    lastErrorMessage: text(item, 'last_error_message') || undefined,
    pendingCount: numberValue(item, 'pending_count'),
    failedCount: numberValue(item, 'failed_count'),
  };
}

export function emptyCatalog(): CatalogResponse {
  return {
    models: [],
    prompts: [],
    quality_prompts: [],
    keyword_libraries: [],
    title_libraries: [],
    image_libraries: [],
    knowledge_bases: [],
    authors: [],
    categories: [],
  };
}
