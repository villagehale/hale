/** The outbound discriminator for a mid-activity ask. Not the VIL-366 follow-up key. */
export const MID_ACTIVITY_ASK_TEMPLATE_KEY = 'mid-activity:ask';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function midActivityAskDedupeKey(offerId: string): string {
  return `${MID_ACTIVITY_ASK_TEMPLATE_KEY}:${offerId}`;
}

/** The signup offer inside a key this module built, or null for anything else. */
export function offerIdFromMidActivityDedupeKey(dedupeKey: string | null): string | null {
  if (!dedupeKey) return null;
  const prefix = `${MID_ACTIVITY_ASK_TEMPLATE_KEY}:`;
  if (!dedupeKey.startsWith(prefix)) return null;
  const id = dedupeKey.slice(prefix.length);
  return UUID.test(id) ? id : null;
}
