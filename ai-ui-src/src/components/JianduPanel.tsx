import React, { useCallback, useEffect, useState } from 'react';
import { Button, Field, Input, useConfirm, useToast } from './ui';
import {
  GeoFlowApiClient,
  type JianduConnectionProjection,
  type JianduDetectionSettings,
  type JianduQuestionRecord,
} from '../api/geoflowClient';
import { describeApiError } from '../api/permissions';
import { Link2, Plus, RefreshCw, Trash2, Unplug } from 'lucide-react';

/**
 * 「见度对接」面板——AI 模型与提示词页里的第三方接入区（与「来源提供者」同区）。
 *
 * 这里承担见度GEO 检测的**全部配置**（2026-09-20 拍板：见度检测不再单开页面）：
 *  ① 连接：输一次见度账号密码（新设备过一次验证码），此后由后端维持会话；
 *  ② 检测问题集：每日自动检测的口径来源，运营自己维护（上限 20 条）；
 *  ③ 每日自动检测：开关 + 平台入口勾选——每天凌晨跑「勾选平台 × 启用问题」。
 *
 * 数据展示在「数据分析 → AI 可见度」栏目里（实时拉取，见 AiVisibilityJianduSection）。
 */

interface JianduPanelProps {
  apiClient: GeoFlowApiClient;
  lang: 'zh' | 'en';
  canManage: boolean;
}

const PLATFORM_LABELS: Record<string, string> = {
  doubao: '豆包',
  deepseek: 'DeepSeek',
  qianwen: '千问',
  yuanbao: '元宝',
  kimi: 'Kimi',
  wenxin: '文心一言',
};

function timeText(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  if (!text) return '—';
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toLocaleString();
}

