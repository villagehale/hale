'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_THEME_PREFERENCE,
  NEXT_PREFERENCE,
  THEME_COLOR,
  THEME_ORDER,
  THEME_STORAGE_KEY,
  type ThemePreference,
  isThemePreference,
} from '~/lib/site/theme';

/**
 * The two theme controls, on one store.
 *
 * What the page LOOKS like is settled before hydration — the layout's pre-paint
 * script writes `data-theme` and globals.css resolves the rest — so these
 * components only own the writing. The header icon renders both glyphs and lets
 * CSS pick between them (see `.theme-icon-*`), which is why the button is right
 * in the first painted frame; only its label, which has to name the stored
 * PREFERENCE rather than the resolved theme, waits for the store to be read on
 * mount.
 */

const NAME: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

const ICON = { light: Sun, dark: Moon, system: Monitor };

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

/**
 * Keeps the browser-chrome colour on an explicit choice. Next emits the
 * light/dark `theme-color` pair behind media queries, which is correct while the
 * preference is `system`; an override needs an unconditional tag to beat them,
 * and removing it hands the pair back.
 */
function syncThemeColor(preference: ThemePreference) {
  const existing = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (preference === 'system') {
    existing?.remove();
    return;
  }
  const meta = existing ?? document.head.appendChild(document.createElement('meta'));
  meta.name = 'theme-color';
  meta.content = THEME_COLOR[preference];
}

function useThemePreference() {
  const [preference, setPreference] = useState<ThemePreference>(DEFAULT_THEME_PREFERENCE);

  useEffect(() => {
    setPreference(readPreference());
  }, []);

  const choose = useCallback((next: ThemePreference) => {
    setPreference(next);
    if (next === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', next);
    syncThemeColor(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // A blocked storage bucket costs the reader persistence, not the theme —
      // the attribute above has already switched the page.
    }
  }, []);

  return { preference, choose };
}

/** The header control: one 44px icon that cycles light → dark → system. */
export function ThemeToggle() {
  const { preference, choose } = useThemePreference();
  const next = NEXT_PREFERENCE[preference];

  return (
    <button
      type="button"
      className="chrome-icon-btn"
      aria-label={`Theme: ${NAME[preference].toLowerCase()} — click for ${NAME[next].toLowerCase()}`}
      onClick={() => choose(next)}
    >
      <Sun className="theme-icon-light" size={19} strokeWidth={1.75} aria-hidden="true" />
      <Moon className="theme-icon-dark" size={19} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

/** The footer control: the three options, named, with the current one pressed. */
export function ThemeChoice() {
  const { preference, choose } = useThemePreference();

  return (
    <fieldset className="theme-choice" aria-label="Theme">
      {THEME_ORDER.map((option) => {
        const Icon = ICON[option];
        return (
          <button
            key={option}
            type="button"
            className="theme-choice-option inline-flex items-center gap-1.5"
            aria-pressed={preference === option}
            onClick={() => choose(option)}
          >
            <Icon size={13} strokeWidth={2} aria-hidden="true" />
            {NAME[option]}
          </button>
        );
      })}
    </fieldset>
  );
}
