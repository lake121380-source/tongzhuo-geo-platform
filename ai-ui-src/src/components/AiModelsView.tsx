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
import { EmptyState, Modal } from './ui';
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
  /** 弹窗内部的错误与测试结果——不再塞进页面顶部的全局 notice（那里离操作点太远）。 */
  const [modelError, setModelError] = useState('');
  const [modelTest, setModelTest] = useState('');
  /** 列表里每个模型的测试结果，按 id 存。 */
  const [testResults, setTestResults] = useState<Record<string, string>>({});
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

  const closeModelForm = () => { setModelForm(null); setModelError(''); setModelTest(''); };

  /**
   * 保存模型。**成功后必须关掉弹窗**——原来的写法只把整个表单塞给 `run()`，
   * 而 `run()` 成功时只设一句「已保存」，表单一直开着，用户以为没保存上。
   */
  const saveModel = async () => {
    if (!modelForm) return;
    setBusy('save-model');
    setModelError('');
    try {
      if (modelForm.id) await onUpdateModel?.(String(modelForm.id), modelForm);
      else await onCreateModel?.(modelForm);
      closeModelForm();
      setNotice(lang === 'zh' ? '模型已保存' : 'Model saved');
    } catch (error) {
      setModelError(describeApiError(error, lang === 'zh' ? '保存失败' : 'Save failed', lang));
    } finally {
      setBusy('');
    }
  };

  /** 测试连通性。结果就地显示——原来复用 `run()`，成功时显示的是「已保存」，说法是错的。 */
  const testModel = async (id: string, inModal = false) => {
    const key = inModal ? 'test-modal' : `test-${id}`;
    setBusy(key);
    inModal ? setModelTest(lang === 'zh' ? '测试中…' : 'Testing…') : setTestResults((prev) => ({ ...prev, [id]: lang === 'zh' ? '测试中…' : 'Testing…' }));
    try {
      await onTestModel?.(id);
      const ok = lang === 'zh' ? '连接正常' : 'Connection OK';
      inModal ? setModelTest(ok) : setTestResults((prev) => ({ ...prev, [id]: ok }));
    } catch (error) {
      const message = describeApiError(error, lang === 'zh' ? '测试失败' : 'Test failed', lang);
      inModal ? setModelTest(message) : setTestResults((prev) => ({ ...prev, [id]: message }));
    } finally {
      setBusy('');
    }
  };

  /** 同一个 model_id 已经存在时提醒——不拦，只提示（多分组/多密钥是合理用法）。 */
  const duplicateModelId = (() => {
    const id = String(modelForm?.model_id ?? '').trim();
    if (!id) return false;
    return models.some((m) => String(m.modelId ?? '').trim() === id && String(m.id) !== String(modelForm?.id ?? ''));
  })();

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
              <div className="flex items-center justify-between text-[13px] text-slate-400 pt-3 mt-3 border-t border-slate-800/80"><span>{mod.apiKeyConfigured ? 'API Key ✓' : 'API Key —'}</span><div className="flex gap-3">{canWrite && mod.isDefault !== true && mod.type === 'chat' && <button onClick={() => onSelectDefaultModel(mod.id)} className="text-indigo-400">{lang === 'zh' ? '设为默认' : 'Default'}</button>}{apiMode && canWrite && <><button onClick={() => setModelForm({ id: mod.id, name: mod.name, version: mod.version || '', model_id: mod.modelId || '', model_type: mod.type, api_url: mod.apiUrl || '', api_key: '', daily_limit: mod.dailyLimit || 0, max_tokens: mod.maxTokens || 4096, status: mod.status || 'active', access_scope: mod.accessScope || 'user_content', failover_priority: mod.failoverPriority || 100 })} className="text-slate-300">{lang === 'zh' ? '编辑' : 'Edit'}</button><button onClick={() => void testModel(String(mod.id))} className="text-emerald-300 flex items-center gap-1"><Wifi className="w-3 h-3" />{busy === 'test-' + mod.id ? '…' : (lang === 'zh' ? '测试' : 'Test')}</button><button onClick={() => run('delete-' + mod.id, () => onDeleteModel?.(mod.id) || Promise.resolve())} className="text-rose-400"><Trash2 className="w-3 h-3" /></button></>}</div></div>
              {(testResults[String(mod.id)] || (mod.type === 'embedding' && mod.accessScope !== 'system_only')) && (
                <p className={'mt-2 text-[12px] leading-relaxed ' + (testResults[String(mod.id)] && testResults[String(mod.id)].indexOf('失败') >= 0 ? 'text-rose-300' : 'text-amber-300')}>
                  {testResults[String(mod.id)]
                    ? (lang === 'zh' ? '测试结果：' : 'Test: ') + testResults[String(mod.id)]
                    : (lang === 'zh' ? '⚠ 知识库索引只使用「仅系统工作流」的嵌入模型，这一条现在不是——索引不会用它。' : '⚠ Knowledge index only uses system_only embedding models.')}
                </p>
              )}
              </div>)}
            </>}
          </div>
      {modelForm && apiMode && canRead && canWrite && (
        <Modal
          open
          onClose={closeModelForm}
          size="md"
          closeOnBackdrop={false}
          title={modelForm.id ? (lang === 'zh' ? '编辑模型' : 'Edit model') : (lang === 'zh' ? '新增模型' : 'Add model')}
          description={lang === 'zh' ? '密钥只保存在后端加密存储里，保存后不会回显。' : 'Credentials stay encrypted server-side and are never echoed back.'}
          footer={<>
            {Boolean(modelForm.id) && (
              <button type="button" onClick={() => void testModel(String(modelForm.id), true)} disabled={busy !== ''} className="mr-auto inline-flex h-9 items-center gap-1.5 rounded-xl border border-emerald-500/40 px-3.5 text-[13px] font-semibold text-emerald-300 transition hover:bg-emerald-500/10 disabled:opacity-50">
                <Wifi className="h-3.5 w-3.5" />{busy === 'test-modal' ? (lang === 'zh' ? '测试中…' : 'Testing…') : (lang === 'zh' ? '测试连接' : 'Test')}
              </button>
            )}
            <button type="button" onClick={closeModelForm} className="inline-flex h-9 items-center rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-slate-800">{lang === 'zh' ? '取消' : 'Cancel'}</button>
            <button type="button" onClick={() => void saveModel()} disabled={busy === 'save-model' || !String(modelForm.name ?? '').trim() || !String(modelForm.model_id ?? '').trim()} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white transition hover:bg-indigo-500 disabled:opacity-50">
              <Save className="h-3.5 w-3.5" />{busy === 'save-model' ? (lang === 'zh' ? '保存中…' : 'Saving…') : (lang === 'zh' ? '保存' : 'Save')}
            </button>
          </>}
        >
          <div className="space-y-4">
            {modelError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-[13px] text-rose-200">{modelError}</div>}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-[13px] text-slate-400">{lang === 'zh' ? '名称' : 'Name'}<span className="ml-1 text-rose-400">*</span>
                <input value={modelValue('name')} onChange={(e) => setModelValue('name', e.target.value)} placeholder={lang === 'zh' ? '给自己看的备注名，如「主用 DeepSeek」' : 'Display name'} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition placeholder:text-slate-600 focus:border-indigo-500" />
              </label>
              <label className="text-[13px] text-slate-400">{lang === 'zh' ? '模型 ID' : 'Model ID'}<span className="ml-1 text-rose-400">*</span>
                <input value={modelValue('model_id')} onChange={(e) => setModelValue('model_id', e.target.value)} placeholder="deepseek-v4-flash / bge-m3 / …" className="mt-1 h-10 w-full rounded-full border border-slate-700 bg-slate-900 px-3 font-mono text-[13px] text-white outline-none transition placeholder:text-slate-600 focus:border-indigo-500" />
              </label>
            </div>
            {duplicateModelId && <p className="-mt-2 text-[12px] text-amber-300">{lang === 'zh' ? '⚠ 这个模型 ID 已经有一条记录了——同一个 ID 配多条是允许的（比如不同分组或不同密钥），确认不是误加就行。' : '⚠ A model with this ID already exists.'}</p>}

            <label className="block text-[13px] text-slate-400">API URL<span className="ml-1 text-rose-400">*</span>
              <input value={modelValue('api_url')} onChange={(e) => setModelValue('api_url', e.target.value)} placeholder="https://api.example.com/v1" className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 font-mono text-[13px] text-white outline-none transition placeholder:text-slate-600 focus:border-indigo-500" />
              <span className="mt-1 block text-[12px] text-slate-500">{lang === 'zh' ? '填到版本号为止即可（如 …/v1），程序会自己补 /embeddings 这类路径。' : 'Base URL only; paths are appended by the app.'}</span>
            </label>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="text-[13px] text-slate-400">{lang === 'zh' ? '类型' : 'Type'}
                <select value={modelValue('model_type')} onChange={(e) => setModelValue('model_type', e.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500">
                  <option value="chat">{lang === 'zh' ? '对话模型（生成正文）' : 'chat'}</option>
                  <option value="embedding">{lang === 'zh' ? '向量嵌入（知识库检索）' : 'embedding'}</option>
                </select>
              </label>
              <label className="text-[13px] text-slate-400">{lang === 'zh' ? '权限范围' : 'Access scope'}
                <select value={modelValue('access_scope')} onChange={(e) => setModelValue('access_scope', e.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500">
                  <option value="user_content">{lang === 'zh' ? '账号可用' : 'user_content'}</option>
                  <option value="system_only">{lang === 'zh' ? '仅系统工作流' : 'system_only'}</option>
                </select>
              </label>
              <label className="text-[13px] text-slate-400">{lang === 'zh' ? '状态' : 'Status'}
                <select value={modelValue('status')} onChange={(e) => setModelValue('status', e.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500">
                  <option value="active">{lang === 'zh' ? '启用' : 'active'}</option>
                  <option value="inactive">{lang === 'zh' ? '停用' : 'inactive'}</option>
                </select>
              </label>
            </div>
            <div className="-mt-2 space-y-1 text-[12px] leading-relaxed text-slate-500">
              {modelValue('model_type') === 'embedding' && <p className="text-indigo-300">{lang === 'zh' ? '· 向量嵌入模型只用于知识库检索，不能拿来写文章。' : '· Embedding models serve knowledge retrieval only.'}</p>}
              <p className={modelValue('access_scope') === 'system_only' ? 'text-amber-300' : ''}>
                {lang === 'zh' ? '· 权限范围：' : '· Scope: '}
                <b>{lang === 'zh' ? '账号可用' : 'user_content'}</b>{lang === 'zh' ? '＝你自己在后台用；' : ' = usable in the console; '}
                <b>{lang === 'zh' ? '仅系统工作流' : 'system_only'}</b>{lang === 'zh' ? '＝专供知识库索引这类后台任务。' : ' = reserved for system jobs.'}
              </p>
              {modelValue('model_type') === 'embedding' && modelValue('access_scope') !== 'system_only' && (
                <p className="text-amber-300">{lang === 'zh' ? '⚠ 知识库索引只会使用「仅系统工作流」的嵌入模型。想让知识库用上它，这里要选「仅系统工作流」，并到「系统设置」把它设为默认嵌入模型。' : '⚠ The knowledge index only accepts system_only embedding models.'}</p>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="text-[13px] text-slate-400">{lang === 'zh' ? '日调用上限' : 'Daily limit'}
                <input type="number" min={0} value={modelValue('daily_limit')} onChange={(e) => setModelValue('daily_limit', e.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" />
                <span className="mt-1 block text-[12px] text-slate-500">{lang === 'zh' ? '0 = 不限' : '0 = unlimited'}</span>
              </label>
              <label className="text-[13px] text-slate-400">{lang === 'zh' ? '单次最大 Tokens' : 'Max tokens'}
                <input type="number" min={1} max={1000000} value={modelValue('max_tokens')} onChange={(e) => setModelValue('max_tokens', e.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" />
              </label>
              <label className="text-[13px] text-slate-400">{lang === 'zh' ? '故障转移优先级' : 'Failover priority'}
                <input type="number" min={1} value={modelValue('failover_priority')} onChange={(e) => setModelValue('failover_priority', e.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" />
                <span className="mt-1 block text-[12px] text-slate-500">{lang === 'zh' ? '数字越小越先用' : 'Lower runs first'}</span>
              </label>
            </div>

            <label className="block text-[13px] text-slate-400">API Key{modelForm.id ? '' : <span className="ml-1 text-rose-400">*</span>}
              <input type="password" autoComplete="new-password" value={modelValue('api_key')} onChange={(e) => setModelValue('api_key', e.target.value)} placeholder={modelForm.id ? (lang === 'zh' ? '留空＝保留原密钥' : 'Leave blank to keep the current key') : 'sk-…'} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 font-mono text-[13px] text-white outline-none transition placeholder:text-slate-600 focus:border-indigo-500" />
              <span className="mt-1 block text-[12px] text-slate-500">{modelForm.id ? (lang === 'zh' ? '留空则不修改已存的密钥。' : 'Blank keeps the stored key.') : (lang === 'zh' ? '只写入后端加密存储，不回显。' : 'Stored encrypted server-side.')}</span>
            </label>

            {modelTest && <div className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-[12.5px] leading-relaxed text-slate-300"><b className="text-slate-400">{lang === 'zh' ? '测试结果：' : 'Test: '}</b>{modelTest}</div>}
          </div>
        </Modal>
      )}
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
