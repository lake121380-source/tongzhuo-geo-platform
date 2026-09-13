import React from 'react';
import { CircleAlert, LockKeyhole } from 'lucide-react';

interface ApiUnavailableViewProps {
  title: string;
  description: string;
  lang: 'zh' | 'en';
}

/**
 * Explicit boundary for UI modules that do not have a 桐灼GEO API v1
 * contract yet.  It is intentionally boring: an unavailable capability must
 * never render demo values or pretend that a write succeeded.
 */
export const ApiUnavailableView: React.FC<ApiUnavailableViewProps> = ({ title, description, lang }) => (
  <section className="mx-auto max-w-2xl rounded-2xl border border-amber-500/30 bg-slate-900/80 p-8 text-center shadow-xl">
    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-300">
      <LockKeyhole className="h-6 w-6" aria-hidden="true" />
    </div>
    <h1 className="text-lg font-bold text-white">{title}</h1>
    <p className="mt-2 text-sm leading-6 text-slate-300">{description}</p>
    <div className="mt-5 inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/70 px-3 py-2 text-xs text-slate-400">
      <CircleAlert className="h-4 w-4 text-amber-400" aria-hidden="true" />
      <span>
        {lang === 'zh'
          ? '当前 桐灼GEO API v1 尚未提供此能力，页面已安全禁用。'
          : '桐灼GEO API v1 does not expose this capability yet; the action is disabled safely.'}
      </span>
    </div>
  </section>
);

