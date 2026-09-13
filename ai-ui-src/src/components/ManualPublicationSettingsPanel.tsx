import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Save, ShieldCheck, UserRound } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';
import PermissionNotice from './PermissionNotice';

interface ManualPublicationSettingsPanelProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  canRead: boolean;
  canWrite: boolean;
  isSuperAdmin?: boolean;
}

const key = (prefix: string) => `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
const record = (value: unknown): ApiRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
const text = (value: unknown): string => (value === undefined || value === null ? '' : String(value));

type PersonaDraft = { name: string; bio: string; tone: string; domain: string; disclosure_text: string };
type AccountDraft = { persona_id: string; platform: string; custom_platform: string; account_name: string; profile_url: string; notes: string };

const emptyPersona = (): PersonaDraft => ({ name: '', bio: '', tone: '', domain: '', disclosure_text: '' });
const emptyAccount = (): AccountDraft => ({ persona_id: '', platform: 'custom', custom_platform: '', account_name: '', profile_url: '', notes: '' });

/**
 * 发布账号与人设。
 *
 * 这两样决定「手动发布工单派给谁」：人设是发文身份（口吻、领域、披露语），账号是
 * 某个平台上那个身份的具体账号。**超管专属**——服务端另判，前端置灰不算门禁。
 *
 * 账号必须挂在某个人设下（`persona_id` 必填），所以人设为空时要先提示建人设，
 * 而不是给一个必定 422 的表单。
 */
const ManualPublicationSettingsPanel: React.FC<ManualPublicationSettingsPanelProps> = ({
  apiClient, lang, canRead, canWrite, isSuperAdmin = false,
}) => {
  const zh = lang === 'zh';
  const [personas, setPersonas] = useState<ApiRecord[]>([]);
  const [accounts, setAccounts] = useState<ApiRecord[]>([]);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [personaDraft, setPersonaDraft] = useState<PersonaDraft>(emptyPersona);
  const [accountDraft, setAccountDraft] = useState<AccountDraft>(emptyAccount);
  const [editingPersona, setEditingPersona] = useState<ApiRecord | null>(null);
  const [editingAccount, setEditingAccount] = useState<ApiRecord | null>(null);

  const canMutate = canWrite && isSuperAdmin;

  const load = useCallback(async () => {
    // 这个端点是**超管专属**（服务端 index() 第一行就判超管）。非超管进来只显示
    // PermissionNotice，不要发请求——否则会稳定挂出一条 403 错误，看上去像系统故障。
    if (!canRead || !isSuperAdmin) return;
    setLoading(true);
    setError('');
    try {
      const data = record(await apiClient.getManualPublicationSettings());
      const nextPersonas = Array.isArray(data.personas) ? data.personas.map(record) : [];
      setPersonas(nextPersonas);
      setAccounts(Array.isArray(data.accounts) ? data.accounts.map(record) : []);
      const nextPlatforms = Array.isArray(data.platforms) ? data.platforms.map(text) : [];
      setPlatforms(nextPlatforms.length > 0 ? nextPlatforms : ['custom']);
      setAccountDraft((previous) => ({
        ...previous,
        persona_id: previous.persona_id || (nextPersonas[0] ? text(nextPersonas[0].id) : ''),
      }));
    } catch (cause) {
      setError(describeApiError(cause, zh ? '无法读取发布账号与人设' : 'Unable to load personas and accounts', lang));
    } finally {
      setLoading(false);
    }
  }, [apiClient, canRead, isSuperAdmin, lang, zh]);

  useEffect(() => { void load(); }, [load]);

  const fail = (cause: unknown, fallback: string) => setError(describeApiError(cause, fallback, lang));

  const savePersona = async () => {
    if (busy || personaDraft.name.trim() === '') return;
    setBusy('persona'); setError(''); setNotice('');
    const payload = { ...personaDraft, is_active: true };
    try {
      if (editingPersona) {
        await apiClient.updateManualPublicationPersona(text(editingPersona.id), payload, { idempotencyKey: key('persona-update') });
        setNotice(zh ? '人设已更新。' : 'Persona updated.');
      } else {
        await apiClient.saveManualPublicationPersona(payload, { idempotencyKey: key('persona-create') });
        setNotice(zh ? '人设已创建。' : 'Persona created.');
      }
      setPersonaDraft(emptyPersona());
      setEditingPersona(null);
      await load();
    } catch (cause) {
      fail(cause, zh ? '保存人设失败' : 'Unable to save persona');
    } finally {
      setBusy('');
    }
  };

  const saveAccount = async () => {
    if (busy || accountDraft.account_name.trim() === '' || accountDraft.persona_id === '') return;
    setBusy('account'); setError(''); setNotice('');
    const payload = { ...accountDraft, persona_id: Number(accountDraft.persona_id), is_active: true };
    try {
      if (editingAccount) {
        await apiClient.updateManualPublicationAccount(text(editingAccount.id), payload, { idempotencyKey: key('account-update') });
        setNotice(zh ? '账号已更新。' : 'Account updated.');
      } else {
        await apiClient.saveManualPublicationAccount(payload, { idempotencyKey: key('account-create') });
        setNotice(zh ? '账号已创建。' : 'Account created.');
      }
      setAccountDraft({ ...emptyAccount(), persona_id: accountDraft.persona_id });
      setEditingAccount(null);
      await load();
    } catch (cause) {
      fail(cause, zh ? '保存账号失败' : 'Unable to save account');
    } finally {
      setBusy('');
    }
  };

  if (!canRead) return null;

  return (
    <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
      <h3 className="flex items-center gap-2 text-sm font-bold text-white">
        <UserRound className="h-4 w-4 text-sky-400" />
        {zh ? '发布账号与人设' : 'Publishing personas & accounts'}
        <span className="text-[11px] font-normal text-slate-500">{personas.length} / {accounts.length}</span>
      </h3>
      <p className="text-[11px] leading-relaxed text-slate-500">
        {zh
          ? '人设是发文身份（口吻、领域、披露语），账号是某个平台上该身份的具体入口；工单派发时两者一起决定「谁去发」。'
          : 'A persona is the publishing identity; an account is that identity on a specific platform. Both decide who publishes a work order.'}
      </p>

      {canWrite && !isSuperAdmin && <PermissionNotice lang={lang} requiredScope="super_admin" />}
      {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">{notice}</div>}

      {loading ? (
        <div className="flex min-h-24 items-center justify-center text-xs text-slate-500"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{zh ? '读取中…' : 'Loading…'}</div>
      ) : (
        <>
          <div className="space-y-2">
            <div className="text-xs font-semibold text-slate-300">{zh ? '人设' : 'Personas'}</div>
            {personas.length === 0 && <div className="rounded-lg border border-dashed border-slate-800 px-3 py-4 text-center text-[11px] text-slate-500">{zh ? '还没有人设，先建一个人设再建账号' : 'No persona yet; create one before adding accounts'}</div>}
            {personas.map((persona) => (
              <div key={text(persona.id)} className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-slate-200">{text(persona.name)} <span className="ml-1 text-[10px] text-slate-500">{text(persona.accounts_count)} {zh ? '个账号' : 'accounts'}</span></div>
                  <div className="mt-1 text-[10px] text-slate-500">{[text(persona.tone), text(persona.domain), text(persona.bio)].filter((v) => v !== '').join(' · ') || (zh ? '未填写口吻/领域' : 'No tone/domain')}</div>
                </div>
                {canMutate && (
                  <button type="button" onClick={() => { setEditingPersona(persona); setPersonaDraft({ name: text(persona.name), bio: text(persona.bio), tone: text(persona.tone), domain: text(persona.domain), disclosure_text: text(persona.disclosure_text) }); }} className="shrink-0 text-[11px] text-slate-300 hover:text-white">{zh ? '编辑' : 'Edit'}</button>
                )}
              </div>
            ))}
          </div>

          {canMutate && (
            <div className="space-y-2 rounded-xl border border-sky-500/30 bg-slate-950/60 p-3">
              <div className="text-[11px] font-semibold text-slate-300">{editingPersona ? (zh ? `编辑人设 #${text(editingPersona.id)}` : `Edit persona #${text(editingPersona.id)}`) : (zh ? '新增人设' : 'New persona')}</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input value={personaDraft.name} onChange={(event) => setPersonaDraft({ ...personaDraft, name: event.target.value })} placeholder={zh ? '人设名称 *' : 'Persona name *'} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" />
                <input value={personaDraft.tone} onChange={(event) => setPersonaDraft({ ...personaDraft, tone: event.target.value })} placeholder={zh ? '口吻' : 'Tone'} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" />
                <input value={personaDraft.domain} onChange={(event) => setPersonaDraft({ ...personaDraft, domain: event.target.value })} placeholder={zh ? '领域' : 'Domain'} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" />
                <input value={personaDraft.disclosure_text} onChange={(event) => setPersonaDraft({ ...personaDraft, disclosure_text: event.target.value })} placeholder={zh ? '披露语（如「本文由 AI 辅助撰写」）' : 'Disclosure text'} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" />
              </div>
              <textarea value={personaDraft.bio} onChange={(event) => setPersonaDraft({ ...personaDraft, bio: event.target.value })} rows={2} placeholder={zh ? '简介' : 'Bio'} className="w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-xs text-white" />
              <div className="flex gap-2">
                <button type="button" onClick={() => void savePersona()} disabled={busy === 'persona' || personaDraft.name.trim() === ''} className="inline-flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50">
                  {busy === 'persona' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}{zh ? '保存人设' : 'Save persona'}
                </button>
                {editingPersona && <button type="button" onClick={() => { setEditingPersona(null); setPersonaDraft(emptyPersona()); }} className="text-xs text-slate-400 hover:text-slate-200">{zh ? '取消' : 'Cancel'}</button>}
              </div>
            </div>
          )}

          <div className="space-y-2 border-t border-slate-800 pt-3">
            <div className="text-xs font-semibold text-slate-300">{zh ? '账号' : 'Accounts'}</div>
            {accounts.length === 0 && <div className="rounded-lg border border-dashed border-slate-800 px-3 py-4 text-center text-[11px] text-slate-500">{zh ? '还没有账号' : 'No account yet'}</div>}
            {accounts.map((account) => (
              <div key={text(account.id)} className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-slate-200">
                    {text(account.account_name)}
                    <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">{text(account.platform) === 'custom' && text(account.custom_platform) !== '' ? text(account.custom_platform) : text(account.platform)}</span>
                    {account.is_active !== true && <span className="ml-1 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{zh ? '已停用' : 'Disabled'}</span>}
                  </div>
                  <div className="mt-1 text-[10px] text-slate-500">{text(account.persona_name) || `persona #${text(account.persona_id)}`}{text(account.profile_url) !== '' ? ` · ${text(account.profile_url)}` : ''}</div>
                </div>
                {canMutate && (
                  <button
                    type="button"
                    onClick={() => { setEditingAccount(account); setAccountDraft({ persona_id: text(account.persona_id), platform: text(account.platform) || 'custom', custom_platform: text(account.custom_platform), account_name: text(account.account_name), profile_url: text(account.profile_url), notes: text(account.notes) }); }}
                    className="shrink-0 text-[11px] text-slate-300 hover:text-white"
                  >
                    {zh ? '编辑' : 'Edit'}
                  </button>
                )}
              </div>
            ))}
          </div>

          {canMutate && (
            <div className="space-y-2 rounded-xl border border-sky-500/30 bg-slate-950/60 p-3">
              <div className="text-[11px] font-semibold text-slate-300">{editingAccount ? (zh ? `编辑账号 #${text(editingAccount.id)}` : `Edit account #${text(editingAccount.id)}`) : (zh ? '新增账号' : 'New account')}</div>
              {personas.length === 0 ? (
                <div className="text-[11px] text-amber-300">{zh ? '先建一个人设，账号必须挂在人设下' : 'Create a persona first; accounts must belong to one'}</div>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <select value={accountDraft.persona_id} onChange={(event) => setAccountDraft({ ...accountDraft, persona_id: event.target.value })} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white">
                      {personas.map((persona) => <option key={text(persona.id)} value={text(persona.id)}>{text(persona.name)}</option>)}
                    </select>
                    <select value={accountDraft.platform} onChange={(event) => setAccountDraft({ ...accountDraft, platform: event.target.value })} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white">
                      {platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
                    </select>
                    <input value={accountDraft.account_name} onChange={(event) => setAccountDraft({ ...accountDraft, account_name: event.target.value })} placeholder={zh ? '账号名 *' : 'Account name *'} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" />
                    <input value={accountDraft.custom_platform} onChange={(event) => setAccountDraft({ ...accountDraft, custom_platform: event.target.value })} placeholder={zh ? '自定义平台名' : 'Custom platform'} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white" />
                    <input value={accountDraft.profile_url} onChange={(event) => setAccountDraft({ ...accountDraft, profile_url: event.target.value })} placeholder={zh ? '主页链接' : 'Profile URL'} className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-white sm:col-span-2" />
                  </div>
                  <textarea value={accountDraft.notes} onChange={(event) => setAccountDraft({ ...accountDraft, notes: event.target.value })} rows={2} placeholder={zh ? '备注' : 'Notes'} className="w-full rounded-lg border border-slate-700 bg-slate-900 p-2 text-xs text-white" />
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void saveAccount()} disabled={busy === 'account' || accountDraft.account_name.trim() === ''} className="inline-flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50">
                      {busy === 'account' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}{zh ? '保存账号' : 'Save account'}
                    </button>
                    {editingAccount && <button type="button" onClick={() => { setEditingAccount(null); setAccountDraft({ ...emptyAccount(), persona_id: accountDraft.persona_id }); }} className="text-xs text-slate-400 hover:text-slate-200">{zh ? '取消' : 'Cancel'}</button>}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      <div className="flex items-center gap-1.5 text-[10px] text-slate-600">
        <ShieldCheck className="h-3 w-3" />
        {zh ? '仅超级管理员可以维护发布账号与人设' : 'Only super administrators can maintain personas and accounts'}
      </div>
    </section>
  );
};

export default ManualPublicationSettingsPanel;
