import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApiAuthSession,
  GeoFlowApiClient,
  GeoFlowApiError,
  StorageLike,
} from './geoflowClient';

const TOKEN_STORAGE_KEY = 'geoflow.api.v1.token';
const SESSION_STORAGE_KEY = 'geoflow.api.v1.session';

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function envelope<T>(data: T, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({
    success: true,
    data,
    error: null,
    meta: { request_id: 'response-request-id' },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
    ...init,
  });
}

test('login uses the 桐灼GEO envelope and persists the returned token', async () => {
  const storage = new MemoryStorage();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const session: ApiAuthSession = {
    token: 'secret-token',
    scopes: ['catalog:read'],
    expires_at: '2026-09-06T00:00:00Z',
    admin: {
      id: 7,
      username: 'admin',
      display_name: '运营管理员',
      role: 'super_admin',
      status: 'active',
    },
  };
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope(session);
  }) as typeof fetch;
  const client = new GeoFlowApiClient({
    baseUrl: 'https://geo.example/api/v1/',
    fetchImpl,
    storage,
  });

  const result = await client.login('admin', 'password');

  assert.deepEqual(result, session);
  assert.equal(storage.getItem(TOKEN_STORAGE_KEY), 'secret-token');
  assert.deepEqual(JSON.parse(storage.getItem(SESSION_STORAGE_KEY) || 'null'), session);
  assert.equal(calls[0].url, 'https://geo.example/api/v1/auth/login');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    username: 'admin',
    password: 'password',
  });
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('Authorization'), null);
  assert.equal(headers.get('Accept'), 'application/json');
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.ok(headers.get('X-Request-Id'));
});

test('logout revokes the current bearer token before clearing local session state', async () => {
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_STORAGE_KEY, 'logout-token');
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: 'logout-token' }));
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ logged_out: true, token_revoked: true });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: '/api/v1', fetchImpl, storage });

  await client.logout();

  assert.equal(calls[0].url, '/api/v1/auth/logout');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(new Headers(calls[0].init.headers).get('Authorization'), 'Bearer logout-token');
  assert.equal(storage.getItem(TOKEN_STORAGE_KEY), null);
  assert.equal(storage.getItem(SESSION_STORAGE_KEY), null);
});

test('the default browser fetch is invoked with the global receiver', async () => {
  const originalFetch = globalThis.fetch;
  let receiver: unknown = null;
  globalThis.fetch = function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit) {
    receiver = this;
    return Promise.resolve(envelope({
      token: 'native-token',
      scopes: [],
      expires_at: null,
      admin: {
        id: 1,
        username: 'admin',
        display_name: '管理员',
        role: 'super_admin',
        status: 'active',
      },
    }));
  } as typeof fetch;

  try {
    const client = new GeoFlowApiClient({ baseUrl: '/api/v1', storage: null });
    await client.login('admin', 'password');
    assert.equal(receiver, globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('system update client uses authenticated scoped endpoints and idempotency keys', async () => {
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_STORAGE_KEY, 'system-token');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith('/updater/package')) {
      return new Response(new Blob(['archive']), { status: 200, headers: { 'Content-Type': 'application/gzip' } });
    }
    return envelope({ accepted: true }, { status: init.method === 'POST' ? 202 : 200 });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage });

  await client.getSystemUpdates('archived');
  await client.checkSystemUpdates({ idempotencyKey: 'system-check-1' });
  await client.prepareSystemUpdater({ idempotencyKey: 'system-prepare-1' });
  await client.startSystemUpdateOperation('backup', {
    current_admin_password: 'secret',
    updater_authorization_code: '123456',
  }, { idempotencyKey: 'system-backup-1' });
  const archive = await client.downloadSystemUpdaterPackage();

  assert.equal(calls[0].url, 'https://geo.test/api/v1/system-updates?history=archived');
  assert.equal(calls[1].url, 'https://geo.test/api/v1/system-updates/check');
  assert.equal(calls[2].url, 'https://geo.test/api/v1/system-updates/updater/prepare');
  assert.equal(calls[3].url, 'https://geo.test/api/v1/system-updates/operations/backup');
  assert.equal(calls[4].url, 'https://geo.test/api/v1/system-updates/updater/package');
  assert.equal(new Headers(calls[0].init.headers).get('Authorization'), 'Bearer system-token');
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'system-check-1');
  assert.equal(new Headers(calls[2].init.headers).get('X-Idempotency-Key'), 'system-prepare-1');
  assert.equal(new Headers(calls[3].init.headers).get('X-Idempotency-Key'), 'system-backup-1');
  assert.equal(new Headers(calls[4].init.headers).get('Accept'), 'application/gzip');
  assert.deepEqual(JSON.parse(String(calls[3].init.body)), {
    current_admin_password: 'secret',
    updater_authorization_code: '123456',
  });
  assert.equal(await archive.text(), 'archive');
});

test('authenticated requests include the persisted Bearer token', async () => {
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_STORAGE_KEY, 'persisted-token');
  let requestHeaders = new Headers();
  const fetchImpl = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    requestHeaders = new Headers(init.headers);
    return envelope({
      models: [],
      prompts: [],
      keyword_libraries: [],
      title_libraries: [],
      image_libraries: [],
      knowledge_bases: [],
      authors: [],
      categories: [],
    });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: '/api/v1', fetchImpl, storage });

  await client.catalog();

  assert.equal(requestHeaders.get('Authorization'), 'Bearer persisted-token');
});

test('a fresh client restores the login projection while retaining the bearer token', () => {
  const storage = new MemoryStorage();
  const session: ApiAuthSession = {
    token: 'restored-token',
    scopes: ['articles:read'],
    expires_at: null,
    admin: {
      id: 11,
      username: 'refreshed-admin',
      display_name: '刷新后的管理员',
      role: 'admin',
      status: 'active',
    },
  };
  storage.setItem(TOKEN_STORAGE_KEY, session.token);
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));

  const client = new GeoFlowApiClient({ baseUrl: '/api/v1', storage, fetchImpl: (async () => envelope({})) as typeof fetch });

  assert.equal(client.token, session.token);
  assert.deepEqual(client.session, session);
  client.clearToken();
  assert.equal(client.session, null);
  assert.equal(storage.getItem(SESSION_STORAGE_KEY), null);
});

test('session restoration rejects a mismatched bearer token or expired projection', () => {
  const storage = new MemoryStorage();
  const baseSession: ApiAuthSession = {
    token: 'session-token',
    scopes: ['articles:read'],
    expires_at: null,
    admin: {
      id: 12,
      username: 'session-admin',
      display_name: '会话管理员',
      role: 'admin',
      status: 'active',
    },
  };
  storage.setItem(TOKEN_STORAGE_KEY, 'different-token');
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(baseSession));
  const client = new GeoFlowApiClient({ baseUrl: '/api/v1', storage, fetchImpl: (async () => envelope({})) as typeof fetch });

  assert.equal(client.session, null);

  storage.setItem(TOKEN_STORAGE_KEY, baseSession.token);
  storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
    ...baseSession,
    expires_at: '2000-01-01T00:00:00Z',
  }));
  assert.equal(client.session, null);
});

test('API failures expose the 桐灼GEO code, field errors and response request ID', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({
    success: false,
    data: null,
    error: {
      code: 'validation_failed',
      message: '参数校验失败',
      details: { field_errors: { title: '标题不能为空' } },
    },
  }), {
    status: 422,
    headers: { 'X-Request-Id': 'backend-request-id' },
  })) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: '/api/v1', fetchImpl, storage: null });

  await assert.rejects(
    () => client.createArticle({ title: '' }),
    (error: unknown) => {
      assert.ok(error instanceof GeoFlowApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, 'validation_failed');
      assert.equal(error.message, '参数校验失败');
      assert.deepEqual(error.details, { field_errors: { title: '标题不能为空' } });
      assert.equal(error.requestId, 'backend-request-id');
      return true;
    },
  );
});

