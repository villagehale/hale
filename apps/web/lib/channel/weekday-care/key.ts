/**
 * THE ASK'S DEDUPE KEY, minted and parsed in one place.
 *
 * The weekday-care question names ONE child, and the answer is filed against that
 * child — but the parent's words rarely say who ("she's home with me" names nobody).
 * So the subject comes from the key of the message that asked, exactly the way the
 * health nudge's told-marker is parsed back out of its own key.
 *
 * FIXED ARITY, and that is the whole safety property: the key is five colon-separated
 * parts and a parse that finds anything else returns null rather than guessing which
 * segment was the child. Both directions live here so a change to the shape cannot
 * change the sender without changing the reader.
 */

const PREFIX = 'nudge';
const KIND = 'weekday_care';
const PARTS = 5;

export function weekdayCareDedupeKey(
  familyId: string,
  childId: string,
  parentUserId: string,
): string {
  return `${PREFIX}:${familyId}:${KIND}:${childId}:${parentUserId}`;
}

/** The child this key asked about, or null when the key is not one of ours. Null is a
 * real outcome: `channel_messages.dedupe_key` holds every lane's keys, and a reader
 * that coerced one of those into a child id would file an answer against a stranger. */
export function childIdFromWeekdayCareKey(key: string | null): string | null {
  if (key === null) return null;
  const parts = key.split(':');
  if (parts.length !== PARTS) return null;
  if (parts[0] !== PREFIX || parts[2] !== KIND) return null;
  const childId = parts[3];
  return childId !== undefined && childId.length > 0 ? childId : null;
}
