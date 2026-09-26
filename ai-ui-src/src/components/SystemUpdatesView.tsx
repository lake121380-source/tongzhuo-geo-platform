import React, { useEffect, useState } from 'react';
import { updaterConnectionLabel, updaterDoctorLabel, updaterReadinessLabel } from '../api/labels';
import {
  AlertTriangle,
  ArchiveRestore,
  CheckCircle2,
  Clipboard,
  CloudDownload,
  DatabaseBackup,
  ExternalLink,
  Loader2,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { ApiRecord, GeoFlowApiClient, SystemUpdateOperationKind } from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';
import { PermissionNotice } from './PermissionNotice';
import { PageHeader } from './PageHeader';
import { EmptyState } from './ui';

interface SystemUpdatesViewProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  canRead: boolean;
  canWrite: boolean;
  isSuperAdmin: boolean;
}

type SensitiveOperation = 'update' | 'backup' | 'rollback';

const record = (value: unknown): ApiRecord => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {}
);

const list = (value: unknown): ApiRecord[] => (
  Array.isArray(value) ? value.filter((item): item is ApiRecord => Boolean(item && typeof item === 'object' && !Array.isArray(item))) : []
);

const truthy = (value: unknown): boolean => value === true;

const dateText = (value: unknown, lang: 'zh' | 'en'): string => {
  if (typeof value !== 'string' || !value.trim()) return '—';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US') : value;
};

const bytesText = (value: unknown): string => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 1) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
};

const idempotencyKey = (kind: string): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `${kind}-${crypto.randomUUID()}`;
  } catch {
    // The timestamp fallback still produces a unique operator request key.
  }
  return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

