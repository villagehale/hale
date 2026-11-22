import { createHash } from 'node:crypto';
import { isEnabled } from '@hale/flags';
import { MID_ACTIVITY_ASK_TEMPLATE_KEY } from './mid-activity/claim';

/**
 * VIL-740. `channel_messages_dedupe_key_uniq` is global, so a send key with no family in it
 * lets one family's text use up another's: the second family gets no text, no row and no
 * page. Exactly `true` puts the family in these keys. Anything else leaves every key as it
 * was built, with no added read.
 */
export const FAMILY_SCOPED_SEND_KEYS_ENV = 'FAMILY_SCOPED_SEND_KEYS_ENABLED';

export function familyScopedSendKeysEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('family-scoped-send-keys', undefined, env);
}

export interface FamilySendKey {
  /** The key this send claims and writes. */
  dedupeKey: string;
  /**
   * The same text's key from before the family was in it, which an older row may carry.
   * Null with the flag off and for a key with no family form.
   */
  legacyDedupeKey: string | null;
}

export const DUTY_ASK_KEY_PREFIX = 'duty_ask:';
const GROUP_PREFIX = 'linq-group:';
const GROUP_KINDS = ['who-takes', 'conflict', 'handoff', 'kids', 'followup', 'clash'];
const SAID_PREFIX = `${MID_ACTIVITY_ASK_TEMPLATE_KEY}:said:`;
const QUIET_PREFIX = 'linq:group_quiet_notice:';
/** `midActivityAskRef` allows exactly three colon parts, so the said key joins with `#`. */
const FAMILY_SLOTS = [
  { prefix: GROUP_PREFIX, separator: ':' },
  { prefix: QUIET_PREFIX, separator: ':' },
  { prefix: SAID_PREFIX, separator: '#' },
  { prefix: DUTY_ASK_KEY_PREFIX, separator: ':' },
] as const;

function withoutFamily(key: string, familyId: string): string {
  for (const { prefix, separator } of FAMILY_SLOTS) {
    const scoped = `${prefix}${familyId}${separator}`;
    if (key.startsWith(scoped)) return `${prefix}${key.slice(scoped.length)}`;
  }
  return key;
}

/** This family's form of a key built with no family in it. Null for every other key. */
function scopedForm(legacy: string, familyId: string): string | null {
  if (legacy.startsWith(SAID_PREFIX)) {
    return `${SAID_PREFIX}${familyId}#${legacy.slice(SAID_PREFIX.length)}`;
  }
  if (legacy.startsWith(QUIET_PREFIX)) {
    return `${QUIET_PREFIX}${familyId}:${legacy.slice(QUIET_PREFIX.length)}`;
  }
  if (legacy.startsWith(DUTY_ASK_KEY_PREFIX)) {
    return `${DUTY_ASK_KEY_PREFIX}${familyId}:${legacy.slice(DUTY_ASK_KEY_PREFIX.length)}`;
  }
  if (!legacy.startsWith(GROUP_PREFIX)) return null;
  const rest = legacy.slice(GROUP_PREFIX.length);
  const kind = GROUP_KINDS.find((name) => rest.startsWith(`${name}:`));
  if (kind === undefined) return null;
  // `clash:<hash>:1to1:<parent>` is the cross-parent 1:1 key, read as it is by its own sweep.
  if (kind === 'clash' && rest.slice('clash:'.length).includes(':')) return null;
  return `${GROUP_PREFIX}${familyId}:${rest}`;
}

/**
 * Takes a key in either shape and returns the same pair, because the decider holds only the
 * string on a candidate row and must arrive at the key the sweep would have used.
 */
export function familySendKey(key: string, familyId: string): FamilySendKey {
  if (!familyScopedSendKeysEnabled()) return { dedupeKey: key, legacyDedupeKey: null };
  const legacy = withoutFamily(key, familyId);
  const scoped = scopedForm(legacy, familyId);
  return scoped === null
    ? { dedupeKey: key, legacyDedupeKey: null }
    : { dedupeKey: scoped, legacyDedupeKey: legacy };
}

/** The key with no family in it, so one send compares equal under either shape. */
export function unscopedSendKey(key: string, familyId: string): string {
  return familySendKey(key, familyId).legacyDedupeKey ?? key;
}

/** A key Linq sees. A scoped key names the family, so only its hash leaves. */
export function providerPollKey(key: FamilySendKey): string {
  return key.legacyDedupeKey === null
    ? `poll:${key.dedupeKey}`
    : `poll:${createHash('sha256').update(key.dedupeKey).digest('hex')}`;
}