export const JianduPanel: React.FC<JianduPanelProps> = ({ apiClient, lang, canManage }) => {
  const zh = lang === 'zh';
  const toast = useToast();
  const confirm = useConfirm();

  const [booting, setBooting] = useState(true);
  const [connection, setConnection] = useState<JianduConnectionProjection | null>(null);
  const [notice, setNotice] = useState('');

  // 连接表单
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [challenge, setChallenge] = useState<{ channel: 'sms' | 'email'; message: string } | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  // 问题集与每日设置
  const [questions, setQuestions] = useState<JianduQuestionRecord[]>([]);
  const [maxQuestions, setMaxQuestions] = useState(20);
  const [questionDraft, setQuestionDraft] = useState('');
  const [questionBusy, setQuestionBusy] = useState(false);
  const [settings, setSettings] = useState<JianduDetectionSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);

  const failText = useCallback(
    (reason: unknown, fallback: string): string => describeApiError(reason, fallback, lang),
    [lang],
  );

  // 发码冷却（见度侧 60 秒窗口）
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown((value) => (value <= 1 ? 0 : value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const loadAll = useCallback(async () => {
    try {
      const status = await apiClient.getJianduStatus();
      setConnection(status.connection);
      if (status.connection) {
        const [list, config] = await Promise.all([
          apiClient.listJianduQuestions(),
          apiClient.getJianduSettings(),
        ]);
        setQuestions(list.items || []);
        setMaxQuestions(list.max_questions || 20);
        setSettings(config.settings);
      }
    } catch (reason) {
      setNotice(failText(reason, zh ? '见度对接状态加载失败' : 'Failed to load Jiandu settings'));
    } finally {
      setBooting(false);
    }
  }, [apiClient, failText, zh]);

  useEffect(() => {
    if (canManage) {
      void loadAll();
    } else {
      setBooting(false);
    }
  }, [canManage, loadAll]);

  const sendCode = useCallback(async (channel: 'sms' | 'email') => {
    if (codeBusy) return;
    setCodeBusy(true);
    try {
      const result = await apiClient.sendJianduCode({ channel, account: account.trim() });
      setCooldown(60);
      toast.success(zh ? '验证码已发送' : 'Code sent', result.message || (channel === 'sms'
        ? (zh ? '请查收短信，输入验证码后再次提交。' : 'Check the SMS and submit the code.')
        : (zh ? '请查收邮件，输入验证码后再次提交。' : 'Check the email and submit the code.')));
    } catch (reason) {
      toast.error(zh ? '验证码发送失败' : 'Failed to send code', failText(reason, zh ? '请稍后重试' : 'Please retry later'));
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
      setPassword('');
      setVerifyCode('');
      toast.success(zh ? '已连接见度系统' : 'Connected to Jiandu', zh
        ? `账号 ${result.connection?.account || account.trim()} · 数据将展示在「数据分析 → AI 可见度」`
        : 'Data will appear under Analytics → AI visibility');
      await loadAll();
    } catch (reason) {
      setFormError(failText(reason, zh ? '连接失败' : 'Connection failed'));
    } finally {
      setFormBusy(false);
    }
  }, [account, apiClient, failText, formBusy, loadAll, password, sendCode, toast, verifyCode, zh]);

  const disconnect = useCallback(async () => {
    const confirmed = await confirm({
      title: zh ? '断开见度连接？' : 'Disconnect Jiandu?',
      description: zh
        ? '「AI 可见度」栏目将不再展示见度数据；见度侧的服务端会话会被吊销。随时可用账号密码重新连接。'
        : 'The AI visibility section will stop showing Jiandu data and the server-side session is revoked.',
      confirmLabel: zh ? '断开连接' : 'Disconnect',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await apiClient.disconnectJianduSession();
      setConnection(null);
      setQuestions([]);
      setSettings(null);
      setChallenge(null);
      toast.success(zh ? '已断开连接' : 'Disconnected');
    } catch (reason) {
      toast.error(zh ? '断开失败' : 'Failed to disconnect', failText(reason, zh ? '请稍后重试' : 'Please retry later'));
    }
  }, [apiClient, confirm, failText, toast, zh]);

  const addQuestion = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    const text = questionDraft.trim();
    if (!text || questionBusy) return;
    setQuestionBusy(true);
    try {
      const created = await apiClient.createJianduQuestion({ question: text });
      setQuestions((previous) => [...previous, created.item]);
      setQuestionDraft('');
    } catch (reason) {
      toast.error(zh ? '添加失败' : 'Failed to add', failText(reason, zh ? '请稍后重试' : 'Please retry later'));
    } finally {
      setQuestionBusy(false);
    }
  }, [apiClient, failText, questionBusy, questionDraft, toast, zh]);

  const toggleQuestion = useCallback(async (item: JianduQuestionRecord) => {
    try {
      const updated = await apiClient.updateJianduQuestion(item.id, { is_active: !item.is_active });
      setQuestions((previous) => previous.map((row) => (row.id === item.id ? updated.item : row)));
    } catch (reason) {
      toast.error(zh ? '更新失败' : 'Failed to update', failText(reason, zh ? '请稍后重试' : 'Please retry later'));
    }
  }, [apiClient, failText, toast, zh]);

  const removeQuestion = useCallback(async (item: JianduQuestionRecord) => {
    const confirmed = await confirm({
      title: zh ? `删除这条检测问题？` : 'Delete this question?',
      description: item.question,
      confirmLabel: zh ? '删除' : 'Delete',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await apiClient.deleteJianduQuestion(item.id);
      setQuestions((previous) => previous.filter((row) => row.id !== item.id));
    } catch (reason) {
      toast.error(zh ? '删除失败' : 'Failed to delete', failText(reason, zh ? '请稍后重试' : 'Please retry later'));
    }
  }, [apiClient, confirm, failText, toast, zh]);

  const saveSettings = useCallback(async (patch: { enabled?: boolean; platforms?: string[] }) => {
    if (settingsBusy) return;
    setSettingsBusy(true);
    try {
      const updated = await apiClient.updateJianduSettings(patch);
      setSettings(updated.settings);
    } catch (reason) {
      toast.error(zh ? '设置保存失败' : 'Failed to save settings', failText(reason, zh ? '请稍后重试' : 'Please retry later'));
    } finally {
      setSettingsBusy(false);
    }
  }, [apiClient, failText, settingsBusy, toast, zh]);

  const activeQuestions = questions.filter((item) => item.is_active);
  const platforms = settings?.platforms || [];
  const dailyJobs = activeQuestions.length * platforms.length;

  if (!canManage) {
    return (
      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
        <h3 className="text-section-title">{zh ? '见度GEO 检测（第三方）' : 'Jiandu detection (third-party)'}</h3>
        <p className="mt-2 text-[13px] text-slate-500">
          {zh ? '见度对接仅超级管理员可见可改。数据展示在「数据分析 → AI 可见度」。' : 'Only super administrators can manage the Jiandu connection.'}
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-section-title flex items-center gap-2">
            <Link2 className="w-4 h-4 text-slate-400" />
            {zh ? '见度GEO 检测（第三方）' : 'Jiandu detection (third-party)'}
          </h3>
          <p className="mt-1 text-[12.5px] leading-6 text-slate-500">
            {zh
              ? '登录一次即可：检测数据（提及率、平台表现、批次、报告）展示在「数据分析 → AI 可见度」栏目；检测每天按下面的问题集自动跑。'
              : 'Sign in once. Detection data appears under Analytics → AI visibility; detection runs daily with the questions below.'}
          </p>
        </div>
        {connection && (
          <Button variant="secondary" size="sm" icon={Unplug} onClick={() => void disconnect()}>
            {zh ? '断开连接' : 'Disconnect'}
          </Button>
        )}
      </div>

      {notice && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-[13px] text-rose-200">{notice}</div>}

      {booting ? (
        <div className="flex items-center gap-2 text-[13px] text-slate-500"><RefreshCw className="h-3.5 w-3.5 animate-spin" />{zh ? '正在读取见度对接状态…' : 'Loading…'}</div>
      ) : !connection ? (
        <form className="max-w-xl space-y-4" onSubmit={(event) => void connect(event)}>
          <Field label={zh ? '见度账号（手机号或邮箱）' : 'Jiandu account (phone or email)'} htmlFor="jiandu-panel-account" required>
            <Input
              id="jiandu-panel-account"
              autoComplete="username"
              value={account}
              onChange={(event) => setAccount(event.target.value)}
              placeholder={zh ? 'name@example.com 或 13800138000' : 'name@example.com'}
              required
            />
          </Field>
          <Field label={zh ? '密码' : 'Password'} htmlFor="jiandu-panel-password" required>
            <Input
              id="jiandu-panel-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </Field>

          {challenge && (
            <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
              <p className="text-[13px] leading-6 text-slate-300">
                {challenge.message || (challenge.channel === 'sms'
                  ? (zh ? '这是一台新设备，请输入短信验证码。' : 'New device: enter the SMS code.')
                  : (zh ? '这是一台新设备，请输入邮箱验证码。' : 'New device: enter the email code.'))}
              </p>
              <Field label={zh ? '验证码' : 'Verification code'} htmlFor="jiandu-panel-code">
                <Input
                  id="jiandu-panel-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={verifyCode}
                  onChange={(event) => setVerifyCode(event.target.value)}
                  placeholder="123456"
                />
              </Field>
              <Button type="button" variant="secondary" size="sm" loading={codeBusy} disabled={cooldown > 0} onClick={() => void sendCode(challenge.channel)}>
                {cooldown > 0 ? (zh ? `重新发送（${cooldown}s）` : `Resend (${cooldown}s)`) : (zh ? '重新发送验证码' : 'Resend code')}
              </Button>
            </div>
          )}

          {formError && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-[13px] text-rose-200">{formError}</div>}

          <Button type="submit" variant="primary" loading={formBusy} icon={Link2}>
            {challenge ? (zh ? '提交验证码并连接' : 'Submit code & connect') : (zh ? '连接见度' : 'Connect')}
          </Button>
        </form>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-slate-950/50 px-4 py-3 text-[13px]">
            <span className="flex items-center gap-2 font-semibold text-white">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
              {zh ? '已连接' : 'Connected'}
            </span>
            <span className="text-slate-300">{connection.organization_name || '—'}</span>
            <span className="text-slate-500">{connection.account}</span>
            <span className="text-slate-500">{zh ? '会话续期至' : 'Refresh until'} {timeText(connection.refresh_expires_at)}</span>
          </div>

          {/* 每日自动检测 */}
          {settings && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-[13px] font-bold text-slate-200">{zh ? '每日自动检测' : 'Daily auto detection'}</h4>
                <label className="flex items-center gap-2 text-[13px] text-slate-300">
                  <input
                    type="checkbox"
                    checked={settings.enabled}
                    disabled={settingsBusy}
                    onChange={(event) => void saveSettings({ enabled: event.target.checked })}
                  />
                  {zh ? '开启（每天 01:10 自动跑）' : 'Enabled (daily at 01:10)'}
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                {(settings.available_platforms || []).map((platform) => {
                  const checked = platforms.includes(platform);
                  return (
                    <button
                      key={platform}
                      type="button"
                      disabled={settingsBusy}
                      onClick={() => void saveSettings({
                        platforms: checked ? platforms.filter((item) => item !== platform) : [...platforms, platform],
                      })}
                      className={`h-8 rounded-lg border px-2.5 text-[12px] font-semibold transition ${
                        checked ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-slate-700 bg-slate-800/60 text-slate-400 hover:bg-slate-800'
                      }`}
                    >
                      {PLATFORM_LABELS[platform] || platform}
                    </button>
                  );
                })}
              </div>
              <p className="text-[12px] leading-6 text-slate-500">
                {zh
                  ? `每天跑「勾选的 ${platforms.length} 个平台 × 启用的 ${activeQuestions.length} 个问题」= ${dailyJobs} 次检测/天（约 ${dailyJobs * 30} 次/月，占用见度侧套餐额度与积分）。`
                  : `${platforms.length} platform(s) × ${activeQuestions.length} active question(s) = ${dailyJobs} detections/day.`}
                {settings.last_run_at && (
                  <> {zh ? '上次运行：' : 'Last run: '}{timeText(settings.last_run_at)}{settings.last_run_status ? `（${settings.last_run_status}）` : ''}</>
                )}
              </p>
            </div>
          )}

          {/* 检测问题集 */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-[13px] font-bold text-slate-200">
                {zh ? '检测问题集' : 'Detection questions'}
                <span className="ml-2 text-[12px] font-normal text-slate-500">{questions.length}/{maxQuestions}{zh ? ' 条' : ''}</span>
              </h4>
            </div>
            <form className="flex gap-2" onSubmit={(event) => void addQuestion(event)}>
              <input
                value={questionDraft}
                onChange={(event) => setQuestionDraft(event.target.value)}
                placeholder={zh ? '输入一个客户最常问 AI 的问句（如：XX服务商哪家好？）' : 'A question customers ask AI'}
                className="h-10 min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 text-[13px] text-white outline-none transition focus:border-indigo-500"
              />
              <Button type="submit" variant="primary" size="sm" icon={Plus} loading={questionBusy} disabled={!questionDraft.trim() || questions.length >= maxQuestions}>
                {zh ? '添加' : 'Add'}
              </Button>
            </form>
            {questions.length === 0 ? (
              <p className="text-[12.5px] text-slate-500">{zh ? '还没有问题——每日自动检测需要至少一个问题。' : 'No questions yet.'}</p>
            ) : (
              <ul className="divide-y divide-slate-800/60 rounded-xl border border-slate-800">
                {questions.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={item.is_active}
                      onChange={() => void toggleQuestion(item)}
                      title={zh ? '启用/停用（每日检测只跑启用的）' : 'Active'}
                    />
                    <span className={`min-w-0 flex-1 truncate text-[13px] ${item.is_active ? 'text-slate-200' : 'text-slate-500 line-through'}`}>{item.question}</span>
                    <button type="button" onClick={() => void removeQuestion(item)} className="text-slate-500 transition hover:text-rose-400" aria-label={zh ? '删除' : 'Delete'}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
