import React, { useState } from 'react';
import { AlertCircle, Eye, EyeOff, LoaderCircle, LockKeyhole, ShieldCheck, UserRound } from 'lucide-react';
import { GeoFlowApiError } from '../api/geoflowClient';

interface LoginViewProps {
  lang: 'zh' | 'en';
  onLogin: (username: string, password: string) => Promise<void>;
}

export const LoginView: React.FC<LoginViewProps> = ({ lang, onLogin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; requestId?: string | null } | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) return;
    setSubmitting(true);
    setError(null);
    try {
      await onLogin(username.trim(), password);
    } catch (reason) {
      if (reason instanceof GeoFlowApiError) {
        const fieldErrors = reason.details.field_errors as Record<string, string> | undefined;
        setError({
          message: fieldErrors?.username || fieldErrors?.password || reason.message,
          requestId: reason.requestId,
        });
      } else {
        setError({
          message: lang === 'zh' ? '登录失败，请稍后重试' : 'Sign-in failed. Please try again.',
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4 py-8">
      <div className="flex w-full max-w-4xl flex-col gap-6 lg:flex-row lg:items-center lg:gap-10">
        {/* 品牌侧（小屏隐藏）：一句话说清「这套系统替你做什么」——
            登录页是产品对外的第一面，原来的居中单卡没有任何产品信息。 */}
        <div className="hidden flex-1 lg:block">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600 text-2xl font-black text-white shadow-sm">
              桐
            </div>
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight text-white">桐灼GEO</h1>
              <p className="mt-0.5 text-xs text-slate-400">
                {lang === 'zh' ? '生成式引擎优化工作台' : 'Generative Engine Optimization Workspace'}
              </p>
            </div>
          </div>
          <p className="mb-6 max-w-md text-sm leading-relaxed text-slate-300">
            {lang === 'zh'
              ? '让品牌内容更容易被大模型「看到、引用、推荐」——从写作、审核、发布，到效果监测，都在一个后台完成。'
              : 'Get your content seen, cited and recommended by AI engines — write, review, publish and measure in one place.'}
          </p>
          <ul className="space-y-3">
            {[
              {
                title: lang === 'zh' ? 'AI 写文章' : 'AI writing',
                detail: lang === 'zh' ? '选好标题库与知识库，一篇有依据的长文约一分钟产出' : 'Grounded longform articles in about a minute',
              },
              {
                title: lang === 'zh' ? '审核后发布' : 'Review, then publish',
                detail: lang === 'zh' ? '草稿先过 AI 质检与人工审核，再分发到各个站点' : 'Quality gate, human review, then multi-site distribution',
              },
              {
                title: lang === 'zh' ? '看 AI 侧效果' : 'AI-side results',
                detail: lang === 'zh' ? '监测品牌在生成式引擎里的提及、引用与带来的访问' : 'Track mentions, citations and traffic from AI engines',
              },
            ].map((item) => (
              <li key={item.title} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <div>
                  <div className="text-sm font-semibold text-white">{item.title}</div>
                  <div className="mt-0.5 text-xs leading-relaxed text-slate-400">{item.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* 表单侧 */}
        <div className="w-full lg:w-[400px] lg:shrink-0">
          <div className="mb-6 flex items-center justify-center gap-3 lg:hidden">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-xl font-black text-white shadow-sm">
              桐
            </div>
            <div>
              <h1 className="text-xl font-extrabold text-white">桐灼GEO</h1>
              <p className="mt-0.5 text-xs text-slate-400">
                {lang === 'zh' ? '生成式引擎优化工作台' : 'Generative Engine Optimization'}
              </p>
            </div>
          </div>

          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl shadow-black/30">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-white">
                  {lang === 'zh' ? '管理员登录' : 'Administrator sign in'}
                </h2>
                <p className="mt-1 text-xs text-slate-400">
                  {lang === 'zh' ? '使用当前部署实例的管理员账号' : 'Use an administrator account for this deployment'}
                </p>
              </div>
              <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="geoflow-username" className="text-xs font-semibold text-slate-300">
                  {lang === 'zh' ? '用户名' : 'Username'}
                </label>
                <div className="relative">
                  <UserRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
                  <input
                    id="geoflow-username"
                    name="username"
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    disabled={submitting}
                    className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 pl-9 pr-3 text-sm text-white outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="geoflow-password" className="text-xs font-semibold text-slate-300">
                  {lang === 'zh' ? '密码' : 'Password'}
                </label>
                <div className="relative">
                  <LockKeyhole className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
                  <input
                    id="geoflow-password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={submitting}
                    className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 pl-9 pr-10 text-sm text-white outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((visible) => !visible)}
                    className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-800 hover:text-white"
                    title={lang === 'zh' ? (showPassword ? '隐藏密码' : '显示密码') : (showPassword ? 'Hide password' : 'Show password')}
                    aria-label={lang === 'zh' ? (showPassword ? '隐藏密码' : '显示密码') : (showPassword ? 'Hide password' : 'Show password')}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div role="alert" className="rounded-lg border border-red-500/30 bg-red-950/40 px-3 py-2.5 text-xs text-red-200">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
                    <div className="min-w-0">
                      <p>{error.message}</p>
                      {error.requestId && (
                        <p className="mt-1 break-all font-mono text-[10px] text-red-300/70">Request ID: {error.requestId}</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !username.trim() || !password}
                className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-bold text-white transition hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-2 focus:ring-offset-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {submitting
                  ? (lang === 'zh' ? '正在验证' : 'Signing in')
                  : (lang === 'zh' ? '登录' : 'Sign in')}
              </button>
            </form>
          </section>

          <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-500">
            {lang === 'zh'
              ? '登录凭据由本部署实例管理；系统不会把内容发送给未配置的第三方。'
              : 'Credentials are managed by this deployment; content is never sent to unconfigured third parties.'}
          </p>
        </div>
      </div>
    </main>
  );
};

