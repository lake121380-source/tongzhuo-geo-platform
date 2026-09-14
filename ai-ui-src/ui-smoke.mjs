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

/**
 * 必现的一级导航。
 * AI 助手不在这里——它是**特性开关**控制的可选入口
 * （`GEOFLOW_AI_WORKSPACE_RUNTIME_ENABLED`，生产默认关，关掉时导航不渲染）。
 * 把它当成必现项会让这套冒烟测试在任何「关掉助手的部署」上假红。
 * 它的可见性单独断言（见 `AI 助手入口与开关一致`），判据取自后端开关本身。
 */
const REQUIRED_TOP_LEVEL = ['工作台', 'GEO 诊断', '内容中心', '发布中心', 'GEO 效果', '设置'];
const OPTIONAL_TOP_LEVEL = ['AI 助手'];

/** 曾经在侧边栏出现过的静态副标签，重构后必须一个都不剩。 */
const FORBIDDEN_BADGES = ['聚合', '核心', 'Schema', 'Spec', '资产', '闭环', '权限', '运维'];

/**
 * 二级入口（点开分组后应能找到），用于逐个点开验证。
 * `AI 助手` 不在这里——它是**一级**入口（2026-09-13 从「设置」里提出来的），
 * 而且受特性开关控制；把它混进这个「必须点得开」的清单，等于要求它必现。
 *
 * 「竞品对比 / 引用测试 / 线索 / 页面体检 / 品牌实体」也不在这里——2026-09-13 的
 * 「入口收敛」把它们并进了四个合并入口（AI 引用监测 / 转化与线索 / 可发现性总览 /
 * 站点与品牌设置），但**页签与深链全部保留**。老深链的落点单独断言（见 MERGED_DEEPLINKS）。
 */
const SUB_NAV_ITEMS = [
  // 内容中心
  '写文章', '文章与审核', '知识库', '素材库',
  // 发布中心
  '分发渠道', '手动发布',
  // GEO 效果
  'AI 引用监测', '数据分析', '转化与线索',
  // GEO 诊断
  '可发现性总览', '站点与品牌设置',
  // 设置
  'AI 模型与提示词', '系统设置', '备份与更新', '站点预览',
];

/**
 * 合并入口的深链矩阵：老 tab id 必须仍然可用，且**侧栏高亮落在合并后的入口**上。
 * `expectTab/view` 是规范化后的地址（宿主 + 内层视图）——合并入口会把地址改写过去，
 * 这样「复制地址发给同事」落到的是同一个内层 Tab。
 */
const MERGED_DEEPLINKS = [
  // `expectText` = 该页**正文**里必然出现的字符串（不能用页签标签——那是外壳画的，
  // 会掩盖「正文空白」这种回归：`?tab=llmstxt` 曾经因为漏了渲染分支而整页空白）。
  { tab: 'robots_policy', highlight: '站点与品牌设置', expectTab: 'robots_policy', expectText: 'robots.txt' },
  { tab: 'llmstxt', highlight: '站点与品牌设置', expectTab: 'llmstxt', expectText: 'llms.txt' },
  { tab: 'brand_entity', highlight: '站点与品牌设置', expectTab: 'seo_foundation', expectView: 'brand', expectText: '企业实体基础信息档案' },
  { tab: 'url_scanner', highlight: '可发现性总览', expectTab: 'seo_dashboard', expectView: 'scanner', expectText: '立即深度体检' },
  { tab: 'competitor', highlight: 'AI 引用监测', expectTab: 'query_radar', expectView: 'competitor', expectText: '运行一次真实竞品扫描' },
  { tab: 'sandbox', highlight: 'AI 引用监测', expectTab: 'query_radar', expectView: 'sandbox', expectText: '目标大模型引擎' },
  { tab: 'leads', highlight: '转化与线索', expectTab: 'attribution_funnel', expectView: 'leads', expectText: '新建表单' },
];

const results = [];
const consoleErrors = [];
/** 4xx/5xx 响应（带 URL，便于按已知可忽略项过滤）。 */
const badResponses = [];
/** 在途的 /api/v1 请求（用于「等数据落定再断言」）。 */
const pendingApiRequests = new Set();

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

