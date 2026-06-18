/**
 * Theme preference logic — the pure, framework-free core the toggle UI and the
 * pre-hydration inline script both build on. Mirrors apps/web/lib/theme.ts:
 * apps/site is a separate app and cannot import across the app boundary.
 *
 * A "preference" is what the user chose (light / dark / system); a "resolved"
 * theme is the concrete light/dark that system collapses to via the OS media
 * query. Only the resolved value ever becomes the `.dark` class on <html>.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'hale-theme';
export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/**
 * Reads a stored preference, falling back to 'system' for anything missing or
 * corrupt. 'system' is the deliberate default at this boundary (no stored
 * choice is a valid, expected state).
 */
export function readStoredPreference(raw: string | null): ThemePreference {
  return isThemePreference(raw) ? raw : 'system';
}

/** Collapse a preference to the concrete theme to paint, given the OS setting. */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }
  return preference;
}
