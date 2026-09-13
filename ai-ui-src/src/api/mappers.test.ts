import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapArticle,
  mapCatalogModels,
  mapCatalogPrompts,
  mapDistributionChannel,
  mapKnowledgeBase,
  mapKnowledgeChunks,
  mapTask,
  mapTaskTitleReadiness,
  mapTaskWorkers,
  getPageItems,
  getPaginationMeta,
} from './mappers';

test('mapArticle preserves 桐灼GEO workflow and quality fields', () => {
  const article = mapArticle({
    id: 12,
    title: '可信内容',
    slug: 'trusted-content',
    status: 'published',
    review_status: 'approved',
    category_name: '案例',
    author_name: '管理员',
    excerpt: '摘要',
    content: '# 正文',
    keywords: 'GEO, RAG，引用',
    created_at: '2026-09-05 10:00:00',
    ai_quality: {
      status: 'completed',
      decision: 'passed',
      score: 93,
      summary: '证据充分',
    },
  });

  assert.equal(article.id, '12');
  assert.equal(article.status, 'published');
  assert.equal(article.reviewStatus, 'approved');
  assert.equal(article.aiQualityStatus, 'completed');
  assert.equal(article.geoScore, 93);
  assert.deepEqual(article.seoKeywords, ['GEO', 'RAG', '引用']);
  assert.equal(article.category, '案例');
  assert.equal(article.author, '管理员');
});

test('mapArticle keeps the quality configuration version and optimization projection', () => {
  const article = mapArticle({
    id: 14,
    title: '可复检文章',
    status: 'draft',
    ai_quality: {
      config_version: 6,
      status: 'completed',
      decision: 'needs_review',
      optimization: {
        run_id: 23,
        status: 'candidate_ready',
        can_apply: true,
        candidate_hash: 'hash',
      },
    },
  });

  assert.equal(article.aiQualityConfigVersion, 6);
  assert.equal(article.aiQuality?.config_version, 6);
  assert.equal(article.aiOptimization?.run_id, 23);
});

test('mapArticle treats draft articles awaiting review as review state', () => {
  const article = mapArticle({
    id: 13,
    title: '待审核内容',
    status: 'draft',
    review_status: 'pending',
  });

  assert.equal(article.status, 'review');
  assert.equal(article.reviewStatus, 'pending');
});

test('mapCatalogPrompts does not expose fields omitted by the catalog contract', () => {
  const [prompt] = mapCatalogPrompts([{
    id: 7,
    name: '内容提示词',
    type: 'content',
    // Deliberately include legacy-looking fields: catalog v1 must not render
    // them as authoritative prompt source text.
    content: '不应在目录响应中当作正文',
    system_prompt: 'also not exposed',
  }]);

  assert.equal(prompt.id, '7');
  assert.equal(prompt.category, 'content');
  assert.equal(prompt.systemPrompt, '');
  assert.equal(prompt.userPromptTemplate, '');
});

test('mapCatalogModels preserves the real v1 model projection without fabricating provider metadata', () => {
  const [model] = mapCatalogModels([{
    id: 5,
    name: '企业内容模型',
    version: '2026.09',
    model_type: 'chat',
    status: 'active',
    failover_priority: 20,
    is_available: true,
    is_shared: false,
  }]);

  assert.equal(model.provider, 'unknown');
  assert.equal(model.modelId, undefined);
  assert.equal(model.contextWindow, undefined);
  assert.equal(model.version, '2026.09');
  assert.equal(model.status, 'active');
  assert.equal(model.isAvailable, true);
  assert.equal(model.isShared, false);
});

test('mapTask keeps raw server state and converts publish scope', () => {
  const task = mapTask({
    id: 4,
    name: '每日生成',
    status: 'paused',
    publish_scope: 'local_only',
    article_limit: 8,
    created_count: 3,
    need_review: true,
    task_progress: { last_error_message: null },
  });

  assert.equal(task.status, 'paused');
  assert.equal(task.rawStatus, 'paused');
  assert.equal(task.distributionScope, 'local_only');
  assert.equal(task.batchLimit, 8);
  assert.equal(task.generatedCount, 3);
  assert.equal(task.needReview, true);
});

