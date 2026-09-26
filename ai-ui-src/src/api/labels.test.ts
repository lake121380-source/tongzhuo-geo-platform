import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KNOWN_SCOPES, adminRoleLabel, adminStatusLabel, dataSourceLabel, factValueTypeLabel,
  homepagePresetLabel, mediaFieldLabel, modelStatusLabel, promptTypeLabel, scopeLabel,
  updaterConnectionLabel, updaterDoctorLabel, updaterReadinessLabel,
} from './labels';

/**
 * 后端 `ApiTokenService` 当前发放的 scope 全集（`getCliLoginScopes()` +
 * `getBrowserClientScopes()`）。**这份清单是抄的，不是算的**——它就是要能在
 * 后端悄悄加了一个 scope 而前端标签没跟的时候红掉。
 * 抄错了/后端改了：去 `app/Services/Api/ApiTokenService.php` 核对后同步这里和 `labels.ts`。
 */
const BACKEND_SCOPES = [
  'catalog:read',
  'models:read', 'models:write',
  'seo:read', 'seo:write',
  'tasks:read', 'tasks:write',
  'jobs:read',
  'articles:read', 'articles:write', 'articles:publish',
  'materials:read', 'materials:write',
  'distribution:read', 'distribution:write',
  'analytics:read', 'analytics:collect',
  'jiandu:read', 'jiandu:write',
  'leads:read', 'leads:write',
  'workspace:read', 'workspace:write',
  'system:read', 'system:write',
  'account:read', 'account:write',
  'tokens:read', 'tokens:write',
  'audit:read',
  'browser-operations:read', 'browser-operations:execute',
];

test('每个后端 scope 都有中文名（缺了就回落成原始标识符上屏）', () => {
  const missing = BACKEND_SCOPES.filter((scope) => scopeLabel(scope) === scope);
  assert.deepEqual(missing, [], `这些 scope 没有中文名，界面上会显示成 ${missing[0] ?? ''}`);
});

test('标签表里没有后端已经不发的多余 scope', () => {
  const stale = KNOWN_SCOPES.filter((scope) => !BACKEND_SCOPES.includes(scope));
  assert.deepEqual(stale, [], `后端已不再发放这些 scope，标签表可以清理：${stale.join(', ')}`);
});

test('未收录的 scope 原样返回，不编造中文名', () => {
  assert.equal(scopeLabel('brand-new:scope'), 'brand-new:scope');
});

test('数据来源永远不把内部标识透给用户', () => {
  for (const lang of ['zh', 'en'] as const) {
    const database = dataSourceLabel({ kind: 'geoflow_database' }, lang);
    assert.ok(!database.includes('geoflow_database'), `本站数据库的来源标签漏了原始标识：${database}`);
    assert.ok(!dataSourceLabel({ kind: 'jiandu_api' }, lang).includes('jiandu_api'));
    // 完全不认识的结构也不能把 undefined / [object Object] 画上屏
    for (const weird of [null, undefined, {}, 'geoflow_database', 42]) {
      const text = dataSourceLabel(weird, lang);
      assert.ok(text.length > 0 && !text.includes('undefined'), `异常来源渲染成了「${text}」`);
    }
  }
  // 第三方系统优先显示它自报的名字
  assert.equal(dataSourceLabel({ kind: 'jiandu_api', system: '见度GEO' }, 'zh'), '见度GEO');
});

test('模型状态不打印英文枚举', () => {
  // 建模型表单的下拉只有这两个取值；多出来的取值原样返回好过编一个中文名
  assert.equal(modelStatusLabel('active', 'zh'), '已启用');
  assert.equal(modelStatusLabel('inactive', 'zh'), '已停用');
  assert.equal(modelStatusLabel('active', 'en'), 'Active');
  assert.equal(modelStatusLabel('ACTIVE', 'zh'), '已启用', '大小写不该影响识别');
  assert.equal(modelStatusLabel('maintenance', 'zh'), 'maintenance');
  assert.equal(modelStatusLabel(null, 'zh'), '未知');
});

