import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Ban, Check, ChevronLeft, ChevronRight, GitBranch, Loader2, Merge, Pencil, Plus, RefreshCw, ShieldCheck, Sparkles, Split, X } from 'lucide-react';
import { GeoFlowApiClient, MutationOptions, ApiRecord, KnowledgeFactGenerationConflict, KnowledgeFactGenerationRun } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';

type Lang = 'zh' | 'en';

interface KnowledgeFactWorkbenchProps {
  apiClient: GeoFlowApiClient;
  knowledgeBaseId: string;
  chunks: Array<{ id: string; title: string; content: string }>;
  lang: Lang;
  canRead?: boolean;
  canWrite?: boolean;
}

type FactValue = {
  id: number;
  fact_id: number;
  canonical_value?: { value?: string; unit?: string | null };
  canonical_answer?: string;
  review_status?: string;
  conflict_status?: string;
  lock_version?: number;
  evidences?: Array<{ id: number; knowledge_chunk_id?: number | null; excerpt?: string; is_primary?: boolean }>;
};

type Fact = {
  id: number;
  stable_key: string;
  label: string;
  subject: string;
  predicate: string;
  value_type: string;
  review_status?: string;
  is_enabled?: boolean;
  lock_version?: number;
  values?: FactValue[];
};

type Workbench = {
  library?: {
    id?: number;
    summary?: Record<string, unknown>;
    publish_readiness?: { ready?: boolean; blockers?: string[] };
  };
  items?: Fact[];
  pagination?: { page?: number; per_page?: number; total?: number; total_pages?: number };
  revisions?: Array<{ id: number; version: number; published_at?: string | null; restored_from_revision_id?: number | null }>;
  generation_runs?: KnowledgeFactGenerationRun[];
};

const emptyFact = { stable_key: '', label: '', subject: '', predicate: '', value_type: 'string' };

/** Run statuses the server still considers in-flight (and still pollable). */
const ACTIVE_RUN_STATUSES = ['queued', 'running'];

/** The server refuses `initial` once a library already holds enabled facts. */
function generationModes(factCount: number): string[] {
  return factCount > 0 ? ['supplement', 'refresh_stale'] : ['initial', 'supplement', 'refresh_stale'];
}

function asRecord(value: unknown): ApiRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
}

function asWorkbench(value: unknown): Workbench {
  const row = asRecord(value);
  return {
    library: asRecord(row.library) as Workbench['library'],
    items: Array.isArray(row.items) ? row.items as Fact[] : [],
    pagination: asRecord(row.pagination) as Workbench['pagination'],
    revisions: Array.isArray(row.revisions) ? row.revisions as Workbench['revisions'] : [],
    generation_runs: Array.isArray(row.generation_runs) ? row.generation_runs as KnowledgeFactGenerationRun[] : [],
  };
}

function key(prefix: string): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `${prefix}-${crypto.randomUUID()}`;
  } catch { /* use the fallback below */ }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A bare UUID. The fact-generation endpoint validates `request_key` as a UUID
 * (not a free-form key), so the idempotency-key format used elsewhere is not
 * accepted here.
 */
function rawUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* use the fallback below */ }
  const hex = '0123456789abcdef';
  let out = '';
  for (let index = 0; index < 36; index += 1) {
    if (index === 8 || index === 13 || index === 18 || index === 23) out += '-';
    else if (index === 14) out += '4';
    else if (index === 19) out += hex[(Math.random() * 4 | 0) + 8];
    else out += hex[Math.random() * 16 | 0];
  }
  return out;
}

function statusLabel(status: unknown, lang: Lang): string {
  const value = String(status || 'draft');
  if (lang === 'en') return value;
  return ({ reviewed: '已审核', rejected: '已拒绝', draft: '草稿', clear: '无冲突', unresolved: '有冲突' } as Record<string, string>)[value] || value;
}

/** Generation-run statuses, which share no vocabulary with fact statuses. */
function runStatusLabel(status: unknown, lang: Lang): string {
  const value = String(status || '');
  if (lang === 'en') return value;
  return ({
    queued: '排队中', running: '生成中', finalizing: '收尾中', completed: '已完成',
    partial: '部分完成', failed: '失败', cancelled: '已取消', obsolete: '已作废',
  } as Record<string, string>)[value] || value;
}