/**
 * 等后端明确回答「这个部署开没开 AI 助手」，返回 `'true'` / `'false'`；
 * 超时仍没落定则返回 `null`。
 *
 * 为什么要等：外壳放行（遮罩消失）**不代表数据到齐**——`aiWorkspaceEnabled`
 * 要等 `ai-workspace/status` 回来才从 `null` 变成真值。不等就断言导航，
 * 读到的是「还没问到」的中间态，测出来的成败取决于网速。
 */
async function waitForAiWorkspaceFlag(page, timeout = 20000) {
  try {
    await page.waitForFunction(
      () => {
        const value = document.querySelector('aside')?.getAttribute('data-ai-ws');
        // 'probe-failed' 也算**落定**：它是「问了但没问到答案」，与「还没回」不同，
        // 而且它对深链的处理（保留地址）正是要断言的行为之一。
        return value === 'true' || value === 'false' || value === 'probe-failed';
      },
      { timeout },
    );
  } catch {
    return null;
  }
  return page.evaluate(() => document.querySelector('aside')?.getAttribute('data-ai-ws'));
}

/**
 * 等 /api/v1 的在途请求清空（连续两次采样都为空），最多 30 秒。
 *
 * 为什么需要：外壳放行（遮罩消失）**不代表数据到齐**——列表与计数在数据没到时
 * 显示的是「…」或骨架，读它们会得到依赖网速的中间态。要在断言数据相关的界面
 * （文章计数、生成弹窗标题库、总览 CTA）之前先等一等。
 */
async function waitForDataSettled(page, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let quiet = 0;
  while (Date.now() < deadline && quiet < 2) {
    await page.waitForTimeout(700);
    quiet = pendingApiRequests.size === 0 ? quiet + 1 : 0;
  }
}

