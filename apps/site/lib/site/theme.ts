/**
 * The site's theme preference — one store, read by the pre-paint script in the
 * layout and by both toggles (the header icon and the footer three-way).
 *
 * `system` is the default and is stored as the ABSENCE of the attribute, because
 * globals.css resolves it in CSS: every themed token is a `light-dark()` pair and
 * `:root { color-scheme: light dark }` follows the OS on its own. So the script
 * only ever has to write an override — and a reader with JavaScript off still
 * gets their machine's theme, which a class-toggled dark mode cannot offer.
 */

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const THEME_STORAGE_KEY = 'hale-site-theme';

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

/** The order the footer's three-way lists the options in. */
export const THEME_ORDER: readonly ThemePreference[] = ['light', 'dark', 'system'];

/** What the header icon switches to, one tap on from here. */
export const NEXT_PREFERENCE: Record<ThemePreference, ThemePreference> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

/** The mobile browser chrome colour for each resolved theme. MUST track
 * globals.css --color-linen; layout.tsx pins the same two values in `viewport`
 * behind media queries, which is what covers the first paint. */
export const THEME_COLOR = { light: '#FDFCFA', dark: '#0C1A36' } as const;

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference);
}

/**
 * The pre-paint script, inlined into <head> by the layout. It writes the stored
 * override onto <html> before the first frame; anything else (no choice made,
 * unreadable storage, a stale value) leaves the attribute off, which is the
 * "follow the OS" state rather than a guess.
 */
export const NO_FLASH_SCRIPT = `(function(){try{var p=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(p==="light"||p==="dark"){document.documentElement.setAttribute("data-theme",p);}else{document.documentElement.removeAttribute("data-theme");}}catch(e){}})();`;