test('an authenticated 401 clears the token and notifies the application', async () => {
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_STORAGE_KEY, 'expired-token');
  let unauthorizedCalls = 0;
  const fetchImpl = (async () => new Response(JSON.stringify({
    success: false,
    data: null,
    error: { code: 'unauthorized', message: 'Token 已失效', details: {} },
  }), { status: 401 })) as typeof fetch;
  const client = new GeoFlowApiClient({
    baseUrl: '/api/v1',
    fetchImpl,
    storage,
    onUnauthorized: () => {
      unauthorizedCalls += 1;
    },
  });

  await assert.rejects(() => client.catalog(), GeoFlowApiError);

  assert.equal(client.authenticated, false);
  assert.equal(storage.getItem(TOKEN_STORAGE_KEY), null);
  assert.equal(unauthorizedCalls, 1);
});

test('mutations send the supplied idempotency key while reads do not', async () => {
  const calls: RequestInit[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push(init);
    return envelope({ items: [], pagination: { total: 0 } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: '/api/v1', fetchImpl, storage: null });

  await client.listArticles();
  await client.createArticle({ title: '测试文章' }, { idempotencyKey: 'article-create-1' });

  assert.equal(new Headers(calls[0].headers).get('X-Idempotency-Key'), null);
  assert.equal(new Headers(calls[1].headers).get('X-Idempotency-Key'), 'article-create-1');
});

test('site discovery reads and publication mutations use the authenticated v1 contract', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ content: 'generated output' });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.getSiteSeoConfig();
  await client.previewRobots();
  await client.previewSitemap();
  await client.previewLlms('full');
  await client.updateSiteSeoConfig({ summary: '企业站摘要' }, { idempotencyKey: 'seo-draft-1' });
  await client.rebuildSitemap({ idempotencyKey: 'sitemap-preview-1' });
  await client.publishLlms({ idempotencyKey: 'seo-publish-1' });

  assert.deepEqual(calls.map((call) => [call.url, call.init.method]), [
    ['https://geo.test/api/v1/site/seo-config', 'GET'],
    ['https://geo.test/api/v1/site/robots/preview', 'GET'],
    ['https://geo.test/api/v1/site/sitemap/preview', 'GET'],
    ['https://geo.test/api/v1/site/llms-txt/preview?variant=full', 'GET'],
    ['https://geo.test/api/v1/site/seo-config', 'PATCH'],
    ['https://geo.test/api/v1/site/sitemap/rebuild', 'POST'],
    ['https://geo.test/api/v1/site/llms-txt/publish', 'POST'],
  ]);
  assert.equal(new Headers(calls[0].init.headers).get('X-Idempotency-Key'), null);
  assert.equal(new Headers(calls[4].init.headers).get('X-Idempotency-Key'), 'seo-draft-1');
  assert.equal(new Headers(calls[5].init.headers).get('X-Idempotency-Key'), 'sitemap-preview-1');
  assert.equal(new Headers(calls[6].init.headers).get('X-Idempotency-Key'), 'seo-publish-1');
});

test('manual publication management listing does not collide with the browser protocol route', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return envelope({ items: [], pagination: { total: 0 } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: '/api/v1', fetchImpl, storage: null });

  await client.listManualPublications({ page: 2, status: 'ready' });

  assert.equal(calls[0], '/api/v1/manual-publications/management?page=2&status=ready');
});

test('distribution channel creation uses the write endpoint and returns one-time credentials', async () => {
  let requestedUrl = '';
  let requestHeaders = new Headers();
  let requestBody: unknown;
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    requestedUrl = String(input);
    requestHeaders = new Headers(init.headers);
    requestBody = JSON.parse(String(init.body));
    return envelope({
      channel: { id: 4, channel_type: 'geoflow_agent' },
      one_time_secret: { key_id: 'gfk_test', secret: 'gfsec_test' },
    }, { status: 201 });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  const result = await client.createDistributionChannel({
    name: '官网 Agent',
    domain: 'site.example.test',
    endpoint_url: 'https://site.example.test/agent',
    channel_type: 'geoflow_agent',
  }, { idempotencyKey: 'channel-create-1' });

  assert.equal(requestedUrl, 'https://geo.test/api/v1/distribution/channels');
  assert.equal(requestHeaders.get('X-Idempotency-Key'), 'channel-create-1');
  assert.deepEqual(requestBody, {
    name: '官网 Agent',
    domain: 'site.example.test',
    endpoint_url: 'https://site.example.test/agent',
    channel_type: 'geoflow_agent',
  });
  assert.equal((result.one_time_secret as { secret: string }).secret, 'gfsec_test');
});

test('material detail and mutations use the v1 material resource paths', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ type: 'knowledge-bases', item: { id: 12 } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.getMaterial('knowledge-bases', 12);
  await client.updateMaterial('knowledge-bases', 12, { description: '更新' }, { idempotencyKey: 'kb-update-1' });
  await client.deleteMaterial('knowledge-bases', 12, { idempotencyKey: 'kb-delete-1' });

  assert.equal(calls[0].url, 'https://geo.test/api/v1/materials/knowledge-bases/12');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].url, 'https://geo.test/api/v1/materials/knowledge-bases/12');
  assert.equal(calls[1].init.method, 'PATCH');
  assert.equal(JSON.parse(String(calls[1].init.body)).description, '更新');
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'kb-update-1');
  assert.equal(calls[2].url, 'https://geo.test/api/v1/materials/knowledge-bases/12');
  assert.equal(calls[2].init.method, 'DELETE');
  assert.equal(new Headers(calls[2].init.headers).get('X-Idempotency-Key'), 'kb-delete-1');
});

test('material summary and library item mutations use the authenticated v1 contract', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ types: [{ type: 'keyword-libraries', count: 2 }] });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.materialSummary();
  await client.listMaterialItems('keyword-libraries', 7, { page: 2, per_page: 10 });
  await client.createMaterialItem('keyword-libraries', 7, { keyword: 'GEO' }, { idempotencyKey: 'keyword-create-1' });
  await client.deleteMaterialItems('keyword-libraries', 7, { ids: [11, 12] }, { idempotencyKey: 'keyword-delete-1' });

  assert.equal(calls[0].url, 'https://geo.test/api/v1/materials');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].url, 'https://geo.test/api/v1/materials/keyword-libraries/7/items?page=2&per_page=10');
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[2].url, 'https://geo.test/api/v1/materials/keyword-libraries/7/items');
  assert.equal(calls[2].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { keyword: 'GEO' });
  assert.equal(new Headers(calls[2].init.headers).get('X-Idempotency-Key'), 'keyword-create-1');
  assert.equal(calls[3].url, 'https://geo.test/api/v1/materials/keyword-libraries/7/items');
  assert.equal(calls[3].init.method, 'DELETE');
  assert.deepEqual(JSON.parse(String(calls[3].init.body)), { ids: [11, 12] });
  assert.equal(new Headers(calls[3].init.headers).get('X-Idempotency-Key'), 'keyword-delete-1');
});

