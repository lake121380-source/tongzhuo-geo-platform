import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Inbox,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError, requiredScopeLabel } from '../api/permissions';

type Lang = 'zh' | 'en';
type ViewMode = 'forms' | 'leads';

interface LeadField {
  name: string;
  label: string;
  type: 'text' | 'phone' | 'email' | 'textarea' | 'select' | 'checkbox';
  required: boolean;
  options: string[];
}

interface LeadFormRecord {
  id: number;
  name: string;
  slug: string;
  status: 'active' | 'inactive';
  description: string;
  submitButtonLabel: string;
  successMessage: string;
  fields: LeadField[];
  submissionsCount: number;
  publicPath: string;
  updatedAt: string;
}

interface LeadRecord {
  id: number;
  status: string;
  payload: Record<string, string | boolean>;
  sourceUrl: string;
  note: string;
  form: { id: number; name: string; fields: LeadField[] } | null;
  hostedSite: { id: number; hostname: string } | null;
  handler: { id: number; username: string } | null;
  handledAt: string;
  createdAt: string;
  updatedAt: string;
  ipAddress?: string;
  userAgent?: string;
}

interface Props {
  apiClient: GeoFlowApiClient;
  lang: Lang;
  canRead: boolean;
  canWrite: boolean;
}

interface PageMeta {
  page: number;
  totalPages: number;
  total: number;
}

const emptyStats = { total: 0, active: 0, submissions: 0, new: 0, pending: 0, converted: 0 };
const defaultFields: LeadField[] = [
  { name: 'name', label: '姓名', type: 'text', required: true, options: [] },
  { name: 'phone', label: '电话', type: 'phone', required: false, options: [] },
  { name: 'email', label: '邮箱', type: 'email', required: false, options: [] },
  { name: 'message', label: '需求', type: 'textarea', required: true, options: [] },
];

function asRecord(value: unknown): ApiRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
}

function asItems(value: unknown): ApiRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fieldsFrom(value: unknown): LeadField[] {
  return asItems(value).map((field) => ({
    name: String(field.name || ''),
    label: String(field.label || ''),
    type: ['text', 'phone', 'email', 'textarea', 'select', 'checkbox'].includes(String(field.type))
      ? String(field.type) as LeadField['type']
      : 'text',
    required: Boolean(field.required),
    options: Array.isArray(field.options) ? field.options.map(String) : [],
  }));
}

function mapForm(value: unknown): LeadFormRecord {
  const item = asRecord(value);
  return {
    id: numberValue(item.id),
    name: String(item.name || ''),
    slug: String(item.slug || ''),
    status: item.status === 'inactive' ? 'inactive' : 'active',
    description: String(item.description || ''),
    submitButtonLabel: String(item.submit_button_label || '提交'),
    successMessage: String(item.success_message || ''),
    fields: fieldsFrom(item.fields),
    submissionsCount: numberValue(item.submissions_count),
    publicPath: String(item.public_path || ''),
    updatedAt: String(item.updated_at || ''),
  };
}

function mapLead(value: unknown): LeadRecord {
  const item = asRecord(value);
  const form = asRecord(item.form);
  const hostedSite = asRecord(item.hosted_site);
  const handler = asRecord(item.handler);
  const payload = asRecord(item.payload);
  return {
    id: numberValue(item.id),
    status: String(item.status || 'new'),
    payload: Object.fromEntries(Object.entries(payload).map(([key, val]) => [key, typeof val === 'boolean' ? val : String(val ?? '')])),
    sourceUrl: String(item.source_url || ''),
    note: String(item.note || ''),
    form: form.id ? { id: numberValue(form.id), name: String(form.name || ''), fields: fieldsFrom(form.fields) } : null,
    hostedSite: hostedSite.id ? { id: numberValue(hostedSite.id), hostname: String(hostedSite.hostname || '') } : null,
    handler: handler.id ? { id: numberValue(handler.id), username: String(handler.username || '') } : null,
    handledAt: String(item.handled_at || ''),
    createdAt: String(item.created_at || ''),
    updatedAt: String(item.updated_at || ''),
    ipAddress: item.ip_address === undefined ? undefined : String(item.ip_address || ''),
    userAgent: item.user_agent === undefined ? undefined : String(item.user_agent || ''),
  };
}

