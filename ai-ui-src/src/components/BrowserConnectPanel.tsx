import React, { useState } from 'react';
import { Check, Loader2, Plug, Search, X } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';

interface BrowserConnectPanelProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  canRead: boolean;
  canWrite: boolean;
}

const key = (prefix: string) => `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
const record = (value: unknown): ApiRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value));

function formatStamp(value: unknown): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  return new Date(seconds * 1000).toLocaleString();
}

const STATUS_LABELS: Record<string, { zh: string; en: string }> = {
  pending: { zh: '待批准', en: 'Pending' },
  approved: { zh: '已批准', en: 'Approved' },
  denied: { zh: '已拒绝', en: 'Denied' },
  expired: { zh: '已过期', en: 'Expired' },
};

/**
 * 浏览器插件的连接审批（运营方一侧）。
 *
 * 走的是**设备授权流程**：插件先显示一串配对码，运营方把码填进来才能看到并批准
 * 那一次请求。所以这里的入口是「输入配对码」而不是「待批列表」——服务端也没有
 * 按列表查的入口，不要在前端假装有一个。
 *
 * `authorization` 为 null 表示「没这个请求」或「已过期」，两者对运营方是同一件事：
 * 回插件里重新申请。所以文案要把这两句一起说，而不是显示一个空面板。
 */
const BrowserConnectPanel: React.FC<BrowserConnectPanelProps> = ({ apiClient, lang, canRead, canWrite }) => {
  const zh = lang === 'zh';
  // 插件拿到的 `verification_uri_complete` 形如 `/geo_admin?tab=manual-publications&user_code=XXXX`：
  // 运营方点一下就该直接看到那一次配对请求，而不是再手抄一遍码。所以这里读一次 URL 里的
  // `user_code` 作为初始值，并在拿到读权限后自动查询一次。
  const codeFromUrl = React.useMemo(() => {
    if (typeof window === 'undefined') return '';
    return (new URLSearchParams(window.location.search).get('user_code') || '').trim().toUpperCase();
  }, []);
  const [userCode, setUserCode] = useState(codeFromUrl);
  const [queriedCode, setQueriedCode] = useState('');
  const [authorization, setAuthorization] = useState<ApiRecord | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const lookup = async (codeOverride?: string) => {
    const code = (codeOverride ?? userCode).trim();
    if (busy || code === '' || !canRead) return;
    setBusy('lookup'); setError(''); setNotice('');
    try {
      const data = record(await apiClient.getBrowserConnect(code));
      setQueriedCode(text(data.user_code) || code);
      setAuthorization(data.authorization ? record(data.authorization) : null);
    } catch (cause) {
      setError(describeApiError(cause, zh ? '查询配对码失败' : 'Unable to look up the code', lang));
      setAuthorization(null);
    } finally {
      setBusy('');
    }
  };

  // 只自动查一次：深链进来时把码带出来。之后由运营方手动操作，避免每次输入都打接口。
  const autoLookedUp = React.useRef(false);
  React.useEffect(() => {
    if (autoLookedUp.current || codeFromUrl === '' || !canRead) return;
    autoLookedUp.current = true;
    void lookup(codeFromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeFromUrl, canRead]);

  const decide = async (decision: 'approve' | 'deny') => {
    if (busy || queriedCode === '' || !canWrite) return;
    setBusy(decision); setError(''); setNotice('');
    try {
      await apiClient.decideBrowserConnect(queriedCode, decision, { idempotencyKey: key(`browser-connect-${decision}`) });
      setNotice(decision === 'approve' ? (zh ? '已批准，插件可以开始使用。' : 'Approved.') : (zh ? '已拒绝。' : 'Denied.'));
      await lookup();
    } catch (cause) {
      setError(describeApiError(cause, decision === 'approve' ? (zh ? '批准失败' : 'Unable to approve') : (zh ? '拒绝失败' : 'Unable to deny'), lang));
    } finally {
      setBusy('');
    }
  };

  if (!canRead) return null;

  const status = authorization ? text(authorization.status) : '';

  return (
    <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
      <h3 className="flex items-center gap-2 text-sm font-bold text-white">
        <Plug className="h-4 w-4 text-emerald-400" />
        {zh ? '浏览器插件连接' : 'Browser plugin connection'}
      </h3>
      <p className="text-[11px] leading-relaxed text-slate-500">
        {zh
          ? '在插件里发起连接后会显示一串配对码，把它填在这里确认。批准前请核对客户端名称是不是你要授权的那个。'
          : 'The plugin shows a pairing code when it requests access. Enter it here; check the client name before approving.'}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            value={userCode}
            onChange={(event) => setUserCode(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void lookup(); }}
            placeholder={zh ? '配对码（如 ABCD-1234）' : 'Pairing code'}
            className="w-56 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 pl-8 font-mono text-xs text-white outline-none focus:border-indigo-500"
          />
        </div>
        <button type="button" onClick={() => void lookup()} disabled={busy === 'lookup' || userCode.trim() === ''} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50">
          {busy === 'lookup' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}{zh ? '查询' : 'Look up'}
        </button>
      </div>

      {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">{notice}</div>}

      {queriedCode !== '' && (
        authorization ? (
          <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono text-slate-200">{queriedCode}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${status === 'pending' ? 'bg-amber-500/20 text-amber-300' : status === 'approved' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400'}`}>
                {STATUS_LABELS[status]?.[lang] ?? status}
              </span>
            </div>
            <div className="text-[11px] text-slate-500">
              {zh ? '客户端' : 'Client'}: {text(authorization.client_name) || '—'} · {zh ? '申请于' : 'Requested'} {formatStamp(authorization.requested_at)} · {zh ? '过期' : 'Expires'} {formatStamp(authorization.expires_at)}
            </div>
            {canWrite && status === 'pending' && (
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={() => void decide('approve')} disabled={busy === 'approve'} className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
                  {busy === 'approve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}{zh ? '批准' : 'Approve'}
                </button>
                <button type="button" onClick={() => void decide('deny')} disabled={busy === 'deny'} className="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs font-semibold text-rose-300 hover:bg-rose-950/30 disabled:opacity-50">
                  {busy === 'deny' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}{zh ? '拒绝' : 'Deny'}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-800 px-4 py-6 text-center text-[11px] text-slate-500">
            {zh ? `没有找到配对码 ${queriedCode} 的待批请求（可能已过期）。请让插件重新发起一次连接。` : `No pending request for ${queriedCode} (it may have expired). Ask the plugin to start over.`}
          </div>
        )
      )}
    </section>
  );
};

export default BrowserConnectPanel;
