// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import initScript from '../../public/theme-init.js?raw';
import { THEME_KEY, applyTheme, loadTheme } from './theme';

// Runs the pre-paint script exactly as the browser would, as a classic script.
const runInitScript = () => new Function(initScript)();

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
});

// @req UX-002
describe('theme preference', () => {
  it('defaults to System, which leaves the OS in control', () => {
    expect(loadTheme()).toBe('system');
    runInitScript();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it.each(['light', 'dark'] as const)('persists %s and restores it before first paint', (mode) => {
    applyTheme(mode);
    expect(document.documentElement.dataset.theme).toBe(mode);
    expect(localStorage.getItem(THEME_KEY)).toBe(mode);

    // Simulate a relaunch: fresh document state, then the pre-paint script and the app.
    delete document.documentElement.dataset.theme;
    runInitScript();
    expect(document.documentElement.dataset.theme).toBe(mode);
    expect(loadTheme()).toBe(mode);
  });

  it('returning to System clears the pinned theme and the saved choice', () => {
    applyTheme('dark');
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    runInitScript();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('ignores invalid saved values and unavailable storage', () => {
    localStorage.setItem(THEME_KEY, 'neon');
    expect(loadTheme()).toBe('system');
    runInitScript();
    expect(document.documentElement.dataset.theme).toBeUndefined();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadTheme()).toBe('system');
    expect(runInitScript).not.toThrow();
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
