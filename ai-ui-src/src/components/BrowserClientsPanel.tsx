import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, MonitorSmartphone, RefreshCw, Trash2 } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';
import PermissionNotice from './PermissionNotice';

interface BrowserClientsPanelProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  canRead: boolean;
  canWrite: boolean;
}

const key = (prefix: string) => `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
const record = (value: unknown): ApiRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value));

/**
 * 已授权的浏览器客户端（插件的设备授权）。
 *
 * **与个人 API Token 不是一回事**：这些是浏览器插件走设备授权流程拿到的凭据。
 * 判据是 token 能力里有没有 `browser-operations:read`，服务端也只列/只撤这一类——
 * 所以这个面板不会误删运营方脚本用的普通 Token。
 *
 * 普通管理员只看得到、也只能撤销**自己的**客户端；超管看全部（与旧后台一致）。
 */
const BrowserClientsPanel: React.FC<BrowserClientsPanelProps> = ({ apiClient, lang, canRead, canWrite }) => {
  const zh = lang === 'zh';
  const [clients, setClients] = useState<ApiRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiClient.listBrowserClients();
      setClients(Array.isArray(data.items) ? (data.items as ApiRecord[]).map(record) : []);
    } catch (cause) {
      setError(describeApiError(cause, zh ? '读取浏览器客户端失败' : 'Unable to load browser clients', lang));
    } finally {
      setLoading(false);
    }
  }, [apiClient, canRead, lang, zh]);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (client: ApiRecord) => {
    const id = text(client.id);
    if (busy || id === '') return;
    setBusy(id); setError(''); setNotice('');
    try {
      await apiClient.revokeBrowserClient(id, { idempotencyKey: key(`revoke-browser-client-${id}`) });
      setNotice(zh ? '已撤销该浏览器客户端的授权。' : 'Browser client revoked.');
      await load();
    } catch (cause) {
      setError(describeApiError(cause, zh ? '撤销失败' : 'Unable to revoke', lang));
    } finally {
      setBusy('');
    }
  };

  if (!canRead) return null;

  return (
    <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold text-white">
          <MonitorSmartphone className="h-4 w-4 text-emerald-400" />
          {zh ? '已授权的浏览器客户端' : 'Authorized browser clients'}
          <span className="text-[11px] font-normal text-slate-500">{clients.length}</span>
        </h3>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-200 hover:bg-slate-800 disabled:opacity-50">
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />{zh ? '刷新' : 'Refresh'}
        </button>
      </div>
      <p className="text-[11px] leading-relaxed text-slate-500">
        {zh
          ? '浏览器插件通过配对码拿到的长期凭据。撤销后那个插件需要重新配对；这里列的是插件授权，不是你自己建的 API Token。'
          : 'Long-lived credentials the browser plugin obtained via pairing. Revoking forces it to pair again. These are plugin authorizations, not your API tokens.'}
      </p>

      {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">{notice}</div>}
      {!canWrite && <PermissionNotice lang={lang} requiredScope="account:write" />}

      {loading && clients.length === 0 ? (
        <div className="flex min-h-20 items-center justify-center text-xs text-slate-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{zh ? '读取中…' : 'Loading…'}</div>
      ) : clients.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 px-4 py-6 text-center text-[11px] text-slate-500">
          {zh ? '还没有已授权的浏览器客户端' : 'No authorized browser client yet'}
        </div>
      ) : (
        <div className="space-y-2">
          {clients.map((client) => {
            const id = text(client.id);
            return (
              <div key={id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-slate-200">{text(client.name) || `#${id}`}</div>
                  <div className="mt-1 text-[10px] text-slate-500">
                    {text(client.created_by_username) !== '' && <span className="mr-2">{zh ? '归属' : 'Owner'}: {text(client.created_by_username)}</span>}
                    {zh ? '创建于' : 'Created'} {text(client.created_at).slice(0, 10)}
                    {text(client.last_used_at) !== '' && ` · ${zh ? '最近使用' : 'Last used'} ${text(client.last_used_at).slice(0, 10)}`}
                    {text(client.expires_at) !== '' && ` · ${zh ? '过期' : 'Expires'} ${text(client.expires_at).slice(0, 10)}`}
                  </div>
                </div>
                {canWrite && (
                  <button type="button" onClick={() => void revoke(client)} disabled={busy === id} className="shrink-0 text-rose-300 hover:text-rose-200 disabled:opacity-40" title={zh ? '撤销授权' : 'Revoke'}>
                    {busy === id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};

export default BrowserClientsPanel;
