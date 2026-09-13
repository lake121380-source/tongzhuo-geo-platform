import React from 'react';
import { Loader2 } from 'lucide-react';

interface LoadingStateProps {
  lang: 'zh' | 'en';
  /** 具体在加载什么，例如「SEO 配置」「分析数据」。不传则用通用文案。 */
  label?: string;
  /**
   * `panel` = 占位一整块区域（居中、带边框，用于替换整页/整卡）；
   * `inline` = 行内小提示（用于表格空行、按钮旁）。
   */
  variant?: 'panel' | 'inline';
  className?: string;
}

/**
 * 统一的加载态：**转圈 + 文案**，而不是只有一行灰字。
 *
 * 只有文字时，操作员分不清「还在加载」和「坏了/没数据」——这个项目在 dev 环境下
 * 单请求基线约 2 秒（`php artisan serve` + CLI opcache 关闭，见 `docker/php/opcache-dev.ini`），
 * 首屏并发请求排队后更久，所以「看得出在转」比平时更重要。
 *
 * `role="status"` + `aria-live="polite"`：读屏会念出进度，且不会打断当前朗读。
 */
export const LoadingState: React.FC<LoadingStateProps> = ({ lang, label, variant = 'panel', className = '' }) => {
  const text = label ?? (lang === 'zh' ? '正在读取…' : 'Loading…');

  if (variant === 'inline') {
    return (
      <span role="status" aria-live="polite" className={`inline-flex items-center gap-1.5 text-xs text-slate-400 ${className}`}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        {text}
      </span>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center justify-center gap-2 rounded-xl border border-slate-800 bg-slate-900/70 p-8 text-sm text-slate-400 ${className}`}
    >
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {text}
    </div>
  );
};
