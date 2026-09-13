/**
 * 后台页签的**权威清单**与 URL 深链。
 *
 * 为什么需要它：旧 Blade 后台退役前，AI 助手的「该去哪个页面」用的是 **Laravel 路由名**
 * （`admin.tasks.index` 这类）。旧后台删掉后那些名字不存在了，助手也就指不出页面
 * （`AdminHelpKnowledgeCatalog` 的 20 条入口全被过滤、`CapabilityManifest` 的
 * `route_patterns` 全部失效）。React 后台是 SPA、页面由页签 id 决定、**原先不从 URL 读**，
 * 所以没有天然的落点。这里补上：`/geo_admin?tab=<id>` 成为可引用的入口。
 *
 * 后端 `CapabilityManifest` / `AdminHelpKnowledgeCatalog` 里的路径就是按这个格式写的，
 * **两边要一起改**（与 `protected_paths` 的教训相同：不同步就会出现错位）。
 */
export const ADMIN_TABS = [
  'seo_dashboard',
  'seo_foundation',
  'robots_policy',
  'brand_entity',
  'url_scanner',
  'dashboard',
  'ai-workspace',
  'generator',
  'articles',
  'llmstxt',
  'knowledge',
  'materials',
  'tasks',
  'distribution',
  'manual-publications',
  'attribution_funnel',
  'query_radar',
  'competitor',
  'sandbox',
  'analytics',
  'leads',
  'ai-models',
  'admin-settings',
  'system-updates',
  'preview',
] as const;

export type AdminTab = (typeof ADMIN_TABS)[number];

const TAB_SET = new Set<string>(ADMIN_TABS);

/** 后台入口路径。AI 助手返回的「站内入口」都用它。 */
export const ADMIN_BASE_PATH = '/geo_admin';

export function tabPath(tab: string): string {
  return `${ADMIN_BASE_PATH}?tab=${tab}`;
}

/** 只认已知页签；未知值一律回落默认页，避免深链把界面带成空白。 */
export function normalizeTab(value: unknown, fallback = 'dashboard'): string {
  return typeof value === 'string' && TAB_SET.has(value) ? value : fallback;
}

export function readTabFromUrl(search?: string): string {
  const raw = search === undefined ? (typeof window !== 'undefined' ? window.location.search : '') : search;
  try {
    return normalizeTab(new URLSearchParams(raw).get('tab'));
  } catch {
    return 'dashboard';
  }
}

/**
 * 把当前页签写回地址栏（`replaceState`，不制造历史记录）。
 * 这样「复制地址发给同事」和 AI 助手返回的链接都能落到具体页面。
 */
export function writeTabToUrl(tab: string): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('tab') === tab) return;
    url.searchParams.set('tab', tab);
    window.history.replaceState({}, '', url);
  } catch {
    // 地址栏更新失败不影响本次会话的页签切换，忽略。
  }
}
