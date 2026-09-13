import React, { useCallback, useEffect, useState } from 'react';
import { Activity, Loader2, Save, SlidersHorizontal } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';
import PermissionNotice from './PermissionNotice';

interface AiSystemSettingsPanelProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  canRead: boolean;
  canWrite: boolean;
  isSuperAdmin?: boolean;
}

const key = (prefix: string) => `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
const record = (value: unknown): ApiRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value));
const num = (value: unknown): number => (Number.isFinite(Number(value)) ? Number(value) : 0);

const STRATEGY_LABELS: Record<string, { zh: string; en: string }> = {
  rule: { zh: '按规则切分', en: 'Rule based' },
  auto: { zh: '自动', en: 'Automatic' },
  semantic_llm: { zh: '语义切分（需指定模型）', en: 'Semantic (needs a model)' },
};

const OVERVIEW_LABELS: Record<string, { zh: string; en: string }> = {
  model_count: { zh: '可用模型', en: 'Available models' },
  prompt_count: { zh: '提示词总数', en: 'Prompts' },
  total_usage: { zh: '本人模型累计调用', en: 'Your model calls (total)' },
  today_usage: { zh: '本人模型今日调用', en: 'Your model calls (today)' },
  search_provider_count: { zh: '启用的搜索来源', en: 'Active search providers' },
  search_provider_today_usage: { zh: '搜索来源今日调用', en: 'Search calls (today)' },
  visibility_failed_runs: { zh: '可见度失败运行', en: 'Failed visibility runs' },
};

/**
 * 系统级 AI 配置 + 个人默认 + 概览计数。
 *
 * 三块东西的权限边界**不一样**，不能合成一个「保存」：
 * - **系统级**（切片策略、默认 embedding）决定知识库怎么切、用哪条模型向量化，**超管专属**；
 *   非超管连读都会 403，所以整块对非超管隐藏，而不是给一组禁用控件。
 * - **个人默认**谁都能改自己的，且**字段缺省 = 保持现状**（只想改一个槽位时另一个别传）。
 * - **概览计数**是只读监测；其中三项超管专属，非超管拿到的是 **null 而不是 0**
 *   ——「你没权限看」和「真的是零」必须分开显示。
 */
const AiSystemSettingsPanel: React.FC<AiSystemSettingsPanelProps> = ({
  apiClient, lang, canRead, canWrite, isSuperAdmin = false,
}) => {
  const zh = lang === 'zh';
  const [overview, setOverview] = useState<ApiRecord | null>(null);
  const [system, setSystem] = useState<ApiRecord | null>(null);
  const [personal, setPersonal] = useState<{ chat: string; embedding: string }>({ chat: '', embedding: '' });
  const [personalModels, setPersonalModels] = useState<{ chat: ApiRecord[]; embedding: ApiRecord[] }>({ chat: [], embedding: [] });
  const [chunking, setChunking] = useState({ strategy: 'rule', model_id: '' });
  const [defaultEmbedding, setDefaultEmbedding] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    if (!canRead) return;
    setError('');
    try {
      const [overviewData, modelsData] = await Promise.all([
        apiClient.getAiConfiguratorOverview(),
        apiClient.listAiModels(),
      ]);
      setOverview(record(overviewData.stats));
      const defaults = record((modelsData as unknown as ApiRecord).defaults);
      setPersonal({ chat: text(defaults.chat_model_id), embedding: text(defaults.embedding_model_id) });
      const rows = Array.isArray((modelsData as unknown as ApiRecord).items) ? ((modelsData as unknown as ApiRecord).items as ApiRecord[]) : [];
      setPersonalModels({
        chat: rows.filter((row) => (text(row.model_type) || 'chat') === 'chat'),
        embedding: rows.filter((row) => text(row.model_type) === 'embedding'),
      });
    } catch (cause) {
      setError(describeApiError(cause, zh ? '读取 AI 配置失败' : 'Unable to load AI configuration', lang));
    }

    if (!isSuperAdmin) { setSystem(null); return; }
    try {
      const data = await apiClient.getAiSystemSettings();
      setSystem(data);
      const current = record(data.chunking);
      setChunking({ strategy: text(current.strategy) || 'rule', model_id: text(current.model_id) });
      setDefaultEmbedding(text(data.default_embedding_model_id));
    } catch (cause) {
      // 非超管读到 403 是预期内的，不把它显示成错误。
      setSystem(null);
      if (isSuperAdmin) setError(describeApiError(cause, zh ? '读取系统级配置失败' : 'Unable to load system settings', lang));
    }
  }, [apiClient, canRead, isSuperAdmin, lang, zh]);

  useEffect(() => { void load(); }, [load]);

  const run = async (tag: string, action: () => Promise<unknown>, okText: string, failText: string) => {
    if (busy) return;
    setBusy(tag); setError(''); setNotice('');
    try {
      await action();
      setNotice(okText);
      await load();
    } catch (cause) {
      setError(describeApiError(cause, failText, lang));
    } finally {
      setBusy('');
    }
  };

  if (!canRead) return null;

  const systemOptions = system ? record(system.options) : {};

  return (
    <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
      <h3 className="flex items-center gap-2 text-sm font-bold text-white">
        <SlidersHorizontal className="h-4 w-4 text-cyan-400" />
        {zh ? 'AI 配置与运行概览' : 'AI configuration & overview'}
      </h3>

      {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">{notice}</div>}

      {overview && (
        <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-300"><Activity className="h-3.5 w-3.5 text-cyan-400" />{zh ? '运行概览' : 'Overview'}</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Object.keys(OVERVIEW_LABELS).map((field) => {
              const value = overview[field];
              // null = 没权限看（不是 0），要显示成「—」。
              const display = value === null || value === undefined ? '—' : String(num(value));
              const restricted = value === null || value === undefined;
              return (
                <div key={field} className="rounded-lg border border-slate-800 bg-slate-900/60 p-2">
                  <div className="text-[10px] text-slate-500">{OVERVIEW_LABELS[field][lang]}</div>
                  <div className={`mt-0.5 text-base font-bold tabular-nums ${restricted ? 'text-slate-600' : 'text-white'}`} title={restricted ? (zh ? '需要超级管理员权限' : 'Super administrator only') : undefined}>{display}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {isSuperAdmin && system && (
        <div className="space-y-2 rounded-xl border border-cyan-500/30 bg-slate-950/60 p-3">
          <div className="text-xs font-semibold text-slate-300">{zh ? '知识库切片与默认向量模型（超管）' : 'Chunking & default embedding (super admin)'}</div>
          <p className="text-[10px] text-slate-500">
            {zh ? '这两项决定知识库怎么切、用哪条模型向量化；改之前想清楚，存量内容不会自动重切。' : 'These decide how knowledge bases are chunked and embedded. Existing content is not re-processed automatically.'}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-[11px] text-slate-400">
              {zh ? '切片策略' : 'Chunking strategy'}
              <select value={chunking.strategy} onChange={(event) => setChunking({ ...chunking, strategy: event.target.value })} disabled={!canWrite} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white disabled:opacity-60">
                {(Array.isArray(system.strategies) ? (system.strategies as string[]) : Object.keys(STRATEGY_LABELS)).map((strategy) => (
                  <option key={strategy} value={strategy}>{STRATEGY_LABELS[strategy]?.[lang] ?? strategy}</option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-slate-400">
              {zh ? '切片模型（语义切分必填）' : 'Chunking model'}
              <select value={chunking.model_id} onChange={(event) => setChunking({ ...chunking, model_id: event.target.value })} disabled={!canWrite} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white disabled:opacity-60">
                <option value="">{zh ? '不指定' : 'None'}</option>
                {(Array.isArray(systemOptions.chat) ? (systemOptions.chat as ApiRecord[]) : []).map((model) => (
                  <option key={text(model.id)} value={text(model.id)}>{text(model.name)}</option>
                ))}
              </select>
            </label>
            <label className="text-[11px] text-slate-400 sm:col-span-2">
              {zh ? '系统默认向量模型（0 = 未设置）' : 'System default embedding model'}
              <select value={defaultEmbedding} onChange={(event) => setDefaultEmbedding(event.target.value)} disabled={!canWrite} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white disabled:opacity-60">
                <option value="0">{zh ? '未设置' : 'Not set'}</option>
                {(Array.isArray(systemOptions.embedding) ? (systemOptions.embedding as ApiRecord[]) : []).map((model) => (
                  <option key={text(model.id)} value={text(model.id)}>{text(model.name)}</option>
                ))}
              </select>
            </label>
          </div>
          {canWrite && (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void run('chunking', () => apiClient.updateChunkingConfig({ knowledge_chunk_strategy: chunking.strategy, knowledge_chunking_model_id: Number(chunking.model_id || 0) }, { idempotencyKey: key('chunking') }), zh ? '切片策略已保存。' : 'Chunking saved.', zh ? '保存切片策略失败' : 'Unable to save chunking')} disabled={busy === 'chunking'} className="inline-flex items-center gap-1 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50">
                {busy === 'chunking' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}{zh ? '保存切片策略' : 'Save chunking'}
              </button>
              <button type="button" onClick={() => void run('embedding', () => apiClient.updateDefaultEmbedding({ default_embedding_model_id: Number(defaultEmbedding || 0) }, { idempotencyKey: key('embedding') }), zh ? '默认向量模型已保存。' : 'Default embedding saved.', zh ? '保存默认向量模型失败' : 'Unable to save default embedding')} disabled={busy === 'embedding'} className="inline-flex items-center gap-1 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50">
                {busy === 'embedding' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}{zh ? '保存默认向量模型' : 'Save embedding'}
              </button>
            </div>
          )}
        </div>
      )}

      {canWrite && (
        <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
          <div className="text-xs font-semibold text-slate-300">{zh ? '我的默认模型' : 'My default models'}</div>
          <p className="text-[10px] text-slate-500">
            {zh ? '不带模型参数的生成用这里。只想改一个槽位时另一个留空即可——留空表示保持现状，不传 0 就不会清空。' : 'Used when a generation does not name a model. Leave a slot untouched to keep it as-is.'}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-[11px] text-slate-400">
              {zh ? '默认对话模型' : 'Default chat model'}
              <select value={personal.chat} onChange={(event) => setPersonal({ ...personal, chat: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white">
                <option value="">{zh ? '保持现状' : 'Keep current'}</option>
                {personalModels.chat.map((model) => <option key={text(model.id)} value={text(model.id)}>{text(model.name)}</option>)}
              </select>
            </label>
            <label className="text-[11px] text-slate-400">
              {zh ? '默认向量模型' : 'Default embedding model'}
              <select value={personal.embedding} onChange={(event) => setPersonal({ ...personal, embedding: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white">
                <option value="">{zh ? '保持现状' : 'Keep current'}</option>
                {personalModels.embedding.map((model) => <option key={text(model.id)} value={text(model.id)}>{text(model.name)}</option>)}
              </select>
            </label>
          </div>
          <button
            type="button"
            onClick={() => void run('personal', () => {
              // 留空 = 不传该字段 = 保持现状；这与「传 0 清空」是两回事。
              const payload: ApiRecord = {};
              if (personal.chat !== '') payload.default_chat_model_id = Number(personal.chat);
              if (personal.embedding !== '') payload.default_embedding_model_id = Number(personal.embedding);
              return apiClient.setPersonalModelDefaults(payload, { idempotencyKey: key('personal-defaults') });
            }, zh ? '默认模型已保存。' : 'Defaults saved.', zh ? '保存默认模型失败' : 'Unable to save defaults')}
            disabled={busy === 'personal' || (personal.chat === '' && personal.embedding === '')}
            className="inline-flex items-center gap-1 rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-600 disabled:opacity-50"
          >
            {busy === 'personal' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}{zh ? '保存我的默认' : 'Save my defaults'}
          </button>
        </div>
      )}

      {canRead && !isSuperAdmin && <PermissionNotice lang={lang} requiredScope="super_admin" />}
    </section>
  );
};

export default AiSystemSettingsPanel;
