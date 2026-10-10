/**
 * Whether a dated activity still fits on a Saturday that already has something on it.
 *
 * A 10:00–12:30 study block is not the whole day. The activity needs a free window
 * that covers its own clock time plus a travel buffer. An all-day entry blocks the
 * day only when it is a real commitment: cancelled, free, and transparent entries
 * do not.
 */

export const TRAVEL_BUFFER_MINUTES = 45;
export const DEFAULT_ACTIVITY_MINUTES = 60;
export const WAKING_START_MINUTE = 9 * 60;
export const WAKING_END_MINUTE = 20 * 60;
const ALL_DAY_MINUTES = 20 * 60;

export interface DayCommitment {
  childId: string | null;
  startMinute: number | null;
  endMinute: number | null;
  allDay: boolean;
  /** Google's transparency. Null means the feed did not say. */
  transparency: 'opaque' | 'transparent' | null;
  status: 'confirmed' | 'tentative' | 'cancelled' | 'free' | null;
}

export interface ActivitySpan {
  startMinute: number | null;
  endMinute: number | null;
}

export function parseClockLabel(label: string | null | undefined): ActivitySpan {
  if (!label) return { startMinute: null, endMinute: null };
  const clocks = [...label.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/gi)];
  const minutes = clocks
    .map((match) => {
      let hour = Number(match[1]);
      const minute = match[2] ? Number(match[2]) : 0;
      const meridiem = match[3]?.toLowerCase().replace(/\./g, '') ?? '';
      if (hour > 23 || minute > 59) return null;
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      if (meridiem === '' && hour <= 23) return hour * 60 + minute;
      if (meridiem === 'am' || meridiem === 'pm') return hour * 60 + minute;
      return null;
    })
    .filter((value): value is number => value !== null);
  const start = minutes[0] ?? null;
  const end = minutes[1] ?? null;
  return { startMinute: start, endMinute: end };
}

export function isRealCommitment(commitment: DayCommitment): boolean {
  if (commitment.status === 'cancelled' || commitment.status === 'free') return false;
  if (commitment.transparency === 'transparent') return false;
  return true;
}

function appliesTo(commitment: DayCommitment, childId: string): boolean {
  return commitment.childId === null || commitment.childId === childId;
}

function spanOf(commitment: DayCommitment): { start: number; end: number } | 'day' | null {
  if (!isRealCommitment(commitment)) return null;
  if (commitment.allDay) return 'day';
  if (commitment.startMinute === null) return null;
  const start = commitment.startMinute;
  const end =
    commitment.endMinute !== null && commitment.endMinute > start
      ? commitment.endMinute
      : start + DEFAULT_ACTIVITY_MINUTES;
  if (end - start >= ALL_DAY_MINUTES) return 'day';
  return { start, end };
}

function activityBlock(activity: ActivitySpan): { start: number; end: number } | null {
  if (activity.startMinute === null) return null;
  const start = activity.startMinute;
  const end =
    activity.endMinute !== null && activity.endMinute > start
      ? activity.endMinute
      : start + DEFAULT_ACTIVITY_MINUTES;
  return { start: start - TRAVEL_BUFFER_MINUTES, end };
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function gapFits(blocks: ReadonlyArray<{ start: number; end: number }>, needed: number): boolean {
  const clipped = blocks
    .map((block) => ({
      start: Math.max(WAKING_START_MINUTE, block.start),
      end: Math.min(WAKING_END_MINUTE, block.end),
    }))
    .filter((block) => block.end > block.start)
    .sort((a, b) => a.start - b.start);
  let cursor = WAKING_START_MINUTE;
  for (const block of clipped) {
    if (block.start - cursor >= needed) return true;
    if (block.end > cursor) cursor = block.end;
  }
  return WAKING_END_MINUTE - cursor >= needed;
}

/** True when this child still has a window the activity can use. */
export function childCanAttend(
  commitments: readonly DayCommitment[],
  activity: ActivitySpan,
  childId: string,
): boolean {
  const blocks: { start: number; end: number }[] = [];
  for (const commitment of commitments) {
    if (!appliesTo(commitment, childId)) continue;
    const span = spanOf(commitment);
    if (span === null) continue;
    if (span === 'day') return false;
    blocks.push(span);
  }
  const wanted = activityBlock(activity);
  if (wanted === null) {
    return gapFits(blocks, DEFAULT_ACTIVITY_MINUTES + TRAVEL_BUFFER_MINUTES);
  }
  return blocks.every((block) => !overlaps(wanted, block));
}
