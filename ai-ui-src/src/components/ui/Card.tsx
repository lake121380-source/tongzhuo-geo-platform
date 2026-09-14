import React from 'react';

/**
 * 卡片与分区（Design System · D0）。
 *
 * 审计发现同一种"卡片"在仓库里有 8 种近似写法（`rounded-xl border bg-slate-900/80 p-5` ×9、
 * `/90 p-5 shadow-sm` ×9、`rounded-2xl … p-5` ×5 …）。它们**长得几乎一样但各不相同**，
 * 于是"每个页面像是不同人拼的"。这里固定一种：白面 + 1px 轻边框 + 极轻阴影 + 14px 圆角。
 *
 * 层级约定（效率 > 美观）：
 *   Card    = 一级容器（列表、表单、图表都装它）
 *   Section = 卡片内部的分区，或页面上的小节（标题 + 说明 + 右侧操作）
 */

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 内边距：默认 5（20px）；紧凑场景用 4；纯容器（内部自带 padding）用 0。 */
  padding?: 0 | 3 | 4 | 5 | 6;
  /** 可点击/可悬停的卡片（列表项、入口卡）。 */
  interactive?: boolean;
}

const CARD_PADDING = { 0: '', 3: 'p-3', 4: 'p-4', 5: 'p-5', 6: 'p-6' } as const;

export const Card: React.FC<CardProps> = ({
  padding = 5,
  interactive = false,
  className = '',
  children,
  ...rest
}) => (
  <div
    className={[
      'rounded-2xl border border-slate-800 bg-slate-900/80 shadow-sm',
      CARD_PADDING[padding],
      interactive ? 'transition hover:border-slate-700 hover:shadow-md' : '',
      className,
    ].filter(Boolean).join(' ')}
    {...rest}
  >
    {children}
  </div>
);

interface SectionProps {
  title?: React.ReactNode;
  /** 一句话说明这一节是干什么的——面向运营，不写实现细节。 */
  description?: React.ReactNode;
  /** 右侧操作区（按钮/筛选器）。 */
  actions?: React.ReactNode;
  /** 内嵌在卡片里时不加外边距（默认作为页面小节使用）。 */
  embedded?: boolean;
  className?: string;
  children: React.ReactNode;
}

export const Section: React.FC<SectionProps> = ({
  title,
  description,
  actions,
  embedded = false,
  className = '',
  children,
}) => (
  <section className={`${embedded ? '' : 'space-y-3'} ${className}`}>
    {(title || actions) && (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          {title && <h2 className="text-section-title">{title}</h2>}
          {description && <p className="text-caption mt-0.5">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    )}
    {children}
  </section>
);
