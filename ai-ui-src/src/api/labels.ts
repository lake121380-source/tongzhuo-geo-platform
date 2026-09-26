/**
 * API 返回的**枚举值/内部标识** → 界面文案。
 *
 * 为什么单开一个模块：后端在响应里塞的是机器标识（`geoflow_database`、
 * `jiandu_api`），组件里直接 `String(source.kind)` 就会把这些渲染给运营看——
 * 实测数据分析页的卡片右上角真的写着 `geoflow_database`。两个组件
 * （`AnalyticsApiView`、`AiAttributionFunnelView`）都要用同一份映射，
 * 各写一份必然会漂。**凡是"后端标识直接上屏"的地方，都在这里加一条映射。**
 */
import { ApiRecord } from './geoflowClient';

export function asRecord(value: unknown): ApiRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
}

/**
 * 数据来源的人话标签。
 *
 * - `geoflow_database`：本站数据库（本部署自己的采集表）
 * - `jiandu_api`：第三方系统，优先显示响应里带的 `system` 名（如「见度GEO」）
 * - 未知取值：一律回落成「数据来源」，**不把原始标识透出去**
 */
export function dataSourceLabel(source: unknown, lang: 'zh' | 'en' = 'zh'): string {
  const row = asRecord(source);
  const kind = String(row.kind ?? '').trim();
  const system = String(row.system ?? '').trim();
  const zh = lang === 'zh';

  if (kind === 'geoflow_database') return zh ? '本站数据库' : "This site's database";
  if (kind === 'jiandu_api') return system || (zh ? '见度GEO' : 'Jiandu GEO');
  if (system) return system;
  return zh ? '数据来源' : 'Data source';
}

/**
 * API Token 的 scope → 中文名。
 *
 * **必须覆盖后端 `ApiTokenService::getAvailableScopes()` 的全部取值**
 * （`getCliLoginScopes()` 30 个 + `getBrowserClientScopes()` 2 个 = 32 个）。
 * 少了哪一条，前端就会回落成 `analytics:collect` 这种原始标识符直接上屏——
 * 实测「创建 Token」的权限勾选区就是这么中英混排的，运营看不懂。
 * `labels.test.ts` 有守卫：后端加了 scope 而这里没跟，测试会红。
 */
const SCOPE_LABELS: Record<string, string> = {
  'account:read': '账户读取',
  'account:write': '账户修改',
  'analytics:collect': '分析采集',
  'analytics:read': '分析读取',
  'articles:publish': '文章发布',
  'articles:read': '文章读取',
  'articles:write': '文章编辑',
  'audit:read': '审计日志',
  'browser-operations:execute': '浏览器操作执行',
  'browser-operations:read': '浏览器操作读取',
  'catalog:read': '目录读取',
  'distribution:read': '分发读取',
  'distribution:write': '分发管理',
  'jiandu:read': '见度读取',
  'jiandu:write': '见度管理',
  'jobs:read': '执行记录读取',
  'leads:read': '线索读取',
  'leads:write': '线索管理',
  'materials:read': '素材读取',
  'materials:write': '素材管理',
  'models:read': '模型读取',
  'models:write': '模型管理',
  'seo:read': 'SEO 读取',
  'seo:write': 'SEO 修改',
  'system:read': '系统读取',
  'system:write': '系统管理',
  'tasks:read': '任务读取',
  'tasks:write': '任务管理',
  'tokens:read': 'Token 读取',
  'tokens:write': 'Token 管理',
  'workspace:read': 'AI 助手会话读取',
  'workspace:write': 'AI 助手会话管理',
};

/** scope → 中文名；未收录的取值原样返回（**正常不该发生**，见上面守卫）。 */
export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

/** 只给测试用：本模块认得的 scope 全集。 */
export const KNOWN_SCOPES: readonly string[] = Object.freeze(Object.keys(SCOPE_LABELS));

/** `active` / `inactive` 这种「启用-停用」二元状态的中文化（模型、账号、任务都用它）。 */
function activeInactiveLabel(value: unknown, lang: 'zh' | 'en'): string {
  const text = String(value ?? '').trim().toLowerCase();
  const zh = lang === 'zh';
  if (text === 'active') return zh ? '已启用' : 'Active';
  if (text === 'inactive') return zh ? '已停用' : 'Inactive';
  return text ? text : (zh ? '未知' : 'Unknown');
}

/**
 * AI 模型的启用状态。后端的取值只有 `active` / `inactive`（见建模型表单的下拉），
 * 原来详情卡右上角直接打印 `{mod.status}`，界面上就出现了「active」三个字母。
 */
export function modelStatusLabel(status: unknown, lang: 'zh' | 'en' = 'zh'): string {
  return activeInactiveLabel(status, lang);
}

/** 管理员账号状态（启用/停用）。 */
export function adminStatusLabel(status: unknown, lang: 'zh' | 'en' = 'zh'): string {
  return activeInactiveLabel(status, lang);
}

/**
 * 管理员角色。`superadmin` 是历史拼法，服务端 `Admin::isSuperAdmin()` 两种都认
 * （见 `App.tsx` 的 `isSuperAdminRole`），界面上要归到同一档。
 */
export function adminRoleLabel(role: unknown, lang: 'zh' | 'en' = 'zh'): string {
  const value = String(role ?? '').trim().toLowerCase();
  const zh = lang === 'zh';
  if (value === 'super_admin' || value === 'superadmin') return zh ? '超级管理员' : 'Super admin';
  if (value === 'admin') return zh ? '管理员' : 'Admin';
  return String(role ?? '').trim() || (zh ? '未知' : 'Unknown');
}

