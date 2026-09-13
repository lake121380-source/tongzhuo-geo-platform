import React, { useEffect, useMemo, useState } from 'react';
import { Edit3, Loader2, Plus, RefreshCw, Shield, Trash2, UserRound, X } from 'lucide-react';
import { ApiRecord, GeoFlowApiClient } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';
import PermissionNotice from './PermissionNotice';
import { LoadingState } from './LoadingState';

type AdminUser = {
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: string;
  status: string;
  is_super_admin: boolean;
  last_login: string | null;
  created_at: string | null;
  creator_username: string;
  ai_config_mode: string;
  shared_ai_config_owner_id: number | null;
  shared_provider_name: string;
  shared_provider_status: string;
  ai_config_access_version: number;
  activity_count: number;
};

interface AdminUsersViewProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  canRead: boolean;
  canWrite: boolean;
}

type UserForm = {
  username: string;
  display_name: string;
  email: string;
  password: string;
  confirm_password: string;
  status: 'active' | 'inactive';
  ai_config_mode: 'independent' | 'shared_current_super';
};

const emptyForm: UserForm = {
  username: '', display_name: '', email: '', password: '', confirm_password: '',
  status: 'active', ai_config_mode: 'independent',
};

function record(value: unknown): ApiRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {};
}

function asUser(value: unknown): AdminUser {
  const item = record(value);
  return {
    id: Number(item.id) || 0,
    username: String(item.username ?? ''),
    display_name: String(item.display_name ?? ''),
    email: String(item.email ?? ''),
    role: String(item.role ?? 'admin'),
    status: String(item.status ?? 'active'),
    is_super_admin: Boolean(item.is_super_admin),
    last_login: typeof item.last_login === 'string' ? item.last_login : null,
    created_at: typeof item.created_at === 'string' ? item.created_at : null,
    creator_username: String(item.creator_username ?? ''),
    ai_config_mode: String(item.ai_config_mode ?? 'independent') as AdminUser['ai_config_mode'],
    shared_ai_config_owner_id: item.shared_ai_config_owner_id == null ? null : Number(item.shared_ai_config_owner_id),
    shared_provider_name: String(item.shared_provider_name ?? ''),
    shared_provider_status: String(item.shared_provider_status ?? ''),
    ai_config_access_version: Math.max(1, Number(item.ai_config_access_version) || 1),
    activity_count: Number(item.activity_count) || 0,
  };
}

function idempotencyKey(prefix: string): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

