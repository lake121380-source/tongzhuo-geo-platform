import React, { useEffect, useRef, useState } from 'react';
import {
  Radio,
  Plus,
  RefreshCw,
  CheckCircle2,
  Shield,
  Key,
  Server,
  RotateCcw,
  Download,
  AlertCircle,
  Pencil,
  Pause,
  Play,
  Trash2,
  Globe2,
  Wrench,
  Search,
  Archive,
} from 'lucide-react';
import { DistributionChannel } from '../types';
import PermissionNotice from './PermissionNotice';
import { describeApiError } from '../api/permissions';

interface DistributionViewProps {
  channels: DistributionChannel[];
  /** Hosted sites are a separate lifecycle domain, not ordinary channels. */
  hostedSites?: Array<Record<string, unknown>>;
  distributionJobs?: Array<Record<string, unknown>>;
  /**
   * 重新拉取分发任务列表。
   *
   * 「排队中/发送中」的行不会自己走到终态，所以列表里有未终态行时组件会周期性调用它；
   * 全部到达 synced/failed 后停止（见组件内的轮询 effect）。
   */
  onRefreshDistributionJobs?: () => Promise<void>;
  // `| void` in a returned union cannot be narrowed by a truthiness check, so
  // the "no payload" branch is typed as `undefined` instead.
  onAddChannel: (channel: Partial<DistributionChannel>) => Promise<{ one_time_secret?: { key_id: string; secret: string } } | undefined>;
  onSyncChannel: (id: string) => Promise<void>;
  onRetryDistribution?: (id: string) => Promise<void>;
  lang: 'zh' | 'en';
  apiMode?: boolean;
  /** Distribution channel projection/read endpoints. */
  canRead?: boolean;
  /** Channel mutations and distribution retries. */
  canWrite?: boolean;
  /** Secret creation/rotation is intentionally a separate capability. */
  canManageSecrets?: boolean;
  /** 查看渠道密钥明文（超管 + 二次密码）。 */
  onRevealChannelSecret?: (id: string, password: string) => Promise<{ key_id: string; secret: string; endpoint_url?: string } | undefined>;
  /** 下载渠道接入包（超管 + 二次密码）。 */
  onDownloadChannelPackage?: (id: string, password: string) => Promise<void>;
  /** 重新抓取渠道前端的实际能力快照。 */
  onRefreshChannelCapabilities?: (id: string) => Promise<void>;
  /** 预览「站点设置 → 渠道前端」的同步结果。 */
  onPreviewSettingsSync?: (scope: 'all' | 'selected', channelIds: string[]) => Promise<Record<string, unknown>>;
  /** 执行同步；`confirmed` 对应服务端的 `frontend_sync_confirmed` 门禁。 */
  onSyncSettings?: (scope: 'all' | 'selected', channelIds: string[], confirmed: boolean) => Promise<Record<string, unknown>>;
  /** 取文章快照，用于预填「修正分发内容」表单——列表投影里没有正文。 */
  onLoadArticleSnapshot?: (articleId: string) => Promise<Record<string, unknown>>;
  onUpdateDistributionJob?: (id: string, payload: Record<string, unknown>) => Promise<void>;
  onDeleteDistributionJob?: (id: string) => Promise<void>;
  /** Destructive deletion is restricted to a super administrator by the API. */
  canManageDestructive?: boolean;
  /** Hosted Site lifecycle management is restricted to a super administrator by the API. */
  canManageHostedSites?: boolean;
  onUpdateChannel?: (id: string, payload: Record<string, unknown>) => Promise<void>;
  onSetChannelStatus?: (id: string, active: boolean) => Promise<void>;
  onRotateChannelSecret?: (id: string) => Promise<{ key_id: string; secret: string } | undefined>;
  onPreviewChannelDeletion?: (id: string) => Promise<Record<string, unknown>>;
  onPrepareChannelDeletion?: (id: string) => Promise<Record<string, unknown>>;
  onCancelChannelDeletion?: (id: string) => Promise<Record<string, unknown>>;
  onDeleteChannel?: (id: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onCreateHostedSite?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onHostedSiteAction?: (id: string, action: 'preflight' | 'activate' | 'pause' | 'maintenance' | 'indexing' | 'archive', payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onUpdateHostedSite?: (id: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onAssignHostedArticle?: (id: string, articleId: string) => Promise<Record<string, unknown>>;
}

/**
 * The backend owns Agent package generation and channel secrets.
 * This UI deliberately does not synthesize client code or expose credentials.
 */

export const DistributionView: React.FC<DistributionViewProps> = ({
  channels,
  hostedSites = [],
  distributionJobs = [],
  onRefreshDistributionJobs,
  onAddChannel,
  onSyncChannel,
  onRetryDistribution,
  lang,
  apiMode = false,
  canRead = true,
  canWrite = true,
  canManageSecrets = canWrite,
  onRevealChannelSecret,
  onDownloadChannelPackage,
  onRefreshChannelCapabilities,
  onPreviewSettingsSync,
  onSyncSettings,
  onLoadArticleSnapshot,
  onUpdateDistributionJob,
  onDeleteDistributionJob,
  canManageDestructive = canWrite,
  canManageHostedSites = canWrite,
  onUpdateChannel,
  onSetChannelStatus,
  onRotateChannelSecret,
  onPreviewChannelDeletion,
  onPrepareChannelDeletion,
  onCancelChannelDeletion,
  onDeleteChannel,
  onCreateHostedSite,
  onHostedSiteAction,
  onUpdateHostedSite,
  onAssignHostedArticle,
}) => {
  const [activeTab, setActiveTab] = useState<'channels' | 'deployment'>('channels');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [oneTimeSecret, setOneTimeSecret] = useState<{ key_id: string; secret: string } | null>(null);
  // 二次密码弹窗：查看密钥与下载接入包都要重新验证一次密码，密码只走请求体。
  const [secretPrompt, setSecretPrompt] = useState<{ id: string; purpose: 'reveal' | 'package' } | null>(null);
  const [secretPassword, setSecretPassword] = useState('');
  /**
   * 打开「修正分发内容」。
   *
   * 列表投影里只有 `article.title`，没有正文——所以必须再取一次文章快照来预填，
   * 否则表单是空的而 content 又是必填，运营方只能自己重新粘一遍全文。
   */
  const openJobEdit = async (jobId: string, articleId: string) => {
    if (!articleId || !onLoadArticleSnapshot) return;
    try {
      const snapshot = await onLoadArticleSnapshot(articleId);
      setJobEdit({
        id: jobId,
        articleId,
        title: String(snapshot.title ?? ''),
        excerpt: String(snapshot.excerpt ?? ''),
        content: String(snapshot.content ?? ''),
        keywords: String(snapshot.keywords ?? ''),
        meta_description: String(snapshot.meta_description ?? ''),
      });
    } catch {
      // 读取失败由 App 层统一报错，这里不吞也不开空表单。
    }
  };

  const [syncScope, setSyncScope] = useState<'all' | 'selected'>('all');
  const [syncSelected, setSyncSelected] = useState<Set<string>>(new Set());
  const [syncPreview, setSyncPreview] = useState<Record<string, unknown> | null>(null);
  const [syncConfirmed, setSyncConfirmed] = useState(false);
  const [syncResult, setSyncResult] = useState<Record<string, unknown> | null>(null);
  const [jobEdit, setJobEdit] = useState<{ id: string; articleId: string; title: string; excerpt: string; content: string; keywords: string; meta_description: string } | null>(null);
  const [actionError, setActionError] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [deleteState, setDeleteState] = useState<{
    id: string;
    impact: Record<string, unknown>;
    prepared: boolean;
    confirmationName: string;
    ackRemote: boolean;
    ackTasks: boolean;
    ackCredentials: boolean;
    ackHistory: boolean;
    forceSending: boolean;
    forceOperations: boolean;
  } | null>(null);

  // Form
  const [name, setName] = useState('');
  const [type, setType] = useState<'tongzhuo_geo_agent' | 'wordpress_rest' | 'generic_http'>('tongzhuo_geo_agent');
  const [targetUrl, setTargetUrl] = useState('');
  const [authMethod, setAuthMethod] = useState('HMAC-SHA256 Secret');
  const [hostedModal, setHostedModal] = useState<'create' | 'edit' | null>(null);
  const [hostedEditingId, setHostedEditingId] = useState<string | null>(null);
  const [hostedDraft, setHostedDraft] = useState<Record<string, string>>({});
  const [hostedBusy, setHostedBusy] = useState<string>('');
  const [hostedArticleIds, setHostedArticleIds] = useState<Record<string, string>>({});

  /**
   * 分发任务目前只在应用启动时拉一次（App.tsx），之后只在用户点「分发/重试」时刷新。
   * 于是「排队中/发送中」的行永远不会自己变成「已同步」——用户以为分发卡住了，
   * 而他不知道该点刷新（界面上也没有刷新按钮）。
   *
   * 只要列表里还有未到终态（queued/sending/outcome_unknown）的行，就按固定节奏重拉一次；
   * 全部到达 synced/failed 立即停——不做空闲常驻轮询。切走标签页会卸载组件并清掉定时器。
   * （outcome_unknown 是「待对账」，后端只会由人工重试收敛，所以有这种行时轮询会一直保持——
   *   它表示这个分发还没落定，不算空闲。没有未终态行时一次请求都不会发。）
   */
  const hasInFlightJobs = distributionJobs.some((job) => {
    const status = String(job.status ?? '').trim().toLowerCase();
    return status === 'queued' || status === 'sending' || status === 'outcome_unknown';
  });
  // 回调存进 ref：父组件每次渲染都会生成新的内联函数，写进依赖会让计时器不停被重置。
  const refreshJobsRef = useRef(onRefreshDistributionJobs);
  const jobsPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { refreshJobsRef.current = onRefreshDistributionJobs; }, [onRefreshDistributionJobs]);
  useEffect(() => {
    if (jobsPollTimer.current) clearTimeout(jobsPollTimer.current);
    jobsPollTimer.current = null;
    if (!apiMode || !hasInFlightJobs || !refreshJobsRef.current) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        await refreshJobsRef.current?.();
      } catch {
        // 单轮失败不该打断轮询（也还没到终态）；下一轮再试。
      }
      if (!cancelled) jobsPollTimer.current = setTimeout(() => void poll(), 3000);
    };
    jobsPollTimer.current = setTimeout(() => void poll(), 3000);
    return () => {
      cancelled = true;
      if (jobsPollTimer.current) clearTimeout(jobsPollTimer.current);
      jobsPollTimer.current = null;
    };
    // 依赖只有布尔值：父组件的无关重渲染不会重置计时；列表全到终态时 effect 重跑并停掉轮询。
  }, [apiMode, hasInFlightJobs]);

