/**
 * A small, browser-safe client for 桐灼GEO's authenticated API v1.
 *
 * The Gemini UI used to talk to an unauthenticated demo API with a different
 * response shape.  This client deliberately knows only the 桐灼GEO contract:
 * JSON envelopes, Bearer tokens, request IDs and idempotency keys.  Keeping it
 * separate makes it possible to migrate views one by one without silently
 * falling back to fake data in API mode.
 */

export interface ApiEnvelope<T> {
  success: boolean;
  data: T | null;
  error: null | {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
  meta?: {
    request_id?: string;
    timestamp?: string;
  };
}

export interface ApiErrorDetails {
  [key: string]: unknown;
}

export class GeoFlowApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetails;
  readonly requestId: string | null;

  constructor(
    message: string,
    status: number,
    code = 'request_failed',
    details: ApiErrorDetails = {},
    requestId: string | null = null,
  ) {
    super(message);
    this.name = 'GeoFlowApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export interface ApiAdminSummary {
  id: number;
  username: string;
  display_name: string;
  role: string;
  status: string;
}

export interface ApiAuthSession {
  token: string;
  scopes: string[];
  expires_at: string | null;
  admin: ApiAdminSummary;
}

export interface CatalogResponse {
  models: Array<Record<string, unknown>>;
  prompts: Array<Record<string, unknown>>;
  /** Quality-check prompt templates, returned separately from the editable ones. */
  quality_prompts: Array<Record<string, unknown>>;
  keyword_libraries: Array<Record<string, unknown>>;
  title_libraries: Array<Record<string, unknown>>;
  image_libraries: Array<Record<string, unknown>>;
  knowledge_bases: Array<Record<string, unknown>>;
  authors: Array<Record<string, unknown>>;
  categories: Array<Record<string, unknown>>;
}

export interface PaginatedResponse<T> {
  items: T[];
  /**
   * 桐灼GEO v1 currently returns this object from material/list endpoints.
   * Keep the raw aliases too: older Laravel projections may put the same
   * values under `meta` (current_page/last_page), and the UI must not infer a
   * total from the number of rows in the first page.
   */
  pagination?: ApiPagination;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ApiPagination {
    page?: number;
    per_page?: number;
    total?: number;
    total_pages?: number;
    current_page?: number;
    last_page?: number;
    from?: number | null;
    to?: number | null;
    perPage?: number;
    totalPages?: number;
    currentPage?: number;
    lastPage?: number;
    [key: string]: unknown;
}

export interface AiWorkspaceStreamEvent {
  event: 'status' | 'delta' | 'title' | 'done' | 'error' | string;
  data: ApiRecord;
}

/** 「见度检测」接入：连接投影（后端从不回传 token，连密文都不给）。 */
export interface JianduConnectionProjection {
  id: number;
  account: string;
  organization_name: string;
  user_name: string;
  status: string;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  last_refreshed_at: string | null;
  connected_at: string | null;
}

/** `POST jiandu/session` 的结果：成功直连，或需要新设备验证码的中间态。 */
export interface JianduSessionResult {
  requires_verification: boolean;
  channel: 'sms' | 'email' | null;
  message: string;
  connection: JianduConnectionProjection | null;
}

/** 见度数据响应的来源标注（页面上必须如实说明这批数字来自外部检测系统）。 */
export interface JianduSourceMeta {
  kind: string;
  system?: string;
  fetched_at?: string;
  [key: string]: unknown;
}

export interface JianduProjectsResponse {
  source: JianduSourceMeta;
  projects: Array<{ id: string; name: string; brand_name: string; industry: string }>;
}

export interface JianduOverviewResponse {
  source: JianduSourceMeta;
  project_id: string;
  overview: ApiRecord;
}

export interface JianduDetectionsResponse {
  source: JianduSourceMeta;
  project_id: string;
  detections: ApiRecord;
}

export interface JianduReportsResponse {
  source: JianduSourceMeta;
  project_id: string;
  reports: ApiRecord;
}

export interface JianduMeResponse {
  source: JianduSourceMeta;
  account: ApiRecord;
}

export type SystemUpdateOperationKind = 'update' | 'backup' | 'rollback' | 'verify';

export interface KnowledgeSearchResponse {
  knowledge_base: {
    id: number;
    name: string;
  };
  query: string;
  items: ApiRecord[];
}

/**
 * A reviewed evidence pointer returned by the atomic-fact workflow.
 *
 * `source_locator` is intentionally allowed to be either an object or an
 * array: the Laravel presenter preserves the JSON shape stored for a chunk,
 * and both shapes are valid for source locators.
 */
export interface KnowledgeFactEvidence {
  id: number;
  value_id: number;
  knowledge_chunk_id: number | null;
  source_hash: string;
  content_hash: string;
  source_locator: ApiRecord | unknown[];
  excerpt: string;
  excerpt_hash: string;
  is_primary: boolean;
  created_at?: string | null;
  [key: string]: unknown;
}

export interface KnowledgeFactValue {
  id: number;
  fact_id: number;
  canonical_value: ApiRecord;
  canonical_answer: string;
  temporal_kind: string;
  scope: ApiRecord | unknown[];
  valid_from?: string | null;
  valid_to?: string | null;
  observed_at?: string | null;
  comparison_policy: ApiRecord;
  review_status: string;
  conflict_status: string;
  lock_version: number;
  evidences: KnowledgeFactEvidence[];
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface KnowledgeFact {
  id: number;
  stable_key: string;
  label: string;
  subject: string;
  predicate: string;
  value_type: string;
  locale: string;
  aliases: string[];
  importance: string;
  usage_scope: string;
  review_status: string;
  is_enabled: boolean;
  lock_version: number;
  values: KnowledgeFactValue[];
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface KnowledgeFactRevision {
  id: number;
  library_id: number;
  version: number;
  library_hash: string;
  source_hash: string;
  published_by_admin_id: number | null;
  published_at?: string | null;
  restored_from_revision_id: number | null;
  publisher?: {
    id: number;
    username: string;
    [key: string]: unknown;
  } | null;
  manifest?: ApiRecord;
  [key: string]: unknown;
}

export interface KnowledgeFactGenerationRun {
  id: number;
  library_id: number;
  mode: string;
  target_count: number;
  source_hash: string;
  status: string;
  ai_model_id: number | null;
  created_by_admin_id: number | null;
  request_key: string;
  retryable_failure: boolean;
  error_code?: string | null;
  error_message?: string | null;
  candidate_count?: number;
  conflict_count?: number;
  candidates?: unknown[];
  conflicts?: unknown[];
  resolved?: unknown[];
  started_at?: string | null;
  completed_at?: string | null;
  failed_at?: string | null;
  cancelled_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

export interface KnowledgeFactWorkbenchResponse {
  knowledge_base: {
    id: number;
    name: string;
    chunk_sync_status?: string;
    serving_generation?: string | null;
    serving_source_hash?: string | null;
    [key: string]: unknown;
  };
  library: {
    id: number | null;
    knowledge_base_id: number;
    summary: ApiRecord;
    publish_readiness: ApiRecord;
    [key: string]: unknown;
  };
  items: KnowledgeFact[];
  pagination: ApiPagination;
  revisions: KnowledgeFactRevision[];
  generation_runs: KnowledgeFactGenerationRun[];
  can_manage_protected: boolean;
  [key: string]: unknown;
}

export interface KnowledgeFactMutationResponse {
  fact: KnowledgeFact;
  [key: string]: unknown;
}

export interface KnowledgeFactValueMutationResponse {
  value: KnowledgeFactValue;
  [key: string]: unknown;
}

export interface KnowledgeFactEvidenceMutationResponse {
  evidence: KnowledgeFactEvidence;
  [key: string]: unknown;
}

export interface KnowledgeFactPublishResponse {
  revision: KnowledgeFactRevision;
  library?: ApiRecord;
  [key: string]: unknown;
}

export interface KnowledgeFactRestoreResponse {
  revision: KnowledgeFactRevision;
  [key: string]: unknown;
}

/** Envelope shared by every fact-generation endpoint. */
export interface KnowledgeFactGenerationResponse {
  run: KnowledgeFactGenerationRun;
  /** Server-rendered progress projection; present on create/show, not always on cancel/resolve. */
  presented?: ApiRecord;
  [key: string]: unknown;
}

/** One unresolved duplicate the generation run refused to write automatically. */
export interface KnowledgeFactGenerationConflict {
  _candidate_key: string;
  stable_key: string;
  label?: string;
  subject?: string;
  predicate?: string;
  value_type?: string;
  canonical_value?: string;
  unit?: string;
  canonical_answer?: string;
  [key: string]: unknown;
}

export interface UrlImportJobSummary {
  id: number;
  url: string;
  normalized_url: string;
  source_domain: string;
  page_title: string;
  status: string;
  current_step: string;
  progress_percent: number;
  error_message?: string;
  error_code?: string;
  retryable_failure?: boolean;
  result_ready?: boolean;
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  [key: string]: unknown;
}

export interface UrlImportDetailResponse {
  job: UrlImportJobSummary;
  options?: ApiRecord;
  result?: ApiRecord;
  logs?: Array<ApiRecord>;
  [key: string]: unknown;
}

export interface UrlScanSummary {
  id: number;
  url: string;
  normalized_url: string;
  source_domain: string;
  status: string;
  overall_score: number;
  grade: string;
  scanned_at: string;
  error_message?: string;
  created_at?: string | null;
  [key: string]: unknown;
}

export interface UrlScanResponse {
  id: number;
  url: string;
  status: string;
  error_message?: string;
  error_code?: string;
  report?: ApiRecord;
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  [key: string]: unknown;
}

export interface ThemeReplicationRecord extends ApiRecord {
  id: number;
  name: string;
  theme_id: string;
  status: string;
  ai_model_id?: number | null;
  home_url?: string;
  category_url?: string;
  article_url?: string;
  style_preference?: string;
  error_message?: string | null;
  current_version?: number;
  progress?: ApiRecord;
  can_publish?: boolean;
  can_package?: boolean;
  can_archive?: boolean;
  can_delete_drafts?: boolean;
}

export interface ThemeReplicationListResponse {
  items: ThemeReplicationRecord[];
  themes: ApiRecord[];
  models: ApiRecord[];
  schema_ready: boolean;
  [key: string]: unknown;
}

export type ApiRecord = Record<string, unknown>;

export interface GeoFlowClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  storage?: StorageLike | null;
  onUnauthorized?: () => void;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface MutationOptions {
  idempotencyKey?: string;
}

const TOKEN_STORAGE_KEY = 'geoflow.api.v1.token';
const SESSION_STORAGE_KEY = 'geoflow.api.v1.session';

function trimBaseUrl(value: string): string {
  const trimmed = String(value || '').trim();
  return trimmed.replace(/\/+$/, '');
}

function browserSessionStorage(): StorageLike | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      return window.sessionStorage;
    }
  } catch {
    // Access to storage can be denied by privacy settings.  API requests still
    // work for the current page when the caller supplies a token explicitly.
  }
  return null;
}

function requestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the dependency-free value below.
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function idempotencyKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the dependency-free value below.
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== 'undefined' && value instanceof FormData;
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

export class GeoFlowApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly storage: StorageLike | null;
  private readonly onUnauthorized?: () => void;
  private explicitToken: string | null = null;
  private _lastRequestId: string | null = null;