function formatDate(value: string | null, lang: 'zh' | 'en'): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export const AdminUsersView: React.FC<AdminUsersViewProps> = ({ apiClient, lang, canRead, canWrite }) => {
  const isZh = lang === 'zh';
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [stats, setStats] = useState({ total_admins: 0, active_admins: 0, super_admins: 0 });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<UserForm>(emptyForm);

  const sortedUsers = useMemo(() => [...users].sort((left, right) => Number(right.is_super_admin) - Number(left.is_super_admin) || left.username.localeCompare(right.username)), [users]);

  const loadUsers = async () => {
    if (!canRead) return;
    setLoading(true); setError('');
    try {
      const result = record(await apiClient.listAdminUsers());
      setUsers(Array.isArray(result.items) ? result.items.map(asUser) : []);
      const nextStats = record(result.stats);
      setStats({ total_admins: Number(nextStats.total_admins) || 0, active_admins: Number(nextStats.active_admins) || 0, super_admins: Number(nextStats.super_admins) || 0 });
    } catch (loadError) {
      setError(describeApiError(loadError, isZh ? '管理员列表加载失败' : 'Unable to load administrators', lang));
    } finally { setLoading(false); }
  };

  useEffect(() => { void loadUsers(); }, [apiClient, canRead]);

  const openCreate = () => { setEditing(null); setForm({ ...emptyForm }); setFormOpen(true); setNotice(''); };
  const openEdit = (user: AdminUser) => {
    setEditing(user);
    setForm({
      username: user.username, display_name: user.display_name, email: user.email,
      password: '', confirm_password: '', status: user.status === 'inactive' ? 'inactive' : 'active',
      ai_config_mode: user.ai_config_mode === 'shared' ? 'shared_current_super' : 'independent',
    });
    setFormOpen(true); setNotice('');
  };
  const setField = <K extends keyof UserForm>(key: K, value: UserForm[K]) => setForm((current) => ({ ...current, [key]: value }));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canWrite) return;
    if (!form.username.trim()) { setNotice(isZh ? '用户名不能为空' : 'Username is required'); return; }
    if (!editing && (!form.password || form.password !== form.confirm_password)) { setNotice(isZh ? '请填写匹配的初始密码' : 'Enter matching initial passwords'); return; }
    if (editing && form.password && form.password !== form.confirm_password) { setNotice(isZh ? '两次密码不一致' : 'Passwords do not match'); return; }
    setBusy('save'); setNotice('');
    try {
      let result: ApiRecord;
      if (!editing) {
        result = await apiClient.createAdminUser({
          username: form.username.trim(), display_name: form.display_name.trim(), email: form.email.trim() || null,
          password: form.password, confirm_password: form.confirm_password, ai_config_mode: form.ai_config_mode,
        }, { idempotencyKey: idempotencyKey('admin-create') });
      } else {
        const payload: ApiRecord = {
          username: form.username.trim(), display_name: form.display_name.trim(), email: form.email.trim() || null,
          status: form.status, ai_config_mode: form.ai_config_mode,
          expected_ai_config_access_version: editing.ai_config_access_version,
          expected_shared_ai_config_owner_id: editing.shared_ai_config_owner_id,
        };
        if (form.password) { payload.password = form.password; payload.confirm_password = form.confirm_password; }
        result = await apiClient.updateAdminUser(editing.id, payload, { idempotencyKey: idempotencyKey('admin-update') });
      }
      const next = asUser(record(result).admin);
      setUsers((current) => editing ? current.map((item) => item.id === next.id ? next : item) : [next, ...current]);
      setFormOpen(false); setEditing(null);
      setNotice(isZh ? (editing ? '管理员已更新' : '管理员已创建') : (editing ? 'Administrator updated' : 'Administrator created'));
      await loadUsers();
    } catch (saveError) {
      setNotice(describeApiError(saveError, isZh ? '管理员保存失败' : 'Unable to save administrator', lang));
    } finally { setBusy(''); }
  };

  const toggleStatus = async (user: AdminUser) => {
    if (!canWrite || user.is_super_admin) return;
    const nextStatus = user.status === 'active' ? 'inactive' : 'active';
    setBusy(`status-${user.id}`); setNotice('');
    try {
      const result = record(await apiClient.toggleAdminUserStatus(user.id, nextStatus, { idempotencyKey: idempotencyKey(`admin-status-${user.id}`) }));
      const next = asUser(result.admin);
      setUsers((current) => current.map((item) => item.id === next.id ? next : item));
      setNotice(isZh ? '管理员状态已更新' : 'Administrator status updated');
    } catch (statusError) { setNotice(describeApiError(statusError, isZh ? '状态更新失败' : 'Unable to update status', lang)); }
    finally { setBusy(''); }
  };

  const remove = async (user: AdminUser) => {
    if (!canWrite || user.is_super_admin) return;
    if (!window.confirm(isZh ? `确定删除管理员「${user.username}」吗？` : `Delete administrator “${user.username}”?`)) return;
    setBusy(`delete-${user.id}`); setNotice('');
    try {
      await apiClient.deleteAdminUser(user.id, { idempotencyKey: idempotencyKey(`admin-delete-${user.id}`) });
      setUsers((current) => current.filter((item) => item.id !== user.id));
      setNotice(isZh ? '管理员已删除' : 'Administrator deleted');
      await loadUsers();
    } catch (deleteError) { setNotice(describeApiError(deleteError, isZh ? '管理员删除失败' : 'Unable to delete administrator', lang)); }
    finally { setBusy(''); }
  };

  if (!canRead) return <PermissionNotice lang={lang} mode="read" requiredScope="account:read" />;

  return (
    <section className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/80 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold text-white"><UserRound className="h-4 w-4 text-indigo-400" />{isZh ? '管理员账号' : 'Administrator accounts'}</h2>
          <p className="mt-1 text-xs text-slate-500">{isZh ? '管理 桐灼GEO 部署中的管理员账号、状态和 AI 配置归属。' : 'Manage administrator accounts, status and AI configuration ownership.'}</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void loadUsers()} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-200 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />{isZh ? '刷新' : 'Refresh'}</button>
          {canWrite && <button type="button" onClick={openCreate} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white"><Plus className="h-3.5 w-3.5" />{isZh ? '新增管理员' : 'New administrator'}</button>}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs"><div className="rounded-lg bg-slate-950 p-3"><span className="text-slate-500">{isZh ? '账号总数' : 'Total'}</span><strong className="mt-1 block text-lg text-white">{stats.total_admins}</strong></div><div className="rounded-lg bg-slate-950 p-3"><span className="text-slate-500">{isZh ? '已启用' : 'Active'}</span><strong className="mt-1 block text-lg text-emerald-300">{stats.active_admins}</strong></div><div className="rounded-lg bg-slate-950 p-3"><span className="text-slate-500">{isZh ? '超级管理员' : 'Super admins'}</span><strong className="mt-1 block text-lg text-amber-200">{stats.super_admins}</strong></div></div>
      {error && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{error}</div>}
      {notice && <div role="status" className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-200">{notice}</div>}

      {formOpen && <form onSubmit={(event) => void save(event)} className="grid grid-cols-1 gap-3 rounded-xl border border-indigo-500/30 bg-indigo-950/20 p-4 md:grid-cols-2">
        <div className="flex items-center justify-between md:col-span-2"><h3 className="text-xs font-semibold text-white">{editing ? (isZh ? '编辑管理员' : 'Edit administrator') : (isZh ? '新增管理员' : 'New administrator')}</h3><button type="button" onClick={() => setFormOpen(false)} className="text-slate-400"><X className="h-4 w-4" /></button></div>
        <label className="text-xs text-slate-400">{isZh ? '用户名' : 'Username'}<input value={form.username} onChange={(event) => setField('username', event.target.value)} disabled={Boolean(editing) && editing.is_super_admin} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white disabled:opacity-50" /></label>
        <label className="text-xs text-slate-400">{isZh ? '显示名称' : 'Display name'}<input value={form.display_name} onChange={(event) => setField('display_name', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /></label>
        <label className="text-xs text-slate-400">Email<input type="email" value={form.email} onChange={(event) => setField('email', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /></label>
        <label className="text-xs text-slate-400">{isZh ? 'AI 配置' : 'AI configuration'}<select value={form.ai_config_mode} onChange={(event) => setField('ai_config_mode', event.target.value as UserForm['ai_config_mode'])} disabled={Boolean(editing?.is_super_admin)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white disabled:opacity-50"><option value="independent">{isZh ? '独立配置' : 'Independent'}</option><option value="shared_current_super">{isZh ? '共享当前超级管理员' : 'Share current super admin'}</option></select></label>
        {editing && <label className="text-xs text-slate-400">{isZh ? '状态' : 'Status'}<select value={form.status} onChange={(event) => setField('status', event.target.value as UserForm['status'])} disabled={editing.is_super_admin} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white disabled:opacity-50"><option value="active">active</option><option value="inactive">inactive</option></select></label>}
        <label className="text-xs text-slate-400">{isZh ? (editing ? '新密码（可选）' : '初始密码') : (editing ? 'New password (optional)' : 'Initial password')}<input type="password" value={form.password} onChange={(event) => setField('password', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /></label>
        <label className="text-xs text-slate-400">{isZh ? '确认密码' : 'Confirm password'}<input type="password" value={form.confirm_password} onChange={(event) => setField('confirm_password', event.target.value)} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /></label>
        <div className="flex gap-2 md:col-span-2"><button type="submit" disabled={busy === 'save'} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{busy === 'save' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{isZh ? '保存' : 'Save'}</button><button type="button" onClick={() => setFormOpen(false)} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300">{isZh ? '取消' : 'Cancel'}</button></div>
      </form>}

      <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-xs"><thead className="text-slate-500"><tr><th className="pb-2">{isZh ? '管理员' : 'Administrator'}</th><th className="pb-2">{isZh ? '角色/状态' : 'Role / status'}</th><th className="pb-2">{isZh ? 'AI 配置' : 'AI configuration'}</th><th className="pb-2">{isZh ? '最近登录' : 'Last login'}</th><th className="pb-2 text-right">{isZh ? '操作' : 'Actions'}</th></tr></thead><tbody className="divide-y divide-slate-800">{sortedUsers.map((user) => <tr key={user.id}><td className="py-3 text-slate-200"><div className="font-semibold">{user.display_name || user.username}</div><div className="text-[10px] text-slate-500">{user.username} · {user.email || '—'}</div></td><td className="py-3"><span className={user.is_super_admin ? 'text-amber-200' : 'text-slate-300'}>{user.is_super_admin ? 'super_admin' : user.role}</span><div className={user.status === 'active' ? 'text-emerald-300' : 'text-rose-300'}>{user.status}</div></td><td className="py-3 text-slate-400">{user.ai_config_mode === 'shared' ? (isZh ? `共享：${user.shared_provider_name || '当前超级管理员'}` : `Shared: ${user.shared_provider_name || 'current super admin'}`) : (isZh ? '独立配置' : 'Independent')}<div className="text-[10px] text-slate-600">v{user.ai_config_access_version}</div></td><td className="py-3 text-slate-400">{formatDate(user.last_login, lang)}</td><td className="py-3 text-right"><div className="inline-flex items-center gap-2">{canWrite && <button type="button" onClick={() => openEdit(user)} className="inline-flex items-center gap-1 text-indigo-300"><Edit3 className="h-3.5 w-3.5" />{isZh ? '编辑' : 'Edit'}</button>}{canWrite && !user.is_super_admin && <button type="button" onClick={() => void toggleStatus(user)} disabled={busy === `status-${user.id}`} className="inline-flex items-center gap-1 text-amber-200 disabled:opacity-50"><Shield className="h-3.5 w-3.5" />{user.status === 'active' ? (isZh ? '停用' : 'Disable') : (isZh ? '启用' : 'Enable')}</button>}{canWrite && !user.is_super_admin && <button type="button" onClick={() => void remove(user)} disabled={busy === `delete-${user.id}`} className="inline-flex items-center gap-1 text-rose-300 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />{isZh ? '删除' : 'Delete'}</button>}</div></td></tr>)}{sortedUsers.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-slate-500">{loading ? <LoadingState lang={lang} variant="inline" label={isZh ? '正在读取管理员…' : 'Loading administrators…'} /> : (isZh ? '暂无管理员数据' : 'No administrators')}</td></tr>}</tbody></table></div>
    </section>
  );
};

export default AdminUsersView;