test('knowledge asset lifecycle uses dedicated upload, refresh, revision and media endpoints', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ item: { id: 9 }, revisions: [], media: [] });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });
  const upload = new FormData();
  upload.set('name', '企业资料');
  upload.set('knowledge_file', new Blob(['正文'], { type: 'text/plain' }), 'source.txt');

  await client.getKnowledgeBase(9);
  await client.uploadKnowledgeBase(upload, { idempotencyKey: 'kb-upload-1' });
  await client.refreshKnowledgeBase(9, { idempotencyKey: 'kb-refresh-1' });
  await client.listKnowledgeBaseRevisions(9);
  await client.restoreKnowledgeBaseRevision(9, 4, { idempotencyKey: 'kb-restore-1' });
  await client.listKnowledgeBaseMedia(9);
  const media = new FormData();
  media.set('image', new Blob(['png'], { type: 'image/png' }), 'asset.png');
  await client.uploadKnowledgeBaseMedia(9, media, { idempotencyKey: 'media-upload-1' });
  await client.updateKnowledgeBaseMedia(9, 5, { title: '新标题' }, { idempotencyKey: 'media-update-1' });
  await client.toggleKnowledgeBaseMedia(9, 5, false, { idempotencyKey: 'media-toggle-1' });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/knowledge-bases/9',
    'https://geo.test/api/v1/knowledge-bases/upload',
    'https://geo.test/api/v1/knowledge-bases/9/refresh',
    'https://geo.test/api/v1/knowledge-bases/9/revisions',
    'https://geo.test/api/v1/knowledge-bases/9/revisions/4/restore',
    'https://geo.test/api/v1/knowledge-bases/9/media',
    'https://geo.test/api/v1/knowledge-bases/9/media',
    'https://geo.test/api/v1/knowledge-bases/9/media/5',
    'https://geo.test/api/v1/knowledge-bases/9/media/5/toggle',
  ]);
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'kb-upload-1');
  assert.ok(calls[1].init.body instanceof FormData);
  assert.equal(new Headers(calls[8].init.headers).get('X-Idempotency-Key'), 'media-toggle-1');
});

test('enterprise knowledge draft lifecycle uses the governed v1 endpoints', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ item: { id: 21, status: 'reviewing' }, items: [], pagination: { total: 0 } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.listEnterpriseKnowledge({ page: 2, per_page: 10 });
  await client.getEnterpriseKnowledge(21);
  await client.getEnterpriseKnowledgeStatus(21);
  const image = new FormData();
  image.set('image', new Blob(['png'], { type: 'image/png' }), 'diagram.png');
  await client.uploadEnterpriseKnowledgeImage(21, image, { idempotencyKey: 'enterprise-image-1' });
  await client.createEnterpriseKnowledge({ name: '企业知识', content: '资料' }, { idempotencyKey: 'enterprise-create-1' });
  await client.autosaveEnterpriseKnowledge(21, '草稿', { idempotencyKey: 'enterprise-save-1' });
  await client.validateEnterpriseKnowledge(21, '草稿', { idempotencyKey: 'enterprise-validate-1' });
  await client.restoreEnterpriseKnowledgeRevision(21, 3, { idempotencyKey: 'enterprise-restore-1' });
  await client.publishEnterpriseKnowledge(21, { idempotencyKey: 'enterprise-publish-1' });
  await client.deleteEnterpriseKnowledge(21, { idempotencyKey: 'enterprise-delete-1' });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/enterprise-knowledge?page=2&per_page=10',
    'https://geo.test/api/v1/enterprise-knowledge/21',
    'https://geo.test/api/v1/enterprise-knowledge/21/status',
    'https://geo.test/api/v1/enterprise-knowledge/21/editor/images/upload',
    'https://geo.test/api/v1/enterprise-knowledge',
    'https://geo.test/api/v1/enterprise-knowledge/21/autosave',
    'https://geo.test/api/v1/enterprise-knowledge/21/validate',
    'https://geo.test/api/v1/enterprise-knowledge/21/revisions/3/restore',
    'https://geo.test/api/v1/enterprise-knowledge/21/publish',
    'https://geo.test/api/v1/enterprise-knowledge/21',
  ]);
  assert.equal(new Headers(calls[3].init.headers).get('X-Idempotency-Key'), 'enterprise-image-1');
  assert.ok(calls[3].init.body instanceof FormData);
  assert.equal(new Headers(calls[4].init.headers).get('X-Idempotency-Key'), 'enterprise-create-1');
  assert.equal(new Headers(calls[9].init.headers).get('X-Idempotency-Key'), 'enterprise-delete-1');
});

test('knowledge search uses the authenticated read-only endpoint and encodes the query', async () => {
  let requestedUrl = '';
  const fetchImpl = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return envelope({
      knowledge_base: { id: 9, name: '资料库' },
      query: '产品 / GEO',
      items: [{ chunk_id: 1, score: 0.7 }],
    });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  const result = await client.searchKnowledgeBase(9, '产品 / GEO', 5);

  assert.equal(requestedUrl, 'https://geo.test/api/v1/materials/knowledge-bases/9/search?query=%E4%BA%A7%E5%93%81+%2F+GEO&limit=5');
  assert.equal(result.items[0].chunk_id, 1);
});

test('knowledge fact workbench and mutations use the governed v1 contract', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fact = {
    id: 41,
    stable_key: 'company.name',
    label: '公司名称',
    subject: 'company',
    predicate: 'name',
    value_type: 'string',
    locale: 'zh-CN',
    aliases: [],
    importance: 'high',
    usage_scope: 'quality_and_generation',
    review_status: 'draft',
    is_enabled: true,
    lock_version: 1,
    values: [],
  };
  const value = {
    id: 88,
    fact_id: 41,
    canonical_value: { value: '桐灼科技', unit: null },
    canonical_answer: '桐灼科技',
    temporal_kind: 'timeless',
    scope: {},
    valid_from: null,
    valid_to: null,
    observed_at: null,
    comparison_policy: {},
    review_status: 'draft',
    conflict_status: 'clear',
    lock_version: 1,
    evidences: [],
  };
  const evidence = {
    id: 99,
    value_id: 88,
    knowledge_chunk_id: 7,
    source_hash: 'source-hash',
    content_hash: 'content-hash',
    source_locator: { page: 1 },
    excerpt: '服务器确认的原文片段',
    excerpt_hash: 'excerpt-hash',
    is_primary: true,
  };
  const revision = {
    id: 3,
    library_id: 5,
    version: 2,
    library_hash: 'library-hash',
    source_hash: 'source-hash',
    published_by_admin_id: 1,
    published_at: '2026-09-07T00:00:00Z',
    restored_from_revision_id: null,
    publisher: { id: 1, username: 'admin' },
  };
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({
      knowledge_base: { id: 9, name: '企业知识库' },
      library: {
        id: 5,
        knowledge_base_id: 9,
        summary: { fact_count: 1 },
        publish_readiness: { ready: true, blockers: [] },
      },
      items: [fact],
      pagination: { page: 2, per_page: 10, total: 1, total_pages: 1 },
      revisions: [revision],
      generation_runs: [],
      can_manage_protected: true,
      fact,
      value,
      evidence,
      revision,
    });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  const workbench = await client.getKnowledgeFactWorkbench('9', {
    q: '官网 / GEO',
    status: 'pending',
    page: 2,
    per_page: 10,
  });
  await client.createKnowledgeFact('9', {
    stable_key: 'company.name',
    label: '公司名称',
    subject: 'company',
    predicate: 'name',
    value_type: 'string',
  }, { idempotencyKey: 'fact-create-1' });
  await client.updateKnowledgeFact(9, '41', {
    lock_version: 1,
    label: '公司全称',
  }, { idempotencyKey: 'fact-update-41' });
  await client.reviewKnowledgeFact(9, 41, {
    lock_version: 2,
    review_status: 'reviewed',
  }, { idempotencyKey: 'fact-review-41' });
  await client.createKnowledgeFactValue(9, 41, {
    canonical_value_json: { value: '桐灼科技', unit: null },
    canonical_answer: '桐灼科技',
  }, { idempotencyKey: 'fact-value-41' });
  await client.createKnowledgeFactEvidence(9, 88, {
    knowledge_chunk_id: 7,
    is_primary: true,
    excerpt: '客户端片段（服务端会校验并覆盖）',
    source_locator_json: { page: 999 },
  }, { idempotencyKey: 'fact-evidence-88' });
  await client.publishKnowledgeFacts(9, { idempotencyKey: 'fact-publish-9' });
  await client.restoreKnowledgeFactRevision(9, 3, { idempotencyKey: 'fact-restore-3' });

  assert.equal(workbench.items[0].id, 41);
  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/materials/knowledge-bases/9/facts?q=%E5%AE%98%E7%BD%91+%2F+GEO&status=pending&page=2&per_page=10',
    'https://geo.test/api/v1/materials/knowledge-bases/9/facts',
    'https://geo.test/api/v1/materials/knowledge-bases/9/facts/41',
    'https://geo.test/api/v1/materials/knowledge-bases/9/facts/41/review',
    'https://geo.test/api/v1/materials/knowledge-bases/9/facts/41/values',
    'https://geo.test/api/v1/materials/knowledge-bases/9/fact-values/88/evidences',
    'https://geo.test/api/v1/materials/knowledge-bases/9/facts/publish',
    'https://geo.test/api/v1/materials/knowledge-bases/9/fact-revisions/3/restore',
  ]);

  assert.equal(calls[0].init.method, 'GET');
  assert.equal(new Headers(calls[0].init.headers).get('X-Idempotency-Key'), null);
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    stable_key: 'company.name',
    label: '公司名称',
    subject: 'company',
    predicate: 'name',
    value_type: 'string',
  });
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'fact-create-1');
  assert.equal(calls[2].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { lock_version: 1, label: '公司全称' });
  assert.equal(new Headers(calls[2].init.headers).get('X-Idempotency-Key'), 'fact-update-41');
  assert.equal(calls[3].init.method, 'POST');
  assert.equal(new Headers(calls[3].init.headers).get('X-Idempotency-Key'), 'fact-review-41');
  assert.equal(calls[4].init.method, 'POST');
  assert.equal(new Headers(calls[4].init.headers).get('X-Idempotency-Key'), 'fact-value-41');
  assert.equal(calls[5].init.method, 'POST');
  assert.equal(new Headers(calls[5].init.headers).get('X-Idempotency-Key'), 'fact-evidence-88');
  assert.equal(calls[6].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[6].init.body)), {});
  assert.equal(new Headers(calls[6].init.headers).get('X-Idempotency-Key'), 'fact-publish-9');
  assert.equal(calls[7].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[7].init.body)), {});
  assert.equal(new Headers(calls[7].init.headers).get('X-Idempotency-Key'), 'fact-restore-3');
});

