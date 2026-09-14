import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './Button';

/**
 * 弹窗与抽屉（Design System · D0）。
 *
 * 审计发现：全站 21 处手写遮罩（`fixed inset-0`），行为各不一样——
 * 生成弹窗点遮罩能关，**文章详情弹窗按 Esc 关不掉**（真机验证），关闭按钮普遍没有
 * `aria-label`。用户对"弹窗"的预期是固定的：**Esc 关、点遮罩关、有明确的 ✕**。
 *
 * 这里把它固定下来。注意焦点：打开时把焦点移进面板（Esc 才有落点），关闭后还原到
 * 打开前的元素。完整 focus trap 暂不做（后台以鼠标操作为主），但语义与键盘出口必须对。
 */

function useModalBehavior(open: boolean, onClose: () => void, panelRef: React.RefObject<HTMLElement | null>) {
  // Esc 关闭：用户按 Esc 时**不该**被弹窗吃掉。仅在打开时挂监听。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // 打开时聚焦面板（否则 Esc 监听到的焦点在页面上、读屏也读不到新内容）；
  // 关闭后把焦点还给打开它的那个元素。
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // 子元素可以用 data-autofocus 声明「我才是初始焦点」（例如确认框的「确定」按钮）；
    // 没有声明时聚焦面板本身，保证 Esc 与读屏有落点。
    const preferred = panelRef.current?.querySelector<HTMLElement>('[data-autofocus]');
    (preferred ?? panelRef.current)?.focus();
    return () => previouslyFocused?.focus?.();
  }, [open, panelRef]);
}

const SIZES = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-3xl', xl: 'max-w-5xl' } as const;

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** 头部右侧的额外内容（徽标/次要动作），✕ 永远在最右。 */
  headerExtra?: React.ReactNode;
  /** 底部操作区（通常是「取消 + 主操作」）。 */
  footer?: React.ReactNode;
  size?: keyof typeof SIZES;
  /** 点遮罩是否关闭（默认 true；填写到一半的表单建议 false）。 */
  closeOnBackdrop?: boolean;
  children: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  description,
  headerExtra,
  footer,
  size = 'md',
  closeOnBackdrop = true,
  children,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalBehavior(open, onClose, panelRef);
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-3 backdrop-blur-sm sm:p-6"
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onClick={(event) => event.stopPropagation()}
        className={`my-auto flex max-h-[90vh] w-full ${SIZES[size]} flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl outline-none`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 bg-slate-950/40 p-4 sm:p-5">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-white">{title}</h2>
            {description && <p className="mt-1 text-xs leading-relaxed text-slate-400">{description}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerExtra}
            <IconButton label="关闭弹窗" icon={X} onClick={onClose} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-slate-200 sm:p-5">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-800 bg-slate-950/40 p-4 sm:px-5">{footer}</div>
        )}
      </div>
    </div>
  );
};

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  /** 宽度档位。 */
  size?: 'md' | 'lg';
  children: React.ReactNode;
}

/** 右侧抽屉：用于"看详情不离开列表"的场景（列表页的详情面板统一用它）。 */
export const Drawer: React.FC<DrawerProps> = ({
  open,
  onClose,
  title,
  description,
  footer,
  size = 'md',
  children,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalBehavior(open, onClose, panelRef);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onClick={(event) => event.stopPropagation()}
        className={`flex h-full w-full ${size === 'lg' ? 'max-w-3xl' : 'max-w-xl'} flex-col border-l border-slate-700 bg-slate-900 shadow-2xl outline-none`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 p-4 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-white">{title}</h2>
            {description && <p className="mt-1 text-xs text-slate-400">{description}</p>}
          </div>
          <IconButton label="关闭面板" icon={X} onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-800 p-4 sm:px-5">{footer}</div>
        )}
      </div>
    </div>
  );
};
