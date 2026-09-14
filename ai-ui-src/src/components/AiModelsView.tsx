import React, { useEffect, useState } from 'react';
import { Sliders, Bot, Code, Copy, Plus, Save, Trash2, Wifi } from 'lucide-react';
import { AiModelConfig, PromptTemplate } from '../types';
import { GeoFlowApiClient } from '../api/geoflowClient';
import { AiSourceProvidersPanel } from './AiSourceProvidersPanel';
import SpecialPromptsPanel from './SpecialPromptsPanel';
import AiSystemSettingsPanel from './AiSystemSettingsPanel';
import ModelBindingsPanel from './ModelBindingsPanel';
import PermissionNotice from './PermissionNotice';
import { PageHeader } from './PageHeader';
import { EmptyState } from './ui';
import { describeApiError } from '../api/permissions';

interface AiModelsViewProps {
  models: AiModelConfig[];
  prompts: PromptTemplate[];
  onSelectDefaultModel: (id: string) => void;
  onCreateModel?: (payload: Record<string, unknown>) => Promise<void>;
  onUpdateModel?: (id: string, payload: Record<string, unknown>) => Promise<void>;
  onDeleteModel?: (id: string) => Promise<void>;
  onTestModel?: (id: string) => Promise<unknown>;
  onCreatePrompt?: (payload: Record<string, unknown>) => Promise<void>;
  onUpdatePrompt?: (id: string, payload: Record<string, unknown>) => Promise<void>;
  onDeletePrompt?: (id: string) => Promise<void>;
  /** 复制成可编辑副本——系统内置提示词只读，这是改它们的唯一途径。 */
  onCopyPrompt?: (id: string) => Promise<void>;
  lang: 'zh' | 'en';
  apiMode?: boolean;
  /** Whether the current API token may read model and prompt projections. */
  canRead?: boolean;
  /** Whether the current API token may mutate model and prompt projections. */
  canWrite?: boolean;
  /** System source-provider configuration has an additional super-admin boundary. */
  canManageSourceProviders?: boolean;
  apiClient?: GeoFlowApiClient;
}

const emptyModel = { name: '', version: '', model_id: '', model_type: 'chat', api_url: '', api_key: '', daily_limit: 0, max_tokens: 4096, status: 'active', access_scope: 'user_content', failover_priority: 100 };