test('knowledge fact archiving, merge, split and generation use the governed v1 contract', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fact = {
    id: 41,
    stable_key: 'company.name',
    label: '公司名称',
    subject: 'company',
    predicate: 'name',
    value_type: 'string',
    lock_version: 3,
  };
  const value = { id: 88, fact_id: 41, canonical_answer: '桐灼科技', lock_version: 2 };
  const run = {
    id: 12,
    library_id: 5,
    mode: 'supplement',
    target_count: 10,
    source_hash: 'source-hash',
    status: 'running',
    ai_model_id: 3,
    created_by_admin_id: 1,
    request_key: '11111111-1111-4111-8111-111111111111',
    retryable_failure: true,
    candidate_count: 4,
    conflict_count: 1,
    conflicts: [{ _candidate_key: 'candidate-key-1', stable_key: 'company.name', label: '公司名称' }],
  };
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ fact, value, run, presented: { id: 12, status: 'running', progress_percent: 42, stage: 'running' } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.archiveKnowledgeFact(9, 41, 3, { idempotencyKey: 'fact-archive-41' });
  await client.updateKnowledgeFactValue(9, 88, {
    lock_version: 2,
    canonical_answer: '桐灼科技（更新）',
  }, { idempotencyKey: 'fact-value-update-88' });
  await client.archiveKnowledgeFactValue(9, 88, 2, { idempotencyKey: 'fact-value-archive-88' });
  await client.mergeKnowledgeFact(9, 41, 42, { idempotencyKey: 'fact-merge-41' });
  await client.splitKnowledgeFact(9, 41, {
    value_ids: [88, 89],
    stable_key: 'company.legal_name',
    label: '公司法定名称',
  }, { idempotencyKey: 'fact-split-41' });
  const started = await client.startKnowledgeFactGeneration(9, {
    mode: 'supplement',
    target_count: 10,
    ai_model_id: 3,
    request_key: '11111111-1111-4111-8111-111111111111',
  }, { idempotencyKey: 'fact-generation-9' });
  const polled = await client.getKnowledgeFactGeneration(9, 12);
  await client.cancelKnowledgeFactGeneration(9, 12, { idempotencyKey: 'fact-generation-cancel-12' });
  await client.resolveKnowledgeFactGeneration(9, 12, {
    action: 'merge_as_value',
    candidate_key: 'candidate-key-1',
  }, { idempotencyKey: 'fact-generation-resolve-12' });
  await client.resolveKnowledgeFactGeneration(9, 12, {
    action: 'create_with_new_key',
    candidate_key: 'candidate-key-2',
    stable_key: 'company.legal_name',
  }, { idempotencyKey: 'fact-generation-resolve-12b' });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/materials/knowledge-bases/9/facts/41/archive',
    'https://geo.test/api/v1/materials/knowledge-bases/9/fact-values/88',
    'https://geo.test/api/v1/materials/knowledge-bases/9/fact-values/88/archive',
    'https://geo.test/api/v1/materials/knowledge-bases/9/facts/41/merge',
    'https://geo.test/api/v1/materials/knowledge-bases/9/facts/41/split',
    'https://geo.test/api/v1/materials/knowledge-bases/9/fact-generation',
    'https://geo.test/api/v1/materials/knowledge-bases/9/fact-generation/12',
    'https://geo.test/api/v1/materials/knowledge-bases/9/fact-generation/12/cancel',
    'https://geo.test/api/v1/materials/knowledge-bases/9/fact-generation/12/resolve',
    'https://geo.test/api/v1/materials/knowledge-bases/9/fact-generation/12/resolve',
  ]);

  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { lock_version: 3 });
  assert.equal(new Headers(calls[0].init.headers).get('X-Idempotency-Key'), 'fact-archive-41');

  assert.equal(calls[1].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { lock_version: 2, canonical_answer: '桐灼科技（更新）' });
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'fact-value-update-88');

  assert.equal(calls[2].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { lock_version: 2 });

  assert.equal(calls[3].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[3].init.body)), { target_fact_id: 42 });

  assert.equal(calls[4].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[4].init.body)), {
    value_ids: [88, 89],
    stable_key: 'company.legal_name',
    label: '公司法定名称',
  });

  assert.equal(calls[5].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[5].init.body)), {
    mode: 'supplement',
    target_count: 10,
    ai_model_id: 3,
    request_key: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(new Headers(calls[5].init.headers).get('X-Idempotency-Key'), 'fact-generation-9');

  // Reads never carry an idempotency key, matching the rest of the client.
  assert.equal(calls[6].init.method, 'GET');
  assert.equal(new Headers(calls[6].init.headers).get('X-Idempotency-Key'), null);

  assert.equal(calls[7].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[7].init.body)), {});

  assert.equal(calls[8].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[8].init.body)), { action: 'merge_as_value', candidate_key: 'candidate-key-1' });

  // `stable_key` is only sent for the create_with_new_key action.
  assert.deepEqual(JSON.parse(String(calls[9].init.body)), {
    action: 'create_with_new_key',
    candidate_key: 'candidate-key-2',
    stable_key: 'company.legal_name',
  });

  assert.equal(started.run.id, 12);
  assert.equal(started.presented?.progress_percent, 42);
  assert.equal(polled.run.conflict_count, 1);
  assert.equal((run.conflicts[0] as { _candidate_key: string })._candidate_key, 'candidate-key-1');
});

test('distribution channel listing and health checks use the authenticated 桐灼GEO endpoints', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ items: [{ id: 4, name: '官网' }], channel: { id: 4, status: 'active' } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  const list = await client.listDistributionChannels();
  await client.healthDistributionChannel(4, { idempotencyKey: 'health-4' });

  assert.equal(list.items[0].id, 4);
  assert.equal(calls[0].url, 'https://geo.test/api/v1/distribution/channels');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].url, 'https://geo.test/api/v1/distribution/channels/4/health');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'health-4');
});

