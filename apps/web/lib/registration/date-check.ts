import type { RegistrationWindow } from '@hale/db';
import { flagValue } from '@hale/flags';
import { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import type { LiveRegistrationReading } from './live-reading';
import { registrationAnchor } from './live-reading';
import {
  type RegistrationReader,
  createLiveRegistrationReader,
  registrationDate,
  windowReadTarget,
} from './read';
import { DATE_ONLY_WALL_CLOCK } from './verify-window';

/**
 * VIL-423 · the send-time date check: before a reminder states a catalog window's
 * opening, Hale reads that window's page through the live reader and states the date
 * only when the page corroborates it.
 *
 * Three modes, read from {@link REGISTRATION_DATE_CHECK_ENV}:
 *   `off`     — no read; the senders behave as before.
 *   `shadow`  — read, log agree / disagree / unread per window id, change nothing.
 *   `enforce` — the senders act on the result.
 *
 * Strict equality, no trim: a trailing newline from `vercel env add` must not arm it.
 */

export const REGISTRATION_DATE_CHECK_ENV = 'REGISTRATION_DATE_CHECK';

export type DateCheckMode = 'off' | 'shadow' | 'enforce';

export function registrationDateCheckMode(): DateCheckMode {
  const value = flagValue('registration-date-check');
  return value === 'shadow' || value === 'enforce' ? value : 'off';
}

/** Why a check could not corroborate the stored date. The reading's own status, or one
 * of the check's own names:
 *   `no_reader` — no model client is configured, so no page can be read;
 *   `no_family_date` — the page verified, but names no opening this family acts on;
 *   `time_not_on_page` — the page prints the stored day with no time, and the reminder
 *     would state a time. */
export type DateUnreadReason =
  | Exclude<LiveRegistrationReading['status'], 'verified'>
  | 'no_reader'
  | 'no_family_date'
  | 'time_not_on_page';

export type DateCheck =
  | { outcome: 'agree'; liveAt: Date }
  /** `liveAt` is the opening the page verifies for this family. */
  | { outcome: 'disagree'; liveAt: Date }
  | { outcome: 'unread'; reason: DateUnreadReason; detail: string | null };

export type DateCheckOutcome = DateCheck['outcome'];

export const DATE_CHECK_OUTCOMES: readonly DateCheckOutcome[] = ['agree', 'disagree', 'unread'];

/** The local calendar day and wall clock of an instant in `timeZone`. */
function localDayAndClock(at: Date, timeZone: string): { day: string; clock: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return {
    day: `${part('year')}-${part('month')}-${part('day')}`,
    clock: `${part('hour')}:${part('minute')}`,
  };
}

/**
 * Compare the instant a reminder would state with one live reading of the window's page.
 * Pure: the reading is the only evidence, and the stored row is only the claim under test.
 */
export function compareWithReading(
  reading: LiveRegistrationReading,
  stated: Date,
  resident: boolean,
): DateCheck {
  if (reading.status !== 'verified') {
    return {
      outcome: 'unread',
      reason: reading.status,
      detail: 'reason' in reading ? reading.reason : null,
    };
  }
  const date = registrationDate(reading, resident);
  if (date === null) return { outcome: 'unread', reason: 'no_family_date', detail: null };
  const liveAt = registrationAnchor(reading, date);
  if (date.time !== null) {
    return { outcome: liveAt.getTime() === stated.getTime() ? 'agree' : 'disagree', liveAt };
  }
  // The page prints a day and no time.
  const claimed = localDayAndClock(stated, reading.timeZone);
  if (claimed.day !== date.date) return { outcome: 'disagree', liveAt };
  if (claimed.clock === DATE_ONLY_WALL_CLOCK) return { outcome: 'agree', liveAt };
  return { outcome: 'unread', reason: 'time_not_on_page', detail: null };
}

export interface DateCheckInput {
  window: Pick<
    RegistrationWindow,
    'id' | 'municipality' | 'programDomain' | 'cycleLabel' | 'sourceUrl' | 'district'
  >;
  /** True when this family registers on the resident date. */
  resident: boolean;
  /** The opening the reminder would state. */
  stated: Date;
  /** Which sender asked, for the log line: a ladder leg or the nudge. */
  sender: string;
}

export interface DateChecker {
  mode: DateCheckMode;
  check(input: DateCheckInput, now: Date): Promise<DateCheck>;
  /** Every check this run made, by outcome. */
  tally: Record<DateCheckOutcome, number>;
}

/**
 * One checker per run. The reader (and its per-URL cache) is built on the first check,
 * so a run with nothing to state reads nothing. Every check logs one line per window
 * id: outcome names and codes only, never page text or a family id.
 */
export function createDateChecker(
  createReader: () => RegistrationReader | null,
  mode: DateCheckMode = registrationDateCheckMode(),
): DateChecker {
  let reader: RegistrationReader | null | undefined;
  const tally = Object.fromEntries(DATE_CHECK_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    DateCheckOutcome,
    number
  >;
  return {
    mode,
    tally,
    async check(input, now) {
      if (reader === undefined) reader = createReader();
      const result: DateCheck =
        reader === null
          ? { outcome: 'unread', reason: 'no_reader', detail: null }
          : compareWithReading(
              await reader(windowReadTarget(input.window), now),
              input.stated,
              input.resident,
            );
      tally[result.outcome] += 1;
      console.info(
        {
          outcome: 'registration_date_check',
          mode,
          windowId: input.window.id,
          sender: input.sender,
          check: result.outcome,
          reason: result.outcome === 'unread' ? result.reason : null,
          detail: result.outcome === 'unread' ? result.detail : null,
        },
        'registration date check',
      );
      return result;
    },
  };
}

/** The production reader factory: null when no model key is configured, which every
 * check then names as `no_reader`. */
export function liveDateReader(): RegistrationReader | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return createLiveRegistrationReader(
    budgetedAnthropic(CRON_SWEEP_CLIENT_OPTIONS, { stage: 'registration' }),
  );
}