  constructor(options: GeoFlowClientOptions) {
    const baseUrl = trimBaseUrl(options.baseUrl);
    if (!baseUrl) {
      throw new Error('桐灼GEO API base URL is required');
    }
    this.baseUrl = baseUrl;

    // `window.fetch` is a Web IDL method in browsers.  Storing it as a bare
    // function and later invoking it as `this.fetchImpl(...)` changes its
    // receiver to the GeoFlowApiClient instance, which Chromium reports as
    // "Illegal invocation".  Test adapters are already standalone functions,
    // so only bind the native implementation to its owning global object.
    if (options.fetchImpl) {
      this.fetchImpl = options.fetchImpl;
    } else {
      const nativeFetch = typeof globalThis !== 'undefined' ? globalThis.fetch : undefined;
      if (typeof nativeFetch !== 'function') {
        throw new Error('浏览器不支持 Fetch API');
      }
      this.fetchImpl = nativeFetch.bind(typeof window !== 'undefined' ? window : globalThis);
    }
    this.storage = options.storage === undefined ? browserSessionStorage() : options.storage;
    this.onUnauthorized = options.onUnauthorized;
  }

  get lastRequestId(): string | null {
    return this._lastRequestId;
  }

  get token(): string | null {
    return this.explicitToken || this.storage?.getItem(TOKEN_STORAGE_KEY) || null;
  }

