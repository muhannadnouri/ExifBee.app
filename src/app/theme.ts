// Theme preference (UX-002). System is the default and is pure CSS: tokens.css follows the OS
// through `color-scheme`, so OS changes apply live. An explicit choice pins `data-theme` on <html>;
// public/theme-init.js applies the saved choice before first paint.
export type ThemePreference = 'system' | 'light' | 'dark';

export const THEME_KEY = 'exifbee.theme';
export const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function loadTheme(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(preference: ThemePreference) {
  const root = document.documentElement;
  if (preference === 'system') delete root.dataset.theme;
  else root.dataset.theme = preference;
  try {
    if (preference === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, preference);
  } catch {
    // Storage unavailable: the choice still applies for this session.
  }
}
