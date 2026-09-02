'use client';

import { useSyncExternalStore } from 'react';

/**
 * Chart colors for the admin surface, resolved per theme. Recharts writes SVG
 * presentation attributes, which cannot read CSS custom properties — so the
 * adm-* tokens in app/(authed)/admin/admin.css are mirrored here as concrete
 * strings, keyed off the `.dark` class on <html> (the app's ONLY theme
 * strategy; the pre-paint script + theme toggle own that class). Keep the two
 * files in sync.
 */
export interface AdminChartTheme {
  /** ink-series marks — navy in light, the warm cream ink in dark */
  ink: string;
  /** amber-series marks — FILL-only discipline; brightened on navy */
  amber: string;
  /** grid hairlines — subtle in both themes */
  grid: string;
  /** the x-axis base line */
  axis: string;
  /** tick label text (adm-ink-3) */
  tick: string;
  /** direct end-of-line series labels (adm-ink-2 — AA on the panel) */
  label: string;
  /** the bar-hover cursor wash (adm-wash) */
  cursor: string;
}

const LIGHT: AdminChartTheme = {
  ink: '#17294a',
  amber: '#b26b1f',
  grid: '#eceef3',
  axis: '#e4e7ee',
  tick: '#5c6b87',
  label: '#3d4c68',
  cursor: '#fef0c7',
};

const DARK: AdminChartTheme = {
  ink: '#f6f1e7',
  amber: '#e0a44e',
  grid: 'rgb(246 241 231 / 0.1)',
  axis: 'rgb(246 241 231 / 0.24)',
  tick: '#9bb0d0',
  label: '#c7d3e6',
  cursor: 'rgb(246 241 231 / 0.08)',
};

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

/** Live theme for recharts islands: re-renders when the toggle flips `.dark`. */
export function useAdminChartTheme(): AdminChartTheme {
  const dark = useSyncExternalStore(
    subscribe,
    () => document.documentElement.classList.contains('dark'),
    () => false,
  );
  return dark ? DARK : LIGHT;
}