test('mapTask uses task projection field names and renders publish interval safely', () => {
  const task = mapTask({
    id: 8,
    name: '定时任务',
    status: 'paused',
    fixed_category_id: 17,
    ai_model_id: 4,
    ai_model_name: '内容模型',
    publish_interval: 3600,
    batch_last_run: '2026-09-05 08:00:00',
    batch_status: 'failed',
    batch_error_message: 'quality_gate_blocked',
    task_progress: { last_run_at: '2026-09-04 08:00:00' },
  });

  assert.equal(task.targetCategory, '分类 #17');
  assert.equal(task.aiModel, '内容模型');
  assert.equal(task.apiCategoryId, 17);
  assert.equal(task.apiModelId, 4);
  assert.equal(task.publishIntervalSeconds, 3600);
  assert.equal(task.schedule, '每 1 小时');
  assert.equal(task.lastRunAt, '2026-09-05 08:00:00');
  assert.equal(task.batchStatus, 'failed');
  assert.equal(task.batchErrorMessage, 'quality_gate_blocked');
});

test('mapTask falls back to nested task progress when batch_last_run is absent', () => {
  const task = mapTask({
    id: 9,
    name: '无运行记录',
    status: 'paused',
    task_progress: { last_run_at: '2026-09-03 09:30:00' },
  });

  assert.equal(task.lastRunAt, '2026-09-03 09:30:00');
});

test('mapTask does not use updated_at when a nested run timestamp is available', () => {
  const task = mapTask({
    id: 10,
    name: '已配置但未重跑',
    status: 'paused',
    updated_at: '2026-09-05 18:00:00',
    task_progress: { last_run_at: '2026-09-01 07:15:00' },
  });

  assert.equal(task.lastRunAt, '2026-09-01 07:15:00');
});

test('mapTaskWorkers preserves server heartbeat state and linked execution context', () => {
  const workers = mapTaskWorkers({
    items: [{
      worker_id: 'worker-a',
      status: 'stale',
      status_label: '已失联',
      summary: '最近没有心跳',
      is_stale: true,
      current_job_id: 41,
      task_id: 7,
      task_name: '每日生成',
      article_id: 12,
      article_title: '可信内容',
      memory_mb: 18.5,
      last_seen_human: '5 分钟前',
    }],
  });

  assert.equal(workers.length, 1);
  assert.equal(workers[0].workerId, 'worker-a');
  assert.equal(workers[0].status, 'stale');
  assert.equal(workers[0].isStale, true);
  assert.equal(workers[0].currentJobId, '41');
  assert.equal(workers[0].taskName, '每日生成');
  assert.equal(workers[0].memoryMb, 18.5);
});

test('mapTaskTitleReadiness maps blockers, shortages, and shared-task warnings', () => {
  const report = mapTaskTitleReadiness({
    status: 'blocked',
    can_save: false,
    can_activate: false,
    requires_acknowledgement: true,
    library: { id: 4, name: '标题库', total: 2, used: 1, available: 1 },
    task: { id: 7, status: 'active', article_limit: 3, created_count: 0, remaining: 3, is_loop: false },
    shortage: 2,
    suggested_article_limit: 1,
    conflict_count: 1,
    redacted_conflict_count: 0,
    conflicts: [{ id: 9, name: '另一个任务', remaining: 1, is_loop: false }],
    issues: [
      { code: 'title_library_shortage', severity: 'blocking' },
      { code: 'title_library_shared', severity: 'warning' },
    ],
  });

  assert.equal(report.status, 'blocked');
  assert.equal(report.canActivate, false);
  assert.equal(report.library.available, 1);
  assert.equal(report.shortage, 2);
  assert.equal(report.conflicts[0].name, '另一个任务');
  assert.deepEqual(report.issues.map((issue) => issue.code), ['title_library_shortage', 'title_library_shared']);
});

test('mapKnowledgeBase maps processing/indexed states without inventing counts', () => {
  const processing = mapKnowledgeBase({
    id: 2,
    name: '产品资料',
    chunk_sync_status: 'processing',
    document_count: 0,
    chunk_count: 0,
    embedded_count: 0,
  });
  const indexed = mapKnowledgeBase({
    id: 3,
    name: '已索引',
    chunk_sync_status: 'ready',
    document_count: 2,
    chunk_count: 18,
    embedded_count: 18,
  });

  assert.equal(processing.status, 'processing');
  assert.equal(indexed.status, 'indexed');
  assert.equal(indexed.chunkCount, 18);
  assert.equal(indexed.embeddedCount, 18);
});

