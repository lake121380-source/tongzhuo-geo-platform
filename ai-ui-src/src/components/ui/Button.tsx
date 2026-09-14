import React from 'react';
import { Loader2 } from 'lucide-react';

/**
 * 全站按钮（Design System · D0）。
 *
 * 为什么要有它：审计发现主色按钮有 101 处 `bg-indigo-600` 与 72 处 `bg-indigo-500`
 * （"主色"与"hover"混用），另有 13 处彩色实底按钮承担非主操作；每个页面还各写一套
 * `px-* py-* rounded-*`。结果是：同一个"次要按钮"在三个页面是三种样子。
 *
 * 颜色语义（与设计系统一致，别再发明）：
 *   primary  = 每屏最多一个的**主操作**（保存/生成/发布）
 *   secondary= 次要动作（取消、切换、进入详情）
 *   ghost    = 低强调动作（图标旁的操作、行内动作）
 *   danger   = 破坏性动作（删除、清空）——**只在真的危险时用**
 *   link     = 文字链接式动作
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-indigo-600 text-white shadow-sm hover:bg-indigo-500',
  secondary: 'border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700',
  ghost: 'text-slate-300 hover:bg-slate-800 hover:text-white',
  danger: 'bg-rose-600 text-white shadow-sm hover:bg-rose-500',
  link: 'px-0 text-indigo-400 underline-offset-2 hover:text-indigo-300 hover:underline',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-2.5 text-[11px] rounded-lg',
  md: 'h-9 gap-1.5 px-3.5 text-xs rounded-lg',
  lg: 'h-10 gap-2 px-4 text-sm rounded-lg',
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 进行中：显示转圈并自动禁用（避免重复提交）。 */
  loading?: boolean;
  /** 左侧图标（lucide 组件）。 */
  icon?: React.ComponentType<{ className?: string }>;
  /** 撑满父容器宽度。 */
  block?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon: Icon,
  block = false,
  className = '',
  children,
  disabled,
  type = 'button',
  ...rest
}) => (
  <button
    type={type}
    disabled={disabled || loading}
    className={[
      'inline-flex shrink-0 items-center justify-center font-bold transition',
      'disabled:cursor-not-allowed disabled:opacity-50',
      variant === 'link' ? '' : SIZE_CLASS[size],
      VARIANT_CLASS[variant],
      block ? 'w-full' : '',
      className,
    ].filter(Boolean).join(' ')}
    {...rest}
  >
    {loading
      ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      : Icon ? <Icon className="h-3.5 w-3.5" /> : null}
    {children}
  </button>
);

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 读屏与自动化都靠它定位——**必填**（审计发现站内关闭按钮普遍没有）。 */
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  variant?: Extract<ButtonVariant, 'ghost' | 'secondary' | 'danger'>;
  size?: 'sm' | 'md';
}

const ICON_SIZE_CLASS = { sm: 'h-7 w-7', md: 'h-9 w-9' } as const;

export const IconButton: React.FC<IconButtonProps> = ({
  label,
  icon: Icon,
  variant = 'ghost',
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}) => (
  <button
    type={type}
    title={label}
    aria-label={label}
    className={[
      'inline-flex shrink-0 items-center justify-center rounded-lg transition disabled:cursor-not-allowed disabled:opacity-50',
      ICON_SIZE_CLASS[size],
      variant === 'secondary' ? 'border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700'
        : variant === 'danger' ? 'text-rose-400 hover:bg-rose-950/50 hover:text-rose-300'
          : 'text-slate-400 hover:bg-slate-800 hover:text-white',
      className,
    ].filter(Boolean).join(' ')}
    {...rest}
  >
    <Icon className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
  </button>
);
