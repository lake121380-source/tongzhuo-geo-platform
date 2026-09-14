import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { IconButton } from './Button';

/**
 * 全局提示（Design System · D0）。
 *
 * 审计发现全站**没有统一的成功/失败反馈**：批量操作用 `window.alert`，其余靠列表隐式变化
 * 或页面里的小字。用户做完一件事之后，往往要自己去找"到底成了没有"。
 *
 * 用法：
 *   const toast = useToast();
 *   toast.success('已发布', '文章已上线，可在公开站点看到');
 *   toast.error('发布失败', '质检未通过：3 处事实无来源');
 *
 * 约定：**成功给「下一步」，失败给「为什么 + 怎么办」**（后台提示的唯一标准）。
 */

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

interface ToastOptions {
  /** 一句话说清结果（"已发布"）。 */
  title: string;
  /** 补充：下一步做什么 / 为什么失败、怎么处理。 */
  description?: string;
  /** 一键撤销/跳转（可选）。 */
  action?: { label: string; onClick: () => void };
  /** 毫秒；不传则成功 4s、其它 8s（失败/警告需要更久才读得完）。 */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  tone: ToastTone;
}

interface ToastApi {
  success: (title: string, description?: string, action?: ToastOptions['action']) => void;
  error: (title: string, description?: string, action?: ToastOptions['action']) => void;
  warning: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TONE_STYLE: Record<ToastTone, { icon: React.ComponentType<{ className?: string }>; iconClass: string; bar: string }> = {
  success: { icon: CheckCircle2, iconClass: 'text-emerald-400', bar: 'bg-emerald-500' },
  error: { icon: XCircle, iconClass: 'text-rose-400', bar: 'bg-rose-500' },
  warning: { icon: AlertTriangle, iconClass: 'text-amber-400', bar: 'bg-amber-500' },
  info: { icon: Info, iconClass: 'text-indigo-400', bar: 'bg-indigo-500' },
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback((tone: ToastTone, title: string, description?: string, action?: ToastOptions['action'], duration?: number) => {
    const id = nextId.current++;
    setItems((prev) => [...prev.slice(-3), { id, tone, title, description, action }]); // 最多同时 4 条
    const ms = duration ?? (tone === 'success' ? 4000 : 8000);
    timers.current.set(id, window.setTimeout(() => dismiss(id), ms));
  }, [dismiss]);

  const api = useMemo<ToastApi>(() => ({
    success: (title, description, action) => push('success', title, description, action),
    error: (title, description, action) => push('error', title, description, action),
    warning: (title, description) => push('warning', title, description),
    info: (title, description) => push('info', title, description),
    dismiss,
  }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* 提示宿主：右下角，最多叠 4 条。role=status 让读屏念出结果。 */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[90] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
        {items.map((item) => {
          const tone = TONE_STYLE[item.tone];
          const Icon = tone.icon;
          return (
            <div
              key={item.id}
              role="status"
              aria-live="polite"
              className="pointer-events-auto relative overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-lg"
            >
              <span className={`absolute inset-y-0 left-0 w-1 ${tone.bar}`} aria-hidden="true" />
              <div className="flex items-start gap-2.5 py-3 pl-4 pr-2">
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone.iconClass}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-white">{item.title}</p>
                  {item.description && <p className="mt-1 text-[11px] leading-relaxed text-slate-300">{item.description}</p>}
                  {item.action && (
                    <button
                      type="button"
                      onClick={() => { item.action?.onClick(); dismiss(item.id); }}
                      className="mt-1.5 text-[11px] font-semibold text-indigo-300 underline underline-offset-2 hover:text-indigo-200"
                    >
                      {item.action.label}
                    </button>
                  )}
                </div>
                <IconButton label="关闭提示" icon={XCircle} size="sm" onClick={() => dismiss(item.id)} className="mt-0.5" />
              </div>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

/** 取全局提示 API；没挂 Provider 时返回一个空实现（避免为了提示把组件树炸掉）。 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  const noop = useCallback(() => {}, []);
  return ctx ?? { success: noop, error: noop, warning: noop, info: noop, dismiss: noop };
}
