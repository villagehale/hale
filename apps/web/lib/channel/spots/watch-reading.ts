import type { ClassAvailabilityReading } from '~/lib/registration/class-availability';
import type { SpotReading, SpotState, SpotTransitionKind } from './availability';
import { type SpotOpenFacts, spotOpenFacts } from './copy';

/**
 * VIL-337 · one tick's reading of a watched page, whichever reader produced it.
 *
 * The sweep asks the same three questions of a PerfectMind course page and of any other
 * program page: is it a state, does the waitlist have room, and what facts back a text.
 * The facts are bound to THIS tick's reading, so a text is only ever composed from the
 * bytes that were just read.
 */

export type SpotOpenFactsResult = ReturnType<typeof spotOpenFacts>;

export type WatchReading =
  | { state: 'unreadable'; reason: string }
  | { state: 'not_registrable'; reason: string }
  | {
      state: SpotState;
      waitlistRoom: boolean;
      facts(kind: SpotTransitionKind, label: string, language: string): SpotOpenFactsResult;
    };

export type StateReading = Extract<WatchReading, { waitlistRoom: boolean }>;

export function fromSpotReading(reading: SpotReading, portalLabel: string): WatchReading {
  if (reading.state === 'unreadable' || reading.state === 'not_registrable') return reading;
  return {
    state: reading.state,
    waitlistRoom: reading.model.IsWaitListAvailable && reading.model.WaitListSpotsLeft > 0,
    facts: (kind, label, language) =>
      spotOpenFacts({
        kind,
        portalLabel,
        label,
        model: reading.model,
        evidence: reading.evidence,
        language,
      }),
  };
}

/** Facts off a page the model read, every one already checked against the page text. */
export function fromPageReading(
  reading: Extract<ClassAvailabilityReading, { status: 'read' }>,
): StateReading {
  return {
    state: reading.state,
    waitlistRoom: reading.waitlistRoom,
    facts: (kind, label, language): SpotOpenFactsResult => {
      if (kind === 'seat_opened' && reading.state !== 'open') {
        return { ok: false, reasons: ['no_seat'] };
      }
      if (kind === 'waitlist_reopened' && !reading.waitlistRoom) {
        return { ok: false, reasons: ['unbacked_waitlist'] };
      }
      const facts: SpotOpenFacts = {
        kind,
        source: reading.provider,
        label,
        spotsLeft: kind === 'seat_opened' ? reading.spotsLeft : null,
        schedule: reading.schedule,
        language,
      };
      return { ok: true, facts };
    },
  };
}

/**
 * The change, if this reading is one worth a text.
 *
 * TWO TRANSITIONS, and the second is the one a parent on a queued class can actually
 * act on: Markham's own registration page says a freed seat in a full class is emailed
 * to the next waitlisted person, who has 48 hours to accept before it passes down the
 * list — so for a class with a queue, `seat_opened` may fire late or never. Everything
 * else (full to waitlist_full, open to full) is recorded and says nothing.
 */
export function watchTransition(prev: SpotState, reading: WatchReading): SpotTransitionKind | null {
  if (!('waitlistRoom' in reading)) return null;
  if (reading.state === 'open') {
    return prev === 'full' || prev === 'waitlist_full' ? 'seat_opened' : null;
  }
  if (reading.state === 'full' && prev === 'waitlist_full') {
    return reading.waitlistRoom ? 'waitlist_reopened' : null;
  }
  return null;
}

/** Does THIS tick's reading still support the observation being held? */
export function supportsKind(kind: SpotTransitionKind, reading: StateReading): boolean {
  if (kind === 'seat_opened') return reading.state === 'open';
  return reading.state === 'full' && reading.waitlistRoom;
}
