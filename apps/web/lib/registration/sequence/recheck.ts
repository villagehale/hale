import type { RegistrationWindow } from '@hale/db';
import { type DateCheckMode, type DateUnreadReason, compareWithReading } from '../date-check';
import { type RegistrationReader, registrationDate, windowReadTarget } from '../read';
import { READINESS_LEAD_DAYS } from './schedule.js';

/**
 * VIL-423 · slice 4b — the scheduled re-read of every watched registration page.
 *
 * The ladder's legs are a pure function of one anchor (schedule.ts), so a page that
 * moves its opening moves every unsent leg the moment the anchor moves. Before this, the
 * anchor was the catalog row, and the page was read only once a leg was already due: a
 * page that moved the 20th to the 18th could be read after the 18th's legs had passed.
 *
 * What this module decides, and nothing else: which pages are due a read, and what one
 * read means for each ladder watching that page. It is pure over an injected reader; the
 * caller (run.ts) persists the patch, writes the audit row and sends the change note.
 *
 * THE STORED DATE IS NEVER PARENT-FACING TRUTH. `last_reading` holds the date the page
 * last showed, with its URL and read time, for scheduling and change detection only.
 * Every dated text still reads the page at send time (date-check.ts).
 *
 * ONE READ PER PAGE. Ladders are grouped by what they ask the reader; a group is read
 * once when any member is due, and every member is rescheduled from that read, so two
 * families watching one page cost one read.
 */

/** From this far ahead of the opening, the page is read hourly: the readiness checklist,
 * the evening-before plan and the go text all land inside it, and a move found an hour
 * late still reaches each of them. Before it, once a day. */
export const RECHECK_HOURLY_LEAD_DAYS = READINESS_LEAD_DAYS;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Distinct pages read per sweep tick. A read is a fetch and a model call; the tick also
 * has the go leg to send inside a fifteen-minute window. Pages left over stay due and are
 * read on the next tick, soonest opening first. */
export const MAX_RECHECK_READS_PER_RUN = 3;

/** What a ladder stores about its page's last read: the opening the page showed for this
 * family, the page it was read off, and whether that was the resident date. */
export interface LastSeenOpen {
  openAt: string;
  sourceUrl: string;
  resident: boolean;
  /** False when the page printed a day and no time. */
  timePrinted: boolean;
}

/** A moved date the household has not yet been told about. `from` is the opening Hale
 * last stated to them, kept across a second move so the note compares with what they
 * heard. */
export interface PendingDateChange {
  from: string;
  to: string;
  toTimePrinted: boolean;
}

function isoInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export function parseLastSeen(raw: Record<string, unknown> | null): LastSeenOpen | null {
  if (raw === null) return null;
  const { openAt, sourceUrl, resident, timePrinted } = raw;
  if (!isoInstant(openAt) || typeof sourceUrl !== 'string') return null;
  if (typeof resident !== 'boolean' || typeof timePrinted !== 'boolean') return null;
  return { openAt, sourceUrl, resident, timePrinted };
}

export function parsePendingChange(raw: Record<string, unknown> | null): PendingDateChange | null {
  if (raw === null) return null;
  const { from, to, toTimePrinted } = raw;
  if (!isoInstant(from) || !isoInstant(to) || typeof toTimePrinted !== 'boolean') return null;
  return { from, to, toTimePrinted };
}

/** The opening the page last showed this family, or null when there is none for THIS
 * window's page and THIS family's residency: a reading of another page, or of the other
 * date, is not evidence about this ladder. */
export function lastSeenOpenAt(
  raw: Record<string, unknown> | null,
  window: Pick<RegistrationWindow, 'sourceUrl'>,
  resident: boolean,
): Date | null {
  const seen = parseLastSeen(raw);
  if (seen === null || seen.sourceUrl !== window.sourceUrl || seen.resident !== resident) {
    return null;
  }
  return new Date(seen.openAt);
}

/** When the page is next due a read, given the opening it is being watched for. */
export function nextRecheckAt(anchor: Date, now: Date): Date {
  const hourlyFrom = anchor.getTime() - RECHECK_HOURLY_LEAD_DAYS * DAY_MS;
  if (now.getTime() >= hourlyFrom) return new Date(now.getTime() + HOUR_MS);
  return new Date(Math.min(now.getTime() + DAY_MS, hourlyFrom));
}

export interface RecheckSubject {
  sequenceId: string;
  window: Pick<
    RegistrationWindow,
    'id' | 'municipality' | 'programDomain' | 'cycleLabel' | 'sourceUrl' | 'district'
  >;
  resident: boolean;
  /** The opening the ladder runs on right now. */
  anchor: Date;
  nextCheckAt: Date | null;
  pendingChange: PendingDateChange | null;
}

