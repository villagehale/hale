import type { WeekPlanItem } from '@hale/db';

/**
 * What a caregiver's two messages carry — and, as much as anything here, what they do
 * NOT carry.
 *
 * These payloads are assembled AFTER `scopeWeekItemsForRole` / `classifyFamilyEvent`
 * have already decided what this role may see, so the redaction is upstream of the
 * queue rather than at the renderer. That ordering is the point: a payload sitting on
 * pg-boss holds only what was already cleared to leave, so a rendering bug cannot widen
 * it and a queue row is not a second copy of the household.
 *
 * WHICH IS WHY `children` IS NOT THE FAMILY'S CHILDREN. The parents' payloads ship every
 * child (id, name, DOB, gender) so the renderer can resolve the name dial. A caregiver's
 * ships only the children their own scoped items actually reference, and only id + name:
 * a teenager whose every item the scope filter removed must not still ride along as a
 * name and a date of birth (rule #1).
 */

/** A child a caregiver's message may name. Id to join on, name to say — nothing else. */
export interface CaregiverChild {
  id: string;
  name: string;
}

export interface CaregiverPlanPayload {
  /** Monday of the covered week (the artifact's key), YYYY-MM-DD. */
  weekStart: string;
  /** The week's items AFTER the role scope + teen gate. Never the whole plan. */
  items: WeekPlanItem[];
  /** Only the children those items reference. */
  children: CaregiverChild[];
}

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
  /** The family IANA timezone — the time labels are family-local, not the caregiver's,
   * because the time they need is the time the child is expected somewhere. */
  timeZone: string;
  events: CaregiverReminderEvent[];
}

function isPlanItem(value: unknown): value is WeekPlanItem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.title === 'string' && Array.isArray(v.childIds);
}

/** Narrow the A2 LoopMessage payload, throwing on a malformed one: the caregiver sender
 * is the only producer, so a bad payload is a wiring bug and fails loud (rule #8). */
export function asCaregiverPlanPayload(payload: Record<string, unknown>): CaregiverPlanPayload {
  const p = payload as Partial<CaregiverPlanPayload>;
  if (typeof p.weekStart !== 'string' || !Array.isArray(p.items) || !Array.isArray(p.children)) {
    throw new Error('caregiver plan renderer: malformed payload');
  }
  if (!p.items.every(isPlanItem)) throw new Error('caregiver plan renderer: malformed items');
  return { weekStart: p.weekStart, items: p.items, children: p.children };
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
