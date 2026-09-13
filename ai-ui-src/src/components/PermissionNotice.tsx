import React from 'react';
import { LockKeyhole, ShieldAlert } from 'lucide-react';

interface PermissionNoticeProps {
  lang: 'zh' | 'en';
  requiredScope?: string;
  /** Read access errors use the stronger alert treatment. */
  mode?: 'read' | 'write';
  className?: string;
}

/** A small, consistent explanation shown when a token cannot use a view/action. */
export const PermissionNotice: React.FC<PermissionNoticeProps> = ({
  lang,
  requiredScope,
  mode = 'write',
  className = '',
}) => {
  const isRead = mode === 'read';
  return (
    <div
      role={isRead ? 'alert' : 'status'}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
        isRead
          ? 'border-rose-500/40 bg-rose-950/35 text-rose-200'
          : 'border-amber-500/30 bg-amber-950/25 text-amber-200'
      } ${className}`}
    >
      {isRead ? <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /> : <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>
        {isRead
          ? (lang === 'zh' ? '当前 Token 没有读取此页面所需的权限，无法加载真实数据。' : 'Your token cannot read this page, so real data was not loaded.')
          : (lang === 'zh' ? '当前 Token 为只读，写入操作已禁用。' : 'Your token is read-only; write actions are disabled.')}
        {requiredScope && <span className="ml-1 opacity-80">{lang === 'zh' ? `需要「${requiredScope}」` : `(requires “${requiredScope}”)`}</span>}
      </span>
    </div>
  );
};

export default PermissionNotice;
