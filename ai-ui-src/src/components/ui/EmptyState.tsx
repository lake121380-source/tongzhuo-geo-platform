import React from 'react';

/**
 * 空状态（Design System · D0）。
 *
 * 审计发现空态文案在 38 个文件里各写各的（97 处「暂无/没有/还没有/尚未」），
 * 而且**多数空态不告诉用户下一步做什么**——"暂无数据"三个字对第一次用的人是死路。
 *
 * 约定：空态 = 图标 + 一句「为什么空」+ 一句「怎么让它不空」+ **一个动作**（可选但强烈建议）。
 * 与「加载中」严格区分：数据没到时用 LoadingState/骨架，**不要用空态**（那是把"还不知道"说成"没有"）。
 */

interface EmptyStateProps {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: React.ReactNode;
  /** 下一步动作（按钮等）。 */
  action?: React.ReactNode;
  /** 紧凑版（表格空行、卡片内侧）。 */
  compact?: boolean;
  /**
   * 整栏级空态（占满内容区的那种）用 `lg`：更大的图标与留白、虚线框。
   * 卡片内侧的小空态维持默认/compact——把卡片里的空态也放大，只会让卡片显得空。
   */
  size?: 'default' | 'lg';
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
  size = 'default',
  className = '',
}) => {
  const lg = size === 'lg' && !compact;
  return (
  <div
    role="status"
    className={[
      'flex flex-col items-center justify-center text-center',
      compact
        ? 'gap-1.5 px-4 py-8'
        : lg
          ? 'gap-3 rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 px-8 py-16'
          : 'gap-2 rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 px-6 py-12',
      className,
    ].filter(Boolean).join(' ')}
  >
    {Icon && (
      <span className={`mb-1 flex items-center justify-center bg-slate-800 text-slate-400 ${lg ? 'h-14 w-14 rounded-2xl' : 'h-10 w-10 rounded-xl'}`}>
        <Icon className={lg ? 'h-7 w-7' : 'h-5 w-5'} />
      </span>
    )}
    <p className={`font-semibold text-slate-200 ${lg ? 'text-base' : 'text-sm'}`}>{title}</p>
    {description && <p className={`text-caption ${lg ? 'max-w-lg' : 'max-w-md'}`}>{description}</p>}
    {action && <div className={lg ? 'mt-3' : 'mt-2'}>{action}</div>}
  </div>
  );
};