test('distribution jobs can be listed and retried through the v1 endpoints', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ items: [{ id: 12, status: 'failed' }], job: { id: 12, status: 'queued' } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  const page = await client.listDistributionJobs({ status: 'failed', page: 1 });
  const retried = await client.retryDistribution(12, { idempotencyKey: 'distribution-retry-12' });
  const retriedJob = (retried as Record<string, unknown>).job as Record<string, unknown>;

  assert.equal(page.items[0].id, 12);
  assert.equal(retriedJob.status, 'queued');
  assert.equal(calls[0].url, 'https://geo.test/api/v1/distribution/jobs?status=failed&page=1');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].url, 'https://geo.test/api/v1/distribution/jobs/12/retry');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'distribution-retry-12');
});

test('hosted site lifecycle uses the dedicated 桐灼GEO endpoints', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ hosted_site: { id: 9, status: 'active' }, preflight: { passed: true } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.listHostedSites({ page: 2 });
  await client.getHostedSite(9);
  await client.createHostedSite({ name: '内容站', hostname: 'news.example.test' }, { idempotencyKey: 'hs-create' });
  await client.updateHostedSite(9, { name: '内容站 2' }, { idempotencyKey: 'hs-update' });
  await client.preflightHostedSite(9, { idempotencyKey: 'hs-preflight' });
  await client.activateHostedSite(9, { idempotencyKey: 'hs-activate' });
  await client.pauseHostedSite(9, { idempotencyKey: 'hs-pause' });
  await client.maintainHostedSite(9, { idempotencyKey: 'hs-maintenance' });
  await client.setHostedSiteIndexing(9, { indexing_status: 'index', quality_confirmed: true }, { idempotencyKey: 'hs-indexing' });
  await client.archiveHostedSite(9, 'news.example.test', { idempotencyKey: 'hs-archive' });
  await client.assignHostedSiteArticle(9, 17, { idempotencyKey: 'hs-article' });

  assert.equal(calls[0].url, 'https://geo.test/api/v1/distribution/hosted-sites?page=2');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].url, 'https://geo.test/api/v1/distribution/hosted-sites/9');
  assert.equal(calls[2].url, 'https://geo.test/api/v1/distribution/hosted-sites');
  assert.equal(new Headers(calls[2].init.headers).get('X-Idempotency-Key'), 'hs-create');
  assert.equal(calls[7].url, 'https://geo.test/api/v1/distribution/hosted-sites/9/maintenance');
  assert.equal(new Headers(calls[9].init.headers).get('X-Idempotency-Key'), 'hs-archive');
  assert.deepEqual(JSON.parse(String(calls[10].init.body)), { article_id: 17 });
});

test('source provider configuration uses the protected v1 endpoints', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ items: [{ id: 6, name: '可见度搜索' }], provider: { id: 6 } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.listAiSourceProviders();
  await client.createAiSourceProvider({ name: '可见度搜索', api_key: 'secret' }, { idempotencyKey: 'provider-create' });
  await client.updateAiSourceProvider(6, { name: '新名称' }, { idempotencyKey: 'provider-update' });
  await client.deleteAiSourceProvider(6, { idempotencyKey: 'provider-delete' });

  assert.equal(calls[0].url, 'https://geo.test/api/v1/source-providers');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'provider-create');
  assert.equal(calls[2].url, 'https://geo.test/api/v1/source-providers/6');
  assert.equal(calls[2].init.method, 'PATCH');
  assert.equal(calls[3].init.method, 'DELETE');
  assert.equal(new Headers(calls[3].init.headers).get('X-Idempotency-Key'), 'provider-delete');
});

test('AI model defaults and prompt projections use authenticated v1 endpoints', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ items: [{ id: 8, model_type: 'chat', is_default: true }], model: { id: 8, is_default: true } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  const models = await client.listAiModels();
  await client.setDefaultAiModel(8, { idempotencyKey: 'model-default-8' });
  const prompts = await client.listPrompts();

  assert.equal(models.items[0].id, 8);
  assert.equal(prompts.items[0].id, 8);
  assert.equal(calls[0].url, 'https://geo.test/api/v1/models');
  assert.equal(calls[1].url, 'https://geo.test/api/v1/models/8/default');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'model-default-8');
  assert.equal(calls[2].url, 'https://geo.test/api/v1/prompts');
});

test('task lifecycle methods use the v1 paths and preserve queue payloads', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ task_id: 7, job_id: 22, status: 'pending' });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.startTask(7, true, { idempotencyKey: 'start-1' });
  await client.stopTask(7, { idempotencyKey: 'stop-1' });
  await client.enqueueTask(7, 'generate_article', { idempotencyKey: 'enqueue-1' });
  await client.listTaskJobs(7, { limit: 1 });
  await client.getJob(22);

  assert.equal(calls[0].url, 'https://geo.test/api/v1/tasks/7/start');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { enqueue_now: true });
  assert.equal(new Headers(calls[0].init.headers).get('X-Idempotency-Key'), 'start-1');
  assert.equal(calls[1].url, 'https://geo.test/api/v1/tasks/7/stop');
  assert.equal(calls[2].url, 'https://geo.test/api/v1/tasks/7/enqueue');
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { job_type: 'generate_article' });
  assert.equal(calls[3].url, 'https://geo.test/api/v1/tasks/7/jobs?limit=1');
  assert.equal(calls[4].url, 'https://geo.test/api/v1/jobs/22');
});

test('task monitoring methods use read-only worker and title-readiness endpoints', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ items: [], pagination: { page: 1, per_page: 20, total: 0, total_pages: 0 } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.getTaskWorkers({ page: 2, per_page: 20 });
  await client.getTaskTitleReadiness({
    title_library_id: 4,
    article_limit: 3,
    is_loop: 0,
    status: 'active',
    task_id: 7,
  });

  assert.equal(calls[0].url, 'https://geo.test/api/v1/tasks/workers?page=2&per_page=20');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].url, 'https://geo.test/api/v1/tasks/title-readiness?title_library_id=4&article_limit=3&is_loop=0&status=active&task_id=7');
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(new Headers(calls[0].init.headers).get('X-Idempotency-Key'), null);
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), null);
});

test('task trash projection and restore use the governed lifecycle endpoints', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ items: [{ id: 7, trash_sequence: 12 }], pagination: { page: 1, total: 1 } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.listTrashedTasks({ page: 2, per_page: 10, snapshot_id: 14 });
  await client.restoreTask(7, 12, { idempotencyKey: 'task-restore-1' });

  assert.equal(calls[0].url, 'https://geo.test/api/v1/tasks/trash?page=2&per_page=10&snapshot_id=14');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].url, 'https://geo.test/api/v1/tasks/7/restore');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { trash_sequence: 12 });
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'task-restore-1');
});

test('article quality recheck and optimization lifecycle use governed v1 endpoints', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({
      optimization: {
        run_id: 41,
        status: 'candidate_ready',
        candidate_hash: 'a'.repeat(64),
      },
    });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.articleQualityStatus(9);
  await client.recheckArticleQuality(9, 3, { idempotencyKey: 'quality-recheck-9' });
  await client.startArticleOptimization(9, 'excellent_80', 7, { idempotencyKey: 'optimization-start-9' });
  await client.latestArticleOptimizationCandidate(9);
  await client.articleOptimizationCandidate(9, 41);
  await client.applyArticleOptimization(9, 41, 'a'.repeat(64), { idempotencyKey: 'optimization-apply-9' });
  await client.cancelArticleOptimization(9, 41, { idempotencyKey: 'optimization-cancel-9' });
  await client.rollbackArticleOptimization(9, 41, { idempotencyKey: 'optimization-rollback-9' });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/articles/9/ai-quality/status',
    'https://geo.test/api/v1/articles/9/ai-quality/recheck',
    'https://geo.test/api/v1/articles/9/ai-quality/optimization',
    'https://geo.test/api/v1/articles/9/ai-quality/optimization/candidate',
    'https://geo.test/api/v1/articles/9/ai-quality/optimization/41/candidate',
    'https://geo.test/api/v1/articles/9/ai-quality/optimization/41/apply',
    'https://geo.test/api/v1/articles/9/ai-quality/optimization/41/cancel',
    'https://geo.test/api/v1/articles/9/ai-quality/optimization/41/rollback',
  ]);
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { config_version: 3 });
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), {
    strategy: 'excellent_80',
    optimization_model_id: 7,
  });
  assert.deepEqual(JSON.parse(String(calls[5].init.body)), { candidate_hash: 'a'.repeat(64) });
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'quality-recheck-9');
  assert.equal(new Headers(calls[5].init.headers).get('X-Idempotency-Key'), 'optimization-apply-9');
  assert.equal(new Headers(calls[7].init.headers).get('X-Idempotency-Key'), 'optimization-rollback-9');
});