function generationModeLabel(mode: string, lang: Lang): string {
  if (lang === 'en') return mode;
  return ({ initial: '首次生成（需空库）', supplement: '补充生成', refresh_stale: '刷新过时事实' } as Record<string, string>)[mode] || mode;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The atomic-fact governance surface. It intentionally renders only server
 * projections and keeps every mutation behind the same idempotent API client
 * used by the rest of the React admin.
 */
export const KnowledgeFactWorkbench: React.FC<KnowledgeFactWorkbenchProps> = ({
  apiClient,
  knowledgeBaseId,
  chunks,
  lang,
  canRead = true,
  canWrite = true,
}) => {
  const [workbench, setWorkbench] = useState<Workbench>({ items: [], revisions: [] });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [factForm, setFactForm] = useState<Record<string, string> | null>(null);
  const [valueFactId, setValueFactId] = useState<number | null>(null);
  const [valueForm, setValueForm] = useState({ value: '', unit: '', answer: '' });
  const [evidenceTarget, setEvidenceTarget] = useState<{ valueId: number; chunkId: string } | null>(null);
  const [editFactId, setEditFactId] = useState<number | null>(null);
  const [editFactForm, setEditFactForm] = useState({ label: '', subject: '', predicate: '', value_type: 'string' });
  const [mergeFactId, setMergeFactId] = useState<number | null>(null);
  const [mergeTarget, setMergeTarget] = useState('');
  const [splitFactId, setSplitFactId] = useState<number | null>(null);
  const [splitForm, setSplitForm] = useState({ stable_key: '', label: '' });
  const [splitValueIds, setSplitValueIds] = useState<number[]>([]);
  const [editValueId, setEditValueId] = useState<number | null>(null);
  const [editValueForm, setEditValueForm] = useState({ value: '', unit: '', answer: '' });
  const [models, setModels] = useState<ApiRecord[]>([]);
  const [genForm, setGenForm] = useState({ mode: 'supplement', target_count: '10', ai_model_id: '' });
  const [genRun, setGenRun] = useState<KnowledgeFactGenerationRun | null>(null);
  // The run row and its rendered progress live in different halves of the
  // response envelope, so they are tracked separately.
  const [genPresented, setGenPresented] = useState<ApiRecord>({});
  const [newKeyFor, setNewKeyFor] = useState<string | null>(null);
  const [newKeyValue, setNewKeyValue] = useState('');
  const pollTimer = useRef<number | null>(null);

  const items = workbench.items || [];
  const selectedValueFact = useMemo(() => items.find((fact) => fact.id === valueFactId) || null, [items, valueFactId]);
  const pagination = workbench.pagination || {};
  const totalPages = Math.max(1, numberValue(pagination.total_pages, 1));
  const summary = workbench.library?.summary || {};
  const readiness = workbench.library?.publish_readiness || {};
  const factCount = numberValue(summary.fact_count, items.length);
  const activeRun = useMemo(
    () => (workbench.generation_runs || []).find((run) => ACTIVE_RUN_STATUSES.includes(String(run.status))) || null,
    [workbench.generation_runs],
  );
  // The server rejects `initial` once the library holds enabled facts, and it
  // only accepts chat models, so the pickers offer exactly what it will accept.
  const modeOptions = generationModes(factCount);
  // `initial` disappears from the picker once the library is non-empty, so fall
  // back to the first still-valid mode instead of rendering an empty select.
  const selectedMode = modeOptions.includes(genForm.mode) ? genForm.mode : modeOptions[0];
  const chatModels = useMemo(
    () => models.filter((model) => String(model.model_type || 'chat') === 'chat' && model.is_available !== false),
    [models],
  );
  const genConflicts = useMemo(() => {
    const raw = genRun?.conflicts;
    return Array.isArray(raw) ? raw as KnowledgeFactGenerationConflict[] : [];
  }, [genRun]);

  const request = async (method: string, ...args: unknown[]): Promise<any> => {
    const client = apiClient as any;
    const operation = client[method];
    if (typeof operation !== 'function') throw new Error(lang === 'zh' ? '事实工作台接口尚未加载' : 'Fact workbench API is not available');
    return operation.apply(client, args);
  };

  const load = async (targetPage = page) => {
    if (!canRead || !knowledgeBaseId) return;
    setLoading(true);
    setError('');
    try {
      const result = await request('getKnowledgeFactWorkbench', knowledgeBaseId, { page: targetPage, per_page: 20 });
      setWorkbench(asWorkbench(result));
      setPage(numberValue(asRecord(result).pagination && asRecord(asRecord(result).pagination).page, targetPage));
      if (valueFactId !== null && !(Array.isArray(asRecord(result).items) && (asRecord(result).items as Fact[]).some((fact) => fact.id === valueFactId))) setValueFactId(null);
    } catch (loadError) {
      setError(describeApiError(loadError, lang === 'zh' ? '事实工作台加载失败' : 'Unable to load fact workbench', lang));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setPage(1);
    setWorkbench({ items: [], revisions: [] });
    setValueFactId(null);
    if (canRead && knowledgeBaseId) void load(1);
    // `load` intentionally reads the current client and selected base.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knowledgeBaseId, canRead]);

  const run = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(lang === 'zh' ? '操作已提交并由后端确认' : 'Operation accepted by the backend');
      await load(page);
    } catch (operationError) {
      setError(describeApiError(operationError, lang === 'zh' ? '操作失败' : 'Operation failed', lang));
    } finally {
      setBusy('');
    }
  };

  const createFact = () => {
    if (!canWrite) return;
    setFactForm({ ...emptyFact });
    setError('');
  };

  const submitFact = async () => {
    if (!factForm) return;
    await run('create-fact', async () => {
      await request('createKnowledgeFact', knowledgeBaseId, factForm, { idempotencyKey: key('fact-create') } as MutationOptions);
      setFactForm(null);
    });
  };

  const submitValue = async () => {
    if (!selectedValueFact || !valueForm.value.trim() || !valueForm.answer.trim()) return;
    await run('create-value', async () => {
      await request('createKnowledgeFactValue', knowledgeBaseId, selectedValueFact.id, {
        canonical_value_json: { value: valueForm.value.trim(), unit: valueForm.unit.trim() || null },
        canonical_answer: valueForm.answer.trim(),
      }, { idempotencyKey: key('fact-value-create') } as MutationOptions);
      setValueFactId(null);
      setValueForm({ value: '', unit: '', answer: '' });
    });
  };

  const review = (fact: Fact) => run(`review-${fact.id}`, () => request('reviewKnowledgeFact', knowledgeBaseId, fact.id, {
    lock_version: numberValue(fact.lock_version, 1),
    review_status: 'reviewed',
  }, { idempotencyKey: key('fact-review') } as MutationOptions));

  const addEvidence = async () => {
    if (!evidenceTarget?.chunkId) return;
    await run(`evidence-${evidenceTarget.valueId}`, async () => {
      await request('createKnowledgeFactEvidence', knowledgeBaseId, evidenceTarget.valueId, {
        knowledge_chunk_id: numberValue(evidenceTarget.chunkId),
        is_primary: true,
      }, { idempotencyKey: key('fact-evidence') } as MutationOptions);
      setEvidenceTarget(null);
    });
  };

  const publish = () => run('publish', () => request('publishKnowledgeFacts', knowledgeBaseId, { idempotencyKey: key('fact-publish') } as MutationOptions));
  const restore = (revisionId: number) => run(`restore-${revisionId}`, () => request('restoreKnowledgeFactRevision', knowledgeBaseId, revisionId, { idempotencyKey: key('fact-restore') } as MutationOptions));

  const loadModels = async () => {
    try {
      const result = await request('listAiModels');
      setModels(Array.isArray(asRecord(result).items) ? asRecord(result).items as ApiRecord[] : []);
    } catch {
      // The generation picker stays disabled with an explicit hint; nothing else
      // in the workbench depends on the model list.
      setModels([]);
    }
  };

  useEffect(() => {
    if (canWrite && apiClient) void loadModels();
    // Models are only needed by the generation picker and change rarely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canWrite, apiClient]);

  const applyGenerationResponse = (result: unknown) => {
    const payload = asRecord(result);
    setGenRun(asRecord(payload.run) as KnowledgeFactGenerationRun);
    setGenPresented(asRecord(payload.presented));
  };

  const refreshGeneration = async (runId: number) => {
    const result = await request('getKnowledgeFactGeneration', knowledgeBaseId, runId);
    const run = asRecord(asRecord(result).run) as KnowledgeFactGenerationRun;
    applyGenerationResponse(result);
    // A finished run has already written its candidates, so pull the fact list
    // again to show them instead of waiting for the next manual refresh.
    if (!ACTIVE_RUN_STATUSES.includes(String(run.status))) await load(page);
  };

  useEffect(() => {
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
    const runId = genRun?.id;
    if (!runId || !ACTIVE_RUN_STATUSES.includes(String(genRun?.status))) return undefined;
    pollTimer.current = window.setTimeout(() => {
      void refreshGeneration(runId).catch((pollError) => {
        setError(describeApiError(pollError, lang === 'zh' ? '事实生成状态刷新失败' : 'Unable to refresh generation status', lang));
      });
    }, 2000);
    return () => {
      if (pollTimer.current !== null) {
        window.clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    };
    // Depends only on the run identity and status so each poll schedules exactly one follow-up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genRun?.id, genRun?.status]);

  const startGeneration = async () => {
    if (!genForm.ai_model_id) return;
    await run('fact-generation-start', async () => {
      const result = await request('startKnowledgeFactGeneration', knowledgeBaseId, {
        mode: selectedMode,
        target_count: numberValue(genForm.target_count, 10),
        ai_model_id: numberValue(genForm.ai_model_id),
        request_key: rawUuid(),
      }, { idempotencyKey: key('fact-generation') } as MutationOptions);
      applyGenerationResponse(result);
    });
  };

  const cancelGeneration = async (runId: number) => {
    await run(`fact-generation-cancel-${runId}`, async () => {
      const result = await request('cancelKnowledgeFactGeneration', knowledgeBaseId, runId, { idempotencyKey: key('fact-generation-cancel') } as MutationOptions);
      applyGenerationResponse(result);
    });
  };

  const resolveConflict = async (candidateKey: string, action: string, stableKey?: string) => {
    const runId = genRun?.id;
    if (!runId) return;
    await run(`fact-generation-resolve-${candidateKey}`, async () => {
      const result = await request('resolveKnowledgeFactGeneration', knowledgeBaseId, runId, {
        action,
        candidate_key: candidateKey,
        ...(action === 'create_with_new_key' && stableKey ? { stable_key: stableKey } : {}),
      }, { idempotencyKey: key('fact-generation-resolve') } as MutationOptions);
      applyGenerationResponse(result);
    });
  };

  const archiveFact = (fact: Fact) => run(`archive-fact-${fact.id}`, () => request(
    'archiveKnowledgeFact', knowledgeBaseId, fact.id, numberValue(fact.lock_version, 1),
    { idempotencyKey: key('fact-archive') } as MutationOptions,
  ));

  const openFactEditor = (fact: Fact) => {
    setEditFactId(fact.id);
    setEditFactForm({
      label: fact.label || '',
      subject: fact.subject || '',
      predicate: fact.predicate || '',
      value_type: fact.value_type || 'string',
    });
    setError('');
  };

  const submitFactEditor = async (fact: Fact) => {
    await run(`edit-fact-${fact.id}`, async () => {
      await request('updateKnowledgeFact', knowledgeBaseId, fact.id, {
        lock_version: numberValue(fact.lock_version, 1),
        ...editFactForm,
      }, { idempotencyKey: key('fact-update') } as MutationOptions);
      setEditFactId(null);
    });
  };

  const submitMerge = async (fact: Fact) => {
    if (!mergeTarget) return;
    await run(`merge-fact-${fact.id}`, async () => {
      await request('mergeKnowledgeFact', knowledgeBaseId, fact.id, numberValue(mergeTarget), { idempotencyKey: key('fact-merge') } as MutationOptions);
      setMergeFactId(null);
      setMergeTarget('');
    });
  };

  const submitSplit = async (fact: Fact) => {
    if (splitValueIds.length === 0 || !splitForm.stable_key.trim() || !splitForm.label.trim()) return;
    await run(`split-fact-${fact.id}`, async () => {
      await request('splitKnowledgeFact', knowledgeBaseId, fact.id, {
        value_ids: splitValueIds,
        stable_key: splitForm.stable_key.trim(),
        label: splitForm.label.trim(),
      }, { idempotencyKey: key('fact-split') } as MutationOptions);
      setSplitFactId(null);
      setSplitValueIds([]);
      setSplitForm({ stable_key: '', label: '' });
    });
  };

  const openValueEditor = (value: FactValue) => {
    setEditValueId(value.id);
    setEditValueForm({
      value: value.canonical_value?.value || '',
      unit: value.canonical_value?.unit || '',
      answer: value.canonical_answer || '',
    });
    setError('');
  };

  const submitValueEditor = async (value: FactValue) => {
    if (!editValueForm.value.trim() || !editValueForm.answer.trim()) return;
    await run(`edit-value-${value.id}`, async () => {
      await request('updateKnowledgeFactValue', knowledgeBaseId, value.id, {
        lock_version: numberValue(value.lock_version, 1),
        canonical_value_json: { value: editValueForm.value.trim(), unit: editValueForm.unit.trim() || null },
        canonical_answer: editValueForm.answer.trim(),
      }, { idempotencyKey: key('fact-value-update') } as MutationOptions);
      setEditValueId(null);
    });
  };

  const archiveValue = (value: FactValue) => run(`archive-value-${value.id}`, () => request(
    'archiveKnowledgeFactValue', knowledgeBaseId, value.id, numberValue(value.lock_version, 1),
    { idempotencyKey: key('fact-value-archive') } as MutationOptions,
  ));

  if (!canRead) {
    return <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 px-4 py-4 text-xs text-rose-200">{lang === 'zh' ? '当前 Token 没有 materials:read，事实工作台不可用。' : 'The current token lacks materials:read; the fact workbench is unavailable.'}</div>;
  }

  return (
    <section className="bg-slate-900/80 p-5 rounded-2xl border border-slate-800 space-y-4" aria-label={lang === 'zh' ? '原子事实工作台' : 'Atomic fact workbench'}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 pb-3">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-cyan-400" />{lang === 'zh' ? '原子事实工作台' : 'Atomic fact workbench'}</h3>
          <p className="text-[11px] text-slate-400 mt-1">{lang === 'zh' ? '事实必须有可追溯证据并经过审核后才能发布。' : 'Facts require traceable evidence and review before publication.'}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void load(page)} disabled={loading} className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:border-cyan-500 disabled:opacity-50"><RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
          {canWrite && <button type="button" onClick={createFact} className="inline-flex items-center gap-1 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500"><Plus className="w-3.5 h-3.5" />{lang === 'zh' ? '新增事实' : 'Add fact'}</button>}
        </div>
      </div>

      {error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200"><AlertTriangle className="w-4 h-4 shrink-0" />{error}</div>}
      {notice && <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-200">{notice}</div>}

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center text-[11px]">
        {[
          ['事实', summary.fact_count], ['已启用', summary.enabled_count], ['待审核', summary.pending_count], ['冲突', summary.conflict_count], ['当前版本', summary.active_version],
        ].map(([label, value]) => <div key={String(label)} className="rounded-lg border border-slate-800 bg-slate-950/50 px-2 py-2"><div className="text-slate-500">{String(label)}</div><div className="mt-1 font-mono text-sm text-slate-100">{value === null || value === undefined ? '—' : String(value)}</div></div>)}
      </div>

      {readiness.ready === false && Array.isArray(readiness.blockers) && readiness.blockers.length > 0 && <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-xs text-amber-200"><div className="font-semibold">{lang === 'zh' ? '发布尚未就绪' : 'Publication is not ready'}</div><ul className="mt-1 list-disc pl-4">{readiness.blockers.slice(0, 5).map((blocker) => <li key={String(blocker)}>{String(blocker)}</li>)}</ul></div>}

      {canWrite && (
        <div className="rounded-xl border border-violet-500/30 bg-slate-950 p-3 space-y-3" aria-label={lang === 'zh' ? 'AI 事实生成' : 'AI fact generation'}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-violet-200">
              <Sparkles className="w-3.5 h-3.5" />
              {lang === 'zh' ? 'AI 事实生成' : 'AI fact generation'}
            </div>
            {(genRun || activeRun) && (
              <span className="text-[10px] text-slate-500">
                #{String((genRun || activeRun)?.id)} · {runStatusLabel((genRun || activeRun)?.status, lang)}
              </span>
            )}
          </div>

          {chatModels.length === 0 ? (
            <p className="text-[11px] text-amber-300">
              {lang === 'zh'
                ? '没有可用的对话模型。请先在「AI 模型」中添加并启用一条 chat 模型，生成才会可用。'
                : 'No available chat model. Add and enable a chat model under AI models first.'}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              <label className="text-[11px] text-slate-400">
                {lang === 'zh' ? '模式' : 'Mode'}
                <select
                  value={selectedMode}
                  onChange={(event) => setGenForm((current) => ({ ...current, mode: event.target.value }))}
                  className="mt-1 w-full rounded bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-white"
                >
                  {modeOptions.map((mode) => <option key={mode} value={mode}>{generationModeLabel(mode, lang)}</option>)}
                </select>
              </label>
              <label className="text-[11px] text-slate-400">
                {lang === 'zh' ? '目标条数' : 'Target count'}
                <input
                  type="number"
                  min={1}
                  value={genForm.target_count}
                  onChange={(event) => setGenForm((current) => ({ ...current, target_count: event.target.value }))}
                  className="mt-1 w-full rounded bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-white"
                />
              </label>
              <label className="text-[11px] text-slate-400">
                {lang === 'zh' ? '生成模型' : 'Model'}
                <select
                  value={genForm.ai_model_id}
                  onChange={(event) => setGenForm((current) => ({ ...current, ai_model_id: event.target.value }))}
                  className="mt-1 w-full rounded bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-white"
                >
                  <option value="">{lang === 'zh' ? '选择模型…' : 'Select a model…'}</option>
                  {chatModels.map((model) => (
                    <option key={String(model.id)} value={String(model.id)}>{String(model.name || model.model_id || model.id)}</option>
                  ))}
                </select>
              </label>
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => void startGeneration()}
                  disabled={!genForm.ai_model_id || busy === 'fact-generation-start' || Boolean(activeRun)}
                  className="w-full rounded bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-40"
                >
                  {busy === 'fact-generation-start' ? '…' : (lang === 'zh' ? '开始生成' : 'Start generation')}
                </button>
              </div>
            </div>
          )}

          {activeRun && !genRun && (
            <p className="text-[11px] text-slate-400">
              {lang === 'zh' ? '已有一个生成任务在运行；开始新的生成前请等待它结束或取消它。' : 'A generation run is already active; wait for it or cancel it before starting another.'}
            </p>
          )}

          {genRun && (
            <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/60 p-2.5">
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                <span>{lang === 'zh' ? '候选' : 'Candidates'}: <span className="font-mono text-slate-200">{numberValue(genRun.candidate_count)}</span></span>
                <span>{lang === 'zh' ? '冲突' : 'Conflicts'}: <span className="font-mono text-slate-200">{numberValue(genRun.conflict_count)}</span></span>
                {genRun.error_code ? <span className="text-rose-300">{String(genRun.error_code)}</span> : null}
              </div>
              {genRun.error_message ? <p className="text-[11px] text-rose-300">{String(genRun.error_message)}</p> : null}
              {ACTIVE_RUN_STATUSES.includes(String(genRun.status)) && (
                <div className="flex items-center gap-2">
                  <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded bg-slate-800">
                    <div className="h-full bg-violet-500 transition-all" style={{ width: `${Math.min(100, Math.max(0, numberValue(genPresented.progress_percent, 0)))}%` }} />
                  </div>
                  {genPresented.stage ? <span className="shrink-0 text-[10px] text-slate-500">{String(genPresented.stage)}</span> : null}
                  <button
                    type="button"
                    onClick={() => void cancelGeneration(genRun.id)}
                    disabled={busy === `fact-generation-cancel-${genRun.id}`}
                    className="inline-flex items-center gap-1 rounded border border-rose-500/30 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
                  >
                    <Ban className="w-3 h-3" />{lang === 'zh' ? '取消' : 'Cancel'}
                  </button>
                </div>
              )}

              {genConflicts.length > 0 && (
                <div className="space-y-2 border-t border-slate-800 pt-2">
                  <div className="text-[11px] font-semibold text-amber-200">
                    {lang === 'zh' ? `以下 ${genConflicts.length} 条候选与已有事实的稳定键重复，需要人工决定` : `${genConflicts.length} candidate(s) reuse an existing stable key; decide each one`}
                  </div>
                  {genConflicts.map((candidate) => (
                    <div key={candidate._candidate_key} className="rounded-lg border border-amber-500/20 bg-slate-950/60 px-2.5 py-2 space-y-1.5">
                      <div className="text-xs text-slate-200">
                        {candidate.label || candidate.stable_key}
                        <span className="ml-2 font-mono text-[10px] text-slate-500">{candidate.stable_key}</span>
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {[candidate.subject, candidate.predicate].filter(Boolean).join(' · ')}
                        {candidate.canonical_answer ? ` → ${candidate.canonical_answer}` : ''}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button type="button" onClick={() => void resolveConflict(candidate._candidate_key, 'discard')} disabled={Boolean(busy)} className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-slate-500 disabled:opacity-50">{lang === 'zh' ? '丢弃该候选' : 'Discard'}</button>
                        <button type="button" onClick={() => void resolveConflict(candidate._candidate_key, 'merge_as_value')} disabled={Boolean(busy)} className="rounded border border-cyan-500/30 px-2 py-1 text-[11px] text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-50">{lang === 'zh' ? '并入已有事实（作为新值）' : 'Merge as a new value'}</button>
                        <button type="button" onClick={() => { setNewKeyFor(candidate._candidate_key); setNewKeyValue(''); }} className="rounded border border-violet-500/30 px-2 py-1 text-[11px] text-violet-300 hover:bg-violet-500/10">{lang === 'zh' ? '用新稳定键新建' : 'Create with a new key'}</button>
                      </div>
                      {newKeyFor === candidate._candidate_key && (
                        <div className="flex flex-wrap gap-2">
                          <input
                            value={newKeyValue}
                            onChange={(event) => setNewKeyValue(event.target.value)}
                            placeholder={lang === 'zh' ? '新稳定键，如 company.founded_year' : 'New stable key, e.g. company.founded_year'}
                            className="min-w-0 flex-1 rounded bg-slate-950 border border-slate-700 px-2 py-1 text-[11px] text-white"
                          />
                          <button
                            type="button"
                            onClick={() => void resolveConflict(candidate._candidate_key, 'create_with_new_key', newKeyValue.trim()).then(() => setNewKeyFor(null))}
                            disabled={!/^[a-z0-9][a-z0-9._-]*$/.test(newKeyValue.trim()) || Boolean(busy)}
                            className="rounded bg-violet-600 px-2 py-1 text-[11px] text-white disabled:opacity-50"
                          >
                            {lang === 'zh' ? '确定新建' : 'Create'}
                          </button>
                          <button type="button" onClick={() => setNewKeyFor(null)} className="px-1 text-[11px] text-slate-500"><X className="w-3 h-3" /></button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {factForm && canWrite && <div className="rounded-xl border border-cyan-500/30 bg-slate-950 p-3 space-y-2"><div className="text-xs font-semibold text-cyan-200">{lang === 'zh' ? '新增事实（草稿）' : 'New fact (draft)'}</div><div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{[['stable_key', '稳定键'], ['label', '名称'], ['subject', '主体'], ['predicate', '谓词']].map(([field, label]) => <label key={field} className="text-[11px] text-slate-400">{lang === 'zh' ? label : field}<input value={factForm[field] || ''} onChange={(event) => setFactForm((current) => ({ ...(current || {}), [field]: event.target.value }))} className="mt-1 w-full rounded bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-white" /></label>)}<label className="text-[11px] text-slate-400">{lang === 'zh' ? '值类型' : 'Value type'}<select value={factForm.value_type} onChange={(event) => setFactForm((current) => ({ ...(current || {}), value_type: event.target.value }))} className="mt-1 w-full rounded bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-white"><option value="string">string</option><option value="integer">integer</option><option value="decimal">decimal</option><option value="date">date</option><option value="boolean">boolean</option><option value="url">url</option></select></label></div><div className="flex justify-end gap-2"><button type="button" onClick={() => setFactForm(null)} className="px-3 py-1.5 text-xs text-slate-400">{lang === 'zh' ? '取消' : 'Cancel'}</button><button type="button" onClick={() => void submitFact()} disabled={busy === 'create-fact'} className="rounded bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{busy === 'create-fact' ? '…' : (lang === 'zh' ? '保存草稿' : 'Save draft')}</button></div></div>}

      <div className="space-y-2">
        {loading && items.length === 0 ? <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-400"><Loader2 className="w-4 h-4 animate-spin" />{lang === 'zh' ? '加载事实中…' : 'Loading facts…'}</div> : items.length === 0 ? <div className="rounded-lg border border-dashed border-slate-700 px-3 py-8 text-center text-xs text-slate-500">{lang === 'zh' ? '当前事实库没有事实；新增后仍需证据和审核。' : 'No facts in this library; new facts still require evidence and review.'}</div> : items.map((fact) => <div key={fact.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 space-y-2"><div className="flex flex-wrap items-start justify-between gap-2"><div><div className="flex items-center gap-2"><span className="text-sm font-semibold text-white">{fact.label}</span><span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">{statusLabel(fact.review_status, lang)}</span><span className="font-mono text-[10px] text-slate-500">{fact.stable_key}</span></div><div className="mt-1 text-[11px] text-slate-400">{fact.subject} · {fact.predicate} · {fact.value_type}</div></div>{canWrite && (
              <div className="flex flex-wrap items-center gap-1.5">
                {fact.review_status !== 'reviewed' && (
                  <button type="button" onClick={() => void review(fact)} disabled={busy === `review-${fact.id}`} className="inline-flex items-center gap-1 rounded border border-emerald-500/30 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"><Check className="w-3 h-3" />{busy === `review-${fact.id}` ? '…' : (lang === 'zh' ? '审核通过' : 'Review')}</button>
                )}
                <button type="button" onClick={() => openFactEditor(fact)} className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-cyan-500 hover:text-cyan-200"><Pencil className="w-3 h-3" />{lang === 'zh' ? '编辑' : 'Edit'}</button>
                {items.length > 1 && (
                  <button type="button" onClick={() => { setMergeFactId(fact.id); setMergeTarget(''); }} className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-cyan-500 hover:text-cyan-200"><Merge className="w-3 h-3" />{lang === 'zh' ? '合并到…' : 'Merge into…'}</button>
                )}
                {(fact.values || []).length > 1 && (
                  <button type="button" onClick={() => { setSplitFactId(fact.id); setSplitValueIds([]); setSplitForm({ stable_key: '', label: '' }); }} className="inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-cyan-500 hover:text-cyan-200"><Split className="w-3 h-3" />{lang === 'zh' ? '拆分' : 'Split'}</button>
                )}
                {fact.is_enabled !== false && (
                  <button type="button" onClick={() => void archiveFact(fact)} disabled={busy === `archive-fact-${fact.id}`} className="inline-flex items-center gap-1 rounded border border-rose-500/30 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"><Ban className="w-3 h-3" />{busy === `archive-fact-${fact.id}` ? '…' : (lang === 'zh' ? '归档' : 'Archive')}</button>
                )}
              </div>
            )}</div>
          <div className="space-y-1.5">{(fact.values || []).map((value) => <div key={value.id} className="rounded-lg border border-slate-800/80 bg-slate-900/60 px-2.5 py-2"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-slate-200">{value.canonical_answer || value.canonical_value?.value || '—'}{value.canonical_value?.unit ? ` ${value.canonical_value.unit}` : ''}</span><span className="text-[10px] text-slate-500">{statusLabel(value.review_status, lang)} · {statusLabel(value.conflict_status, lang)}</span></div><div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-slate-500"><span>{lang === 'zh' ? '证据' : 'Evidence'}: {value.evidences?.length || 0}</span>{canWrite && <button type="button" onClick={() => setEvidenceTarget({ valueId: value.id, chunkId: '' })} className="text-cyan-300 hover:text-cyan-200">{lang === 'zh' ? '挂载切片证据' : 'Attach chunk evidence'}</button>}{canWrite && <button type="button" onClick={() => openValueEditor(value)} className="text-cyan-300 hover:text-cyan-200">{lang === 'zh' ? '编辑值' : 'Edit value'}</button>}{canWrite && <button type="button" onClick={() => void archiveValue(value)} disabled={busy === `archive-value-${value.id}`} className="text-rose-300 hover:text-rose-200 disabled:opacity-50">{busy === `archive-value-${value.id}` ? '…' : (lang === 'zh' ? '归档值' : 'Archive value')}</button>}</div>{evidenceTarget?.valueId === value.id && canWrite && <div className="mt-2 flex gap-2"><select value={evidenceTarget.chunkId} onChange={(event) => setEvidenceTarget((current) => current ? { ...current, chunkId: event.target.value } : current)} className="min-w-0 flex-1 rounded bg-slate-950 border border-slate-700 px-2 py-1 text-[11px] text-white"><option value="">{lang === 'zh' ? '选择本知识库切片' : 'Select a chunk from this base'}</option>{chunks.map((chunk) => <option key={chunk.id} value={chunk.id}>{chunk.title || `#${chunk.id}`}</option>)}</select><button type="button" onClick={() => void addEvidence()} disabled={!evidenceTarget.chunkId || busy === `evidence-${value.id}`} className="rounded bg-cyan-700 px-2 py-1 text-[11px] text-white disabled:opacity-50">{lang === 'zh' ? '确定' : 'Attach'}</button><button type="button" onClick={() => setEvidenceTarget(null)} className="px-1 text-[11px] text-slate-500">×</button></div>}</div>)}</div>
          {canWrite && editValueId !== null && (fact.values || []).some((value) => value.id === editValueId) && (
            <div className="grid grid-cols-1 gap-2 rounded-lg border border-cyan-500/20 bg-slate-900 p-2 sm:grid-cols-3">
              <input value={editValueForm.value} onChange={(event) => setEditValueForm((current) => ({ ...current, value: event.target.value }))} placeholder={lang === 'zh' ? '标准值' : 'Canonical value'} className="rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-white" />
              <input value={editValueForm.unit} onChange={(event) => setEditValueForm((current) => ({ ...current, unit: event.target.value }))} placeholder={lang === 'zh' ? '单位（可选）' : 'Unit (optional)'} className="rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-white" />
              <div className="flex gap-2">
                <input value={editValueForm.answer} onChange={(event) => setEditValueForm((current) => ({ ...current, answer: event.target.value }))} placeholder={lang === 'zh' ? '标准答案' : 'Canonical answer'} className="min-w-0 flex-1 rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-white" />
                <button type="button" onClick={() => { const value = (fact.values || []).find((row) => row.id === editValueId); if (value) void submitValueEditor(value); }} disabled={busy === `edit-value-${editValueId}`} className="rounded bg-cyan-600 px-2 text-xs text-white disabled:opacity-50">{busy === `edit-value-${editValueId}` ? '…' : '✓'}</button>
                <button type="button" onClick={() => setEditValueId(null)} className="px-1 text-slate-500"><X className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          )}

          {canWrite && editFactId === fact.id && (
            <div className="space-y-2 rounded-lg border border-cyan-500/20 bg-slate-900 p-2">
              <div className="text-[11px] font-semibold text-cyan-200">{lang === 'zh' ? '编辑事实' : 'Edit fact'}</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <input value={editFactForm.label} onChange={(event) => setEditFactForm((current) => ({ ...current, label: event.target.value }))} placeholder={lang === 'zh' ? '名称' : 'Label'} className="rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-white" />
                <input value={editFactForm.subject} onChange={(event) => setEditFactForm((current) => ({ ...current, subject: event.target.value }))} placeholder={lang === 'zh' ? '主体' : 'Subject'} className="rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-white" />
                <input value={editFactForm.predicate} onChange={(event) => setEditFactForm((current) => ({ ...current, predicate: event.target.value }))} placeholder={lang === 'zh' ? '谓词' : 'Predicate'} className="rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-white" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select value={editFactForm.value_type} onChange={(event) => setEditFactForm((current) => ({ ...current, value_type: event.target.value }))} className="rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-white">
                  {['string', 'integer', 'decimal', 'number', 'percentage', 'date', 'range', 'boolean', 'url', 'path', 'version'].map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
                <button type="button" onClick={() => void submitFactEditor(fact)} disabled={busy === `edit-fact-${fact.id}`} className="rounded bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{busy === `edit-fact-${fact.id}` ? '…' : (lang === 'zh' ? '保存' : 'Save')}</button>
                <button type="button" onClick={() => setEditFactId(null)} className="px-2 py-1.5 text-xs text-slate-400">{lang === 'zh' ? '取消' : 'Cancel'}</button>
              </div>
            </div>
          )}

          {canWrite && mergeFactId === fact.id && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/25 bg-slate-900 p-2">
              <span className="text-[11px] text-amber-200">{lang === 'zh' ? '把本条合并到：' : 'Merge this fact into:'}</span>
              <select value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)} className="min-w-0 flex-1 rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-white">
                <option value="">{lang === 'zh' ? '选择目标事实…' : 'Select the target fact…'}</option>
                {items.filter((row) => row.id !== fact.id).map((row) => <option key={row.id} value={row.id}>{row.label} · {row.stable_key}</option>)}
              </select>
              <button type="button" onClick={() => void submitMerge(fact)} disabled={!mergeTarget || busy === `merge-fact-${fact.id}`} className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{busy === `merge-fact-${fact.id}` ? '…' : (lang === 'zh' ? '确认合并' : 'Merge')}</button>
              <button type="button" onClick={() => setMergeFactId(null)} className="px-2 py-1.5 text-xs text-slate-400">{lang === 'zh' ? '取消' : 'Cancel'}</button>
              <p className="w-full text-[10px] text-slate-500">{lang === 'zh' ? '合并后本条事实会被移除，其值转到目标事实下。' : 'The source fact is removed; its values move to the target.'}</p>
            </div>
          )}

          {canWrite && splitFactId === fact.id && (
            <div className="space-y-2 rounded-lg border border-cyan-500/20 bg-slate-900 p-2">
              <div className="text-[11px] font-semibold text-cyan-200">{lang === 'zh' ? '拆分：勾选要移到新事实的值' : 'Split: pick the values that move to a new fact'}</div>
              <div className="flex flex-wrap gap-2">
                {(fact.values || []).map((value) => (
                  <label key={value.id} className="flex items-center gap-1.5 rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300">
                    <input type="checkbox" checked={splitValueIds.includes(value.id)} onChange={() => setSplitValueIds((current) => current.includes(value.id) ? current.filter((id) => id !== value.id) : [...current, value.id])} className="accent-cyan-500" />
                    {value.canonical_answer || value.canonical_value?.value || `#${value.id}`}
                  </label>
                ))}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input value={splitForm.stable_key} onChange={(event) => setSplitForm((current) => ({ ...current, stable_key: event.target.value }))} placeholder={lang === 'zh' ? '新稳定键，如 company.founded_year' : 'New stable key'} className="rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-white" />
                <input value={splitForm.label} onChange={(event) => setSplitForm((current) => ({ ...current, label: event.target.value }))} placeholder={lang === 'zh' ? '新事实名称' : 'New fact label'} className="rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-white" />
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => void submitSplit(fact)} disabled={splitValueIds.length === 0 || !/^[a-z0-9][a-z0-9._-]*$/.test(splitForm.stable_key.trim()) || !splitForm.label.trim() || busy === `split-fact-${fact.id}`} className="rounded bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{busy === `split-fact-${fact.id}` ? '…' : (lang === 'zh' ? '确认拆分' : 'Split')}</button>
                <button type="button" onClick={() => setSplitFactId(null)} className="px-2 py-1.5 text-xs text-slate-400">{lang === 'zh' ? '取消' : 'Cancel'}</button>
              </div>
              <p className="text-[10px] text-slate-500">{lang === 'zh' ? '稳定键只能用小写字母、数字、点、下划线和短横线，且需以字母或数字开头。' : 'Stable keys allow lowercase letters, digits, dot, underscore and dash, starting alphanumeric.'}</p>
            </div>
          )}

          {canWrite && <button type="button" onClick={() => { setValueFactId(fact.id); setValueForm({ value: '', unit: '', answer: '' }); }} className="text-[11px] text-cyan-300 hover:text-cyan-200">+ {lang === 'zh' ? '新增事实值' : 'Add value'}</button>}
          {selectedValueFact?.id === fact.id && canWrite && <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 rounded-lg border border-cyan-500/20 bg-slate-900 p-2"><input value={valueForm.value} onChange={(event) => setValueForm((current) => ({ ...current, value: event.target.value }))} placeholder={lang === 'zh' ? '标准值' : 'Canonical value'} className="rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-white" /><input value={valueForm.unit} onChange={(event) => setValueForm((current) => ({ ...current, unit: event.target.value }))} placeholder={lang === 'zh' ? '单位（可选）' : 'Unit (optional)'} className="rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-white" /><div className="flex gap-2"><input value={valueForm.answer} onChange={(event) => setValueForm((current) => ({ ...current, answer: event.target.value }))} placeholder={lang === 'zh' ? '标准答案' : 'Canonical answer'} className="min-w-0 flex-1 rounded bg-slate-950 border border-slate-700 px-2 py-1.5 text-xs text-white" /><button type="button" onClick={() => void submitValue()} disabled={busy === 'create-value'} className="rounded bg-cyan-600 px-2 text-xs text-white disabled:opacity-50">{busy === 'create-value' ? '…' : '✓'}</button><button type="button" onClick={() => setValueFactId(null)} className="px-1 text-xs text-slate-500">×</button></div></div>}
        </div>)}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-3"><div className="flex items-center gap-2 text-[11px] text-slate-500"><GitBranch className="w-3.5 h-3.5" />{lang === 'zh' ? '不可变版本' : 'Immutable revisions'}: {(workbench.revisions || []).map((revision) => <span key={revision.id} className="rounded bg-slate-800 px-1.5 py-0.5">v{revision.version}</span>)}</div><div className="flex items-center gap-2">{canWrite && <button type="button" onClick={() => void publish()} disabled={busy === 'publish' || readiness.ready === false} className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">{busy === 'publish' ? '…' : (lang === 'zh' ? '发布事实版本' : 'Publish revision')}</button>}{(workbench.revisions || []).length > 0 && canWrite && <select defaultValue="" onChange={(event) => { const id = Number(event.target.value); if (id > 0) void restore(id); event.currentTarget.value = ''; }} className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-[11px] text-slate-300"><option value="">{lang === 'zh' ? '恢复版本…' : 'Restore revision…'}</option>{(workbench.revisions || []).map((revision) => <option key={revision.id} value={revision.id}>v{revision.version}</option>)}</select>}</div><div className="flex items-center gap-1"><button type="button" onClick={() => void load(Math.max(1, page - 1))} disabled={loading || page <= 1} className="rounded border border-slate-700 p-1 text-slate-300 disabled:opacity-30"><ChevronLeft className="w-3.5 h-3.5" /></button><span className="text-[11px] text-slate-500">{page}/{totalPages}</span><button type="button" onClick={() => void load(Math.min(totalPages, page + 1))} disabled={loading || page >= totalPages} className="rounded border border-slate-700 p-1 text-slate-300 disabled:opacity-30"><ChevronRight className="w-3.5 h-3.5" /></button></div></div>
    </section>
  );
};

export default KnowledgeFactWorkbench;
