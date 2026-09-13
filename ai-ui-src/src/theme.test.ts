import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  nextTheme,
  normalizeTheme,
  persistTheme,
  readStoredTheme,
} from './theme';

/** 最小的存储替身：只实现被用到的两个方法，避免依赖浏览器环境。 */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => { data[key] = value; },
  };
}

/** 最小的根元素替身：只记录 class 的增删。 */
function fakeRoot(initial: string[] = []) {
  const classes = new Set(initial);
  return {
    classes,
    classList: {
      add: (name: string) => { classes.add(name); },
      remove: (name: string) => { classes.delete(name); },
    },
  };
}

test('theme defaults to light and only accepts an explicit dark', () => {
  assert.equal(DEFAULT_THEME, 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme('light'), 'light');
  // 任何意外输入都必须回落到亮色——宁可回到默认，也不要停在半个主题上。
  assert.equal(normalizeTheme(null), 'light');
  assert.equal(normalizeTheme(undefined), 'light');
  assert.equal(normalizeTheme(''), 'light');
  assert.equal(normalizeTheme('Dark'), 'light');
  assert.equal(normalizeTheme(true), 'light');
});

test('stored theme is read from the documented key and survives a broken store', () => {
  assert.equal(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'dark' })), 'dark');
  assert.equal(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: 'light' })), 'light');
  assert.equal(readStoredTheme(fakeStorage()), 'light');
  assert.equal(readStoredTheme(null), 'light');
  // 存储抛异常（隐私模式/被禁用）时不能把界面带崩。
  assert.equal(readStoredTheme({ getItem: () => { throw new Error('blocked'); } }), 'light');
});

test('applying dark adds the class and applying light removes it', () => {
  const root = fakeRoot();
  applyTheme('dark', root);
  assert.equal(root.classes.has('dark'), true);

  // 亮色是**移除** `.dark`，不是加 `.light`——index.html 的预置脚本与 Tailwind 的 dark variant 都认 `.dark`。
  applyTheme('light', root);
  assert.equal(root.classes.has('dark'), false);
  assert.equal(root.classes.has('light'), false);
});

test('persisting writes the documented key and tolerates a failing store', () => {
  const storage = fakeStorage();
  persistTheme('dark', storage);
  assert.equal(storage.data[THEME_STORAGE_KEY], 'dark');
  persistTheme('light', storage);
  assert.equal(storage.data[THEME_STORAGE_KEY], 'light');

  assert.doesNotThrow(() => persistTheme('dark', { setItem: () => { throw new Error('quota'); } }));
});

test('toggling alternates between the two modes', () => {
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'light');
  // 往返必须回到原值，否则连点两下会停在意外的状态。
  assert.equal(nextTheme(nextTheme('light')), 'light');
});
