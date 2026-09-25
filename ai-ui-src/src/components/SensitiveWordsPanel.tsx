import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Save, Search, ShieldAlert, Trash2 } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';
import PermissionNotice from './PermissionNotice';

interface SensitiveWordsPanelProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  canRead: boolean;
  canWrite: boolean;
  isSuperAdmin?: boolean;
}

const SEVERITIES = ['warning', 'blocked'] as const;

/** 与后端 `SiteSensitiveWordApiController::SCOPES` 一致；改了要两边一起改。 */
const SCOPES = ['title', 'excerpt', 'content', 'keywords', 'meta_description'] as const;

const SEVERITY_LABELS: Record<string, { zh: string; en: string }> = {
  warning: { zh: '警告', en: 'Warning' },
  blocked: { zh: '拦截', en: 'Blocked' },
};

const SCOPE_LABELS: Record<string, { zh: string; en: string }> = {
  title: { zh: '标题', en: 'Title' },
  excerpt: { zh: '摘要', en: 'Excerpt' },
  content: { zh: '正文', en: 'Content' },
  keywords: { zh: '关键词', en: 'Keywords' },
  meta_description: { zh: '描述', en: 'Meta description' },
};

const key = (prefix: string) => `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
const record = (value: unknown): ApiRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};

type Draft = {
  words: string;
  severity: string;
  category: string;
  suggestion: string;
  applies_to: string[];
};

const emptyDraft = (): Draft => ({ words: '', severity: 'warning', category: '', suggestion: '', applies_to: [] });

/**
 * 敏感词规则管理。
 *
 * 这张表不是展示品——`ArticleRiskScanner` 直接拿它做文章质检，所以退役后如果改不了，
 * 规则集就冻结在部署值上，质量门禁会一直按旧规则跑。
 *
 * 三个必须如实显示的东西：**规则总数与上限**（撞了 422 才发现太晚）、**severity**
 * （警告与拦截是两种后果）、**applies_to**（同一个词在正文里和在标题里可以是两种规则）。
 */
const SensitiveWordsPanel: React.FC<SensitiveWordsPanelProps> = ({
  apiClient, lang, canRead, canWrite, isSuperAdmin = false,
}) => {
  const zh = lang === 'zh';
  const [rules, setRules] = useState<ApiRecord[]>([]);
  const [limit, setLimit] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string>('');
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft);

  const canMutate = canWrite && isSuperAdmin;

  const load = useCallback(async (keyword: string) => {
    if (!canRead) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiClient.listSensitiveWords(keyword.trim() === '' ? undefined : keyword.trim());
      setRules(Array.isArray(data.items) ? (data.items as ApiRecord[]).map(record) : []);
      setLimit(Number(data.limit ?? 0));
    } catch (loadError) {
      setError(describeApiError(loadError, zh ? '读取敏感词失败' : 'Unable to load rules', lang));
    } finally {
      setLoading(false);
    }
  }, [apiClient, canRead, lang, zh]);

  useEffect(() => { void load(''); }, [load]);

  const fail = (mutationError: unknown, fallback: string) => setError(describeApiError(mutationError, fallback, lang));

  const submitNew = async () => {
    if (busy || draft.words.trim() === '') return;
    setBusy('add'); setError(''); setNotice('');
    try {
      const data = await apiClient.storeSensitiveWords({
        words: draft.words,
        severity: draft.severity,
        category: draft.category,
        suggestion: draft.suggestion,
        applies_to: draft.applies_to,
      }, { idempotencyKey: key('sensitive-words-add') });
      setNotice(zh ? `已新增 ${Number(data.inserted ?? 0)} 条规则。` : `Added ${Number(data.inserted ?? 0)} rules.`);
      setDraft(emptyDraft());
      setAdding(false);
      await load(search);
    } catch (mutationError) {
      fail(mutationError, zh ? '新增失败' : 'Unable to add');
    } finally {
      setBusy('');
    }
  };

  const beginEdit = (rule: ApiRecord) => {
    setEditingId(String(rule.id));
    setEditDraft({
      words: String(rule.word ?? ''),
      severity: String(rule.severity ?? 'warning'),
      category: String(rule.category ?? ''),
      suggestion: String(rule.suggestion ?? ''),
      applies_to: Array.isArray(rule.applies_to) ? (rule.applies_to as string[]) : [],
    });
  };

  const saveEdit = async () => {
    if (busy || editingId === '') return;
    setBusy(`save-${editingId}`); setError(''); setNotice('');
    try {
      // PATCH 是全量更新，必须把 `is_enabled` 原样带上。以前这里**硬编码 true**：
      // 运营编辑一条已停用的规则（比如某词在特定语境误拦）改完保存，规则就静默复活，
      // 而编辑表单里没有启用开关、列表上的「已停用」徽标也会消失——看不出是自己打开的。
      const current = rules.find((rule) => String(rule.id) === editingId);
      await apiClient.updateSensitiveWord(editingId, {
        word: editDraft.words.trim(),
        severity: editDraft.severity,
        category: editDraft.category,
        is_enabled: current?.is_enabled === true,
        suggestion: editDraft.suggestion,
        applies_to: editDraft.applies_to,
      }, { idempotencyKey: key(`sensitive-word-save-${editingId}`) });
      setNotice(zh ? '已保存。' : 'Saved.');
      setEditingId('');
      await load(search);
    } catch (mutationError) {
      fail(mutationError, zh ? '保存失败' : 'Unable to save');
    } finally {
      setBusy('');
    }
  };

  const toggleEnabled = async (rule: ApiRecord) => {
    if (busy) return;
    const id = String(rule.id);
    setBusy(`toggle-${id}`); setError('');
    try {
      // PATCH 是全量更新：切开关也必须把其余字段原样回传，否则会被清空。
      await apiClient.updateSensitiveWord(id, {
        word: String(rule.word ?? ''),
        severity: String(rule.severity ?? 'warning'),
        category: String(rule.category ?? ''),
        is_enabled: !(rule.is_enabled === true),
        suggestion: String(rule.suggestion ?? ''),
        applies_to: Array.isArray(rule.applies_to) ? rule.applies_to : [],
      }, { idempotencyKey: key(`sensitive-word-toggle-${id}`) });
      await load(search);
    } catch (mutationError) {
      fail(mutationError, zh ? '切换失败' : 'Unable to toggle');
    } finally {
      setBusy('');
    }
  };

  const remove = async (rule: ApiRecord) => {
    if (busy) return;
    const id = String(rule.id);
    setBusy(`delete-${id}`); setError(''); setNotice('');
    try {
      await apiClient.deleteSensitiveWord(id, { idempotencyKey: key(`sensitive-word-delete-${id}`) });
      setNotice(zh ? '已删除。' : 'Deleted.');
      await load(search);
    } catch (mutationError) {
      fail(mutationError, zh ? '删除失败' : 'Unable to delete');
    } finally {
      setBusy('');
    }
  };

  const scopePicker = (selected: string[], onToggle: (next: string[]) => void) => (
    <div className="flex flex-wrap gap-2">
      {SCOPES.map((scope) => (
        <label key={scope} className="inline-flex items-center gap-1 text-[11px] text-slate-400">
          <input
            type="checkbox"
            checked={selected.includes(scope)}
            onChange={() => onToggle(selected.includes(scope) ? selected.filter((item) => item !== scope) : [...selected, scope])}
            className="accent-indigo-500"
          />
          {SCOPE_LABELS[scope][lang]}
        </label>
      ))}
      <span className="text-[10px] text-slate-600">{zh ? '不勾选 = 全部位置生效' : 'None checked = all scopes'}</span>
    </div>
  );

  const draftFields = (value: Draft, onChange: (next: Draft) => void, wordInput: boolean) => (
    <div className="space-y-2">
      {wordInput ? (
        <textarea
          value={value.words}
          onChange={(event) => onChange({ ...value, words: event.target.value })}
          rows={4}
          placeholder={zh ? '每行一个敏感词，也可以一次贴一整段' : 'One word per line'}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-200"
        />
      ) : (
        <input value={value.words} onChange={(event) => onChange({ ...value, words: event.target.value })} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white" />
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-[11px] text-slate-400">
          {zh ? '处理方式' : 'Severity'}
          <select value={value.severity} onChange={(event) => onChange({ ...value, severity: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white">
            {SEVERITIES.map((severity) => <option key={severity} value={severity}>{SEVERITY_LABELS[severity][lang]}</option>)}
          </select>
        </label>
        <label className="text-[11px] text-slate-400">
          {zh ? '分类' : 'Category'}
          <input value={value.category} onChange={(event) => onChange({ ...value, category: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" />
        </label>
        <label className="text-[11px] text-slate-400">
          {zh ? '修改建议' : 'Suggestion'}
          <input value={value.suggestion} onChange={(event) => onChange({ ...value, suggestion: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" />
        </label>
      </div>
      {scopePicker(value.applies_to, (next) => onChange({ ...value, applies_to: next }))}
    </div>
  );

  return (
    <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold text-white">
          <ShieldAlert className="h-4 w-4 text-amber-400" />
          {zh ? '敏感词规则' : 'Sensitive words'}
          <span className="text-[11px] font-normal text-slate-500">{rules.length}{limit > 0 ? ` / ${limit}` : ''}</span>
        </h3>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void load(search); }}
              placeholder={zh ? '搜索，回车执行' : 'Search, press Enter'}
              className="w-44 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 pl-8 text-xs text-white outline-none focus:border-indigo-500"
            />
          </div>
          {canMutate && (
            <button type="button" onClick={() => setAdding((previous) => !previous)} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500">
              <Plus className="h-3.5 w-3.5" />{zh ? '新增' : 'Add'}
            </button>
          )}
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-slate-500">
        {zh
          ? '这些规则会直接被文章质检使用：命中「警告」会在质检里提示，命中「拦截」会挡住文章流转。'
          : 'These rules feed article quality inspection directly: "warning" surfaces a finding, "blocked" stops the article.'}
      </p>

      {!canRead && <PermissionNotice lang={lang} mode="read" requiredScope="seo:read" />}
      {canRead && canWrite && !isSuperAdmin && <PermissionNotice lang={lang} requiredScope="super_admin" />}

      {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">{notice}</div>}

      {canMutate && adding && (
        <div className="space-y-2 rounded-xl border border-indigo-500/30 bg-slate-950/60 p-3">
          {draftFields(draft, setDraft, true)}
          <div className="flex gap-2">
            <button type="button" onClick={() => void submitNew()} disabled={busy === 'add' || draft.words.trim() === ''} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
              {busy === 'add' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}{zh ? '提交' : 'Submit'}
            </button>
            <button type="button" onClick={() => { setAdding(false); setDraft(emptyDraft()); }} className="text-xs text-slate-400 hover:text-slate-200">{zh ? '取消' : 'Cancel'}</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex min-h-24 items-center justify-center text-xs text-slate-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{zh ? '读取规则…' : 'Loading rules…'}</div>
      ) : rules.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 px-4 py-8 text-center text-xs text-slate-500">
          {search.trim() === '' ? (zh ? '还没有敏感词规则' : 'No rules configured yet') : (zh ? '没有匹配的规则' : 'No matching rule')}
        </div>
      ) : (
        <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
          {rules.map((rule) => {
            const id = String(rule.id);
            if (editingId === id) {
              return (
                <div key={id} className="space-y-2 rounded-lg border border-indigo-500/40 bg-slate-950/60 p-3">
                  {draftFields(editDraft, setEditDraft, false)}
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void saveEdit()} disabled={busy === `save-${id}`} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
                      {busy === `save-${id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}{zh ? '保存' : 'Save'}
                    </button>
                    <button type="button" onClick={() => setEditingId('')} className="text-xs text-slate-400 hover:text-slate-200">{zh ? '取消' : 'Cancel'}</button>
                  </div>
                </div>
              );
            }
            const appliesTo = Array.isArray(rule.applies_to) ? (rule.applies_to as string[]) : [];
            return (
              <div key={id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all text-xs font-semibold text-slate-200">{String(rule.word ?? '')}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${String(rule.severity) === 'blocked' ? 'bg-rose-500/20 text-rose-300' : 'bg-amber-500/20 text-amber-300'}`}>
                      {SEVERITY_LABELS[String(rule.severity)]?.[lang] ?? String(rule.severity)}
                    </span>
                    {rule.is_enabled !== true && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{zh ? '已停用' : 'Disabled'}</span>}
                  </div>
                  <div className="mt-1 text-[10px] text-slate-500">
                    {String(rule.category ?? '') !== '' && <span className="mr-2">{String(rule.category)}</span>}
                    {appliesTo.length > 0 ? appliesTo.map((scope) => SCOPE_LABELS[scope]?.[lang] ?? scope).join('、') : (zh ? '全部位置' : 'All scopes')}
                    {String(rule.suggestion ?? '') !== '' && <span className="ml-2">{zh ? '建议：' : 'Suggestion: '}{String(rule.suggestion)}</span>}
                  </div>
                </div>
                {canMutate && (
                  <div className="flex shrink-0 items-center gap-2 text-[11px]">
                    <button type="button" onClick={() => void toggleEnabled(rule)} disabled={busy === `toggle-${id}`} className="text-slate-300 hover:text-white disabled:opacity-40">
                      {rule.is_enabled === true ? (zh ? '停用' : 'Disable') : (zh ? '启用' : 'Enable')}
                    </button>
                    <button type="button" onClick={() => beginEdit(rule)} className="text-slate-300 hover:text-white">{zh ? '编辑' : 'Edit'}</button>
                    <button type="button" onClick={() => void remove(rule)} disabled={busy === `delete-${id}`} className="text-rose-300 hover:text-rose-200 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};

export default SensitiveWordsPanel;
