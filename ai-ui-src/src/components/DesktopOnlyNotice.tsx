import React, { useEffect, useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';

/**
 * 桌面端守卫（Design System · D1 · 响应式）。
 *
 * 审计实测：375px 下侧栏占 256px，正文被压成竖排单字，**界面是坏的**（截图见
 * `.review/ux-audit/mobile-dashboard.png`）。这个后台是运营工作台，真实使用场景是桌面，
 * 本次**不做移动端适配**（那是另一件事），但也不能让用户看到"坏掉的界面"。
 *
 * 做法：<1024px 时盖一层受控提示，说清"为什么看不到"和"怎么办"。
 * 用 CSS 媒体查询控制显隐（`max-lg:`），不依赖 JS 宽度监听——首屏不会闪。
 * 挂 `data-desktop-guard` 供冒烟测试断言。
 */
export const DesktopOnlyNotice: React.FC = () => {
  // 只在真的窄屏时渲染内容（避免无谓地占用 DOM）；CSS 仍负责最终显隐。
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(max-width: 1023px)');
    const update = () => setNarrow(query.matches);
    update();
    // 现代浏览器用 addEventListener；老 Safari 只有 addListener——两条都挂上，
    // 否则「拉宽窗口后提示不消失」只在部分浏览器出现，很难查。
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', update);
      return () => query.removeEventListener('change', update);
    }
    query.addListener(update);
    return () => query.removeListener(update);
  }, []);

  if (!narrow) return null;

  return (
    <div
      data-desktop-guard
      role="alertdialog"
      aria-label="请使用桌面浏览器"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950 px-6 text-center"
    >
      <div className="max-w-sm">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900 text-slate-300">
          <MonitorSmartphone className="h-6 w-6" />
        </span>
        <h1 className="text-lg font-bold text-white">请使用桌面浏览器访问管理后台</h1>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          桐灼GEO 后台是面向运营人员的工作台，需要至少 1024px 宽的窗口
          （写作、审核、渠道配置都在宽屏下才完整）。
          请改用电脑浏览器打开，或把窗口拉宽到 1024px 以上。
        </p>
        <p className="mt-3 text-[11px] text-slate-500">
          公开站点本身不受影响——访客用手机浏览没有问题。
        </p>
      </div>
    </div>
  );
};
