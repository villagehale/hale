import { namesAny } from '@hale/types';

/**
 * VIL-634 · title and text gates share one matcher.
 *
 * Off unless `TEEN_NAME_SHARED_MATCHER_ENABLED` is exactly `true`. A trailing
 * newline, `TRUE`, `on`, and `1` stay off. Unset stays off. Lit, every gate
 * that hid a teen's title or text uses {@link namesAny}. Unlit, those gates
 * keep the pre-VIL-634 whole-word check (no accent fold, the full stored
 * token as one word).
 */

export const TEEN_NAME_SHARED_MATCHER_ENABLED_ENV = 'TEEN_NAME_SHARED_MATCHER_ENABLED';

export function teenNameSharedMatcherEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[TEEN_NAME_SHARED_MATCHER_ENABLED_ENV] === 'true';
}

/**
 * Whether `text` names any of `names` as a whole word. Lit: {@link namesAny}.
 * Unlit: the legacy coach/calendar check, so existing titles stay as they are
 * until Prod turns the flag on.
 */
export function teenNameIn(text: string, names: readonly string[]): boolean {
  if (teenNameSharedMatcherEnabled()) return namesAny(text, names);
  return mentionsAnyNameLegacy(text, names);
}

/** Pre-VIL-634 whole-word check: case-insensitive, no accent fold. */
function mentionsAnyNameLegacy(text: string, names: readonly string[]): boolean {
  return names.some((name) => {
    const token = name.trim();
    if (token.length < 2) return false;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(
      ` ${text} `,
    );
  });
}
