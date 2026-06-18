'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  type ThemePreference,
  readStoredPreference,
  resolveTheme,
  THEME_STORAGE_KEY,
} from '~/lib/theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; Icon: typeof Sun }> = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

function applyResolved(preference: ThemePreference): void {
  const systemPrefersDark = window.matchMedia(DARK_QUERY).matches;
  const resolved = resolveTheme(preference, systemPrefersDark);
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

/**
 * Light / Dark / System control. Persists the choice to localStorage under the
 * key the pre-paint script reads, and — while on "System" — tracks live OS
 * changes. The pre-paint script in layout.tsx sets the class before this mounts,
 * so there is no flash; this only re-applies on user choice and OS change.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [preference, setPreference] = useState<ThemePreference>('system');

  useEffect(() => {
    setPreference(readStoredPreference(localStorage.getItem(THEME_STORAGE_KEY)));
  }, []);

  useEffect(() => {
    if (preference !== 'system') return;
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => applyResolved('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);

  function choose(next: ThemePreference): void {
    setPreference(next);
    localStorage.setItem(THEME_STORAGE_KEY, next);
    applyResolved(next);
  }

  return (
    <fieldset aria-label="Color theme" className={`theme-toggle${className ? ` ${className}` : ''}`}>
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={preference === value}
          aria-label={label}
          title={label}
          onClick={() => choose(value)}
          className="theme-toggle-option"
        >
          <Icon size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      ))}
    </fieldset>
  );
}
