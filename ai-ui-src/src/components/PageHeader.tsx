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
 * 统一的页面头（2026-09-13 视觉重设计）。
 *
 * 为什么要有它：原先 24 个页面各写各的头部——有的 h1 带图标、有的没有、有的干脆
 * 没标题（总览）；字重/间距/描述行各不相同，观感「拼」出来的。这里固定一版：
 * 分组线索 + 标题 + 一句话说明 + 右侧操作，**所有被重设计的页面共用**。
 *
 * 页面标题回答「这是哪」，description 回答「这一页能做什么」——
 * 面向运营人员的大白话，不出现实现术语（同 `docs/ADMIN_UI_REDESIGN_PLAN.md` 原则 2）。
 */
export const PageHeader: React.FC<PageHeaderProps> = ({ icon: Icon, group, title, description, actions, embedded = false }) => {
  if (embedded) {
    return actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : null;
  }
  return (
  /* 页面头：分组线索 → 标题 → 一句话说明 → 主操作，底部一条分隔线把「页头区」与
     「内容区」分开——这是全站统一版式的第一步（原来标题、按钮、统计、表格混在一起）。 */
  <div className="flex flex-col gap-5 border-b border-slate-800 pb-6 sm:flex-row sm:items-end sm:justify-between">
    <div className="min-w-0">
      {group && (
        <div className="mb-2 text-[12px] font-medium text-slate-400">{group}</div>
      )}
      <h1 className="text-page-title flex items-center gap-3">
        {Icon && (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-500">
            <Icon className="h-[22px] w-[22px]" />
          </span>
        )}
        {title}
      </h1>
      {description && (
        <p className="text-body mt-2 max-w-3xl">{description}</p>
      )}
    </div>
    {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 self-start sm:self-auto">{actions}</div>}
  </div>
  );
};