test('管理员角色两种历史拼法归到同一档', () => {
  assert.equal(adminRoleLabel('super_admin', 'zh'), '超级管理员');
  assert.equal(adminRoleLabel('superadmin', 'zh'), '超级管理员', '历史拼法不能掉回英文');
  assert.equal(adminRoleLabel('admin', 'zh'), '管理员');
  assert.equal(adminRoleLabel('super_admin', 'en'), 'Super admin');
  assert.equal(adminRoleLabel('auditor', 'zh'), 'auditor', '没见过的角色原样返回，不编');
});

test('账号状态中文化，且与模型状态同一套口径', () => {
  assert.equal(adminStatusLabel('active', 'zh'), '已启用');
  assert.equal(adminStatusLabel('inactive', 'zh'), '已停用');
  assert.equal(adminStatusLabel(null, 'zh'), '未知');
});

/**
 * 后端 `SystemUpdaterBridgeService::readiness()` 的取值全集。
 * 抄自 `app/Services/Admin/SystemUpdaterBridgeService.php`——正是要能在后端加了状态
 * 而前端没跟的时候红掉。
 */
const UPDATER_READINESS_VALUES = [
  'ready', 'not_installed', 'installation_pending', 'attention_required', 'authorization_pending',
];

test('更新器的每个就绪状态都有中文名', () => {
  const missing = UPDATER_READINESS_VALUES.filter((value) => updaterReadinessLabel(value, 'zh') === value);
  assert.deepEqual(missing, [], `这些状态没有中文名：${missing.join(', ')}`);
  for (const value of UPDATER_READINESS_VALUES) {
    assert.ok(!/^[a-z_]+$/.test(updaterReadinessLabel(value, 'zh')), `${value} 仍然渲染成英文标识符`);
    assert.ok(updaterReadinessLabel(value, 'en').length > 0);
  }
});

test('连接状态与自检结果都中文化', () => {
  for (const value of ['connected', 'degraded', 'disconnected']) {
    assert.ok(!/^[a-z_]+$/.test(updaterConnectionLabel(value, 'zh')), `连接状态 ${value} 没翻译`);
  }
  for (const value of ['pass', 'warn', 'fail', 'unavailable']) {
    assert.ok(!/^[a-z_]+$/.test(updaterDoctorLabel(value, 'zh')), `自检结果 ${value} 没翻译`);
  }
});

test('提示词类型与事实值类型都中文化', () => {
  assert.equal(promptTypeLabel('content', 'zh'), '生成正文');
  assert.equal(promptTypeLabel('quality_check', 'zh'), '质检判定');
  for (const value of ['string', 'integer', 'decimal', 'date', 'boolean', 'url']) {
    assert.ok(!/^[a-z_]+$/.test(factValueTypeLabel(value, 'zh')), `值类型 ${value} 没翻译`);
  }
});

test('首页预设与媒体字段名都中文化', () => {
  for (const value of ['enterprise_brand', 'content_portal', 'service_solution', 'report_hub', 'product_launch']) {
    assert.ok(!/^[a-z_]+$/.test(homepagePresetLabel(value, 'zh')), `预设 ${value} 没翻译`);
  }
  for (const field of ['asset_key', 'section_key', 'route_name', 'title', 'alt_text', 'caption']) {
    assert.ok(!/^[a-z_]+$/.test(mediaFieldLabel(field, 'zh')), `媒体字段 ${field} 没翻译`);
  }
});

test('未收录的取值原样返回，不编中文名', () => {
  assert.equal(updaterReadinessLabel('brand_new_state', 'zh'), 'brand_new_state');
  assert.equal(promptTypeLabel('something_else', 'zh'), 'something_else');
  assert.equal(homepagePresetLabel('mystery_preset', 'zh'), 'mystery_preset');
  assert.equal(mediaFieldLabel('unknown_field', 'zh'), 'unknown_field');
});
