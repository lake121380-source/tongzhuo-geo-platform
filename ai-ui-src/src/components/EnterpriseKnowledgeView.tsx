import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BrainCircuit, CheckCircle2, FilePlus2, History, ImagePlus, Save, Send, ShieldCheck, Trash2 } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';
import { LoadingState } from './LoadingState';

interface EnterpriseKnowledgeViewProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  canRead: boolean;
  canWrite: boolean;
}

const asRecord = (value: unknown): ApiRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
const asString = (value: unknown, fallback = ''): string => value == null ? fallback : String(value);
const asNumber = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0;

/** Enterprise knowledge draft UI backed entirely by 桐灼GEO's durable workflow API. */
export const EnterpriseKnowledgeView: React.FC<EnterpriseKnowledgeViewProps> = ({ apiClient, lang, canRead, canWrite }) => {
  const zh = lang === 'zh';
  const [projects, setProjects] = useState<ApiRecord[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ApiRecord | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [validationItems, setValidationItems] = useState<ApiRecord[]>([]);
  const [requiresDangerConfirmation, setRequiresDangerConfirmation] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const loadProjects = useCallback(async () => {
    if (!canRead) return;
    try {
      const result = asRecord(await apiClient.listEnterpriseKnowledge({ page: 1, per_page: 50 }));
      const rows = Array.isArray(result.items) ? result.items.map(asRecord) : [];
      setProjects(rows);
      if (!selectedId && rows[0]) setSelectedId(asNumber(rows[0].id));
    } finally {
      setLoading(false);
    }
  }, [apiClient, canRead, selectedId]);

  const loadDetail = useCallback(async (id: number) => {
    const result = asRecord(await apiClient.getEnterpriseKnowledge(id));
    const item = asRecord(result.item);
    setDetail(item);
    setName(asString(item.name));
    setDescription(asString(item.description));
    setContent(asString(item.draft_content));
    setValidationItems(Array.isArray(item.validation_items) ? item.validation_items.map(asRecord) : []);
    setRequiresDangerConfirmation(false);
  }, [apiClient]);

  useEffect(() => { void loadProjects().catch((failure) => setError(describeApiError(failure, zh ? '无法读取企业知识项目' : 'Unable to load enterprise knowledge', lang))); }, [loadProjects, zh, lang]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId).catch((failure) => setError(describeApiError(failure, zh ? '无法读取项目详情' : 'Unable to load project', lang))); }, [loadDetail, selectedId, zh, lang]);

  useEffect(() => {
    if (!selectedId || !detail || !['queued', 'processing'].includes(asString(detail.status))) return;
    const timer = window.setInterval(() => {
      void apiClient.getEnterpriseKnowledgeStatus(selectedId).then((status) => {
        const next = asRecord(status);
        setDetail((previous) => ({ ...(previous || {}), ...next }));
        if (next.reload) void loadDetail(selectedId);
      }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [apiClient, detail, loadDetail, selectedId]);

  const run = async (action: string, callback: () => Promise<ApiRecord>) => {
    setBusy(action); setError(''); setMessage('');
    try {
      const result = await callback();
      setMessage(action === 'validate'
        ? (zh ? '已完成服务端草稿校验' : 'Server-side draft validation completed')
        : action === 'publish'
          ? (zh ? '已发布到知识库，并已请求后端切片' : 'Published to the knowledge base; backend chunking was requested')
          : (zh ? '已保存到 桐灼GEO' : 'Saved to 桐灼GEO'));
      if (action === 'delete') { setSelectedId(null); setDetail(null); setContent(''); }
      else if (selectedId) await loadDetail(selectedId);
      await loadProjects();
      return result;
    }
    catch (failure) { setError(describeApiError(failure, zh ? '操作失败' : 'Operation failed', lang)); throw failure; }
    finally { setBusy(''); }
  };

  const create = () => run('create', async () => {
    if (sourceFile) {
      const formData = new FormData();
      formData.set('name', name);
      formData.set('description', description);
      formData.set('enterprise_files[]', sourceFile);
      return apiClient.createEnterpriseKnowledge(formData, { idempotencyKey: `enterprise-create-${Date.now()}` });
    }
    return apiClient.createEnterpriseKnowledge({ name, description, content }, { idempotencyKey: `enterprise-create-${Date.now()}` });
  });
  const save = () => selectedId ? run('save', () => apiClient.autosaveEnterpriseKnowledge(selectedId, content, { idempotencyKey: `enterprise-save-${selectedId}-${Date.now()}` })) : Promise.resolve();

  const validate = async (): Promise<ApiRecord[]> => {
    if (!selectedId) return [];
    const result = await run('validate', () => apiClient.validateEnterpriseKnowledge(selectedId, content, { idempotencyKey: `enterprise-validate-${selectedId}-${Date.now()}` }));
    const items = Array.isArray(result.validation_items) ? result.validation_items.map(asRecord) : [];
    setValidationItems(items);
    return items;
  };

  const publish = async (confirmedDanger = false) => {
    if (!selectedId) return;
    if (!confirmedDanger) {
      const items = await validate();
      if (items.some((item) => asString(item.level) === 'danger')) {
        setRequiresDangerConfirmation(true);
        setMessage(zh ? '校验发现危险项；请阅读下方提示后明确确认发布。' : 'Validation found danger items. Review them and explicitly confirm publication below.');
        return;
      }
    }
    setRequiresDangerConfirmation(false);
    await run('publish', () => apiClient.publishEnterpriseKnowledge(selectedId, { idempotencyKey: `enterprise-publish-${selectedId}-${Date.now()}` }));
  };

  const uploadImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null;
    event.target.value = '';
    if (!file || !selectedId) return;

    await run('image', async () => {
      const formData = new FormData();
      formData.set('image', file);
      const result = asRecord(await apiClient.uploadEnterpriseKnowledgeImage(selectedId, formData, {
        idempotencyKey: `enterprise-image-${selectedId}-${Date.now()}`,
      }));
      const image = asRecord(result.image);
      const markdown = asString(image.markdown);
      if (!markdown) throw new Error(zh ? '服务器没有返回图片 Markdown' : 'The server did not return image Markdown');

      const nextContent = content.trim() === ''
        ? markdown
        : `${content.replace(/\s+$/, '')}\n\n${markdown}`;
      await apiClient.autosaveEnterpriseKnowledge(selectedId, nextContent, {
        idempotencyKey: `enterprise-image-save-${selectedId}-${Date.now()}`,
      });
      setContent(nextContent);
      return result;
    });
  };

  if (!canRead) return <div className="rounded-xl border border-rose-500/30 bg-rose-950/20 px-4 py-4 text-xs text-rose-200">{zh ? '当前 Token 没有 materials:read，企业知识工作台不可用。' : 'The current token lacks materials:read.'}</div>;

  return <section className="space-y-4 rounded-2xl border border-indigo-500/30 bg-slate-900/80 p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="flex items-center gap-2 text-sm font-bold text-white"><BrainCircuit className="h-4 w-4 text-indigo-300" />{zh ? '企业知识 AI 草稿工作台' : 'Enterprise knowledge AI drafts'}</h2><p className="mt-1 text-[11px] text-slate-500">{zh ? '沿用 桐灼GEO 的来源解析、生成队列、校验、版本和发布链路。' : 'Source parsing, AI queue, validation, revisions and publishing all run in 桐灼GEO.'}</p></div>
      {canWrite && <button type="button" onClick={() => { setSelectedId(null); setDetail(null); setName(''); setDescription(''); setContent(''); setSourceFile(null); setMessage(''); }} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] text-white hover:bg-indigo-500"><FilePlus2 className="h-3.5 w-3.5" />{zh ? '新建项目' : 'New project'}</button>}
    </div>
    {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{error}</div>}
    {message && <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-200"><CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />{message}</div>}
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
      <div className="space-y-2 lg:col-span-1">{loading && projects.length === 0 ? <LoadingState lang={lang} variant="inline" label={zh ? '正在读取企业知识项目…' : 'Loading enterprise projects…'} /> : projects.length === 0 ? <p className="text-xs text-slate-500">{zh ? '暂无企业知识项目' : 'No projects yet'}</p> : projects.map((project) => <button type="button" key={String(project.id)} onClick={() => setSelectedId(asNumber(project.id))} className={`w-full rounded-lg border p-2.5 text-left ${asNumber(project.id) === selectedId ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-800 bg-slate-950/40'}`}><div className="truncate text-xs font-semibold text-slate-200">{asString(project.name)}</div><div className="mt-1 text-[10px] text-slate-500">{asString(project.status)}</div></button>)}</div>
      <div className="space-y-3 lg:col-span-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2"><input value={name} onChange={(event) => setName(event.target.value)} disabled={!canWrite || Boolean(selectedId)} placeholder={zh ? '项目名称' : 'Project name'} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white" /><input value={description} onChange={(event) => setDescription(event.target.value)} disabled={!canWrite || Boolean(selectedId)} placeholder={zh ? '业务线/描述' : 'Description'} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white" /></div>
        {!selectedId && canWrite && <input type="file" accept=".txt,.md,.markdown,.docx" onChange={(event) => setSourceFile(event.target.files?.[0] || null)} className="block w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-[11px] text-slate-400 file:mr-2 file:rounded file:border-0 file:bg-slate-800 file:px-2 file:py-1 file:text-[10px] file:text-slate-200" />}
        <textarea value={content} onChange={(event) => { setContent(event.target.value); setRequiresDangerConfirmation(false); }} disabled={!canWrite} rows={12} placeholder={zh ? '粘贴企业资料，创建后 桐灼GEO 会异步生成结构化草稿。' : 'Paste enterprise source material; 桐灼GEO generates a structured draft asynchronously.'} className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs leading-relaxed text-slate-200" />
        <div className="flex flex-wrap items-center gap-2">
          {!selectedId && canWrite && <button type="button" onClick={() => void create()} disabled={busy !== '' || !name.trim() || (!content.trim() && !sourceFile)} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"><BrainCircuit className="h-3.5 w-3.5" />{busy === 'create' ? '…' : (zh ? '创建并生成草稿' : 'Create & generate')}</button>}
          {selectedId && canWrite && <><button type="button" onClick={() => void save()} disabled={busy !== '' || !content.trim()} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"><Save className="h-3.5 w-3.5" />{busy === 'save' ? '…' : (zh ? '自动保存' : 'Autosave')}</button><button type="button" onClick={() => imageInputRef.current?.click()} disabled={busy !== ''} className="inline-flex items-center gap-1 rounded-lg border border-indigo-500/30 px-3 py-2 text-xs text-indigo-200 hover:bg-indigo-500/10 disabled:opacity-50"><ImagePlus className="h-3.5 w-3.5" />{busy === 'image' ? '…' : (zh ? '插入图片' : 'Insert image')}</button><input ref={imageInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" onChange={(event) => void uploadImage(event)} className="hidden" /><button type="button" onClick={() => void validate()} disabled={busy !== '' || !content.trim()} className="inline-flex items-center gap-1 rounded-lg border border-amber-500/30 px-3 py-2 text-xs text-amber-200 disabled:opacity-50"><ShieldCheck className="h-3.5 w-3.5" />{zh ? '校验草稿' : 'Validate'}</button><button type="button" onClick={() => void publish()} disabled={busy !== '' || !content.trim()} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"><Send className="h-3.5 w-3.5" />{zh ? '发布到知识库' : 'Publish'}</button></>}
          {selectedId && detail && <span className="text-[11px] text-slate-500">状态：{asString(detail.status)} {asString(detail.error_message) && `· ${asString(detail.error_message)}`}</span>}
        </div>
        {selectedId && validationItems.length > 0 && <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-xs"><div className="mb-2 flex items-center gap-1 font-semibold text-amber-100"><ShieldCheck className="h-3.5 w-3.5" />{zh ? '服务端草稿校验结果' : 'Server-side draft validation'}</div><ul className="space-y-1.5 text-amber-100/80">{validationItems.map((item, index) => <li key={`${asString(item.code, 'validation')}-${index}`} className={asString(item.level) === 'danger' ? 'text-rose-200' : ''}><span className="mr-1 rounded border border-current/30 px-1 py-0.5 text-[10px] uppercase">{asString(item.level, 'info')}</span>{asString(item.message, asString(item.description, zh ? '需要人工确认' : 'Manual review required'))}</li>)}</ul>{requiresDangerConfirmation && canWrite && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-amber-500/20 pt-3"><span className="text-[11px] text-rose-200">{zh ? '危险项不会自动忽略。确认后仍会保留在服务端记录中。' : 'Danger items are not ignored and remain recorded server-side.'}</span><button type="button" onClick={() => void publish(true)} disabled={busy !== ''} className="rounded bg-rose-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-rose-500 disabled:opacity-50">{zh ? '我已知晓风险，确认发布' : 'I understand the risks, publish'}</button></div>}</div>}
        {selectedId && Array.isArray(detail?.revisions) && <div className="border-t border-slate-800 pt-3"><div className="mb-2 flex items-center gap-1 text-xs font-semibold text-slate-300"><History className="h-3.5 w-3.5 text-indigo-300" />{zh ? '历史版本' : 'Revisions'}</div><div className="flex flex-wrap gap-2">{(detail?.revisions as unknown[]).map((revision) => { const item = asRecord(revision); return <button type="button" key={String(item.id)} onClick={() => canWrite && void run(`restore-${item.id}`, () => apiClient.restoreEnterpriseKnowledgeRevision(selectedId, asNumber(item.id), { idempotencyKey: `enterprise-restore-${item.id}-${Date.now()}` }))} disabled={!canWrite || busy !== ''} className="rounded border border-slate-700 px-2 py-1 text-[10px] text-slate-400 hover:border-indigo-500 disabled:opacity-50">{asString(item.source)} · {asString(item.created_at)}</button>; })}</div></div>}
        {selectedId && canWrite && <button type="button" onClick={() => void run('delete', () => apiClient.deleteEnterpriseKnowledge(selectedId, { idempotencyKey: `enterprise-delete-${selectedId}-${Date.now()}` }))} className="inline-flex items-center gap-1 text-[10px] text-rose-400 hover:text-rose-300"><Trash2 className="h-3 w-3" />{zh ? '删除项目' : 'Delete project'}</button>}
      </div>
    </div>
  </section>;
};

export default EnterpriseKnowledgeView;
