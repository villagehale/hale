/**
 * What a caregiver's message carries — and, as much as anything here, what it does
 * NOT carry.
 *
 * This payload is assembled AFTER `classifyFamilyEvent` has already decided what this
 * role may see, so the redaction is upstream of the queue rather than at the renderer.
 * That ordering is the point: a payload sitting on pg-boss holds only what was already
 * cleared to leave, so a rendering bug cannot widen it and a queue row is not a second
 * copy of the household.
 */

/** One event on a caregiver's reminder: where to be, when, and for what. */
export interface CaregiverReminderEvent {
  /** family_events id — the batch anchor, never rendered. */
  eventRef: string;
  title: string;
  /** Start INSTANT (ISO); the local label is derived with `timeZone`. */
  startsAt: string;
  location: string | null;
}

export interface CaregiverReminderPayload {
  offset: '-P1D' | '-PT1H';
  /**
   * The RECIPIENT's own IANA zone (`users.timezone`), which is the one rule the whole
   * product renders times by — a co-parent who moved to Vancouver already reads the
   * Toronto swim class as 07:00, because there is no `families.timezone` anywhere in the
   * schema and never has been. The caregiver leg follows that convention rather than
   * inventing a second one for itself; making the label family-local is a product-wide
   * decision about every reminder, not a property of this payload.
   *
   * Worth knowing where it bites: `ensureCaregiverUser` (channel/caregiver/invites.ts)
   * never writes a zone, so a seat minted from a phone number sits on the column default.
   * The zone is real only for a caregiver who also holds an account of their own.
   */
  timeZone: string;
  events: CaregiverReminderEvent[];
}

function isReminderEvent(value: unknown): value is CaregiverReminderEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.eventRef === 'string' &&
    typeof v.title === 'string' &&
    typeof v.startsAt === 'string' &&
    (v.location === null || typeof v.location === 'string')
  );
}

export function asCaregiverReminderPayload(
  payload: Record<string, unknown>,
): CaregiverReminderPayload {
  const offset = payload.offset;
  if (offset !== '-P1D' && offset !== '-PT1H') {
    throw new Error(`caregiver reminder renderer: bad offset ${String(offset)}`);
  }
  if (typeof payload.timeZone !== 'string') {
    throw new Error('caregiver reminder renderer: missing timeZone');
  }
  if (!Array.isArray(payload.events) || !payload.events.every(isReminderEvent)) {
    throw new Error('caregiver reminder renderer: malformed events');
  }
  return { offset, timeZone: payload.timeZone, events: payload.events };
}
