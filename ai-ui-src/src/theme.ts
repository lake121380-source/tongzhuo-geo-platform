/**
 * 明暗主题：**亮色为默认**，偏好存在 localStorage。
 *
 * 为什么单独一个模块：主题是纯逻辑（读存储 → 决定挂不挂 `.dark` 类），
 * 抽出来就能像 `permissions.ts` 那样单测，不必依赖组件测试（本项目没有）。
 *
 * 真正的配色在 `index.css`：Tailwind 的 slate 刻度与 white 被指向主题变量，
 * 组件里那些 `bg-slate-900` / `text-white` 一个都不用改，跟着 `.dark` 走。
 */

export type ThemeMode = 'light' | 'dark';

/** 与 `geoflow.api.v1.*` 的命名保持一致。 */
export const THEME_STORAGE_KEY = 'geoflow.ui.theme';

/** 哥哥 2026-09-12 定：默认亮色，可切到暗色。 */
export const DEFAULT_THEME: ThemeMode = 'light';

/** 只认 `'dark'`，其余（含 null / 乱写的值）一律回落到亮色。 */
export function normalizeTheme(value: unknown): ThemeMode {
  return value === 'dark' ? 'dark' : 'light';
}

/** 读取已保存的偏好；存储不可用（隐私模式等）时静默回落默认值。 */
export function readStoredTheme(storage?: Pick<Storage, 'getItem'> | null): ThemeMode {
  const target = storage === undefined
    ? (typeof window !== 'undefined' ? window.localStorage : null)
    : storage;
  if (!target) return DEFAULT_THEME;
  try {
    return normalizeTheme(target.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function persistTheme(mode: ThemeMode, storage?: Pick<Storage, 'setItem'> | null): void {
  const target = storage === undefined
    ? (typeof window !== 'undefined' ? window.localStorage : null)
    : storage;
  if (!target) return;
  try {
    target.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 存不下不影响本次会话的主题，忽略。
  }
}

/**
 * 只声明真正用到的两个方法——这样测试可以传一个替身，
 * 不必为了满足 `DOMTokenList` 去实现 length/value/contains/item 等一堆无关成员。
 */
export interface ThemeRoot {
  classList: {
    add(name: string): void;
    remove(name: string): void;
  };
}

/**
 * 把主题落到 DOM 上：亮色**移除** `.dark`（而不是加个 `.light`），
 * 因为 `index.html` 的预置脚本与 Tailwind 的 dark variant 都认 `.dark`。
 */
export function applyTheme(mode: ThemeMode, root?: ThemeRoot | null): void {
  const target = root === undefined
    ? (typeof document !== 'undefined' ? document.documentElement : null)
    : root;
  if (!target) return;
  if (mode === 'dark') target.classList.add('dark');
  else target.classList.remove('dark');
}

export function nextTheme(mode: ThemeMode): ThemeMode {
  return mode === 'dark' ? 'light' : 'dark';
}
