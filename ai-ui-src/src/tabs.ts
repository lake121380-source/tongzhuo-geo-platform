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
  'brand_entity',
  'url_scanner',
  'dashboard',
  'ai-workspace',
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
  // ⚠️ 下面两个**不在侧边栏里**（2026-09-13 入口收敛后只留「站点与品牌设置」一个入口），
  // 但仍是**有效的深链页签**：它们打开的是同一个 SeoConfigurationView 的不同默认页签
  // （robots / llms）。保留它们，是为了让既有深链（书签、AI 助手回复里的入口、
  // 后端 AdminTabs/帮助目录里硬编码的路径）保持原有保真度。
  // **每条 id 都必须在 App.tsx 里真的有一条渲染分支**——少了就是「深链进来空白页」。
  'robots_policy',
] as const;

export type AdminTab = (typeof ADMIN_TABS)[number];

const TAB_SET = new Set<string>(ADMIN_TABS);

/** 后台入口路径。AI 助手返回的「站内入口」都用它。 */
export const ADMIN_BASE_PATH = '/geo_admin';

export function tabPath(tab: string): string {
  return `${ADMIN_BASE_PATH}?tab=${tab}`;
}

/** 已撤销的页签别名：历史深链仍然可点，落到合并后的页面。 */
const LEGACY_TAB_ALIASES: Record<string, string> = {
  generator: 'articles', // 「写文章」已并入「文章」，旧链接落到文章页
};

/**
 * 合并入口的子页签 → { 宿主页签, 内层视图 }（Design System · D1 入口收敛）。
 *
 * 背景：这些页面**后端同源、说的是同一件事**，却在侧栏占着多个入口（用户要猜该进哪个）：
 *   - 竞品对比 / 引用测试 与「AI 问答监测」同走 `AiResearchController`
 *   - 线索 与「AI 引流与转化」都是"AI 带来的访问有没有变成客户"
 *   - 页面体检 与「SEO 总览」都是"检查"，品牌实体 与「站点 SEO」都是"配置"
 *
 * **注意这是"入口收敛"而不是"删页面"**：下面这些 id **仍在 `ADMIN_TABS` 里、仍然可深链**，
 * 打开的就是同一个页面（只是内层视图不同），侧栏高亮落在宿主入口上。
 * 后端 `AdminTabs` / 帮助目录 / `AdminHelpRouteCoverageTest` 因此**一行都不用改**。
 */
export const MERGED_VIEWS: Record<string, { host: string; view: string }> = {
  competitor: { host: 'query_radar', view: 'competitor' },
  sandbox: { host: 'query_radar', view: 'sandbox' },
  leads: { host: 'attribution_funnel', view: 'leads' },
  url_scanner: { host: 'seo_dashboard', view: 'scanner' },
  brand_entity: { host: 'seo_foundation', view: 'brand' },
};

/** 宿主页签的默认内层视图（直接进 `?tab=<宿主>` 时显示哪个）。 */
export const HOST_DEFAULT_VIEW: Record<string, string> = {
  query_radar: 'query_radar',
  attribution_funnel: 'funnel',
  seo_dashboard: 'overview',
  seo_foundation: 'site',
};

/** 该页签属于哪个"页面"（合并子页签返回宿主，其它原样返回）。 */
export function hostTabOf(tab: string): string {
  return MERGED_VIEWS[tab]?.host ?? tab;
}

/** 该页签默认应显示的内层视图（子页签→对应视图；宿主→默认视图；其它→null）。 */
export function defaultViewOf(tab: string): string | null {
  const merged = MERGED_VIEWS[tab];
  if (merged) return merged.view;
  return HOST_DEFAULT_VIEW[tab] ?? null;
}

/** 从地址栏读内层视图（`?view=`）。只做字符串透传；合法性由宿主页面自己判断。 */
export function readViewFromUrl(search?: string): string | null {
  const raw = search === undefined ? (typeof window !== 'undefined' ? window.location.search : '') : search;
  try {
    const value = new URLSearchParams(raw).get('view');
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/** 只认已知页签；未知值一律回落默认页，避免深链把界面带成空白。 */
export function normalizeTab(value: unknown, fallback = 'dashboard'): string {
  if (typeof value !== 'string') return fallback;
  const resolved = LEGACY_TAB_ALIASES[value] ?? value;
  return TAB_SET.has(resolved) ? resolved : fallback;
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
 * 把当前位置写回地址栏（`replaceState`，不制造历史记录）。
 *
 * 合并入口统一写成 **宿主页签 + 内层视图**（`?tab=query_radar&view=competitor`）——
 * 这样"复制地址发给同事"落到的是同一个子视图，而不是宿主页的第一个 Tab。
 * 非合并页签不写 `view`（保持地址干净）。
 */
export function writeNavToUrl(tab: string, view: string | null): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  try {
    const host = hostTabOf(tab);
    const url = new URL(window.location.href);
    const isMergedHost = host in HOST_DEFAULT_VIEW;
    const nextView = isMergedHost ? (view ?? defaultViewOf(tab) ?? null) : null;
    if (url.searchParams.get('tab') === host && (url.searchParams.get('view') ?? null) === nextView) return;
    url.searchParams.set('tab', host);
    if (nextView) url.searchParams.set('view', nextView);
    else url.searchParams.delete('view');
    window.history.replaceState({}, '', url);
  } catch {
    // 地址栏更新失败不影响本次会话的页签切换，忽略。
  }
}

/**
 * 把当前页签写回地址栏（兼容旧调用点：只写 tab，不带合并视图）。
 * @deprecated 新代码用 `writeNavToUrl(tab, view)`。
 */
export function writeTabToUrl(tab: string): void {
  writeNavToUrl(tab, null);
}
