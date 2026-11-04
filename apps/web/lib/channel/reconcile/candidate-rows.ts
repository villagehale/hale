import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { and, asc, eq, gte, isNull, or } from 'drizzle-orm';
import { townLabel } from '~/lib/channel/intake/radar-voice';
import type { ReplyLanguage } from '~/lib/channel/language';
import { familySpeechLanguage } from '~/lib/channel/linq/family-outbound';
import { loadOpenCommitments } from '~/lib/commitments/ledger';
import { CLAIM_ROW_SLOTS, type ClaimCandidateRow } from './candidates';
import { claimRowLabel } from './claim-label';
import type { ReconcileView } from './reconcile';
import { loadReconcileView } from './view';

/**
 * VIL-581 · the rows a real family's claim may cite, for the claim reader in SHADOW.
 *
 * Every read reuses a predicate that already exists: the reconcile view's own
 * `family_events` and live-sequence predicates, the MEM-10 ledger reader, the watched
 * spots' live predicate. view.ts is not edited, so the regex gate's input stays
 * byte-identical.
 *
 * EVERY LABEL GOES THROUGH claimRowLabel. A calendar title is read only into its
 * `calendar` source, which redacts a 13+ child's or a sensitive row to "A private
 * calendar item" (isPrivateEvent). No location, no row id and no URL is carried; a
 * watched page contributes its host only.
 *
 * THE ZONE IS THE RECIPIENT'S OWN `users.timezone`. A missing user row (or, with no
 * recipient named, no primary parent) is `no_time_zone`, never a default zone.
 */

export type ClaimShadowContext =
  | { status: 'ready'; rows: ClaimCandidateRow[]; language: ReplyLanguage | null; timeZone: string }
  | { status: 'skipped'; reason: 'no_time_zone' };

export async function loadClaimShadowContext(
  database: Database,
  input: {
    familyId: string;
    now: Date;
    /** The recipient; null means the primary parent (the unlabelled sweep only). */
    parentUserId: string | null;
    /** The coach already loaded it. */
    view?: ReconcileView;
    pending?: { activityFollowup: string | null; spotWatch: string | null };
  },
): Promise<ClaimShadowContext> {
  const { familyId, now } = input;
  const timeZone = await recipientTimeZone(database, familyId, input.parentUserId);
  if (timeZone === null) return { status: 'skipped', reason: 'no_time_zone' };
  const [language, view, events, commitments, spots, sequences] = await Promise.all([
    familySpeechLanguage(database, familyId),
    input.view ?? loadReconcileView(database, { familyId, now }),
    calendarRows(database, familyId, now),
    loadOpenCommitments(database, familyId, now),
    watchedPageRows(database, familyId),
    liveSequenceRows(database, familyId),
  ]);
  const rows: ClaimCandidateRow[] = [
    ...events,
    ...view.statedBookings.map(
      (text): ClaimCandidateRow => ({
        familyId,
        source: 'parent_stated',
        kind: 'scheduled_event',
        what: claimRowLabel({ from: 'stated_booking', text }, now),
      }),
    ),
    ...commitments.flatMap((c): ClaimCandidateRow[] =>
      // The spot_watch commitment is one constant summary per family: its pages are g*.
      c.kind === 'registration_watch' || c.kind === 'activity_followup'
        ? [
            {
              familyId,
              source: 'open_commitment',
              kind: c.kind,
              what: claimRowLabel({ from: 'commitment', summary: c.summary }, now),
            },
          ]
        : [],
    ),
    ...spots.map(
      (spot): ClaimCandidateRow => ({
        familyId,
        source: 'watched_page',
        kind: 'spot_watch',
        what: claimRowLabel({ from: 'watched_page', label: spot.label }, now),
        host: new URL(spot.sourceUrl).hostname,
      }),
    ),
    ...sequences.map(
      (seq): ClaimCandidateRow => ({
        familyId,
        source: 'live_sequence',
        kind: 'registration_watch',
        what: claimRowLabel(
          {
            from: 'program',
            town: seq.municipality === null ? null : townLabel(seq.municipality),
            domain: seq.programDomain,
            cycle: seq.cycleLabel,
          },
          now,
        ),
        opensAt: seq.courseOpensAt,
      }),
    ),
    ...(view.mintableWindow
      ? [
          {
            familyId,
            source: 'mintable_window',
            kind: 'registration_watch',
            what: claimRowLabel(
              { from: 'program', town: view.mintableWindow.town, domain: null, cycle: null },
              now,
            ),
            opensForFamilyAt: view.mintableWindow.opensForFamilyAt,
          } satisfies ClaimCandidateRow,
        ]
      : []),
    ...(input.pending?.activityFollowup
      ? [
          {
            familyId,
            source: 'pending',
            kind: 'activity_followup',
            what: claimRowLabel({ from: 'pending', text: input.pending.activityFollowup }, now),
          } satisfies ClaimCandidateRow,
        ]
      : []),
    ...(input.pending?.spotWatch
      ? [
          {
            familyId,
            source: 'pending',
            kind: 'spot_watch',
            what: claimRowLabel({ from: 'pending', text: input.pending.spotWatch }, now),
          } satisfies ClaimCandidateRow,
        ]
      : []),
  ];
  return { status: 'ready', rows, language, timeZone };
}