test('article batch operations use governed endpoints, numeric ids, and idempotency keys', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({
      action: 'publish',
      requested_count: 2,
      succeeded_count: 2,
      failed_count: 0,
      succeeded: [{ article_id: 7, result: {} }, { article_id: 8, result: {} }],
      failed: [],
    });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.batchReviewArticles(['7', 8], { review_status: 'approved' }, { idempotencyKey: 'batch-review-1' });
  await client.batchPublishArticles(['7', 8], { idempotencyKey: 'batch-publish-1' });
  await client.batchTrashArticles([7, '8'], { idempotencyKey: 'batch-trash-1' });
  await client.batchRestoreArticles([7, 8], { idempotencyKey: 'batch-restore-1' });
  // 撤回成草稿（旧后台 batch/update-status 的等价物，补于 2026-09-12）。
  await client.batchUpdateArticleStatus(['7', 8], 'draft', '', { idempotencyKey: 'batch-status-1' });
  await client.batchUpdateArticleStatus([7], 'private', '合规复核已完成', { idempotencyKey: 'batch-status-2' });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/articles/batch/review',
    'https://geo.test/api/v1/articles/batch/publish',
    'https://geo.test/api/v1/articles/batch/trash',
    'https://geo.test/api/v1/articles/batch/restore',
    'https://geo.test/api/v1/articles/batch/status',
    'https://geo.test/api/v1/articles/batch/status',
  ]);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    review_status: 'approved',
    article_ids: [7, 8],
  });
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { article_ids: [7, 8] });
  assert.equal(new Headers(calls[3].init.headers).get('X-Idempotency-Key'), 'batch-restore-1');
  // 没给理由时不能带 risk_override_reason 字段（服务端只在越权放行时才认它）。
  assert.deepEqual(JSON.parse(String(calls[4].init.body)), { article_ids: [7, 8], new_status: 'draft' });
  assert.deepEqual(JSON.parse(String(calls[5].init.body)), {
    article_ids: [7],
    new_status: 'private',
    risk_override_reason: '合规复核已完成',
  });
});

test('URL import lifecycle uses authenticated v1 endpoints and idempotency keys', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ job: { id: 12, status: 'queued' }, result: {}, logs: [] });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.listUrlImports({ page: 2, per_page: 10 });
  await client.createUrlImport({ url: 'https://example.test/docs', outputs: ['knowledge'] }, { idempotencyKey: 'url-create-1' });
  await client.getUrlImport(12);
  await client.runUrlImport('12', { idempotencyKey: 'url-run-12' });
  await client.commitUrlImport(12, { idempotencyKey: 'url-commit-12' });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/url-imports?page=2&per_page=10',
    'https://geo.test/api/v1/url-imports',
    'https://geo.test/api/v1/url-imports/12',
    'https://geo.test/api/v1/url-imports/12/run',
    'https://geo.test/api/v1/url-imports/12/commit',
  ]);
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    url: 'https://example.test/docs',
    outputs: ['knowledge'],
  });
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'url-create-1');
  assert.equal(new Headers(calls[3].init.headers).get('X-Idempotency-Key'), 'url-run-12');
  assert.equal(new Headers(calls[4].init.headers).get('X-Idempotency-Key'), 'url-commit-12');
});

test('URL scan lifecycle uses persisted-report endpoints and markdown export', async () => {
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_STORAGE_KEY, 'scan-token');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith('/url-scans/12/export')) {
      return new Response('# GEO URL 扫描诊断报告', {
        status: 200,
        headers: { 'Content-Type': 'text/markdown; charset=UTF-8' },
      });
    }
    return envelope({
      items: [{ id: 12, url: 'https://example.test/docs', status: 'completed' }],
      pagination: { page: 2, per_page: 10, total: 1, total_pages: 1 },
      scan: {
        id: 12,
        url: 'https://example.test/docs',
        status: 'completed',
        report: { overall_score: 91, grade: 'A' },
      },
    }, { status: 201 });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage });

  await client.listUrlScans({ page: 2, per_page: 10 });
  await client.createUrlScan('https://example.test/docs', { idempotencyKey: 'url-scan-create-1' });
  await client.getUrlScan(12);
  await client.retryUrlScan(12, { idempotencyKey: 'url-scan-retry-12' });
  const report = await client.downloadUrlScanReport(12);

  assert.equal(await report.text(), '# GEO URL 扫描诊断报告');
  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/url-scans?page=2&per_page=10',
    'https://geo.test/api/v1/url-scans',
    'https://geo.test/api/v1/url-scans/12',
    'https://geo.test/api/v1/url-scans/12/retry',
    'https://geo.test/api/v1/url-scans/12/export',
  ]);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(new Headers(calls[0].init.headers).get('X-Idempotency-Key'), null);
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { url: 'https://example.test/docs' });
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'url-scan-create-1');
  assert.equal(calls[2].init.method, 'GET');
  assert.equal(calls[3].init.method, 'POST');
  assert.equal(new Headers(calls[3].init.headers).get('X-Idempotency-Key'), 'url-scan-retry-12');
  assert.equal(calls[4].init.method, 'GET');
  assert.equal(new Headers(calls[4].init.headers).get('Accept'), 'text/markdown');
  assert.equal(new Headers(calls[4].init.headers).get('Authorization'), 'Bearer scan-token');
});

test('task configuration updates and deletion use authenticated write endpoints', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ id: 7, name: '已更新任务' });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.updateTask(7, {
    name: '已更新任务',
    publish_interval: 7200,
    need_review: true,
  }, { idempotencyKey: 'task-update-7' });
  await client.deleteTask(7, { idempotencyKey: 'task-delete-7' });

  assert.equal(calls[0].url, 'https://geo.test/api/v1/tasks/7');
  assert.equal(calls[0].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    name: '已更新任务',
    publish_interval: 7200,
    need_review: true,
  });
  assert.equal(new Headers(calls[0].init.headers).get('X-Idempotency-Key'), 'task-update-7');
  assert.equal(calls[1].url, 'https://geo.test/api/v1/tasks/7');
  assert.equal(calls[1].init.method, 'DELETE');
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'task-delete-7');
});

test('analytics projections use the dedicated v1 read endpoints and preserve filters', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ source: { kind: 'geoflow_database', estimated: false } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.getAnalyticsOverview({ preset: '30d' });
  await client.getAnalyticsContent({ preset: '7d', category_id: 3 });
  await client.getAnalyticsTraffic({ log_preset: '7d', log_source: 'hosted_site' });
  await client.getAnalyticsCrawlers({ preset: '7d' });
  await client.getAiVisibilityAnalytics({ ai_preset: '14d' });
  await client.getDistributionAnalytics({ preset: '30d', distribution_status: 'failed' });
  await client.getLeadAnalytics({ lead_preset: '30d' });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/analytics/overview?preset=30d',
    'https://geo.test/api/v1/analytics/content?preset=7d&category_id=3',
    'https://geo.test/api/v1/analytics/traffic?log_preset=7d&log_source=hosted_site',
    'https://geo.test/api/v1/analytics/crawlers?preset=7d',
    'https://geo.test/api/v1/analytics/ai-visibility?ai_preset=14d',
    'https://geo.test/api/v1/analytics/distribution?preset=30d&distribution_status=failed',
    'https://geo.test/api/v1/analytics/leads?lead_preset=30d',
  ]);
});

