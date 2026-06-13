import type { DigestPerChildBreakdown } from '@hearth/db';

/**
 * Sibling calendar-overlap detection — a pure function over the day's calendar
 * actions. When two calendar actions (create/update_calendar_event) for DIFFERENT
 * children have overlapping time windows, it surfaces a coordination FLAG (never
 * a block): a parent with a newborn and a teenager who each have something booked
 * at the same time needs to see the clash.
 *
 * HONEST LIMITATION: Hearth has no canonical calendar-events store — Google
 * Calendar execution is `not_configured` (no OAuth wired), so no provider-side
 * event windows exist to diff against. The only time-windowed calendar data
 * available is in the day's own calendar ACTION payloads. This detector therefore
 * compares the day's calendar actions against each other, attributed by
 * events.child_id. It cannot see a sibling's PRE-EXISTING calendar event that
 * Hearth never touched. Once a real calendar integration lands, the same pure
 * function can take those windows as additional inputs — the wiring point (the
 * daily digest) and the flag shape stay the same.
 */

const CALENDAR_ACTION_TYPES = new Set(['create_calendar_event', 'update_calendar_event']);

/** Default event length when a payload gives a start but no end or duration. */
const DEFAULT_DURATION_MIN = 60;

export interface CalendarActionInput {
  actionId: string;
  childId: string | null;
  actionType: string;
  payload: Record<string, unknown>;
}

export type SiblingCalendarOverlapFlag = DigestPerChildBreakdown['coordinationFlags'][number];

interface Window {
  actionId: string;
  childId: string;
  startMs: number;
  endMs: number;
}

function parseMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Resolve a calendar action's [start, end) window. Returns null when the action
 * is not a calendar action, is unattributed, or has no parseable start — those
 * cannot be compared, so they produce no flag rather than a fabricated one.
 */
function windowFor(action: CalendarActionInput): Window | null {
  if (!CALENDAR_ACTION_TYPES.has(action.actionType)) return null;
  if (!action.childId) return null;

  const startMs = parseMs(action.payload.startsAt);
  if (startMs === null) return null;

  const explicitEnd = parseMs(action.payload.endsAt);
  let endMs: number;
  if (explicitEnd !== null) {
    endMs = explicitEnd;
  } else {
    const durationMin =
      typeof action.payload.durationMin === 'number'
        ? action.payload.durationMin
        : DEFAULT_DURATION_MIN;
    endMs = startMs + durationMin * 60_000;
  }

  return { actionId: action.actionId, childId: action.childId, startMs, endMs };
}

function overlaps(a: Window, b: Window): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

export function detectSiblingCalendarOverlaps(
  actions: CalendarActionInput[],
): SiblingCalendarOverlapFlag[] {
  const windows = actions
    .map(windowFor)
    .filter((w): w is Window => w !== null)
    .sort((a, b) => a.startMs - b.startMs);

  const flags: SiblingCalendarOverlapFlag[] = [];
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const earlier = windows[i];
      const later = windows[j];
      if (!earlier || !later) continue;
      if (earlier.childId === later.childId) continue;
      if (!overlaps(earlier, later)) continue;
      flags.push({
        kind: 'sibling_calendar_overlap',
        actionId: later.actionId,
        childId: later.childId,
        siblingChildId: earlier.childId,
        detail: `Calendar event for one child overlaps a sibling's event (action ${earlier.actionId}).`,
      });
    }
  }
  return flags;
}
