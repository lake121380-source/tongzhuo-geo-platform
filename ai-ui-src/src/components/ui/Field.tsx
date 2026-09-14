import React from 'react';

/**
 * 表单控件（Design System · D0）。
 *
 * 审计发现表单控件在每个页面各写一遍（同样的 `w-full rounded-*-xl border border-slate-700
 * bg-slate-950 px-3 py-2 text-xs text-white focus:border-indigo-500` 出现在几十个文件里），
 * 而且**报错和帮助文字没有固定位置**——有的在字段上方、有的在整表底部、有的只有一行 toast。
 *
 * 约定：字段 = Label（+ 必填星号）+ 控件 + 帮助文字 + **紧贴字段的错误**。
 * 错误必须紧贴字段（"哪个字段错了"和"错在哪"要在同一处），与整表错误分开。
 */

const FIELD_BASE = 'w-full rounded-lg border bg-slate-950 px-3 text-xs text-white outline-none transition placeholder:text-slate-500 focus:border-indigo-500 disabled:cursor-not-allowed disabled:opacity-50';

function fieldBorder(hasError: boolean) {
  return hasError ? 'border-rose-500/60 focus:border-rose-400' : 'border-slate-700';
}

interface FieldProps {
  label: React.ReactNode;
  /** 字段级错误（会同时把 name/id 标记 aria-invalid）。 */
  error?: string;
  /** 帮助文字：解释这个字段填什么、为什么需要。 */
  hint?: React.ReactNode;
  required?: boolean;
  /** 让控件自己渲染（需要传 id/aria-describedby 时用 render prop）。 */
  children: React.ReactNode | ((ids: { id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }) => React.ReactNode);
  /** 生成关联 id 用的键；不传则不生成 id（简单场景够用）。 */
  htmlFor?: string;
  className?: string;
}

export const Field: React.FC<FieldProps> = ({ label, error, hint, required, children, htmlFor, className = '' }) => {
  const hintId = htmlFor ? `${htmlFor}-hint` : undefined;
  const errorId = htmlFor ? `${htmlFor}-error` : undefined;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className={`space-y-1.5 ${className}`}>
      <label htmlFor={htmlFor} className="flex items-center gap-1 text-xs font-semibold text-slate-300">
        {label}
        {required && <span className="text-rose-400" aria-hidden="true">*</span>}
      </label>
      {typeof children === 'function'
        ? children({ id: htmlFor, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })
        : children}
      {hint && <p id={hintId} className="text-[11px] leading-relaxed text-slate-500">{hint}</p>}
      {error && <p id={errorId} role="alert" className="text-[11px] leading-relaxed text-rose-300">{error}</p>}
    </div>
  );
};

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input: React.FC<InputProps> = ({ invalid = false, className = '', ...rest }) => (
  <input className={`${FIELD_BASE} h-9 ${fieldBorder(invalid)} ${className}`} {...rest} />
);

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea: React.FC<TextareaProps> = ({ invalid = false, className = '', ...rest }) => (
  <textarea className={`${FIELD_BASE} py-2 leading-relaxed ${fieldBorder(invalid)} ${className}`} {...rest} />
);

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select: React.FC<SelectProps> = ({ invalid = false, className = '', children, ...rest }) => (
  <select className={`${FIELD_BASE} h-9 ${fieldBorder(invalid)} ${className}`} {...rest}>
    {children}
  </select>
);
