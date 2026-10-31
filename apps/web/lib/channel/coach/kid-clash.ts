import { type AhaCalendarFact, calendarOverlaps } from '~/lib/channel/connect/aha-read';
import type { CalendarBlockView, ScheduleEvent } from './tools';

/**
 * VIL-79 · does a proposed kid item land on top of something a kid already has?
 *
 * Read at decision time from what the coach already reads for lookup_week — Hale's
 * household family_events and the connected Google Calendar blocks — and NOTHING is
 * stored. The result is facts, never a sentence: the coach words any mention itself.
 *
 * Kid-only. A household family_event is Hale's own kids-year calendar. A Google block
 * counts only when its stored kid-relevance verdict (judgeKidRelevance, run at sync)
 * said kid; every other block is an adult's busy hour and never surfaces here, not even
 * as "busy". No model is asked at this point and no title is matched on words.
 *
 * No invented end times. Two spans overlap through `calendarOverlaps` (half-open, so
 * back-to-back is not a clash). An item with no end is an instant: it clashes only when
 * it falls strictly inside the other item's real span. Two instants never clash.
 */
export interface KidClashFact {
  /** The other item's child, when it has one — an id the coach already holds. */
  childId: string | null;
  /** The other item's title as lookup_week would show it (already redacted). */
  what: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
}

export interface KidClashCandidate {
  startsAt: Date;
  endsAt: Date | null;
  /** An existing event being moved — never clashes with itself. */
  eventId?: string | null;
}

interface Other {
  fact: KidClashFact;
  startMs: number;
  endMs: number | null;
}

const MAX_FACTS = 4;

export function kidClashFacts(
  candidate: KidClashCandidate,
  events: readonly ScheduleEvent[],
  blocks: readonly CalendarBlockView[],
): KidClashFact[] {
  const others: Other[] = [];
  for (const event of events) {
    if (candidate.eventId && event.eventId === candidate.eventId) continue;
    others.push({
      fact: {
        childId: event.childId,
        what: event.title,
        startsAt: event.startsAt.toISOString(),
        endsAt: event.endsAt?.toISOString() ?? null,
        allDay: false,
      },
      startMs: event.startsAt.getTime(),
      endMs: event.endsAt?.getTime() ?? null,
    });
  }
  for (const block of blocks) {
    // A null title is a non-kid (adult) block: it never surfaces.
    if (block.title === null) continue;
    others.push({
      fact: {
        childId: null,
        what: block.title,
        startsAt: block.startsAt.toISOString(),
        endsAt: block.endsAt?.toISOString() ?? null,
        allDay: block.allDay,
      },
      startMs: block.startsAt.getTime(),
      endMs: block.endsAt?.getTime() ?? null,
    });
  }

  const candStart = candidate.startsAt.getTime();
  const candEnd = candidate.endsAt?.getTime() ?? null;
  const clashes: KidClashFact[] = [];
  const seen = new Set<string>();
  const push = (fact: KidClashFact) => {
    const key = `${fact.what}|${fact.startsAt}|${fact.endsAt ?? ''}`;
    if (seen.has(key) || clashes.length >= MAX_FACTS) return;
    seen.add(key);
    clashes.push(fact);
  };

  others.forEach((other, index) => {
    if (candEnd !== null && other.endMs !== null) {
      // Both have real spans — the shared overlap rule. Titles are index tokens so the
      // answer maps back to the row without comparing words.
      const pair: AhaCalendarFact[] = [
        spanFact('candidate', candidate.startsAt, candidate.endsAt, false),
        spanFact(`other:${index}`, new Date(other.startMs), new Date(other.endMs), false),
      ];
      if (calendarOverlaps(pair).length > 0) push(other.fact);
      return;
    }
    if (candEnd === null && other.endMs !== null) {
      if (other.startMs < candStart && candStart < other.endMs) push(other.fact);
      return;
    }
    if (candEnd !== null && other.endMs === null) {
      if (candStart < other.startMs && other.startMs < candEnd) push(other.fact);
    }
    // Two instants: no span on either side, so no clash is claimed.
  });
  return clashes;
}

function spanFact(title: string, start: Date, end: Date | null, allDay: boolean): AhaCalendarFact {
  return {
    title,
    start: start.toISOString(),
    end: end?.toISOString() ?? null,
    allDay,
    location: null,
    declined: false,
  };
}

/**
 * A STRUCTURED session time from a source (VIL-79). Only a source that publishes a real
 * instant fills this; a free-text `when` ("Saturdays 9:15am") is never parsed into one,
 * so a find without it carries no clash facts at all — never a guessed one.
 */
export interface StructuredSession {
  startsAt: string;
  endsAt: string | null;
}

/** Minimal read surface — the channel schedule reader satisfies it. */
export interface KidClashReader {
  eventsInWeek(familyId: string, start: Date, end: Date): Promise<ScheduleEvent[]>;
  connectedWeek(
    familyId: string,
    start: Date,
    end: Date,
    dayKeys: readonly string[],
  ): Promise<{ blocks: CalendarBlockView[] }>;
}

/**
 * Clash facts for a structured session, read live over the session's own span (an
 * instant reads just that instant). Null when the session is absent or malformed, so the
 * caller omits the field rather than claiming "no clash".
 */
export async function sessionKidClashFacts(
  reader: KidClashReader,
  familyId: string,
  session: StructuredSession | null | undefined,
): Promise<KidClashFact[] | null> {
  if (!session) return null;
  const startsAt = new Date(session.startsAt);
  const endsAt = session.endsAt ? new Date(session.endsAt) : null;
  if (Number.isNaN(startsAt.getTime())) return null;
  if (endsAt && (Number.isNaN(endsAt.getTime()) || endsAt <= startsAt)) return null;
  const DAY = 24 * 60 * 60 * 1000;
  // Read a day either side: an all-day or long block that starts earlier still overlaps.
  const from = new Date(startsAt.getTime() - DAY);
  const to = new Date((endsAt ?? startsAt).getTime() + DAY);
  const dayKeys = [from, startsAt, to].map((d) => d.toISOString().slice(0, 10));
  const [events, connected] = await Promise.all([
    reader.eventsInWeek(familyId, from, to),
    reader.connectedWeek(familyId, from, to, dayKeys),
  ]);
  return kidClashFacts({ startsAt, endsAt }, events, connected.blocks);
}
