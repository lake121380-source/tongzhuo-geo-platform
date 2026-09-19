import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, DataTable, EmptyState, Field, Input, TrendChart, useConfirm, useToast } from './ui';
import type { DataTableColumn } from './ui';
import { LoadingState } from './LoadingState';
import { PageHeader } from './PageHeader';
import {
  GeoFlowApiClient,
  type ApiRecord,
  type JianduConnectionProjection,
  type JianduSourceMeta,
} from '../api/geoflowClient';
import { describeApiError, hasScope } from '../api/permissions';
import type { ScopeSource } from '../api/permissions';
import { AlertTriangle, FileText, Link2, LogOut, RefreshCw, ScanSearch, TrendingUp, Unplug } from 'lucide-react';

/**
 * 「见度检测」页：把外部**见度GEO 检测系统**的数据接进本后台。
 *
 * 两条状态：
 *  · 未连接 —— 输入见度账号密码（新设备可能要求验证码，两步式）；
 *  · 已连接 —— 按项目展示提及率概览与检测批次。
 *
 * 设计纪律：
 *  · 凭据只进本系统后端（浏览器不接触见度 token），页面拿到的连接投影里连密文都没有；
 *  · 页面上**如实标注数据来源**（见度系统、拉取时间）——两套系统的口径不同，
 *    混在一起说会误导；`source` 字段就是给这行标注用的；
 *  · 「没有数据」与「数据是 0」严格区分：缺失值显示「—」，不画 0。
 */

interface JianduViewProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  scopes: ScopeSource;
}

interface JianduProject {
  id: string;
  name: string;
  brand_name: string;
  industry: string;
}

function record(value: unknown): ApiRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ApiRecord) : {};
}

function list(value: unknown): ApiRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is ApiRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

