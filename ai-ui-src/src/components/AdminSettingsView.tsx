import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Check,
  Clipboard,
  KeyRound,
  RefreshCw,
  Save,
  Shield,
  UserRound,
  XCircle,
} from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';
import { scopeLabel, adminRoleLabel, adminStatusLabel } from '../api/labels';
import PermissionNotice from './PermissionNotice';
import { LoadingState } from './LoadingState';
import BrowserClientsPanel from './BrowserClientsPanel';
import AdminUsersView from './AdminUsersView';
import { PageHeader } from './PageHeader';
import { EmptyState, useConfirm } from './ui';

interface AdminSettingsViewProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  canReadProfile?: boolean;
  canWriteProfile?: boolean;
  /** Called after the server has revoked the current bearer session. */
  onPasswordChanged?: () => void;
  canReadTokens?: boolean;
  canWriteTokens?: boolean;
  canReadAudit?: boolean;
  isSuperAdmin?: boolean;
  /**
   * 合并入口（`TabbedShell`）的内层渲染：不画自己的页面标题与「设置」面包屑，
   * 由外壳统一画——否则会出现「一页两个标题」。
   */
  embedded?: boolean;
  /**
   * 只渲染哪一块（合并入口拆页签用）：
   *   account 账号与安全（管理员账号 / 资料 / 密码 / 已授权的浏览器客户端）
   *   tokens  API Token（创建 + 列表）
   *   audit   管理员活动审计
   * 缺省 `all` 渲染全部——保留整页渲染能力，深链与旧调用点不受影响。
   */
  section?: 'all' | 'account' | 'tokens' | 'audit';
}

type Profile = {
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: string;
  status: string;
  last_login?: string | null;
  created_at?: string | null;
  is_super_admin?: boolean;
};

type TokenRecord = {
  id: number;
  name: string;
  scopes: string[];
  status: string;
  created_at?: string | null;
  last_used_at?: string | null;
  expires_at?: string | null;
  created_by_username?: string;
};

type ActivityLog = {
  id: number;
  admin_username: string;
  admin_role: string;
  action: string;
  request_method: string;
  page: string;
  target_type: string;
  target_id?: number | null;
  ip_address: string;
  details: unknown;
  created_at?: string | null;
};

function asRecord(value: unknown): ApiRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asProfile(value: unknown): Profile {
  const item = asRecord(value);
  return {
    id: asNumber(item.id),
    username: asString(item.username),
    display_name: asString(item.display_name),
    email: asString(item.email),
    role: asString(item.role, 'admin'),
    status: asString(item.status, 'active'),
    last_login: typeof item.last_login === 'string' ? item.last_login : null,
    created_at: typeof item.created_at === 'string' ? item.created_at : null,
    is_super_admin: Boolean(item.is_super_admin),
  };
}

function asToken(value: unknown): TokenRecord {
  const item = asRecord(value);
  return {
    id: asNumber(item.id),
    name: asString(item.name),
    scopes: Array.isArray(item.scopes) ? item.scopes.filter((scope): scope is string => typeof scope === 'string') : [],
    status: asString(item.status, 'active'),
    created_at: typeof item.created_at === 'string' ? item.created_at : null,
    last_used_at: typeof item.last_used_at === 'string' ? item.last_used_at : null,
    expires_at: typeof item.expires_at === 'string' ? item.expires_at : null,
    created_by_username: typeof item.created_by_username === 'string' ? item.created_by_username : undefined,
  };
}

function asActivity(value: unknown): ActivityLog {
  const item = asRecord(value);
  return {
    id: asNumber(item.id),
    admin_username: asString(item.admin_username),
    admin_role: asString(item.admin_role),
    action: asString(item.action),
    request_method: asString(item.request_method),
    page: asString(item.page),
    target_type: asString(item.target_type),
    target_id: item.target_id == null ? null : asNumber(item.target_id),
    ip_address: asString(item.ip_address),
    details: item.details,
    created_at: typeof item.created_at === 'string' ? item.created_at : null,
  };
}

function formatDate(value: string | null | undefined, lang: 'zh' | 'en'): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function makeIdempotencyKey(prefix: string): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

/**
 * Token 列表每页条数。登录一次就铸一个 Token，实测单库能积到 130+ 条，必须分页。
 */
const TOKENS_PER_PAGE = 10;
/** Token 行里 scopes 默认最多显示几个标签，其余折叠成「+N」。 */
const SCOPE_CHIPS_INLINE = 3;

