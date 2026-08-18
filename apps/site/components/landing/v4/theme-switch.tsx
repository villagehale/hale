'use client';

import { Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  THEME_COLOR,
  THEME_STORAGE_KEY,
  type ThemePreference,
  isThemePreference,
} from '~/lib/site/theme';

/**
 * The v4 footer's light/dark switch — a two-state toggle, not the three-way.
 *
 * The default is `system`: with no stored choice the page follows the OS (the
 * pre-paint script writes no override and every token is a light-dark() pair), so
 * a visitor sees dark or light by their machine, time of day included. This
 * switch REFLECTS whatever is currently resolved and, when flipped, writes the
 * opposite as an explicit override. There is no visible "system" position — the
 * switch simply shows where you are; leaving it alone is following the OS.
 *
 * What the page looks like is already settled before hydration, so this only owns
 * the writing. The resolved state is read on mount (hence the null first frame on
 * the label, never on the layout).
 */

function resolveIsDark(): boolean {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(stored) && stored !== 'system') return stored === 'dark';
  } catch {
    // fall through to the OS query
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyPreference(preference: Exclude<ThemePreference, 'system'>) {
  document.documentElement.setAttribute('data-theme', preference);
  const existing = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  const meta = existing ?? document.head.appendChild(document.createElement('meta'));
  meta.name = 'theme-color';
  meta.content = THEME_COLOR[preference];
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // a written override is a nicety; the attribute already changed the paint
  }
}

/**
 * Labels default to English so the switch renders untranslated when used on its
 * own (unit tests); the footer passes the reader's language.
 */
export interface ThemeSwitchLabels {
  light: string;
  dark: string;
  toLight: string;
  toDark: string;
}

const DEFAULT_LABELS: ThemeSwitchLabels = {
  light: 'Light',
  dark: 'Dark',
  toLight: 'Switch to light mode',
  toDark: 'Switch to dark mode',
};

export function FooterThemeSwitch({ labels = DEFAULT_LABELS }: { labels?: ThemeSwitchLabels }) {
  const [isDark, setIsDark] = useState<boolean | null>(null);

  useEffect(() => {
    setIsDark(resolveIsDark());
    // While no explicit choice is stored, track the OS so the switch stays honest.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (!isThemePreference(stored) || stored === 'system') setIsDark(media.matches);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const toggle = useCallback(() => {
    const next = !(isDark ?? false);
    applyPreference(next ? 'dark' : 'light');
    setIsDark(next);
  }, [isDark]);

  const checked = isDark ?? false;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={checked ? labels.toLight : labels.toDark}
      className="v4-switch"
      onClick={toggle}
    >
      <span className="v4-switch-track">
        <span className="v4-switch-knob">
          {checked ? (
            <Moon size={13} aria-hidden="true" />
          ) : (
            <Sun size={13} aria-hidden="true" />
          )}
        </span>
      </span>
      <span className="v4-switch-label">{checked ? labels.dark : labels.light}</span>
    </button>
  );
}