test('analytics filters are forwarded with the backend query-parameter names', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ source: { kind: 'geoflow_database', estimated: false } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  // 分析页的五个筛选控件：任务/分类/文章/渠道发给 content 投影，AI 关键词只被
  // ai-visibility 消费（其余端点忽略它，不发也不会报错）。
  await client.getAnalyticsOverview({
    preset: '30d',
    task_id: 11,
    category_id: 22,
    article_id: 33,
    channel_id: 44,
  });
  await client.getAiVisibilityAnalytics({ ai_preset: '60d', ai_keyword: '生成式引擎优化' });
  // 总览页也接受 ai_keyword：`AnalyticsController::overview` 会把它转给 AI 可见度
  // 子投影。控件因此在「总览」与「AI 可见度」两个分区都渲染——否则总览的卡片会被
  // 一个看不见的筛选静默收窄。
  await client.getAnalyticsOverview({ preset: '30d', ai_keyword: '生成式引擎优化' });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/analytics/overview?preset=30d&task_id=11&category_id=22&article_id=33&channel_id=44',
    `https://geo.test/api/v1/analytics/ai-visibility?ai_preset=60d&ai_keyword=${encodeURIComponent('生成式引擎优化')}`,
    `https://geo.test/api/v1/analytics/overview?preset=30d&ai_keyword=${encodeURIComponent('生成式引擎优化')}`,
  ]);
});

test('lead management uses dedicated authenticated CRUD, concurrency and export contracts', async () => {
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_STORAGE_KEY, 'lead-token');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).includes('/leads/export')) {
      return new Response('ID,Form,Status\n1,Contact,new', { status: 200, headers: { 'Content-Type': 'text/csv' } });
    }
    return envelope({ items: [], form: { id: 7 }, lead: { id: 11 }, pagination: { page: 1, total: 0 } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage });

  await client.listLeadForms({ status: 'active', page: 2 });
  await client.getLeadForm(7);
  await client.createLeadForm({ name: 'Contact', fields: [] }, { idempotencyKey: 'lead-form-create-7' });
  await client.updateLeadForm(7, { name: 'Sales', expected_updated_at: 'v1' }, { idempotencyKey: 'lead-form-update-7' });
  await client.setLeadFormStatus(7, 'inactive', 'v2', { idempotencyKey: 'lead-form-status-7' });
  await client.deleteLeadForm(7, 'v3', { idempotencyKey: 'lead-form-delete-7' });
  await client.listLeads({ status: 'new', search: 'alice' });
  await client.getLead(11);
  await client.updateLead(11, { status: 'contacted', note: 'called', expected_updated_at: 'v1' }, { idempotencyKey: 'lead-update-11' });
  const csv = await client.downloadLeadExport({ status: 'new' });

  assert.equal(await csv.text(), 'ID,Form,Status\n1,Contact,new');
  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/lead-forms?status=active&page=2',
    'https://geo.test/api/v1/lead-forms/7',
    'https://geo.test/api/v1/lead-forms',
    'https://geo.test/api/v1/lead-forms/7',
    'https://geo.test/api/v1/lead-forms/7/status',
    'https://geo.test/api/v1/lead-forms/7',
    'https://geo.test/api/v1/leads?status=new&search=alice',
    'https://geo.test/api/v1/leads/11',
    'https://geo.test/api/v1/leads/11',
    'https://geo.test/api/v1/leads/export?status=new',
  ]);
  assert.equal(calls[2].init.method, 'POST');
  assert.equal(new Headers(calls[2].init.headers).get('X-Idempotency-Key'), 'lead-form-create-7');
  assert.equal(calls[3].init.method, 'PATCH');
  assert.equal(calls[4].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[4].init.body)), { status: 'inactive', expected_updated_at: 'v2' });
  assert.equal(calls[5].init.method, 'DELETE');
  assert.deepEqual(JSON.parse(String(calls[5].init.body)), { expected_updated_at: 'v3' });
  assert.equal(calls[8].init.method, 'PATCH');
  assert.equal(new Headers(calls[8].init.headers).get('X-Idempotency-Key'), 'lead-update-11');
  assert.equal(new Headers(calls[9].init.headers).get('Authorization'), 'Bearer lead-token');
  assert.equal(new Headers(calls[9].init.headers).get('Accept'), 'text/csv');
});

test('AI workspace uses authenticated persisted conversation and SSE contracts', async () => {
  const storage = new MemoryStorage();
  storage.setItem(TOKEN_STORAGE_KEY, 'workspace-token');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const conversationId = '0199-aaaa-bbbb-cccc';
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith(`/ai-workspace/conversations/${conversationId}/messages`)) {
      return new Response([
        'event: status\ndata: {"stage":"preparing","label":"准备中"}\n\n',
        'event: delta\ndata: {"content":"真实回答"}\n\n',
        'event: done\ndata: {"message_id":"m1","conversation_title":"任务帮助"}\n\n',
      ].join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-Request-Id': 'stream-rid' } });
    }
    if (url.includes('/ai-workspace/media/9')) {
      return new Response('image-bytes', { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    return envelope({
      runtime_enabled: true,
      ready: true,
      items: [{ id: conversationId, title: '任务帮助' }],
      conversation: { id: conversationId, title: '任务帮助', messages: [] },
      archived: true,
    });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage });

  await client.getAiWorkspaceStatus();
  await client.listAiWorkspaceConversations();
  await client.createAiWorkspaceConversation('任务帮助', { idempotencyKey: 'workspace-create-1' });
  await client.getAiWorkspaceConversation(conversationId, 'cursor-1');
  await client.renameAiWorkspaceConversation(conversationId, '新版标题', { idempotencyKey: 'workspace-rename-1' });
  await client.archiveAiWorkspaceConversation(conversationId, { idempotencyKey: 'workspace-archive-1' });
  await client.streamAiWorkspaceMessage(
    conversationId,
    '如何创建任务？',
    (event) => events.push(event),
    { idempotencyKey: 'workspace-message-1' },
  );
  const image = await client.downloadAiWorkspaceMedia(9);

  assert.equal(await image.text(), 'image-bytes');
  assert.deepEqual(events.map((event) => event.event), ['status', 'delta', 'done']);
  assert.equal(events[1].data.content, '真实回答');
  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/ai-workspace/status',
    'https://geo.test/api/v1/ai-workspace/conversations',
    'https://geo.test/api/v1/ai-workspace/conversations',
    `https://geo.test/api/v1/ai-workspace/conversations/${conversationId}?before=cursor-1`,
    `https://geo.test/api/v1/ai-workspace/conversations/${conversationId}`,
    `https://geo.test/api/v1/ai-workspace/conversations/${conversationId}/archive`,
    `https://geo.test/api/v1/ai-workspace/conversations/${conversationId}/messages`,
    'https://geo.test/api/v1/ai-workspace/media/9?variant=thumbnail',
  ]);
  assert.equal(new Headers(calls[2].init.headers).get('X-Idempotency-Key'), 'workspace-create-1');
  assert.equal(new Headers(calls[6].init.headers).get('Authorization'), 'Bearer workspace-token');
  assert.equal(new Headers(calls[6].init.headers).get('Accept'), 'text/event-stream');
  assert.equal(new Headers(calls[6].init.headers).get('X-Idempotency-Key'), 'workspace-message-1');
  assert.deepEqual(JSON.parse(String(calls[6].init.body)), { prompt: '如何创建任务？' });
  assert.equal(new Headers(calls[7].init.headers).get('Authorization'), 'Bearer workspace-token');
});