async function recipientTimeZone(
  database: Database,
  familyId: string,
  parentUserId: string | null,
): Promise<string | null> {
  if (parentUserId !== null) {
    const [user] = await database
      .select({ timezone: schema.users.timezone })
      .from(schema.users)
      .where(eq(schema.users.id, parentUserId))
      .limit(1);
    return user?.timezone ?? null;
  }
  const [primary] = await database
    .select({ timezone: schema.users.timezone })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.familyMembers.userId))
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);
  return primary?.timezone ?? null;
}

/** view.ts's own predicate: household rows (no mirror, not deleted), future, soonest first. */
async function calendarRows(
  database: Database,
  familyId: string,
  now: Date,
): Promise<ClaimCandidateRow[]> {
  const rows = await database
    .select({
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
      childId: schema.familyEvents.childId,
      sensitive: schema.familyEvents.sensitive,
      childDateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.familyEvents)
    .leftJoin(schema.children, eq(schema.children.id, schema.familyEvents.childId))
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        householdFamilyEvent(),
        gte(schema.familyEvents.startsAt, now),
      ),
    )
    .orderBy(asc(schema.familyEvents.startsAt))
    .limit(CLAIM_ROW_SLOTS.e);
  return rows.map((row) => ({
    familyId,
    source: 'calendar',
    kind: 'scheduled_event',
    what: claimRowLabel(
      {
        from: 'calendar',
        title: row.title,
        childId: row.childId,
        childDateOfBirth: row.childDateOfBirth,
        sensitive: row.sensitive,
      },
      now,
    ),
    startsAt: row.startsAt,
  }));
}

/** The live predicate of spots/store.ts (`watched_spots_live_uniq`). */
async function watchedPageRows(database: Database, familyId: string) {
  return database
    .select({ label: schema.watchedSpots.label, sourceUrl: schema.watchedSpots.sourceUrl })
    .from(schema.watchedSpots)
    .where(and(eq(schema.watchedSpots.familyId, familyId), isNull(schema.watchedSpots.releasedAt)))
    .orderBy(asc(schema.watchedSpots.createdAt))
    .limit(CLAIM_ROW_SLOTS.g);
}

/** view.ts's live-sequence predicate: no outcome yet, or a waitlist clock. */
async function liveSequenceRows(database: Database, familyId: string) {
  return database
    .select({
      municipality: schema.registrationWindows.municipality,
      programDomain: schema.registrationWindows.programDomain,
      cycleLabel: schema.registrationWindows.cycleLabel,
      courseOpensAt: schema.registrationSequences.courseOpensAt,
    })
    .from(schema.registrationSequences)
    .leftJoin(
      schema.registrationWindows,
      eq(schema.registrationWindows.id, schema.registrationSequences.windowId),
    )
    .where(
      and(
        eq(schema.registrationSequences.familyId, familyId),
        or(
          isNull(schema.registrationSequences.outcome),
          eq(schema.registrationSequences.outcome, 'waitlisted'),
        ),
      ),
    )
    .orderBy(asc(schema.registrationSequences.createdAt))
    .limit(CLAIM_ROW_SLOTS.q);
}