  /**
   * The API has no `current-user` endpoint.  Keep only the small login
   * projection in sessionStorage so a browser refresh can still render the
   * authenticated shell without inventing an administrator identity.  The
   * bearer token remains the source of truth for authorization.
   */
  get session(): ApiAuthSession | null {
    try {
      const raw = this.storage?.getItem(SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<ApiAuthSession>;
      const activeToken = this.token;
      const admin = parsed.admin as Partial<ApiAdminSummary> | undefined;
      if (
        typeof parsed.token !== 'string'
        || parsed.token.trim() === ''
        || parsed.token !== activeToken
        || !Array.isArray(parsed.scopes)
        || !parsed.scopes.every((scope) => typeof scope === 'string')
        || !admin
        || !Number.isInteger(admin.id)
        || Number(admin.id) <= 0
        || typeof admin.username !== 'string'
        || typeof admin.display_name !== 'string'
        || typeof admin.role !== 'string'
        || typeof admin.status !== 'string'
      ) {
        return null;
      }
      if (parsed.expires_at !== null) {
        if (typeof parsed.expires_at !== 'string') return null;
        const expiresAt = Date.parse(parsed.expires_at);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
      }
      return parsed as ApiAuthSession;
    } catch {
      return null;
    }
  }

  get authenticated(): boolean {
    return Boolean(this.token);
  }

  setToken(token: string): void {
    const normalized = String(token || '').trim();
    if (!normalized) {
      this.clearToken();
      return;
    }
    this.explicitToken = normalized;
    try {
      this.storage?.setItem(TOKEN_STORAGE_KEY, normalized);
    } catch {
      // A token supplied in memory remains usable when storage is unavailable.
    }
  }

  setSession(session: ApiAuthSession): void {
    this.setToken(session.token);
    try {
      this.storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {
      // A token supplied in memory remains usable when storage is unavailable.
    }
  }

  clearToken(): void {
    this.explicitToken = null;
    try {
      this.storage?.removeItem(TOKEN_STORAGE_KEY);
      this.storage?.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Ignore storage errors; there is no token left in memory either.
    }
  }

  async login(username: string, password: string): Promise<ApiAuthSession> {
    const data = await this.request<ApiAuthSession>('auth/login', {
      method: 'POST',
      body: { username, password },
      skipAuth: true,
    });
    if (!data || typeof data.token !== 'string' || !data.admin) {
      throw new GeoFlowApiError('登录响应缺少 Token 或管理员信息', 502, 'invalid_response');
    }
    this.setSession(data);
    return data;
  }

  /** Revoke the current bearer token server-side, then always clear its local copy. */
  async logout(): Promise<void> {
    try {
      await this.request<ApiRecord>('auth/logout', {
        method: 'POST',
        body: {},
      });
    } finally {
      this.clearToken();
    }
  }

  async catalog(): Promise<CatalogResponse> {
    return this.request<CatalogResponse>('catalog');
  }

  /** Read the authenticated administrator's editable profile projection. */
  async getAdminProfile(): Promise<ApiRecord> {
    return this.request<ApiRecord>('admin/profile');
  }

  /** Update profile fields with an optimistic profile version check. */
  async updateAdminProfile(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('admin/profile', {
      method: 'PATCH',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Change the current administrator password; the server revokes this
   * bearer token on success, so callers must clear the local session. */
  async updateAdminPassword(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('admin/password', {
      method: 'PATCH',
      // Keep the wire contract intentionally narrow even if a caller passes
      // a form object containing unrelated account fields.
      body: {
        current_password: payload.current_password,
        password: payload.password,
        password_confirmation: payload.password_confirmation,
      },
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** List non-secret API token metadata and the server-approved scope catalog. */
  async listAdminTokens(): Promise<ApiRecord> {
    return this.request<ApiRecord>('admin/tokens');
  }

  /** Create a personal API token; plaintext is returned only once by the server. */
  async createAdminToken(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('admin/tokens', {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Revoke an administrator API token. */
  /**
   * 已授权的浏览器客户端（插件的设备授权）。
   *
   * 与 `listAdminTokens` 的个人 API Token **不是一回事**：判据是 token 能力里有没有
   * `browser-operations:read`，服务端也只列/只撤这一类。
   */
  async listBrowserClients(): Promise<ApiRecord> {
    return this.request<ApiRecord>('admin/browser-clients');
  }

  async revokeBrowserClient(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('admin/browser-clients/' + this.numericId(id), {
      method: 'DELETE',
      idempotencyKey: options.idempotencyKey,
    });
  }

  async revokeAdminToken(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`admin/tokens/${this.numericId(id)}/revoke`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Read the redacted administrator activity projection. */
  async listAdminActivityLogs(params: Record<string, string | number | undefined> = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`admin/activity-logs${this.query(params)}`);
  }

  /** List all administrator accounts (super-admin only on the server). */
  async listAdminUsers(): Promise<ApiRecord> {
    return this.request<ApiRecord>('admin/users');
  }

  async getAdminUser(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`admin/users/${this.numericId(id)}`);
  }

  async createAdminUser(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('admin/users', {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async updateAdminUser(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`admin/users/${this.numericId(id)}`, {
      method: 'PATCH',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async toggleAdminUserStatus(id: string | number, nextStatus: 'active' | 'inactive', options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`admin/users/${this.numericId(id)}/status`, {
      method: 'POST',
      body: { next_status: nextStatus },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async deleteAdminUser(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`admin/users/${this.numericId(id)}`, {
      method: 'DELETE',
      idempotencyKey: options.idempotencyKey,
    });
  }

  async listAiModels(): Promise<PaginatedResponse<ApiRecord>> {
    return this.request<PaginatedResponse<ApiRecord>>('models');
  }

  async createAiModel(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('models', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async updateAiModel(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('models/' + this.numericId(id), { method: 'PATCH', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async deleteAiModel(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('models/' + this.numericId(id), { method: 'DELETE', idempotencyKey: options.idempotencyKey });
  }

  async testAiModel(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('models/' + this.numericId(id) + '/test', { method: 'POST', body: {}, idempotencyKey: options.idempotencyKey });
  }

  async setDefaultAiModel(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`models/${this.numericId(id)}/default`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async listPrompts(): Promise<PaginatedResponse<ApiRecord>> {
    return this.request<PaginatedResponse<ApiRecord>>('prompts');
  }

  async getPrompt(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>('prompts/' + this.numericId(id));
  }

  async createPrompt(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('prompts', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async updatePrompt(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('prompts/' + this.numericId(id), { method: 'PATCH', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async deletePrompt(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('prompts/' + this.numericId(id), { method: 'DELETE', idempotencyKey: options.idempotencyKey });
  }

  // ---- 特殊提示词（keyword / description）----
  // 这两类被 URL 导入流水线真实消费，口径与通用 prompt CRUD 不同：
  // 读「最新一条」、写「按类型整体覆盖」。所以单列一组端点，前端也要单列一块界面。
  async listSpecialPrompts(): Promise<ApiRecord> {
    return this.request<ApiRecord>('prompts/special');
  }

  async saveSpecialPrompt(type: 'keyword' | 'description', content: string, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`prompts/special/${type}`, { method: 'POST', body: { content }, idempotencyKey: options.idempotencyKey });
  }

  // ---- 系统级 AI 配置（超管）与个人默认 ----
  async getAiSystemSettings(): Promise<ApiRecord> {
    return this.request<ApiRecord>('ai-system-settings');
  }

  async updateChunkingConfig(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('ai-system-settings/chunking', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async updateDefaultEmbedding(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('ai-system-settings/default-embedding', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  /**
   * 一次设定本人的默认 chat / embedding。
   *
   * **字段缺省 = 保持现状、显式传 0 = 清空**——与 `setDefaultModel`（只改 chat、
   * 保留 embedding）不同；只想改一个槽位时，另一个字段干脆别传。
   */
  async setPersonalModelDefaults(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('models/defaults', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  /** AI 配置器概览计数（只读监测）。 */
  async getAiConfiguratorOverview(): Promise<ApiRecord> {
    return this.request<ApiRecord>('ai-configuration/overview');
  }

  // ---- 可见度分析模型绑定（ark / deepseek）----
  async getVisibilityModelBindings(): Promise<ApiRecord> {
    return this.request<ApiRecord>('source-providers/model-bindings');
  }

  /** 切换绑定。两个 id 都要传（0 表示解绑），服务端按类型与域名策略校验。 */
  async updateVisibilityModelBindings(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('source-providers/model-bindings', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  /** 写某条绑定的 API 配置（域名策略、密钥、限额都在服务端校验）。 */
  async saveVisibilityModelApi(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('source-providers/model-api', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  /** 探活一条绑定；会真实出站并消耗一次额度。 */
  async testVisibilityModelBinding(bindingType: 'ark' | 'deepseek', modelId: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('source-providers/model-bindings/test', {
      method: 'POST',
      body: { binding_type: bindingType, model_id: Number(modelId) },
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** 队列/Worker 健康快照 + 跨任务最近运行（旧后台 tasks/health-check 与 tasks/jobs）。 */
  async getTaskHealth(page = 1): Promise<ApiRecord> {
    return this.request<ApiRecord>(`tasks/health${this.query({ page })}`);
  }

  async listRecentTaskRuns(params: Record<string, string | number | undefined> = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`tasks/jobs${this.query(params)}`);
  }

  /**
   * 把提示词复制成可编辑副本。
   *
   * 系统内置提示词在 api/v1 里是只读的（PATCH/DELETE 都回 409），**复制是改它们的唯一途径**。
   */
  async copyPrompt(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`prompts/${this.numericId(id)}/copy`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** 来源 Provider 的真实出站探活；**会消耗一次额度**，所以是 POST 不是 GET。 */
  async testAiSourceProvider(id: string | number, query: string, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`source-providers/${this.numericId(id)}/test`, {
      method: 'POST',
      body: query.trim() === '' ? {} : { query },
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** List system-level AI visibility source providers (super administrator only). */
  async listAiSourceProviders(): Promise<PaginatedResponse<ApiRecord>> {
    return this.request<PaginatedResponse<ApiRecord>>('source-providers');
  }

  async createAiSourceProvider(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('source-providers', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async updateAiSourceProvider(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('source-providers/' + this.numericId(id), { method: 'PATCH', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async deleteAiSourceProvider(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('source-providers/' + this.numericId(id), { method: 'DELETE', idempotencyKey: options.idempotencyKey });
  }

  async getAnalyticsOverview(params: Record<string, string | number | undefined> = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`analytics/overview${this.query(params)}`);
  }

  /**
   * 旧 Blade analytics 首页的「增长总览 + 下一步该做什么的告警条」。
   *
   * 退役时这个版面一度没有入口（服务还在、只被已删的 Blade 控制器引用），后补的。
   * 它自带 60 天窗口，**不吃**分析页的时间范围与实体筛选参数。
   */
  async getGrowthOverview(): Promise<ApiRecord> {
    return this.request<ApiRecord>('analytics/growth-overview');
  }

  async getAnalyticsContent(params: Record<string, string | number | undefined> = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`analytics/content${this.query(params)}`);
  }

  async getAnalyticsTraffic(params: Record<string, string | number | undefined> = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`analytics/traffic${this.query(params)}`);
  }

  async getAnalyticsCrawlers(params: Record<string, string | number | undefined> = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`analytics/crawlers${this.query(params)}`);
  }

  async getAiVisibilityAnalytics(params: Record<string, string | number | undefined> = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`analytics/ai-visibility${this.query(params)}`);
  }

  async getDistributionAnalytics(params: Record<string, string | number | undefined> = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`analytics/distribution${this.query(params)}`);
  }

  async getLeadAnalytics(params: Record<string, string | number | undefined> = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`analytics/leads${this.query(params)}`);
  }

  // ---------------------------------------------------------------- 见度检测接入

  /** 当前见度连接（未连接时 connection 为 null）。 */
  async getJianduStatus(): Promise<{ connection: JianduConnectionProjection | null }> {
    return this.request<{ connection: JianduConnectionProjection | null }>('jiandu/status');
  }

  /** 输入见度账号密码建立连接。可能需要 verify_code（先用 sendJianduCode 发码）。 */
  async connectJianduSession(
    payload: { account: string; password: string; verify_code?: string },
    options: MutationOptions = {},
  ): Promise<JianduSessionResult> {
    return this.request<JianduSessionResult>('jiandu/session', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  /** 触发新设备验证码（channel 由连接尝试的返回告知：sms / email）。 */
  async sendJianduCode(
    payload: { channel: 'sms' | 'email'; account: string },
    options: MutationOptions = {},
  ): Promise<{ sent: boolean; message: string }> {
    return this.request<{ sent: boolean; message: string }>('jiandu/session/send-code', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  /** 断开见度连接（见度侧尽力吊销会话；重复调用幂等）。 */
  async disconnectJianduSession(options: MutationOptions = {}): Promise<{ connection: null }> {
    return this.request<{ connection: null }>('jiandu/session', { method: 'DELETE', idempotencyKey: options.idempotencyKey });
  }

  async getJianduProjects(): Promise<JianduProjectsResponse> {
    return this.request<JianduProjectsResponse>('jiandu/projects');
  }

  async getJianduOverview(params: { project_id: string; range?: string }): Promise<JianduOverviewResponse> {
    return this.request<JianduOverviewResponse>(`jiandu/overview${this.query(params)}`);
  }

  async getJianduDetections(params: { project_id: string; page?: number; page_size?: number }): Promise<JianduDetectionsResponse> {
    return this.request<JianduDetectionsResponse>(`jiandu/detections${this.query(params)}`);
  }

  async getJianduReports(params: { project_id: string; page?: number; page_size?: number }): Promise<JianduReportsResponse> {
    return this.request<JianduReportsResponse>(`jiandu/reports${this.query(params)}`);
  }

  /** 见度侧账号/套餐/额度（连接信息条用；失败可降级隐藏，不参与整屏成败）。 */
  async getJianduMe(): Promise<JianduMeResponse> {
    return this.request<JianduMeResponse>('jiandu/me');
  }

  /** Manage the real 桐灼GEO public forms and persisted lead inbox. */
  async listLeadForms(params: Record<string, string | number | undefined> = {}): Promise<PaginatedResponse<ApiRecord>> {
    return this.request<PaginatedResponse<ApiRecord>>(`lead-forms${this.query(params)}`);
  }

  async getLeadForm(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`lead-forms/${this.numericId(id)}`);
  }

  async createLeadForm(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('lead-forms', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async updateLeadForm(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`lead-forms/${this.numericId(id)}`, { method: 'PATCH', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async setLeadFormStatus(id: string | number, status: 'active' | 'inactive', expectedUpdatedAt: string, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`lead-forms/${this.numericId(id)}/status`, {
      method: 'POST',
      body: { status, expected_updated_at: expectedUpdatedAt },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async deleteLeadForm(id: string | number, expectedUpdatedAt: string, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`lead-forms/${this.numericId(id)}`, {
      method: 'DELETE',
      body: { expected_updated_at: expectedUpdatedAt },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async listLeads(params: Record<string, string | number | undefined> = {}): Promise<PaginatedResponse<ApiRecord>> {
    return this.request<PaginatedResponse<ApiRecord>>(`leads${this.query(params)}`);
  }

  async getLead(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`leads/${this.numericId(id)}`);
  }

  async updateLead(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`leads/${this.numericId(id)}`, { method: 'PATCH', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async downloadLeadExport(params: Record<string, string | number | undefined> = {}): Promise<Blob> {
    return this.downloadAuthenticated(`leads/export${this.query(params)}`, 'text/csv', '线索导出失败', 'lead_export_failed');
  }

  async getAiWorkspaceStatus(): Promise<ApiRecord> {
    return this.request<ApiRecord>('ai-workspace/status');
  }

  async listAiWorkspaceConversations(): Promise<ApiRecord> {
    return this.request<ApiRecord>('ai-workspace/conversations');
  }

  async createAiWorkspaceConversation(title?: string, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('ai-workspace/conversations', {
      method: 'POST',
      body: title ? { title } : {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async getAiWorkspaceConversation(id: string, before?: string): Promise<ApiRecord> {
    return this.request<ApiRecord>(`ai-workspace/conversations/${this.pathSegment(id)}${this.query({ before })}`);
  }

  async renameAiWorkspaceConversation(id: string, title: string, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`ai-workspace/conversations/${this.pathSegment(id)}`, {
      method: 'PATCH',
      body: { title },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async archiveAiWorkspaceConversation(id: string, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`ai-workspace/conversations/${this.pathSegment(id)}/archive`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  /**
   * Consume the native workspace's SSE response without buffering it as JSON.
   * The server persists the completed answer; callers should reload the
   * conversation after interruption to reconcile an uncertain connection.
   */
  async streamAiWorkspaceMessage(
    id: string,
    prompt: string,
    onEvent: (event: AiWorkspaceStreamEvent) => void,
    options: MutationOptions & { signal?: AbortSignal } = {},
  ): Promise<void> {
    const rid = requestId();
    const headers = new Headers({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'X-Request-Id': rid,
      'X-Idempotency-Key': options.idempotencyKey || idempotencyKey(),
    });
    const token = this.token;
    if (token) headers.set('Authorization', `Bearer ${token}`);

    let response: Response;
    try {
      response = await this.fetchImpl(this.buildUrl(`ai-workspace/conversations/${this.pathSegment(id)}/messages`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt }),
        signal: options.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new GeoFlowApiError(error instanceof Error ? error.message : '无法连接 AI 工作台', 0, 'network_error', {}, rid);
    }

    const responseRequestId = response.headers.get('X-Request-Id') || rid;
    this._lastRequestId = responseRequestId;
    if (!response.ok || !response.body) {
      let message = `AI 工作台请求失败（HTTP ${response.status}）`;
      let code = 'workspace_stream_failed';
      try {
        const payload = await response.json() as ApiEnvelope<never>;
        message = String(payload?.error?.message || message);
        code = String(payload?.error?.code || code);
      } catch {
        // Keep the HTTP fallback when a proxy returns a non-JSON error page.
      }
      if (response.status === 401) {
        this.clearToken();
        this.onUnauthorized?.();
      }
      throw new GeoFlowApiError(message, response.status, code, {}, responseRequestId);
    }

    await this.readSseStream(response.body, onEvent);
  }

  /**
   * Shared SSE frame reader. Handles both `event:`-tagged JSON frames (Laravel
   * `eventStream`) and bare `data:` lines, and never buffers the whole body.
   */
  private async readSseStream(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: { event: string; data: ApiRecord }) => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const emitBlocks = (final = false) => {
      buffer = buffer.replace(/\r\n/g, '\n');
      const blocks = buffer.split('\n\n');
      if (final) buffer = '';
      else buffer = blocks.pop() || '';
      blocks.forEach((block) => {
        if (!block.trim()) return;
        let event = 'message';
        const dataLines: string[] = [];
        block.split('\n').forEach((line) => {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        });
        if (dataLines.length === 0) return;
        try {
          const parsed = JSON.parse(dataLines.join('\n'));
          onEvent({ event, data: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ApiRecord : { value: parsed } });
        } catch {
          onEvent({ event, data: { content: dataLines.join('\n') } });
        }
      });
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      emitBlocks();
    }
    buffer += decoder.decode();
    emitBlocks(true);
  }

  /**
   * Editor assistant: candidate titles from the title libraries. Backs the
   * "换一个推荐标题" control in the article editor.
   */
  async listEditorTitles(
    params: Record<string, string | number | undefined> = {},
  ): Promise<{ items: ApiRecord[]; pagination: ApiRecord }> {
    return this.request<{ items: ApiRecord[]; pagination: ApiRecord }>(
      `articles/editor/titles${this.query(params)}`,
    );
  }

  /**
   * Editor assistant: generate article content for the editor in one streamed
   * call. Frames are `delta` (raw chunks while the model writes), one
   * `replacement` with the final cleaned content, then `done` or `error`.
   */
  async streamEditorGeneration(
    payload: ApiRecord,
    onEvent: (event: { event: string; data: ApiRecord }) => void,
    options: MutationOptions & { signal?: AbortSignal } = {},
  ): Promise<void> {
    const rid = requestId();
    const headers = new Headers({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'X-Request-Id': rid,
      'X-Idempotency-Key': options.idempotencyKey || idempotencyKey(),
    });
    const token = this.token;
    if (token) headers.set('Authorization', `Bearer ${token}`);

    let response: Response;
    try {
      response = await this.fetchImpl(this.buildUrl('articles/editor/generate'), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: options.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new GeoFlowApiError(error instanceof Error ? error.message : '无法连接编辑器助手', 0, 'network_error', {}, rid);
    }

    const responseRequestId = response.headers.get('X-Request-Id') || rid;
    this._lastRequestId = responseRequestId;
    if (!response.ok || !response.body) {
      let message = `编辑器生成请求失败（HTTP ${response.status}）`;
      let code = 'editor_generation_failed';
      try {
        const envelope = await response.json() as ApiEnvelope<never>;
        message = String(envelope?.error?.message || message);
        code = String(envelope?.error?.code || code);
      } catch {
        // Keep the HTTP fallback when a proxy returns a non-JSON error page.
      }
      if (response.status === 401) {
        this.clearToken();
        this.onUnauthorized?.();
      }
      throw new GeoFlowApiError(message, response.status, code, {}, responseRequestId);
    }

    await this.readSseStream(response.body, onEvent);
  }

  async downloadAiWorkspaceMedia(id: string | number, thumbnail = true): Promise<Blob> {    const path = `ai-workspace/media/${this.numericId(id)}${thumbnail ? '?variant=thumbnail' : ''}`;
    return this.downloadAuthenticated(path, 'image/*', '知识图片加载失败', 'workspace_media_failed');
  }

  async getSystemUpdates(
    history: 'recent' | 'archived' = 'recent',
    pages: { runsPage?: number; backupsPage?: number } = {},
  ): Promise<ApiRecord> {
    return this.request<ApiRecord>(`system-updates${this.query({
      history,
      runs_page: pages.runsPage,
      backups_page: pages.backupsPage,
    })}`);
  }

  async checkSystemUpdates(options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('system-updates/check', {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async prepareSystemUpdater(options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('system-updates/updater/prepare', {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async downloadSystemUpdaterPackage(): Promise<Blob> {
    return this.downloadAuthenticated(
      'system-updates/updater/package',
      'application/gzip',
      'Updater 安装包下载失败',
      'system_updater_package_download_failed',
    );
  }

  async startSystemUpdateOperation(
    kind: SystemUpdateOperationKind,
    payload: ApiRecord = {},
    options: MutationOptions = {},
  ): Promise<ApiRecord> {
    return this.request<ApiRecord>(`system-updates/operations/${kind}`, {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async getQueryRadar(options: { days?: number } = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`ai-research/query-radar${this.query({ days: options.days })}`);
  }

  async collectQueryRadar(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('ai-research/query-radar/collect', {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async generateQueryRadarDraft(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('ai-research/query-radar/draft', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async getCompetitorRadar(options: { days?: number } = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`ai-research/competitor${this.query({ days: options.days })}`);
  }

  async saveCompetitorConfig(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('ai-research/competitor/config', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async benchmarkCompetitorRadar(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('ai-research/competitor/benchmark', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async getBrandEntity(): Promise<ApiRecord> {
    return this.request<ApiRecord>('ai-research/brand-entity');
  }

  /** 可发现性体检：当前生效的 robots/llms/sitemap 配置与 AI 爬虫名单的对撞结果。 */
  async getSeoAudit(): Promise<ApiRecord> {
    return this.request<ApiRecord>('site/seo-audit');
  }

  /** AI 引流归因漏斗：基于 view_logs.referer 与 lead_submissions 的真实投影。 */
  async getAttributionFunnel(days = 30): Promise<ApiRecord> {
    return this.request<ApiRecord>(`ai-research/attribution${this.query({ days })}`);
  }

  async saveBrandEntity(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('ai-research/brand-entity', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async runAiSandbox(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('ai-research/sandbox', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async getSiteSeoConfig(): Promise<ApiRecord> {
    return this.request<ApiRecord>('site/seo-config');
  }

  /**
   * Read the structured, published-only site preview projection.  The
   * optional hosted site id is an admin-side selector; the server validates
   * it against a real hosted_site channel before switching the site scope.
   */
  async getSitePreview(params: {
    page?: 'home' | 'category' | 'article';
    category_id?: string | number;
    article_id?: string | number;
    hosted_site_id?: string | number;
    limit?: number;
  } = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`site/preview${this.query(params)}`);
  }

  async updateSiteSeoConfig(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('site/seo-config', { method: 'PATCH', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async previewRobots(): Promise<ApiRecord> {
    return this.request<ApiRecord>('site/robots/preview');
  }

  async previewSitemap(): Promise<ApiRecord> {
    return this.request<ApiRecord>('site/sitemap/preview');
  }

  async rebuildSitemap(options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('site/sitemap/rebuild', { method: 'POST', body: {}, idempotencyKey: options.idempotencyKey });
  }

  async previewLlms(variant: 'short' | 'full' = 'short'): Promise<ApiRecord> {
    return this.request<ApiRecord>('site/llms-txt/preview?variant=' + encodeURIComponent(variant));
  }

  async publishLlms(options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('site/llms-txt/publish', { method: 'POST', body: {}, idempotencyKey: options.idempotencyKey });
  }

  async getSiteSettings(): Promise<ApiRecord> {
    return this.request<ApiRecord>('site-settings');
  }

  async updateSiteSettings(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('site-settings', { method: 'PATCH', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async updateSiteTheme(activeTheme: string, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('site-settings/theme', { method: 'POST', body: { active_theme: activeTheme }, idempotencyKey: options.idempotencyKey });
  }

  /**
   * 敏感词规则。它是文章质量门禁的真实输入——退役后改不了就等于规则集冻结。
   *
   * 读只要 `seo:read`；**增删改要超管**（服务端另判），前端不能只靠按钮置灰来兜底。
   */
  async listSensitiveWords(search?: string): Promise<ApiRecord> {
    return this.request<ApiRecord>(`site-settings/sensitive-words${this.query({ search })}`);
  }

  /** 批量新增：一次提交一整段词表（每行一个），比逐条插入少几十次往返。 */
  async storeSensitiveWords(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('site-settings/sensitive-words', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async updateSensitiveWord(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`site-settings/sensitive-words/${this.numericId(id)}`, { method: 'PATCH', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async deleteSensitiveWord(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`site-settings/sensitive-words/${this.numericId(id)}`, { method: 'DELETE', idempotencyKey: options.idempotencyKey });
  }

  async updateHomepageSettings(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('site-settings/homepage', { method: 'PATCH', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async applyHomepagePreset(preset: string, mode: 'replace' | 'append' = 'replace', options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('site-settings/homepage/preset', { method: 'POST', body: { homepage_preset: preset, preset_mode: mode }, idempotencyKey: options.idempotencyKey });
  }

  async importHomepageDesign(design: ApiRecord, mode: 'replace' | 'append' = 'replace', options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('site-settings/homepage/import', { method: 'POST', body: { homepage_design: design, import_mode: mode }, idempotencyKey: options.idempotencyKey });
  }

  async listThemeReplications(limit = 20): Promise<ThemeReplicationListResponse> {
    return this.request<ThemeReplicationListResponse>(`site-settings/theme-replications?limit=${Math.max(1, Math.min(100, Math.floor(limit)))}`);
  }

  async getThemeReplication(id: string | number): Promise<{ replication: ThemeReplicationRecord }> {
    return this.request<{ replication: ThemeReplicationRecord }>(`site-settings/theme-replications/${this.numericId(id)}`);
  }

  async createThemeReplication(payload: ApiRecord, options: MutationOptions = {}): Promise<{ replication: ThemeReplicationRecord }> {
    return this.request<{ replication: ThemeReplicationRecord }>('site-settings/theme-replications', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async retryThemeReplication(id: string | number, options: MutationOptions = {}): Promise<{ replication: ThemeReplicationRecord }> {
    return this.request<{ replication: ThemeReplicationRecord }>(`site-settings/theme-replications/${this.numericId(id)}/retry`, { method: 'POST', body: {}, idempotencyKey: options.idempotencyKey });
  }

  async iterateThemeReplication(id: string | number, feedback: string, options: MutationOptions = {}): Promise<{ replication: ThemeReplicationRecord }> {
    return this.request<{ replication: ThemeReplicationRecord }>(`site-settings/theme-replications/${this.numericId(id)}/iterate`, { method: 'POST', body: { feedback }, idempotencyKey: options.idempotencyKey });
  }

  async actOnThemeReplication(id: string | number, action: 'publish' | 'archive' | 'delete-drafts', options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`site-settings/theme-replications/${this.numericId(id)}/${action}`, { method: 'POST', body: {}, idempotencyKey: options.idempotencyKey });
  }

  async copyThemeReplication(id: string | number, payload: { name: string; theme_id: string }, options: MutationOptions = {}): Promise<{ replication: ThemeReplicationRecord }> {
    return this.request<{ replication: ThemeReplicationRecord }>(`site-settings/theme-replications/${this.numericId(id)}/copy`, { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async previewThemeReplication(id: string | number, page: 'home' | 'category' | 'article'): Promise<Blob> {
    return this.downloadAuthenticated(`site-settings/theme-replications/${this.numericId(id)}/preview/${page}`, 'text/html', '主题预览加载失败', 'theme_replication_preview_failed');
  }

  async downloadThemeReplicationPackage(id: string | number): Promise<Blob> {
    return this.downloadAuthenticated(`site-settings/theme-replications/${this.numericId(id)}/package`, 'application/zip', '主题包下载失败', 'theme_replication_package_failed');
  }

  async listArticles(params: Record<string, string | number | undefined> = {}): Promise<PaginatedResponse<ApiRecord>> {
    return this.request<PaginatedResponse<ApiRecord>>(`articles${this.query(params)}`);
  }

  async getArticle(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}`);
  }

  async createArticle(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('articles', {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async updateArticle(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}`, {
      method: 'PATCH',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async reviewArticle(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/review`, {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async publishArticle(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/publish`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async trashArticle(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/trash`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async restoreArticle(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/restore`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  /**
   * 人工放行：对「质检跑完但判定为待人工复核」的文章记录理由并放行。
   * 后端要求分数 ≥ `manual_override_min_score`（默认 70），且只能对 needs_review 用。
   */
  async overrideArticleAiQuality(id: string | number, reason: string, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/ai-quality/override`, {
      method: 'POST',
      body: { reason },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async recheckArticleRisk(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/risk-scan`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async batchForceDeleteArticles(ids: Array<string | number>, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('articles/batch/force-delete', {
      method: 'POST',
      body: { article_ids: ids.map((id) => this.numericId(id)) },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async emptyArticleTrash(options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('articles/trash/empty', {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async prepareArticleMarkdownExport(ids: Array<string | number>, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('articles/markdown-export/prepare', {
      method: 'POST',
      body: { article_ids: ids.map((id) => this.numericId(id)) },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async downloadArticleMarkdownExport(url: string): Promise<Blob> {
    const rid = requestId();
    const headers = new Headers({ Accept: 'application/zip', 'X-Request-Id': rid });
    const token = this.token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers });
    } catch (error) {
      throw new GeoFlowApiError(error instanceof Error ? error.message : '无法下载文章导出文件', 0, 'network_error', {}, rid);
    }
    if (!response.ok) {
      if (response.status === 401) {
        this.clearToken();
        this.onUnauthorized?.();
      }
      throw new GeoFlowApiError('文章导出文件下载失败', response.status, 'article_export_download_failed', {}, response.headers.get('X-Request-Id') || rid);
    }
    return response.blob();
  }

  async exportArticleWeChatHtml(content: string, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('articles/editor/wechat-html', {
      method: 'POST',
      body: { content },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async uploadArticleEditorImage(
    id: string | number,
    file: File,
    alt = '',
    position = 0,
    options: MutationOptions = {},
  ): Promise<ApiRecord> {
    const form = new FormData();
    form.append('image', file);
    if (alt.trim()) form.append('alt', alt.trim());
    form.append('position', String(Math.max(0, Math.floor(position))));
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/editor/images/upload`, {
      method: 'POST',
      body: form,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Apply a governed review decision to up to 100 articles. */
  async batchReviewArticles(
    ids: Array<string | number>,
    payload: ApiRecord,
    options: MutationOptions = {},
  ): Promise<ApiRecord> {
    return this.request<ApiRecord>('articles/batch/review', {
      method: 'POST',
      body: { ...payload, article_ids: ids.map((id) => this.numericId(id)) },
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Publish a set of already-approved articles through the same server gates as single publish. */
  async batchPublishArticles(
    ids: Array<string | number>,
    options: MutationOptions = {},
  ): Promise<ApiRecord> {
    return this.request<ApiRecord>('articles/batch/publish', {
      method: 'POST',
      body: { article_ids: ids.map((id) => this.numericId(id)) },
      idempotencyKey: options.idempotencyKey,
    });
  }

  /**
   * 批量改文章状态——旧后台 `articles/batch/update-status` 的等价端点。
   *
   * 撤回（`draft`）不需要过质检门禁；`published` / `private` 会走风险与质检门禁，
   * 且未审核通过的文章会被服务端归一到草稿（不是绕过审核的后门）。
   */
  async batchUpdateArticleStatus(
    ids: Array<string | number>,
    newStatus: 'draft' | 'published' | 'private',
    riskOverrideReason = '',
    options: MutationOptions = {},
  ): Promise<ApiRecord> {
    return this.request<ApiRecord>('articles/batch/status', {
      method: 'POST',
      body: {
        article_ids: ids.map((id) => this.numericId(id)),
        new_status: newStatus,
        ...(riskOverrideReason ? { risk_override_reason: riskOverrideReason } : {}),
      },
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Soft-delete a set of articles; the server retains audit and restore state. */
  async batchTrashArticles(
    ids: Array<string | number>,
    options: MutationOptions = {},
  ): Promise<ApiRecord> {
    return this.request<ApiRecord>('articles/batch/trash', {
      method: 'POST',
      body: { article_ids: ids.map((id) => this.numericId(id)) },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async batchRestoreArticles(
    ids: Array<string | number>,
    options: MutationOptions = {},
  ): Promise<ApiRecord> {
    return this.request<ApiRecord>('articles/batch/restore', {
      method: 'POST',
      body: { article_ids: ids.map((id) => this.numericId(id)) },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async articleQualityStatus(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/ai-quality/status`);
  }

  async recheckArticleQuality(id: string | number, configVersion: number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/ai-quality/recheck`, {
      method: 'POST',
      body: { config_version: configVersion },
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Start a governed server-side AI optimization run for a draft article. */
  async startArticleOptimization(
    id: string | number,
    strategy: 'pass' | 'excellent_80' | 'excellent_90' = 'excellent_80',
    optimizationModelId?: string | number,
    options: MutationOptions = {},
  ): Promise<ApiRecord> {
    const body: ApiRecord = { strategy };
    if (optimizationModelId !== undefined && optimizationModelId !== null && String(optimizationModelId).trim() !== '') {
      body.optimization_model_id = this.numericId(optimizationModelId);
    }
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/ai-quality/optimization`, {
      method: 'POST',
      body,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Read the latest optimization candidate, if one is available. */
  async latestArticleOptimizationCandidate(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/ai-quality/optimization/candidate`);
  }

  /** Read a concrete optimization run's candidate and audit-safe diff. */
  async articleOptimizationCandidate(id: string | number, runId: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/ai-quality/optimization/${this.numericId(runId)}/candidate`);
  }

  /** Apply a candidate after the server verifies its immutable hash. */
  async applyArticleOptimization(
    id: string | number,
    runId: string | number,
    candidateHash: string,
    options: MutationOptions = {},
  ): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/ai-quality/optimization/${this.numericId(runId)}/apply`, {
      method: 'POST',
      body: { candidate_hash: candidateHash },
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Cancel an active optimization run without changing article content. */
  async cancelArticleOptimization(
    id: string | number,
    runId: string | number,
    options: MutationOptions = {},
  ): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/ai-quality/optimization/${this.numericId(runId)}/cancel`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** Roll back a previously applied candidate when the server says it is safe. */
  async rollbackArticleOptimization(
    id: string | number,
    runId: string | number,
    options: MutationOptions = {},
  ): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/ai-quality/optimization/${this.numericId(runId)}/rollback`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async listTasks(params: Record<string, string | number | undefined> = {}): Promise<PaginatedResponse<ApiRecord>> {
    return this.request<PaginatedResponse<ApiRecord>>(`tasks${this.query(params)}`);
  }

  async listTrashedTasks(params: Record<string, string | number | undefined> = {}): Promise<PaginatedResponse<ApiRecord>> {
    return this.request<PaginatedResponse<ApiRecord>>(`tasks/trash${this.query(params)}`);
  }

  async getTaskWorkers(params: Record<string, string | number | undefined> = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`tasks/workers${this.query(params)}`);
  }

  async getTaskTitleReadiness(params: Record<string, string | number | undefined> = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`tasks/title-readiness${this.query(params)}`);
  }

  async updateTask(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`tasks/${this.numericId(id)}`, {
      method: 'PATCH',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async deleteTask(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`tasks/${this.numericId(id)}`, {
      method: 'DELETE',
      idempotencyKey: options.idempotencyKey,
    });
  }

  async restoreTask(id: string | number, trashSequence: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`tasks/${this.numericId(id)}/restore`, {
      method: 'POST',
      body: { trash_sequence: this.numericId(trashSequence) },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async createTask(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('tasks', {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async startTask(id: string | number, enqueueNow = false, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`tasks/${this.numericId(id)}/start`, {
      method: 'POST',
      body: { enqueue_now: enqueueNow },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async stopTask(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`tasks/${this.numericId(id)}/stop`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async enqueueTask(id: string | number, jobType = 'generate_article', options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`tasks/${this.numericId(id)}/enqueue`, {
      method: 'POST',
      body: { job_type: jobType },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async listTaskJobs(id: string | number, params: Record<string, string | number | undefined> = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`tasks/${this.numericId(id)}/jobs${this.query(params)}`);
  }

  async getJob(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`jobs/${this.numericId(id)}`);
  }

  async listDistributionChannels(params: Record<string, string | number | undefined> = {}): Promise<PaginatedResponse<ApiRecord>> {
    return this.request<PaginatedResponse<ApiRecord>>(`distribution/channels${this.query(params)}`);
  }

  async getDistributionChannel(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/channels/${this.numericId(id)}`);
  }

  async createDistributionChannel(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('distribution/channels', {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async updateDistributionChannel(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/channels/${this.numericId(id)}`, {
      method: 'PATCH',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async pauseDistributionChannel(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/channels/${this.numericId(id)}/pause`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async activateDistributionChannel(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/channels/${this.numericId(id)}/activate`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async rotateDistributionChannelSecret(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/channels/${this.numericId(id)}/rotate-secret`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async previewDistributionChannelDeletion(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/channels/${this.numericId(id)}/deletion-preview`);
  }

  async prepareDistributionChannelDeletion(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/channels/${this.numericId(id)}/prepare-delete`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async cancelDistributionChannelDeletion(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/channels/${this.numericId(id)}/cancel-delete`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async deleteDistributionChannel(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/channels/${this.numericId(id)}/delete`, {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async healthDistributionChannel(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/channels/${this.numericId(id)}/health`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  /**
   * 查看渠道密钥的明文。
   *
   * 门禁比 rotate-secret 更严：**超管 + 二次密码**（交出的是已有密钥，不是换一把新的）。
   * 二次密码错了服务端会给 403 `secret_reveal_password_invalid`。
   */
  async revealDistributionChannelSecret(id: string | number, password: string, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/channels/${this.numericId(id)}/reveal-secret`, {
      method: 'POST',
      body: { password },
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** 下载渠道接入包（同样是超管 + 二次密码，字段名与服务端一致是 `package_password`）。 */
  async downloadDistributionChannelPackage(id: string | number, password: string, options: MutationOptions = {}): Promise<Blob> {
    const rid = requestId();
    const headers = new Headers({ Accept: 'application/zip', 'Content-Type': 'application/json', 'X-Request-Id': rid });
    const token = this.token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await this.fetchImpl(`distribution/channels/${this.numericId(id)}/package`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ package_password: password, ...(options.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {}) }),
      });
    } catch (error) {
      throw new GeoFlowApiError(error instanceof Error ? error.message : '无法下载渠道接入包', 0, 'network_error', {}, rid);
    }
    if (!response.ok) {
      if (response.status === 401) { this.clearToken(); this.onUnauthorized?.(); }
      throw new GeoFlowApiError('渠道接入包下载失败', response.status, 'channel_package_download_failed', {}, response.headers.get('X-Request-Id') || rid);
    }

    return response.blob();
  }

  /** 重新抓取渠道前端的实际能力快照（旧后台的「刷新前端能力」）。 */
  async refreshDistributionChannelCapabilities(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/channels/${this.numericId(id)}/frontend-capabilities/refresh`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  /**
   * 站点设置同步到渠道前端：先预览、再执行。
   *
   * `scope` 是 `all` / `selected`——**预览与执行必须用同一个 scope**，
   * 否则会出现「预览看的是 A、同步下去的是 B」。
   */
  async previewDistributionSettingsSync(scope: 'all' | 'selected', target: { channel_id?: number; channel_ids?: number[] } = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('distribution/sync-settings/preview', {
      method: 'POST',
      body: { scope, ...target },
    });
  }


  async syncAllDistributionSettings(payload: ApiRecord = {}, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('distribution/sync-settings/all', {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async syncSelectedDistributionSettings(channelIds: Array<string | number>, payload: ApiRecord = {}, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('distribution/sync-settings/selected', {
      method: 'POST',
      body: { ...payload, channel_ids: channelIds.map(Number) },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async listHostedSites(params: Record<string, string | number | undefined> = {}): Promise<PaginatedResponse<ApiRecord>> {
    return this.request<PaginatedResponse<ApiRecord>>(`distribution/hosted-sites${this.query(params)}`);
  }

  async getHostedSite(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/hosted-sites/${this.numericId(id)}`);
  }

  async createHostedSite(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('distribution/hosted-sites', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async updateHostedSite(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/hosted-sites/${this.numericId(id)}`, { method: 'PATCH', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async preflightHostedSite(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/hosted-sites/${this.numericId(id)}/preflight`, { method: 'POST', body: {}, idempotencyKey: options.idempotencyKey });
  }

  async activateHostedSite(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/hosted-sites/${this.numericId(id)}/activate`, { method: 'POST', body: {}, idempotencyKey: options.idempotencyKey });
  }

  async pauseHostedSite(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/hosted-sites/${this.numericId(id)}/pause`, { method: 'POST', body: {}, idempotencyKey: options.idempotencyKey });
  }

  async maintainHostedSite(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/hosted-sites/${this.numericId(id)}/maintenance`, { method: 'POST', body: {}, idempotencyKey: options.idempotencyKey });
  }

  async setHostedSiteIndexing(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/hosted-sites/${this.numericId(id)}/indexing`, { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async archiveHostedSite(id: string | number, hostname: string, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/hosted-sites/${this.numericId(id)}/archive`, { method: 'POST', body: { hostname }, idempotencyKey: options.idempotencyKey });
  }

  async assignHostedSiteArticle(id: string | number, articleId: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/hosted-sites/${this.numericId(id)}/articles`, { method: 'POST', body: { article_id: this.numericId(articleId) }, idempotencyKey: options.idempotencyKey });
  }

  async distributeArticle(id: string | number, channelIds: Array<string | number> = [], options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/distribute`, {
      method: 'POST',
      body: { channel_ids: channelIds.map((value) => this.numericId(value)) },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async listManualPublications(params: Record<string, string | number | undefined> = {}): Promise<PaginatedResponse<ApiRecord>> {
    return this.request<PaginatedResponse<ApiRecord>>(`manual-publications/management${this.query(params)}`);
  }

  async getManualPublication(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`manual-publications/${this.numericId(id)}/management`);
  }

  async createManualPublication(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('manual-publications', {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async updateManualPublication(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`manual-publications/${this.numericId(id)}`, {
      method: 'PATCH',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async transitionManualPublication(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`manual-publications/${this.numericId(id)}/transition`, {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /**
   * 导出发布工单。
   *
   * **必须与列表用同一组筛选参数**——服务端也共用同一个 `filteredQuery`，
   * 但前端如果只导出「当前页」的筛选就会拿到全量，那是两边的口径分叉。
   */
  async exportManualPublications(params: Record<string, string | number | undefined> = {}): Promise<Blob> {
    const rid = requestId();
    const url = `manual-publications/export${this.query(params)}`;
    const headers = new Headers({ Accept: 'text/csv, application/octet-stream', 'X-Request-Id': rid });
    const token = this.token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers });
    } catch (error) {
      throw new GeoFlowApiError(error instanceof Error ? error.message : '无法导出发布工单', 0, 'network_error', {}, rid);
    }
    if (!response.ok) {
      if (response.status === 401) { this.clearToken(); this.onUnauthorized?.(); }
      throw new GeoFlowApiError('发布工单导出失败', response.status, 'manual_publication_export_failed', {}, response.headers.get('X-Request-Id') || rid);
    }

    return response.blob();
  }

  /** 发布账号与人设（超管专属，服务端判定）。 */
  async getManualPublicationSettings(): Promise<ApiRecord> {
    return this.request<ApiRecord>('manual-publications/settings');
  }

  async saveManualPublicationPersona(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('manual-publications/settings/personas', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async updateManualPublicationPersona(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`manual-publications/settings/personas/${this.numericId(id)}`, { method: 'PATCH', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async saveManualPublicationAccount(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('manual-publications/settings/accounts', { method: 'POST', body: payload, idempotencyKey: options.idempotencyKey });
  }

  async updateManualPublicationAccount(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`manual-publications/settings/accounts/${this.numericId(id)}`, { method: 'PATCH', body: payload, idempotencyKey: options.idempotencyKey });
  }

  /**
   * 按配对码查询浏览器插件的待批请求（运营方一侧）。
   *
   * `user_code` 是**必填**：这走的是设备授权流程，运营方要先把插件界面上显示的
   * 那串码填进来，服务端才知道要批的是哪一次请求。
   */
  async getBrowserConnect(userCode: string): Promise<ApiRecord> {
    return this.request<ApiRecord>(`manual-publications/browser-connect${this.query({ user_code: userCode })}`);
  }

  /** 批准或拒绝一次插件配对；`user_code` 就是插件上显示的那个码。 */
  async decideBrowserConnect(userCode: string, decision: 'approve' | 'deny', options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('manual-publications/browser-connect/decision', {
      method: 'POST',
      body: { user_code: userCode, decision },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async listArticleDistributions(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`articles/${this.numericId(id)}/distributions`);
  }

  async listDistributionJobs(params: Record<string, string | number | undefined> = {}): Promise<PaginatedResponse<ApiRecord>> {
    return this.request<PaginatedResponse<ApiRecord>>(`distribution/jobs${this.query(params)}`);
  }

  async retryDistribution(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/jobs/${this.numericId(id)}/retry`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** 修正某条分发记录的文章关联（旧后台的编辑分发）。 */
  async updateDistributionJob(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/jobs/${this.numericId(id)}`, {
      method: 'PATCH',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async deleteDistributionJob(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`distribution/jobs/${this.numericId(id)}`, {
      method: 'DELETE',
      idempotencyKey: options.idempotencyKey,
    });
  }

  async listMaterials(type: string, params: Record<string, string | number | undefined> = {}): Promise<PaginatedResponse<ApiRecord>> {
    return this.request<PaginatedResponse<ApiRecord>>(`materials/${this.pathSegment(type)}${this.query(params)}`);
  }

  /**
   * Return the server-side material library summary.  The summary is useful
   * for the shell cards because it does not require loading every library
   * page just to show counts.
   */
  async materialSummary(): Promise<ApiRecord> {
    return this.request<ApiRecord>('materials');
  }

  /** Full 桐灼GEO knowledge-base asset projection (content metadata, revisions and media). */
  async getKnowledgeBase(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`knowledge-bases/${this.numericId(id)}`);
  }

  async listKnowledgeBaseRevisions(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`knowledge-bases/${this.numericId(id)}/revisions`);
  }

  async getKnowledgeBaseRevision(id: string | number, revisionId: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`knowledge-bases/${this.numericId(id)}/revisions/${this.numericId(revisionId)}`);
  }

  /** Create a knowledge base from pasted text and/or txt/markdown/docx files. */
  async uploadKnowledgeBase(payload: ApiRecord | FormData, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('knowledge-bases/upload', {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async refreshKnowledgeBase(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`knowledge-bases/${this.numericId(id)}/refresh`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async restoreKnowledgeBaseRevision(id: string | number, revisionId: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`knowledge-bases/${this.numericId(id)}/revisions/${this.numericId(revisionId)}/restore`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  /**
   * 采纳随包发布的官方版本。
   *
   * **与 `restoreKnowledgeBaseRevision` 不等价**：后者只在内容哈希恰好等于绑定记录时
   * 才清 `customized_at`，不刷新 `official_version`——产品升级后采纳新版本这件事它做不到。
   */
  async adoptKnowledgeBaseOfficial(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`knowledge-bases/${this.numericId(id)}/official/adopt`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async listKnowledgeBaseMedia(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`knowledge-bases/${this.numericId(id)}/media`);
  }

  async uploadKnowledgeBaseMedia(id: string | number, payload: FormData, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`knowledge-bases/${this.numericId(id)}/media`, {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async updateKnowledgeBaseMedia(id: string | number, mediaId: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`knowledge-bases/${this.numericId(id)}/media/${this.numericId(mediaId)}`, {
      method: 'PATCH',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async replaceKnowledgeBaseMedia(id: string | number, mediaId: string | number, payload: FormData, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`knowledge-bases/${this.numericId(id)}/media/${this.numericId(mediaId)}/replace`, {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async toggleKnowledgeBaseMedia(id: string | number, mediaId: string | number, active: boolean, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`knowledge-bases/${this.numericId(id)}/media/${this.numericId(mediaId)}/toggle`, {
      method: 'POST',
      body: { active },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async listEnterpriseKnowledge(params: Record<string, string | number | undefined> = {}): Promise<PaginatedResponse<ApiRecord>> {
    return this.request<PaginatedResponse<ApiRecord>>(`enterprise-knowledge${this.query(params)}`);
  }

  async getEnterpriseKnowledge(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`enterprise-knowledge/${this.numericId(id)}`);
  }

  async getEnterpriseKnowledgeStatus(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`enterprise-knowledge/${this.numericId(id)}/status`);
  }

  async uploadEnterpriseKnowledgeImage(id: string | number, payload: FormData, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`enterprise-knowledge/${this.numericId(id)}/editor/images/upload`, {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async createEnterpriseKnowledge(payload: ApiRecord | FormData, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('enterprise-knowledge', {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async autosaveEnterpriseKnowledge(id: string | number, content: string, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`enterprise-knowledge/${this.numericId(id)}/autosave`, {
      method: 'POST',
      body: { content },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async validateEnterpriseKnowledge(id: string | number, content?: string, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`enterprise-knowledge/${this.numericId(id)}/validate`, {
      method: 'POST',
      body: content === undefined ? {} : { content },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async restoreEnterpriseKnowledgeRevision(id: string | number, revisionId: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`enterprise-knowledge/${this.numericId(id)}/revisions/${this.numericId(revisionId)}/restore`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async publishEnterpriseKnowledge(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`enterprise-knowledge/${this.numericId(id)}/publish`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async deleteEnterpriseKnowledge(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`enterprise-knowledge/${this.numericId(id)}`, {
      method: 'DELETE',
      idempotencyKey: options.idempotencyKey,
    });
  }

  async getMaterial(type: string, id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(
      `materials/${this.pathSegment(type)}/${this.numericId(id)}`,
    );
  }

  async createMaterial(type: string, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`materials/${this.pathSegment(type)}`, {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async updateMaterial(
    type: string,
    id: string | number,
    payload: ApiRecord,
    options: MutationOptions = {},
  ): Promise<ApiRecord> {
    return this.request<ApiRecord>(
      `materials/${this.pathSegment(type)}/${this.numericId(id)}`,
      {
        method: 'PATCH',
        body: payload,
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  async deleteMaterial(
    type: string,
    id: string | number,
    options: MutationOptions = {},
  ): Promise<ApiRecord> {
    return this.request<ApiRecord>(
      `materials/${this.pathSegment(type)}/${this.numericId(id)}`,
      {
        method: 'DELETE',
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  async listMaterialItems(type: string, id: string | number, params: Record<string, string | number | undefined> = {}): Promise<PaginatedResponse<ApiRecord>> {
    return this.request<PaginatedResponse<ApiRecord>>(
      `materials/${this.pathSegment(type)}/${this.numericId(id)}/items${this.query(params)}`,
    );
  }

  async createMaterialItem(
    type: string,
    id: string | number,
    payload: ApiRecord | FormData,
    options: MutationOptions = {},
  ): Promise<ApiRecord> {
    return this.request<ApiRecord>(
      `materials/${this.pathSegment(type)}/${this.numericId(id)}/items`,
      {
        method: 'POST',
        body: payload,
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  async deleteMaterialItems(
    type: string,
    id: string | number,
    payload: ApiRecord = {},
    options: MutationOptions = {},
  ): Promise<ApiRecord> {
    return this.request<ApiRecord>(
      `materials/${this.pathSegment(type)}/${this.numericId(id)}/items`,
      {
        method: 'DELETE',
        body: payload,
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  /**
   * 批量导入。关键词库按换行或逗号切分；标题库每行支持 `标题|关键词` 成对格式。
   *
   * 切分与去重规则在服务端（两个入口共用一套），前端只负责把整段文本送上去。
   */
  async importLibraryText(
    type: 'keyword-libraries' | 'title-libraries',
    id: string | number,
    text: string,
    options: MutationOptions = {},
  ): Promise<ApiRecord> {
    const field = type === 'keyword-libraries' ? 'keywords_text' : 'titles_text';

    return this.request<ApiRecord>(`materials/${this.pathSegment(type)}/${this.numericId(id)}/import`, {
      method: 'POST',
      body: { [field]: text },
      idempotencyKey: options.idempotencyKey,
    });
  }

  /**
   * 一次性上传多张图片到图片库。
   *
   * 服务端逐张独立成败：一张失败不牵连其余，返回值里的 `uploaded` / `skipped` /
   * `failed_names` 要如实展示，不能因为「部分失败」就报成整批失败。
   */
  async uploadMaterialImages(id: string | number, files: File[], options: MutationOptions = {}): Promise<ApiRecord> {
    const form = new FormData();
    files.forEach((file) => form.append('images[]', file));

    return this.request<ApiRecord>(`materials/image-libraries/${this.numericId(id)}/images`, {
      method: 'POST',
      body: form,
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** 某标题库的 AI 生成记录（含进行中的那一次）。 */
  async listTitleGenerationRuns(id: string | number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`materials/title-libraries/${this.numericId(id)}/ai-generation-runs`);
  }

  async startTitleGeneration(id: string | number, payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`materials/title-libraries/${this.numericId(id)}/ai-generation-runs`, {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async retryTitleGeneration(id: string | number, runId: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`materials/title-libraries/${this.numericId(id)}/ai-generation-runs/${this.numericId(runId)}/retry`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async cancelTitleGeneration(id: string | number, runId: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`materials/title-libraries/${this.numericId(id)}/ai-generation-runs/${this.numericId(runId)}/cancel`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** 某作者最近的文章（旧后台作者详情页那张列表）。 */
  async listAuthorArticles(id: string | number, limit?: number): Promise<ApiRecord> {
    return this.request<ApiRecord>(`materials/authors/${this.numericId(id)}/articles${this.query({ limit })}`);
  }

  async searchKnowledgeBase(
    id: string | number,
    query: string,
    limit = 8,
  ): Promise<KnowledgeSearchResponse> {
    return this.request<KnowledgeSearchResponse>(
      `materials/knowledge-bases/${this.numericId(id)}/search${this.query({ query, limit })}`,
    );
  }

  /**
   * Read the reviewed atomic-fact workbench for a knowledge base.  The
   * server owns pagination, summaries, revision manifests and generation
   * state; the client deliberately returns that projection without deriving
   * counts from the current page.
   */
  async getKnowledgeFactWorkbench(
    id: string | number,
    params: Record<string, string | number | undefined> = {},
  ): Promise<KnowledgeFactWorkbenchResponse> {
    return this.request<KnowledgeFactWorkbenchResponse>(
      `materials/knowledge-bases/${this.numericId(id)}/facts${this.query(params)}`,
    );
  }

  /** Create a new draft atomic fact in the selected knowledge base. */
  async createKnowledgeFact(
    knowledgeBaseId: string | number,
    payload: ApiRecord,
    options: MutationOptions = {},
  ): Promise<KnowledgeFactMutationResponse> {
    return this.request<KnowledgeFactMutationResponse>(
      `materials/knowledge-bases/${this.numericId(knowledgeBaseId)}/facts`,
      {
        method: 'POST',
        body: payload,
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  /** Update a fact using the server's optimistic lock version. */
  async updateKnowledgeFact(
    knowledgeBaseId: string | number,
    factId: string | number,
    payload: ApiRecord,
    options: MutationOptions = {},
  ): Promise<KnowledgeFactMutationResponse> {
    return this.request<KnowledgeFactMutationResponse>(
      `materials/knowledge-bases/${this.numericId(knowledgeBaseId)}/facts/${this.numericId(factId)}`,
      {
        method: 'PATCH',
        body: payload,
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  /** Mark a fact draft/reviewed/rejected after an optimistic lock check. */
  async reviewKnowledgeFact(
    knowledgeBaseId: string | number,
    factId: string | number,
    payload: ApiRecord,
    options: MutationOptions = {},
  ): Promise<KnowledgeFactMutationResponse> {
    return this.request<KnowledgeFactMutationResponse>(
      `materials/knowledge-bases/${this.numericId(knowledgeBaseId)}/facts/${this.numericId(factId)}/review`,
      {
        method: 'POST',
        body: payload,
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  /** Add a candidate value to an atomic fact. */
  async createKnowledgeFactValue(
    knowledgeBaseId: string | number,
    factId: string | number,
    payload: ApiRecord,
    options: MutationOptions = {},
  ): Promise<KnowledgeFactValueMutationResponse> {
    return this.request<KnowledgeFactValueMutationResponse>(
      `materials/knowledge-bases/${this.numericId(knowledgeBaseId)}/facts/${this.numericId(factId)}/values`,
      {
        method: 'POST',
        body: payload,
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  /**
   * Attach evidence to a fact value.  The API resolves the chunk and replaces
   * any client-supplied excerpt/locator with the canonical source data.
   */
  async createKnowledgeFactEvidence(
    knowledgeBaseId: string | number,
    valueId: string | number,
    payload: ApiRecord,
    options: MutationOptions = {},
  ): Promise<KnowledgeFactEvidenceMutationResponse> {
    return this.request<KnowledgeFactEvidenceMutationResponse>(
      `materials/knowledge-bases/${this.numericId(knowledgeBaseId)}/fact-values/${this.numericId(valueId)}/evidences`,
      {
        method: 'POST',
        body: payload,
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  /** Publish the currently reviewed fact set as an immutable revision. */
  async publishKnowledgeFacts(
    knowledgeBaseId: string | number,
    options: MutationOptions = {},
  ): Promise<KnowledgeFactPublishResponse> {
    return this.request<KnowledgeFactPublishResponse>(
      `materials/knowledge-bases/${this.numericId(knowledgeBaseId)}/facts/publish`,
      {
        method: 'POST',
        body: {},
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  /** Restore a previous immutable fact revision as a new published revision. */
  async restoreKnowledgeFactRevision(
    knowledgeBaseId: string | number,
    revisionId: string | number,
    options: MutationOptions = {},
  ): Promise<KnowledgeFactRestoreResponse> {
    return this.request<KnowledgeFactRestoreResponse>(
      `materials/knowledge-bases/${this.numericId(knowledgeBaseId)}/fact-revisions/${this.numericId(revisionId)}/restore`,
      {
        method: 'POST',
        body: {},
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  /**
   * Archive a fact. The server disables it and marks it rejected under the
   * same optimistic lock used by every other fact mutation.
   */
  async archiveKnowledgeFact(
    knowledgeBaseId: string | number,
    factId: string | number,
    lockVersion: number,
    options: MutationOptions = {},
  ): Promise<KnowledgeFactMutationResponse> {
    return this.request<KnowledgeFactMutationResponse>(
      `materials/knowledge-bases/${this.numericId(knowledgeBaseId)}/facts/${this.numericId(factId)}/archive`,
      {
        method: 'POST',
        body: { lock_version: lockVersion },
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  /** Update a fact value under the server's optimistic lock version. */
  async updateKnowledgeFactValue(
    knowledgeBaseId: string | number,
    valueId: string | number,
    payload: ApiRecord,
    options: MutationOptions = {},
  ): Promise<KnowledgeFactValueMutationResponse> {
    return this.request<KnowledgeFactValueMutationResponse>(
      `materials/knowledge-bases/${this.numericId(knowledgeBaseId)}/fact-values/${this.numericId(valueId)}`,
      {
        method: 'PATCH',
        body: payload,
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  /** Archive a fact value and mark its conflict resolved. */
  async archiveKnowledgeFactValue(
    knowledgeBaseId: string | number,
    valueId: string | number,
    lockVersion: number,
    options: MutationOptions = {},
  ): Promise<KnowledgeFactValueMutationResponse> {
    return this.request<KnowledgeFactValueMutationResponse>(
      `materials/knowledge-bases/${this.numericId(knowledgeBaseId)}/fact-values/${this.numericId(valueId)}/archive`,
      {
        method: 'POST',
        body: { lock_version: lockVersion },
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  /**
   * Merge a duplicate fact into another fact in the same library. The server
   * moves the values across and removes the source fact.
   */
  async mergeKnowledgeFact(
    knowledgeBaseId: string | number,
    factId: string | number,
    targetFactId: string | number,
    options: MutationOptions = {},
  ): Promise<{ target_fact_id: number }> {
    return this.request<{ target_fact_id: number }>(
      `materials/knowledge-bases/${this.numericId(knowledgeBaseId)}/facts/${this.numericId(factId)}/merge`,
      {
        method: 'POST',
        body: { target_fact_id: this.numericId(targetFactId) },
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  /** Split the selected fact values off into a brand-new fact. */
  async splitKnowledgeFact(
    knowledgeBaseId: string | number,
    factId: string | number,
    payload: { value_ids: number[]; stable_key: string; label: string },
    options: MutationOptions = {},
  ): Promise<KnowledgeFactMutationResponse> {
    return this.request<KnowledgeFactMutationResponse>(
      `materials/knowledge-bases/${this.numericId(knowledgeBaseId)}/facts/${this.numericId(factId)}/split`,
      {
        method: 'POST',
        body: payload,
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  /**
   * Start an AI fact-generation run. `request_key` must be a UUID and is what
   * makes the run idempotent across retries of the same submission.
   */
  async startKnowledgeFactGeneration(
    knowledgeBaseId: string | number,
    payload: { mode: string; target_count: number; ai_model_id: number; request_key: string },
    options: MutationOptions = {},
  ): Promise<KnowledgeFactGenerationResponse> {
    return this.request<KnowledgeFactGenerationResponse>(
      `materials/knowledge-bases/${this.numericId(knowledgeBaseId)}/fact-generation`,
      {
        method: 'POST',
        body: payload,
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  /** Poll one generation run; the server also returns its presented progress. */
  async getKnowledgeFactGeneration(
    knowledgeBaseId: string | number,
    runId: string | number,
  ): Promise<KnowledgeFactGenerationResponse> {
    return this.request<KnowledgeFactGenerationResponse>(
      `materials/knowledge-bases/${this.numericId(knowledgeBaseId)}/fact-generation/${this.numericId(runId)}`,
    );
  }

  /** Cancel an in-flight generation run. */
  async cancelKnowledgeFactGeneration(
    knowledgeBaseId: string | number,
    runId: string | number,
    options: MutationOptions = {},
  ): Promise<KnowledgeFactGenerationResponse> {
    return this.request<KnowledgeFactGenerationResponse>(
      `materials/knowledge-bases/${this.numericId(knowledgeBaseId)}/fact-generation/${this.numericId(runId)}/cancel`,
      {
        method: 'POST',
        body: {},
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  /**
   * Resolve one generation conflict. `candidate_key` is the `_candidate_key`
   * the server attached to the conflict entry; `stable_key` is required only
   * for the `create_with_new_key` action.
   */
  async resolveKnowledgeFactGeneration(
    knowledgeBaseId: string | number,
    runId: string | number,
    payload: { action: string; candidate_key: string; stable_key?: string },
    options: MutationOptions = {},
  ): Promise<KnowledgeFactGenerationResponse> {
    return this.request<KnowledgeFactGenerationResponse>(
      `materials/knowledge-bases/${this.numericId(knowledgeBaseId)}/fact-generation/${this.numericId(runId)}/resolve`,
      {
        method: 'POST',
        body: payload,
        idempotencyKey: options.idempotencyKey,
      },
    );
  }

  async listUrlImports(params: Record<string, string | number | undefined> = {}): Promise<PaginatedResponse<UrlImportJobSummary>> {
    return this.request<PaginatedResponse<UrlImportJobSummary>>(`url-imports${this.query(params)}`);
  }

  async createUrlImport(payload: ApiRecord, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>('url-imports', {
      method: 'POST',
      body: payload,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async getUrlImport(id: string | number): Promise<UrlImportDetailResponse> {
    return this.request<UrlImportDetailResponse>(`url-imports/${this.numericId(id)}`);
  }

  async runUrlImport(id: string | number, options: MutationOptions = {}): Promise<UrlImportDetailResponse> {
    return this.request<UrlImportDetailResponse>(`url-imports/${this.numericId(id)}/run`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async commitUrlImport(id: string | number, options: MutationOptions = {}): Promise<ApiRecord> {
    return this.request<ApiRecord>(`url-imports/${this.numericId(id)}/commit`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async listUrlScans(params: Record<string, string | number | undefined> = {}): Promise<PaginatedResponse<UrlScanSummary>> {
    return this.request<PaginatedResponse<UrlScanSummary>>(`url-scans${this.query(params)}`);
  }

  async createUrlScan(url: string, options: MutationOptions = {}): Promise<{ scan: UrlScanResponse }> {
    return this.request<{ scan: UrlScanResponse }>('url-scans', {
      method: 'POST',
      body: { url },
      idempotencyKey: options.idempotencyKey,
    });
  }

  async getUrlScan(id: string | number): Promise<{ scan: UrlScanResponse }> {
    return this.request<{ scan: UrlScanResponse }>(`url-scans/${this.numericId(id)}`);
  }

  async retryUrlScan(id: string | number, options: MutationOptions = {}): Promise<{ scan: UrlScanResponse }> {
    return this.request<{ scan: UrlScanResponse }>(`url-scans/${this.numericId(id)}/retry`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }

  async downloadUrlScanReport(id: string | number): Promise<Blob> {
    const rid = requestId();
    const headers = new Headers({ Accept: 'text/markdown', 'X-Request-Id': rid });
    const token = this.token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await this.fetchImpl(this.buildUrl(`url-scans/${this.numericId(id)}/export`), { method: 'GET', headers });
    } catch (error) {
      throw new GeoFlowApiError(error instanceof Error ? error.message : '无法下载 URL 扫描报告', 0, 'network_error', {}, rid);
    }
    if (!response.ok) {
      if (response.status === 401) {
        this.clearToken();
        this.onUnauthorized?.();
      }
      throw new GeoFlowApiError('URL 扫描报告下载失败', response.status, 'url_scan_export_failed', {}, response.headers.get('X-Request-Id') || rid);
    }
    return response.blob();
  }

  private async downloadAuthenticated(path: string, accept: string, message: string, code: string): Promise<Blob> {
    const rid = requestId();
    const headers = new Headers({ Accept: accept, 'X-Request-Id': rid });
    const token = this.token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await this.fetchImpl(this.buildUrl(path), { method: 'GET', headers });
    } catch (error) {
      throw new GeoFlowApiError(error instanceof Error ? error.message : message, 0, 'network_error', {}, rid);
    }
    if (!response.ok) {
      if (response.status === 401) {
        this.clearToken();
        this.onUnauthorized?.();
      }
      throw new GeoFlowApiError(message, response.status, code, {}, response.headers.get('X-Request-Id') || rid);
    }
    return response.blob();
  }

  async request<T>(
    path: string,
    init: Omit<RequestInit, 'body'> & {
      body?: BodyInit | ApiRecord | null;
      skipAuth?: boolean;
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    const { skipAuth, idempotencyKey: suppliedIdempotencyKey, body, ...requestInit } = init;
    const method = String(requestInit.method || 'GET').toUpperCase();
    const headers = new Headers(requestInit.headers || {});
    headers.set('Accept', 'application/json');
    const rid = requestId();
    headers.set('X-Request-Id', rid);

    if (!skipAuth) {
      const token = this.token;
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
    }

    let encodedBody: BodyInit | undefined;
    if (body !== undefined && body !== null) {
      if (
        isFormData(body)
        || typeof body === 'string'
        || isBlob(body)
        || (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer)
      ) {
        encodedBody = body as BodyInit;
      } else {
        headers.set('Content-Type', 'application/json');
        encodedBody = JSON.stringify(body);
      }
    }

    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      headers.set('X-Idempotency-Key', suppliedIdempotencyKey || idempotencyKey());
    }

    const url = this.buildUrl(path);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...requestInit,
        method,
        headers,
        body: encodedBody,
      });
    } catch (error) {
      throw new GeoFlowApiError(
        error instanceof Error ? error.message : '无法连接 桐灼GEO API',
        0,
        'network_error',
        {},
        rid,
      );
    }

    const responseHeaderRequestId = response.headers.get('X-Request-Id');
    if (response.status === 204) {
      return undefined as T;
    }

    const raw = await response.text();
    let payload: ApiEnvelope<T> | null = null;
    if (raw.trim() !== '') {
      try {
        payload = JSON.parse(raw) as ApiEnvelope<T>;
      } catch {
        throw new GeoFlowApiError('服务器返回了无法解析的响应', response.status, 'invalid_response', {}, responseHeaderRequestId || rid);
      }
    }

    const responseRequestId = responseHeaderRequestId
      || payload?.meta?.request_id
      || rid;
    this._lastRequestId = responseRequestId;

    const errorPayload = payload?.error;
    if (!response.ok || payload?.success === false) {
      const status = response.status || 500;
      const code = String(errorPayload?.code || (status === 401 ? 'unauthorized' : 'request_failed'));
      const message = String(errorPayload?.message || `请求失败（HTTP ${status}）`);
      if (status === 401 && !skipAuth) {
        this.clearToken();
        this.onUnauthorized?.();
      }
      throw new GeoFlowApiError(message, status, code, errorPayload?.details || {}, responseRequestId);
    }

    if (!payload || payload.success !== true) {
      throw new GeoFlowApiError('服务器返回了不符合 桐灼GEO 信封的响应', response.status, 'invalid_response', {}, responseRequestId);
    }

    return payload.data as T;
  }

  private buildUrl(path: string): string {
    const normalizedPath = String(path || '').replace(/^\/+/, '');
    return `${this.baseUrl}/${normalizedPath}`;
  }

  private query(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && String(value) !== '') {
        search.set(key, String(value));
      }
    });
    const encoded = search.toString();
    return encoded ? `?${encoded}` : '';
  }

  private numericId(value: string | number): number {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
      throw new GeoFlowApiError('资源 ID 无效', 0, 'invalid_id');
    }
    return id;
  }

  private pathSegment(value: string): string {
    const normalized = String(value || '').trim();
    if (!normalized || normalized.includes('/')) {
      throw new GeoFlowApiError('资源类型无效', 0, 'invalid_type');
    }
    return encodeURIComponent(normalized);
  }
}
