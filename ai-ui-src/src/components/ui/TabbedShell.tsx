import React, { useEffect } from 'react';
import { PageHeader } from '../PageHeader';

/**
 * 合并页面的外壳（Design System · D1）。
 *
 * 用途：把"同一件事、后端同源、只是视角不同"的几个页面收进**一个侧栏入口**，
 * 内部用 Tab 切换——用户不再需要在侧栏猜该进哪个。
 * 已合并：AI 引用监测（问答监测/竞品对比/引用测试）、转化与线索、
 * 可发现性总览（总览/页面体检）、站点与品牌设置（站点 SEO/品牌实体）。
 *
 * **不删页面、不删 API**：被合并的子页面仍是独立可渲染的视图，旧 `?tab=<子id>` 深链
 * 依然打开它（只是侧栏高亮落在合并后的入口上）。这里做的是"入口收敛"，不是"功能删除"。
 *
 * 子视图以 `embedded` 模式渲染：它们自己不再画页面标题（由本外壳统一画），
 * 但仍保有自己的操作按钮与说明——所以不会出现"两个标题"或"标题丢了动作"。
 */

export interface ShellTab {
  key: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  render: () => React.ReactNode;
}

interface TabbedShellProps {
  /** 面包屑（一级分组名）。 */
  group?: string;
  title: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  tabs: ShellTab[];
  /** 当前子视图 key（来自 URL `?tab=<host>&view=<key>` 或内层点击）。 */
  view?: string | null;
  onViewChange: (key: string) => void;
}

export const TabbedShell: React.FC<TabbedShellProps> = ({
  group,
  title,
  description,
  icon,
  tabs,
  view,
  onViewChange,
}) => {
  const active = tabs.find((tab) => tab.key === view) ?? tabs[0];

  // 地址里的 view 不认识（旧链接/拼错/宿主默认视图不属于本页）时，把它纠正成真实视图。
  // 不做这一步的话：界面会停在 tabs[0]，而地址栏仍写着那个无效 view，
  // 「复制地址发给同事」就会把别人也带到一个不存在的内层 Tab。
  useEffect(() => {
    if (view && tabs.length > 0 && !tabs.some((tab) => tab.key === view)) {
      onViewChange(tabs[0].key);
    }
  }, [view, tabs, onViewChange]);

  return (
    <div className="space-y-6">
      <PageHeader icon={icon} group={group} title={title} description={description} />

      {/* 页面级页签：下划线样式，明确「这是同一页的不同视角」，而不是一排并列按钮。 */}
      <div role="tablist" aria-label={`${title} 子视图`} className="flex items-center gap-1 overflow-x-auto border-b border-slate-800">
        {tabs.map((tab) => {
          const isActive = tab.key === active?.key;
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              data-shell-tab={tab.key}
              onClick={() => onViewChange(tab.key)}
              className={[
                'relative flex shrink-0 items-center gap-2 px-4 py-3 text-[14px] font-semibold transition',
                isActive ? 'text-white' : 'text-slate-400 hover:text-slate-200',
                isActive ? 'after:absolute after:inset-x-3 after:-bottom-px after:h-[3px] after:rounded-full after:bg-indigo-600' : '',
              ].filter(Boolean).join(' ')}
            >
              {Icon && <Icon className="h-3.5 w-3.5" />}
              {tab.label}
            </button>
          );
        })}
      </div>

      <div>{active?.render()}</div>
    </div>
  );
};
