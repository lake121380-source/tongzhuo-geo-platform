import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';

interface TitleGenerationPanelProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  libraryId: string | number;
  libraryName: string;
  canWrite: boolean;
  /** 生成完成后回调，用来刷新标题库条目。 */
  onGenerated?: () => void;
}

const TITLE_STYLES = ['professional', 'attractive', 'seo', 'creative', 'question'] as const;

const STYLE_LABELS: Record<string, { zh: string; en: string }> = {
  professional: { zh: '专业严谨', en: 'Professional' },
  attractive: { zh: '吸引眼球', en: 'Attention-grabbing' },
  seo: { zh: 'SEO 优化', en: 'SEO' },
  creative: { zh: '创意新颖', en: 'Creative' },
  question: { zh: '疑问式', en: 'Question' },
};

const STATUS_LABELS: Record<string, { zh: string; en: string }> = {
  queued: { zh: '排队中', en: 'Queued' },
  running: { zh: '生成中', en: 'Running' },
  completed: { zh: '已完成', en: 'Completed' },
  partial: { zh: '部分完成', en: 'Partially completed' },
  failed: { zh: '已失败', en: 'Failed' },
  cancelled: { zh: '已取消', en: 'Cancelled' },
};

function idempotencyKey(prefix: string): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

function num(record: ApiRecord | null | undefined, key: string): number {
  const value = Number(record?.[key]);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 标题库的 AI 批量生成。
 *
 * 这是本域最重的一条链路：生成是**异步**的（建 run → 入队 → 分批出结果），
 * 所以界面必须按 run 的状态轮询，而不是等一个同步响应。
 *
 * 两道确认门禁由**服务端**判定（超量确认的阈值、关键词复用），前端不复制那套规则：
 * 界面上只把「要确认什么」讲清楚，真正的拦截看 `error.details.field_errors`。
 */
const TitleGenerationPanel: React.FC<TitleGenerationPanelProps> = ({
  apiClient, lang, libraryId, libraryName, canWrite, onGenerated,
}) => {
  const zh = lang === 'zh';
  const [open, setOpen] = useState(false);
  const [keywordLibraries, setKeywordLibraries] = useState<ApiRecord[]>([]);
  const [models, setModels] = useState<ApiRecord[]>([]);
  const [runs, setRuns] = useState<ApiRecord[]>([]);
  const [current, setCurrent] = useState<ApiRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState({
    keyword_library_id: '',
    ai_model_id: '',
    title_count: '20',
    title_style: 'professional',
    custom_prompt: '',
    confirmed_keyword_reuse: false,
    confirmed_large_run: false,
  });
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedKeywords = keywordLibraries.find((row) => String(row.id) === draft.keyword_library_id) || null;
  const keywordCount = num(selectedKeywords, 'item_count') || num(selectedKeywords, 'keyword_count');
  const wantsReuse = Number(draft.title_count) > keywordCount && keywordCount > 0;

  const applyRun = useCallback((run: ApiRecord | null) => {
    setCurrent(run);
    if (run) setRuns((previous) => [run, ...previous.filter((row) => String(row.id) !== String(run.id))].slice(0, 20));
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const data = await apiClient.listTitleGenerationRuns(libraryId);
      const list = Array.isArray(data.runs) ? (data.runs as ApiRecord[]) : [];
      setRuns(list);
      setCurrent((data.current as ApiRecord) ?? null);
    } catch {
      // 记录读取失败不该把整个面板变成错误态——生成入口仍然可用。
      setRuns([]);
      setCurrent(null);
    }
  }, [apiClient, libraryId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    void Promise.all([
      apiClient.listMaterials('keyword-libraries', { per_page: 100 }),
      apiClient.listAiModels(),
    ])
      .then(([keywordResult, modelResult]) => {
        if (cancelled) return;
        const keywordItems = (keywordResult as { items?: ApiRecord[] }).items ?? [];
        setKeywordLibraries(keywordItems);
        const chatModels = ((modelResult as { items?: ApiRecord[] }).items ?? [])
          .filter((model) => String(model.model_type ?? 'chat') === 'chat');
        setModels(chatModels);
        setDraft((previous) => ({
          ...previous,
          keyword_library_id: previous.keyword_library_id || (keywordItems[0] ? String(keywordItems[0].id) : ''),
          ai_model_id: previous.ai_model_id || (chatModels[0] ? String(chatModels[0].id) : ''),
        }));
      })
      .catch((loadError) => {
        if (!cancelled) setError(describeApiError(loadError, zh ? '加载生成配置失败' : 'Unable to load generation options', lang));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    void loadRuns();
    return () => { cancelled = true; };
  }, [apiClient, lang, loadRuns, open, zh]);

  // 按服务端给的节奏轮询：它知道配额等待要等多久（quota_wait 会给 5 分钟）。
  useEffect(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    if (!open || !current?.active) return;
    const delay = Math.max(1500, num(current, 'next_poll_ms') || 2500);
    pollTimer.current = setTimeout(() => { void loadRuns().then(() => onGenerated?.()); }, delay);
    return () => { if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, [current, loadRuns, onGenerated, open]);

  const fieldError = (key: string): string => fieldErrors[key] ?? '';

  const start = async () => {
    if (busy) return;
    setBusy('start');
    setError('');
    setFieldErrors({});
    try {
      const data = await apiClient.startTitleGeneration(libraryId, {
        keyword_library_id: Number(draft.keyword_library_id),
        ai_model_id: Number(draft.ai_model_id),
        title_count: Number(draft.title_count),
        title_style: draft.title_style,
        custom_prompt: draft.custom_prompt,
        confirmed_keyword_reuse: draft.confirmed_keyword_reuse ? 1 : 0,
        confirmed_large_run: draft.confirmed_large_run ? 1 : 0,
      }, { idempotencyKey: idempotencyKey(`title-generation-${libraryId}`) });
      applyRun((data.run as ApiRecord) ?? null);
    } catch (startError) {
      const details = (startError as { details?: { field_errors?: Record<string, string> } })?.details;
      if (details?.field_errors) setFieldErrors(details.field_errors);
      setError(describeApiError(startError, zh ? '提交生成失败' : 'Unable to start generation', lang));
    } finally {
      setBusy('');
    }
  };

  const runAction = async (action: 'retry' | 'cancel', runId: string | number) => {
    if (busy) return;
    setBusy(action);
    setError('');
    try {
      const data = action === 'retry'
        ? await apiClient.retryTitleGeneration(libraryId, runId, { idempotencyKey: idempotencyKey(`title-retry-${runId}`) })
        : await apiClient.cancelTitleGeneration(libraryId, runId, { idempotencyKey: idempotencyKey(`title-cancel-${runId}`) });
      applyRun((data.run as ApiRecord) ?? null);
      void loadRuns();
    } catch (actionError) {
      setError(describeApiError(actionError, zh ? '操作失败' : 'Operation failed', lang));
    } finally {
      setBusy('');
    }
  };

  const statusText = current ? (STATUS_LABELS[String(current.status)]?.[lang] ?? String(current.status)) : '';

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
          {zh ? 'AI 批量生成标题' : 'Generate titles with AI'}
          {current && (
            <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] ${current.active ? 'bg-indigo-500/20 text-indigo-300' : 'bg-slate-800 text-slate-400'}`}>
              {statusText}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {current?.active && canWrite && (
            <button type="button" onClick={() => void runAction('cancel', String(current.id))} disabled={busy === 'cancel'} className="text-[11px] text-rose-300 hover:text-rose-200 disabled:opacity-50">
              {zh ? '取消生成' : 'Cancel'}
            </button>
          )}
          {!current?.active && current?.retryable === true && canWrite && (
            <button type="button" onClick={() => void runAction('retry', String(current.id))} disabled={busy === 'retry'} className="inline-flex items-center gap-1 text-[11px] text-amber-300 hover:text-amber-200 disabled:opacity-50">
              <RefreshCw className="h-3 w-3" />{zh ? '重试' : 'Retry'}
            </button>
          )}
          <button type="button" onClick={() => setOpen((previous) => !previous)} className="text-[11px] text-indigo-300 hover:text-indigo-200">
            {open ? (zh ? '收起' : 'Hide') : (zh ? '配置' : 'Configure')}
          </button>
        </div>
      </div>

      {current && (
        <div className="mt-3 space-y-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${Math.min(100, num(current, 'progress_percent'))}%` }} />
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-400">
            <span>{zh ? '目标' : 'Target'} {num(current, 'requested_count')}</span>
            <span>{zh ? '已生成' : 'Generated'} {num(current, 'generated_count')}</span>
            <span>{zh ? '已入库' : 'Saved'} {num(current, 'saved_count')}</span>
            <span>{zh ? '重复' : 'Duplicates'} {num(current, 'duplicate_count')}</span>
            <span>{zh ? '无效' : 'Invalid'} {num(current, 'invalid_count')}</span>
          </div>
          {typeof current.notice === 'string' && current.notice !== '' && <div className="text-[11px] text-amber-300">{current.notice}</div>}
          {typeof current.last_error === 'string' && current.last_error !== '' && <div className="text-[11px] text-rose-300">{current.last_error}</div>}
        </div>
      )}

      {open && (
        <div className="mt-3 space-y-3 border-t border-slate-800 pt-3">
          {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-[11px] text-rose-200">{error}</div>}
          {loading ? (
            <div className="flex items-center gap-2 text-[11px] text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />{zh ? '加载配置…' : 'Loading options…'}</div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="text-[11px] text-slate-400">
                  {zh ? '关键词库' : 'Keyword library'}
                  <select value={draft.keyword_library_id} onChange={(event) => setDraft((previous) => ({ ...previous, keyword_library_id: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white">
                    {keywordLibraries.length === 0 && <option value="">{zh ? '没有可用的关键词库' : 'No keyword library'}</option>}
                    {keywordLibraries.map((library) => (
                      <option key={String(library.id)} value={String(library.id)}>
                        {String(library.name)}（{num(library, 'item_count') || num(library, 'keyword_count')} {zh ? '词' : 'keywords'}）
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-[11px] text-slate-400">
                  {zh ? 'AI 模型' : 'AI model'}
                  <select value={draft.ai_model_id} onChange={(event) => setDraft((previous) => ({ ...previous, ai_model_id: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white">
                    {models.length === 0 && <option value="">{zh ? '没有可用的对话模型' : 'No chat model available'}</option>}
                    {models.map((model) => <option key={String(model.id)} value={String(model.id)}>{String(model.name)}</option>)}
                  </select>
                </label>
                <label className="text-[11px] text-slate-400">
                  {zh ? '生成数量' : 'How many'}
                  <input type="number" min={1} value={draft.title_count} onChange={(event) => setDraft((previous) => ({ ...previous, title_count: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" />
                </label>
                <label className="text-[11px] text-slate-400">
                  {zh ? '标题风格' : 'Style'}
                  <select value={draft.title_style} onChange={(event) => setDraft((previous) => ({ ...previous, title_style: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white">
                    {TITLE_STYLES.map((style) => <option key={style} value={style}>{STYLE_LABELS[style][lang]}</option>)}
                  </select>
                </label>
              </div>

              <label className="block text-[11px] text-slate-400">
                {zh ? '自定义提示词（可选）' : 'Custom prompt (optional)'}
                <textarea value={draft.custom_prompt} onChange={(event) => setDraft((previous) => ({ ...previous, custom_prompt: event.target.value }))} rows={3} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-xs text-white" />
              </label>

              <div className="space-y-2">
                <label className={`flex items-start gap-2 text-[11px] ${wantsReuse ? 'text-amber-300' : 'text-slate-400'}`}>
                  <input type="checkbox" checked={draft.confirmed_keyword_reuse} onChange={(event) => setDraft((previous) => ({ ...previous, confirmed_keyword_reuse: event.target.checked }))} className="mt-0.5 accent-indigo-500" />
                  <span>
                    {zh ? '允许复用关键词' : 'Allow reusing keywords'}
                    {wantsReuse && <span className="ml-1">{zh ? `（目标 ${draft.title_count} 条 > 词库 ${keywordCount} 词，服务端会要求确认）` : `(target ${draft.title_count} > ${keywordCount} keywords; server will require this)`}</span>}
                    {fieldError('confirmed_keyword_reuse') && <span className="ml-1 text-rose-300">{fieldError('confirmed_keyword_reuse')}</span>}
                  </span>
                </label>
                <label className="flex items-start gap-2 text-[11px] text-slate-400">
                  <input type="checkbox" checked={draft.confirmed_large_run} onChange={(event) => setDraft((previous) => ({ ...previous, confirmed_large_run: event.target.checked }))} className="mt-0.5 accent-indigo-500" />
                  <span>
                    {zh ? '确认这是一次大型生成（耗时更长、模型费用更高）' : 'Confirm this is a large run (slower, higher model cost)'}
                    {fieldError('confirmed_large_run') && <span className="ml-1 text-rose-300">{fieldError('confirmed_large_run')}</span>}
                  </span>
                </label>
              </div>

              {keywordCount === 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-200">
                  {zh
                    ? `「${libraryName}」里还没有关键词——先去「素材库 → 关键词库」添加，AI 才能按词生成标题。`
                    : `"${libraryName}" has no keywords yet. Add some under Materials → Keyword library first.`}
                </div>
              )}

              <button
                type="button"
                onClick={() => void start()}
                disabled={busy === 'start' || !canWrite || current?.active === true || draft.keyword_library_id === '' || draft.ai_model_id === '' || keywordCount === 0}
                className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {busy === 'start' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
                {current?.active ? (zh ? '已有进行中的生成任务' : 'A run is already active') : (zh ? `为「${libraryName}」生成` : `Generate for "${libraryName}"`)}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default TitleGenerationPanel;
