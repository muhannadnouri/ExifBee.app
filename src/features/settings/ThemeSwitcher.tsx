import { useState } from 'react';
import { THEME_OPTIONS, applyTheme, loadTheme } from '../../app/theme';
import type { ThemePreference } from '../../app/theme';
import { IconButton } from '../../components/atoms/IconButton';
import type { IconName } from '../../components/atoms/Icon';

const ICONS: Record<ThemePreference, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' };

/**
 * One button cycling System → Light → Dark. The icon shows the current mode; because a
 * three-state icon is not self-explanatory, the name and tooltip say both the current mode and
 * what a click does. The choice applies immediately and persists.
 */
export function ThemeSwitcher() {
  const [theme, setTheme] = useState(loadTheme);
  const at = THEME_OPTIONS.findIndex((option) => option.value === theme);
  const current = THEME_OPTIONS[at] ?? THEME_OPTIONS[0];
  const next = THEME_OPTIONS[(at + 1) % THEME_OPTIONS.length] ?? THEME_OPTIONS[0];
  return (
    <IconButton
      icon={ICONS[theme]}
      label={`Theme: ${current?.label}. Switch to ${next?.label}`}
      onClick={() => {
        if (!next) return;
        applyTheme(next.value);
        setTheme(next.value);
      }}
    />
  );
}
