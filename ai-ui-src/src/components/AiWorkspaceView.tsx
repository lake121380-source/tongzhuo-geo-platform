import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Bot,
  BookOpen,
  ExternalLink,
  Loader2,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  UserRound,
} from 'lucide-react';
import {
  ApiRecord,
  GeoFlowApiClient,
  GeoFlowApiError,
} from '../api/geoflowClient';

interface Props {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  canRead: boolean;
  canWrite: boolean;
  onNavigate?: (tab: string) => void;
}

interface WorkspaceStatus {
  runtimeEnabled: boolean;
  ready: boolean;
  reason: string;
  starterActions: Array<{ id: string; name: string; prompt: string }>;
}

interface WorkspaceConversation {
  id: string;
  title: string;
  updatedAt: string;
}

interface WorkspaceMessage {
  id: string;
  role: string;
  content: string;
  meta: ApiRecord;
  createdAt: string;
  pending?: boolean;
}

const featureTabs: Record<string, string> = {
  'ai-visibility': 'analytics',
  'data-center': 'analytics',
  tasks: 'tasks',
  articles: 'articles',
  materials: 'materials',
  distribution: 'distribution',
  'knowledge-bases': 'knowledge',
  'lead-forms': 'leads',
  leads: 'leads',
  'ai-config': 'ai-models',
  'site-settings': 'admin-settings',
  'homepage-theme': 'admin-settings',
  'users-permissions': 'admin-settings',
};

function record(value: unknown): ApiRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
}

function records(value: unknown): ApiRecord[] {
  return Array.isArray(value) ? value.map(record).filter((item) => Object.keys(item).length > 0) : [];
}

function mapConversation(value: unknown): WorkspaceConversation {
  const item = record(value);
  return {
    id: String(item.id || ''),
    title: String(item.title || '新对话'),
    updatedAt: String(item.updated_at || ''),
  };
}

function mapMessage(value: unknown): WorkspaceMessage {
  const item = record(value);
  return {
    id: String(item.id || `message-${Date.now()}-${Math.random()}`),
    role: String(item.role || 'assistant'),
    content: String(item.content || ''),
    meta: record(item.meta),
    createdAt: String(item.created_at || ''),
  };
}

function errorText(error: unknown, lang: 'zh' | 'en'): string {
  if (error instanceof GeoFlowApiError) {
    const suffix = error.requestId ? ` · Request ID: ${error.requestId}` : '';
    return `${error.message}${suffix}`;
  }
  if (error instanceof Error) return error.message;
  return lang === 'zh' ? 'AI 工作台操作失败' : 'AI workspace operation failed';
}

function dateText(value: string, lang: 'zh' | 'en'): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(parsed);
}

function idempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const AiWorkspaceView: React.FC<Props> = ({ apiClient, lang, canRead, canWrite, onNavigate }) => {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [conversations, setConversations] = useState<WorkspaceConversation[]>([]);
  const [activeId, setActiveId] = useState('');
  const [messages, setMessages] = useState<WorkspaceMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [sending, setSending] = useState(false);
  const [streamLabel, setStreamLabel] = useState('');
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeId) || null,
    [activeId, conversations],
  );

  const loadConversation = async (id: string, before?: string) => {
    if (!id) return;
    setLoadingConversation(true);
    setError('');
    try {
      const result = record(await apiClient.getAiWorkspaceConversation(id, before));
      const conversation = record(result.conversation);
      const page = record(conversation.message_page);
      const loaded = records(conversation.messages).map(mapMessage);
      setActiveId(String(conversation.id || id));
      setMessages((current) => before
        ? [...loaded, ...current].filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
        : loaded);
      setNextCursor(page.has_more ? String(page.next_cursor || '') || null : null);
      setConversations((current) => current.map((item) => item.id === id ? {
        ...item,
        title: String(conversation.title || item.title),
        updatedAt: String(conversation.updated_at || item.updatedAt),
      } : item));
    } catch (cause) {
      setError(errorText(cause, lang));
    } finally {
      setLoadingConversation(false);
    }
  };

  const refreshConversations = async (preferredId?: string) => {
    const result = record(await apiClient.listAiWorkspaceConversations());
    const items = records(result.items).map(mapConversation).filter((item) => item.id);
    setConversations(items);
    const nextId = preferredId && items.some((item) => item.id === preferredId)
      ? preferredId
      : items[0]?.id || '';
    if (nextId) await loadConversation(nextId);
    else {
      setActiveId('');
      setMessages([]);
      setNextCursor(null);
    }
  };

  const refresh = async () => {
    if (!canRead) return;
    setLoading(true);
    setError('');
    try {
      const state = record(await apiClient.getAiWorkspaceStatus());
      setStatus({
        runtimeEnabled: Boolean(state.runtime_enabled),
        ready: Boolean(state.ready),
        reason: String(state.reason || ''),
        starterActions: records(state.starter_actions).map((item) => ({
          id: String(item.id || ''),
          name: String(item.name || ''),
          prompt: String(item.prompt || ''),
        })).filter((item) => item.prompt),
      });
      await refreshConversations(activeId || undefined);
    } catch (cause) {
      setError(errorText(cause, lang));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    return () => abortRef.current?.abort();
    // The client/session is stable for the authenticated shell. Reloading is
    // explicit so an active stream is never replaced by an unrelated render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiClient, canRead]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streamLabel]);

  const createConversation = async (): Promise<WorkspaceConversation | null> => {
    if (!canWrite) return null;
    setError('');
    try {
      const result = record(await apiClient.createAiWorkspaceConversation(undefined, {
        idempotencyKey: idempotencyKey('workspace-create'),
      }));
      const conversation = mapConversation(result.conversation);
      setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
      setActiveId(conversation.id);
      setMessages([]);
      setNextCursor(null);
      return conversation;
    } catch (cause) {
      setError(errorText(cause, lang));
      return null;
    }
  };

  const renameConversation = async () => {
    if (!activeConversation || !canWrite) return;
    const title = window.prompt(lang === 'zh' ? '输入新的会话名称' : 'New conversation title', activeConversation.title)?.trim();
    if (!title || title === activeConversation.title) return;
    setError('');
    try {
      const result = record(await apiClient.renameAiWorkspaceConversation(activeConversation.id, title, {
        idempotencyKey: idempotencyKey('workspace-rename'),
      }));
      const updated = mapConversation(result.conversation);
      setConversations((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      setError(errorText(cause, lang));
    }
  };

  const archiveConversation = async () => {
    if (!activeConversation || !canWrite) return;
    if (!window.confirm(lang === 'zh' ? '归档当前会话？历史记录会保留在数据库中。' : 'Archive this conversation? Its history remains persisted.')) return;
    setError('');
    try {
      await apiClient.archiveAiWorkspaceConversation(activeConversation.id, {
        idempotencyKey: idempotencyKey('workspace-archive'),
      });
      await refreshConversations();
    } catch (cause) {
      setError(errorText(cause, lang));
    }
  };

  const sendMessage = async () => {
    const question = prompt.trim();
    if (!question || sending || !canWrite || !status?.ready) return;
    let conversationId = activeId;
    if (!conversationId) {
      const created = await createConversation();
      if (!created) return;
      conversationId = created.id;
    }

    const userId = `local-user-${Date.now()}`;
    const answerId = `local-answer-${Date.now()}`;
    setPrompt('');
    setError('');
    setSending(true);
    setStreamLabel(lang === 'zh' ? '正在准备…' : 'Preparing…');
    setMessages((current) => [
      ...current,
      { id: userId, role: 'user', content: question, meta: {}, createdAt: new Date().toISOString() },
      { id: answerId, role: 'assistant', content: '', meta: {}, createdAt: new Date().toISOString(), pending: true },
    ]);
    const controller = new AbortController();
    abortRef.current = controller;
    let streamFailure = '';

    try {
      await apiClient.streamAiWorkspaceMessage(conversationId, question, ({ event, data }) => {
        if (event === 'status') setStreamLabel(String(data.label || (lang === 'zh' ? '正在生成…' : 'Generating…')));
        if (event === 'title') {
          const title = String(data.title || '');
          if (title) setConversations((current) => current.map((item) => item.id === conversationId ? { ...item, title } : item));
        }
        if (event === 'delta') {
          const delta = String(data.content || '');
          setMessages((current) => current.map((item) => item.id === answerId ? { ...item, content: item.content + delta } : item));
          setStreamLabel('');
        }
        if (event === 'done') {
          const title = String(data.conversation_title || '');
          setMessages((current) => current.map((item) => item.id === answerId ? {
            ...item,
            id: String(data.message_id || item.id),
            meta: data,
            pending: false,
          } : item));
          if (title) setConversations((current) => current.map((item) => item.id === conversationId ? { ...item, title } : item));
        }
        if (event === 'error') streamFailure = String(data.message || (lang === 'zh' ? '回答生成失败' : 'Generation failed'));
      }, { signal: controller.signal, idempotencyKey: idempotencyKey('workspace-message') });
      if (streamFailure) throw new Error(streamFailure);
      await refreshConversations(conversationId);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        setError(lang === 'zh' ? '已停止接收；请刷新会话确认服务端最终保存状态。' : 'Streaming stopped; refresh to reconcile the persisted state.');
      } else {
        setError(errorText(cause, lang));
      }
      await loadConversation(conversationId);
    } finally {
      abortRef.current = null;
      setSending(false);
      setStreamLabel('');
    }
  };

  if (!canRead) {
    return <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-6 text-amber-100">
      <h2 className="text-lg font-bold">{lang === 'zh' ? '无权访问 AI 工作台' : 'AI workspace access denied'}</h2>
      <p className="mt-2 text-sm text-amber-200/80">{lang === 'zh' ? '当前 Token 缺少 workspace:read。' : 'The current token lacks workspace:read.'}</p>
    </div>;
  }

  return <div className="flex min-h-[70vh] overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-xl">
    <aside className="flex w-72 shrink-0 flex-col border-r border-slate-800 bg-slate-950/60">
      <div className="flex items-center justify-between border-b border-slate-800 p-4">
        <div><h2 className="font-bold text-white">{lang === 'zh' ? 'AI 工作台' : 'AI Workspace'}</h2><p className="text-xs text-slate-500">桐灼GEO persisted assistant</p></div>
        <button type="button" onClick={() => void createConversation()} disabled={!canWrite || sending} className="rounded-lg bg-indigo-600 p-2 text-white disabled:opacity-40" title={lang === 'zh' ? '新对话' : 'New conversation'}><MessageSquarePlus className="h-4 w-4" /></button>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {loading ? <div className="flex items-center gap-2 p-3 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />{lang === 'zh' ? '加载真实会话…' : 'Loading conversations…'}</div>
          : conversations.length === 0 ? <div className="p-4 text-sm text-slate-500">{lang === 'zh' ? '数据库中还没有会话。' : 'No persisted conversations yet.'}</div>
            : conversations.map((conversation) => <button type="button" key={conversation.id} onClick={() => void loadConversation(conversation.id)} className={`w-full rounded-lg px-3 py-2 text-left ${activeId === conversation.id ? 'bg-indigo-600/20 text-indigo-100' : 'text-slate-300 hover:bg-slate-800'}`}><span className="block truncate text-sm font-medium">{conversation.title}</span><span className="mt-1 block text-[10px] text-slate-500">{dateText(conversation.updatedAt, lang)}</span></button>)}
      </div>
      <button type="button" onClick={() => void refresh()} disabled={loading || sending} className="m-3 inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 disabled:opacity-40"><RefreshCw className="h-3.5 w-3.5" />{lang === 'zh' ? '刷新数据库状态' : 'Refresh persisted state'}</button>
    </aside>

    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
        <div className="min-w-0"><h1 className="truncate text-lg font-bold text-white">{activeConversation?.title || (lang === 'zh' ? '桐灼GEO AI 助手' : '桐灼GEO AI Assistant')}</h1><p className="text-xs text-slate-500">{status?.ready ? (lang === 'zh' ? '模型、知识检索与持久化已就绪' : 'Model, retrieval and persistence ready') : status?.reason || ''}</p></div>
        {activeConversation && <div className="flex gap-2"><button type="button" onClick={() => void renameConversation()} disabled={!canWrite || sending} className="rounded-lg border border-slate-700 p-2 text-slate-300 disabled:opacity-40" title={lang === 'zh' ? '重命名' : 'Rename'}><Pencil className="h-4 w-4" /></button><button type="button" onClick={() => void archiveConversation()} disabled={!canWrite || sending} className="rounded-lg border border-red-500/30 p-2 text-red-300 disabled:opacity-40" title={lang === 'zh' ? '归档' : 'Archive'}><Archive className="h-4 w-4" /></button></div>}
      </header>

      {error && <div role="alert" className="m-4 rounded-lg border border-red-500/30 bg-red-950/30 px-4 py-3 text-sm text-red-100">{error}</div>}
      {!loading && status && !status.ready && <div className="mx-4 mt-4 rounded-lg border border-amber-500/30 bg-amber-950/20 px-4 py-3 text-sm text-amber-100"><strong>{lang === 'zh' ? '真实模型暂不可用：' : 'Real model unavailable: '}</strong>{status.reason || (lang === 'zh' ? '请在模型配置中完成连接测试。' : 'Complete model configuration and readiness testing.')}</div>}

      <div className="flex-1 overflow-y-auto p-5">
        {nextCursor && <button type="button" onClick={() => void loadConversation(activeId, nextCursor)} disabled={loadingConversation} className="mx-auto mb-5 flex items-center gap-2 rounded-full border border-slate-700 px-4 py-2 text-xs text-slate-300"><BookOpen className="h-3.5 w-3.5" />{loadingConversation ? (lang === 'zh' ? '加载中…' : 'Loading…') : (lang === 'zh' ? '加载更早消息' : 'Load earlier')}</button>}
        {messages.length === 0 ? <EmptyWorkspace status={status} lang={lang} setPrompt={setPrompt} />
          : <div className="space-y-6">{messages.map((message) => <MessageCard key={message.id} message={message} apiClient={apiClient} lang={lang} onNavigate={onNavigate} setPrompt={setPrompt} />)}</div>}
        {streamLabel && <div className="mt-4 flex items-center gap-2 text-sm text-indigo-300"><Loader2 className="h-4 w-4 animate-spin" />{streamLabel}</div>}
        <div ref={messagesEndRef} />
      </div>

      <footer className="border-t border-slate-800 bg-slate-950/40 p-4">
        <div className="flex items-end gap-3 rounded-xl border border-slate-700 bg-slate-900 p-3 focus-within:border-indigo-500">
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} disabled={!canWrite || !status?.ready || sending} rows={2} maxLength={4000} placeholder={lang === 'zh' ? '询问后台功能、操作步骤或故障排查…' : 'Ask about features, operations or troubleshooting…'} className="min-h-12 flex-1 resize-none bg-transparent text-sm text-white outline-none placeholder:text-slate-600 disabled:opacity-50" />
          {sending ? <button type="button" onClick={() => abortRef.current?.abort()} className="rounded-lg bg-red-600 p-3 text-white" title={lang === 'zh' ? '停止' : 'Stop'}><Square className="h-4 w-4" /></button>
            : <button type="button" onClick={() => void sendMessage()} disabled={!prompt.trim() || !canWrite || !status?.ready} className="rounded-lg bg-indigo-600 p-3 text-white disabled:opacity-40" title={lang === 'zh' ? '发送' : 'Send'}><Send className="h-4 w-4" /></button>}
        </div>
        <p className="mt-2 text-center text-[10px] text-slate-600">{lang === 'zh' ? '回答、来源与会话写入 桐灼GEO 数据库；模型不可用时不会返回演示答案。' : 'Answers, sources and history are persisted in 桐灼GEO; no demo answer is substituted.'}</p>
      </footer>
    </section>
  </div>;
};

const EmptyWorkspace: React.FC<{ status: WorkspaceStatus | null; lang: 'zh' | 'en'; setPrompt: (value: string) => void }> = ({ status, lang, setPrompt }) => <div className="mx-auto flex max-w-3xl flex-col items-center py-16 text-center">
  <div className="rounded-2xl bg-indigo-600/15 p-4 text-indigo-300"><Sparkles className="h-8 w-8" /></div>
  <h3 className="mt-4 text-xl font-bold text-white">{lang === 'zh' ? '向 桐灼GEO 询问真实后台能力' : 'Ask 桐灼GEO about the real admin'}</h3>
  <p className="mt-2 max-w-xl text-sm text-slate-400">{lang === 'zh' ? '回答由当前部署的模型与系统知识库生成，并保留来源和会话记录。' : 'Answers use the configured model and system knowledge base, with sources and history persisted.'}</p>
  <div className="mt-7 grid w-full gap-3 sm:grid-cols-2">{status?.starterActions.map((action) => <button type="button" key={action.id} onClick={() => setPrompt(action.prompt)} className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-left hover:border-indigo-500/50"><span className="block text-sm font-semibold text-slate-200">{action.name}</span><span className="mt-1 block text-xs text-slate-500">{action.prompt}</span></button>)}</div>
</div>;

const MessageCard: React.FC<{ message: WorkspaceMessage; apiClient: GeoFlowApiClient; lang: 'zh' | 'en'; onNavigate?: (tab: string) => void; setPrompt: (value: string) => void }> = ({ message, apiClient, lang, onNavigate, setPrompt }) => {
  const assistant = message.role === 'assistant';
  const features = records(message.meta.related_features);
  const sources = records(message.meta.knowledge_sources);
  const media = records(message.meta.related_media);
  const suggestions = Array.isArray(message.meta.suggestions) ? message.meta.suggestions.map(String).filter(Boolean) : [];
  return <article className={`flex gap-3 ${assistant ? '' : 'justify-end'}`}>
    {assistant && <div className="mt-1 rounded-lg bg-indigo-600/20 p-2 text-indigo-300"><Bot className="h-4 w-4" /></div>}
    <div className={`max-w-3xl rounded-2xl px-4 py-3 ${assistant ? 'border border-slate-800 bg-slate-950/50 text-slate-200' : 'bg-indigo-600 text-white'}`}>
      <div className="whitespace-pre-wrap break-words text-sm leading-7">{message.content || (message.pending ? (lang === 'zh' ? '正在生成真实回答…' : 'Generating…') : '')}</div>
      {assistant && features.length > 0 && <div className="mt-4 flex flex-wrap gap-2">{features.map((feature) => { const id = String(feature.id || ''); const tab = featureTabs[id]; return <button type="button" key={id || String(feature.title)} disabled={!tab || !onNavigate} onClick={() => tab && onNavigate?.(tab)} className="inline-flex items-center gap-1 rounded-full border border-indigo-500/30 bg-indigo-950/30 px-3 py-1 text-xs text-indigo-200 disabled:opacity-50">{String(feature.title || feature.name || id)}<ExternalLink className="h-3 w-3" /></button>; })}</div>}
      {assistant && media.length > 0 && <div className="mt-4 grid gap-3 sm:grid-cols-2">{media.map((item) => <WorkspaceMedia key={String(item.id)} item={item} apiClient={apiClient} />)}</div>}
      {assistant && sources.length > 0 && <details className="mt-4 rounded-lg border border-slate-800 bg-slate-900/60 p-3"><summary className="cursor-pointer text-xs font-semibold text-slate-300">{lang === 'zh' ? `参考来源（${sources.length}）` : `Sources (${sources.length})`}</summary><ul className="mt-2 space-y-2 text-xs text-slate-500">{sources.map((source, index) => <li key={`${String(source.knowledge_base_id || '')}-${index}`}>{String(source.title || source.section_path || source.feature_id || (lang === 'zh' ? '系统知识库' : 'System knowledge'))}</li>)}</ul></details>}
      {assistant && suggestions.length > 0 && <div className="mt-4 space-y-2">{suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => setPrompt(suggestion)} className="block text-left text-xs text-indigo-300 hover:text-indigo-200">→ {suggestion}</button>)}</div>}
    </div>
    {!assistant && <div className="mt-1 rounded-lg bg-slate-800 p-2 text-slate-300"><UserRound className="h-4 w-4" /></div>}
  </article>;
};

const WorkspaceMedia: React.FC<{ item: ApiRecord; apiClient: GeoFlowApiClient }> = ({ item, apiClient }) => {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    void apiClient.downloadAiWorkspaceMedia(Number(item.id), true).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => setUrl(''));
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [apiClient, item.id]);
  if (!url) return null;
  return <figure className="overflow-hidden rounded-lg border border-slate-800"><img src={url} alt={String(item.alt || item.title || '')} className="h-auto w-full" /><figcaption className="px-3 py-2 text-xs text-slate-500">{String(item.caption || item.title || '')}</figcaption></figure>;
};