export const AiModelsView: React.FC<AiModelsViewProps> = ({
  models, prompts, onSelectDefaultModel, onCreateModel, onUpdateModel, onDeleteModel, onTestModel,
  onCreatePrompt, onUpdatePrompt, onDeletePrompt, onCopyPrompt, lang, apiMode = false,
  canRead = true, canWrite = true, canManageSourceProviders = false, apiClient,
}) => {
  const [selectedPrompt, setSelectedPrompt] = useState<PromptTemplate | null>(prompts[0] || null);
  const [creatingPrompt, setCreatingPrompt] = useState(false);
  const [modelForm, setModelForm] = useState<Record<string, unknown> | null>(null);
  const [promptDraft, setPromptDraft] = useState({ name: '', content: '', type: 'content' });
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!creatingPrompt && (!selectedPrompt || !prompts.some((prompt) => prompt.id === selectedPrompt.id))) setSelectedPrompt(prompts[0] || null);
  }, [prompts, selectedPrompt, creatingPrompt]);
  useEffect(() => {
    if (selectedPrompt) setPromptDraft({ name: selectedPrompt.name, content: selectedPrompt.systemPrompt, type: selectedPrompt.type || selectedPrompt.category || 'content' });
  }, [selectedPrompt]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setNotice('');
    try { await action(); setNotice(lang === 'zh' ? '已保存' : 'Saved'); }
    catch (error) { setNotice(describeApiError(error, lang === 'zh' ? '操作失败' : 'Operation failed', lang)); }
    finally { setBusy(''); }
  };
  const modelValue = (key: string): string => String(modelForm?.[key] ?? '');
  const setModelValue = (key: string, value: string) => setModelForm((prev) => ({ ...(prev || emptyModel), [key]: value }));

  return (
    <div className="space-y-8">
      <PageHeader
        icon={Sliders}
        group={lang === 'zh' ? '设置' : 'Settings'}
        title={lang === 'zh' ? 'AI 模型与提示词' : 'AI Models & Prompts'}
        description={lang === 'zh' ? '给 AI 配「用哪个模型写、按什么要求写」。密钥只保存在后端加密存储里。' : 'Which model writes, and with what prompt. Credentials stay encrypted server-side.'}
      />
      {!canRead && <PermissionNotice lang={lang} mode="read" requiredScope="models:read" />}
      {canRead && !canWrite && <PermissionNotice lang={lang} requiredScope="models:write" />}
      {notice && <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-[13px] text-indigo-200">{notice}</div>}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6 bg-slate-900/80 p-5 rounded-2xl space-y-4">
          <div className="flex items-center justify-between"><h3 className="text-section-title flex items-center gap-2"><Bot className="w-4 h-4 text-slate-400" />{lang === 'zh' ? 'AI 模型' : 'AI Models'}</h3>{apiMode && canRead && canWrite && <button onClick={() => setModelForm({ ...emptyModel })} className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 text-[12px] font-semibold text-slate-200 transition hover:bg-slate-800"><Plus className="w-3 h-3" />{lang === 'zh' ? '新增' : 'Add'}</button>}</div>
          <div className="space-y-3">
            {!canRead ? <div className="text-[13px] text-slate-500">{lang === 'zh' ? '没有模型读取权限' : 'Model read access is not granted'}</div> : <>{models.length === 0 && <EmptyState compact icon={Bot} title={lang === 'zh' ? '还没有 AI 模型' : 'No models available from API'} description={lang === 'zh' ? '点右上角「新增」添加一个模型，填好 API 地址与密钥。' : 'Add one from the top-right button.'} />}
            {models.map((mod) => <div key={mod.id} className="p-4 rounded-xl bg-slate-950/40">
              <div className="flex items-start justify-between"><div><div className="flex items-center gap-2"><span className="text-sm font-bold text-white">{mod.name}</span>{mod.isDefault && <span className="text-[12px] px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300">{lang === 'zh' ? '默认' : 'Default'}</span>}</div><div className="text-[13px] font-mono text-slate-400 mt-1">{mod.modelId || '—'} · {mod.type}</div></div><span className="text-[12px] text-slate-500">{mod.status || 'unknown'}</span></div>
              <div className="flex items-center justify-between text-[13px] text-slate-400 pt-3 mt-3 border-t border-slate-800/80"><span>{mod.apiKeyConfigured ? 'API Key ✓' : 'API Key —'}</span><div className="flex gap-3">{canWrite && mod.isDefault !== true && mod.type === 'chat' && <button onClick={() => onSelectDefaultModel(mod.id)} className="text-indigo-400">{lang === 'zh' ? '设为默认' : 'Default'}</button>}{apiMode && canWrite && <><button onClick={() => setModelForm({ id: mod.id, name: mod.name, version: mod.version || '', model_id: mod.modelId || '', model_type: mod.type, api_url: mod.apiUrl || '', api_key: '', daily_limit: mod.dailyLimit || 0, max_tokens: mod.maxTokens || 4096, status: mod.status || 'active', access_scope: mod.accessScope || 'user_content', failover_priority: mod.failoverPriority || 100 })} className="text-slate-300">{lang === 'zh' ? '编辑' : 'Edit'}</button><button onClick={() => run('test-' + mod.id, () => onTestModel?.(mod.id) || Promise.resolve())} className="text-emerald-300 flex items-center gap-1"><Wifi className="w-3 h-3" />{busy === 'test-' + mod.id ? '…' : (lang === 'zh' ? '测试' : 'Test')}</button><button onClick={() => run('delete-' + mod.id, () => onDeleteModel?.(mod.id) || Promise.resolve())} className="text-rose-400"><Trash2 className="w-3 h-3" /></button></>}</div></div>
              </div>)}
            </>}
          </div>
          {modelForm && apiMode && canRead && canWrite && <div className="rounded-xl bg-slate-950/40 p-4 space-y-2"><div className="grid grid-cols-2 gap-2">{[['name','名称'],['version','版本'],['model_id','模型 ID'],['api_url','API URL'],['daily_limit','日额度'],['max_tokens','最大 Tokens']].map(([key,label]) => <label key={key} className="text-[13px] text-slate-400">{label}<input value={modelValue(key)} onChange={(e) => setModelValue(key,e.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" /></label>)}</div><div className="grid grid-cols-3 gap-2">{[['model_type',['chat','embedding']],['status',['active','inactive']],['access_scope',['user_content','system_only']]].map(([key,options]) => <label key={key as string} className="text-[13px] text-slate-400">{({model_type:'类型',status:'状态',access_scope:'权限范围'} as Record<string,string>)[key as string]}<select value={modelValue(key as string)} onChange={(e) => setModelValue(key as string,e.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500">{(options as string[]).map((option) => <option key={option} value={option}>{option}</option>)}</select></label>)}</div><label className="text-[13px] text-slate-400">故障转移优先级<input value={modelValue('failover_priority')} onChange={(e) => setModelValue('failover_priority',e.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" /></label><label className="text-[13px] text-slate-400">API Key（{modelForm.id ? '留空保留原值' : '必填'}）<input type="password" value={modelValue('api_key')} onChange={(e) => setModelValue('api_key',e.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" /></label><div className="flex gap-2"><button onClick={() => run('save-model', () => modelForm.id ? onUpdateModel?.(String(modelForm.id), modelForm) || Promise.resolve() : onCreateModel?.(modelForm) || Promise.resolve())} className="inline-flex h-9 items-center gap-1 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white transition hover:bg-indigo-500"><Save className="w-3 h-3" />{busy === 'save-model' ? '…' : '保存'}</button><button onClick={() => setModelForm(null)} className="text-[13px] text-slate-400">取消</button></div></div>}
        </div>
        <div className="lg:col-span-6 bg-slate-900/80 p-5 rounded-2xl space-y-4">
          <div className="flex items-center justify-between"><h3 className="text-section-title flex items-center gap-2"><Code className="w-4 h-4 text-slate-400" />{lang === 'zh' ? '提示词模板' : 'Prompt Templates'}</h3>{apiMode && canRead && canWrite && <button onClick={() => { setCreatingPrompt(true); setSelectedPrompt(null); setPromptDraft({ name: '', content: '', type: 'content' }); }} className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 text-[12px] font-semibold text-slate-200 transition hover:bg-slate-800"><Plus className="w-3 h-3" />{lang === 'zh' ? '新增' : 'Add'}</button>}</div>
          <div className="flex flex-wrap gap-2">{prompts.map((p) => <button key={p.id} onClick={() => { setCreatingPrompt(false); setSelectedPrompt(p); }} className={'text-[13px] px-3 py-1.5 rounded-xl ' + (selectedPrompt?.id === p.id ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300')}>{p.name}</button>)}</div>
          {!canRead ? <div className="text-[13px] text-slate-500">{lang === 'zh' ? '没有提示词读取权限' : 'Prompt read access is not granted'}</div> : apiMode ? <div className="space-y-2"><input disabled={!canWrite} value={promptDraft.name} onChange={(e) => setPromptDraft((p) => ({ ...p, name: e.target.value }))} placeholder="提示词名称" className="h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500 disabled:opacity-60" /><select value={promptDraft.type} disabled={Boolean(selectedPrompt) || !canWrite} onChange={(e) => setPromptDraft((p) => ({ ...p, type: e.target.value }))} className="h-10 rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500 disabled:opacity-60"><option value="content">content</option><option value="quality_check">quality_check</option></select><textarea disabled={!canWrite} rows={12} value={promptDraft.content} onChange={(e) => setPromptDraft((p) => ({ ...p, content: e.target.value }))} className="w-full rounded-xl border border-slate-700 bg-slate-900 p-3 text-[13px] text-slate-300 font-mono outline-none transition focus:border-indigo-500 disabled:opacity-60" /><div className="flex gap-2"><button disabled={!canWrite || Boolean(selectedPrompt?.systemManaged)} onClick={() => void run('save-prompt', () => creatingPrompt ? onCreatePrompt?.(promptDraft) || Promise.resolve() : selectedPrompt ? onUpdatePrompt?.(selectedPrompt.id, promptDraft) || Promise.resolve() : Promise.resolve()).then(() => setCreatingPrompt(false))} className="inline-flex h-9 items-center gap-1 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white transition hover:bg-indigo-500 disabled:opacity-40"><Save className="w-3 h-3" />保存</button>{canWrite && selectedPrompt && !selectedPrompt.systemManaged && <button onClick={() => run('delete-prompt', () => onDeletePrompt?.(selectedPrompt.id) || Promise.resolve())} className="text-[13px] text-rose-400 flex items-center gap-1"><Trash2 className="w-3 h-3" />删除</button>}{canWrite && selectedPrompt && onCopyPrompt && <button onClick={() => run('copy-prompt', () => onCopyPrompt(selectedPrompt.id))} className="text-[13px] text-indigo-300 flex items-center gap-1" title={lang === 'zh' ? '复制成可编辑副本（系统内置提示词只能这样改）' : 'Copy into an editable duplicate'}><Copy className="w-3 h-3" />{lang === 'zh' ? '复制' : 'Copy'}</button>}</div></div> : <div className="text-[13px] text-slate-500">连接 API 后可编辑提示词</div>}
        </div>
      </div>
      {apiMode && apiClient && <AiSourceProvidersPanel apiClient={apiClient} lang={lang} canManage={canManageSourceProviders} />}
      {apiMode && apiClient && (
        <div className="space-y-4">
          {/* 系统级配置（切片/默认向量，超管）与个人默认、运行概览 */}
          <AiSystemSettingsPanel apiClient={apiClient} lang={lang} canRead={canRead} canWrite={canWrite} isSuperAdmin={canManageSourceProviders} />
          {/* 可见度运行用哪条模型做检索与二次分析 */}
          <ModelBindingsPanel apiClient={apiClient} lang={lang} canManage={canManageSourceProviders} />
          {/* keyword / description 两类提示词——被 URL 导入流水线真实消费 */}
          <SpecialPromptsPanel apiClient={apiClient} lang={lang} canRead={canRead} canWrite={canWrite} />
        </div>
      )}
    </div>
  );
};
