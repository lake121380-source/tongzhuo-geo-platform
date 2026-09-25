import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Plug, Save, Search } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';

interface ModelBindingsPanelProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  /** 该配置是超管专属，服务端会再判一次。 */
  canManage: boolean;
}

const key = (prefix: string) => `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
const record = (value: unknown): ApiRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value));

const BINDINGS = ['ark', 'deepseek'] as const;
type BindingType = typeof BINDINGS[number];

const BINDING_LABELS: Record<BindingType, { zh: string; en: string; role: { zh: string; en: string } }> = {
  ark: {
    zh: 'Ark 联网检索',
    en: 'Ark web search',
    role: { zh: '可见度运行时用它做联网检索', en: 'Used for live web search during visibility runs' },
  },
  deepseek: {
    zh: 'DeepSeek 二次分析',
    en: 'DeepSeek analysis',
    role: { zh: '对检索结果做二次分析', en: 'Second-pass analysis over search results' },
  },
};

/**
 * 可见度分析模型的绑定。
 *
 * 这两条绑定决定「AI 可见度运行用哪条模型做检索 / 二次分析」。旧后台能切、能验证；
 * 不做的话只能停在部署时绑的那条——所以「当前绑的是谁」必须一眼可见。
 *
 * `bindings` 里 **0 = 没绑或绑定已失效**（两种情况的动作都是重绑，不拆开显示）。
 * 探活是**真实出站**并消耗一次额度，所以是个明确的按钮，不跟着页面自动跑。
 */
const ModelBindingsPanel: React.FC<ModelBindingsPanelProps> = ({ apiClient, lang, canManage }) => {
  const zh = lang === 'zh';
  const [bindings, setBindings] = useState<Record<string, number>>({ ark: 0, deepseek: 0 });
  const [candidates, setCandidates] = useState<ApiRecord[]>([]);
  const [apiConfig, setApiConfig] = useState<Record<string, ApiRecord>>({});
  const [drafts, setDrafts] = useState<Record<string, { model_id: string; name: string; api_url: string; api_key: string; model_row_id: string; daily_limit: string; max_tokens: string }>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [probe, setProbe] = useState<Record<string, ApiRecord>>({});

  const load = useCallback(async () => {
    if (!canManage) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiClient.getVisibilityModelBindings();
      setBindings({ ark: Number(record(data.bindings).ark ?? 0), deepseek: Number(record(data.bindings).deepseek ?? 0) });
      setCandidates(Array.isArray(data.candidates) ? (data.candidates as ApiRecord[]) : []);
      const api = record(data.api);
      setApiConfig({ ark: record(api.ark), deepseek: record(api.deepseek) });
      setDrafts({
        ark: {
          model_row_id: text(record(api.ark).model_row_id),
          name: text(record(api.ark).name),
          model_id: text(record(api.ark).model_id),
          api_url: text(record(api.ark).api_url),
          api_key: '',
          // 日额度与 max_tokens 以前既不上屏也不回传，保存一次就被后端写成 0 / null；
          // 而 `daily_limit > 0` 才限流——**0 等于不限量**，等于把给模型设的额度抹掉了却看不见。
          daily_limit: text(record(api.ark).daily_limit) || '0',
          max_tokens: text(record(api.ark).max_tokens),
        },
        deepseek: {
          model_row_id: text(record(api.deepseek).model_row_id),
          name: text(record(api.deepseek).name),
          model_id: text(record(api.deepseek).model_id),
          api_url: text(record(api.deepseek).api_url),
          api_key: '',
          daily_limit: text(record(api.deepseek).daily_limit) || '0',
          max_tokens: text(record(api.deepseek).max_tokens),
        },
      });
    } catch (cause) {
      setError(describeApiError(cause, zh ? '读取可见度模型绑定失败' : 'Unable to load model bindings', lang));
    } finally {
      setLoading(false);
    }
  }, [apiClient, canManage, lang, zh]);

  useEffect(() => { void load(); }, [load]);

  const same = (a: number, b: number) => a > 0 && a === b;

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

  if (!canManage) return null;

  return (
    <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
      <h3 className="flex items-center gap-2 text-sm font-bold text-white">
        <Plug className="h-4 w-4 text-purple-400" />
        {zh ? '可见度分析模型绑定' : 'Visibility model bindings'}
      </h3>
      <p className="text-[11px] leading-relaxed text-slate-500">
        {zh
          ? '决定可见度运行用哪条模型做联网检索与二次分析。显示「未绑定」表示没绑、或者绑的那条模型现在已不可用——两种情况都要重新绑。'
          : 'Decides which model performs search and analysis. "Not bound" means either nothing is bound or the bound model is no longer usable.'}
      </p>

      {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">{notice}</div>}

      {loading ? (
        <div className="flex min-h-20 items-center justify-center text-xs text-slate-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{zh ? '读取绑定…' : 'Loading bindings…'}</div>
      ) : BINDINGS.map((type) => {
        const draft = drafts[type] ?? { model_row_id: '', name: '', model_id: '', api_url: '', api_key: '', daily_limit: '0', max_tokens: '' };
        const bound = bindings[type] ?? 0;
        const config = apiConfig[type] ?? {};
        const probes = probe[type];
        return (
          <div key={type} className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-slate-200">{BINDING_LABELS[type][lang]}</span>
              {bound > 0
                ? <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">{zh ? '已绑定' : 'Bound'} #{bound}</span>
                : <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">{zh ? '未绑定 / 已失效' : 'Not bound'}</span>}
              {config.api_key_configured === true && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">API Key ✓</span>}
            </div>
            <p className="text-[10px] text-slate-500">{BINDING_LABELS[type].role[lang]}</p>

            <label className="block text-[11px] text-slate-400">
              {zh ? '绑定的模型' : 'Bound model'}
              <select
                value={String(bound)}
                onChange={(event) => void run(`bind-${type}`, () => apiClient.updateVisibilityModelBindings(
                  { ark_model_id: type === 'ark' ? Number(event.target.value) : (bindings.ark ?? 0), deepseek_model_id: type === 'deepseek' ? Number(event.target.value) : (bindings.deepseek ?? 0) },
                  { idempotencyKey: key(`binding-${type}`) },
                ), zh ? '绑定已更新。' : 'Binding updated.', zh ? '更新绑定失败' : 'Unable to update binding')}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white"
              >
                <option value="0">{zh ? '解绑' : 'Unbind'}</option>
                {candidates.map((model) => (
                  <option key={text(model.id)} value={text(model.id)}>{text(model.name)}（{text(model.model_id)}）</option>
                ))}
              </select>
            </label>

            <details className="rounded-lg border border-slate-800 bg-slate-900/60 p-2">
              <summary className="cursor-pointer text-[11px] text-slate-300">{zh ? 'API 配置（域名、密钥、限额）' : 'API configuration'}</summary>
              <div className="mt-2 space-y-2">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input value={draft.name} onChange={(event) => setDrafts((previous) => ({ ...previous, [type]: { ...draft, name: event.target.value } }))} placeholder={zh ? '显示名' : 'Display name'} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white" />
                  <input value={draft.model_id} onChange={(event) => setDrafts((previous) => ({ ...previous, [type]: { ...draft, model_id: event.target.value } }))} placeholder={zh ? '模型 ID' : 'Model id'} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white" />
                  <input value={draft.api_url} onChange={(event) => setDrafts((previous) => ({ ...previous, [type]: { ...draft, api_url: event.target.value } }))} placeholder={zh ? 'API 地址' : 'API URL'} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white sm:col-span-2" />
                  <input type="password" value={draft.api_key} onChange={(event) => setDrafts((previous) => ({ ...previous, [type]: { ...draft, api_key: event.target.value } }))} placeholder={config.api_key_configured === true ? (zh ? '留空保留原密钥' : 'Leave blank to keep the key') : (zh ? 'API Key（必填）' : 'API key (required)')} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white sm:col-span-2" />
                  <label className="text-[11px] text-slate-400">
                    {zh ? '日额度（0 = 不限量）' : 'Daily limit (0 = unlimited)'}
                    <input type="number" min="0" value={draft.daily_limit} onChange={(event) => setDrafts((previous) => ({ ...previous, [type]: { ...draft, daily_limit: event.target.value } }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white" />
                  </label>
                  <label className="text-[11px] text-slate-400">
                    {zh ? 'max_tokens（留空不限制）' : 'max_tokens (blank = unset)'}
                    <input type="number" min="1" value={draft.max_tokens} onChange={(event) => setDrafts((previous) => ({ ...previous, [type]: { ...draft, max_tokens: event.target.value } }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white" />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void run(`api-${type}`, () => apiClient.saveVisibilityModelApi({
                      binding_type: type,
                      name: draft.name,
                      model_id: draft.model_id,
                      api_url: draft.api_url,
                      // 0 在这里是「不限量」而不是「没有额度」，所以必须显式回传（后端也只覆盖传上来的键）。
                      daily_limit: Number(draft.daily_limit || 0),
                      // 留空 = 不设上限；显式传 null 才能把已有值清掉。
                      max_tokens: draft.max_tokens.trim() === '' ? null : Number(draft.max_tokens),
                      // 留空表示沿用已有密钥，不要把空串发上去。
                      ...(draft.api_key === '' ? {} : { api_key: draft.api_key }),
                    }, { idempotencyKey: key(`binding-api-${type}`) }), zh ? 'API 配置已保存。' : 'API configuration saved.', zh ? '保存 API 配置失败' : 'Unable to save API configuration')}
                    disabled={busy === `api-${type}` || draft.name === '' || draft.model_id === '' || draft.api_url === ''}
                    className="inline-flex items-center gap-1 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-500 disabled:opacity-50"
                  >
                    {busy === `api-${type}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}{zh ? '保存 API 配置' : 'Save API config'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void run(`probe-${type}`, async () => {
                      const result = await apiClient.testVisibilityModelBinding(type, bound, { idempotencyKey: key(`binding-probe-${type}`) });
                      setProbe((previous) => ({ ...previous, [type]: result }));
                    }, zh ? '探活完成。' : 'Probe finished.', zh ? '探活失败' : 'Probe failed')}
                    disabled={busy === `probe-${type}` || bound <= 0}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                  >
                    {busy === `probe-${type}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}{zh ? '探活（会消耗一次额度）' : 'Probe (uses quota)'}
                  </button>
                </div>
                {probes && (
                  <div className="rounded-lg border border-slate-800 bg-slate-950 p-2 text-[10px] text-slate-400">
                    {zh ? '就绪度' : 'Readiness'}: {text(record(probes.workspace_readiness).status) || text(record(record(probes.workspace_readiness).configuration).status) || '—'}
                    {' · '}{zh ? '有效至' : 'Expires'} {text(probes.workspace_readiness_expires_at).slice(0, 19) || '—'}
                  </div>
                )}
              </div>
            </details>

            {config.bound === true && <div className="text-[10px] text-slate-600">{zh ? '当前' : 'Current'}: {text(config.name)} · {text(config.model_id)} · {text(config.api_url)}</div>}
          </div>
        );
      })}
    </section>
  );
};

export default ModelBindingsPanel;