/** Real administrator account, API token and audit controls for the 桐灼GEO shell. */
export const AdminSettingsView: React.FC<AdminSettingsViewProps> = ({
  apiClient,
  lang,
  canReadProfile = true,
  canWriteProfile = true,
  onPasswordChanged,
  canReadTokens = false,
  canWriteTokens = false,
  canReadAudit = false,
  isSuperAdmin = false,
  embedded = false,
  section = 'all',
}) => {
  const showAccount = section === 'all' || section === 'account';
  const showTokens = section === 'all' || section === 'tokens';
  const showAudit = section === 'all' || section === 'audit';
  const [profile, setProfile] = useState<Profile | null>(null);
  const confirmDialog = useConfirm();
  const [profileVersion, setProfileVersion] = useState('');
  const [profileDraft, setProfileDraft] = useState({ display_name: '', email: '' });
  const [passwordDraft, setPasswordDraft] = useState({
    current_password: '',
    password: '',
    password_confirmation: '',
  });
  const [passwordFieldErrors, setPasswordFieldErrors] = useState<Record<string, string>>({});
  const [tokens, setTokens] = useState<TokenRecord[]>([]);
  const [availableScopes, setAvailableScopes] = useState<string[]>([]);
  const [defaultExpiresAt, setDefaultExpiresAt] = useState('');
  const [activity, setActivity] = useState<ActivityLog[]>([]);
  const [activityPagination, setActivityPagination] = useState({ page: 1, total: 0, total_pages: 1 });
  const [activityStats, setActivityStats] = useState({ total_logs: 0, today_logs: 0, active_admins: 0 });
  const [activitySearch, setActivitySearch] = useState('');
  const [activityPage, setActivityPage] = useState(1);
  const [tokenName, setTokenName] = useState('');
  const [tokenScopes, setTokenScopes] = useState<string[]>([]);
  const [tokenExpiresAt, setTokenExpiresAt] = useState('');
  const [newPlaintextToken, setNewPlaintextToken] = useState('');
  const [copied, setCopied] = useState(false);
  const [tokenPage, setTokenPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  const isZh = lang === 'zh';
  // 桐灼GEO accepts both the canonical role and the legacy `superadmin` value.
  // Keep the UI aligned with the server-side Admin::isSuperAdmin() check even
  // when a deployment still contains the historical role spelling.
  const privilegedAdmin = isSuperAdmin || ['super_admin', 'superadmin'].includes(String(profile?.role || '').trim().toLowerCase());
  const hasSecurityRead = privilegedAdmin && canReadTokens;
  const hasAuditRead = privilegedAdmin && canReadAudit;
  const sortedScopes = useMemo(() => [...availableScopes].sort((left, right) => left.localeCompare(right)), [availableScopes]);

  const report = useCallback((error: unknown, fallback: string) => {
    setNotice(describeApiError(error, fallback, lang));
  }, [lang]);

  const loadProfile = useCallback(async () => {
    if (!canReadProfile) return;
    const data = asRecord(await apiClient.getAdminProfile());
    const next = asProfile(data.admin);
    setProfile(next);
    setProfileDraft({ display_name: next.display_name, email: next.email });
    setProfileVersion(asString(data.profile_version));
  }, [apiClient, canReadProfile]);

  const loadSecurity = useCallback(async () => {
    if (!hasSecurityRead) return;
    const data = asRecord(await apiClient.listAdminTokens());
    setTokens(Array.isArray(data.items) ? data.items.map(asToken) : []);
    setAvailableScopes(Array.isArray(data.available_scopes) ? data.available_scopes.filter((scope): scope is string => typeof scope === 'string') : []);
    setDefaultExpiresAt(asString(data.default_expires_at));
  }, [apiClient, hasSecurityRead]);

  const loadAudit = useCallback(async (page = 1, search = '') => {
    if (!hasAuditRead) return;
    const data = asRecord(await apiClient.listAdminActivityLogs({ page, per_page: 20, search: search || undefined }));
    setActivity(Array.isArray(data.items) ? data.items.map(asActivity) : []);
    const pagination = asRecord(data.pagination);
    setActivityPagination({
      page: asNumber(pagination.page, page),
      total: asNumber(pagination.total),
      total_pages: Math.max(1, asNumber(pagination.total_pages, 1)),
    });
    const stats = asRecord(data.stats);
    setActivityStats({ total_logs: asNumber(stats.total_logs), today_logs: asNumber(stats.today_logs), active_admins: asNumber(stats.active_admins) });
  }, [apiClient, hasAuditRead]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setNotice('');
    try {
      // 合并入口拆页签后，只拉当前这块需要的接口——别为一个只读审计的页面
      // 顺手把 Token 列表也拉回来（132 条的那个接口就是这么被拖慢的）。
      await Promise.all([
        showAccount ? loadProfile() : Promise.resolve(),
        showTokens ? loadSecurity() : Promise.resolve(),
        showAudit ? loadAudit(1) : Promise.resolve(),
      ]);
      setActivityPage(1);
    } catch (error) {
      report(error, isZh ? '无法读取管理员设置' : 'Unable to load administrator settings');
    } finally {
      setLoading(false);
    }
  }, [isZh, loadAudit, loadProfile, loadSecurity, report, showAccount, showAudit, showTokens]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const refreshButton = (
    <button
      type="button"
      onClick={() => void loadAll()}
      disabled={loading}
      className="flex h-9 items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
      {isZh ? '刷新' : 'Refresh'}
    </button>
  );

  const saveProfile = async () => {
    if (!profileVersion) return;
    setBusy('profile'); setNotice('');
    try {
      const data = asRecord(await apiClient.updateAdminProfile({ ...profileDraft, profile_version: profileVersion }, { idempotencyKey: makeIdempotencyKey('profile') }));
      const next = asProfile(data.admin);
      setProfile(next); setProfileDraft({ display_name: next.display_name, email: next.email }); setProfileVersion(asString(data.profile_version));
      setNotice(isZh ? '个人资料已保存' : 'Profile saved');
    } catch (error) { report(error, isZh ? '资料保存失败' : 'Unable to save profile'); }
    finally { setBusy(''); }
  };

  const updatePassword = async () => {
    if (!canWriteProfile) return;
    const fieldErrors: Record<string, string> = {};
    if (!passwordDraft.current_password) {
      fieldErrors.current_password = isZh ? '请输入当前密码' : 'Enter your current password';
    }
    if (!passwordDraft.password) {
      fieldErrors.password = isZh ? '请输入新密码' : 'Enter a new password';
    } else if (passwordDraft.password.length < 8) {
      fieldErrors.password = isZh ? '新密码至少需要 8 位' : 'The new password must be at least 8 characters';
    }
    if (!passwordDraft.password_confirmation) {
      fieldErrors.password_confirmation = isZh ? '请再次输入新密码' : 'Confirm the new password';
    } else if (passwordDraft.password !== passwordDraft.password_confirmation) {
      fieldErrors.password_confirmation = isZh ? '两次输入的新密码不一致' : 'The passwords do not match';
    }
    setPasswordFieldErrors(fieldErrors);
    if (Object.keys(fieldErrors).length > 0) return;

    setBusy('password');
    setNotice('');
    try {
      await apiClient.updateAdminPassword({ ...passwordDraft }, { idempotencyKey: makeIdempotencyKey('password') });
      setPasswordDraft({ current_password: '', password: '', password_confirmation: '' });
      setPasswordFieldErrors({});
      // A successful password change revokes the bearer token server-side.
      // Let App clear its session and return to the login screen immediately.
      onPasswordChanged?.();
    } catch (error) {
      const details = error instanceof Error && 'details' in error
        ? (error as { details?: unknown }).details
        : undefined;
      const rawFieldErrors = details && typeof details === 'object' && !Array.isArray(details)
        ? (details as { field_errors?: unknown }).field_errors
        : undefined;
      if (rawFieldErrors && typeof rawFieldErrors === 'object' && !Array.isArray(rawFieldErrors)) {
        const normalized = Object.fromEntries(
          Object.entries(rawFieldErrors)
            .filter(([, value]) => typeof value === 'string')
            .map(([key, value]) => [key, String(value)]),
        );
        setPasswordFieldErrors(normalized);
      }
      report(error, isZh ? '密码修改失败' : 'Unable to change password');
    } finally {
      setBusy('');
    }
  };

  const createToken = async () => {
    if (!tokenName.trim() || tokenScopes.length === 0) {
      setNotice(isZh ? '请填写 Token 名称并至少选择一个权限' : 'Enter a name and select at least one scope');
      return;
    }
    setBusy('token-create'); setNotice(''); setNewPlaintextToken('');
    try {
      const payload: ApiRecord = { name: tokenName.trim(), scopes: tokenScopes };
      if (tokenExpiresAt) payload.expires_at = new Date(tokenExpiresAt).toISOString();
      const data = asRecord(await apiClient.createAdminToken(payload, { idempotencyKey: makeIdempotencyKey('token') }));
      setNewPlaintextToken(asString(data.token));
      setTokenName(''); setTokenScopes([]); setTokenExpiresAt('');
      await loadSecurity();
      setNotice(isZh ? 'Token 已创建；明文只显示这一次，请立即复制保存。' : 'Token created; copy the plaintext now because it is shown only once.');
    } catch (error) { report(error, isZh ? 'Token 创建失败' : 'Unable to create token'); }
    finally { setBusy(''); }
  };

  const revokeToken = async (token: TokenRecord) => {
    // 用 ConfirmDialog 而不是 window.confirm：原生 confirm 在部分内嵌浏览器里不渲染，
    // 1ms 返回 false，表现成「点了撤销没反应」。
    if (!(await confirmDialog({
      title: isZh ? `撤销「${token.name}」？` : `Revoke "${token.name}"?`,
      description: isZh ? '此操作不可恢复，用该令牌的集成会立即失效。' : 'This cannot be undone; integrations using this token stop working immediately.',
      confirmLabel: isZh ? '撤销' : 'Revoke',
      tone: 'danger',
    }))) return;
    setBusy(`revoke-${token.id}`); setNotice('');
    try {
      await apiClient.revokeAdminToken(token.id, { idempotencyKey: makeIdempotencyKey(`revoke-${token.id}`) });
      await loadSecurity();
      setNotice(isZh ? 'Token 已撤销' : 'Token revoked');
    } catch (error) { report(error, isZh ? 'Token 撤销失败' : 'Unable to revoke token'); }
    finally { setBusy(''); }
  };

  const copyToken = async () => {
    if (!newPlaintextToken) return;
    try {
      await navigator.clipboard.writeText(newPlaintextToken);
      setCopied(true); window.setTimeout(() => setCopied(false), 1600);
    } catch { setNotice(isZh ? '复制失败，请手动复制明文 Token' : 'Copy failed; copy the token manually'); }
  };

  const searchAudit = async () => {
    setActivityPage(1); setBusy('audit');
    try { await loadAudit(1, activitySearch); } catch (error) { report(error, isZh ? '审计日志读取失败' : 'Unable to load audit logs'); }
    finally { setBusy(''); }
  };

  const changeAuditPage = async (page: number) => {
    const next = Math.max(1, Math.min(activityPagination.total_pages, page));
    setActivityPage(next); setBusy('audit');
    try { await loadAudit(next, activitySearch); } catch (error) { report(error, isZh ? '审计日志读取失败' : 'Unable to load audit logs'); }
    finally { setBusy(''); }
  };

  return (
    <div className="space-y-8">
      {embedded ? (
        // 合并入口内层：外壳已经画了标题，这里只留一条右对齐的工具行（刷新）。
        <div className="flex justify-end">
          {refreshButton}
        </div>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader
            icon={Shield}
            group={isZh ? '设置' : 'Settings'}
            title={isZh ? '系统设置' : 'Settings'}
            description={isZh ? '账号资料、API 凭据与操作审计——都是这个部署实例自己的。' : 'Profile, API credentials and audit trail for this deployment.'}
          />
          <div className="flex flex-wrap gap-2">{refreshButton}</div>
        </div>
      )}
      {notice && <div role="status" className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-4 py-2.5 text-[13px] text-indigo-200">{notice}</div>}

      {showAccount && privilegedAdmin && <AdminUsersView apiClient={apiClient} lang={lang} canRead={canReadProfile} canWrite={canWriteProfile} />}

      {showAccount && <section className="rounded-2xl bg-slate-900/80 p-5">
        <div className="mb-4 flex items-center gap-2"><UserRound className="h-4 w-4 text-indigo-400" /><h2 className="text-section-title">{isZh ? '管理员资料' : 'Administrator profile'}</h2></div>
        {!canReadProfile ? <PermissionNotice lang={lang} mode="read" requiredScope="account:read" /> : loading && !profile ? <LoadingState lang={lang} variant="panel" label={isZh ? '正在读取管理员资料…' : 'Loading administrator profile…'} /> : <div className="grid max-w-3xl grid-cols-1 gap-4 md:grid-cols-2">
          <label className="text-[13px] text-slate-400">{isZh ? '用户名（不可修改）' : 'Username (read-only)'}<input value={profile?.username || ''} readOnly className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-slate-500" /></label>
          <label className="text-[13px] text-slate-400">{isZh ? '角色' : 'Role'}<input value={adminRoleLabel(profile?.role, lang)} readOnly className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-slate-500" /></label>
          <label className="text-[13px] text-slate-400">{isZh ? '显示名称' : 'Display name'}<input value={profileDraft.display_name} disabled={!canWriteProfile} onChange={(event) => setProfileDraft((draft) => ({ ...draft, display_name: event.target.value }))} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500 disabled:opacity-50" /></label>
          <label className="text-[13px] text-slate-400">Email<input type="email" value={profileDraft.email} disabled={!canWriteProfile} onChange={(event) => setProfileDraft((draft) => ({ ...draft, email: event.target.value }))} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500 disabled:opacity-50" /></label>
          <div className="text-[12.5px] text-slate-500">{isZh ? '上次登录' : 'Last login'}：{formatDate(profile?.last_login, lang)}</div>
          <div className="text-[12.5px] text-slate-500">{isZh ? '账户状态' : 'Status'}：<span className={profile?.status === 'active' ? 'text-emerald-300' : 'text-rose-300'}>{adminStatusLabel(profile?.status, lang)}</span></div>
          {!canWriteProfile && <PermissionNotice lang={lang} requiredScope="account:write" className="md:col-span-2" />}
          {canWriteProfile && <div className="md:col-span-2"><button type="button" onClick={() => void saveProfile()} disabled={busy === 'profile'} className="flex h-9 items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white hover:bg-indigo-500 disabled:opacity-50"><Save className="h-3.5 w-3.5" />{busy === 'profile' ? '…' : (isZh ? '保存资料' : 'Save profile')}</button></div>}
        </div>}
      </section>}

      {showAccount && <section className="rounded-2xl bg-slate-900/80 p-5">
        <div className="mb-2 flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-rose-400" />
          <h2 className="text-section-title">{isZh ? '修改登录密码' : 'Change sign-in password'}</h2>
        </div>
        <p className="mb-4 text-[13px] text-slate-500">
          {isZh
            ? '修改成功后，当前浏览器和其他设备上的 API Token 会立即失效，需要重新登录。'
            : 'Changing the password revokes API tokens on every device; you will need to sign in again.'}
        </p>
        {!canWriteProfile ? <PermissionNotice lang={lang} requiredScope="account:write" /> : (
          <form
            className="grid max-w-3xl grid-cols-1 gap-4 md:grid-cols-2"
            onSubmit={(event) => { event.preventDefault(); void updatePassword(); }}
            noValidate
          >
            <label className="text-[13px] text-slate-400 md:col-span-2">
              {isZh ? '当前密码' : 'Current password'}
              <input
                type="password"
                autoComplete="current-password"
                value={passwordDraft.current_password}
                disabled={busy === 'password'}
                onChange={(event) => setPasswordDraft((draft) => ({ ...draft, current_password: event.target.value }))}
                className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500 disabled:opacity-50"
              />
              {passwordFieldErrors.current_password && <span className="mt-1 block text-[12.5px] text-rose-300">{passwordFieldErrors.current_password}</span>}
            </label>
            <label className="text-[13px] text-slate-400">
              {isZh ? '新密码（至少 8 位）' : 'New password (8+ characters)'}
              <input
                type="password"
                autoComplete="new-password"
                value={passwordDraft.password}
                disabled={busy === 'password'}
                onChange={(event) => setPasswordDraft((draft) => ({ ...draft, password: event.target.value }))}
                className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500 disabled:opacity-50"
              />
              {passwordFieldErrors.password && <span className="mt-1 block text-[12.5px] text-rose-300">{passwordFieldErrors.password}</span>}
            </label>
            <label className="text-[13px] text-slate-400">
              {isZh ? '确认新密码' : 'Confirm new password'}
              <input
                type="password"
                autoComplete="new-password"
                value={passwordDraft.password_confirmation}
                disabled={busy === 'password'}
                onChange={(event) => setPasswordDraft((draft) => ({ ...draft, password_confirmation: event.target.value }))}
                className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500 disabled:opacity-50"
              />
              {passwordFieldErrors.password_confirmation && <span className="mt-1 block text-[12.5px] text-rose-300">{passwordFieldErrors.password_confirmation}</span>}
            </label>
            <div className="md:col-span-2">
              <button type="submit" disabled={busy === 'password'} className="flex h-9 items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white hover:bg-indigo-500 disabled:opacity-50">
                <Save className="h-3.5 w-3.5" />
                {busy === 'password' ? '…' : (isZh ? '修改密码并重新登录' : 'Change password and sign in again')}
              </button>
            </div>
          </form>
        )}
      </section>}

      {showTokens && <section className="rounded-2xl bg-slate-900/80 p-5">
        <div className="mb-4 flex items-center gap-2"><KeyRound className="h-4 w-4 text-amber-400" /><h2 className="text-section-title">{isZh ? 'API Token' : 'API tokens'}</h2><span className="text-caption">{isZh ? '明文只在创建响应中出现一次' : 'Plaintext is shown only once'}</span></div>
        {!hasSecurityRead ? <PermissionNotice lang={lang} mode="read" requiredScope="tokens:read" /> : <div className="space-y-5">
          {newPlaintextToken && <div className="rounded-xl border border-amber-500/40 bg-amber-950/20 p-3"><div className="mb-2 flex items-center justify-between text-[13px] font-semibold text-amber-200"><span>{isZh ? '新 Token 明文（请立即保存）' : 'New plaintext token (save it now)'}</span><button type="button" onClick={() => void copyToken()} className="flex h-8 items-center gap-1 rounded-lg border border-amber-500/40 px-2 text-[12.5px] text-amber-200 hover:bg-amber-900/40">{copied ? <Check className="h-3 w-3" /> : <Clipboard className="h-3 w-3" />}{copied ? (isZh ? '已复制' : 'Copied') : (isZh ? '复制' : 'Copy')}</button></div><code className="block break-all rounded-xl bg-slate-950/60 p-3 text-[12.5px] text-amber-100">{newPlaintextToken}</code></div>}
          {canWriteTokens && <div className="grid grid-cols-1 gap-3 rounded-xl bg-slate-950/40 px-4 py-3 md:grid-cols-12"><label className="text-[13px] text-slate-400 md:col-span-4">{isZh ? '名称' : 'Name'}<input value={tokenName} onChange={(event) => setTokenName(event.target.value)} placeholder={isZh ? '例如：部署同步' : 'e.g. deployment-sync'} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" /></label><label className="text-[13px] text-slate-400 md:col-span-3">{isZh ? '过期时间（可选）' : 'Expires (optional)'}<input type="datetime-local" value={tokenExpiresAt} onChange={(event) => setTokenExpiresAt(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" /></label><div className="md:col-span-5"><div className="mb-1 text-[13px] text-slate-400">{isZh ? '权限' : 'Scopes'}</div><div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">{sortedScopes.map((scope) => <label key={scope} className={`cursor-pointer rounded-lg border px-2.5 py-1 text-[12.5px] ${tokenScopes.includes(scope) ? 'border-indigo-500/60 bg-indigo-500/20 text-indigo-200' : 'border-slate-700 text-slate-400'}`}><input type="checkbox" className="sr-only" checked={tokenScopes.includes(scope)} onChange={() => setTokenScopes((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope])} />{scopeLabel(scope)}</label>)}</div></div><div className="md:col-span-12"><button type="button" onClick={() => void createToken()} disabled={busy === 'token-create'} className="h-9 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white hover:bg-indigo-500 disabled:opacity-50">{busy === 'token-create' ? '…' : (isZh ? '创建 Token' : 'Create token')}</button>{defaultExpiresAt && <span className="ml-3 text-[12.5px] text-slate-500">{isZh ? `默认过期：${formatDate(defaultExpiresAt, lang)}` : `Default expiry: ${formatDate(defaultExpiresAt, lang)}`}</span>}</div></div>}
          {!canWriteTokens && <PermissionNotice lang={lang} requiredScope="tokens:write" />}
          <TokenTable
            tokens={tokens}
            lang={lang}
            page={tokenPage}
            onPageChange={setTokenPage}
            loading={loading}
            canWrite={canWriteTokens}
            busy={busy}
            onRevoke={revokeToken}
          />
        </div>}
      </section>}

      {showAudit && <section className="rounded-2xl bg-slate-900/80 p-5">
        <div className="mb-4 flex items-center gap-2"><Activity className="h-4 w-4 text-emerald-400" /><h2 className="text-section-title">{isZh ? '管理员活动审计' : 'Administrator activity audit'}</h2></div>
        {!hasAuditRead ? <PermissionNotice lang={lang} mode="read" requiredScope="audit:read" /> : <div className="space-y-4">
          <div className="flex flex-wrap gap-2"><input value={activitySearch} onChange={(event) => setActivitySearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void searchAudit(); }} placeholder={isZh ? '搜索管理员、动作或页面' : 'Search admin, action or page'} className="h-10 min-w-[240px] flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" /><button type="button" onClick={() => void searchAudit()} disabled={busy === 'audit'} className="h-9 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40">{isZh ? '筛选' : 'Filter'}</button></div>
          <div className="grid grid-cols-3 gap-2"><div className="rounded-xl bg-slate-950/40 px-4 py-3"><div className="text-[12.5px] text-slate-400">{isZh ? '日志总数' : 'Total logs'}</div><div className="mt-1.5 text-[19px] font-black leading-none tabular-nums text-white">{activityStats.total_logs}</div></div><div className="rounded-xl bg-slate-950/40 px-4 py-3"><div className="text-[12.5px] text-slate-400">{isZh ? '今日' : 'Today'}</div><div className="mt-1.5 text-[19px] font-black leading-none tabular-nums text-white">{activityStats.today_logs}</div></div><div className="rounded-xl bg-slate-950/40 px-4 py-3"><div className="text-[12.5px] text-slate-400">{isZh ? '近 7 天管理员' : 'Active admins (7d)'}</div><div className="mt-1.5 text-[19px] font-black leading-none tabular-nums text-white">{activityStats.active_admins}</div></div></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[13px] text-slate-300"><thead className="border-b border-slate-800 bg-slate-800/40 text-[12.5px] font-semibold text-slate-400"><tr><th className="px-3 py-3.5">{isZh ? '时间' : 'Time'}</th><th className="px-3 py-3.5">{isZh ? '管理员' : 'Admin'}</th><th className="px-3 py-3.5">{isZh ? '动作' : 'Action'}</th><th className="px-3 py-3.5">{isZh ? '页面/目标' : 'Page / target'}</th><th className="px-3 py-3.5">IP</th><th className="px-3 py-3.5">{isZh ? '详情' : 'Details'}</th></tr></thead><tbody className="divide-y divide-slate-800/60">{activity.map((log) => <tr key={log.id} className="hover:bg-slate-800/40"><td className="whitespace-nowrap px-3 py-4 text-slate-400">{formatDate(log.created_at, lang)}</td><td className="px-3 py-4 text-slate-100">{log.admin_username}<div className="text-[12.5px] text-slate-500">{adminRoleLabel(log.admin_role, lang)}</div></td><td className="whitespace-nowrap px-3 py-4 font-mono text-emerald-300">{log.request_method} {log.action}</td><td className="px-3 py-4 text-slate-400">{log.page || '—'}{log.target_type && <div className="text-[12.5px] text-slate-500">{log.target_type}#{log.target_id || '—'}</div>}</td><td className="whitespace-nowrap px-3 py-4 text-slate-500">{log.ip_address || '—'}</td><td className="max-w-[260px] px-3 py-4 text-slate-400"><code className="line-clamp-2 break-all">{typeof log.details === 'string' ? log.details : JSON.stringify(log.details || {})}</code></td></tr>)}{activity.length === 0 && <tr><td colSpan={6}>{loading ? <div className="py-6"><LoadingState lang={lang} variant="inline" label={isZh ? '正在读取审计记录…' : 'Loading audit records…'} /></div> : <EmptyState compact icon={Activity} title={isZh ? '暂无审计记录' : 'No audit records'} description={isZh ? '管理员做过的操作会记录在这里；换个关键词或时间范围试试。' : 'Admin actions are recorded here; try another keyword or range.'} />}</td></tr>}</tbody></table></div>
          <div className="flex items-center justify-between text-[12.5px] text-slate-500"><span>{isZh ? `共 ${activityPagination.total} 条` : `${activityPagination.total} records`}</span><div className="flex gap-2"><button type="button" onClick={() => void changeAuditPage(activityPage - 1)} disabled={activityPage <= 1 || busy === 'audit'} className="h-8 rounded-lg border border-slate-700 px-2.5 font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40">‹</button><span className="px-2 py-1">{activityPage} / {activityPagination.total_pages}</span><button type="button" onClick={() => void changeAuditPage(activityPage + 1)} disabled={activityPage >= activityPagination.total_pages || busy === 'audit'} className="h-8 rounded-lg border border-slate-700 px-2.5 font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40">›</button></div></div>
        </div>}
      </section>}

      {/* 插件设备授权——与个人 API Token 分开的一块 */}
      {showAccount && <BrowserClientsPanel apiClient={apiClient} lang={lang} canRead={canReadTokens} canWrite={canWriteTokens} />}
    </div>
  );
};

/**
 * API Token 列表：分页 + 权限折叠。
 *
 * 为什么必须这么做：后端 `ApiAdminAuthService::login()` **每次登录都铸一个新的
 * 「CLI Login <user> <时间>」全权限 Token 且从不回收**，实测半个月的部署已积到 130+ 条。
 * 原来这一格把每个 Token 的 30 个 scope 逗号拼成一整串塞进 `max-w-[260px]`，
 * 一行要换 5~6 行文字 —— 整块高 **33,007px，占「系统设置」页的 84%**。
 * 现在每行最多 3 个权限标签 + 「+N」，点开才展开；配上每页 10 条，
 * 整页从 39,172px 降到 4 千出头。
 */
const TokenTable: React.FC<{
  tokens: TokenRecord[];
  lang: 'zh' | 'en';
  page: number;
  onPageChange: (page: number) => void;
  loading: boolean;
  canWrite: boolean;
  busy: string;
  onRevoke: (token: TokenRecord) => void;
}> = ({ tokens, lang, page, onPageChange, loading, canWrite, busy, onRevoke }) => {
  const isZh = lang === 'zh';
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const pageCount = Math.max(1, Math.ceil(tokens.length / TOKENS_PER_PAGE));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const visible = tokens.slice((safePage - 1) * TOKENS_PER_PAGE, safePage * TOKENS_PER_PAGE);
  const usable = tokens.filter((token) => token.status !== 'expired' && token.status !== 'revoked').length;
  const statusLabel = (status: string) => status === 'expired' ? (isZh ? '已过期' : 'Expired')
    : status === 'revoked' ? (isZh ? '已撤销' : 'Revoked')
      : (isZh ? '有效' : 'Active');

  return (
    <div className="space-y-3">
      {tokens.length > 0 && (
        <p className="text-caption">
          {isZh
            ? `共 ${tokens.length} 个，其中有效 ${usable} 个。每次在浏览器里登录后台都会自动签发一个「CLI Login …」，用不到的可以撤销。`
            : `${tokens.length} tokens, ${usable} usable. Signing in to the admin mints one "CLI Login …" token each time; revoke the ones you no longer need.`}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-[13px] text-slate-300">
          <thead className="border-b border-slate-800 bg-slate-800/40 text-[12.5px] font-semibold text-slate-400">
            <tr>
              <th className="px-3 py-3.5">{isZh ? '名称' : 'Name'}</th>
              <th className="px-3 py-3.5">{isZh ? '权限' : 'Scopes'}</th>
              <th className="px-3 py-3.5">{isZh ? '创建时间' : 'Created'}</th>
              <th className="px-3 py-3.5">{isZh ? '过期时间' : 'Expires'}</th>
              <th className="px-3 py-3.5 text-right">{isZh ? '操作' : 'Actions'}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {visible.map((token) => {
              const expanded = expandedId === token.id;
              const shown = expanded ? token.scopes : token.scopes.slice(0, SCOPE_CHIPS_INLINE);
              const hidden = token.scopes.length - shown.length;
              return (
                <tr key={token.id} className="align-top hover:bg-slate-800/40">
                  <td className="px-3 py-3 font-semibold text-slate-100">
                    {/* 不截断：这些 Token 名字共享长前缀（`CLI Login admin 2026-09-25 …`），
                        截断会把唯一能区分它们的时间戳切掉，十行看起来一模一样。 */}
                    <span className="block max-w-[240px] break-words" title={token.name}>{token.name}</span>
                    <span className="text-[12.5px] font-normal text-slate-500">#{token.id} · {statusLabel(token.status)}</span>
                  </td>
                  <td className="px-3 py-3">
                    {token.scopes.length === 0 ? <span className="text-slate-500">—</span> : (
                      <div className="flex flex-wrap items-center gap-1">
                        {shown.map((scope) => (
                          <span key={scope} className="rounded-md bg-slate-800/70 px-1.5 py-0.5 text-[12px] text-slate-300">{scopeLabel(scope)}</span>
                        ))}
                        {token.scopes.length > SCOPE_CHIPS_INLINE && (
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => setExpandedId(expanded ? null : token.id)}
                            className="rounded-md border border-slate-700 px-1.5 py-0.5 text-[12px] font-semibold text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
                          >
                            {expanded ? (isZh ? '收起' : 'Less') : `+${hidden}`}
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-400">{formatDate(token.created_at, lang)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-slate-400">{formatDate(token.expires_at, lang)}</td>
                  <td className="px-3 py-3 text-right">
                    {canWrite && (
                      <button
                        type="button"
                        onClick={() => onRevoke(token)}
                        disabled={busy === `revoke-${token.id}` || token.status === 'revoked'}
                        title={isZh ? '撤销 Token' : 'Revoke token'}
                        aria-label={isZh ? '撤销 Token' : 'Revoke token'}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-rose-500/10 hover:text-rose-400 disabled:opacity-40"
                      >
                        <XCircle className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {tokens.length === 0 && <tr><td colSpan={5}>{loading ? <div className="py-6"><LoadingState lang={lang} variant="inline" label={isZh ? '正在读取 API Token…' : 'Loading API tokens…'} /></div> : <EmptyState compact icon={KeyRound} title={isZh ? '暂无 API Token' : 'No API tokens'} description={isZh ? '创建一个 Token 后即可在脚本或插件里调用 API。' : 'Create a token to call the API from scripts or plugins.'} />}</td></tr>}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div className="flex items-center justify-between text-[12.5px] text-slate-500">
          <span>{isZh ? `第 ${safePage} / ${pageCount} 页` : `Page ${safePage} of ${pageCount}`}</span>
          <div className="flex gap-2">
            <button type="button" onClick={() => onPageChange(safePage - 1)} disabled={safePage <= 1} aria-label={isZh ? '上一页' : 'Previous page'} className="h-8 rounded-lg border border-slate-700 px-2.5 font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40">‹</button>
            <button type="button" onClick={() => onPageChange(safePage + 1)} disabled={safePage >= pageCount} aria-label={isZh ? '下一页' : 'Next page'} className="h-8 rounded-lg border border-slate-700 px-2.5 font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40">›</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminSettingsView;
