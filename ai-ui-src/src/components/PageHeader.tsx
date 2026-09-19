import React from 'react';

interface PageHeaderProps {
  /** 页面图标（放在浅底方块里）。 */
  icon?: React.ComponentType<{ className?: string }>;
  /** 所属一级分组（面包屑位置，如「内容中心」）。与侧边栏分组同名。 */
  group?: string;
  title: string;
  description?: string;
  /** 右侧操作区（主按钮在前、次按钮在后）。 */
  actions?: React.ReactNode;
  /**
   * 嵌入式渲染（用于合并页面的内层 Tab）：**只保留操作区**，不画标题与说明——
   * 标题由外层 `TabbedShell` 统一画，避免"一个页面两个标题"。
   * 这样被合并的子页面只需在 `<PageHeader>` 上加一个 `embedded={embedded}`，不必重排 JSX。
   */
  embedded?: boolean;
}

/**
 * 统一的页面头。
 *
 * 2026-09-13 建：原先 24 个页面各写各的头部，字重/间距/描述行各不相同，观感「拼」出来的。
 *
 * 2026-09-19 改版（对齐外部设计稿）：**从「重页头」改成「紧凑页头」**。
 * 原来是一行分组标签 + 44px 图标方块 + 大标题 + 正文尺寸的说明，还带一条下边框；
 * 设计稿的页头只有两行——`text-xl` 标题 + `text-xs` 副标题，操作靠右，**没有分组建、没有图标方块**。
 * 分组线索本来侧栏就在显示（导航分组），页头再写一遍是重复；图标方块则占掉半行高度。
 *
 * ⚠️ `icon` / `group` 两个 props **保留但不再渲染**——调用方有 20 多处，
 * 删 prop 要同步改 20 多个文件，而它们的收益只是少传两个参数。留在这里是有意的。
 *
 * 页面标题回答「这是哪」，description 回答「这一页能做什么」——
 * 面向运营人员的大白话，不出现实现术语（同 `docs/ADMIN_UI_REDESIGN_PLAN.md` 原则 2）。
 */
export const PageHeader: React.FC<PageHeaderProps> = ({ title, description, actions, embedded = false }) => {
  if (embedded) {
    return actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : null;
  }
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-bold tracking-tight text-white">{title}</h1>
        {description && (
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-400">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 self-start sm:self-auto">{actions}</div>}
    </div>
  );
};