test('administrator security projections use the account, token and audit contracts', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({
      admin: { id: 3, username: 'admin', display_name: '管理员', profile_version: 'v' },
      items: [],
      available_scopes: ['account:read'],
      pagination: { page: 1, total: 0 },
    });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.getAdminProfile();
  await client.updateAdminProfile({ profile_version: 'version-1', display_name: '新名称' }, { idempotencyKey: 'profile-update-1' });
  await client.listAdminTokens();
  await client.createAdminToken({ name: '部署令牌', scopes: ['articles:read'] }, { idempotencyKey: 'token-create-1' });
  await client.revokeAdminToken(42, { idempotencyKey: 'token-revoke-42' });
  await client.listAdminActivityLogs({ page: 2, per_page: 20, action: 'api.admin.token.create' });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/admin/profile',
    'https://geo.test/api/v1/admin/profile',
    'https://geo.test/api/v1/admin/tokens',
    'https://geo.test/api/v1/admin/tokens',
    'https://geo.test/api/v1/admin/tokens/42/revoke',
    'https://geo.test/api/v1/admin/activity-logs?page=2&per_page=20&action=api.admin.token.create',
  ]);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].init.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    profile_version: 'version-1',
    display_name: '新名称',
  });
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'profile-update-1');
  assert.equal(calls[3].init.method, 'POST');
  assert.equal(new Headers(calls[3].init.headers).get('X-Idempotency-Key'), 'token-create-1');
  assert.equal(calls[4].init.method, 'POST');
  assert.equal(new Headers(calls[4].init.headers).get('X-Idempotency-Key'), 'token-revoke-42');
  assert.equal(new Headers(calls[5].init.headers).get('X-Idempotency-Key'), null);
});

test('administrator password changes use a narrow PATCH contract and idempotency key', async () => {
  let requestedUrl = '';
  let requestHeaders = new Headers();
  let requestBody: unknown;
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    requestedUrl = String(input);
    requestHeaders = new Headers(init.headers);
    requestBody = JSON.parse(String(init.body));
    return envelope({
      password_updated: true,
      credentials_revoked: true,
      reauth_required: true,
    });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  const result = await client.updateAdminPassword({
    current_password: 'old-password',
    password: 'new-password-123',
    password_confirmation: 'new-password-123',
    role: 'super_admin',
    status: 'active',
  }, { idempotencyKey: 'password-change-1' });

  assert.equal(requestedUrl, 'https://geo.test/api/v1/admin/password');
  assert.equal(requestHeaders.get('X-Idempotency-Key'), 'password-change-1');
  assert.deepEqual(requestBody, {
    current_password: 'old-password',
    password: 'new-password-123',
    password_confirmation: 'new-password-123',
  });
  assert.equal((result as Record<string, unknown>).reauth_required, true);
});

test('administrator account management uses the 桐灼GEO users contract', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ admin: { id: 9, username: 'editor', status: 'active' }, items: [] });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.listAdminUsers();
  await client.getAdminUser(9);
  await client.createAdminUser({ username: 'editor', password: 'password-123', confirm_password: 'password-123', ai_config_mode: 'independent' }, { idempotencyKey: 'admin-create-1' });
  await client.updateAdminUser(9, { username: 'editor', status: 'active' }, { idempotencyKey: 'admin-update-9' });
  await client.toggleAdminUserStatus(9, 'inactive', { idempotencyKey: 'admin-status-9' });
  await client.deleteAdminUser(9, { idempotencyKey: 'admin-delete-9' });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/admin/users',
    'https://geo.test/api/v1/admin/users/9',
    'https://geo.test/api/v1/admin/users',
    'https://geo.test/api/v1/admin/users/9',
    'https://geo.test/api/v1/admin/users/9/status',
    'https://geo.test/api/v1/admin/users/9',
  ]);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[2].init.method, 'POST');
  assert.equal(new Headers(calls[2].init.headers).get('X-Idempotency-Key'), 'admin-create-1');
  assert.equal(calls[3].init.method, 'PATCH');
  assert.equal(new Headers(calls[3].init.headers).get('X-Idempotency-Key'), 'admin-update-9');
  assert.equal(calls[4].init.method, 'POST');
  assert.equal(new Headers(calls[4].init.headers).get('X-Idempotency-Key'), 'admin-status-9');
  assert.equal(calls[5].init.method, 'DELETE');
  assert.equal(new Headers(calls[5].init.headers).get('X-Idempotency-Key'), 'admin-delete-9');
});

test('query radar uses persisted observation, collection and evidence-draft contracts', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ items: [], runs: [], article: { id: 71 } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.getQueryRadar({ days: 30 });
  await client.collectQueryRadar({ query: '企业 GEO', keyword_id: 9 }, { idempotencyKey: 'query-collect-9' });
  await client.generateQueryRadarDraft({ query: '企业 GEO', keyword_id: 9, days: 30 }, { idempotencyKey: 'query-draft-9' });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/ai-research/query-radar?days=30',
    'https://geo.test/api/v1/ai-research/query-radar/collect',
    'https://geo.test/api/v1/ai-research/query-radar/draft',
  ]);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'query-collect-9');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { query: '企业 GEO', keyword_id: 9 });
  assert.equal(calls[2].init.method, 'POST');
  assert.equal(new Headers(calls[2].init.headers).get('X-Idempotency-Key'), 'query-draft-9');
});

test('competitor radar uses persisted projection, config and explicit benchmark query', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return envelope({ competitors: [], blindspots: [], scan: { query: '企业 GEO' } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  await client.getCompetitorRadar({ days: 7 });
  await client.saveCompetitorConfig({ industry: '企业软件', competitors: [{ name: '竞品 A', domains: ['competitor.example.test'] }] }, { idempotencyKey: 'competitor-config-1' });
  await client.benchmarkCompetitorRadar({ query: '企业 GEO', days: 7 }, { idempotencyKey: 'competitor-scan-1' });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/ai-research/competitor?days=7',
    'https://geo.test/api/v1/ai-research/competitor/config',
    'https://geo.test/api/v1/ai-research/competitor/benchmark',
  ]);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'competitor-config-1');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { industry: '企业软件', competitors: [{ name: '竞品 A', domains: ['competitor.example.test'] }] });
  assert.equal(calls[2].init.method, 'POST');
  assert.equal(new Headers(calls[2].init.headers).get('X-Idempotency-Key'), 'competitor-scan-1');
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { query: '企业 GEO', days: 7 });
});

test('article editor assistant reads candidate titles and consumes the generation stream', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const frames = [
    'event: delta\ndata: {"content":"第一段"}\n\n',
    'event: delta\ndata: {"content":"第二段"}\n\n',
    'event: replacement\ndata: {"content":"第一段第二段"}\n\n',
    'event: done\ndata: {}\n\n',
  ];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).includes('/articles/editor/titles')) {
      return envelope({ items: [{ id: 7, title: '候选标题', keyword: '关键词' }], pagination: { page: 1, last_page: 1, total: 1 } });
    }
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        frames.forEach((frame) => controller.enqueue(encoder.encode(frame)));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  const client = new GeoFlowApiClient({ baseUrl: 'https://geo.test/api/v1', fetchImpl, storage: null });

  const titles = await client.listEditorTitles({ usage: 'unused', page: 2 });
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  let streamed = '';
  await client.streamEditorGeneration(
    { title: '标题', keyword: '关键词', knowledge_base_id: 3, prompt_id: 4 },
    (frame) => {
      events.push(frame);
      if (frame.event === 'delta') streamed += String(frame.data.content);
    },
    { idempotencyKey: 'editor-generate-1' },
  );

  assert.equal(titles.items[0].title, '候选标题');
  assert.deepEqual(events.map((event) => event.event), ['delta', 'delta', 'replacement', 'done']);
  assert.equal(streamed, '第一段第二段');
  assert.equal(events[2].data.content, '第一段第二段');
  assert.deepEqual(calls.map((call) => call.url), [
    'https://geo.test/api/v1/articles/editor/titles?usage=unused&page=2',
    'https://geo.test/api/v1/articles/editor/generate',
  ]);
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(new Headers(calls[1].init.headers).get('Accept'), 'text/event-stream');
  assert.equal(new Headers(calls[1].init.headers).get('X-Idempotency-Key'), 'editor-generate-1');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    title: '标题',
    keyword: '关键词',
    knowledge_base_id: 3,
    prompt_id: 4,
  });
});
