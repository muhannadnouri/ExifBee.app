import { useState } from 'react';
import { THEME_OPTIONS, applyTheme, loadTheme } from '../../app/theme';
import { Select } from '../../components/atoms/Select';
import './ThemeSwitcher.css';

/** Light / Dark / System selector; the choice applies immediately and persists. */
export function ThemeSwitcher() {
  const [theme, setTheme] = useState(loadTheme);
  return (
    <label className="theme-switcher">
      Theme
      <Select
        value={theme}
        options={THEME_OPTIONS}
        onChange={(next) => {
          applyTheme(next);
          setTheme(next);
        }}
      />
    </label>
  );
}
