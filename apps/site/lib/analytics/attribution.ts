import {
  type Attribution,
  ATTRIBUTION_KEYS,
  attributionIsEmpty,
  mergeFirstTouch,
  parseAttribution,
  serializeAttribution,
} from '@hale/types';

export const ATTRIBUTION_COOKIE = 'hale_attr';
export const ATTRIBUTION_STORAGE_KEY = 'hale.first_touch_attr';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * First-touch attribution from this URL plus whatever the tab already stored. The card
 * code is never taken from the URL under its attribution name: source-code.ts reads the
 * site's own `s` / `src` tag.
 */
export function readFirstTouchAttribution(
  search: string,
  storage: StorageLike | null,
): Attribution {
  const { source_code: _ignored, ...fromUrl } = parseAttribution(search);
  const remembered = storage
    ? parseAttribution(storage.getItem(ATTRIBUTION_STORAGE_KEY) ?? undefined)
    : {};
  const merged = mergeFirstTouch(remembered, fromUrl);
  if (storage && !attributionIsEmpty(merged)) {
    storage.setItem(ATTRIBUTION_STORAGE_KEY, serializeAttribution(merged));
  }
  return merged;
}

export function attributionCookie(attribution: Attribution, hostname: string): string | null {
  const value = serializeAttribution(attribution);
  if (!value) return null;
  const parts = [
    `${ATTRIBUTION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${MAX_AGE_SECONDS}`,
    'SameSite=Lax',
  ];
  const host = hostname.replace(/\.$/, '').toLowerCase();
  if (host === 'villagehale.com' || host.endsWith('.villagehale.com')) {
    parts.push('Domain=.villagehale.com');
  }
  return parts.join('; ');
}

export { ATTRIBUTION_KEYS, parseAttribution };
