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
      <div className="w-full max-w-sm">
        <div className="mb-7 flex items-center justify-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-red-500/30 bg-red-600 text-xl font-black text-white shadow-lg shadow-red-950/40">
            桐
          </div>
          <div>
            <h1 className="text-xl font-extrabold text-white">桐灼GEO</h1>
            <p className="mt-0.5 text-xs text-slate-400">
              {lang === 'zh' ? '企业 GEO 运营系统' : 'Enterprise GEO Operations'}
            </p>
          </div>
        </div>

        <section className="rounded-lg border border-slate-800 bg-slate-900 p-6 shadow-2xl shadow-black/30">
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
                  className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 pl-9 pr-3 text-sm text-white outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-500/20 disabled:opacity-60"
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
                  className="h-10 w-full rounded-md border border-slate-700 bg-slate-950 pl-9 pr-10 text-sm text-white outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-500/20 disabled:opacity-60"
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
              <div role="alert" className="rounded-md border border-red-500/30 bg-red-950/40 px-3 py-2.5 text-xs text-red-200">
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
              className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-red-600 px-4 text-sm font-bold text-white transition hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-red-400 focus:ring-offset-2 focus:ring-offset-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {submitting
                ? (lang === 'zh' ? '正在验证' : 'Signing in')
                : (lang === 'zh' ? '登录' : 'Sign in')}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
};

