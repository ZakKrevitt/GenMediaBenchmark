'use client';

import { useEffect, useState } from 'react';
import { ThemeSwitch } from './arc/theme-switch/theme-switch';

type Theme = 'light' | 'dark';
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    const id = requestAnimationFrame(() => setTheme(current === 'light' ? 'light' : 'dark'));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <ThemeSwitch
      theme={theme}
      iconOnly
      label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      onThemeChange={(next) => {
        setTheme(next);
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem('genmedia-theme', next);
        } catch {}
      }}
    />
  );
}
