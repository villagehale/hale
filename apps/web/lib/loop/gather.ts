import type { Database } from '@hale/db';
import { companionForFamily } from '~/lib/companion/queries';
import { dayKeyIn, groupRoutineByDay, type WeekWindow } from '~/lib/plan/spine';
import { readVillage } from '~/lib/village/queries';
import type {
  ComposeFamilyEvent,
  ComposeHealth,
  ComposeInputs,
  ComposeRoutinePattern,
  ComposeVillage,
} from './compose';
import { listFamilyEventsInWindow } from './queries';

/**
 * The I/O layer for the weekly-plan composer (VIL-217): loads a family's live signals
 * for one upcoming week from the EXISTING cron-safe loaders (db + familyId, no
 * session) and shapes them into the pure composer's `ComposeInputs`. It invents
 * nothing — every source already exists and is already teen-gated at its own layer;
 * the deterministic teen gate in compose is the single authority over the artifact.
 *
 * Thin glue by design: the ranking / caps / redaction rules live (and are unit-tested)
 * in compose; the cron logic (window, idempotent pre-check, degradation) is unit-tested
 * with this gather injected as a fake. This function is verified by tsc + the live probe.
 */
export async function gatherWeekPlanInputs(
  db: Database,
  familyId: string,
  window: WeekWindow,
  timeZone: string,
  now: Date = new Date(),
): Promise<ComposeInputs> {
  const [companion, village, familyEventRows] = await Promise.all([
    companionForFamily(familyId, db, now),
    readVillage(db, familyId),
    listFamilyEventsInWindow(db, familyId, ...instantWindow(window)),
  ]);

  const children = companion.map((c) => ({ id: c.id, name: c.name, dateOfBirth: c.dateOfBirth }));

  // The soonest upcoming health item per child (compose filters it to the appointment
  // horizon + applies the teen gate). Mirrors plan/week.ts (one health line per child).
  const health: ComposeHealth[] = companion
    .map((c) => {
      const h = c.nextHealth[0];
      return h ? { childId: c.id, what: h.what, kind: h.kind, dueInWeeks: h.dueInWeeks } : null;
    })
    .filter((h): h is ComposeHealth => h !== null);

  // Saved / accepted village activities DATED in-window (teen-attributed candidates
  // already carry eventDate=null at the mapper, so they can't reach a dated rail).
  const villageDated: ComposeVillage[] = village.candidates
    .filter((c) => c.eventDate !== null && (c.saved || c.accepted) && !c.teenAttributed)
    .map((c) => ({ id: c.id, title: c.title, eventDate: c.eventDate, location: c.venueName }));

  // The ONE suggestion: the top-ranked candidate the family hasn't saved/accepted and
  // that isn't teen-attributed. readVillage orders by confidence then recency — the
  // deterministic base the rank-recommendations agent refines (loadVillageFeed applies
  // that permutation but is session-scoped, so unavailable to a cron).
  const top = village.candidates.find((c) => !c.saved && !c.accepted && !c.teenAttributed) ?? null;
  const suggestion: ComposeVillage | null = top
    ? { id: top.id, title: top.title, eventDate: top.eventDate, location: top.venueName }
    : null;

  // Routines condensed to at most one pattern per active weekday-strip — never the raw
  // line-items (ticket). A redacted teen item keeps its non-PII kind/day, so the strip
  // label stays safe.
  const routines: ComposeRoutinePattern[] = village.routine
    ? groupRoutineByDay(village.routine.items).map((strip) => ({
        label: routinePatternLabel(strip.weekday, strip.items),
        day: strip.weekday,
      }))
    : [];

  const familyEvents: ComposeFamilyEvent[] = familyEventRows.map((e) => ({
    id: e.id,
    childId: e.childId,
    title: e.title,
    startKey: dayKeyIn(e.startsAt, timeZone),
    endKey: e.endsAt ? dayKeyIn(e.endsAt, timeZone) : null,
    location: e.location,
  }));

  return { window, children, health, routines, villageDated, suggestion, familyEvents };
}

/** A condensed, non-PII label for a routine day-strip: the weekday + the distinct
 * kinds it carries ("weekday mornings" style), never the individual items. */
function routinePatternLabel(
  weekday: string | null,
  items: ReadonlyArray<{ kind: string }>,
): string {
  const kinds = [...new Set(items.map((i) => i.kind))].join(', ');
  const when = weekday ?? 'anytime';
  return kinds ? `${when}: ${kinds}` : when;
}

/** A UTC instant window generous enough to include every event whose FAMILY-LOCAL day
 * falls in [startKey, endKey]: pad one day each side so no timezone offset (±14h < 1d)
 * can push an in-window local day outside the coarse instant filter. compose then does
 * the exact family-local day-key filtering. */
function instantWindow(window: WeekWindow): [Date, Date] {
  const start = new Date(`${window.startKey}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(`${window.endKey}T23:59:59Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return [start, end];
}