test('mapKnowledgeBase keeps chunk synchronization errors distinct from ready', () => {
  const failed = mapKnowledgeBase({
    id: 4,
    name: '失败库',
    chunk_sync_status: 'failed',
    chunk_sync_error: '切片服务不可用',
  });

  assert.equal(failed.status, 'failed');
  assert.equal(failed.syncError, '切片服务不可用');
});

test('mapKnowledgeBase leaves unsupported counts unknown instead of defaulting to zero', () => {
  const mapped = mapKnowledgeBase({
    id: 5,
    name: '只有正文的库',
    content: '正文即使存在也不能代表文档数或向量数',
    file_path: 'knowledge-bases/source.md',
    chunk_sync_status: 'idle',
  });

  assert.equal(mapped.documentCount, undefined);
  assert.equal(mapped.chunkCount, undefined);
  assert.equal(mapped.embeddedCount, undefined);
  assert.equal(mapped.vectorizedChunkCount, undefined);
});

test('mapKnowledgeBase maps 桐灼GEO vectorized chunk projection and preserves explicit zero', () => {
  const mapped = mapKnowledgeBase({
    id: 6,
    name: '尚未向量化',
    chunk_count: 4,
    vectorized_chunk_count: 0,
    document_count: 0,
    source_name: '人工录入',
  });

  assert.equal(mapped.chunkCount, 4);
  assert.equal(mapped.embeddedCount, 0);
  assert.equal(mapped.vectorizedChunkCount, 0);
  assert.equal(mapped.documentCount, 0);
  assert.equal(mapped.sourceName, '人工录入');
});

test('getPaginationMeta reads canonical and Laravel paginator metadata without using row count', () => {
  assert.deepEqual(
    getPaginationMeta({
      items: [{ id: 1 }],
      pagination: { page: 2, per_page: 20, total: 41, total_pages: 3 },
    }),
    { page: 2, perPage: 20, total: 41, totalPages: 3 },
  );
  assert.deepEqual(
    getPaginationMeta({
      items: [{ id: 1 }],
      meta: { current_page: 4, per_page: 15, total: 60, last_page: 4, from: 46, to: 60 },
    }),
    { page: 4, perPage: 15, total: 60, totalPages: 4, from: 46, to: 60 },
  );
  assert.equal(getPaginationMeta({ items: [{ id: 1 }] }), undefined);
});

test('getPageItems accepts the 桐灼GEO data projection and does not fabricate rows', () => {
  assert.deepEqual(getPageItems({ items: [{ id: 1 }] }), [{ id: 1 }]);
  assert.deepEqual(getPageItems({ data: { items: [{ id: 2 }] } }), [{ id: 2 }]);
  assert.deepEqual(getPageItems({ items: [] }), []);
  assert.deepEqual(getPageItems({ pagination: { total: 99 } }), []);
});

test('mapKnowledgeChunks leaves embedding state unknown when v1 omits it', () => {
  const [chunk] = mapKnowledgeChunks({
    items: [{
      id: 9,
      knowledge_base_id: 2,
      chunk_index: 0,
      content: '事实片段',
      token_count: 12,
    }],
  }, '2');

  assert.equal(chunk.kbId, '2');
  assert.equal(chunk.title, '切片 0');
  assert.equal(chunk.tokenCount, 12);
  assert.equal(chunk.hasEmbedding, undefined);
});

test('mapDistributionChannel preserves backend lifecycle states', () => {
  const statuses = ['active', 'paused', 'deleting', 'syncing', 'disconnected'] as const;
  for (const rawStatus of statuses) {
    const channel = mapDistributionChannel({
      id: 10,
      name: `渠道-${rawStatus}`,
      channel_type: 'geoflow_agent',
      endpoint_url: 'https://example.test/agent',
      status: rawStatus,
    });
    assert.equal(channel.status, rawStatus);
    assert.equal(channel.rawStatus, rawStatus);
  }
});

test('mapDistributionChannel keeps unknown lifecycle values auditable without enabling actions', () => {
  const channel = mapDistributionChannel({
    id: 11,
    name: '未知状态渠道',
    channel_type: 'geoflow_agent',
    endpoint_url: 'https://example.test/agent',
    status: 'error',
  });
  assert.equal(channel.status, 'disconnected');
  assert.equal(channel.rawStatus, 'error');
});
