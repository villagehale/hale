import { type Database, schema } from '@hale/db';
import { ageInMonths } from '@hale/types';
import { and, asc, eq, gte, isNull, or } from 'drizzle-orm';
import { f14EnabledFor } from '~/lib/channel/f14';
import { readWindows } from '~/lib/channel/intake/radar';
import { townLabel } from '~/lib/channel/intake/radar-voice';
import { loadOpenCommitments } from '~/lib/commitments/ledger';
import { matchRegistrationWindows } from '~/lib/registration/match-registration-windows';
import type { ReconcileView } from './reconcile';

/**
 * VIL-293 · what a lane can read about a family before it decides to send — ONE BATCH.
 *
 * FOUR QUESTIONS, FOUR PARALLEL READS, and the count is the design. The inline coach
 * lane runs this on every turn that reaches the model, so the primitive is only
 * affordable if it is a fixed handful of indexed selects rather than a walk of the
 * family's history. Everything here is keyed on `family_id` and bounded.
 *
 * IT IS KICKED OFF BESIDE THE MODEL CALL, not after it (route.ts). The reads have no
 * dependency on what the model says — only on which family is talking — so the whole
 * batch resolves inside the seconds the coach is already thinking, and the reconcile
 * itself is regex work. That is what keeps a gate on Hale's honesty off the critical
 * path of a parent waiting for an answer.
 *
 * NO SOURCE OF TRUTH IS ADDED. The window match is `matchRegistrationWindows`, the
 * window rows are the intake radar's `readWindows`, the arming predicate is the ladder's
 * own `f14EnabledFor`, and the promises are the MEM-10 ledger's own reader — the same
 * four the coach's context and the sweep use. What differs is the PROJECTION: the coach
 * needs a phrase a parent can read, this needs an instant a promise can come due at.
 */

/** How many upcoming placements a booking claim is checked against. A family's calendar
 * a month out is a handful of rows; the cap is there so a pathological account cannot
 * turn a send gate into a table scan. */
const SCHEDULED_TITLE_LIMIT = 50;

export async function loadReconcileView(
  database: Database,
  input: { familyId: string; now: Date },
): Promise<ReconcileView> {
  const { familyId, now } = input;
  const [openCommitments, laddered, scheduled, mintableWindow] = await Promise.all([
    loadOpenCommitments(database, familyId, now),
    hasLiveSequence(database, familyId),
    loadScheduledTitles(database, familyId, now),
    loadMintableWindow(database, familyId, now),
  ]);
  return {
    openKinds: new Set(openCommitments.map((commitment) => commitment.kind)),
    // Nothing is pending from a background lane: a sweep composes one message and the
    // rows it will write are the ones it already decided on. The coach's turn is the one
    // caller that overrides this, with what its tools registered (route.ts).
    pendingKinds: new Set(),
    registrationLaddered: laddered,
    mintableWindow,
    scheduledTitles: scheduled,
  };
}

/**
 * Is the registration ladder already running for this household?
 *
 * The SAME predicate `loadLiveSequences` selects on — a sequence with no outcome yet, or
 * one holding a waitlist clock. Those are precisely the states in which the ladder still
 * has legs to send, which is what makes "I'm on that morning" a true sentence.
 */
async function hasLiveSequence(database: Database, familyId: string): Promise<boolean> {
  const rows = await database
    .select({ id: schema.registrationSequences.id })
    .from(schema.registrationSequences)
    .where(
      and(
        eq(schema.registrationSequences.familyId, familyId),
        or(
          isNull(schema.registrationSequences.outcome),
          eq(schema.registrationSequences.outcome, 'waitlisted'),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Live, future placements — titles only, and they never reach a log. A deleted or past
 * row is not something a parent can be told is booked. */
async function loadScheduledTitles(
  database: Database,
  familyId: string,
  now: Date,
): Promise<string[]> {
  const rows = await database
    .select({ title: schema.familyEvents.title })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        isNull(schema.familyEvents.deletedAt),
        gte(schema.familyEvents.startsAt, now),
      ),
    )
    .orderBy(asc(schema.familyEvents.startsAt))
    .limit(SCHEDULED_TITLE_LIMIT);
  return rows.map((row) => row.title);
}

/**
 * The soonest municipal window this family matches, if the ladder is armed for them.
 *
 * BOTH HALVES ARE REQUIRED and neither is negotiable. A matched window with the sweep
 * dark is a date nobody will act on, so minting a watch against it would write a debt
 * that can never be kept — the ledger's overdue query would be right and the parent
 * would still be waiting. An armed sweep with no matched window has nothing to watch.
 */
async function loadMintableWindow(
  database: Database,
  familyId: string,
  now: Date,
): Promise<ReconcileView['mintableWindow']> {
  if (!f14EnabledFor(familyId)) return null;

  const [family] = await database
    .select({ areaCoarse: schema.families.areaCoarse })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  const areaCoarse = family?.areaCoarse ?? null;
  if (areaCoarse === null) return null;

  const [children, windows] = await Promise.all([
    database
      .select({ dateOfBirth: schema.children.dateOfBirth })
      .from(schema.children)
      .where(eq(schema.children.familyId, familyId)),
    readWindows(database, areaCoarse),
  ]);

  const [match] = matchRegistrationWindows({
    windows,
    postal: areaCoarse,
    childrenAgesMonths: children.map((child) => ageInMonths(child.dateOfBirth, now)),
    now,
  });
  if (!match) return null;
  return {
    town: townLabel(match.window.municipality),
    opensForFamilyAt: match.opensForFamilyAt,
  };
}
