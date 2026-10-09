'use client';

import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import {
  THEME_STORAGE_KEY,
  type ThemePreference,
  readStoredPreference,
  resolveTheme,
} from '~/lib/theme';
import styles from './portal.module.css';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/* Order follows iOS Display & Brightness: Light, Dark, then Automatic. */
const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Auto' },
];

/**
 * Same-document listeners. `storage` only fires in other tabs, and Settings
 * mounts the sidebar control and this card together.
 */
const listeners = new Set<(preference: ThemePreference) => void>();

function readPreference(): ThemePreference {
  try {
    return readStoredPreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

function writePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A blocked store still paints for this view. The pre-paint script has the
    // same try/catch: a thrown setItem must not leave the control half-applied.
  }
}

function apply(preference: ThemePreference): void {
  const dark = resolveTheme(preference, window.matchMedia(DARK_QUERY).matches) === 'dark';
  document.documentElement.classList.toggle('dark', dark);
}

function publish(preference: ThemePreference): void {
  apply(preference);
  for (const listener of listeners) listener(preference);
}

/**
 * Light / Dark / Auto as a text segmented control — no previews, no icons.
 * `side` sits above Sign out in the desktop sidebar; `card` is the Settings
 * row (the only home on a phone, where the sidebar becomes the tab bar).
 */
export function AppearanceControl({ variant }: { variant: 'side' | 'card' }) {
  const [pref, setPref] = useState<ThemePreference>('system');
  const buttons = useRef(new Map<ThemePreference, HTMLButtonElement>());

  useEffect(() => {
    const stored = readPreference();
    setPref(stored);
    apply(stored);
    const onChoice = (next: ThemePreference) => setPref(next);
    listeners.add(onChoice);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const next = readStoredPreference(event.newValue);
      apply(next);
      for (const listener of listeners) listener(next);
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(onChoice);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    if (pref !== 'system') return;
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => apply('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [pref]);

  function choose(next: ThemePreference) {
    writePreference(next);
    publish(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = OPTIONS.findIndex((option) => option.value === pref);
    let nextIndex = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % OPTIONS.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + OPTIONS.length) % OPTIONS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = OPTIONS.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const next = OPTIONS[nextIndex];
    if (!next) return;
    choose(next.value);
    buttons.current.get(next.value)?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className={variant === 'side' ? `${styles.look} ${styles.lookSide}` : styles.look}
      onKeyDown={onKeyDown}
    >
      {OPTIONS.map(({ value, label }) => {
        const selected = pref === value;
        return (
          <button
            key={value}
            ref={(node) => {
              if (node) buttons.current.set(value, node);
              else buttons.current.delete(value);
            }}
            type="button"
            // A native radio paints its own chrome and cannot take the Messages
            // filter pill. role="radio" is the segmented-control pattern.
            // biome-ignore lint/a11y/useSemanticElements: segmented text control, not a form radio
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            title={value === 'system' ? 'Auto: match this device' : label}
            className={selected ? `${styles.lookOpt} ${styles.segOn}` : styles.lookOpt}
            onClick={() => choose(value)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function AppearanceCard() {
  return (
    <section className={styles.card}>
      <span className={styles.tag}>Appearance</span>
      <AppearanceControl variant="card" />
      <p className={`${styles.meta} ${styles.lookNote}`}>Auto follows this device's setting.</p>
    </section>
  );
}
