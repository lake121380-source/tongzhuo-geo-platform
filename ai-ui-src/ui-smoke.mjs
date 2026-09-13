#!/usr/bin/env node
/**
 * 桐灼 GEO 后台 —— 真·UI 冒烟测试（点击驱动）
 *
 * 为什么要有它：仓库里原来的 `smoke-test.cjs` 是纯 HTTP 断言，且打的是**已被删除的
 * Express 演示服务**（`127.0.0.1:3000` + `/api/*`），实测 19/19 全失败却无人察觉；
 * 更要命的是它**一次 UI 点击都没有**，所以「写文章页写死第一个标题库」「保存按钮点了
 * 没反应」「没有加载态」这类问题它一个都发现不了——而 2026-09-13 那次人工走查发现的
 * 10 个问题里有 6 个只有点界面才能发现。
 *
 * 这个脚本用 Playwright 驱动**本机 Chrome**，只通过「点击 + 填表」操作界面，
 * 逐条断言，失败即以非零码退出。
 *
 * 用法：
 *   node ui-smoke.mjs                          # 默认打 http://localhost:18081
 *   BASE_URL=http://localhost:18080 node ui-smoke.mjs
 *   HEADED=1 node ui-smoke.mjs                 # 想看它自己点就在有头模式跑
 *
 * 凭据：从 `../geoflow-src/.env` 读 `GEOFLOW_ADMIN_PASSWORD`（用户名固定 admin）。
 *      密码不会被打印。
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || 'http://localhost:18081';
const ADMIN_PATH = `${BASE_URL}/geo_admin`;
const HEADLESS = process.env.HEADED !== '1';

/** 读管理员密码：只从 .env 取，不打印、不落盘。 */
function readAdminPassword() {
  const envPath = path.resolve(__dirname, '../geoflow-src/.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`找不到 ${envPath}，无法读取 GEOFLOW_ADMIN_PASSWORD`);
  }
  const match = fs.readFileSync(envPath, 'utf8').match(/^GEOFLOW_ADMIN_PASSWORD=(.*)$/m);
  if (!match || !match[1].trim()) {
    throw new Error('geoflow-src/.env 里没有 GEOFLOW_ADMIN_PASSWORD');
  }
  return match[1].trim().replace(/^["']|["']$/g, '');
}

/** 期望的一级导航（顺序即断言顺序）。2026-09-13：AI 助手从「设置」里提出来，紧跟总览。 */
const TOP_LEVEL_NAV = ['总览', 'AI 助手', 'GEO 诊断', '内容中心', '发布中心', 'GEO 效果', '设置'];

/** 曾经在侧边栏出现过的静态副标签，重构后必须一个都不剩。 */
const FORBIDDEN_BADGES = ['聚合', '核心', 'Schema', 'Spec', '资产', '闭环', '权限', '运维'];

/** 二级入口（点开分组后应能找到），用于逐个点开验证。 */
const SUB_NAV_ITEMS = [
  '品牌实体', 'SEO 总览', '页面体检', '站点 SEO', '爬虫策略', 'llms.txt',
  '写文章', '文章与审核', '知识库', '素材库',
  '分发渠道', '生成任务', '手动发布',
  'AI 问答监测', '竞品对比', '引用测试', '数据分析', 'AI 引流与转化', '线索',
  'AI 模型与提示词', '系统设置', '备份与更新', '站点预览', 'AI 助手',
];

const results = [];
const consoleErrors = [];
/** 4xx/5xx 响应（带 URL，便于按已知可忽略项过滤）。 */
const badResponses = [];

/** 已知按设计返回 404 的端点：托管站点功能默认关闭，中间件故意返 404 隐藏接口面。 */
const IGNORABLE_BAD_URL = /distribution\/hosted-sites/;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${mark} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}

/** 等到「首次加载遮罩」消失（应用启动会挡住整个外壳）。 */
async function waitForAppReady(page, timeout = 40000) {
  await page.waitForFunction(
    () => {
      const body = document.body.innerText || '';
      return !body.includes('正在从后端读取') && !!document.querySelector('aside');
    },
    { timeout },
  );
}

/** 侧边栏当前高亮的入口文案（用于断言「点谁亮谁」）。 */
async function activeNavLabel(page) {
  return page.evaluate(() => {
    const aside = document.querySelector('aside');
    if (!aside) return null;
    const active = [...aside.querySelectorAll('button')].find((b) => b.className.includes('bg-indigo-600'));
    return active ? active.innerText.trim().replace(/\s+/g, ' ').slice(0, 16) : null;
  });
}

/** 点侧边栏里的某一项（必要时先展开分组）。返回是否点到。 */
async function clickNavItem(page, label) {
  // 先展开全部分组
  await page.evaluate(() => {
    const aside = document.querySelector('aside');
    if (!aside) return;
    [...aside.querySelectorAll('button[aria-expanded="false"]')].forEach((b) => b.click());
  });
  await page.waitForTimeout(250);

  const clicked = await page.evaluate((text) => {
    const aside = document.querySelector('aside');
    if (!aside) return false;
    const target = [...aside.querySelectorAll('button')].find((b) => b.innerText.trim().startsWith(text));
    if (!target) return false;
    target.click();
    return true;
  }, label);
  if (!clicked) return false;

  // 等「高亮项 == 被点项」
  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(200);
    const active = await activeNavLabel(page);
    if (active && active.startsWith(label.slice(0, 4))) return true;
  }
  return false;
}