  const newHostedDraft = (): Record<string, string> => ({
    name: '', hostname: '', topic: '', locale: 'zh_CN', timezone: 'Asia/Shanghai',
    daily_publish_limit: '10', publish_weight: '100', min_publish_interval_minutes: '360',
    min_articles_before_index: '10', template_key: 'default', site_description: '',
    site_keywords: '', about_title: '', about_content: '', contact_email: '', lead_form_slugs: '',
  });

  const profileOf = (site: Record<string, unknown>): Record<string, unknown> => (
    site.profile && typeof site.profile === 'object' ? site.profile as Record<string, unknown> : {}
  );

  const startHostedEdit = (site: Record<string, unknown>) => {
    const profile = profileOf(site);
    const settings = site.site_settings && typeof site.site_settings === 'object' ? site.site_settings as Record<string, unknown> : {};
    setHostedEditingId(String(site.id || ''));
    setHostedDraft({
      ...newHostedDraft(),
      name: String(site.name || ''), hostname: String(profile.hostname || site.domain || ''),
      topic: String(profile.topic || ''), locale: String(profile.locale || 'zh_CN'),
      timezone: String(profile.timezone || 'Asia/Shanghai'),
      daily_publish_limit: String(profile.daily_publish_limit ?? 10),
      publish_weight: String(profile.publish_weight ?? 100),
      min_publish_interval_minutes: String(profile.min_publish_interval_minutes ?? 360),
      min_articles_before_index: String(profile.min_articles_before_index ?? 10),
      template_key: String(settings.template_key || 'default'),
      site_description: String(settings.site_description || ''), site_keywords: String(settings.site_keywords || ''),
      about_title: String(settings.about_title || ''), about_content: String(settings.about_content || ''),
      contact_email: String(settings.contact_email || ''),
    });
    setHostedModal('edit');
  };

