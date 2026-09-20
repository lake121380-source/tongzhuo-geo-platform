import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileText,
  History,
  Link2,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import {
  ApiRecord,
  GeoFlowApiClient,
  UrlImportDetailResponse,
  UrlImportJobSummary,
} from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';
import PermissionNotice from './PermissionNotice';
import { LoadingState } from './LoadingState';
import { useConfirm } from './ui';

interface UrlImportPanelProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  canRead?: boolean;
  canWrite?: boolean;
}

interface ImportForm {
  url: string;
  project_name: string;
  source_label: string;
  content_language: string;
  notes: string;
  outputs: string[];
}

const DEFAULT_FORM: ImportForm = {
  url: '',
  project_name: '',
  source_label: '',
  content_language: 'zh-CN',
  notes: '',
  outputs: ['knowledge', 'keywords', 'titles'],
};

const ACTIVE_STATUSES = new Set(['queued', 'running']);

function value(record: ApiRecord | undefined, key: string, fallback = ''): string {
  const raw = record?.[key];
  return raw === undefined || raw === null ? fallback : String(raw);
}

function numberValue(record: ApiRecord | undefined, key: string, fallback = 0): number {
  const raw = Number(record?.[key]);
  return Number.isFinite(raw) ? raw : fallback;
}

function asJob(valueToNormalize: unknown): UrlImportJobSummary | null {
  if (!valueToNormalize || typeof valueToNormalize !== 'object' || Array.isArray(valueToNormalize)) return null;
  const record = valueToNormalize as ApiRecord;
  const id = Number(record.id);
  if (!Number.isInteger(id) || id < 1) return null;
  return {
    id,
    url: value(record, 'url'),
    normalized_url: value(record, 'normalized_url'),
    source_domain: value(record, 'source_domain'),
    page_title: value(record, 'page_title'),
    status: value(record, 'status', 'queued'),
    current_step: value(record, 'current_step', 'queued'),
    progress_percent: numberValue(record, 'progress_percent'),
    error_message: value(record, 'error_message'),
    error_code: value(record, 'error_code'),
    retryable_failure: Boolean(record.retryable_failure),
    result_ready: Boolean(record.result_ready),
    created_at: typeof record.created_at === 'string' ? record.created_at : null,
    started_at: typeof record.started_at === 'string' ? record.started_at : null,
    finished_at: typeof record.finished_at === 'string' ? record.finished_at : null,
  };
}

function detailJob(detail: UrlImportDetailResponse | null): UrlImportJobSummary | null {
  return asJob(detail?.job);
}

function statusLabel(status: string, lang: 'zh' | 'en'): string {
  const labels: Record<string, [string, string]> = {
    queued: ['已排队', 'Queued'],
    running: ['处理中', 'Running'],
    completed: ['预览就绪', 'Preview ready'],
    imported: ['已提交', 'Imported'],
    failed: ['失败', 'Failed'],
  };
  return labels[status]?.[lang === 'zh' ? 0 : 1] || status || '—';
}

function stepLabel(step: string, lang: 'zh' | 'en'): string {
  const labels: Record<string, [string, string]> = {
    queued: ['等待启动', 'Waiting to start'],
    fetch: ['抓取页面', 'Fetch page'],
    page_json: ['解析页面', 'Parse page'],
    knowledge: ['生成知识摘要', 'Build knowledge'],
    keywords: ['生成关键词', 'Build keywords'],
    titles: ['生成标题', 'Build titles'],
    preview: ['整理预览', 'Prepare preview'],
    imported: ['已提交素材库', 'Imported'],
  };
  return labels[step]?.[lang === 'zh' ? 0 : 1] || step || '—';
}