/**
 * `unchanged`: the page shows the opening the ladder runs on.
 * `moved`: the page shows another opening, still ahead.
 * `already_open`: the page shows an opening already past. Nothing moves: a ladder
 *   re-anchored on the past would fire its check-in for a morning nobody was told of.
 * `unread`: no date this family acts on could be read, by `reason`. Nothing moves.
 */
export type RecheckOutcome = 'unchanged' | 'moved' | 'already_open' | 'unread';

export const RECHECK_OUTCOMES: readonly RecheckOutcome[] = [
  'unchanged',
  'moved',
  'already_open',
  'unread',
];

export interface DateWatchPatch {
  lastReading?: LastSeenOpen;
  lastReadAt?: Date;
  nextCheckAt?: Date;
  /** Null clears it: the page moved back to the opening the household was told. */
  pendingChange?: PendingDateChange | null;
}

export interface RecheckResult {
  subject: RecheckSubject;
  outcome: RecheckOutcome;
  reason: DateUnreadReason | null;
  detail: string | null;
  /** What to store. Empty when nothing changes (a busy reader is retried next tick). */
  patch: DateWatchPatch;
}

function targetKey(subject: RecheckSubject): string {
  return JSON.stringify(windowReadTarget(subject.window));
}

/**
 * Read every page due a read (at most {@link MAX_RECHECK_READS_PER_RUN}), once each,
 * and say what each read means for every ladder on that page. `shadow` stores only when
 * to read next; `enforce` also stores the date and the change the household is owed.
 */
export async function recheckWatchedDates(
  subjects: readonly RecheckSubject[],
  createReader: () => RegistrationReader | null,
  mode: Exclude<DateCheckMode, 'off'>,
  now: Date,
): Promise<{ results: RecheckResult[]; reads: number }> {
  const groups = new Map<string, RecheckSubject[]>();
  for (const subject of subjects) {
    const key = targetKey(subject);
    groups.set(key, [...(groups.get(key) ?? []), subject]);
  }
  const due = [...groups.values()]
    .filter((group) =>
      group.some((s) => s.nextCheckAt === null || s.nextCheckAt.getTime() <= now.getTime()),
    )
    .sort(
      (a, b) =>
        Math.min(...a.map((s) => s.anchor.getTime())) -
        Math.min(...b.map((s) => s.anchor.getTime())),
    )
    .slice(0, MAX_RECHECK_READS_PER_RUN);
  if (due.length === 0) return { results: [], reads: 0 };

  const reader = createReader();
  const results: RecheckResult[] = [];
  let reads = 0;
  for (const group of due) {
    const [first] = group as [RecheckSubject];
    reads += 1;
    const reading = reader === null ? null : await reader(windowReadTarget(first.window), now);
    for (const subject of group) {
      const check =
        reading === null
          ? ({ outcome: 'unread', reason: 'no_reader', detail: null } as const)
          : compareWithReading(reading, subject.anchor, subject.resident);
      if (check.outcome === 'unread') {
        results.push({
          subject,
          outcome: 'unread',
          reason: check.reason,
          detail: check.detail,
          // Busy says nothing about the page: it stays due and is read next tick.
          patch: check.reason === 'busy' ? {} : { nextCheckAt: nextRecheckAt(subject.anchor, now) },
        });
        continue;
      }
      const liveAt = check.liveAt;
      const moved = check.outcome === 'disagree' && liveAt.getTime() > now.getTime();
      const outcome: RecheckOutcome =
        check.outcome === 'agree' ? 'unchanged' : moved ? 'moved' : 'already_open';
      const date = reading === null ? null : registrationDate(reading, subject.resident);
      const seen: LastSeenOpen = {
        openAt: liveAt.toISOString(),
        sourceUrl: subject.window.sourceUrl,
        resident: subject.resident,
        timePrinted: date?.time != null,
      };
      const patch: DateWatchPatch = {
        nextCheckAt: nextRecheckAt(moved && mode === 'enforce' ? liveAt : subject.anchor, now),
      };
      if (mode === 'enforce' && outcome !== 'already_open') {
        patch.lastReading = seen;
        patch.lastReadAt = now;
        if (moved) {
          const from = subject.pendingChange?.from ?? subject.anchor.toISOString();
          patch.pendingChange =
            Date.parse(from) === liveAt.getTime()
              ? null
              : { from, to: seen.openAt, toTimePrinted: seen.timePrinted };
        }
      }
      results.push({ subject, outcome, reason: null, detail: null, patch });
    }
  }
  return { results, reads };
}