/** 见度比率是 0-100 的数值；缺失（undefined/null/NaN）显示「—」而不是 0。 */
function displayPercent(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric}%` : '—';
}

function displayCount(value: unknown): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(numeric) : '—';
}

function displayTime(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  if (!text) return '—';
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toLocaleString();
}

export const JianduView: React.FC<JianduViewProps> = ({ apiClient, lang, scopes }) => {
  const zh = lang === 'zh';
  const toast = useToast();
  const confirm = useConfirm();

  const canRead = hasScope(scopes, 'jiandu:read');
  const canWrite = hasScope(scopes, 'jiandu:write');

  const [booted, setBooted] = useState(false);
  const [connection, setConnection] = useState<JianduConnectionProjection | null>(null);
  const [bootError, setBootError] = useState('');

  // 连接表单
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [challenge, setChallenge] = useState<{ channel: 'sms' | 'email'; message: string } | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);

  // 数据视图
  const [projects, setProjects] = useState<JianduProject[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [range, setRange] = useState<'30d' | '90d'>('30d');
  const [overview, setOverview] = useState<ApiRecord | null>(null);
  const [detections, setDetections] = useState<ApiRecord[]>([]);
  const [reports, setReports] = useState<ApiRecord[]>([]);
  const [reportsError, setReportsError] = useState('');
  const [me, setMe] = useState<ApiRecord | null>(null);
  const [source, setSource] = useState<JianduSourceMeta | null>(null);
  const [dataBusy, setDataBusy] = useState(false);
  const [dataError, setDataError] = useState('');
  const [reconnectNotice, setReconnectNotice] = useState('');
  const [codeCooldown, setCodeCooldown] = useState(0);

  const failText = useCallback(
    (reason: unknown, fallback: string): string => describeApiError(reason, fallback, lang),
    [lang],
  );

  /** 发码冷却：见度侧的窗口是 60 秒，倒计时期间禁用「重新发送」而不是让用户撞一次 429。 */
  useEffect(() => {
    if (codeCooldown <= 0) return;
    const timer = window.setInterval(() => setCodeCooldown((value) => (value <= 1 ? 0 : value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [codeCooldown]);

  /**
   * 退出并重新登录。
   *
   * 为「旧登录态缺新权限」准备的：scope 在登录时下发，功能上线前建立的会话
   * 不会带上 `jiandu:*`——重登一次即生效，比让用户去翻「联系管理员」快得多。
   */
  const relogin = useCallback(async () => {
    try {
      await apiClient.logout();
    } catch {
      // 会话可能已经失效——登出失败无所谓，本地凭证在 logout() 里必然被清掉。
    }
    window.location.reload();
  }, [apiClient]);

  const loadStatus = useCallback(async () => {
    setBootError('');
    try {
      const result = await apiClient.getJianduStatus();
      setConnection(result.connection);
    } catch (reason) {
      setBootError(failText(reason, zh ? '连接状态加载失败' : 'Failed to load connection status'));
    } finally {
      setBooted(true);
    }
  }, [apiClient, failText, zh]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  /** 已连接后拉项目列表；项目的字段由后端投影过（只给 id/名称/品牌/行业）。 */
  const loadProjects = useCallback(async () => {
    try {
      const result = await apiClient.getJianduProjects();
      setProjects(result.projects);
      setProjectId((current) => (current && result.projects.some((item) => item.id === current) ? current : result.projects[0]?.id || ''));
      setSource(result.source || null);
    } catch (reason) {
      setProjects([]);
      const message = failText(reason, zh ? '见度项目列表加载失败' : 'Failed to load Jiandu projects');
      // 「连接失效需重连」不是页面级错误，而是连接态的变更——引导用户重连。
      if (isReconnectRequired(reason)) {
        setReconnectNotice(message);
        void loadStatus();
        return;
      }
      setDataError(message);
    }
  }, [apiClient, failText, loadStatus, zh]);

  useEffect(() => {
    if (connection) {
      void loadProjects();
    } else {
      setProjects(null);
      setProjectId('');
      setOverview(null);
      setDetections([]);
      setReports([]);
      setReportsError('');
      setMe(null);
      setSource(null);
    }
  }, [connection, loadProjects]);

  /**
   * 概览 + 检测批次 + 报告 + 账号额度一起拉。
   *
   * **只有概览与批次参与整屏成败**：报告有见度侧的套餐特性门禁（403 是能力边界，
   * 不是故障），额度失败也只影响信息条——都不能把已经拿到的提及率打没。
   */
  const loadData = useCallback(async (selectedProjectId: string, selectedRange: '30d' | '90d') => {
    if (!selectedProjectId) return;
    setDataBusy(true);
    setDataError('');
    setReportsError('');
    try {
      const [overviewResult, detectionsResult, reportsResult, meResult] = await Promise.all([
        apiClient.getJianduOverview({ project_id: selectedProjectId, range: selectedRange }),
        apiClient.getJianduDetections({ project_id: selectedProjectId, page: 1, page_size: 20 }),
        apiClient.getJianduReports({ project_id: selectedProjectId, page: 1, page_size: 10 })
          .catch((reason: unknown) => {
            setReports([]);
            setReportsError(failText(reason, zh ? '报告加载失败' : 'Failed to load reports'));
            return null;
          }),
        apiClient.getJianduMe().catch(() => null),
      ]);
      setOverview(overviewResult.overview || null);
      setDetections(list(record(detectionsResult.detections).items));
      setReports(reportsResult ? list(record(reportsResult.reports).items) : []);
      if (meResult) setMe(meResult.account || null);
      setSource(overviewResult.source || detectionsResult.source || reportsResult?.source || null);
    } catch (reason) {
      const message = failText(reason, zh ? '见度数据加载失败' : 'Failed to load Jiandu data');
      if (isReconnectRequired(reason)) {
        setReconnectNotice(message);
        setOverview(null);
        setDetections([]);
        setReports([]);
        setReportsError('');
        setMe(null);
        void loadStatus();
      } else {
        setDataError(message);
      }
    } finally {
      setDataBusy(false);
    }
  }, [apiClient, failText, loadStatus, zh]);

  useEffect(() => {
    if (connection && projectId) {
      void loadData(projectId, range);
    }
  }, [connection, projectId, range, loadData]);

  const sendCode = useCallback(async (channel: 'sms' | 'email') => {
    if (codeBusy) return;
    setCodeBusy(true);
    try {
      const result = await apiClient.sendJianduCode({ channel, account: account.trim() });
      setCodeCooldown(60);
      toast.success(
        zh ? '验证码已发送' : 'Code sent',
        result.message || (channel === 'sms'
          ? (zh ? '请查收短信，输入 6 位验证码后再次提交。' : 'Check the SMS and submit the code.')
          : (zh ? '请查收邮件，输入验证码后再次提交。' : 'Check the email and submit the code.')),
      );
    } catch (reason) {
      toast.error(
        zh ? '验证码发送失败' : 'Failed to send code',
        failText(reason, zh ? '请稍后重试' : 'Please retry later'),
      );
    } finally {
      setCodeBusy(false);
    }
  }, [account, apiClient, codeBusy, failText, toast, zh]);

  const connect = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (formBusy) return;
    setFormBusy(true);
    setFormError('');
    try {
      const result = await apiClient.connectJianduSession({
        account: account.trim(),
        password,
        ...(verifyCode.trim() ? { verify_code: verifyCode.trim() } : {}),
      });

      if (result.requires_verification) {
        const channel = result.channel === 'sms' || result.channel === 'email' ? result.channel : 'email';
        setChallenge({ channel, message: result.message || '' });
        setVerifyCode('');
        // 用户刚点了「连接」——码应该已经在路上，别让他再去按一个按钮。
        void sendCode(channel);
        return;
      }

      setConnection(result.connection);
      setChallenge(null);
      setFormError('');
      setPassword('');
      setVerifyCode('');
      setReconnectNotice('');
      toast.success(
        zh ? '已连接见度系统' : 'Connected to Jiandu',
        zh
          ? `账号 ${result.connection?.account || account.trim()} · 组织 ${result.connection?.organization_name || '—'}`
          : `Account ${result.connection?.account || account.trim()}`,
      );
    } catch (reason) {
      setFormError(failText(reason, zh ? '连接失败' : 'Connection failed'));
    } finally {
      setFormBusy(false);
    }
  }, [account, apiClient, failText, formBusy, password, sendCode, toast, verifyCode, zh]);

  const disconnect = useCallback(async () => {
    const confirmed = await confirm({
      title: zh ? '断开见度连接？' : 'Disconnect Jiandu?',
      description: zh
        ? '本后台将不再拉取见度数据；见度侧的服务端会话会被吊销。随时可以用账号密码重新连接。'
        : 'This admin will stop pulling Jiandu data and the server-side session will be revoked. You can reconnect anytime.',
      confirmLabel: zh ? '断开连接' : 'Disconnect',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await apiClient.disconnectJianduSession();
      setConnection(null);
      setProjects(null);
      setOverview(null);
      setDetections([]);
      setReports([]);
      setReportsError('');
      setMe(null);
      toast.success(zh ? '已断开连接' : 'Disconnected');
    } catch (reason) {
      toast.error(zh ? '断开失败' : 'Failed to disconnect', failText(reason, zh ? '请稍后重试' : 'Please retry later'));
    }
  }, [apiClient, confirm, failText, toast, zh]);

  const overviewData = useMemo(() => record(overview), [overview]);
  const platformRows = useMemo(() => list(overviewData.platformPerformance), [overviewData]);

  const kpiCards = useMemo(() => [
    {
      key: 'mentionRate',
      label: zh ? '提及率' : 'Mention rate',
      value: displayPercent(overviewData.mentionRate),
      delta: record(overviewData.mentionRateDelta),
    },
    {
      key: 'recommendRate',
      label: zh ? '推荐率' : 'Recommend rate',
      value: displayPercent(overviewData.recommendRate),
      delta: record(overviewData.recommendRateDelta),
    },
    {
      key: 'positiveRate',
      label: zh ? '正面率' : 'Positive rate',
      value: displayPercent(overviewData.positiveRate),
      delta: record(overviewData.positiveRateDelta),
    },
    {
      key: 'geoScore',
      label: zh ? 'GEO 综合可见度' : 'GEO score',
      value: displayCount(overviewData.geoScore),
      delta: record(overviewData.geoScoreDelta),
    },
    {
      key: 'totalAnswers',
      label: zh ? '样本回答' : 'Answers sampled',
      value: displayCount(overviewData.totalAnswers),
      delta: {},
    },
  ], [overviewData, zh]);

  const detectionColumns: DataTableColumn<ApiRecord>[] = useMemo(() => [
    {
      key: 'createdAt',
      header: zh ? '检测时间' : 'Run time',
      render: (row) => <span className="text-slate-400">{displayTime(row.createdAt)}</span>,
    },
    {
      key: 'status',
      header: zh ? '状态' : 'Status',
      render: (row) => <span>{statusLabel(row.status, zh)}</span>,
    },
    {
      key: 'totalAnswers',
      header: zh ? '样本' : 'Samples',
      render: (row) => <span className="tabular-nums">{displayCount(row.totalAnswers)}</span>,
    },
    {
      key: 'mentionRate',
      header: zh ? '提及率' : 'Mention',
      render: (row) => <span className="font-semibold tabular-nums text-white">{displayPercent(row.mentionRate)}</span>,
    },
    {
      key: 'recommendRate',
      header: zh ? '推荐率' : 'Recommend',
      render: (row) => <span className="tabular-nums">{displayPercent(row.recommendRate)}</span>,
    },
  ], [zh]);

  const platformColumns: DataTableColumn<ApiRecord>[] = useMemo(() => [
    { key: 'platform', header: zh ? '平台' : 'Platform', render: (row) => <span>{String(row.platform || row.platformId || '—')}</span> },
    {
      key: 'mentionRate',
      header: zh ? '提及率' : 'Mention',
      render: (row) => <span className="font-semibold tabular-nums text-white">{displayPercent(row.mentionRate)}</span>,
    },
    {
      key: 'totalCount',
      header: zh ? '样本' : 'Samples',
      render: (row) => <span className="tabular-nums">{displayCount(row.totalCount)}</span>,
    },
  ], [zh]);

  const reportColumns: DataTableColumn<ApiRecord>[] = useMemo(() => [
    {
      key: 'title',
      header: zh ? '报告' : 'Report',
      render: (row) => <span className="text-white">{String(row.title || row.id || '—')}</span>,
    },
    {
      key: 'createdAt',
      header: zh ? '生成时间' : 'Created',
      render: (row) => <span className="text-slate-400">{displayTime(row.createdAt)}</span>,
    },
    {
      key: 'geoScore',
      header: zh ? 'GEO 分' : 'GEO',
      render: (row) => <span className="font-semibold tabular-nums text-white">{geoScoreText(row, zh)}</span>,
    },
    {
      key: 'mentionRate',
      header: zh ? '提及率' : 'Mention',
      render: (row) => <span className="tabular-nums">{displayPercent(record(row.metrics).mentionRate)}</span>,
    },
    {
      key: 'recommendRate',
      header: zh ? '推荐率' : 'Recommend',
      render: (row) => <span className="tabular-nums">{displayPercent(record(row.metrics).recommendRate)}</span>,
    },
    {
      key: 'total',
      header: zh ? '样本' : 'Samples',
      render: (row) => <span className="tabular-nums">{displayCount(record(row.metrics).total)}</span>,
    },
  ], [zh]);

  // 趋势按天分桶、只包含有样本的日期——所以这里的数值不会有「缺数据」态，
  // 0 就是真实的 0（那几天确实没被提及）。
  const trendRows = useMemo(() => list(overviewData.trendData), [overviewData]);
  const trendSeries = useMemo(() => [
    {
      name: zh ? '提及率' : 'Mention',
      values: trendRows.map((row) => (Number.isFinite(Number(row.mentionRate)) ? Number(row.mentionRate) : 0)),
      tone: 'text-emerald-500',
    },
    {
      name: zh ? '推荐率' : 'Recommend',
      values: trendRows.map((row) => (Number.isFinite(Number(row.recommendRate)) ? Number(row.recommendRate) : 0)),
      tone: 'text-amber-400',
    },
  ], [trendRows, zh]);

  if (!canRead) {
    return (
      <div className="space-y-5">
        <PageHeader title={zh ? '见度检测' : 'Jiandu Detection'} description={zh ? '查看见度GEO 检测系统的提及率与检测批次。' : 'View mention rates and runs from the Jiandu detection system.'} />
        <Card padding={6} className="max-w-2xl">
          <EmptyState
            icon={ScanSearch}
            title={zh ? '当前登录态没有见度检测权限' : 'This session cannot view Jiandu data'}
            description={zh
              ? '权限在登录时下发。如果你是在此功能上线之前登录的后台，重新登录一次即可；若重新登录后仍然如此，说明你的账号或 API Token 未被授予 jiandu:read，请联系超级管理员。'
              : 'Scopes are granted at login. If you signed in before this feature shipped, sign in again; otherwise ask a super admin for the jiandu:read scope.'}
            action={(
              <Button variant="primary" icon={LogOut} onClick={() => void relogin()}>
                {zh ? '退出并重新登录' : 'Sign out & sign in again'}
              </Button>
            )}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={zh ? '见度检测' : 'Jiandu Detection'}
        description={zh
          ? '连接见度GEO 检测系统，查看品牌在主流 AI 平台回答中的提及率与检测批次。'
          : 'Connect to the Jiandu detection system to view AI mention rates and detection runs.'}
        actions={connection && canWrite ? (
          <Button variant="secondary" icon={Unplug} onClick={() => void disconnect()}>
            {zh ? '断开连接' : 'Disconnect'}
          </Button>
        ) : undefined}
      />

      {bootError && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-[13px] text-rose-200">
          {bootError}
          <button type="button" onClick={() => void loadStatus()} className="ml-3 font-semibold underline">
            {zh ? '重试' : 'Retry'}
          </button>
        </div>
      )}

      {reconnectNotice && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{reconnectNotice}</span>
        </div>
      )}

      {!booted ? (
        <LoadingState lang={lang} label={zh ? '正在读取见度连接状态…' : 'Loading Jiandu connection…'} />
      ) : connection ? (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl bg-slate-900/80 px-5 py-4 text-[13px]">
            <span className="flex items-center gap-2 font-semibold text-white">
              <Link2 className="h-4 w-4 text-emerald-400" />
              {zh ? '已连接' : 'Connected'}
            </span>
            <span className="text-slate-300">{connection.organization_name || '—'}</span>
            <span className="text-slate-500">{connection.account}</span>
            {me && (
              <>
                <span className="text-slate-500">
                  {zh ? '套餐' : 'Plan'} {String(record(me.plan).name || '—')}
                </span>
                <span className="text-slate-500">
                  {zh ? '本月检测' : 'Used'} {displayCount(record(me.quota).monthlyDetectionsUsed)}/{displayCount(record(me.quota).monthlyDetectionsTotal)}
                </span>
                <span className="text-slate-500">
                  {zh ? '积分' : 'Points'} {displayCount(record(me.quota).pointsBalance)}
                </span>
                {record(me.plan).apiEnabled === false && (
                  <span className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
                    {zh ? '见度套餐已不含开放 API，数据将无法继续拉取' : 'Plan no longer includes the open API'}
                  </span>
                )}
              </>
            )}
            {connection.access_expires_at && (
              <span className="text-slate-500">
                {zh ? '会话续期至' : 'Refresh until'} {displayTime(connection.refresh_expires_at)}
              </span>
            )}
            <span className="ml-auto text-caption">
              {zh ? '数据来自见度GEO 检测系统' : 'Data from the Jiandu system'}
              {source?.fetched_at ? ` · ${zh ? '拉取于' : 'fetched'} ${displayTime(source.fetched_at)}` : ''}
            </span>
          </div>

          {projects && projects.length === 0 ? (
            <Card padding={6}>
              <EmptyState
                icon={ScanSearch}
                title={zh ? '见度账号下还没有项目' : 'No projects under this Jiandu account'}
                description={zh ? '请先在见度系统里创建项目并完成一次检测，再回到这里。' : 'Create a project and run a detection in Jiandu first.'}
              />
            </Card>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <label className="text-xs font-semibold text-slate-300" htmlFor="jiandu-project">{zh ? '品牌项目' : 'Project'}</label>
                <select
                  id="jiandu-project"
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                  disabled={!projects}
                  className="h-9 min-w-[220px] rounded-lg border border-slate-700 bg-slate-950 px-3 text-xs text-white outline-none focus:border-indigo-500 disabled:opacity-50"
                >
                  {(projects || []).map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name || project.id}{project.brand_name ? ` · ${project.brand_name}` : ''}
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-1">
                  {(['30d', '90d'] as const).map((option) => (
                    <Button
                      key={option}
                      variant={range === option ? 'primary' : 'ghost'}
                      size="sm"
                      onClick={() => setRange(option)}
                    >
                      {option === '30d' ? (zh ? '近 30 天' : '30d') : (zh ? '近 90 天' : '90d')}
                    </Button>
                  ))}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={RefreshCw}
                  onClick={() => void loadData(projectId, range)}
                  disabled={!projectId || dataBusy}
                >
                  {zh ? '刷新' : 'Refresh'}
                </Button>
              </div>

              {dataError && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-[13px] text-rose-200">
                  {dataError}
                  <button type="button" onClick={() => void loadData(projectId, range)} className="ml-3 font-semibold underline">
                    {zh ? '重试' : 'Retry'}
                  </button>
                </div>
              )}

              {dataBusy && !overview ? (
                <LoadingState lang={lang} label={zh ? '正在读取见度数据…' : 'Loading Jiandu data…'} />
              ) : overview && (
                <>
                  <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                    {kpiCards.map((card) => (
                      <div key={card.key} className="rounded-2xl bg-slate-900/80 p-5 transition hover:shadow-md">
                        <div className="text-caption">{card.label}</div>
                        <div className="mt-1.5 text-[26px] font-black leading-none tabular-nums text-white">{card.value}</div>
                        {Number.isFinite(Number(card.delta.change)) && (
                          <div className={`mt-1.5 text-[11px] ${card.delta.trend === 'up' ? 'text-emerald-300' : card.delta.trend === 'down' ? 'text-rose-300' : 'text-slate-500'}`}>
                            {zh ? '环比' : 'vs prev'} {Number(card.delta.change) > 0 ? '+' : ''}{String(card.delta.change)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {Number(overviewData.totalAnswers) === 0 && (
                    <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{zh ? '该项目在当前时间范围内没有成功检测样本——指标为「—」表示没有数据，不是 0。' : 'No successful samples in this range; "—" means no data, not zero.'}</span>
                    </div>
                  )}

                  <Card>
                    <div className="mb-3 flex items-center justify-between">
                      <h2 className="text-sm font-bold text-white">{zh ? '提及率 / 推荐率趋势' : 'Mention & recommend trend'}</h2>
                      <span className="text-caption">{zh ? '按天 · 数据来自见度' : 'daily · from Jiandu'}</span>
                    </div>
                    {trendRows.length < 2 ? (
                      <EmptyState
                        compact
                        icon={TrendingUp}
                        title={zh ? '样本还不足以画趋势' : 'Not enough samples for a trend yet'}
                        description={zh ? '至少需要两天、每天有成功检测样本；一个点画不出趋势。' : 'At least two days with samples are needed.'}
                      />
                    ) : (
                      <TrendChart labels={trendRows.map((row) => String(row.date || ''))} series={trendSeries} />
                    )}
                  </Card>

                  <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                    <Card>
                      <h2 className="mb-3 text-sm font-bold text-white">{zh ? '各平台表现' : 'By platform'}</h2>
                      {platformRows.length === 0 ? (
                        <EmptyState
                          compact
                          icon={ScanSearch}
                          title={zh ? '当前时间范围暂无平台数据' : 'No platform data in this range'}
                          description={zh ? '换个时间范围或换一个项目再看。' : 'Try another range or project.'}
                        />
                      ) : (
                        <DataTable
                          columns={platformColumns}
                          rows={platformRows}
                          rowKey={(row) => String(row.platformId || row.platform || Math.random())}
                          dense
                        />
                      )}
                    </Card>

                    <Card>
                      <h2 className="mb-3 text-sm font-bold text-white">{zh ? '最近检测批次' : 'Recent detection runs'}</h2>
                      {detections.length === 0 ? (
                        <EmptyState
                          compact
                          icon={ScanSearch}
                          title={zh ? '还没有检测批次' : 'No detection runs yet'}
                          description={zh ? '在见度系统里跑一次检测，这里就会显示批次与提及率。' : 'Run a detection in Jiandu and it will show up here.'}
                        />
                      ) : (
                        <DataTable
                          columns={detectionColumns}
                          rows={detections}
                          rowKey={(row) => String(row.id || Math.random())}
                          dense
                        />
                      )}
                    </Card>
                  </div>

                  <Card>
                    <div className="mb-3 flex items-center justify-between">
                      <h2 className="text-sm font-bold text-white">{zh ? '检测报告' : 'Detection reports'}</h2>
                      <span className="text-caption">{zh ? '来自见度 · 任务完成后自动生成' : 'from Jiandu · created after a run'}</span>
                    </div>
                    {reportsError ? (
                      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">{reportsError}</div>
                    ) : reports.length === 0 ? (
                      <EmptyState
                        compact
                        icon={FileText}
                        title={zh ? '还没有检测报告' : 'No reports yet'}
                        description={zh ? '见度侧检测任务完成后会自动生成报告，这里就能看到。' : 'Reports appear here once a run completes in Jiandu.'}
                      />
                    ) : (
                      <DataTable
                        columns={reportColumns}
                        rows={reports}
                        rowKey={(row) => String(row.id || row.taskId || Math.random())}
                        dense
                      />
                    )}
                  </Card>
                </>
              )}
            </>
          )}
        </>
      ) : (
        <Card padding={6} className="max-w-xl space-y-4">
          <div>
            <h2 className="text-sm font-bold text-white">{zh ? '连接见度系统' : 'Connect to Jiandu'}</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              {zh
                ? '输入见度GEO 的账号密码。凭证只在本系统服务端使用、加密保存，浏览器不会拿到见度的会话。首次在服务器上登录时，见度会要求一次验证码。'
                : 'Enter your Jiandu account. Credentials stay server-side and are encrypted; the first server login may require a verification code.'}
            </p>
          </div>

          {!canWrite ? (
            <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] leading-6 text-amber-200">
              <p>
                {zh
                  ? '当前登录态没有建立连接的权限（需要 jiandu:write）。如果是在此功能上线前登录的后台，重新登录一次即可；否则请联系超级管理员。'
                  : 'The jiandu:write scope is required to connect. Sign in again if your session predates this feature; otherwise ask a super admin.'}
              </p>
              <Button type="button" variant="secondary" size="sm" icon={LogOut} onClick={() => void relogin()}>
                {zh ? '退出并重新登录' : 'Sign out & sign in again'}
              </Button>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={(event) => void connect(event)}>
              <Field label={zh ? '见度账号（手机号或邮箱）' : 'Jiandu account (phone or email)'} htmlFor="jiandu-account" required>
                <Input
                  id="jiandu-account"
                  autoComplete="username"
                  value={account}
                  onChange={(event) => setAccount(event.target.value)}
                  placeholder={zh ? 'name@example.com 或 13800138000' : 'name@example.com or 13800138000'}
                  required
                />
              </Field>
              <Field label={zh ? '密码' : 'Password'} htmlFor="jiandu-password" required>
                <Input
                  id="jiandu-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </Field>

              {challenge && (
                <div className="space-y-3 rounded-xl border border-line bg-canvas p-3">
                  <p className="text-[13px] leading-6 text-slate-300">
                    {challenge.message
                      || (challenge.channel === 'sms'
                        ? (zh ? '这是一台新设备，请输入短信验证码。' : 'New device: enter the SMS code.')
                        : (zh ? '这是一台新设备，请输入邮箱验证码。' : 'New device: enter the email code.'))}
                  </p>
                  <Field label={zh ? '验证码' : 'Verification code'} htmlFor="jiandu-code">
                    <Input
                      id="jiandu-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={verifyCode}
                      onChange={(event) => setVerifyCode(event.target.value)}
                      placeholder="123456"
                    />
                  </Field>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    loading={codeBusy}
                    disabled={codeCooldown > 0}
                    onClick={() => void sendCode(challenge.channel)}
                  >
                    {codeCooldown > 0
                      ? (zh ? `重新发送（${codeCooldown}s）` : `Resend (${codeCooldown}s)`)
                      : (zh ? '重新发送验证码' : 'Resend code')}
                  </Button>
                </div>
              )}

              {formError && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-[13px] text-rose-200">{formError}</div>
              )}

              <Button type="submit" variant="primary" loading={formBusy} icon={Link2}>
                {challenge ? (zh ? '提交验证码并连接' : 'Submit code & connect') : (zh ? '连接' : 'Connect')}
              </Button>
            </form>
          )}
        </Card>
      )}
    </div>
  );
};

function statusLabel(status: unknown, zh: boolean): string {
  const value = String(status || '');
  const labels: Record<string, [string, string]> = {
    completed: ['已完成', 'Completed'],
    partial: ['部分完成', 'Partial'],
    failed: ['失败', 'Failed'],
    cancelled: ['已取消', 'Cancelled'],
    running: ['进行中', 'Running'],
    queued: ['排队中', 'Queued'],
    pending: ['等待中', 'Pending'],
  };
  const pair = labels[value];
  if (pair) return zh ? pair[0] : pair[1];
  return value || '—';
}

/** 「连接失效需重连」在 HTTP 层是 409 + 固定 code——页面据此切回未连接引导。 */
function isReconnectRequired(reason: unknown): boolean {
  const error = reason as { code?: unknown } | null;
  return Boolean(error && typeof error === 'object' && error.code === 'jiandu_reconnect_required');
}

/**
 * 见度报告的 GEO 分三态（与见度控制台同一套判据）：
 * `geoScoreStatus !== 'final'` = 规则制定期没有这个指标（「未启用」）；
 * 有 `metrics.total` 才有分，零样本时说「暂无数据」——**不能画成 0 分**。
 */
function geoScoreText(row: ApiRecord, zh: boolean): string {
  if (String(row.geoScoreStatus || '') !== 'final') return zh ? '未启用' : 'n/a';
  const total = Number(record(row.metrics).total);
  const score = Number(row.geoScore);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(score)) return zh ? '暂无数据' : 'no data';
  return `${score} / 100`;
}
