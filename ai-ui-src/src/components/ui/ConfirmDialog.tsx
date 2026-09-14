import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './Button';
import { Modal } from './Modal';

/**
 * 确认对话框（Design System · D0）。
 *
 * 审计发现全站 **15 处 `window.confirm`**：样式不可控、在部分内嵌浏览器里根本不渲染
 * （AGENTS.md 有记载：原生 confirm 在内嵌浏览器 1ms 返回，等于没有确认），
 * 而且无法说清"删了之后能不能恢复"。
 *
 * 用法：
 *   const confirm = useConfirm();
 *   if (await confirm({ title: '删除这篇文章？', description: '移入回收站，30 天内可恢复。', confirmLabel: '删除', tone: 'danger' })) { ... }
 */

interface ConfirmOptions {
  title: string;
  /** 说清后果与可逆性（"移入回收站，可恢复" / "永久删除，不可撤销"）。 */
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<{ options: ConfirmOptions; resolve: (value: boolean) => void } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const confirm = useCallback<ConfirmFn>((options) => new Promise<boolean>((resolve) => {
    // 已有待确认的对话框时，先把上一个按"取消"收掉，避免 Promise 永远悬着。
    if (stateRef.current) stateRef.current.resolve(false);
    setState({ options, resolve });
  }), []);

  const settle = useCallback((value: boolean) => {
    setState((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  const value = useMemo(() => confirm, [confirm]);
  const options = state?.options;

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Modal
        open={state !== null}
        onClose={() => settle(false)}
        size="sm"
        title={options?.title ?? ''}
        headerExtra={<AlertTriangle className={`h-4 w-4 ${options?.tone === 'danger' ? 'text-rose-400' : 'text-amber-400'}`} />}
        footer={<>
          <Button variant="secondary" onClick={() => settle(false)}>
            {options?.cancelLabel ?? '取消'}
          </Button>
          <Button
            variant={options?.tone === 'danger' ? 'danger' : 'primary'}
            onClick={() => settle(true)}
            data-autofocus
          >
            {options?.confirmLabel ?? '确定'}
          </Button>
        </>}
      >
        {options?.description && <p className="text-xs leading-relaxed text-slate-300">{options.description}</p>}
      </Modal>
    </ConfirmContext.Provider>
  );
};

/** 取确认 API。**没挂 Provider 时退回原生 confirm**——宁可样式差，也不能让"删除"静默通过。 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  return useCallback<ConfirmFn>((options) => {
    if (ctx) return ctx(options);
    const text = options.description ? `${options.title}\n\n${options.description}` : options.title;
    return Promise.resolve(window.confirm(text));
  }, [ctx]);
}
