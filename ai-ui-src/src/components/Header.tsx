import React from 'react';
import { adminRoleLabel } from '../api/labels';
import {
  Globe,
  Sparkles,
  Radio,
  LogOut,
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
    <header className="h-16 border-b border-slate-800 bg-slate-900/95 backdrop-blur-md px-4 sm:px-6 flex items-center justify-end sticky top-0 z-30">
      {/* 品牌区 2026-09-18 已挪进侧栏（设计稿是「侧栏通高、品牌在侧栏顶部」）。
          这里只留动作，不再重复标识。 */}

      {/* Center Actions / Status */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* 顶栏只留「动作」，连接状态等常驻信息交给侧栏底部的状态条——
            原来这里挂着一个「后端已认证」小牌，每一屏都在，却从不变化。 */}

        {/* 明暗切换：亮色为默认。标题里写明当前是哪一个，读屏与悬停都能看出来。 */}
        <button
          onClick={toggleTheme}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
          title={theme === 'dark'
            ? (lang === 'zh' ? '当前：暗色 — 点击切到亮色' : 'Currently dark — switch to light')
            : (lang === 'zh' ? '当前：亮色 — 点击切到暗色' : 'Currently light — switch to dark')}
          aria-label={lang === 'zh' ? '切换明暗主题' : 'Toggle color theme'}
        >
          {theme === 'dark'
            ? <Moon className="w-4 h-4" />
            : <Sun className="w-4 h-4" />}
        </button>

        {/* Live Site Preview Quick Link */}
        {onOpenPreview && <button
          onClick={onOpenPreview}
          className="flex items-center gap-1.5 px-3 h-9 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
          title={lang === 'zh' ? '查看生成的公开前台效果' : 'Preview Live Site'}
        >
          <Radio className="w-3.5 h-3.5 text-indigo-400" />
          <span className="hidden sm:inline">{lang === 'zh' ? '站点预览' : 'Site Preview'}</span>
        </button>}

        {/* Quick Generate Button: 全站的「写文章」主入口，点了直达生成弹窗 */}
        {onQuickGenerate && <button
          onClick={onQuickGenerate}
          className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm transition"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>{lang === 'zh' ? 'AI 创作' : 'AI Studio'}</span>
        </button>}

        {/* Language Switch */}
        <button
          onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
          className="flex items-center gap-1 px-2.5 h-9 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
          title={lang === 'zh' ? 'Switch to English' : '切换至中文'}
        >
          <Globe className="w-3.5 h-3.5 text-slate-400" />
          <span>{lang === 'zh' ? 'EN' : '中文'}</span>
        </button>

        {/* Admin Badge */}
        <div className="hidden lg:flex items-center gap-2 pl-3 ml-1 border-l border-slate-800">
          <div className="w-7 h-7 rounded-full bg-indigo-500/15 border border-indigo-500/25 flex items-center justify-center text-xs font-bold text-indigo-500">
            {(adminName || 'A').slice(0, 1).toUpperCase()}
          </div>
          <div className="text-left text-xs">
            <div className="font-semibold text-slate-200">{adminName || 'Admin'}</div>
            <div className="text-[10px] text-slate-400">{adminRoleLabel(adminRole, lang)}</div>
          </div>
          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-white"
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