/** 侧边栏当前高亮的入口文案（用于断言「点谁亮谁」）。 */
async function activeNavLabel(page) {
  return page.evaluate(() => {
    const aside = document.querySelector('aside');
    // 用 `data-active` 而不是扫 className：选中态 2026-09-13 从「靛蓝实底」
    // 改成了「浅底 + 左侧指示条」，靠类名匹配会随视觉改版一起烂掉。
    const active = aside?.querySelector('button[data-active="true"]');
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
  page.on('request', (req) => {
    if (req.url().includes('/api/v1/')) pendingApiRequests.add(req.url());
  });
  page.on('requestfinished', (req) => {
    if (req.url().includes('/api/v1/')) pendingApiRequests.delete(req.url());
  });
  page.on('requestfailed', (req) => {
    if (req.url().includes('/api/v1/')) pendingApiRequests.delete(req.url());
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

    // 列表计数/CTA 要等首轮业务数据落定（「加载中」显示为「…」/骨架，读到的不是结论）。
    await waitForDataSettled(page);

    // ── 2. 侧边栏结构 ──────────────────────────────────────────────
    // 先等 AI 助手的开关落定再读导航：外壳放行 ≠ 数据到齐，不等就会读到
    // 「后端还没回答」的中间态（实测 dev 下入口比外壳晚好几秒才出现）。
    const aiWsFlag = await waitForAiWorkspaceFlag(page);
    record(
      'AI 助手开关状态已落定',
      aiWsFlag !== null,
      aiWsFlag === null ? '20 秒内仍为 unknown' : `data-ai-ws=${aiWsFlag}`,
    );

    const navLabels = await page.evaluate(() => {
      const aside = document.querySelector('aside');
      if (!aside) return [];
      // 一级入口 = 带 aria-expanded 的分组头，或「总览 / AI 助手」这两个单页入口
      const SINGLE_PAGE = ['工作台', 'AI 助手'];
      return [...aside.querySelectorAll('button')]
        .filter((b) => b.getAttribute('aria-expanded') !== null || SINGLE_PAGE.includes(b.innerText.trim()))
        .map((b) => b.innerText.trim().replace(/\s+/g, ' ').replace(/[▾▸]/g, '').trim());
    });
    const missingRequired = REQUIRED_TOP_LEVEL.filter((l) => !navLabels.includes(l));
    const unexpected = navLabels.filter(
      (l) => !REQUIRED_TOP_LEVEL.includes(l) && !OPTIONAL_TOP_LEVEL.includes(l),
    );
    record(
      `一级导航包含全部 ${REQUIRED_TOP_LEVEL.length} 个必现入口`,
      missingRequired.length === 0,
      `实际 ${navLabels.length} 个: ${navLabels.join(' / ')}`,
    );
    record(
      '一级导航没有多余入口',
      unexpected.length === 0,
      unexpected.length ? `多余: ${unexpected.join(',')}` : '',
    );

    // AI 助手入口的可见性必须与后端开关**一致**：开了却不显示（或反过来）
    // 都是缺陷，而且这两半都不会让别的断言变红，只能单独断言。
    const hasAiEntry = navLabels.includes('AI 助手');
    record(
      `AI 助手入口与开关一致（开关=${aiWsFlag}）`,
      aiWsFlag !== null && hasAiEntry === (aiWsFlag === 'true'),
      hasAiEntry ? '导航里有 AI 助手' : '导航里没有 AI 助手',
    );

    // 入口在就得点得开（它是从「设置」里提出来的一级入口，走的是自己的页签）。
    if (aiWsFlag === 'true') {
      const opened = await clickNavItem(page, 'AI 助手');
      const openedTab = new URLSearchParams(new URL(page.url()).search).get('tab');
      record('AI 助手入口可点开', opened && openedTab === 'ai-workspace', `tab=${openedTab}`);
    }

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

    // ── 3b. 合并入口：老深链仍可用，且高亮落在合并后的入口 ────────────
    // 被合并的子页签（竞品对比/引用测试/线索/页面体检/品牌实体）**仍在 ADMIN_TABS 里**，
    // 深链打开的就是同一个页面（只是内层 Tab 不同）；侧栏高亮必须落在合并后的入口上，
    // 否则深链进来侧栏一个都不亮。合并入口同时把地址规范化为 `?tab=<宿主>&view=<内层>`。
    for (const entry of MERGED_DEEPLINKS) {
      await page.goto(`${ADMIN_PATH}?tab=${entry.tab}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await waitForAppReady(page);
      await waitForDataSettled(page);
      const active = await activeNavLabel(page);
      const params = new URLSearchParams(new URL(page.url()).search);
      const tabInUrl = params.get('tab');
      const viewInUrl = params.get('view');
      const urlOk = tabInUrl === entry.expectTab && (entry.expectView ? viewInUrl === entry.expectView : true);
      const highlightOk = (active || '').startsWith(entry.highlight);
      // 内层 Tab 真的选中了吗（合并页面靠 data-shell-tab + aria-selected 标记）
      const innerOk = entry.expectView
        ? await page.evaluate((key) => document.querySelector(`[data-shell-tab="${key}"]`)?.getAttribute('aria-selected') === 'true', entry.expectView)
        : true;
      // 正文内容判据：确认这一页真的渲染出来了（不只是地址与高亮对）
      const textOk = await page.evaluate((needle) => (document.querySelector('main')?.innerText || '').includes(needle), entry.expectText);
      record(
        `合并入口：${entry.tab} → 高亮「${entry.highlight}」、内层 Tab 与正文都正确`,
        urlOk && highlightOk && innerOk && textOk,
        `tab=${tabInUrl} view=${viewInUrl} 高亮=${active} 内层=${innerOk} 正文=${textOk}`,
      );
    }
    await clickNavItem(page, '工作台');
    await page.waitForTimeout(600);

    // ── 4. 关键 CTA：总览「去审核」─────────────────────────────────
    await clickNavItem(page, '工作台');
    await page.waitForTimeout(1200);
    // 待办磁贴由真实数据推导（待审数 > 0 才渲染），数据未落定时不渲染
    // （加载中不许把「还不知道」说成 0 待审）——所以先等落定再找。
    // 判据用 `data-todo="review"` 钩子，不依赖中文文案（文案会改，钩子不会）。
    await waitForDataSettled(page);
    await page.waitForTimeout(400);
    const ctaClicked = await page.evaluate(() => {
      const btn = document.querySelector('main [data-todo="review"]');
      if (!btn) return null;
      btn.click();
      return true;
    });
    if (ctaClicked) {
      await page.waitForTimeout(2500);
      const url = page.url();
      record('工作台「待审核」磁贴能跳到文章页', url.includes('tab=articles'), url.split('?')[1] || url);
    } else {
      record('工作台「待审核」磁贴存在', false);
    }

    // ── 5. 「AI 生成」弹窗应显示标题库前置条件 ─────────────────────
    // 这一条原先打在独立的「写文章」页上；那一页已于 2026-09-13 并入「文章」页的弹窗，
    // 断言随之**改指到新面，判据不放宽**：用哪个标题库、还有没有可用标题，必须在
    // 「开始生成」之前就看得见，而不是点了才撞上「标题已用完」。
    await clickNavItem(page, '文章与审核');
    await waitForDataSettled(page);
    const openedGenerate = await page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      const btn = [...main.querySelectorAll('button')].find((b) => b.innerText.trim().includes('AI 生成'));
      if (!btn) return false;
      btn.click();
      return true;
    });
    await page.waitForTimeout(2500);
    const generateText = await page.evaluate(() => (document.querySelector('main')?.innerText || ''));
    record(
      '文章页「AI 生成」弹窗可打开',
      openedGenerate && /标题库/.test(generateText),
      openedGenerate ? '' : '没找到「AI 生成」按钮',
    );
    record('弹窗把标题库可用条数前置显示', /可用\s*\d+/.test(generateText));
    record('弹窗可切换标题库（下拉存在）', await page.evaluate(() => !!document.querySelector('main select')));

    // ── 5b. 连续审核模式：只验证「能进、计数对、键盘能出」─────────────
    // **刻意不点「通过审核 / 退回修改」**：那两个按钮会真的改文章状态与审核记录，
    // 冒烟测试不允许动真实业务数据。这里守的是三件容易回归的事：
    // ① 有待审文章时入口出现；② 进度计数读的是真实待审条数；
    // ③ Escape 能退出——它和 ←/→ 走的是同一条键盘通路（handlers ref），
    //    这条通过就说明监听器注册与「闭包不取第一次渲染的值」这两件事都对。
    await clickNavItem(page, '工作台');
    await page.waitForTimeout(800);
    await clickNavItem(page, '文章与审核');
    await page.waitForTimeout(1500);
    await waitForDataSettled(page);
    // 先读页面自己报的待审条数（状态筛选条上的「待审核 (N)」），再拿它判入口该不该在。
    // 这比「找不到入口就算通过」强：那样入口因为回归而消失时，测试会安静地变绿。
    const pendingReview = await page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      const chip = [...main.querySelectorAll('button')].find((b) => b.innerText.trim().startsWith('待审核'));
      if (!chip) return null;
      const matched = chip.innerText.match(/\((\d+)\)/);
      return matched ? Number(matched[1]) : null;
    });
    const reviewEntryClicked = await page.evaluate(() => {
      const main = document.querySelector('main') || document.body;
      const btn = [...main.querySelectorAll('button')].find((b) => b.innerText.trim().startsWith('开启审核模式'));
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (pendingReview === null) {
      record('文章页能读到待审数量', false, '没找到「待审核 (N)」筛选条');
    } else if (pendingReview === 0) {
      record('没有待审文章时不显示连续审核入口', reviewEntryClicked === false);
    } else {
      record('有待审文章时出现连续审核入口', reviewEntryClicked === true);
      await page.waitForTimeout(900);
      const progress = await page.evaluate(() => {
        const el = document.querySelector('[data-review-progress]');
        return el ? el.innerText.trim() : null;
      });
      const total = progress ? Number((progress.split('/')[1] || '').trim()) : -1;
      record('连续审核模式可打开且计数正确', progress !== null && total === pendingReview, progress || '没渲染出进度');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
      const stillOpen = await page.evaluate(() => !!document.querySelector('[data-review-progress]'));
      record('Escape 可退出连续审核', stillOpen === false);
    }

    // ── 5c. 质检结论必须与「门禁判定」一致，且不能是死胡同 ──────────────
    // 2026-09-14 哥哥报的 bug：面板把 status=completed 显示成「已完成」（绿色勾），
    // 用户以为通过、点发布却被门禁拦下，而且界面上**没有任何放行的出路**。
    // 判据（只读，不改任何数据）：
    //   ① 主结论必须是「质检通过 / 待人工复核 / 质检未通过 / 未质检 / 待质检 / 质检失败」之一，
    //      **绝不能是「已完成」**（那是"跑完了"，不是结论）；
    //   ② 判定为「待人工复核」时，必须给出下一步：可放行就给放行区，分数不够就说清要优化。
    await clickNavItem(page, '文章与审核');
    await waitForDataSettled(page);
    const openedArticle = await page.evaluate(() => {
      const row = [...document.querySelectorAll('main tbody tr')].find((tr) => /待审核|已发布|草稿/.test(tr.innerText));
      const btn = row?.querySelector('button[aria-label="查看文章"]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (openedArticle) {
      await page.waitForTimeout(8000);
      const quality = await page.evaluate(() => {
        const el = document.querySelector('[data-quality-verdict]');
        return {
          label: el ? el.innerText.trim() : null,
          decision: el ? el.getAttribute('data-quality-verdict') : null,
          hasRelease: !!document.querySelector('[data-quality-release]'),
          releaseText: document.querySelector('[data-quality-release]')?.innerText || '',
        };
      });
      const allowed = ['质检通过', '待人工复核', '质检未通过', '未质检', '待质检', '质检失败'];
      record(
        '文章详情：质检主结论是「判定」而不是「已完成」',
        quality.label !== null && allowed.some((v) => (quality.label || '').includes(v)),
        `结论=${quality.label} decision=${quality.decision}`,
      );
      const needsNextStep = quality.decision !== 'needs_review'
        || quality.hasRelease;
      record(
        '判定为「待人工复核」时给出了下一步（放行区/优化说明）',
        needsNextStep,
        quality.decision === 'needs_review'
          ? (quality.hasRelease ? '有放行区' : '!! 没有任何出路')
          : `不需要（decision=${quality.decision}）`,
      );
      // 放行区必须说清「为什么要人工放行」——不能只甩一个分数（100 分却要放行看起来像 bug）
      const explainsWhy = !quality.hasRelease
        || /原因|覆盖|门禁|抽样/.test(quality.releaseText || '');
      record(
        '人工放行区说明了真实依据（不是只给分数）',
        explainsWhy,
        explainsWhy ? '' : (quality.releaseText || '').slice(0, 60),
      );
      // 关掉弹窗，别影响后续用例
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      const stillOpen = await page.evaluate(() => !!document.querySelector('div.fixed.inset-0'));
      if (stillOpen) {
        await page.locator('div.fixed.inset-0 button:has(svg.lucide-x)').first().click().catch(() => {});
        await page.waitForTimeout(800);
      }
    } else {
      record('文章详情：能打开一篇文章做质检结论检查', false, '列表里没有可打开的文章');
    }

    // ── 6. 深链：/geo_admin?tab=ai-workspace ───────────────────────
    // 这个链接是**后端 AI 助手回复里给出的入口格式**（`src/tabs.ts` 的 tabPath），
    // 也是「复制地址发给同事」用的。它必须在登录前就活下来——此前的实现把
    // 「开关还没问到」当成「关掉了」，于是在登录页停留几百毫秒后地址栏就被改写成
    // `?tab=dashboard`，链接在用户登录之前就已经失效。这一条守的就是那个回归。
    await page.goto(`${ADMIN_PATH}?tab=ai-workspace`, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await waitForAppReady(page);
    const deepLinkFlag = await waitForAiWorkspaceFlag(page);
    const deepLinkTab = new URLSearchParams(new URL(page.url()).search).get('tab');
    // 落点分三种，不能混为一谈：
    //   · 开关开着（true）→ 停在 AI 助手；
    //   · 后端**明确**回答没开（false）→ 退回总览；
    //   · 问了但没问到答案（probe-failed）→ **地址原样保留**，因为「没问到」不许被当成
    //     「否定」。这一条是 2026-09-13 实测出来的：同一台机器两次加载，一次探到 true、
    //     一次连接被重置，旧实现会因此把用户粘贴的入口链接改写成总览。
    const expectedTab = deepLinkFlag === 'false' ? 'dashboard' : 'ai-workspace';
    record(
      `AI 助手深链落点正确（开关=${deepLinkFlag}）`,
      deepLinkFlag !== null && deepLinkTab === expectedTab,
      `落在 tab=${deepLinkTab}，期望 ${expectedTab}`,
    );

    // ── 7. 失败请求（按 URL 过滤掉已知可忽略项）──────────────────────
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