function pageMeta(value: ApiRecord): PageMeta {
  const pagination = asRecord(value.pagination);
  return {
    page: Math.max(1, numberValue(pagination.page) || 1),
    totalPages: Math.max(1, numberValue(pagination.total_pages) || 1),
    total: numberValue(pagination.total),
  };
}

function idempotencyKey(prefix: string): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

function displayDate(value: string): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const statusLabels: Record<string, { zh: string; en: string }> = {
  new: { zh: '新线索', en: 'New' },
  contacted: { zh: '已联系', en: 'Contacted' },
  qualified: { zh: '已确认', en: 'Qualified' },
  invalid: { zh: '无效', en: 'Invalid' },
  converted: { zh: '已转化', en: 'Converted' },
};

export const LeadManagementView: React.FC<Props> = ({ apiClient, lang, canRead, canWrite }) => {
  const [mode, setMode] = useState<ViewMode>('forms');
  const [forms, setForms] = useState<LeadFormRecord[]>([]);
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [formMeta, setFormMeta] = useState<PageMeta>({ page: 1, totalPages: 1, total: 0 });
  const [leadMeta, setLeadMeta] = useState<PageMeta>({ page: 1, totalPages: 1, total: 0 });
  const [stats, setStats] = useState(emptyStats);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [formSearch, setFormSearch] = useState('');
  const [formStatus, setFormStatus] = useState('');
  const [filters, setFilters] = useState({ search: '', status: '', formId: '', dateFrom: '', dateTo: '' });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [editingForm, setEditingForm] = useState<LeadFormRecord | null | undefined>(undefined);
  const [activeLead, setActiveLead] = useState<LeadRecord | null>(null);
  const [leadDraft, setLeadDraft] = useState({ status: 'new', note: '' });

  const loadForms = useCallback(async (page = formMeta.page) => {
    if (!canRead) return;
    setLoading(true);
    setError('');
    try {
      const result = await apiClient.listLeadForms({ page, per_page: 20, search: formSearch || undefined, status: formStatus || undefined });
      setForms(asItems(result.items).map(mapForm));
      setFormMeta(pageMeta(result));
      const nextStats = asRecord(result.stats);
      setStats((current) => ({
        ...current,
        total: numberValue(nextStats.total),
        active: numberValue(nextStats.active),
        submissions: numberValue(nextStats.submissions),
      }));
    } catch (cause) {
      setError(describeApiError(cause, lang === 'zh' ? '表单加载失败' : 'Failed to load forms', lang));
    } finally {
      setLoading(false);
    }
  }, [apiClient, canRead, formMeta.page, formSearch, formStatus, lang]);

  const loadLeads = useCallback(async (page = leadMeta.page, selectedFilters = appliedFilters) => {
    if (!canRead) return;
    setLoading(true);
    setError('');
    try {
      const result = await apiClient.listLeads({
        page,
        per_page: 20,
        search: selectedFilters.search || undefined,
        status: selectedFilters.status || undefined,
        form_id: selectedFilters.formId || undefined,
        date_from: selectedFilters.dateFrom || undefined,
        date_to: selectedFilters.dateTo || undefined,
      });
      setLeads(asItems(result.items).map(mapLead));
      setLeadMeta(pageMeta(result));
      const nextStats = asRecord(result.stats);
      setStats((current) => ({
        ...current,
        submissions: numberValue(nextStats.total),
        new: numberValue(nextStats.new),
        pending: numberValue(nextStats.pending),
        converted: numberValue(nextStats.converted),
      }));
    } catch (cause) {
      setError(describeApiError(cause, lang === 'zh' ? '线索加载失败' : 'Failed to load leads', lang));
    } finally {
      setLoading(false);
    }
  }, [apiClient, appliedFilters, canRead, lang, leadMeta.page]);

  useEffect(() => {
    if (!canRead) return;
    if (mode === 'forms') void loadForms(1);
    else void loadLeads(1);
  }, [canRead, mode]); // Deliberately reload only when the operator switches workspace.

  const openLead = async (lead: LeadRecord) => {
    setLoading(true);
    setError('');
    try {
      const result = await apiClient.getLead(lead.id);
      const detail = mapLead(asRecord(result.lead || result));
      setActiveLead(detail);
      setLeadDraft({ status: detail.status, note: detail.note });
    } catch (cause) {
      setError(describeApiError(cause, lang === 'zh' ? '线索详情加载失败' : 'Failed to load lead', lang));
    } finally {
      setLoading(false);
    }
  };

  const saveForm = async (form: LeadFormRecord) => {
    setSaving(true);
    setError('');
    try {
      const payload: ApiRecord = {
        name: form.name,
        slug: form.slug,
        status: form.status,
        description: form.description,
        submit_button_label: form.submitButtonLabel,
        success_message: form.successMessage,
        fields: form.fields,
      };
      const result = form.id > 0
        ? await apiClient.updateLeadForm(form.id, { ...payload, expected_updated_at: form.updatedAt }, { idempotencyKey: idempotencyKey('lead-form-update') })
        : await apiClient.createLeadForm(payload, { idempotencyKey: idempotencyKey('lead-form-create') });
      const saved = mapForm(asRecord(result.form || result));
      setForms((current) => form.id > 0 ? current.map((item) => item.id === saved.id ? saved : item) : [saved, ...current]);
      setEditingForm(undefined);
      await loadForms(1);
    } catch (cause) {
      setError(describeApiError(cause, lang === 'zh' ? '表单保存失败' : 'Failed to save form', lang));
    } finally {
      setSaving(false);
    }
  };

  const changeFormStatus = async (form: LeadFormRecord) => {
    if (!canWrite) return;
    setSaving(true);
    setError('');
    try {
      const next = form.status === 'active' ? 'inactive' : 'active';
      const result = await apiClient.setLeadFormStatus(form.id, next, form.updatedAt, { idempotencyKey: idempotencyKey('lead-form-status') });
      const saved = mapForm(asRecord(result.form || result));
      setForms((current) => current.map((item) => item.id === saved.id ? saved : item));
    } catch (cause) {
      setError(describeApiError(cause, lang === 'zh' ? '表单状态更新失败' : 'Failed to update form status', lang));
    } finally {
      setSaving(false);
    }
  };

  const deleteForm = async (form: LeadFormRecord) => {
    if (!canWrite) return;
    const confirmed = window.confirm(lang === 'zh'
      ? `确认删除表单“${form.name}”？已有线索的表单不会被删除。`
      : `Delete “${form.name}”? Forms with submissions cannot be deleted.`);
    if (!confirmed) return;
    setSaving(true);
    setError('');
    try {
      await apiClient.deleteLeadForm(form.id, form.updatedAt, { idempotencyKey: idempotencyKey('lead-form-delete') });
      setForms((current) => current.filter((item) => item.id !== form.id));
      await loadForms(1);
    } catch (cause) {
      setError(describeApiError(cause, lang === 'zh' ? '表单删除失败' : 'Failed to delete form', lang));
    } finally {
      setSaving(false);
    }
  };

  const saveLead = async () => {
    if (!activeLead || !canWrite) return;
    setSaving(true);
    setError('');
    try {
      const result = await apiClient.updateLead(activeLead.id, {
        status: leadDraft.status,
        note: leadDraft.note,
        expected_updated_at: activeLead.updatedAt,
      }, { idempotencyKey: idempotencyKey('lead-update') });
      const saved = mapLead(asRecord(result.lead || result));
      setActiveLead(saved);
      setLeadDraft({ status: saved.status, note: saved.note });
      setLeads((current) => current.map((item) => item.id === saved.id ? saved : item));
    } catch (cause) {
      setError(describeApiError(cause, lang === 'zh' ? '线索处理结果保存失败' : 'Failed to save lead', lang));
    } finally {
      setSaving(false);
    }
  };

  const exportLeads = async () => {
    setSaving(true);
    setError('');
    try {
      const blob = await apiClient.downloadLeadExport({
        search: appliedFilters.search || undefined,
        status: appliedFilters.status || undefined,
        form_id: appliedFilters.formId || undefined,
        date_from: appliedFilters.dateFrom || undefined,
        date_to: appliedFilters.dateTo || undefined,
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `geoflow-leads-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(describeApiError(cause, lang === 'zh' ? '线索导出失败' : 'Lead export failed', lang));
    } finally {
      setSaving(false);
    }
  };

  const fieldLabels = useMemo(() => {
    if (!activeLead?.form) return {} as Record<string, string>;
    return Object.fromEntries(activeLead.form.fields.map((field) => [field.name, field.label]));
  }, [activeLead]);

  if (!canRead) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-6 text-amber-100">
        <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-5 w-5" />{lang === 'zh' ? '无权读取线索数据' : 'Lead data is restricted'}</div>
        <p className="mt-2 text-sm text-amber-200/80">{requiredScopeLabel('leads:read', lang)}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-indigo-300"><Inbox className="h-5 w-5" /><span className="text-xs font-semibold uppercase tracking-widest">桐灼GEO Leads</span></div>
          <h1 className="mt-2 text-2xl font-bold text-white">{lang === 'zh' ? '表单与线索中心' : 'Forms & Lead Center'}</h1>
          <p className="mt-1 text-sm text-slate-400">{lang === 'zh' ? '管理官网真实表单、查看持久化提交并记录跟进结果。' : 'Manage public forms, persisted submissions, and follow-up outcomes.'}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => mode === 'forms' ? void loadForms() : void loadLeads()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />{lang === 'zh' ? '刷新' : 'Refresh'}</button>
          {mode === 'forms' && <button type="button" onClick={() => setEditingForm({ id: 0, name: '', slug: '', status: 'active', description: '', submitButtonLabel: lang === 'zh' ? '提交' : 'Submit', successMessage: '', fields: defaultFields.map((field) => ({ ...field })), submissionsCount: 0, publicPath: '', updatedAt: '' })} disabled={!canWrite} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"><Plus className="h-4 w-4" />{lang === 'zh' ? '新建表单' : 'New form'}</button>}
          {mode === 'leads' && <button type="button" onClick={() => void exportLeads()} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"><Download className="h-4 w-4" />{lang === 'zh' ? '导出 CSV' : 'Export CSV'}</button>}
        </div>
      </div>

      <div className="inline-flex rounded-lg border border-slate-700 bg-slate-900 p-1">
        <button type="button" onClick={() => setMode('forms')} className={`rounded-md px-4 py-2 text-sm font-semibold ${mode === 'forms' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}>{lang === 'zh' ? '表单管理' : 'Forms'}</button>
        <button type="button" onClick={() => setMode('leads')} className={`rounded-md px-4 py-2 text-sm font-semibold ${mode === 'leads' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}`}>{lang === 'zh' ? '线索收件箱' : 'Lead inbox'}</button>
      </div>

      {error && <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-950/30 px-4 py-3 text-sm text-red-100"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}

      {mode === 'forms' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label={lang === 'zh' ? '全部表单' : 'Forms'} value={stats.total} />
            <Stat label={lang === 'zh' ? '启用中' : 'Active'} value={stats.active} tone="emerald" />
            <Stat label={lang === 'zh' ? '累计提交' : 'Submissions'} value={stats.submissions} tone="indigo" />
          </div>
          <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-4 sm:flex-row">
            <input value={formSearch} onChange={(event) => setFormSearch(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void loadForms(1)} placeholder={lang === 'zh' ? '搜索名称、标识或说明' : 'Search forms'} className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500" />
            <select value={formStatus} onChange={(event) => setFormStatus(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"><option value="">{lang === 'zh' ? '全部状态' : 'All statuses'}</option><option value="active">{lang === 'zh' ? '启用' : 'Active'}</option><option value="inactive">{lang === 'zh' ? '停用' : 'Inactive'}</option></select>
            <button type="button" onClick={() => void loadForms(1)} className="rounded-lg border border-indigo-500/40 px-4 py-2 text-sm font-semibold text-indigo-200 hover:bg-indigo-950/50">{lang === 'zh' ? '查询' : 'Search'}</button>
          </div>
          <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
            <div className="overflow-x-auto"><table className="min-w-full divide-y divide-slate-800 text-sm"><thead className="bg-slate-900"><tr className="text-left text-xs uppercase tracking-wide text-slate-500"><th className="px-4 py-3">{lang === 'zh' ? '表单' : 'Form'}</th><th className="px-4 py-3">{lang === 'zh' ? '公开地址' : 'Public URL'}</th><th className="px-4 py-3">{lang === 'zh' ? '状态' : 'Status'}</th><th className="px-4 py-3">{lang === 'zh' ? '提交数' : 'Submissions'}</th><th className="px-4 py-3 text-right">{lang === 'zh' ? '操作' : 'Actions'}</th></tr></thead><tbody className="divide-y divide-slate-800">
              {!loading && forms.length === 0 && <tr><td colSpan={5} className="px-4 py-12 text-center text-slate-500">{lang === 'zh' ? '暂无真实表单，可新建第一个表单。' : 'No persisted forms yet.'}</td></tr>}
              {forms.map((form) => <tr key={form.id} className="text-slate-200"><td className="px-4 py-4"><p className="font-semibold text-white">{form.name}</p><p className="mt-1 max-w-md truncate text-xs text-slate-500">{form.description || '-'}</p></td><td className="px-4 py-4"><a href={form.publicPath} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-indigo-300 hover:text-indigo-200">{form.publicPath}<ExternalLink className="h-3 w-3" /></a></td><td className="px-4 py-4"><span className={`rounded-full px-2 py-1 text-xs ${form.status === 'active' ? 'bg-emerald-950 text-emerald-300' : 'bg-slate-800 text-slate-400'}`}>{form.status === 'active' ? (lang === 'zh' ? '启用' : 'Active') : (lang === 'zh' ? '停用' : 'Inactive')}</span></td><td className="px-4 py-4 text-slate-300">{form.submissionsCount}</td><td className="px-4 py-4"><div className="flex justify-end gap-2"><button type="button" onClick={() => setEditingForm(form)} disabled={!canWrite} title={lang === 'zh' ? '编辑' : 'Edit'} className="rounded-md border border-slate-700 p-2 hover:bg-slate-800 disabled:opacity-30"><Pencil className="h-4 w-4" /></button><button type="button" onClick={() => void changeFormStatus(form)} disabled={!canWrite || saving} className="rounded-md border border-slate-700 px-3 py-1.5 text-xs hover:bg-slate-800 disabled:opacity-30">{form.status === 'active' ? (lang === 'zh' ? '停用' : 'Disable') : (lang === 'zh' ? '启用' : 'Enable')}</button><button type="button" onClick={() => void deleteForm(form)} disabled={!canWrite || form.submissionsCount > 0 || saving} title={form.submissionsCount > 0 ? (lang === 'zh' ? '已有线索，只能停用' : 'Disable forms with submissions') : (lang === 'zh' ? '删除' : 'Delete')} className="rounded-md border border-red-500/30 p-2 text-red-300 hover:bg-red-950/40 disabled:opacity-30"><Trash2 className="h-4 w-4" /></button></div></td></tr>)}
            </tbody></table></div>
            <Pagination meta={formMeta} lang={lang} onPage={(page) => void loadForms(page)} />
          </div>
        </>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4"><Stat label={lang === 'zh' ? '累计线索' : 'All leads'} value={stats.submissions} /><Stat label={lang === 'zh' ? '新线索' : 'New'} value={stats.new} tone="indigo" /><Stat label={lang === 'zh' ? '待跟进' : 'Pending'} value={stats.pending} tone="amber" /><Stat label={lang === 'zh' ? '已转化' : 'Converted'} value={stats.converted} tone="emerald" /></div>
          <div className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-4 md:grid-cols-6">
            <input value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} placeholder={lang === 'zh' ? '搜索提交内容/来源/备注' : 'Search leads'} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white md:col-span-2" />
            <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"><option value="">{lang === 'zh' ? '全部状态' : 'All statuses'}</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label[lang]}</option>)}</select>
            <select value={filters.formId} onChange={(event) => setFilters({ ...filters, formId: event.target.value })} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"><option value="">{lang === 'zh' ? '全部表单' : 'All forms'}</option>{forms.map((form) => <option key={form.id} value={form.id}>{form.name}</option>)}</select>
            <input type="date" value={filters.dateFrom} onChange={(event) => setFilters({ ...filters, dateFrom: event.target.value })} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
            <input type="date" value={filters.dateTo} onChange={(event) => setFilters({ ...filters, dateTo: event.target.value })} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
            <div className="flex gap-2 md:col-span-6"><button type="button" onClick={() => { setAppliedFilters(filters); void loadLeads(1, filters); }} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500">{lang === 'zh' ? '应用筛选' : 'Apply'}</button><button type="button" onClick={() => { const reset = { search: '', status: '', formId: '', dateFrom: '', dateTo: '' }; setFilters(reset); setAppliedFilters(reset); void loadLeads(1, reset); }} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">{lang === 'zh' ? '重置' : 'Reset'}</button></div>
          </div>
          <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70"><div className="overflow-x-auto"><table className="min-w-full divide-y divide-slate-800 text-sm"><thead><tr className="text-left text-xs uppercase tracking-wide text-slate-500"><th className="px-4 py-3">{lang === 'zh' ? '提交内容' : 'Submission'}</th><th className="px-4 py-3">{lang === 'zh' ? '表单' : 'Form'}</th><th className="px-4 py-3">{lang === 'zh' ? '状态' : 'Status'}</th><th className="px-4 py-3">{lang === 'zh' ? '来源' : 'Source'}</th><th className="px-4 py-3">{lang === 'zh' ? '时间' : 'Created'}</th></tr></thead><tbody className="divide-y divide-slate-800">
            {!loading && leads.length === 0 && <tr><td colSpan={5} className="px-4 py-12 text-center text-slate-500">{lang === 'zh' ? '当前筛选下没有真实线索。' : 'No persisted leads match these filters.'}</td></tr>}
            {leads.map((lead) => <tr key={lead.id} onClick={() => void openLead(lead)} className="cursor-pointer text-slate-300 hover:bg-slate-800/60"><td className="px-4 py-4"><div className="space-y-1">{Object.entries(lead.payload).slice(0, 3).map(([key, value]) => <p key={key} className="max-w-sm truncate"><span className="text-slate-500">{key}：</span>{typeof value === 'boolean' ? (value ? '✓' : '✕') : value}</p>)}</div></td><td className="px-4 py-4">{lead.form?.name || (lang === 'zh' ? '已删除表单' : 'Deleted form')}</td><td className="px-4 py-4"><span className="rounded-full bg-indigo-950 px-2 py-1 text-xs text-indigo-300">{statusLabels[lead.status]?.[lang] || lead.status}</span></td><td className="max-w-xs truncate px-4 py-4 text-xs text-slate-500">{lead.hostedSite?.hostname || lead.sourceUrl || '-'}</td><td className="whitespace-nowrap px-4 py-4 text-xs text-slate-500">{displayDate(lead.createdAt)}</td></tr>)}
          </tbody></table></div><Pagination meta={leadMeta} lang={lang} onPage={(page) => void loadLeads(page)} /></div>
        </>
      )}

      {loading && <div className="fixed bottom-5 right-5 flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-200 shadow-xl"><Loader2 className="h-4 w-4 animate-spin" />{lang === 'zh' ? '读取真实数据…' : 'Loading persisted data…'}</div>}
      {editingForm !== undefined && <FormEditor form={editingForm} lang={lang} saving={saving} onClose={() => setEditingForm(undefined)} onSave={(form) => void saveForm(form)} />}
      {activeLead && <LeadDetail lead={activeLead} draft={leadDraft} setDraft={setLeadDraft} lang={lang} canWrite={canWrite} saving={saving} labels={fieldLabels} onClose={() => setActiveLead(null)} onSave={() => void saveLead()} />}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: number; tone?: 'indigo' | 'emerald' | 'amber' }> = ({ label, value, tone = 'indigo' }) => <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4"><p className="text-xs uppercase tracking-wide text-slate-500">{label}</p><p className={`mt-2 text-2xl font-bold ${tone === 'emerald' ? 'text-emerald-300' : tone === 'amber' ? 'text-amber-300' : 'text-indigo-300'}`}>{value}</p></div>;

const Pagination: React.FC<{ meta: PageMeta; lang: Lang; onPage: (page: number) => void }> = ({ meta, lang, onPage }) => <div className="flex items-center justify-between border-t border-slate-800 px-4 py-3 text-xs text-slate-500"><span>{lang === 'zh' ? `共 ${meta.total} 条` : `${meta.total} total`}</span><div className="flex items-center gap-2"><button type="button" onClick={() => onPage(meta.page - 1)} disabled={meta.page <= 1} className="rounded border border-slate-700 p-1.5 disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button><span>{meta.page} / {meta.totalPages}</span><button type="button" onClick={() => onPage(meta.page + 1)} disabled={meta.page >= meta.totalPages} className="rounded border border-slate-700 p-1.5 disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button></div></div>;

const FormEditor: React.FC<{ form: LeadFormRecord | null; lang: Lang; saving: boolean; onClose: () => void; onSave: (form: LeadFormRecord) => void }> = ({ form, lang, saving, onClose, onSave }) => {
  const [draft, setDraft] = useState<LeadFormRecord>(form || { id: 0, name: '', slug: '', status: 'active', description: '', submitButtonLabel: '提交', successMessage: '', fields: defaultFields, submissionsCount: 0, publicPath: '', updatedAt: '' });
  const updateField = (index: number, patch: Partial<LeadField>) => setDraft((current) => ({ ...current, fields: current.fields.map((field, idx) => idx === index ? { ...field, ...patch } : field) }));
  const valid = draft.name.trim() !== '' && draft.fields.some((field) => field.label.trim() !== '');
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"><div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-800 bg-slate-900 px-5 py-4"><div><h2 className="font-bold text-white">{draft.id ? (lang === 'zh' ? '编辑表单' : 'Edit form') : (lang === 'zh' ? '新建表单' : 'New form')}</h2><p className="text-xs text-slate-500">{lang === 'zh' ? '保存后立即写入 桐灼GEO 数据库；启用后公开地址可提交。' : 'Saves to 桐灼GEO; active forms accept public submissions.'}</p></div><button type="button" onClick={onClose} className="rounded p-2 text-slate-400 hover:bg-slate-800"><X className="h-5 w-5" /></button></div><div className="space-y-5 p-5"><div className="grid gap-4 md:grid-cols-2"><Field label={lang === 'zh' ? '表单名称' : 'Name'}><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="control" /></Field><Field label={lang === 'zh' ? 'URL 标识' : 'Slug'}><input value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })} placeholder="contact-us" className="control font-mono" /></Field><Field label={lang === 'zh' ? '状态' : 'Status'}><select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as LeadFormRecord['status'] })} className="control"><option value="active">{lang === 'zh' ? '启用' : 'Active'}</option><option value="inactive">{lang === 'zh' ? '停用' : 'Inactive'}</option></select></Field><Field label={lang === 'zh' ? '提交按钮文案' : 'Submit label'}><input value={draft.submitButtonLabel} onChange={(event) => setDraft({ ...draft, submitButtonLabel: event.target.value })} className="control" /></Field><Field label={lang === 'zh' ? '说明' : 'Description'} wide><textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={2} className="control" /></Field><Field label={lang === 'zh' ? '成功提示' : 'Success message'} wide><textarea value={draft.successMessage} onChange={(event) => setDraft({ ...draft, successMessage: event.target.value })} rows={2} className="control" /></Field></div><div><div className="mb-3 flex items-center justify-between"><h3 className="font-semibold text-white">{lang === 'zh' ? '动态字段' : 'Fields'}</h3><button type="button" onClick={() => setDraft({ ...draft, fields: [...draft.fields, { name: '', label: '', type: 'text', required: false, options: [] }] })} className="inline-flex items-center gap-1 rounded border border-indigo-500/40 px-3 py-1.5 text-xs text-indigo-200"><Plus className="h-3 w-3" />{lang === 'zh' ? '添加字段' : 'Add field'}</button></div><div className="space-y-3">{draft.fields.map((field, index) => <div key={index} className="grid gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3 md:grid-cols-12"><input value={field.label} onChange={(event) => updateField(index, { label: event.target.value })} placeholder={lang === 'zh' ? '显示名称' : 'Label'} className="control md:col-span-3" /><input value={field.name} onChange={(event) => updateField(index, { name: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} placeholder={lang === 'zh' ? '字段名（可留空）' : 'Field name'} className="control font-mono md:col-span-2" /><select value={field.type} onChange={(event) => updateField(index, { type: event.target.value as LeadField['type'] })} className="control md:col-span-2">{['text', 'phone', 'email', 'textarea', 'select', 'checkbox'].map((type) => <option key={type} value={type}>{type}</option>)}</select><input value={field.options.join(', ')} onChange={(event) => updateField(index, { options: event.target.value.split(/[,，|]/).map((option) => option.trim()).filter(Boolean) })} disabled={!['select', 'checkbox'].includes(field.type)} placeholder={lang === 'zh' ? '选项，逗号分隔' : 'Comma-separated options'} className="control disabled:opacity-40 md:col-span-3" /><label className="flex items-center gap-2 text-xs text-slate-300 md:col-span-1"><input type="checkbox" checked={field.required} onChange={(event) => updateField(index, { required: event.target.checked })} />{lang === 'zh' ? '必填' : 'Required'}</label><button type="button" onClick={() => setDraft({ ...draft, fields: draft.fields.filter((_, idx) => idx !== index) })} className="rounded border border-red-500/30 p-2 text-red-300 md:col-span-1"><Trash2 className="mx-auto h-4 w-4" /></button></div>)}</div></div></div><div className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-800 bg-slate-900 px-5 py-4"><button type="button" onClick={onClose} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300">{lang === 'zh' ? '取消' : 'Cancel'}</button><button type="button" onClick={() => onSave(draft)} disabled={!valid || saving} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{lang === 'zh' ? '保存到数据库' : 'Save'}</button></div></div></div>;
};

const Field: React.FC<{ label: string; wide?: boolean; children: React.ReactNode }> = ({ label, wide, children }) => <label className={wide ? 'md:col-span-2' : ''}><span className="mb-1.5 block text-xs font-medium text-slate-400">{label}</span>{children}</label>;

const LeadDetail: React.FC<{ lead: LeadRecord; draft: { status: string; note: string }; setDraft: React.Dispatch<React.SetStateAction<{ status: string; note: string }>>; lang: Lang; canWrite: boolean; saving: boolean; labels: Record<string, string>; onClose: () => void; onSave: () => void }> = ({ lead, draft, setDraft, lang, canWrite, saving, labels, onClose, onSave }) => <div className="fixed inset-0 z-50 flex justify-end bg-black/65"><div className="h-full w-full max-w-2xl overflow-y-auto border-l border-slate-700 bg-slate-900 shadow-2xl"><div className="sticky top-0 flex items-center justify-between border-b border-slate-800 bg-slate-900 px-5 py-4"><div><h2 className="font-bold text-white">{lang === 'zh' ? `线索 #${lead.id}` : `Lead #${lead.id}`}</h2><p className="text-xs text-slate-500">{lead.form?.name || (lang === 'zh' ? '已删除表单' : 'Deleted form')}</p></div><button type="button" onClick={onClose} className="rounded p-2 text-slate-400 hover:bg-slate-800"><X className="h-5 w-5" /></button></div><div className="space-y-6 p-5"><section className="rounded-xl border border-slate-800 bg-slate-950/40"><div className="border-b border-slate-800 px-4 py-3 font-semibold text-white">{lang === 'zh' ? '提交内容' : 'Submission'}</div><dl className="divide-y divide-slate-800">{Object.entries(lead.payload).map(([key, value]) => <div key={key} className="grid gap-1 px-4 py-3 sm:grid-cols-3"><dt className="text-xs text-slate-500">{labels[key] || key}</dt><dd className="break-words text-sm text-slate-200 sm:col-span-2">{typeof value === 'boolean' ? (value ? (lang === 'zh' ? '是' : 'Yes') : (lang === 'zh' ? '否' : 'No')) : value}</dd></div>)}</dl></section><section className="grid gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-sm sm:grid-cols-2"><Meta label={lang === 'zh' ? '来源' : 'Source'} value={lead.sourceUrl || '-'} /><Meta label={lang === 'zh' ? '站点' : 'Site'} value={lead.hostedSite?.hostname || (lang === 'zh' ? '主站' : 'Primary site')} /><Meta label="IP" value={lead.ipAddress || '-'} /><Meta label="User Agent" value={lead.userAgent || '-'} /><Meta label={lang === 'zh' ? '提交时间' : 'Created'} value={displayDate(lead.createdAt)} /><Meta label={lang === 'zh' ? '处理人' : 'Handler'} value={lead.handler?.username || '-'} /></section><section className="space-y-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4"><div className="flex items-center gap-2 font-semibold text-white"><CheckCircle2 className="h-4 w-4 text-emerald-400" />{lang === 'zh' ? '跟进记录' : 'Follow-up'}</div><Field label={lang === 'zh' ? '状态' : 'Status'}><select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })} disabled={!canWrite} className="control">{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label[lang]}</option>)}</select></Field><Field label={lang === 'zh' ? '备注' : 'Note'}><textarea value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} disabled={!canWrite} rows={6} className="control" /></Field>{canWrite ? <button type="button" onClick={onSave} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{lang === 'zh' ? '保存处理结果' : 'Save outcome'}</button> : <p className="text-xs text-amber-300">{requiredScopeLabel('leads:write', lang)}</p>}</section></div></div></div>;

const Meta: React.FC<{ label: string; value: string }> = ({ label, value }) => <div><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 break-words text-slate-200">{value}</dd></div>;