  const submitHosted = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!onCreateHostedSite && !onUpdateHostedSite) return;
    const payload: Record<string, unknown> = {
      ...hostedDraft,
      daily_publish_limit: Number(hostedDraft.daily_publish_limit),
      publish_weight: Number(hostedDraft.publish_weight),
      min_publish_interval_minutes: Number(hostedDraft.min_publish_interval_minutes),
      min_articles_before_index: Number(hostedDraft.min_articles_before_index),
      lead_form_slugs: hostedDraft.lead_form_slugs.split(',').map((value) => value.trim()).filter(Boolean),
    };
    setHostedBusy('save');
    try {
      if (hostedModal === 'edit' && hostedEditingId && onUpdateHostedSite) await onUpdateHostedSite(hostedEditingId, payload);
      else if (onCreateHostedSite) await onCreateHostedSite(payload);
      setHostedModal(null);
      setHostedEditingId(null);
      setActionError('');
    } catch (error) {
      setActionError(describeApiError(error, lang === 'zh' ? '保存 Hosted Site 失败' : 'Unable to save hosted site', lang));
    } finally {
      setHostedBusy('');
    }
  };

  const runHostedAction = async (id: string, action: 'preflight' | 'activate' | 'pause' | 'maintenance' | 'indexing' | 'archive', payload: Record<string, unknown> = {}) => {
    if (!onHostedSiteAction) return;
    setHostedBusy(`${action}-${id}`);
    try {
      await onHostedSiteAction(id, action, payload);
      setActionError('');
    } catch (error) {
      setActionError(describeApiError(error, lang === 'zh' ? 'Hosted Site 操作失败' : 'Hosted Site action failed', lang));
    } finally {
      setHostedBusy('');
    }
  };

  const assignHostedArticle = async (siteId: string) => {
    const articleId = (hostedArticleIds[siteId] || '').trim();
    if (!articleId || !onAssignHostedArticle) return;
    setHostedBusy(`assign-${siteId}`);
    try {
      await onAssignHostedArticle(siteId, articleId);
      setHostedArticleIds((current) => ({ ...current, [siteId]: '' }));
      setActionError('');
    } catch (error) {
      setActionError(describeApiError(error, lang === 'zh' ? '分配文章失败' : 'Unable to assign article', lang));
    } finally {
      setHostedBusy('');
    }
  };

  const handleSync = async (id: string) => {
    if (!canRead) {
      setActionError(lang === 'zh' ? '权限不足（403）：此操作需要「distribution:read」权限。' : 'Permission denied (403): this action requires the “distribution:read” scope.');
      return;
    }
    setSyncingId(id);
    try {
      await onSyncChannel(id);
      setActionError('');
    } catch (error) {
      setActionError(describeApiError(error, lang === 'zh' ? '渠道健康检查失败' : 'Channel health check failed', lang));
    } finally {
      setSyncingId(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) {
      setActionError(lang === 'zh' ? '权限不足（403）：此操作需要「distribution:write」权限。' : 'Permission denied (403): this action requires the “distribution:write” scope.');
      return;
    }
    if (!name.trim() || !targetUrl.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const result = await onAddChannel(apiMode
        ? {
            name: name.trim(),
            type: 'tongzhuo_geo_agent',
            targetUrl: targetUrl.trim(),
            channel_type: 'geoflow_agent',
            endpoint_url: targetUrl.trim(),
            domain: (() => {
              try { return new URL(targetUrl.trim()).hostname; } catch { return targetUrl.trim(); }
            })(),
            status: 'active',
          }
        : { name, type, targetUrl, authMethod });
      if (result?.one_time_secret) setOneTimeSecret(result.one_time_secret);
      setName('');
      setTargetUrl('');
      setIsModalOpen(false);
      setActionError('');
    } catch (error) {
      setActionError(describeApiError(error, lang === 'zh' ? '保存分发节点失败' : 'Unable to save distribution endpoint', lang));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRetry = async (id: string) => {
    if (!canWrite) {
      setActionError(lang === 'zh' ? '权限不足（403）：此操作需要「distribution:write」权限。' : 'Permission denied (403): this action requires the “distribution:write” scope.');
      return;
    }
    if (!onRetryDistribution) return;
    try {
      await onRetryDistribution(id);
      setActionError('');
    } catch (error) {
      setActionError(describeApiError(error, lang === 'zh' ? '重试分发失败' : 'Unable to retry distribution', lang));
    }
  };

  const runChannelAction = async (key: string, action: () => Promise<void>, fallback: string) => {
    if (!canWrite) {
      setActionError(lang === 'zh' ? '权限不足（403）：此操作需要「distribution:write」权限。' : 'Permission denied (403): this action requires the “distribution:write” scope.');
      return;
    }
    setBusyAction(key);
    try {
      await action();
      setActionError('');
    } catch (error) {
      setActionError(describeApiError(error, fallback, lang));
    } finally {
      setBusyAction('');
    }
  };

  const beginEdit = (channel: DistributionChannel) => {
    setEditingId(channel.id);
    setEditName(channel.name);
    setEditUrl(channel.endpoint_url || channel.targetUrl);
    setEditDescription(channel.description || '');
    setActionError('');
  };

  const saveEdit = async () => {
    if (!editingId || !onUpdateChannel) return;
    await runChannelAction(`edit-${editingId}`, async () => {
      await onUpdateChannel(editingId, {
        name: editName.trim(),
        endpoint_url: editUrl.trim(),
        description: editDescription.trim() || null,
      });
      setEditingId(null);
    }, lang === 'zh' ? '更新分发渠道失败' : 'Unable to update channel');
  };

  const beginDelete = async (channel: DistributionChannel) => {
    if (!canManageDestructive || !onPreviewChannelDeletion) {
      setActionError(lang === 'zh' ? '当前 Token 无权读取删除影响或后端未提供删除接口。' : 'Deletion preview is not available for this token.');
      return;
    }
    setBusyAction(`preview-delete-${channel.id}`);
    try {
      const result = await onPreviewChannelDeletion(channel.id);
      const impact = result.impact && typeof result.impact === 'object' ? result.impact as Record<string, unknown> : {};
      setDeleteState({
        id: channel.id,
        impact,
        prepared: String(result.channel && typeof result.channel === 'object' ? (result.channel as Record<string, unknown>).status : '') === 'deleting',
        confirmationName: '',
        ackRemote: false,
        ackTasks: false,
        ackCredentials: false,
        ackHistory: false,
        forceSending: false,
        forceOperations: false,
      });
      setActionError('');
    } catch (error) {
      setActionError(describeApiError(error, lang === 'zh' ? '无法读取删除影响' : 'Unable to inspect deletion impact', lang));
    } finally {
      setBusyAction('');
    }
  };

  const prepareDelete = async () => {
    if (!deleteState || !onPrepareChannelDeletion) return;
    const id = deleteState.id;
    await runChannelAction(`prepare-delete-${id}`, async () => {
      const result = await onPrepareChannelDeletion(id);
      const impact = result.impact && typeof result.impact === 'object' ? result.impact as Record<string, unknown> : deleteState.impact;
      setDeleteState((current) => current ? { ...current, impact, prepared: true } : current);
    }, lang === 'zh' ? '准备删除失败' : 'Unable to prepare deletion');
  };

  const cancelDelete = async () => {
    if (!deleteState || !onCancelChannelDeletion) return;
    const id = deleteState.id;
    await runChannelAction(`cancel-delete-${id}`, async () => {
      await onCancelChannelDeletion(id);
      setDeleteState(null);
    }, lang === 'zh' ? '取消删除失败' : 'Unable to cancel deletion');
  };

  const completeDelete = async () => {
    if (!deleteState || !onDeleteChannel) return;
    const id = deleteState.id;
    const impact = deleteState.impact;
    const requiredName = String(channels.find((channel) => channel.id === id)?.name || '');
    if (deleteState.confirmationName !== requiredName || !deleteState.ackHistory) {
      setActionError(lang === 'zh' ? '请输入准确的渠道名称并确认历史记录影响。' : 'Enter the exact channel name and acknowledge history impact.');
      return;
    }
    if (Number(impact.remote_content_count || 0) > 0 && !deleteState.ackRemote) {
      setActionError(lang === 'zh' ? '请确认远端内容影响。' : 'Acknowledge remote content impact.');
      return;
    }
    if (Number(impact.linked_task_count || 0) > 0 && !deleteState.ackTasks) {
      setActionError(lang === 'zh' ? '请确认任务关联影响。' : 'Acknowledge linked task impact.');
      return;
    }
    if (Number(impact.secret_count || 0) > 0 && !deleteState.ackCredentials) {
      setActionError(lang === 'zh' ? '请确认凭据失效影响。' : 'Acknowledge credential impact.');
      return;
    }
    await runChannelAction(`delete-${id}`, async () => {
      await onDeleteChannel(id, {
        confirmation_name: deleteState.confirmationName,
        impact_fingerprint: String(impact.impact_fingerprint || ''),
        ack_remote_content: deleteState.ackRemote,
        ack_task_changes: deleteState.ackTasks,
        ack_credentials: deleteState.ackCredentials,
        ack_history: deleteState.ackHistory,
        force_stale_sending: deleteState.forceSending,
        force_stale_operations: deleteState.forceOperations,
      });
      setDeleteState(null);
    }, lang === 'zh' ? '删除分发渠道失败' : 'Unable to delete channel');
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-black text-white flex items-center gap-2">
              <Radio className="w-6 h-6 text-purple-500" />
              <span>{lang === 'zh' ? '多端渠道分发与 Agent 部署中台' : 'Multi-Site Distribution Hub'}</span>
            </h1>
            <span className="text-[11px] px-2.5 py-0.5 rounded-full font-bold bg-purple-500/10 text-purple-400 border border-purple-500/20">
              桐灼GEO API v1
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {lang === 'zh'
              ? '通过 桐灼GEO Agent 协议，把生成文章推送到远端独立站与博客；站点设置可在本页「预览 → 执行同步」两步推送到各渠道前端的 /llms.txt 与 sitemap.xml。'
              : 'Securely publish articles to remote static sites, WordPress blogs, and custom HTTP API endpoints.'}
          </p>
        </div>

        {/* View Switcher Tabs */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('channels')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
              activeTab === 'channels'
                ? 'bg-purple-600 text-white shadow-md shadow-purple-600/20'
                : 'bg-slate-800 text-slate-300 hover:text-white'
            }`}
          >
            <Server className="w-3.5 h-3.5" />
            <span>{lang === 'zh' ? '已连入站点节点' : 'Connected Sites'}</span>
          </button>
          <button
            onClick={() => setActiveTab('deployment')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
              activeTab === 'deployment'
                ? 'bg-purple-600 text-white shadow-md shadow-purple-600/20'
                : 'bg-slate-800 text-slate-300 hover:text-white'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            <span>{lang === 'zh' ? 'Agent 部署状态' : 'Agent Deployment'}</span>
          </button>
        </div>
      </div>

      {!canRead && <PermissionNotice lang={lang} mode="read" requiredScope="distribution:read" />}
      {canRead && !canWrite && <PermissionNotice lang={lang} requiredScope="distribution:write" />}
      {actionError && <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{actionError}</div>}

      {activeTab === 'channels' ? (
        <>
          {/* Hosted Sites have their own lifecycle, quality gate and allocation domain. */}
          {apiMode && canManageHostedSites && (
            <section className="space-y-4 rounded-2xl border border-cyan-500/20 bg-slate-900/80 p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <Globe2 className="h-5 w-5 text-cyan-300" />
                    <h2 className="text-base font-bold text-white">{lang === 'zh' ? 'Hosted Site 托管站点' : 'Hosted Sites'}</h2>
                    <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-200">{hostedSites.length}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">{lang === 'zh' ? '独立站点的上线、索引、质量门禁和文章容量分配。' : 'Lifecycle, indexing, quality gates, and article capacity for hosted sites.'}</p>
                </div>
                <button
                  type="button"
                  disabled={!canWrite || !onCreateHostedSite}
                  onClick={() => { setHostedDraft(newHostedDraft()); setHostedEditingId(null); setHostedModal('create'); }}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-cyan-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-cyan-500 disabled:opacity-50"
                ><Plus className="h-4 w-4" />{lang === 'zh' ? '新增 Hosted Site' : 'Add Hosted Site'}</button>
              </div>
              {!canRead ? <div className="py-6 text-center text-xs text-slate-500">{lang === 'zh' ? '没有 Hosted Site 读取权限' : 'Hosted Site read access is not granted'}</div> : hostedSites.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-700 px-4 py-8 text-center text-xs text-slate-500">{lang === 'zh' ? '暂无托管站点' : 'No hosted sites yet'}</div>
              ) : (
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  {hostedSites.map((site) => {
                    const profile = profileOf(site);
                    const siteId = String(site.id || '');
                    const serving = String(profile.serving_status || 'maintenance');
                    const indexing = String(profile.indexing_status || 'noindex');
                    const quality = String(profile.quality_status || 'pending');
                    const statusLabel: Record<string, string> = { online: '线上', maintenance: '维护', archived: '已归档' };
                    const qualityLabel: Record<string, string> = { passed: '质量通过', pending: '待检查', blocked: '质量阻断' };
                    return (
                      <article key={siteId} className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="truncate text-sm font-bold text-white">{String(site.name || profile.hostname || 'Hosted Site')}</h3>
                              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${serving === 'online' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300' : serving === 'archived' ? 'border-rose-500/20 bg-rose-500/10 text-rose-300' : 'border-amber-500/20 bg-amber-500/10 text-amber-300'}`}>{statusLabel[serving] || serving}</span>
                            </div>
                            <p className="mt-1 truncate font-mono text-[11px] text-slate-400">{String(profile.hostname || site.domain || '—')}</p>
                          </div>
                          <button type="button" onClick={() => startHostedEdit(site)} disabled={!canWrite || !onUpdateHostedSite} className="rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-slate-300 hover:text-white disabled:opacity-50" title={lang === 'zh' ? '编辑站点配置' : 'Edit site'}><Pencil className="h-3.5 w-3.5" /></button>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                          <div className="rounded-lg border border-slate-800 bg-slate-900 p-2"><span className="text-slate-500">质量</span><div className={quality === 'passed' ? 'text-emerald-300' : quality === 'blocked' ? 'text-rose-300' : 'text-amber-300'}>{qualityLabel[quality] || quality}</div></div>
                          <div className="rounded-lg border border-slate-800 bg-slate-900 p-2"><span className="text-slate-500">索引</span><div className={indexing === 'index' ? 'text-emerald-300' : 'text-amber-300'}>{indexing === 'index' ? '允许' : '禁止'}</div></div>
                          <div className="rounded-lg border border-slate-800 bg-slate-900 p-2"><span className="text-slate-500">今日容量</span><div className="text-slate-200">{String(profile.today_used_count ?? 0)} / {String(profile.daily_publish_limit ?? 0)}</div></div>
                          <div className="rounded-lg border border-slate-800 bg-slate-900 p-2"><span className="text-slate-500">文章 / 线索</span><div className="text-slate-200">{String(site.articles_count ?? 0)} / {String(site.lead_count ?? 0)}</div></div>
                        </div>
                        {site.last_error_message && <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-[11px] text-rose-200">{String(site.last_error_message)}</div>}
                        <div className="flex flex-wrap gap-1.5 border-t border-slate-800 pt-3">
                          <button type="button" disabled={!canWrite || hostedBusy === `preflight-${siteId}`} onClick={() => void runHostedAction(siteId, 'preflight')} className="inline-flex items-center gap-1 rounded-lg border border-blue-500/30 bg-blue-500/10 px-2 py-1 text-[10px] font-semibold text-blue-200 disabled:opacity-50"><Search className="h-3 w-3" />预检</button>
                          {serving === 'online' ? <button type="button" disabled={!canWrite || hostedBusy === `pause-${siteId}`} onClick={() => void runHostedAction(siteId, 'pause')} className="inline-flex items-center gap-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-200 disabled:opacity-50"><Pause className="h-3 w-3" />暂停</button> : serving !== 'archived' && <button type="button" disabled={!canWrite || hostedBusy === `activate-${siteId}`} onClick={() => void runHostedAction(siteId, 'activate')} className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-200 disabled:opacity-50"><Play className="h-3 w-3" />上线</button>}
                          {serving !== 'archived' && <button type="button" disabled={!canWrite || hostedBusy === `maintenance-${siteId}`} onClick={() => void runHostedAction(siteId, 'maintenance')} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-semibold text-slate-200 disabled:opacity-50"><Wrench className="h-3 w-3" />维护</button>}
                          {serving !== 'archived' && <button type="button" disabled={!canWrite || hostedBusy === `indexing-${siteId}`} onClick={() => void runHostedAction(siteId, 'indexing', { indexing_status: indexing === 'index' ? 'noindex' : 'index', quality_confirmed: quality === 'passed' })} className="inline-flex items-center gap-1 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[10px] font-semibold text-cyan-200 disabled:opacity-50"><Globe2 className="h-3 w-3" />{indexing === 'index' ? '设为不索引' : '允许索引'}</button>}
                          {serving !== 'archived' && <button type="button" disabled={!canWrite || hostedBusy === `archive-${siteId}`} onClick={() => { if (window.confirm(`确认归档 ${String(profile.hostname || site.name || '')}？`)) void runHostedAction(siteId, 'archive', { hostname: String(profile.hostname || site.domain || '') }); }} className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[10px] font-semibold text-rose-200 disabled:opacity-50"><Archive className="h-3 w-3" />归档</button>}
                        </div>
                        {onAssignHostedArticle && serving !== 'archived' && <div className="flex gap-2 border-t border-slate-800 pt-3"><input value={hostedArticleIds[siteId] || ''} onChange={(event) => setHostedArticleIds((current) => ({ ...current, [siteId]: event.target.value }))} placeholder={lang === 'zh' ? '输入文章 ID 分配容量' : 'Article ID'} className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-[11px] text-white" /><button type="button" disabled={!canWrite || hostedBusy === `assign-${siteId}`} onClick={() => void assignHostedArticle(siteId)} className="rounded-lg bg-slate-800 px-3 py-1.5 text-[10px] font-semibold text-slate-200 disabled:opacity-50">分配文章</button></div>}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          <div className="flex justify-between items-center">
            <span className="text-xs text-slate-400 font-semibold">
              {lang === 'zh' ? `当前管理 ${channels.filter((channel) => channel.type !== 'hosted_site').length} 个分发端点` : `${channels.filter((channel) => channel.type !== 'hosted_site').length} endpoints`}
            </span>
            <button
              onClick={() => setIsModalOpen(true)}
              disabled={!canWrite}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-purple-600 hover:bg-purple-500 text-white shadow-lg shadow-purple-600/20 transition"
            >
              <Plus className="w-4 h-4" />
              <span>{lang === 'zh' ? '添加分发节点' : 'Add Endpoint'}</span>
            </button>
          </div>

          {/* Distribution Channels Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {!canRead ? <div className="md:col-span-3 text-center py-8 text-xs text-slate-500">{lang === 'zh' ? '没有分发渠道读取权限' : 'Distribution read access is not granted'}</div> : channels.filter((channel) => channel.type !== 'hosted_site').map((channel) => {
              const isSyncing = syncingId === channel.id || channel.status === 'syncing';
              return (
                <div
                  key={channel.id}
                  className="bg-slate-900/80 border border-slate-800 rounded-2xl p-5 flex flex-col justify-between space-y-4 hover:border-slate-700 transition"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="text-[10px] px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 font-bold border border-purple-500/20">
                          {channel.type === 'tongzhuo_geo_agent' ? '桐灼GEO Agent' : channel.type === 'wordpress_rest' ? 'WordPress REST' : channel.type === 'hosted_site' ? 'Hosted Site' : 'HTTP API'}
                        </span>
                        <h3 className="text-sm font-bold text-white mt-1.5 line-clamp-1">{channel.name}</h3>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border flex items-center gap-1 ${
                        channel.status === 'active'
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          : channel.status === 'deleting'
                            ? 'bg-rose-500/10 text-rose-300 border-rose-500/20'
                            : 'bg-amber-500/10 text-amber-300 border-amber-500/20'
                      }`}>
                        <CheckCircle2 className="w-2.5 h-2.5" />
                        <span>{({
                          active: '启用',
                          paused: '暂停',
                          deleting: '删除中',
                          disconnected: '断开',
                          syncing: '同步中',
                        } as Record<DistributionChannel['status'], string>)[channel.status]}</span>
                      </span>
                    </div>

                    <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800 text-xs space-y-1.5">
                      <div className="text-slate-400 truncate">
                        <span className="text-slate-400">{lang === 'zh' ? '目标 URL' : 'Target URL'}:</span>{' '}
                        <span className="text-slate-200 font-mono text-[11px]">{channel.targetUrl}</span>
                      </div>
                      <div className="flex justify-between text-slate-400">
                        <span>{lang === 'zh' ? '鉴权方式' : 'Auth'}:</span>
                        <span className="text-slate-300 font-mono">{channel.authMethod}</span>
                      </div>
                      <div className="flex justify-between text-slate-400 pt-1 border-t border-slate-800">
                        <span>{lang === 'zh' ? '累计接收' : 'Total Pushed'}:</span>
                        <strong className="text-purple-400 font-mono">{channel.articlesCount} {lang === 'zh' ? '篇' : 'arts'}</strong>
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-slate-800 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-slate-400">
                        {lang === 'zh' ? '最后同步' : 'Last sync'}: {channel.lastSyncedAt ? channel.lastSyncedAt.split(' ')[0] : '—'}
                      </span>
                      <button
                        onClick={() => void handleSync(channel.id)}
                        disabled={isSyncing || !canRead}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-white disabled:opacity-50 transition border border-slate-700"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin text-purple-400' : 'text-slate-300'}`} />
                        <span>{isSyncing ? (lang === 'zh' ? '检查中...' : 'Checking...') : (lang === 'zh' ? '健康检查' : 'Health check')}</span>
                      </button>
                    </div>
                    {apiMode && canWrite && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {onSetChannelStatus && channel.status !== 'deleting' && (
                          <button
                            type="button"
                            disabled={busyAction === `status-${channel.id}`}
                            onClick={() => void runChannelAction(`status-${channel.id}`, () => onSetChannelStatus(channel.id, channel.status !== 'active'), channel.status === 'active' ? '暂停渠道失败' : '启用渠道失败')}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-semibold text-slate-200 disabled:opacity-50"
                          >
                            {channel.status === 'active' ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                            {channel.status === 'active' ? '暂停' : '启用'}
                          </button>
                        )}
                        {onUpdateChannel && channel.status !== 'deleting' && (
                          <button type="button" onClick={() => beginEdit(channel)} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-semibold text-slate-200">
                            <Pencil className="h-3 w-3" />编辑
                          </button>
                        )}
                        {onRotateChannelSecret && canManageSecrets && channel.type === 'tongzhuo_geo_agent' && channel.status !== 'deleting' && (
                          <button
                            type="button"
                            disabled={busyAction === `rotate-${channel.id}`}
                            onClick={() => void runChannelAction(`rotate-${channel.id}`, async () => {
                              const secret = await onRotateChannelSecret(channel.id);
                              if (secret) setOneTimeSecret(secret);
                            }, '轮换密钥失败')}
                            className="inline-flex items-center gap-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-200 disabled:opacity-50"
                          >
                            <Key className="h-3 w-3" />轮换密钥
                          </button>
                        )}
                        {onRevealChannelSecret && canManageSecrets && channel.status !== 'deleting' && (
                          <button type="button" onClick={() => { setSecretPassword(''); setSecretPrompt({ id: channel.id, purpose: 'reveal' }); }} className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-semibold text-slate-200">
                            <Key className="h-3 w-3" />查看密钥
                          </button>
                        )}
                        {onDownloadChannelPackage && canManageSecrets && channel.type === 'tongzhuo_geo_agent' && channel.status !== 'deleting' && (
                          <button type="button" onClick={() => { setSecretPassword(''); setSecretPrompt({ id: channel.id, purpose: 'package' }); }} className="inline-flex items-center gap-1 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[10px] font-semibold text-cyan-200">
                            <Download className="h-3 w-3" />接入包
                          </button>
                        )}
                        {onRefreshChannelCapabilities && canWrite && channel.status !== 'deleting' && (
                          <button
                            type="button"
                            disabled={busyAction === `capabilities-${channel.id}`}
                            onClick={() => void runChannelAction(`capabilities-${channel.id}`, () => onRefreshChannelCapabilities(channel.id), '刷新前端能力失败')}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-semibold text-slate-200 disabled:opacity-50"
                          >
                            <RefreshCw className="h-3 w-3" />刷新能力
                          </button>
                        )}
                        {onPreviewChannelDeletion && onDeleteChannel && canManageDestructive && (
                          <button
                            type="button"
                            disabled={busyAction === `preview-delete-${channel.id}`}
                            onClick={() => void beginDelete(channel)}
                            className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[10px] font-semibold text-rose-200 disabled:opacity-50"
                          >
                            <Trash2 className="h-3 w-3" />删除
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {apiMode && (onPreviewSettingsSync || onSyncSettings) && (
            <div className="bg-slate-900/80 rounded-2xl border border-slate-800 p-5 space-y-3">
              <div>
                <h3 className="text-sm font-bold text-white">{lang === 'zh' ? '站点设置同步到渠道前端' : 'Sync site settings to channel frontends'}</h3>
                <p className="mt-1 text-[11px] text-slate-400">
                  {lang === 'zh'
                    ? '改了站点信息、主题或首页编排后，要推到各渠道前端才生效。先预览、再同步——预览和执行必须用同一个范围。'
                    : 'After changing site info, theme or homepage composition, push it to channel frontends. Preview first, and use the same scope for both.'}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-300">
                <label className="inline-flex items-center gap-1.5">
                  <input type="radio" checked={syncScope === 'all'} onChange={() => { setSyncScope('all'); setSyncPreview(null); setSyncConfirmed(false); }} className="accent-purple-500" />
                  {lang === 'zh' ? '全部可同步渠道' : 'All syncable channels'}
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input type="radio" checked={syncScope === 'selected'} onChange={() => { setSyncScope('selected'); setSyncPreview(null); setSyncConfirmed(false); }} className="accent-purple-500" />
                  {lang === 'zh' ? '选定渠道' : 'Selected channels'}
                </label>
                {syncScope === 'selected' && (
                  <span className="flex flex-wrap gap-2">
                    {channels.map((channel) => (
                      <label key={channel.id} className="inline-flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={syncSelected.has(channel.id)}
                          onChange={() => setSyncSelected((previous) => {
                            const next = new Set(previous);
                            if (next.has(channel.id)) next.delete(channel.id); else next.add(channel.id);
                            return next;
                          })}
                          className="accent-purple-500"
                        />
                        {channel.name}
                      </label>
                    ))}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busyAction === 'sync-preview' || (syncScope === 'selected' && syncSelected.size === 0) || !onPreviewSettingsSync}
                  onClick={() => void runChannelAction('sync-preview', async () => {
                    const report = await onPreviewSettingsSync?.(syncScope, Array.from(syncSelected));
                    setSyncPreview(report ?? null);
                    setSyncConfirmed(false);
                  }, '同步预览失败')}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-[11px] font-semibold text-slate-200 disabled:opacity-50"
                >
                  <RefreshCw className="h-3 w-3" />{lang === 'zh' ? '预览' : 'Preview'}
                </button>
                <label className="inline-flex items-center gap-1.5 text-[11px] text-amber-200">
                  <input type="checkbox" checked={syncConfirmed} onChange={(event) => setSyncConfirmed(event.target.checked)} className="accent-amber-500" />
                  {lang === 'zh' ? '我已查看预览并确认前台体验风险' : 'I reviewed the preview and accept the frontend risk'}
                </label>
                <button
                  type="button"
                  disabled={busyAction === 'sync-run' || !syncConfirmed || (syncScope === 'selected' && syncSelected.size === 0) || !onSyncSettings}
                  onClick={() => void runChannelAction('sync-run', async () => {
                    const result = await onSyncSettings?.(syncScope, Array.from(syncSelected), syncConfirmed);
                    setSyncResult(result ?? null);
                  }, '同步失败')}
                  className="inline-flex items-center gap-1 rounded-lg bg-purple-600 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-purple-500 disabled:opacity-50"
                >
                  {lang === 'zh' ? '执行同步' : 'Sync now'}
                </button>
              </div>

              {syncPreview && <pre className="max-h-40 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-[10px] text-slate-400">{JSON.stringify(syncPreview, null, 2)}</pre>}
              {syncResult && <pre className="max-h-40 overflow-auto rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-3 text-[10px] text-emerald-200">{JSON.stringify(syncResult, null, 2)}</pre>}
            </div>
          )}

          {apiMode && (
            <div className="bg-slate-900/80 rounded-2xl border border-slate-800 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-white">真实分发任务与回执</h3>
                  <p className="text-[11px] text-slate-400 mt-1">队列状态来自 桐灼GEO 后端；“已同步”才代表远端回执已确认。</p>
                </div>
                <span className="text-[11px] text-slate-500">{distributionJobs.length} 条</span>
              </div>
              {distributionJobs.length === 0 ? (
                <div className="px-5 py-8 text-center text-xs text-slate-500">暂无分发任务</div>
              ) : (
                <div className="divide-y divide-slate-800">
                  {distributionJobs.map((job) => {
                    const article = job.article && typeof job.article === 'object' ? job.article as Record<string, unknown> : {};
                    const channel = job.channel && typeof job.channel === 'object' ? job.channel as Record<string, unknown> : {};
                    const status = String(job.status || 'unknown');
                    const retryable = status === 'failed' || status === 'queued';
                    const statusLabel: Record<string, string> = {
                      queued: '排队中', sending: '发送中', synced: '已同步', failed: '失败', outcome_unknown: '待对账',
                    };
                    return (
                      <div key={String(job.id)} className="px-5 py-3 flex flex-col md:flex-row md:items-center gap-3 md:gap-5">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-semibold text-slate-200 truncate">{String(article.title || `文章 #${job.article_id || '—'}`)}</div>
                          <div className="text-[11px] text-slate-500 mt-1 truncate">{String(channel.name || channel.domain || `渠道 #${job.channel_id || '—'}`)}</div>
                        </div>
                        <div className="flex items-center gap-2 text-[11px]">
                          {status === 'failed' ? <AlertCircle className="w-3.5 h-3.5 text-rose-400" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                          <span className={status === 'failed' ? 'text-rose-300' : status === 'synced' ? 'text-emerald-300' : 'text-amber-300'}>{statusLabel[status] || status}</span>
                        </div>
                        <div className="text-[11px] text-slate-500 md:w-48 truncate" title={String(job.last_error_message || '')}>
                          {status === 'failed' ? String(job.last_error_message || '远端返回失败') : String(job.remote_url || job.remote_id || '等待 Worker 回执')}
                        </div>
                        {retryable && onRetryDistribution && canWrite && (
                          <button
                            type="button"
                            onClick={() => void handleRetry(String(job.id))}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                          >
                            <RotateCcw className="w-3.5 h-3.5" /> 重试
                          </button>
                        )}
                        {canWrite && onUpdateDistributionJob && onLoadArticleSnapshot && (
                          <button
                            type="button"
                            onClick={() => void openJobEdit(String(job.id), String(job.article_id || ''))}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                          >
                            <Pencil className="w-3.5 h-3.5" /> 修正
                          </button>
                        )}
                        {canWrite && onDeleteDistributionJob && (
                          <button
                            type="button"
                            onClick={() => void runChannelAction(`job-delete-${job.id}`, () => onDeleteDistributionJob(String(job.id)), '删除分发记录失败')}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold bg-rose-500/10 hover:bg-rose-500/20 text-rose-200 border border-rose-500/30"
                          >
                            <Trash2 className="w-3.5 h-3.5" /> 删除
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Deployment availability banner */}
          {!apiMode && <div className="bg-slate-900/80 p-5 rounded-2xl border border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400">
                <Shield className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-white">Agent 安装包由后端管理</h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  当前部署实例尚未提供签名安装包下载；前端不会生成密钥或可执行脚本。
                </p>
              </div>
            </div>
            <button
              onClick={() => setActiveTab('deployment')}
              className="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200 border border-slate-700 transition shrink-0"
            >
              查看状态
            </button>
          </div>}
        </>
      ) : (
          <div className="lg:col-span-8 bg-slate-900/80 p-6 rounded-2xl border border-slate-800 space-y-5">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-300 shrink-0">
                <Shield className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-bold text-white">{lang === 'zh' ? 'Agent 部署状态' : 'Agent deployment status'}</h2>
                <p className="text-xs text-slate-400 mt-1">
                  {lang === 'zh'
                    ? '安装包、签名密钥和版本信息必须由 桐灼GEO 后端签发；当前前端不会生成或下载可执行脚本。'
                    : 'Packages, signing credentials, and versions must be issued by the 桐灼GEO backend. This UI does not generate or download executable scripts.'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-slate-500">{lang === 'zh' ? '安装包接口' : 'Package endpoint'}</div>
                <div className="mt-2 font-semibold text-amber-300">{lang === 'zh' ? '尚未提供' : 'Not available'}</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-slate-500">{lang === 'zh' ? '签名密钥' : 'Signing secret'}</div>
                <div className="mt-2 font-semibold text-amber-300">{lang === 'zh' ? '仅由后端签发' : 'Backend-issued only'}</div>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="text-slate-500">{lang === 'zh' ? '校验摘要' : 'Checksum'}</div>
                <div className="mt-2 font-semibold text-amber-300">{lang === 'zh' ? '等待后端接口' : 'Awaiting backend API'}</div>
              </div>
            </div>

            <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 text-xs leading-relaxed text-blue-200">
              {lang === 'zh'
                ? '可以先在“已连入站点节点”中创建渠道并使用后端返回的一次性凭据。关闭一次性凭据提示后，密钥不会再次显示。待后端提供带版本和校验摘要的安装包接口后，再开放下载。'
                : 'You can create a channel from Connected Sites and use the one-time credentials returned by the backend. Once dismissed, the secret is not shown again. Downloads will be enabled after the backend exposes a versioned package and checksum endpoint.'}
            </div>
          </div>
      )}

      {hostedModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <form onSubmit={(event) => void submitHosted(event)} className="max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-2xl border border-cyan-500/30 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="flex items-center gap-2 text-base font-bold text-white"><Globe2 className="h-5 w-5 text-cyan-300" />{hostedModal === 'edit' ? '编辑 Hosted Site' : '新增 Hosted Site'}</h3>
              <button type="button" onClick={() => setHostedModal(null)} className="text-slate-400 hover:text-white">✕</button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {([
                ['name', '站点名称', 'text'], ['hostname', '托管域名', 'text'], ['topic', '主题', 'text'],
                ['locale', 'Locale', 'text'], ['timezone', '时区', 'text'], ['template_key', '模板 Key', 'text'],
                ['daily_publish_limit', '每日发布上限', 'number'], ['publish_weight', '发布权重', 'number'],
                ['min_publish_interval_minutes', '最小发布间隔（分钟）', 'number'], ['min_articles_before_index', '允许索引前最少文章', 'number'],
                ['contact_email', '联系邮箱', 'email'], ['lead_form_slugs', 'Lead Form Slugs（逗号分隔）', 'text'],
              ] as Array<[string, string, string]>).map(([key, label, type]) => (
                <label key={key} className="text-[11px] font-semibold text-slate-300">{label}
                  <input required={['name', 'hostname', 'topic', 'locale', 'timezone', 'template_key'].includes(key)} type={type} value={hostedDraft[key] || ''} onChange={(event) => setHostedDraft((current) => ({ ...current, [key]: event.target.value }))} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none" />
                </label>
              ))}
              <label className="text-[11px] font-semibold text-slate-300 sm:col-span-2">站点描述
                <textarea value={hostedDraft.site_description || ''} onChange={(event) => setHostedDraft((current) => ({ ...current, site_description: event.target.value }))} rows={2} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none" />
              </label>
              <label className="text-[11px] font-semibold text-slate-300 sm:col-span-2">About 内容
                <textarea value={hostedDraft.about_content || ''} onChange={(event) => setHostedDraft((current) => ({ ...current, about_content: event.target.value }))} rows={3} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none" />
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-800 pt-3">
              <button type="button" onClick={() => setHostedModal(null)} className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300">取消</button>
              <button type="submit" disabled={hostedBusy === 'save'} className="rounded-lg bg-cyan-600 px-4 py-1.5 text-xs font-bold text-white disabled:opacity-50">{hostedBusy === 'save' ? '保存中...' : '保存 Hosted Site'}</button>
            </div>
          </form>
        </div>
      )}

      {/* New Channel Modal */}
      {oneTimeSecret && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-amber-500/30 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-2 text-amber-300 font-bold"><Key className="w-5 h-5" />{lang === 'zh' ? '渠道密钥仅显示这一次' : 'One-time channel secret'}</div>
            <p className="text-xs text-slate-400">{lang === 'zh' ? '请立即复制并保存。后端只保存加密密文，关闭后无法再次查看。' : 'Copy it now. The backend stores only ciphertext and cannot show it again.'}</p>
            <div className="space-y-2 text-xs">
              <div className="text-slate-400">Key ID</div>
              <code className="block bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-200 break-all">{oneTimeSecret.key_id}</code>
              <div className="text-slate-400">Secret</div>
              <code className="block bg-slate-950 border border-slate-800 rounded-xl p-3 text-amber-200 break-all">{oneTimeSecret.secret}</code>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => navigator.clipboard?.writeText(`${oneTimeSecret.key_id}\n${oneTimeSecret.secret}`)} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200">{lang === 'zh' ? '复制密钥' : 'Copy credentials'}</button>
              <button type="button" onClick={() => setOneTimeSecret(null)} className="px-4 py-1.5 rounded-lg text-xs font-bold bg-purple-600 hover:bg-purple-500 text-white">{lang === 'zh' ? '我已保存' : 'I saved it'}</button>
            </div>
          </div>
        </div>
      )}

      {jobEdit && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const draft = jobEdit;
              setJobEdit(null);
              void runChannelAction(`job-save-${draft.id}`, () => onUpdateDistributionJob?.(draft.id, {
                title: draft.title,
                excerpt: draft.excerpt,
                content: draft.content,
                keywords: draft.keywords,
                meta_description: draft.meta_description,
              }) ?? Promise.resolve(), '修正分发内容失败');
            }}
            className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 space-y-3 shadow-2xl"
          >
            <div className="flex items-center gap-2 text-white font-bold"><Pencil className="w-4 h-4" />{lang === 'zh' ? '修正这条分发的内容' : 'Correct this distribution'}
            </div>
            <p className="text-[11px] text-slate-400">
              {lang === 'zh'
                ? '这里改的是**这次分发推出去的内容快照**，不会改动文章本身。改完需要重新分发才生效。'
                : 'This edits the content snapshot for this distribution only; the article itself is untouched.'}
            </p>
            <label className="block text-[11px] text-slate-400">
              {lang === 'zh' ? '标题' : 'Title'}
              <input value={jobEdit.title} onChange={(event) => setJobEdit({ ...jobEdit, title: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white" />
            </label>
            <label className="block text-[11px] text-slate-400">
              {lang === 'zh' ? '摘要' : 'Excerpt'}
              <input value={jobEdit.excerpt} onChange={(event) => setJobEdit({ ...jobEdit, excerpt: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white" />
            </label>
            <label className="block text-[11px] text-slate-400">
              {lang === 'zh' ? '正文' : 'Content'}
              <textarea required rows={10} value={jobEdit.content} onChange={(event) => setJobEdit({ ...jobEdit, content: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-xs text-white" />
            </label>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="block text-[11px] text-slate-400">
                {lang === 'zh' ? '关键词' : 'Keywords'}
                <input value={jobEdit.keywords} onChange={(event) => setJobEdit({ ...jobEdit, keywords: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white" />
              </label>
              <label className="block text-[11px] text-slate-400">
                {lang === 'zh' ? '描述' : 'Meta description'}
                <input value={jobEdit.meta_description} onChange={(event) => setJobEdit({ ...jobEdit, meta_description: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-white" />
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setJobEdit(null)} className="rounded-lg px-3 py-1.5 text-xs font-bold text-slate-400">{lang === 'zh' ? '取消' : 'Cancel'}</button>
              <button type="submit" disabled={jobEdit.title.trim() === '' || jobEdit.content.trim() === ''} className="rounded-lg bg-purple-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-purple-500 disabled:opacity-50">{lang === 'zh' ? '保存修正' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      {secretPrompt && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const prompt = secretPrompt;
              const password = secretPassword;
              setSecretPrompt(null);
              setSecretPassword('');
              if (prompt.purpose === 'reveal') {
                void runChannelAction(`reveal-${prompt.id}`, async () => {
                  const revealed = await onRevealChannelSecret?.(prompt.id, password);
                  if (revealed) setOneTimeSecret({ key_id: revealed.key_id, secret: revealed.secret });
                }, '查看密钥失败');
              } else {
                void runChannelAction(`package-${prompt.id}`, () => onDownloadChannelPackage?.(prompt.id, password) ?? Promise.resolve(), '接入包下载失败');
              }
            }}
            className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-center gap-2 text-white font-bold"><Key className="w-5 h-5" />{lang === 'zh' ? '需要二次验证' : 'Confirm your password'}</div>
            <p className="text-xs text-slate-400">
              {secretPrompt.purpose === 'reveal'
                ? (lang === 'zh' ? '查看渠道密钥的明文属于敏感操作，需要重新输入你的登录密码。' : 'Revealing the plaintext channel secret requires your login password.')
                : (lang === 'zh' ? '接入包里含有可用密钥，需要重新输入你的登录密码。' : 'The package contains a usable secret; re-enter your login password.')}
            </p>
            <label className="block text-xs text-slate-400">
              {lang === 'zh' ? '登录密码' : 'Password'}
              <input
                type="password"
                autoFocus
                value={secretPassword}
                onChange={(event) => setSecretPassword(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { setSecretPrompt(null); setSecretPassword(''); }} className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-400">{lang === 'zh' ? '取消' : 'Cancel'}</button>
              <button type="submit" disabled={secretPassword === ''} className="px-4 py-1.5 rounded-lg text-xs font-bold bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-50">{lang === 'zh' ? '确认' : 'Confirm'}</button>
            </div>
          </form>
        </div>
      )}

      {editingId && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form
            onSubmit={(event) => { event.preventDefault(); void saveEdit(); }}
            className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2"><Pencil className="h-4 w-4 text-purple-400" />编辑分发渠道</h3>
              <button type="button" onClick={() => setEditingId(null)} className="text-slate-400 hover:text-slate-200">✕</button>
            </div>
            <label className="block text-xs text-slate-400">渠道名称
              <input required value={editName} onChange={(event) => setEditName(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white" />
            </label>
            <label className="block text-xs text-slate-400">目标端点 URL
              <input required type="url" value={editUrl} onChange={(event) => setEditUrl(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white" />
            </label>
            <label className="block text-xs text-slate-400">描述
              <textarea value={editDescription} onChange={(event) => setEditDescription(event.target.value)} rows={3} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white" />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditingId(null)} className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300">取消</button>
              <button type="submit" disabled={busyAction.startsWith('edit-')} className="rounded-lg bg-purple-600 px-4 py-1.5 text-xs font-bold text-white disabled:opacity-50">保存</button>
            </div>
          </form>
        </div>
      )}

      {deleteState && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <section className="bg-slate-900 border border-rose-500/30 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-rose-200 flex items-center gap-2"><Trash2 className="h-4 w-4" />删除分发渠道</h3>
              <button type="button" onClick={() => setDeleteState(null)} className="text-slate-400 hover:text-slate-200">✕</button>
            </div>
            <p className="text-xs leading-5 text-slate-300">删除会解除任务关联、移除本地分发记录和凭据；远端已发布内容不会被自动删除。请先准备删除，再完成确认。</p>
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-[11px] text-slate-400">
              <span>关联任务：<strong className="text-slate-200">{String(deleteState.impact.linked_task_count || 0)}</strong></span>
              <span>远端内容：<strong className="text-slate-200">{String(deleteState.impact.remote_content_count || 0)}</strong></span>
              <span>凭据：<strong className="text-slate-200">{String(deleteState.impact.secret_count || 0)}</strong></span>
              <span>进行中：<strong className="text-slate-200">{String(Number(deleteState.impact.fresh_sending_count || 0) + Number(deleteState.impact.fresh_operation_count || 0))}</strong></span>
            </div>
            {!deleteState.prepared ? (
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setDeleteState(null)} className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300">取消</button>
                {onPrepareChannelDeletion && <button type="button" onClick={() => void prepareDelete()} disabled={busyAction.startsWith('prepare-delete-')} className="rounded-lg bg-rose-600 px-4 py-1.5 text-xs font-bold text-white disabled:opacity-50">准备删除</button>}
              </div>
            ) : (
              <div className="space-y-3">
                <label className="block text-xs text-slate-400">输入渠道名称确认
                  <input value={deleteState.confirmationName} onChange={(event) => setDeleteState((current) => current ? { ...current, confirmationName: event.target.value } : current)} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white" placeholder={channels.find((channel) => channel.id === deleteState.id)?.name || ''} />
                </label>
                {Number(deleteState.impact.remote_content_count || 0) > 0 && <label className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={deleteState.ackRemote} onChange={(event) => setDeleteState((current) => current ? { ...current, ackRemote: event.target.checked } : current)} />确认远端内容影响</label>}
                {Number(deleteState.impact.linked_task_count || 0) > 0 && <label className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={deleteState.ackTasks} onChange={(event) => setDeleteState((current) => current ? { ...current, ackTasks: event.target.checked } : current)} />确认任务关联影响</label>}
                {Number(deleteState.impact.secret_count || 0) > 0 && <label className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={deleteState.ackCredentials} onChange={(event) => setDeleteState((current) => current ? { ...current, ackCredentials: event.target.checked } : current)} />确认凭据失效影响</label>}
                <label className="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={deleteState.ackHistory} onChange={(event) => setDeleteState((current) => current ? { ...current, ackHistory: event.target.checked } : current)} />确认历史记录将被清理</label>
                {Number(deleteState.impact.stale_sending_count || 0) > 0 && <label className="flex items-center gap-2 text-xs text-amber-200"><input type="checkbox" checked={deleteState.forceSending} onChange={(event) => setDeleteState((current) => current ? { ...current, forceSending: event.target.checked } : current)} />确认处理过期发送任务</label>}
                {Number(deleteState.impact.stale_operation_count || 0) > 0 && <label className="flex items-center gap-2 text-xs text-amber-200"><input type="checkbox" checked={deleteState.forceOperations} onChange={(event) => setDeleteState((current) => current ? { ...current, forceOperations: event.target.checked } : current)} />确认处理过期操作租约</label>}
                {/*
                  删除确认的校验错误必须显示在**弹窗内部**。
                  原先 completeDelete() 只调 setActionError()，而那处渲染在页面顶部的
                  502 行——位于本弹窗 z-50 的全屏遮罩后面，用户完全看不到：
                  输错渠道名点「永久删除」时表现为「按钮点了没反应」。
                */}
                {actionError && (
                  <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
                    {actionError}
                  </div>
                )}
                <div className="flex justify-end gap-2 pt-2">
                  <button type="button" onClick={() => void cancelDelete()} className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300">{lang === 'zh' ? '取消删除' : 'Cancel deletion'}</button>
                  <button type="button" onClick={() => void completeDelete()} disabled={busyAction.startsWith('delete-')} className="rounded-lg bg-rose-600 px-4 py-1.5 text-xs font-bold text-white disabled:opacity-50">{lang === 'zh' ? '永久删除' : 'Delete permanently'}</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {isModalOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <form
            onSubmit={handleSubmit}
            className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Radio className="w-5 h-5 text-purple-500" />
                <span>{lang === 'zh' ? '添加分发目标节点' : 'Add Distribution Channel'}</span>
              </h3>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 text-sm"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">
                  {lang === 'zh' ? '节点名称' : 'Channel Name'} *
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-purple-500 transition"
                  placeholder="e.g. 亚太独立站官网 GEO 频道"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">
                  {lang === 'zh' ? '渠道类型' : 'Channel Type'}
                </label>
                <select
                  value={apiMode ? 'tongzhuo_geo_agent' : type}
                  disabled={apiMode}
                  onChange={(e: any) => setType(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-purple-500 transition"
                >
                  <option value="tongzhuo_geo_agent">桐灼GEO Agent (PHP / Static Site)</option>
                  <option value="wordpress_rest">WordPress REST API</option>
                  <option value="generic_http">Generic Webhook / HTTP API</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">
                  {lang === 'zh' ? '目标端点 URL' : 'Target Endpoint URL'} *
                </label>
                <input
                  type="url"
                  required
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-purple-500 transition"
                  placeholder="https://mysite.com/agent.php"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-300">
                  {lang === 'zh' ? '认证秘钥方式' : 'Authentication Method'}
                </label>
                <input
                  type="text"
                  value={authMethod}
                  onChange={(e) => setAuthMethod(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-purple-500 transition"
                />
              </div>
            </div>

            <div className="pt-3 border-t border-slate-800 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300"
              >
                {lang === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !canWrite}
                className="px-4 py-1.5 rounded-lg text-xs font-bold bg-purple-600 hover:bg-purple-500 text-white shadow-sm"
              >
                {isSubmitting ? (lang === 'zh' ? '保存中...' : 'Saving...') : (lang === 'zh' ? '保存节点' : 'Save Endpoint')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