export const SystemUpdatesView: React.FC<SystemUpdatesViewProps> = ({
  apiClient,
  lang,
  canRead,
  canWrite,
  isSuperAdmin,
}) => {
  const zh = lang === 'zh';
  const [summary, setSummary] = useState<ApiRecord | null>(null);
  const [historyScope, setHistoryScope] = useState<'recent' | 'archived'>('recent');
  const [runPage, setRunPage] = useState(1);
  const [backupPage, setBackupPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  const [operationForm, setOperationForm] = useState<SensitiveOperation | null>(null);
  const [password, setPassword] = useState('');
  const [authorizationCode, setAuthorizationCode] = useState('');
  const [recoveryPointId, setRecoveryPointId] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const load = async (scope = historyScope, quiet = false, nextRunPage = runPage, nextBackupPage = backupPage) => {
    if (!canRead || !isSuperAdmin) return;
    if (!quiet) setLoading(true);
    try {
      setSummary(record(await apiClient.getSystemUpdates(scope, { runsPage: nextRunPage, backupsPage: nextBackupPage })));
      if (!quiet) {
        setNotice('');
        setNoticeError(false);
      }
    } catch (error) {
      setNotice(describeApiError(error, zh ? '无法读取系统更新状态' : 'Unable to load system update state', lang));
      setNoticeError(true);
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  useEffect(() => {
    void load(historyScope);
  }, [canRead, historyScope, isSuperAdmin, runPage, backupPage]); // eslint-disable-line react-hooks/exhaustive-deps

  const updater = record(summary?.updater);
  const operation = record(updater.current_operation);
  const operationStatus = String(operation.status || '');
  useEffect(() => {
    if (!['queued', 'running'].includes(operationStatus) || !canRead || !isSuperAdmin) return undefined;
    const timer = window.setInterval(() => void load(historyScope, true), 5000);
    return () => window.clearInterval(timer);
  }, [operationStatus, historyScope, canRead, isSuperAdmin, runPage, backupPage]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isSuperAdmin) {
    return <PermissionNotice lang={lang} mode="read" requiredScope={zh ? '超级管理员角色' : 'super-admin role'} />;
  }
  if (!canRead) return <PermissionNotice lang={lang} mode="read" requiredScope="system:read" />;

  const release = record(summary?.release);
  const releaseState = record(release.state);
  const releaseNotice = record(release.notice);
  const releaseLinks = record(release.links);
  const history = record(summary?.history);
  const runs = list(record(history.runs).items);
  const backups = list(record(history.backups).items);
  const runPagination = record(record(history.runs).pagination);
  const backupPagination = record(record(history.backups).pagination);
  const recoveryPoints = list(updater.recovery_points);
  const checks = list(updater.checks);
  const stages = list(operation.stages);
  const prepared = record(updater.prepared);
  const actions = record(updater.actions);
  const manualCommands = list(summary?.manual_commands);
  const installCommands = Object.entries(record(updater.install_commands)).filter(([, command]) => typeof command === 'string' && command.trim());
  const passwordRequired = truthy(summary?.admin_password_required);
  const rollbackPoint = recoveryPoints.find((point) => truthy(point.rollback_allowed));

  const selectHistoryScope = (scope: 'recent' | 'archived') => {
    setHistoryScope(scope);
    setRunPage(1);
    setBackupPage(1);
  };

  const notify = (message: string, error = false) => {
    setNotice(message);
    setNoticeError(error);
  };

  const runSimple = async (kind: 'check' | 'prepare' | 'verify') => {
    if (!canWrite) return;
    setBusy(kind);
    notify('');
    try {
      if (kind === 'check') await apiClient.checkSystemUpdates({ idempotencyKey: idempotencyKey('system-check') });
      else if (kind === 'prepare') await apiClient.prepareSystemUpdater({ idempotencyKey: idempotencyKey('system-prepare') });
      else await apiClient.startSystemUpdateOperation('verify', {}, { idempotencyKey: idempotencyKey('system-verify') });
      notify(kind === 'check'
        ? (zh ? '版本信息已重新检查。' : 'Release metadata refreshed.')
        : kind === 'prepare'
          ? (zh ? 'Updater 安装包已验证并准备。' : 'Updater package verified and prepared.')
          : (zh ? '环境验收任务已由 Updater 接收。' : 'Verification was accepted by the updater.'));
      await load(historyScope, true);
    } catch (error) {
      notify(describeApiError(error, zh ? '操作失败' : 'Operation failed', lang), true);
    } finally {
      setBusy('');
    }
  };

  const downloadPackage = async () => {
    setBusy('download');
    notify('');
    try {
      const blob = await apiClient.downloadSystemUpdaterPackage();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = String(prepared.filename || 'geoflow-updater.tar.gz');
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      notify(zh ? 'Updater 安装包下载已开始。' : 'Updater package download started.');
    } catch (error) {
      notify(describeApiError(error, zh ? '下载失败' : 'Download failed', lang), true);
    } finally {
      setBusy('');
    }
  };

  const openOperation = (kind: SensitiveOperation) => {
    setOperationForm(kind);
    setPassword('');
    setAuthorizationCode('');
    setRecoveryPointId(kind === 'rollback' ? String(rollbackPoint?.id || '') : '');
    setAcknowledged(false);
    notify('');
  };

  const submitOperation = async () => {
    if (!operationForm || !canWrite || !/^\d{6}$/.test(authorizationCode) || !acknowledged) return;
    if (passwordRequired && !password) return;
    if (operationForm === 'rollback' && !recoveryPointId) return;
    const kind: SystemUpdateOperationKind = operationForm;
    setBusy(kind);
    notify('');
    try {
      const payload: ApiRecord = {
        updater_authorization_code: authorizationCode,
      };
      if (passwordRequired) payload.current_admin_password = password;
      if (kind === 'rollback') payload.recovery_point_id = recoveryPointId;
      await apiClient.startSystemUpdateOperation(kind, payload, { idempotencyKey: idempotencyKey(`system-${kind}`) });
      setOperationForm(null);
      setPassword('');
      setAuthorizationCode('');
      setAcknowledged(false);
      notify(zh ? '操作已由独立 Updater 接收；页面会自动跟踪真实进度。' : 'The independent updater accepted the operation; live progress will be polled.');
      await load(historyScope, true);
    } catch (error) {
      notify(describeApiError(error, zh ? 'Updater 未接受操作' : 'The updater did not accept the operation', lang), true);
    } finally {
      setBusy('');
      setPassword('');
      setAuthorizationCode('');
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify(zh ? '命令已复制。' : 'Command copied.');
    } catch {
      notify(zh ? '复制失败，请手动选择命令。' : 'Copy failed; select the command manually.', true);
    }
  };

  const statusTone = String(updater.readiness || 'not_installed') === 'ready'
    ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-200'
    : String(updater.readiness || '') === 'not_installed'
      ? 'border-slate-700 bg-slate-900 text-slate-300'
      : 'border-amber-500/30 bg-amber-950/20 text-amber-200';

  return (
    <div className="space-y-8">
      <PageHeader
        icon={ServerCog}
        group={zh ? '设置' : 'Settings'}
        title={zh ? '备份与更新' : 'Backup & Update'}
        description={zh ? '查看当前版本、检查更新、备份与恢复。执行细节由独立的更新服务完成，这里只展示真实状态。' : 'Version, updates, backup and recovery — real status only.'}
        actions={
          <button type="button" disabled={loading || Boolean(busy)} onClick={() => void load(historyScope)} className="inline-flex h-9 items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />{zh ? '刷新状态' : 'Refresh'}</button>
        }
      />

      {!canWrite && <PermissionNotice lang={lang} requiredScope="system:write" />}
      {notice && <div role={noticeError ? 'alert' : 'status'} className={`rounded-xl border px-4 py-3 text-[13px] ${noticeError ? 'border-rose-500/30 bg-rose-950/30 text-rose-200' : 'border-emerald-500/30 bg-emerald-950/20 text-emerald-200'}`}>{notice}</div>}

      {loading && !summary ? <div className="flex min-h-48 items-center justify-center text-sm text-slate-400"><Loader2 className="mr-2 h-5 w-5 animate-spin" />{zh ? '读取真实 Updater 状态…' : 'Loading live updater state…'}</div> : summary && <>
        <section className={`rounded-2xl border p-5 ${statusTone}`}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-[12.5px] font-semibold opacity-70">{zh ? '独立 Updater 状态' : 'Independent updater status'}</div>
              <div className="mt-2 text-xl font-bold">{updaterReadinessLabel(updater.readiness || 'not_installed', lang)}</div>
              <div className="mt-1 text-[12.5px] opacity-80">{zh ? '连接' : 'Connection'}: {updaterConnectionLabel(updater.connection || 'disconnected', lang)} · {zh ? '自检' : 'Self-check'}: {updaterDoctorLabel(updater.doctor_status || 'unavailable', lang)} · {zh ? '版本' : 'Version'}: {String(updater.updater_version || '—')}</div>
            </div>
            <a href={String(updater.project_url || 'https://github.com/yaojingang/geoflow-updater')} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] underline underline-offset-4">桐灼GEO Updater <ExternalLink className="h-3.5 w-3.5" /></a>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {checks.length === 0 ? <div className="text-[12.5px] opacity-70">{zh ? 'Agent 未返回检查项。' : 'No checks returned by the agent.'}</div> : checks.map((check) => <div key={String(check.id)} className="rounded-xl bg-slate-950/40 px-4 py-3"><div className="flex items-center gap-2 text-[13px] font-semibold">{String(check.status) === 'pass' ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : String(check.status) === 'fail' ? <XCircle className="h-4 w-4 text-rose-400" /> : <AlertTriangle className="h-4 w-4 text-amber-400" />}{String(check.id || 'check')}</div><p className="mt-1 text-[12.5px] leading-5 opacity-75">{String(check.message || '—')}</p></div>)}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl bg-slate-900/70 p-5">
            <h2 className="flex items-center gap-2 text-section-title"><CloudDownload className="h-4 w-4 text-slate-400" />{zh ? '版本与安装包' : 'Release and installer'}</h2>
            <div className="mt-3 grid grid-cols-2 gap-3 text-[12.5px]"><div><div className="text-slate-500">{zh ? '当前版本' : 'Current'}</div><div className="mt-1 font-mono text-slate-200">{String(releaseState.current_version || '—')}</div></div><div><div className="text-slate-500">{zh ? '最新版本' : 'Latest'}</div><div className="mt-1 font-mono text-slate-200">{String(releaseState.latest_version || '—')}</div></div></div>
            {truthy(releaseNotice.available) && <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-950/20 p-3 text-[13px] text-amber-100"><div className="font-semibold">{zh ? '发现正式更新' : 'Release available'}: {String(releaseNotice.latest_version || '—')}</div><p className="mt-1 leading-5 text-amber-200/80">{String(releaseNotice.summary || (zh ? '上游未提供版本摘要。' : 'No release summary provided.'))}</p>{typeof releaseNotice.url === 'string' && releaseNotice.url && <a href={releaseNotice.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 underline">{zh ? '查看发布说明' : 'Release notes'}<ExternalLink className="h-3 w-3" /></a>}</div>}
            {Object.keys(prepared).length > 0 && <div className="mt-3 rounded-xl border border-indigo-500/20 bg-indigo-950/20 p-3 text-[13px]"><div className="font-semibold text-indigo-100">{String(prepared.filename || 'Updater package')}</div><div className="mt-1 break-all font-mono text-[12.5px] text-slate-400">SHA-256 {String(prepared.sha256 || '—')}</div><div className="mt-1 text-slate-400">{bytesText(prepared.size)} · {dateText(prepared.prepared_at, lang)}</div></div>}
            <div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={!canWrite || Boolean(busy)} onClick={() => void runSimple('check')} className="h-9 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40">{busy === 'check' ? '…' : (zh ? '检查新版本' : 'Check release')}</button>{truthy(actions.prepare) && <button type="button" disabled={!canWrite || Boolean(busy)} onClick={() => void runSimple('prepare')} className="h-9 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40">{busy === 'prepare' ? '…' : (zh ? '验证并准备 Updater' : 'Prepare updater')}</button>}{truthy(actions.download) && <button type="button" disabled={Boolean(busy)} onClick={() => void downloadPackage()} className="h-9 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40">{busy === 'download' ? '…' : (zh ? '下载已验证安装包' : 'Download verified package')}</button>}</div>
            {typeof releaseLinks.release === 'string' && releaseLinks.release && <a href={releaseLinks.release} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-[12.5px] text-slate-500 underline">{zh ? '上游正式 Release' : 'Upstream release'}<ExternalLink className="h-3 w-3" /></a>}
          </div>

          <div className="rounded-2xl bg-slate-900/70 p-5">
            <h2 className="flex items-center gap-2 text-section-title"><ShieldCheck className="h-4 w-4 text-emerald-300" />{zh ? '真实运维操作' : 'Live operations'}</h2>
            <p className="mt-1 text-caption">{zh ? '更新、完整备份和回滚均需 Updater 端生成的 6 位一次性授权码；更新会先建立恢复点。' : 'Update, full backup and rollback require a six-digit one-time code generated by the updater. Updates create a recovery point first.'}</p>
            <div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={!canWrite || !truthy(actions.verify) || Boolean(busy)} onClick={() => void runSimple('verify')} className="h-9 rounded-xl border border-emerald-500/30 px-3.5 text-[13px] font-semibold text-emerald-200 hover:bg-emerald-500/10 disabled:opacity-40">{zh ? '环境验收' : 'Verify environment'}</button><button type="button" disabled={!canWrite || !truthy(actions.backup) || Boolean(busy)} onClick={() => openOperation('backup')} className="h-9 rounded-xl border border-indigo-500/30 px-3.5 text-[13px] font-semibold text-indigo-200 hover:bg-indigo-500/10 disabled:opacity-40">{zh ? '创建完整备份' : 'Create full backup'}</button><button type="button" disabled={!canWrite || !truthy(actions.update) || Boolean(busy)} onClick={() => openOperation('update')} className="h-9 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white hover:bg-indigo-500 disabled:opacity-40">{zh ? '更新系统' : 'Update system'}</button><button type="button" disabled={!canWrite || !truthy(actions.rollback) || Boolean(busy)} onClick={() => openOperation('rollback')} className="h-9 rounded-xl border border-rose-500/35 bg-rose-950/20 px-3.5 text-[13px] font-semibold text-rose-200 hover:bg-rose-950/40 disabled:opacity-40">{zh ? '回滚到最新恢复点' : 'Rollback latest checkpoint'}</button></div>
            {Object.keys(operation).length > 0 && <div className="mt-4 rounded-xl bg-slate-950/40 px-4 py-3"><div className="flex items-center justify-between gap-2 text-[13px]"><span className="font-semibold text-white">{String(operation.kind || 'operation')} · {String(operation.status || 'unknown')}</span><span className="font-mono text-[11.5px] text-slate-500">{String(operation.id || '')}</span></div><div className="mt-2 space-y-1">{stages.length === 0 ? <p className="text-[12.5px] text-slate-500">{zh ? '已接收，等待阶段回执。' : 'Accepted; waiting for stage receipts.'}</p> : stages.map((stage, index) => <div key={`${String(stage.name)}-${index}`} className="flex items-start gap-2 text-[12.5px] text-slate-300"><span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${String(stage.status) === 'succeeded' ? 'bg-emerald-400' : String(stage.status) === 'failed' ? 'bg-rose-400' : 'bg-indigo-400 animate-pulse'}`} /><span><strong>{String(stage.name || 'stage')}</strong> · {String(stage.status || 'unknown')} {stage.message ? `— ${String(stage.message)}` : ''}</span></div>)}</div>{operation.error && <p className="mt-2 text-[12.5px] text-rose-300">{String(operation.error)}</p>}</div>}
          </div>
        </section>

        {operationForm && <section className="rounded-2xl border border-amber-500/30 bg-amber-950/20 p-5" aria-label={zh ? '高风险操作确认' : 'Sensitive operation confirmation'}><div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" /><div><h2 className="text-[16px] font-bold text-amber-100">{operationForm === 'backup' ? (zh ? '创建完整备份' : 'Create full backup') : operationForm === 'update' ? (zh ? '更新 桐灼GEO' : 'Update 桐灼GEO') : (zh ? '回滚到最新更新恢复点' : 'Rollback latest update checkpoint')}</h2><p className="mt-1 text-[13px] leading-5 text-amber-200/75">{zh ? '授权码仅转发给本机 Updater，不写入审计日志。提交后请等待真实阶段回执，不要关闭主机。' : 'The code is forwarded only to the local updater and is never stored in audit logs. Wait for real stage receipts after submitting.'}</p></div></div><div className="mt-4 grid gap-3 sm:grid-cols-2">{passwordRequired && <label className="text-[13px] text-slate-300">{zh ? '当前管理员密码' : 'Current admin password'}<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500" /></label>}<label className="text-[13px] text-slate-300">{zh ? 'Updater 6 位一次性授权码' : 'Updater six-digit one-time code'}<input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={authorizationCode} onChange={(event) => setAuthorizationCode(event.target.value.replace(/\D/g, '').slice(0, 6))} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 font-mono text-[13px] tracking-[0.35em] text-white outline-none transition focus:border-indigo-500" /></label>{operationForm === 'rollback' && <label className="text-[13px] text-slate-300 sm:col-span-2">{zh ? '服务端允许的最新更新恢复点' : 'Latest server-approved update checkpoint'}<select value={recoveryPointId} onChange={(event) => setRecoveryPointId(event.target.value)} className="mt-1 h-10 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500">{recoveryPoints.filter((point) => truthy(point.rollback_allowed)).map((point) => <option key={String(point.id)} value={String(point.id)}>{String(point.id)} · {String(point.version || '—')} · {dateText(point.created_at, lang)}</option>)}</select></label>}</div><label className="mt-4 flex items-start gap-2 text-[13px] text-amber-100"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-0.5" /><span>{zh ? '我已确认当前操作、备份/恢复点状态及服务重启影响。' : 'I confirmed the operation, backup/checkpoint state and service restart impact.'}</span></label><div className="mt-4 flex gap-2"><button type="button" disabled={Boolean(busy) || !acknowledged || !/^\d{6}$/.test(authorizationCode) || (passwordRequired && !password) || (operationForm === 'rollback' && !recoveryPointId)} onClick={() => void submitOperation()} className="h-9 rounded-xl bg-indigo-600 px-3.5 text-[13px] font-bold text-white hover:bg-indigo-500 disabled:opacity-40">{busy ? (zh ? '提交中…' : 'Submitting…') : (zh ? '确认提交给 Updater' : 'Submit to updater')}</button><button type="button" disabled={Boolean(busy)} onClick={() => { setOperationForm(null); setPassword(''); setAuthorizationCode(''); }} className="h-9 rounded-xl border border-slate-700 bg-slate-800/60 px-3.5 text-[13px] font-semibold text-slate-200 hover:bg-slate-800">{zh ? '取消' : 'Cancel'}</button></div></section>}

        {(installCommands.length > 0 || manualCommands.length > 0) && <section className="rounded-2xl bg-slate-900/70 p-5"><h2 className="text-section-title">{zh ? '部署与升级后命令' : 'Deployment and post-update commands'}</h2><p className="mt-1 text-caption">{zh ? '这些命令来自当前部署配置，不会由浏览器自动执行。' : 'These commands come from this deployment configuration and are never executed by the browser.'}</p><div className="mt-3 space-y-2">{installCommands.map(([name, command]) => <div key={name} className="rounded-xl bg-slate-950/40 px-4 py-3"><div className="mb-2 flex items-center justify-between"><span className="text-[12.5px] font-semibold text-slate-400">{name}</span><button type="button" onClick={() => void copy(String(command))} className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[12.5px] font-semibold text-indigo-400 transition hover:bg-slate-800 hover:text-indigo-300"><Clipboard className="h-3 w-3" />{zh ? '复制' : 'Copy'}</button></div><pre className="whitespace-pre-wrap break-all text-[12.5px] leading-5 text-slate-300">{String(command)}</pre></div>)}{manualCommands.map((command) => <div key={String(command.id)} className="rounded-xl bg-slate-950/40 px-4 py-3"><div className="flex items-center justify-between gap-2"><div><div className="text-[13px] font-semibold text-white">{String(command.label || command.id)}</div><p className="mt-1 text-[12.5px] text-slate-500">{String(command.status_description || command.description || '')}</p></div><button type="button" onClick={() => void copy(String(command.command || ''))} className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[12.5px] font-semibold text-indigo-400 transition hover:bg-slate-800 hover:text-indigo-300"><Clipboard className="h-3 w-3" />{zh ? '复制' : 'Copy'}</button></div><pre className="mt-2 whitespace-pre-wrap break-all text-[12.5px] leading-5 text-slate-300">{String(command.command || '')}</pre></div>)}</div></section>}

        <section className="rounded-2xl bg-slate-900/70 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-section-title"><ArchiveRestore className="h-4 w-4 text-slate-400" />{zh ? '旧执行记录（只读）' : 'Legacy execution history (read only)'}</h2><div className="flex rounded-lg border border-slate-700 bg-slate-800/40 p-0.5 text-[12.5px]"><button type="button" onClick={() => selectHistoryScope('recent')} className={`rounded-lg px-2.5 py-1 ${historyScope === 'recent' ? 'bg-slate-700 text-white' : 'text-slate-400'}`}>{zh ? `近 ${String(history.days || 90)} 天` : `Recent ${String(history.days || 90)} days`}</button><button type="button" onClick={() => selectHistoryScope('archived')} className={`rounded-lg px-2.5 py-1 ${historyScope === 'archived' ? 'bg-slate-700 text-white' : 'text-slate-400'}`}>{zh ? '历史归档' : 'Archived'}</button></div></div><p className="mt-1 text-caption">{zh ? '这些数据库记录来自已退役的 Laravel 执行器，仅供追溯；新操作只以独立 Updater 回执为准。' : 'These database rows belong to the retired Laravel executor and are retained only for traceability.'}</p><div className="mt-4 grid gap-4 lg:grid-cols-2"><div><h3 className="mb-2 text-[13px] font-semibold text-slate-300">{zh ? '更新/回滚记录' : 'Update/rollback runs'}</h3><div className="space-y-2">{runs.length === 0 ? <EmptyState compact icon={ArchiveRestore} title={zh ? '此时间范围没有旧执行记录' : 'No legacy runs in this range'} description={zh ? '切换时间范围，或选择「历史归档」查看更早的记录。' : 'Try another range, or switch to the archived view.'} /> : runs.map((run) => <div key={String(run.run_uuid || run.id)} className="rounded-xl bg-slate-950/40 px-4 py-3 text-[13px]"><div className="flex justify-between gap-2"><span className="font-semibold text-white">{String(run.action || 'run')}</span><span className="text-slate-400">{String(run.status || 'unknown')}</span></div><div className="mt-1 text-[12.5px] text-slate-500">{String(run.current_version || '—')} → {String(run.target_version || '—')} · {dateText(run.created_at, lang)}</div>{run.error_message && <p className="mt-1 text-[12.5px] text-rose-300">{String(run.error_message)}</p>}</div>)}</div>{Number(runPagination.total_pages || 0) > 1 && <div className="mt-2 flex items-center justify-between text-[12.5px] text-slate-400"><button type="button" disabled={runPage <= 1} onClick={() => setRunPage((page) => Math.max(1, page - 1))} className="disabled:opacity-30">{zh ? '上一页' : 'Previous'}</button><span>{runPage} / {String(runPagination.total_pages)}</span><button type="button" disabled={runPage >= Number(runPagination.total_pages || 1)} onClick={() => setRunPage((page) => page + 1)} className="disabled:opacity-30">{zh ? '下一页' : 'Next'}</button></div>}</div><div><h3 className="mb-2 flex items-center gap-1 text-[13px] font-semibold text-slate-300"><DatabaseBackup className="h-3.5 w-3.5" />{zh ? '旧备份记录' : 'Legacy backup records'}</h3><div className="space-y-2">{backups.length === 0 ? <EmptyState compact icon={DatabaseBackup} title={zh ? '此时间范围没有旧备份记录' : 'No legacy backups in this range'} description={zh ? '切换时间范围，或选择「历史归档」查看更早的备份。' : 'Try another range, or switch to the archived view.'} /> : backups.map((backup) => <div key={String(backup.backup_uuid || backup.id)} className="rounded-xl bg-slate-950/40 px-4 py-3 text-[13px]"><div className="flex justify-between gap-2"><span className="font-mono text-[12.5px] text-white">{String(backup.backup_uuid || 'backup')}</span><span className="text-slate-400">{String(backup.status || 'unknown')}</span></div><div className="mt-1 text-[12.5px] text-slate-500">{String(backup.from_version || '—')} → {String(backup.to_version || '—')} · {bytesText(backup.total_bytes)} · {dateText(backup.created_at, lang)}</div></div>)}</div>{Number(backupPagination.total_pages || 0) > 1 && <div className="mt-2 flex items-center justify-between text-[12.5px] text-slate-400"><button type="button" disabled={backupPage <= 1} onClick={() => setBackupPage((page) => Math.max(1, page - 1))} className="disabled:opacity-30">{zh ? '上一页' : 'Previous'}</button><span>{backupPage} / {String(backupPagination.total_pages)}</span><button type="button" disabled={backupPage >= Number(backupPagination.total_pages || 1)} onClick={() => setBackupPage((page) => page + 1)} className="disabled:opacity-30">{zh ? '下一页' : 'Next'}</button></div>}</div></div>
        </section>
      </>}
    </div>
  );
};

export default SystemUpdatesView;
