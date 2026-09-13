import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Save, WandSparkles } from 'lucide-react';
import { GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';

interface SpecialPromptsPanelProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  canRead: boolean;
  canWrite: boolean;
}

const key = (prefix: string) => `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;

const TYPES = ['keyword', 'description'] as const;
type SpecialPromptType = typeof TYPES[number];

const TYPE_LABELS: Record<SpecialPromptType, { zh: string; en: string; hint: { zh: string; en: string } }> = {
  keyword: {
    zh: '关键词生成提示词',
    en: 'Keyword prompt',
    hint: {
      zh: '决定 AI 为标题/文章生成什么关键词。URL 导入流水线会把它拼进生成 prompt。',
      en: 'Drives which keywords the AI produces; the URL import pipeline feeds it into its prompt.',
    },
  },
  description: {
    zh: '文章描述提示词',
    en: 'Description prompt',
    hint: {
      zh: '决定文章描述（meta description）的写法与风格，同样被导入流水线消费。',
      en: 'Drives how article descriptions are written; also consumed by the import pipeline.',
    },
  },
};

/**
 * 特殊提示词（关键词 / 描述）。
 *
 * 这两类和普通提示词**不是一套语义**：保存时是「按类型整体覆盖」，读取时取「最新一条」。
 * 所以不能塞进通用的提示词编辑器——那样只能改某一条，历史重复记录会分叉出不同口径。
 *
 * 空内容表示「没配过」，此时流水线会回落到内置默认。所以「未配置」要如实显示，
 * 不要拿一段空文本框冒充已配置。
 */
const SpecialPromptsPanel: React.FC<SpecialPromptsPanelProps> = ({ apiClient, lang, canRead, canWrite }) => {
  const zh = lang === 'zh';
  const [configured, setConfigured] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiClient.listSpecialPrompts();
      const rows = Array.isArray(data.prompts) ? data.prompts as Array<Record<string, unknown>> : [];
      const nextConfigured: Record<string, boolean> = {};
      const nextDrafts: Record<string, string> = {};
      rows.forEach((row) => {
        const type = String(row.type ?? '');
        if (type === '') return;
        nextConfigured[type] = row.configured === true;
        nextDrafts[type] = String(row.content ?? '');
      });
      setConfigured(nextConfigured);
      setDrafts(nextDrafts);
    } catch (cause) {
      setError(describeApiError(cause, zh ? '读取特殊提示词失败' : 'Unable to load special prompts', lang));
    } finally {
      setLoading(false);
    }
  }, [apiClient, canRead, lang, zh]);

  useEffect(() => { void load(); }, [load]);

  const save = async (type: SpecialPromptType) => {
    if (busy || !canWrite) return;
    setBusy(type); setError(''); setNotice('');
    try {
      const data = await apiClient.saveSpecialPrompt(type, drafts[type] ?? '', { idempotencyKey: key(`special-prompt-${type}`) });
      setConfigured((previous) => ({ ...previous, [type]: data.configured === true }));
      setDrafts((previous) => ({ ...previous, [type]: String(data.content ?? '') }));
      setNotice(zh ? '已保存。' : 'Saved.');
    } catch (cause) {
      setError(describeApiError(cause, zh ? '保存失败' : 'Unable to save', lang));
    } finally {
      setBusy('');
    }
  };

  if (!canRead) return null;

  return (
    <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
      <h3 className="flex items-center gap-2 text-sm font-bold text-white">
        <WandSparkles className="h-4 w-4 text-fuchsia-400" />
        {zh ? '关键词与描述提示词' : 'Keyword & description prompts'}
      </h3>
      <p className="text-[11px] leading-relaxed text-slate-500">
        {zh
          ? '这两类提示词会被 URL 导入流水线真实消费，改了立刻影响之后生成的文案风格。保存是「按类型整体覆盖」，不是改某一条。'
          : 'These two feed the URL import pipeline directly. Saving overwrites every row of that type, not a single record.'}
      </p>

      {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">{notice}</div>}

      {loading ? (
        <div className="flex min-h-20 items-center justify-center text-xs text-slate-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{zh ? '读取中…' : 'Loading…'}</div>
      ) : TYPES.map((type) => (
        <div key={type} className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-200">{TYPE_LABELS[type][lang]}</span>
            {configured[type] === true
              ? <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">{zh ? '已配置' : 'Configured'}</span>
              : <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{zh ? '未配置（流水线用内置默认）' : 'Not configured (built-in default)'}</span>}
          </div>
          <p className="text-[10px] text-slate-500">{TYPE_LABELS[type].hint[lang]}</p>
          <textarea
            rows={6}
            disabled={!canWrite}
            value={drafts[type] ?? ''}
            onChange={(event) => setDrafts((previous) => ({ ...previous, [type]: event.target.value }))}
            className="w-full rounded-lg border border-slate-700 bg-slate-900 p-3 font-mono text-xs text-slate-200 disabled:opacity-60"
          />
          {canWrite && (
            <button type="button" onClick={() => void save(type)} disabled={busy === type} className="inline-flex items-center gap-1 rounded-lg bg-fuchsia-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-fuchsia-500 disabled:opacity-50">
              {busy === type ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}{zh ? '保存' : 'Save'}
            </button>
          )}
        </div>
      ))}
    </section>
  );
};

export default SpecialPromptsPanel;
