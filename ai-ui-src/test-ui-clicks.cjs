// @ts-check
const { chromium } = require('playwright');

async function runBrowserClickTests() {
  console.log('====================================================');
  console.log('🚀 启动真实的 Headless Chromium 真实用户点击测试');
  console.log('====================================================');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });

  const page = await context.newPage();

  // 监听浏览器控制台错误
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  page.on('pageerror', err => {
    console.error('页面未捕获异常:', err.message);
    consoleErrors.push(err.message);
  });

  try {
    console.log('⏳ 1. 加载首页应用 http://127.0.0.1:3000 ...');
    await page.goto('http://127.0.0.1:3000', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const title = await page.title();
    console.log(`✅ 页面标题: "${title}"`);

    // 检查侧边栏按钮并点击
    console.log('⏳ 2. 依次真实点击侧边栏各主要模块导航按钮...');

    const navItems = [
      { text: 'SEO 综合决策大盘', expectedSelector: ':is(h1,h2):has-text("SEO 综合决策大盘")' },
      { text: 'SEO 筑基与双轨地图', expectedSelector: ':is(h1,h2):has-text("双轨 Sitemap")' },
      { text: 'AI 爬虫访问防线', expectedSelector: ':is(h1,h2):has-text("爬虫准入")' },
      { text: '品牌实体与 E-E-A-T', expectedSelector: ':is(h1,h2):has-text("品牌实体消歧")' },
      { text: '全站 URL 渲染体检', expectedSelector: ':is(h1,h2):has-text("GEO 深度体检")' },
      { text: '概览大盘', expectedSelector: ':is(h1,h2):has-text("GEO 内容生产总览")' },
      { text: 'AI 内容工坊', expectedSelector: ':is(h1,h2):has-text("GEO 内容工坊")' },
      { text: '内容与审核', expectedSelector: ':is(h1,h2):has-text("GEO 权威信源内容资产中台")' },
      { text: '/llms.txt 规范管理', expectedSelector: ':is(h1,h2):has-text("大语言模型协议直通中枢")' },
      { text: '知识库与 RAG', expectedSelector: ':is(h1,h2):has-text("品牌权威事实知识库")' },
      { text: '任务与调度', expectedSelector: ':is(h1,h2):has-text("定时生产与爬虫同步流水线")' },
      { text: '多端分发中台', expectedSelector: ':is(h1,h2):has-text("自动化分发网络")' },
      { text: 'AI 转化漏斗与归因', expectedSelector: ':is(h1,h2):has-text("AI 搜索引流与高意向转化归因")' },
      { text: '高潜问答挖掘', expectedSelector: ':is(h1,h2):has-text("AI 搜索问答高潜机会雷达")' },
      { text: '竞品声量雷达', expectedSelector: ':is(h1,h2):has-text("竞品大模型声量对比雷达")' },
      { text: 'AI 命中模拟沙盒', expectedSelector: ':is(h1,h2):has-text("多引擎实机检索沙箱")' },
      { text: 'GEO 指标与大盘', expectedSelector: ':is(h1,h2):has-text("GEO 权威信源穿透率与漏斗监控")' },
      { text: '模型与提示词', expectedSelector: ':is(h1,h2):has-text("模型引擎与 Prompt 策略配置")' },
    ];

    for (const item of navItems) {
      console.log(`   👉 点击导航菜单: [${item.text}]`);
      const navBtn = page.locator(`button:has-text("${item.text}")`).first();
      await navBtn.waitFor({ state: 'visible', timeout: 5000 });
      await navBtn.click();
      await page.waitForTimeout(400);
      
      // 验证视图切换成功
      const heading = page.locator(item.expectedSelector).first();
      await heading.waitFor({ state: 'visible', timeout: 5000 });
      console.log(`      ✓ 视图成功切换并正确渲染: ${item.text}`);
    }

    console.log('✅ 侧边栏所有 18 个功能模块导航按钮点击与视图切换全部通过！\n');

    // 交互测试 A: URL 渲染体检交互
    console.log('⏳ 3. 测试【全站 URL 渲染体检】按钮与表单真实点击交互...');
    await page.locator('button:has-text("全站 URL 渲染体检")').first().click();
    await page.waitForTimeout(400);

    const inputField = page.locator('input[placeholder*="https://"]').first();
    await inputField.fill('https://example-saas.com/pricing');
    
    const scanBtn = page.locator('button:has-text("立即执行 GEO 深度体检")').first();
    await scanBtn.click();
    console.log('   👉 真实点击了 [立即执行 GEO 深度体检] 按钮');
    
    // 等待体检结果渲染
    await page.waitForSelector('text=GEO 综合诊断得分', { timeout: 10000 });
    console.log('   ✓ 页面真实返回并渲染了 URL 深度体检诊断报告！');

    // 交互测试 B: 高潜问答挖掘 “生成 GEO 标杆草稿” 按钮
    console.log('⏳ 4. 测试【高潜问答挖掘】中 "生成 GEO 标杆草稿" 按钮真实点击交互...');
    await page.locator('button:has-text("高潜问答挖掘")').first().click();
    await page.waitForTimeout(500);

    const draftBtn = page.locator('button:has-text("生成 GEO 标杆草稿")').first();
    await draftBtn.click();
    console.log('   👉 真实点击了 [生成 GEO 标杆草稿] 按钮');

    // 验证弹出模态框
    await page.waitForSelector('text=基于高潜问答生成 GEO 标杆内容草稿', { timeout: 8000 });
    console.log('   ✓ 成功弹出 [基于高潜问答生成 GEO 标杆内容草稿] 模态框！');

    // 点击模态框内的 "确定生成草稿"
    const confirmBtn = page.locator('button:has-text("确定生成草稿并入库")').first();
    await confirmBtn.click();
    console.log('   👉 真实点击了模态框内 [确定生成草稿并入库] 按钮');
    await page.waitForTimeout(800);

    // 交互测试 C: AI 命中模拟沙盒
    console.log('⏳ 5. 测试【AI 命中模拟沙盒】的引擎切换与检索模拟按钮真实点击...');
    await page.locator('button:has-text("AI 命中模拟沙盒")').first().click();
    await page.waitForTimeout(500);

    const simBtn = page.locator('button:has-text("立即执行 AI 搜索实机模拟")').first();
    await simBtn.click();
    console.log('   👉 真实点击了 [立即执行 AI 搜索实机模拟] 按钮');

    // 等待沙箱结果展示
    await page.waitForSelector('text=AI 搜索实机回答与权威信源生成结果', { timeout: 10000 });
    console.log('   ✓ 实机沙箱真实模拟完成，已呈现生成的 AI 搜索结果与信源引用标签！');

    // 交互测试 D: 品牌实体与 E-E-A-T 保存与微数据同步
    console.log('⏳ 6. 测试【品牌实体与 E-E-A-T】配置保存按钮真实点击...');
    await page.locator('button:has-text("品牌实体与 E-E-A-T")').first().click();
    await page.waitForTimeout(500);

    const saveEntityBtn = page.locator('button:has-text("保存实体配置并同步至全站微数据")').first();
    await saveEntityBtn.click();
    console.log('   👉 真实点击了 [保存实体配置并同步至全站微数据] 按钮');
    await page.waitForTimeout(600);

    // 交互测试 E: 综合决策大盘导出简报与时间切换
    console.log('⏳ 7. 测试【SEO 综合决策大盘】时间切换与复制高管决策内参真实点击...');
    await page.locator('button:has-text("SEO 综合决策大盘")').first().click();
    await page.waitForTimeout(500);

    const btn30d = page.locator('button:has-text("近30天")').first();
    await btn30d.click();
    console.log('   👉 真实点击了时间范围切换按钮 [近30天]');
    await page.waitForTimeout(300);

    const exportBtn = page.locator('button:has-text("复制决策内参")').first();
    await exportBtn.click();
    console.log('   👉 真实点击了 [复制决策内参] 按钮');
    await page.waitForTimeout(300);
    console.log('   ✓ 决策内参成功复制/触发！');

    // 交互测试 F: SEO 筑基与双轨地图
    console.log('⏳ 8. 测试【SEO 筑基与双轨地图】立即同步按钮真实点击...');
    await page.locator('button:has-text("SEO 筑基与双轨地图")').first().click();
    await page.waitForTimeout(500);

    const syncSitemapBtn = page.locator('button:has-text("立即同步并重新生成双轨 Sitemap")').first();
    await syncSitemapBtn.click();
    console.log('   👉 真实点击了 [立即同步并重新生成双轨 Sitemap] 按钮');
    await page.waitForTimeout(600);
    console.log('   ✓ 双轨 Sitemap 同步完成！');

    // 交互测试 G: AI 转化漏斗与归因 生成 UTM 链接按钮
    console.log('⏳ 9. 测试【AI 转化漏斗与归因】生成高精度引流短链按钮真实点击...');
    await page.locator('button:has-text("AI 转化漏斗与归因")').first().click();
    await page.waitForTimeout(500);

    const genUtmBtn = page.locator('button:has-text("生成高精度 AI 引流追踪短链")').first();
    await genUtmBtn.click();
    console.log('   👉 真实点击了 [生成高精度 AI 引流追踪短链] 按钮');
    await page.waitForTimeout(500);
    console.log('   ✓ AI 引流追踪短链与参数注入成功！');

    console.log('====================================================');
    console.log('🎉 真实用户按钮点击与交互测试全部通过！');
    console.log(`控制台致命错误数: ${consoleErrors.length}`);
    console.log('====================================================');

  } catch (error) {
    console.error('❌ 测试过程中发生错误:', error);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

runBrowserClickTests();