async function main() {
  const password = readAdminPassword();
  console.log(`\n桐灼GEO 后台 UI 冒烟测试\n目标: ${ADMIN_PATH}\n${'='.repeat(56)}`);

  const browser = await chromium.launch({ channel: 'chrome', headless: HEADLESS });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 160));
  });
  page.on('response', (res) => {
    if (res.status() >= 400) badResponses.push(`${res.status()} ${res.url()}`);
  });

  try {
    // ── 1. 登录（真实填表，不走 API 捷径）────────────────────────────
    await page.goto(ADMIN_PATH, { waitUntil: 'domcontentloaded', timeout: 40000 });
    const hasLoginForm = await page.locator('#geoflow-username').count();
    record('打开后台出现登录表单', hasLoginForm > 0);

    if (hasLoginForm > 0) {
      await page.fill('#geoflow-username', 'admin');
      await page.fill('#geoflow-password', password);
      await page.click('button[type="submit"]');
      try {
        await waitForAppReady(page);
        record('登录成功并进入后台', true);
      } catch {
        record('登录成功并进入后台', false, '40 秒内未进入后台');
      }
    }

    // ── 2. 侧边栏结构 ──────────────────────────────────────────────
    const navLabels = await page.evaluate(() => {
      const aside = document.querySelector('aside');
      if (!aside) return [];
      // 一级入口 = 带 aria-expanded 的分组头，或「总览 / AI 助手」这两个单页入口
      const SINGLE_PAGE = ['总览', 'AI 助手'];
      return [...aside.querySelectorAll('button')]
        .filter((b) => b.getAttribute('aria-expanded') !== null || SINGLE_PAGE.includes(b.innerText.trim()))
        .map((b) => b.innerText.trim().replace(/\s+/g, ' ').replace(/[▾▸]/g, '').trim());
    });
    record(
      `一级导航正好 ${TOP_LEVEL_NAV.length} 个`,
      navLabels.length === TOP_LEVEL_NAV.length,
      `实际 ${navLabels.length} 个: ${navLabels.join(' / ')}`,
    );
    record('一级导航文案与预期一致', TOP_LEVEL_NAV.every((l) => navLabels.includes(l)));

    const sidebarText = await page.evaluate(() => (document.querySelector('aside')?.innerText || ''));
    const leftover = FORBIDDEN_BADGES.filter((b) => sidebarText.includes(b));
    record('侧边栏已无静态副标签', leftover.length === 0, leftover.length ? `残留: ${leftover.join(',')}` : '');

    // ── 3. 逐个点开二级入口 ────────────────────────────────────────
    let navOk = 0;
    const navFailed = [];
    for (const label of SUB_NAV_ITEMS) {
      const ok = await clickNavItem(page, label);
      if (ok) navOk += 1;
      else navFailed.push(label);
    }
    record(
      `二级入口全部可点开（${navOk}/${SUB_NAV_ITEMS.length}）`,
      navFailed.length === 0,
      navFailed.length ? `失败: ${navFailed.join(',')}` : '',
    );

    // ── 4. 关键 CTA：总览「去审核」─────────────────────────────────
    await clickNavItem(page, '总览');
    await page.waitForTimeout(1200);
    const ctaClicked = await page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      const btn = [...main.querySelectorAll('button')].find((b) => b.innerText.trim() === '去审核');
      if (!btn) return null;
      btn.click();
      return true;
    });
    if (ctaClicked) {
      await page.waitForTimeout(2500);
      const url = page.url();
      record('总览「去审核」能跳到文章页', url.includes('tab=articles'), url.split('?')[1] || url);
    } else {
      record('总览「去审核」按钮存在', false);
    }

    // ── 5. 写文章页应显示标题库前置条件 ─────────────────────────────
    await clickNavItem(page, '写文章');
    await page.waitForTimeout(2500);
    const generatorText = await page.evaluate(() => (document.querySelector('main')?.innerText || ''));
    record('写文章页显示所用标题库', /标题库/.test(generatorText));
    record(
      '写文章页可切换标题库（下拉存在）',
      await page.evaluate(() => !!document.querySelector('main select')),
    );

    // ── 6. 失败请求（按 URL 过滤掉已知可忽略项）──────────────────────
    const realBad = badResponses.filter((entry) => !IGNORABLE_BAD_URL.test(entry));
    const dedupedBad = [...new Set(realBad.map((e) => e.replace(/\?.*$/, '')))];
    record(
      '无未预期的失败请求',
      dedupedBad.length === 0,
      dedupedBad.slice(0, 4).join(' | '),
    );
  } catch (error) {
    record('测试执行未抛异常', false, error.message.split('\n')[0]);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('='.repeat(56));
  console.log(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (consoleErrors.length) {
    console.log(`\n（参考）浏览器控制台错误 ${consoleErrors.length} 条，前 3 条：`);
    consoleErrors.slice(0, 3).forEach((e) => console.log(`  · ${e}`));
  }
  if (failed.length) {
    console.log('\n失败项：');
    failed.forEach((f) => console.log(`  ✗ ${f.name}${f.detail ? `  (${f.detail})` : ''}`));
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('冒烟测试自身出错：', error.message);
  process.exit(1);
});