/** 「受控词表 → 中文」的通用查找：没收录的取值原样返回，不编。 */
function lookup(table: Record<string, { zh: string; en: string }>, value: unknown, lang: 'zh' | 'en'): string {
  const key = String(value ?? '').trim().toLowerCase();
  const hit = table[key];
  if (hit) return lang === 'zh' ? hit.zh : hit.en;
  return String(value ?? '').trim() || (lang === 'zh' ? '未知' : 'Unknown');
}

/** 提示词类型（`prompts.type`）。 */
const PROMPT_TYPES: Record<string, { zh: string; en: string }> = {
  content: { zh: '生成正文', en: 'Content generation' },
  quality_check: { zh: '质检判定', en: 'Quality check' },
};
export function promptTypeLabel(value: unknown, lang: 'zh' | 'en' = 'zh'): string {
  return lookup(PROMPT_TYPES, value, lang);
}

/** 原子事实的值类型（`facts.value_type`）——原来是 `string` / `boolean` 直接上屏。 */
const FACT_VALUE_TYPES: Record<string, { zh: string; en: string }> = {
  string: { zh: '文本', en: 'Text' },
  integer: { zh: '整数', en: 'Integer' },
  decimal: { zh: '小数', en: 'Decimal' },
  date: { zh: '日期', en: 'Date' },
  boolean: { zh: '是 / 否', en: 'Yes / no' },
  url: { zh: '链接', en: 'URL' },
};
export function factValueTypeLabel(value: unknown, lang: 'zh' | 'en' = 'zh'): string {
  return lookup(FACT_VALUE_TYPES, value, lang);
}

/**
 * 系统更新器的就绪状态（后端 `SystemUpdaterBridgeService` 的 `readiness()`，
 * 取值只有这五个：ready / not_installed / installation_pending /
 * attention_required / authorization_pending）。
 */
const UPDATER_READINESS: Record<string, { zh: string; en: string }> = {
  ready: { zh: '已就绪', en: 'Ready' },
  not_installed: { zh: '未安装', en: 'Not installed' },
  installation_pending: { zh: '待安装', en: 'Installation pending' },
  attention_required: { zh: '需要处理', en: 'Attention required' },
  authorization_pending: { zh: '待授权', en: 'Authorization pending' },
};
export function updaterReadinessLabel(value: unknown, lang: 'zh' | 'en' = 'zh'): string {
  return lookup(UPDATER_READINESS, value, lang);
}

/** 更新器与代理的连接状态。 */
const UPDATER_CONNECTIONS: Record<string, { zh: string; en: string }> = {
  connected: { zh: '已连接', en: 'Connected' },
  degraded: { zh: '连接降级', en: 'Degraded' },
  disconnected: { zh: '未连接', en: 'Disconnected' },
};
export function updaterConnectionLabel(value: unknown, lang: 'zh' | 'en' = 'zh'): string {
  return lookup(UPDATER_CONNECTIONS, value, lang);
}

/** 更新器自检（Doctor）结果。 */
const UPDATER_DOCTOR: Record<string, { zh: string; en: string }> = {
  pass: { zh: '正常', en: 'Pass' },
  warn: { zh: '有警告', en: 'Warning' },
  fail: { zh: '未通过', en: 'Failed' },
  unavailable: { zh: '取不到', en: 'Unavailable' },
};
export function updaterDoctorLabel(value: unknown, lang: 'zh' | 'en' = 'zh'): string {
  return lookup(UPDATER_DOCTOR, value, lang);
}

/**
 * 首页预设 id（`homepage.presets[].id`）。这五个是站点设置里「选择首页预设」下拉的选项，
 * 原来直接显示英文标识符。
 */
const HOMEPAGE_PRESETS: Record<string, { zh: string; en: string }> = {
  enterprise_brand: { zh: '企业品牌首页', en: 'Enterprise brand' },
  content_portal: { zh: '内容门户首页', en: 'Content portal' },
  service_solution: { zh: '服务方案首页', en: 'Service & solutions' },
  report_hub: { zh: '报告聚合首页', en: 'Report hub' },
  product_launch: { zh: '产品发布首页', en: 'Product launch' },
};
export function homepagePresetLabel(value: unknown, lang: 'zh' | 'en' = 'zh'): string {
  return lookup(HOMEPAGE_PRESETS, value, lang);
}

/**
 * 知识媒体资产的字段名。这些是**表字段**，原来直接当表单占位符用
 * （`placeholder={field}` → 输入框里写着 `asset_key`）。
 */
const MEDIA_FIELDS: Record<string, { zh: string; en: string }> = {
  asset_key: { zh: '资源标识（给机器读，如 help-media-01）', en: 'Asset key (machine-readable)' },
  section_key: { zh: '章节标识（挂在帮助页的哪一节）', en: 'Section key' },
  route_name: { zh: '后台入口路径（如 /geo_admin?tab=articles）', en: 'Admin route (e.g. /geo_admin?tab=articles)' },
  title: { zh: '标题', en: 'Title' },
  alt_text: { zh: '替代文字（读屏与 AI 用）', en: 'Alt text' },
  caption: { zh: '图注', en: 'Caption' },
};
export function mediaFieldLabel(field: unknown, lang: 'zh' | 'en' = 'zh'): string {
  return lookup(MEDIA_FIELDS, field, lang);
}