function dateLabel(raw: unknown, lang: 'zh' | 'en'): string {
  const text = String(raw ?? '').trim();
  if (!text) return '—';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function safeHttpUrl(raw: unknown): string {
  const candidate = String(raw ?? '').trim();
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function resultRecord(detail: UrlImportDetailResponse | null): ApiRecord {
  return detail?.result && typeof detail.result === 'object' && !Array.isArray(detail.result)
    ? detail.result
    : {};
}

function resultImportStatus(detail: UrlImportDetailResponse | null): string {
  const result = resultRecord(detail);
  const imported = result.import;
  return imported && typeof imported === 'object' && !Array.isArray(imported)
    ? String((imported as ApiRecord).status || '')
    : '';
}

function resultArray(result: ApiRecord, key: string): string[] {
  const raw = result[key];
  return Array.isArray(raw) ? raw.map((item) => String(item)).filter(Boolean) : [];
}

function mergeJob(list: UrlImportJobSummary[], next: UrlImportJobSummary): UrlImportJobSummary[] {
  const found = list.some((item) => item.id === next.id);
  return found ? list.map((item) => item.id === next.id ? next : item) : [next, ...list];
}

export const UrlImportPanel: React.FC<UrlImportPanelProps> = ({
  apiClient,
  lang,
  canRead = true,
  canWrite = true,
}) => {
  const [jobs, setJobs] = useState<UrlImportJobSummary[]>([]);
  const confirmDialog = useConfirm();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<UrlImportDetailResponse | null>(null);
  const [form, setForm] = useState<ImportForm>({ ...DEFAULT_FORM, outputs: [...DEFAULT_FORM.outputs] });
  const [formOpen, setFormOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedId) || detailJob(detail),
    [detail, jobs, selectedId],
  );
  const detailResult = resultRecord(detail);
  const detailPage = detailResult.page && typeof detailResult.page === 'object' && !Array.isArray(detailResult.page)
    ? detailResult.page as ApiRecord
    : {};
  const detailAnalysis = detailResult.analysis && typeof detailResult.analysis === 'object' && !Array.isArray(detailResult.analysis)
    ? detailResult.analysis as ApiRecord
    : {};
  const logs = Array.isArray(detail?.logs) ? detail.logs : [];
  const previewReady = selectedJob?.status === 'completed' && resultImportStatus(detail) === 'preview';

  const loadJobs = async (keepSelection = true) => {
    if (!canRead) return;
    setLoading(true);
    setError('');
    try {
      const response = await apiClient.listUrlImports({ page: 1, per_page: 20 });
      const next = Array.isArray(response.items)
        ? response.items.map(asJob).filter((job): job is UrlImportJobSummary => Boolean(job))
        : [];
      setJobs(next);
      if (!keepSelection || selectedId === null || !next.some((job) => job.id === selectedId)) {
        const nextId = next[0]?.id ?? null;
        setSelectedId(nextId);
        if (nextId === null) setDetail(null);
      }
    } catch (loadError) {
      setError(describeApiError(loadError, lang === 'zh' ? '加载 URL 导入任务失败' : 'Unable to load URL import jobs', lang));
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (id: number, quiet = false) => {
    if (!canRead) return;
    if (!quiet) setDetailLoading(true);
    if (!quiet) setError('');
    try {
      const next = await apiClient.getUrlImport(id);
      setDetail(next);
      const nextJob = detailJob(next);
      if (nextJob) setJobs((previous) => mergeJob(previous, nextJob));
    } catch (loadError) {
      if (!quiet) setError(describeApiError(loadError, lang === 'zh' ? '读取 URL 导入详情失败' : 'Unable to load URL import details', lang));
    } finally {
      if (!quiet) setDetailLoading(false);
    }
  };

  useEffect(() => {
    void loadJobs(false);
    // The API client and permission projection are stable for the shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiClient, canRead]);

  useEffect(() => {
    if (selectedId === null || !canRead) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, apiClient, canRead]);

  useEffect(() => {
    const job = detailJob(detail);
    if (!job || selectedId === null || !ACTIVE_STATUSES.has(job.status)) return undefined;
    const timer = window.setInterval(() => { void loadDetail(selectedId, true); }, 3500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.job?.status, selectedId, apiClient]);

  const setFormField = (key: keyof Omit<ImportForm, 'outputs'>, next: string) => {
    setForm((previous) => ({ ...previous, [key]: next }));
  };

  const toggleOutput = (output: string) => {
    setForm((previous) => ({
      ...previous,
      outputs: previous.outputs.includes(output)
        ? previous.outputs.filter((item) => item !== output)
        : [...previous.outputs, output],
    }));
  };

  const createJob = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite) {
      setError(lang === 'zh' ? '权限不足（403）：创建 URL 导入需要「materials:write」权限。' : 'Permission denied (403): URL imports require the “materials:write” scope.');
      return;
    }
    if (!form.url.trim()) {
      setError(lang === 'zh' ? '请输入要采集的 URL' : 'Enter a URL to import');
      return;
    }
    if (form.outputs.length === 0) {
      setError(lang === 'zh' ? '至少选择一种输出类型' : 'Select at least one output');
      return;
    }
    setBusy('create');
    setError('');
    setNotice('');
    try {
      const response = await apiClient.createUrlImport({
        url: form.url.trim(),
        project_name: form.project_name.trim(),
        source_label: form.source_label.trim(),
        content_language: form.content_language.trim(),
        notes: form.notes.trim(),
        outputs: form.outputs,
      });
      const created = asJob(response.job || response);
      if (!created) throw new Error(lang === 'zh' ? '后端没有返回有效任务' : 'The API did not return a valid job');
      setJobs((previous) => mergeJob(previous, created));
      setSelectedId(created.id);
      setForm({ ...DEFAULT_FORM, outputs: [...DEFAULT_FORM.outputs] });
      setFormOpen(false);
      setNotice(lang === 'zh' ? 'URL 导入任务已创建，请点击“启动”开始抓取。' : 'URL import created. Start it when you are ready.');
    } catch (createError) {
      setError(describeApiError(createError, lang === 'zh' ? '创建 URL 导入任务失败' : 'Unable to create URL import', lang));
    } finally {
      setBusy('');
    }
  };

  const runJob = async (job: UrlImportJobSummary) => {
    if (!canWrite) {
      setError(lang === 'zh' ? '权限不足（403）：运行 URL 导入需要「materials:write」权限。' : 'Permission denied (403): running URL imports requires the “materials:write” scope.');
      return;
    }
    setBusy(`run-${job.id}`);
    setError('');
    setNotice('');
    try {
      const response = await apiClient.runUrlImport(job.id);
      const next = detailJob(response);
      if (next) {
        setJobs((previous) => mergeJob(previous, next));
        setSelectedId(next.id);
      }
      setDetail(response);
      setNotice(lang === 'zh' ? '任务已提交 Worker，页面会自动刷新进度。' : 'The job was submitted to the worker; progress will refresh automatically.');
    } catch (runError) {
      setError(describeApiError(runError, lang === 'zh' ? '启动 URL 导入失败' : 'Unable to run URL import', lang));
    } finally {
      setBusy('');
    }
  };

  const commitJob = async () => {
    if (!selectedJob || !canWrite) return;
    if (!(await confirmDialog({
      title: lang === 'zh' ? '把这次 URL 预览写入素材库？' : 'Commit this URL preview?',
      description: lang === 'zh' ? '会在所选素材库里创建真实记录。' : 'This creates real material records in the selected libraries.',
      confirmLabel: lang === 'zh' ? '写入' : 'Commit',
      tone: 'primary',
    }))) return;
    setBusy(`commit-${selectedJob.id}`);
    setError('');
    setNotice('');
    try {
      const response = await apiClient.commitUrlImport(selectedJob.id);
      const committedDetail = response.job && typeof response.job === 'object' && !Array.isArray(response.job)
        ? response.job as UrlImportDetailResponse
        : null;
      const next = detailJob(committedDetail);
      if (next) setJobs((previous) => mergeJob(previous, next));
      if (committedDetail) setDetail(committedDetail);
      setNotice(lang === 'zh' ? '预览结果已提交到任务中选择的素材库。' : 'The preview was committed to the selected material libraries.');
    } catch (commitError) {
      setError(describeApiError(commitError, lang === 'zh' ? '提交 URL 导入结果失败' : 'Unable to commit URL import', lang));
    } finally {
      setBusy('');
    }
  };

  if (!canRead) {
    return (
      <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
        <PanelHeading lang={lang} />
        <PermissionNotice lang={lang} mode="read" requiredScope="materials:read" className="mt-4" />
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PanelHeading lang={lang} />
        <div className="flex items-center gap-2">
          {!canWrite && <PermissionNotice lang={lang} requiredScope="materials:write" />}
          <button type="button" onClick={() => void loadJobs(true)} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-2 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />{lang === 'zh' ? '刷新任务' : 'Refresh jobs'}
          </button>
          {canWrite && <button type="button" onClick={() => { setError(''); setFormOpen((open) => !open); }} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500">
            <Link2 className="h-3.5 w-3.5" />{lang === 'zh' ? '导入 URL' : 'Import URL'}
          </button>}
        </div>
      </div>

      {error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
      {notice && <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-200"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{notice}</div>}

      {formOpen && canWrite && (
        <form onSubmit={createJob} className="space-y-3 rounded-xl border border-indigo-500/30 bg-slate-950/60 p-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2"><h3 className="text-xs font-bold text-white">{lang === 'zh' ? '创建真实 URL 采集任务' : 'Create URL import job'}</h3><button type="button" onClick={() => setFormOpen(false)} className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-white"><X className="h-4 w-4" /></button></div>
          <label className="block text-xs text-slate-400">URL <span className="text-rose-400">*</span><input required type="url" value={form.url} onChange={(event) => setFormField('url', event.target.value)} placeholder="https://example.com/article" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-indigo-500" /></label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label={lang === 'zh' ? '项目名（可选）' : 'Project name (optional)'} value={form.project_name} onChange={(next) => setFormField('project_name', next)} />
            <Input label={lang === 'zh' ? '来源标签（可选）' : 'Source label (optional)'} value={form.source_label} onChange={(next) => setFormField('source_label', next)} />
            <Input label={lang === 'zh' ? '内容语言' : 'Content language'} value={form.content_language} onChange={(next) => setFormField('content_language', next)} />
            <label className="text-xs text-slate-400">{lang === 'zh' ? '备注（可选）' : 'Notes (optional)'}<input value={form.notes} onChange={(event) => setFormField('notes', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-indigo-500" /></label>
          </div>
          <div><div className="mb-1 text-xs text-slate-400">{lang === 'zh' ? '输出类型' : 'Outputs'}</div><div className="flex flex-wrap gap-2">{[['knowledge', lang === 'zh' ? '知识库' : 'Knowledge'], ['keywords', lang === 'zh' ? '关键词库' : 'Keywords'], ['titles', lang === 'zh' ? '标题库' : 'Titles']].map(([id, label]) => <label key={id} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300"><input type="checkbox" checked={form.outputs.includes(id)} onChange={() => toggleOutput(id)} className="accent-indigo-500" />{label}</label>)}</div></div>
          <div className="flex justify-end gap-2 border-t border-slate-800 pt-3"><button type="button" onClick={() => setFormOpen(false)} className="rounded-lg bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700">{lang === 'zh' ? '取消' : 'Cancel'}</button><button type="submit" disabled={busy === 'create'} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">{busy === 'create' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}{lang === 'zh' ? '创建任务' : 'Create job'}</button></div>
        </form>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(220px,0.85fr)_minmax(0,1.5fr)]">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-500"><span>{lang === 'zh' ? '导入任务' : 'Import jobs'}</span><span>{jobs.length}</span></div>
          {jobs.length === 0 ? <div className="rounded-xl border border-dashed border-slate-800 px-3 py-8 text-center text-xs text-slate-500">{loading ? <LoadingState lang={lang} variant="inline" label={lang === 'zh' ? '读取任务…' : 'Loading jobs…'} /> : (lang === 'zh' ? '暂无 URL 导入任务' : 'No URL import jobs yet')}</div> : <div className="max-h-[440px] space-y-2 overflow-y-auto pr-1">{jobs.map((job) => <JobRow key={job.id} job={job} selected={job.id === selectedId} lang={lang} onSelect={() => setSelectedId(job.id)} onRun={() => void runJob(job)} busy={busy === `run-${job.id}`} canWrite={canWrite} />)}</div>}
        </div>

        <div className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
          {!selectedJob ? <div className="flex min-h-56 items-center justify-center text-xs text-slate-500">{lang === 'zh' ? '选择任务查看详情、日志和预览' : 'Select a job to inspect details, logs and preview'}</div> : detailLoading && !detail ? <div className="flex min-h-56 items-center justify-center text-xs text-slate-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{lang === 'zh' ? '读取任务详情…' : 'Loading job details…'}</div> : <JobDetail detail={detail} job={selectedJob} logs={logs} page={detailPage} analysis={detailAnalysis} lang={lang} previewReady={previewReady} canWrite={canWrite} busy={busy} onRun={() => void runJob(selectedJob)} onCommit={() => void commitJob()} onReload={() => void loadDetail(selectedJob.id)} />}
        </div>
      </div>
    </section>
  );
};

const PanelHeading: React.FC<{ lang: 'zh' | 'en' }> = ({ lang }) => (
  <div><h2 className="flex items-center gap-2 text-sm font-bold text-white"><Sparkles className="h-4 w-4 text-indigo-300" />{lang === 'zh' ? 'URL 智能采集与入库' : 'URL intelligent import'}</h2><p className="mt-1 text-[11px] leading-relaxed text-slate-500">{lang === 'zh' ? '抓取公开页面，经后端 AI 清洗、生成预览，人工确认后再写入真实素材库。' : 'Fetch a public page, generate an audited AI preview, then commit it to the real libraries.'}</p></div>
);

const Input: React.FC<{ label: string; value: string; onChange: (value: string) => void }> = ({ label, value, onChange }) => <label className="text-xs text-slate-400">{label}<input value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-indigo-500" /></label>;

interface JobRowProps {
  job: UrlImportJobSummary;
  selected: boolean;
  lang: 'zh' | 'en';
  onSelect: () => void;
  onRun: () => void;
  busy: boolean;
  canWrite: boolean;
}

const JobRow: React.FC<JobRowProps> = ({ job, selected, lang, onSelect, onRun, busy, canWrite }) => {
  const runnable = canWrite && (job.status === 'queued' || (job.status === 'failed' && Boolean(job.retryable_failure)));
  return <div className={`rounded-xl border p-3 transition ${selected ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-slate-800 bg-slate-950/50 hover:border-slate-700'}`}>
    <button type="button" onClick={onSelect} className="w-full text-left"><div className="flex items-start justify-between gap-2"><span className="line-clamp-2 text-xs font-semibold text-slate-100">{job.page_title || job.source_domain || job.url}</span><StatusBadge status={job.status} lang={lang} /></div><div className="mt-1 truncate text-[10px] text-slate-500">{job.source_domain || job.url}</div><div className="mt-2 flex items-center justify-between text-[10px] text-slate-600"><span>{stepLabel(job.current_step, lang)}</span><span>{numberValue(job, 'progress_percent')}%</span></div><div className="mt-1 h-1 overflow-hidden rounded bg-slate-800"><div className="h-full bg-indigo-500 transition-all" style={{ width: `${Math.max(0, Math.min(100, numberValue(job, 'progress_percent')))}%` }} /></div></button>
    {runnable && <button type="button" onClick={onRun} disabled={busy} className="mt-2 inline-flex items-center gap-1 rounded-lg border border-indigo-500/30 px-2 py-1 text-[10px] font-semibold text-indigo-200 hover:bg-indigo-500/10 disabled:opacity-50">{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : job.status === 'failed' ? <RotateCcw className="h-3 w-3" /> : <Play className="h-3 w-3" />}{job.status === 'failed' ? (lang === 'zh' ? '重试' : 'Retry') : (lang === 'zh' ? '启动' : 'Start')}</button>}
  </div>;
};

const StatusBadge: React.FC<{ status: string; lang: 'zh' | 'en' }> = ({ status, lang }) => {
  const color = status === 'failed' ? 'border-rose-500/30 bg-rose-500/10 text-rose-200' : status === 'completed' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : status === 'imported' ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-200' : 'border-amber-500/30 bg-amber-500/10 text-amber-200';
  return <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${color}`}>{statusLabel(status, lang)}</span>;
};

interface JobDetailProps {
  detail: UrlImportDetailResponse | null;
  job: UrlImportJobSummary;
  logs: ApiRecord[];
  page: ApiRecord;
  analysis: ApiRecord;
  lang: 'zh' | 'en';
  previewReady: boolean;
  canWrite: boolean;
  busy: string;
  onRun: () => void;
  onCommit: () => void;
  onReload: () => void;
}

const JobDetail: React.FC<JobDetailProps> = ({ detail, job, logs, page, analysis, lang, previewReady, canWrite, busy, onRun, onCommit, onReload }) => {
  const keywords = resultArray(analysis, 'keywords');
  const titles = resultArray(analysis, 'titles');
  const knowledge = value(analysis, 'knowledge_markdown');
  const imported = detail?.result?.import && typeof detail.result.import === 'object' && !Array.isArray(detail.result.import)
    ? detail.result.import as ApiRecord
    : {};
  const importedSummary = imported.summary && typeof imported.summary === 'object' && !Array.isArray(imported.summary)
    ? imported.summary as ApiRecord
    : {};
  const sourceUrl = safeHttpUrl(job.normalized_url || job.url);
  const retryable = job.status === 'failed' && Boolean(job.retryable_failure);
  return <div className="space-y-4">
    <div className="flex flex-col gap-2 border-b border-slate-800 pb-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex items-center gap-2"><FileText className="h-4 w-4 shrink-0 text-indigo-300" /><h3 className="truncate text-sm font-bold text-white">{job.page_title || job.source_domain || `#${job.id}`}</h3><StatusBadge status={job.status} lang={lang} /></div>{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-[10px] text-indigo-300 hover:text-indigo-200"><ExternalLink className="h-3 w-3 shrink-0" />{sourceUrl}</a> : <span className="mt-1 block truncate text-[10px] text-slate-500">{job.normalized_url || job.url}</span>}</div><div className="flex shrink-0 items-center gap-1"><button type="button" onClick={onReload} className="rounded-lg border border-slate-700 p-2 text-slate-400 hover:bg-slate-800" title={lang === 'zh' ? '刷新详情' : 'Refresh details'}><RefreshCw className="h-3.5 w-3.5" /></button>{(job.status === 'queued' || retryable) && canWrite && <button type="button" onClick={onRun} disabled={busy.startsWith('run-')} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-2 text-[11px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">{busy.startsWith('run-') ? <Loader2 className="h-3 w-3 animate-spin" /> : retryable ? <RotateCcw className="h-3 w-3" /> : <Play className="h-3 w-3" />}{retryable ? (lang === 'zh' ? '重试' : 'Retry') : (lang === 'zh' ? '启动' : 'Start')}</button>}</div></div>
    <div><div className="mb-1 flex items-center justify-between text-[11px] text-slate-400"><span>{stepLabel(job.current_step, lang)}</span><span>{numberValue(job, 'progress_percent')}%</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-800"><div className={`h-full transition-all ${job.status === 'failed' ? 'bg-rose-500' : 'bg-indigo-500'}`} style={{ width: `${Math.max(0, Math.min(100, numberValue(job, 'progress_percent')))}%` }} /></div><div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-slate-600"><span>{lang === 'zh' ? '创建：' : 'Created: '}{dateLabel(job.created_at, lang)}</span>{job.finished_at && <span>{lang === 'zh' ? '结束：' : 'Finished: '}{dateLabel(job.finished_at, lang)}</span>}</div></div>
    {job.error_message && <div role="alert" className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-950/20 px-3 py-2 text-xs text-rose-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{job.error_message}{job.error_code ? ` (${job.error_code})` : ''}</span></div>}
    {previewReady && <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-200"><span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" />{lang === 'zh' ? 'AI 预览已生成，确认后才会写入素材库。' : 'AI preview is ready; nothing is written until you confirm.'}</span>{canWrite && <button type="button" onClick={onCommit} disabled={busy.startsWith('commit-')} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">{busy.startsWith('commit-') ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}{lang === 'zh' ? '确认入库' : 'Commit'}</button>}</div>}
    {job.status === 'imported' && <div className="flex items-start gap-2 rounded-lg border border-cyan-500/30 bg-cyan-950/20 px-3 py-2 text-xs text-cyan-200"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>{lang === 'zh' ? '已完成入库：' : 'Imported: '}{importedSummary.knowledge_base ? (lang === 'zh' ? `知识库 #${importedSummary.knowledge_base}` : `knowledge base #${importedSummary.knowledge_base}`) : ''}{importedSummary.keyword_library ? ` · ${lang === 'zh' ? `关键词库 #${importedSummary.keyword_library}` : `keyword library #${importedSummary.keyword_library}`}` : ''}{importedSummary.title_library ? ` · ${lang === 'zh' ? `标题库 #${importedSummary.title_library}` : `title library #${importedSummary.title_library}`}` : ''}</span></div>}
    {detail && <div className="grid grid-cols-1 gap-3 xl:grid-cols-2"><PreviewCard title={lang === 'zh' ? '页面预览' : 'Page preview'} icon={<FileText className="h-3.5 w-3.5 text-indigo-300" />}><div className="space-y-2 text-xs"><div><span className="text-slate-500">{lang === 'zh' ? '标题：' : 'Title: '}</span><span className="text-slate-200">{value(page, 'title', job.page_title || '—')}</span></div><div><span className="text-slate-500">{lang === 'zh' ? '摘要：' : 'Summary: '}</span><span className="text-slate-300">{value(page, 'summary', '—')}</span></div><pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-2.5 text-[11px] leading-relaxed text-slate-400">{value(page, 'text', lang === 'zh' ? '暂无页面正文' : 'No page text')}</pre></div></PreviewCard><PreviewCard title={lang === 'zh' ? 'AI 分析结果' : 'AI analysis'} icon={<Sparkles className="h-3.5 w-3.5 text-amber-300" />}><div className="space-y-2 text-xs"><div><span className="text-slate-500">{lang === 'zh' ? '摘要：' : 'Summary: '}</span><span className="text-slate-300">{value(analysis, 'summary', '—')}</span></div><div><span className="text-slate-500">{lang === 'zh' ? '建议库名：' : 'Library: '}</span><span className="text-slate-200">{value(analysis, 'library_name', '—')}</span></div><TagList label={lang === 'zh' ? '关键词' : 'Keywords'} values={keywords} /><TagList label={lang === 'zh' ? '标题候选' : 'Title candidates'} values={titles} /><details className="rounded-lg border border-slate-800"><summary className="cursor-pointer px-2.5 py-2 text-[11px] text-slate-400">{lang === 'zh' ? '知识库 Markdown 预览' : 'Knowledge Markdown preview'}</summary><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-slate-800 p-2.5 text-[11px] leading-relaxed text-slate-400">{knowledge || (lang === 'zh' ? '暂无知识正文' : 'No knowledge content')}</pre></details></div></PreviewCard></div>}
    <div className="rounded-lg border border-slate-800 bg-slate-950/40"><div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2 text-xs font-semibold text-slate-300"><History className="h-3.5 w-3.5 text-slate-500" />{lang === 'zh' ? '处理日志' : 'Processing log'}<span className="text-[10px] font-normal text-slate-600">{logs.length}</span></div>{logs.length === 0 ? <div className="px-3 py-5 text-center text-[11px] text-slate-600">{lang === 'zh' ? '暂无日志' : 'No log entries'}</div> : <div className="max-h-48 space-y-1 overflow-y-auto p-2">{logs.map((log, index) => <div key={`${value(log, 'created_at')}-${index}`} className="flex items-start gap-2 rounded px-2 py-1.5 text-[10px] hover:bg-slate-900"><span className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${value(log, 'level') === 'error' ? 'bg-rose-400' : value(log, 'level') === 'warning' ? 'bg-amber-400' : 'bg-emerald-400'}`} /><span className="min-w-0 flex-1 text-slate-400">{value(log, 'message')}</span><span className="shrink-0 text-slate-600">{dateLabel(log.created_at, lang)}</span></div>)}</div>}</div>
  </div>;
};

const PreviewCard: React.FC<{ title: string; icon: React.ReactNode; children: React.ReactNode }> = ({ title, icon, children }) => <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3"><div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-300">{icon}{title}</div>{children}</div>;

const TagList: React.FC<{ label: string; values: string[] }> = ({ label, values }) => <div><div className="mb-1 text-[11px] text-slate-500">{label}</div><div className="flex flex-wrap gap-1">{values.length === 0 ? <span className="text-[11px] text-slate-600">—</span> : values.map((item) => <span key={item} className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">{item}</span>)}</div></div>;

export default UrlImportPanel;
