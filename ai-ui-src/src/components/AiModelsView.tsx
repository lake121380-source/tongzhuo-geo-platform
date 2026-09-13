import React, { useEffect, useState } from 'react';
import { Sliders, Bot, Code, Copy, Plus, Save, Trash2, Wifi } from 'lucide-react';
import { AiModelConfig, PromptTemplate } from '../types';
import { GeoFlowApiClient } from '../api/geoflowClient';
import { AiSourceProvidersPanel } from './AiSourceProvidersPanel';
import SpecialPromptsPanel from './SpecialPromptsPanel';
import AiSystemSettingsPanel from './AiSystemSettingsPanel';
import ModelBindingsPanel from './ModelBindingsPanel';
import PermissionNotice from './PermissionNotice';
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
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-black text-white flex items-center gap-2"><Sliders className="w-6 h-6 text-blue-500" />{lang === 'zh' ? 'AI 模型网关与提示词资产' : 'AI Models & Prompt Configuration'}</h1>
        <p className="text-xs text-slate-400 mt-1">{lang === 'zh' ? '模型凭据只写入后端加密存储，连接测试沿用 桐灼GEO 安全出站链路。' : 'Credentials are encrypted server-side; connection tests use 桐灼GEO outbound safeguards.'}</p>
      </div>
      {!canRead && <PermissionNotice lang={lang} mode="read" requiredScope="models:read" />}
      {canRead && !canWrite && <PermissionNotice lang={lang} requiredScope="models:write" />}
      {notice && <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-200">{notice}</div>}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6 bg-slate-900/80 p-5 rounded-2xl border border-slate-800 space-y-4">
          <div className="flex items-center justify-between"><h3 className="text-sm font-bold text-white flex items-center gap-2"><Bot className="w-4 h-4 text-blue-400" />{lang === 'zh' ? 'AI 模型' : 'AI Models'}</h3>{apiMode && canRead && canWrite && <button onClick={() => setModelForm({ ...emptyModel })} className="text-xs text-blue-300 flex items-center gap-1"><Plus className="w-3 h-3" />{lang === 'zh' ? '新增' : 'Add'}</button>}</div>
          <div className="space-y-3">
            {!canRead ? <div className="text-xs text-slate-500">{lang === 'zh' ? '没有模型读取权限' : 'Model read access is not granted'}</div> : <>{models.length === 0 && <div className="text-xs text-slate-500">{lang === 'zh' ? '后端没有可用模型' : 'No models available from API'}</div>}
            {models.map((mod) => <div key={mod.id} className="p-4 rounded-xl border border-slate-800 bg-slate-950/60">
              <div className="flex items-start justify-between"><div><div className="flex items-center gap-2"><span className="text-sm font-bold text-white">{mod.name}</span>{mod.isDefault && <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">{lang === 'zh' ? '默认' : 'Default'}</span>}</div><div className="text-xs font-mono text-slate-400 mt-1">{mod.modelId || '—'} · {mod.type}</div></div><span className="text-[10px] text-slate-500">{mod.status || 'unknown'}</span></div>
              <div className="flex items-center justify-between text-xs text-slate-400 pt-3 mt-3 border-t border-slate-800/80"><span>{mod.apiKeyConfigured ? 'API Key ✓' : 'API Key —'}</span><div className="flex gap-3">{canWrite && mod.isDefault !== true && mod.type === 'chat' && <button onClick={() => onSelectDefaultModel(mod.id)} className="text-blue-400">{lang === 'zh' ? '设为默认' : 'Default'}</button>}{apiMode && canWrite && <><button onClick={() => setModelForm({ id: mod.id, name: mod.name, version: mod.version || '', model_id: mod.modelId || '', model_type: mod.type, api_url: mod.apiUrl || '', api_key: '', daily_limit: mod.dailyLimit || 0, max_tokens: mod.maxTokens || 4096, status: mod.status || 'active', access_scope: mod.accessScope || 'user_content', failover_priority: mod.failoverPriority || 100 })} className="text-slate-300">{lang === 'zh' ? '编辑' : 'Edit'}</button><button onClick={() => run('test-' + mod.id, () => onTestModel?.(mod.id) || Promise.resolve())} className="text-emerald-300 flex items-center gap-1"><Wifi className="w-3 h-3" />{busy === 'test-' + mod.id ? '…' : (lang === 'zh' ? '测试' : 'Test')}</button><button onClick={() => run('delete-' + mod.id, () => onDeleteModel?.(mod.id) || Promise.resolve())} className="text-red-300"><Trash2 className="w-3 h-3" /></button></>}</div></div>
              </div>)}
            </>}
          </div>
          {modelForm && apiMode && canRead && canWrite && <div className="rounded-xl border border-blue-500/30 bg-slate-950 p-4 space-y-2"><div className="grid grid-cols-2 gap-2">{[['name','名称'],['version','版本'],['model_id','模型 ID'],['api_url','API URL'],['daily_limit','日额度'],['max_tokens','最大 Tokens']].map(([key,label]) => <label key={key} className="text-xs text-slate-400">{label}<input value={modelValue(key)} onChange={(e) => setModelValue(key,e.target.value)} className="mt-1 w-full rounded bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-white" /></label>)}</div><div className="grid grid-cols-3 gap-2">{[['model_type',['chat','embedding']],['status',['active','inactive']],['access_scope',['user_content','system_only']]].map(([key,options]) => <label key={key as string} className="text-xs text-slate-400">{({model_type:'类型',status:'状态',access_scope:'权限范围'} as Record<string,string>)[key as string]}<select value={modelValue(key as string)} onChange={(e) => setModelValue(key as string,e.target.value)} className="mt-1 w-full rounded bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-white">{(options as string[]).map((option) => <option key={option} value={option}>{option}</option>)}</select></label>)}</div><label className="text-xs text-slate-400">故障转移优先级<input value={modelValue('failover_priority')} onChange={(e) => setModelValue('failover_priority',e.target.value)} className="mt-1 w-full rounded bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-white" /></label><label className="text-xs text-slate-400">API Key（{modelForm.id ? '留空保留原值' : '必填'}）<input type="password" value={modelValue('api_key')} onChange={(e) => setModelValue('api_key',e.target.value)} className="mt-1 w-full rounded bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-white" /></label><div className="flex gap-2"><button onClick={() => run('save-model', () => modelForm.id ? onUpdateModel?.(String(modelForm.id), modelForm) || Promise.resolve() : onCreateModel?.(modelForm) || Promise.resolve())} className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded flex items-center gap-1"><Save className="w-3 h-3" />{busy === 'save-model' ? '…' : '保存'}</button><button onClick={() => setModelForm(null)} className="text-xs text-slate-400">取消</button></div></div>}
        </div>
        <div className="lg:col-span-6 bg-slate-900/80 p-5 rounded-2xl border border-slate-800 space-y-4">
          <div className="flex items-center justify-between"><h3 className="text-sm font-bold text-white flex items-center gap-2"><Code className="w-4 h-4 text-emerald-400" />{lang === 'zh' ? '提示词模板' : 'Prompt Templates'}</h3>{apiMode && canRead && canWrite && <button onClick={() => { setCreatingPrompt(true); setSelectedPrompt(null); setPromptDraft({ name: '', content: '', type: 'content' }); }} className="text-xs text-emerald-300 flex items-center gap-1"><Plus className="w-3 h-3" />{lang === 'zh' ? '新增' : 'Add'}</button>}</div>
          <div className="flex flex-wrap gap-2">{prompts.map((p) => <button key={p.id} onClick={() => { setCreatingPrompt(false); setSelectedPrompt(p); }} className={'text-xs px-3 py-1.5 rounded-xl ' + (selectedPrompt?.id === p.id ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300')}>{p.name}</button>)}</div>
          {!canRead ? <div className="text-xs text-slate-500">{lang === 'zh' ? '没有提示词读取权限' : 'Prompt read access is not granted'}</div> : apiMode ? <div className="space-y-2"><input disabled={!canWrite} value={promptDraft.name} onChange={(e) => setPromptDraft((p) => ({ ...p, name: e.target.value }))} placeholder="提示词名称" className="w-full rounded bg-slate-950 border border-slate-700 px-3 py-2 text-xs text-white disabled:opacity-60" /><select value={promptDraft.type} disabled={Boolean(selectedPrompt) || !canWrite} onChange={(e) => setPromptDraft((p) => ({ ...p, type: e.target.value }))} className="rounded bg-slate-950 border border-slate-700 px-3 py-2 text-xs text-white disabled:opacity-60"><option value="content">content</option><option value="quality_check">quality_check</option></select><textarea disabled={!canWrite} rows={12} value={promptDraft.content} onChange={(e) => setPromptDraft((p) => ({ ...p, content: e.target.value }))} className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-xs text-slate-300 font-mono disabled:opacity-60" /><div className="flex gap-2"><button disabled={!canWrite || Boolean(selectedPrompt?.systemManaged)} onClick={() => void run('save-prompt', () => creatingPrompt ? onCreatePrompt?.(promptDraft) || Promise.resolve() : selectedPrompt ? onUpdatePrompt?.(selectedPrompt.id, promptDraft) || Promise.resolve() : Promise.resolve()).then(() => setCreatingPrompt(false))} className="text-xs bg-emerald-600 disabled:opacity-40 text-white px-3 py-1.5 rounded flex items-center gap-1"><Save className="w-3 h-3" />保存</button>{canWrite && selectedPrompt && !selectedPrompt.systemManaged && <button onClick={() => run('delete-prompt', () => onDeletePrompt?.(selectedPrompt.id) || Promise.resolve())} className="text-xs text-red-300 flex items-center gap-1"><Trash2 className="w-3 h-3" />删除</button>}{canWrite && selectedPrompt && onCopyPrompt && <button onClick={() => run('copy-prompt', () => onCopyPrompt(selectedPrompt.id))} className="text-xs text-sky-300 flex items-center gap-1" title={lang === 'zh' ? '复制成可编辑副本（系统内置提示词只能这样改）' : 'Copy into an editable duplicate'}><Copy className="w-3 h-3" />{lang === 'zh' ? '复制' : 'Copy'}</button>}</div></div> : <div className="text-xs text-slate-500">连接 API 后可编辑提示词</div>}
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
