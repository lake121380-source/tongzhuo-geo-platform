import React from 'react';
import {
  Bot,
  Globe,
  Shield,
  Sparkles,
  Radio,
  CheckCircle2,
  AlertCircle,
  Activity,
  BookOpen,
  FileCode2,
  LogOut,
  Server,
  Moon,
  Sun,
} from 'lucide-react';
import { applyTheme, nextTheme, persistTheme, readStoredTheme } from '../theme';

interface HeaderProps {
  lang: 'zh' | 'en';
  setLang: (lang: 'zh' | 'en') => void;
  hasGeminiKey: boolean;
  onQuickGenerate?: () => void;
  onOpenPreview?: () => void;
  onOpenScorecard?: () => void;
  onOpenGlossary?: () => void;
  onOpenDevHandoff?: () => void;
  mode?: 'demo' | 'geoflow';
  adminName?: string;
  adminRole?: string;
  onLogout?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  lang,
  setLang,
  hasGeminiKey,
  onQuickGenerate,
  onOpenPreview,
  onOpenScorecard,
  onOpenGlossary,
  onOpenDevHandoff,
  mode = 'demo',
  adminName,
  adminRole,
  onLogout,
}) => {
  const isApiMode = mode === 'geoflow';

  // 主题：默认亮色，偏好存 localStorage，`index.html` 的预置脚本已在首绘前套用。
  // 这里持有状态只是为了按钮图标能跟着变；实际生效靠 `applyTheme` 动 <html> 上的 `.dark`。
  const [theme, setTheme] = React.useState(() => readStoredTheme());

  const toggleTheme = () => {
    const following = nextTheme(theme);
    setTheme(following);
    applyTheme(following);
    persistTheme(following);
  };
  return (
    <header className="h-16 border-b border-slate-800 bg-slate-900/95 backdrop-blur-md px-4 sm:px-6 flex items-center justify-between sticky top-0 z-30">
      {/* Brand */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 via-indigo-600 to-indigo-800 flex items-center justify-center shadow-lg shadow-indigo-500/20 text-white font-black text-base">
            桐
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-lg tracking-tight text-white">桐灼GEO</span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-mono">
                {isApiMode ? 'API v1' : 'v2.5 Pro'}
              </span>
            </div>
            <p className="text-xs text-slate-400 hidden sm:block">
              {lang === 'zh' ? '生成式引擎优化 · 双轨基准与事实工程平台' : 'AI Content Engineering & GEO Platform'}
            </p>
          </div>
        </div>
      </div>

      {/* Center Actions / Status */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Executive Readiness Scorecard Button */}
        {!isApiMode && onOpenScorecard && (
          <button
            onClick={onOpenScorecard}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-950/60 hover:bg-emerald-900/80 text-emerald-300 border border-emerald-500/40 shadow-sm transition-all"
            title={lang === 'zh' ? '点击查看全站 GEO/SEO 综合就绪度记分卡' : 'View Executive Scorecard'}
          >
            <Activity className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
            <span>{lang === 'zh' ? 'GEO 健康度' : 'GEO Health'}:</span>
            <span className="font-mono text-emerald-200 tabular-nums">94分 (A+)</span>
          </button>
        )}

        {/* Plain Glossary Trigger Button for Beginners */}
        {!isApiMode && onOpenGlossary && (
          <button
            onClick={onOpenGlossary}
            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-indigo-950/70 text-indigo-300 border border-slate-700 hover:border-indigo-500/40 transition shadow-sm"
            title={lang === 'zh' ? '点击查看小白白话词典，扫除专业黑话' : 'Open Plain Glossary'}
          >
            <BookOpen className="w-3.5 h-3.5 text-indigo-400" />
            <span>{lang === 'zh' ? '白话词典' : 'Glossary'}</span>
          </button>
        )}

        {/* Dev Handoff Trigger Button */}
        {!isApiMode && onOpenDevHandoff && (
          <button
            onClick={onOpenDevHandoff}
            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-emerald-950/70 text-emerald-300 border border-slate-700 hover:border-emerald-500/40 transition shadow-sm"
            title={lang === 'zh' ? '一键导出面向技术人员的上线交接单' : 'Dev Handoff Package'}
          >
            <FileCode2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>{lang === 'zh' ? '技术交接单' : 'Dev Handoff'}</span>
          </button>
        )}

        {/* Gemini Status Pill */}
        {!isApiMode && <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 border border-slate-700 text-slate-300">
          <Bot className="w-3.5 h-3.5 text-blue-400" />
          <span>Gemini:</span>
          {hasGeminiKey ? (
            <span className="text-emerald-400 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" />
              {lang === 'zh' ? '已连接 (API Key)' : 'Active Key'}
            </span>
          ) : (
            <span className="text-amber-400 flex items-center gap-1" title="可在环境或系统设置中提供 GEMINI_API_KEY">
              <AlertCircle className="w-3 h-3" />
              {lang === 'zh' ? '内置合成引擎' : 'Built-in Engine'}
            </span>
          )}
        </div>}

        {isApiMode && (
          <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 border border-slate-700 text-slate-300">
            <Server className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-emerald-400 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" />
              {lang === 'zh' ? '后端已认证' : 'Backend authenticated'}
            </span>
          </div>
        )}

        {/* 明暗切换：亮色为默认。标题里写明当前是哪一个，读屏与悬停都能看出来。 */}
        <button
          onClick={toggleTheme}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition"
          title={theme === 'dark'
            ? (lang === 'zh' ? '当前：暗色 — 点击切到亮色' : 'Currently dark — switch to light')
            : (lang === 'zh' ? '当前：亮色 — 点击切到暗色' : 'Currently light — switch to dark')}
          aria-label={lang === 'zh' ? '切换明暗主题' : 'Toggle color theme'}
        >
          {theme === 'dark'
            ? <Moon className="w-3.5 h-3.5 text-indigo-400" />
            : <Sun className="w-3.5 h-3.5 text-amber-500" />}
          <span className="hidden lg:inline">{theme === 'dark'
            ? (lang === 'zh' ? '暗色' : 'Dark')
            : (lang === 'zh' ? '亮色' : 'Light')}</span>
        </button>

        {/* Live Site Preview Quick Link */}
        {onOpenPreview && <button
          onClick={onOpenPreview}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
          title={lang === 'zh' ? '查看生成的公开前台效果' : 'Preview Live Site'}
        >
          <Radio className="w-3.5 h-3.5 text-indigo-400 animate-pulse" />
          <span>{lang === 'zh' ? '前台站点预览' : 'Site Preview'}</span>
        </button>}

        {/* Quick Generate Button */}
        {onQuickGenerate && <button
          onClick={onQuickGenerate}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm transition"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>{lang === 'zh' ? 'AI 创作' : 'AI Studio'}</span>
        </button>}

        {/* Language Switch */}
        <button
          onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
          title={lang === 'zh' ? 'Switch to English' : '切换至中文'}
        >
          <Globe className="w-3.5 h-3.5 text-slate-400" />
          <span>{lang === 'zh' ? 'EN' : '中文'}</span>
        </button>

        {/* Admin Badge */}
        <div className="hidden lg:flex items-center gap-2 pl-2 border-l border-slate-800">
          <div className="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-xs font-bold text-slate-300">
            <Shield className="w-3.5 h-3.5 text-indigo-400" />
          </div>
          <div className="text-left text-xs">
            <div className="font-semibold text-slate-200">{adminName || 'Admin'}</div>
            <div className="text-[10px] text-slate-400">{adminRole || 'Super Administrator'}</div>
          </div>
          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-white"
              title={lang === 'zh' ? '退出登录' : 'Sign out'}
              aria-label={lang === 'zh' ? '退出登录' : 'Sign out'}
            >
              <LogOut className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
