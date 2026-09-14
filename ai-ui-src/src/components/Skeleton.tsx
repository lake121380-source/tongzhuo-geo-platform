import React from 'react';

/**
 * 骨架条：数据未到时的占位（浅色块 + 脉冲），与「真的没有」的空态区分开。
 *
 * 为什么需要它而不是 LoadingState：数值格（KPI tile）里塞不下「正在读取…」这类文案，
 * 而显示 0 或「暂无数据」会把「还不知道」说成「确认是零/没有」——这是本项目
 * 反复出现的体验缺陷（见 `LoadingState` 的注释与 `docs/ADMIN_UI_REDESIGN_PLAN.md` P1）。
 */
export const Skeleton: React.FC<{ className?: string; label?: string }> = ({ className = '', label }) => (
  <span
    role="status"
    aria-label={label}
    className={`inline-block h-6 animate-pulse rounded-md bg-slate-800 ${className}`}
  />
);

/** 多行骨架（列表行用）。最后一行短一些，看起来更像文本。 */
export const SkeletonRows: React.FC<{ rows?: number; className?: string }> = ({ rows = 3, className = '' }) => (
  <div role="status" aria-label="正在读取" className={`space-y-2.5 ${className}`}>
    {Array.from({ length: rows }).map((_, index) => (
      <div key={index} className="flex items-center gap-3">
        <span className="h-4 w-4 shrink-0 animate-pulse rounded bg-slate-800" />
        <span
          className="h-3.5 animate-pulse rounded bg-slate-800"
          style={{ width: `${Math.max(30, 82 - index * 14)}%` }}
        />
      </div>
    ))}
  </div>
);
