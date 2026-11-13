import { type Database, householdFamilyEvent, householdRemovedFamilyEvent, schema } from '@hale/db';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { townLabel } from '~/lib/channel/intake/radar-voice';
import type { ReplyLanguage } from '~/lib/channel/language';
import { familySpeechLanguage } from '~/lib/channel/linq/family-outbound';
import { loadOpenCommitments } from '~/lib/commitments/ledger';
import { CLAIM_ROW_SLOTS, type ClaimCandidateRow } from './candidates';
import { type SendAudience, claimRowLabel } from './claim-label';
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
 * calendar item" (isPrivateEvent); a 13+ child's commitment is "A private item". No location, no row id and no URL is carried; a
 * watched page contributes its host only.
 *
 * THE ZONE IS THE RECIPIENT'S OWN `users.timezone`, read through this family's
 * membership. A recipient who is not a member (or, with no recipient named, no primary
 * parent) is `no_time_zone`, never a default zone.
 *
 * WHAT A "DONE" CLAIM MAY CITE. A registration is backed only by a confirmed signup, a
 * booking a confirmation email recorded, or the parent saying the child got in — never
 * a calendar row. A send is backed only by a text or email an ACTION sent to SOMEONE
 * ELSE: Hale's chat (to this recipient, to the co-parent, or in a group) is the
 * conversation, not a receipt. A cancellation is backed only by something actually
 * removed or called off lately — a sign-up only once its take-back is over and no
 * payment was under way.
 */

/** How far back a send still backs "I sent it". */
const SEND_RECEIPT_WINDOW_MS = 7 * 86_400_000;
/** How far back a removal still backs "I took it off" / "it's cancelled". */
const CANCELLATION_WINDOW_MS = 14 * 86_400_000;
/** Hale's executor sends that leave as email to someone else. */
const EMAIL_SEND_ACTIONS = ['send_email', 'reply_to_email'];

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
  const to = await recipient(database, familyId, input.parentUserId);
  if (to === null) return { status: 'skipped', reason: 'no_time_zone' };
  const timeZone = to.timeZone;
  const [
    language,
    view,
    events,
    commitments,
    spots,
    sequences,
    birthDates,
    registrations,
    receipts,
    cancellations,
  ] = await Promise.all([
    familySpeechLanguage(database, familyId),
    input.view ?? loadReconcileView(database, { familyId, now }),
    calendarRows(database, familyId, now),
    loadOpenCommitments(database, familyId, now),
    watchedPageRows(database, familyId),
    liveSequenceRows(database, familyId),
    childBirthDates(database, familyId),
    registrationRows(database, familyId, now),
    sendReceiptRows(database, familyId, to.userId, now),
    cancellationRows(database, familyId, now),
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
              what: claimRowLabel(
                {
                  from: 'commitment',
                  summary: c.summary,
                  childId: c.subjectChildId,
                  childDateOfBirth:
                    c.subjectChildId === null ? null : (birthDates.get(c.subjectChildId) ?? null),
                },
                now,
              ),
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
    ...registrations,
    ...receipts,
    ...cancellations,
  ];
  return { status: 'ready', rows, language, timeZone };
}

async function recipient(
  database: Database,
  familyId: string,
  parentUserId: string | null,
): Promise<{ userId: string; timeZone: string } | null> {
  if (parentUserId !== null) {
    // Joined on this family, so an id from another household cannot lend its zone.
    const [member] = await database
      .select({ timezone: schema.users.timezone })
      .from(schema.familyMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.familyMembers.userId))
      .where(
        and(
          eq(schema.familyMembers.familyId, familyId),
          eq(schema.familyMembers.userId, parentUserId),
        ),
      )
      .limit(1);
    return member ? { userId: parentUserId, timeZone: member.timezone } : null;
  }
  const [primary] = await database
    .select({ userId: schema.users.id, timezone: schema.users.timezone })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.familyMembers.userId))
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);
  return primary ? { userId: primary.userId, timeZone: primary.timezone } : null;
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

/** This family's children by id, for the age gate on a commitment's subject child. */
async function childBirthDates(database: Database, familyId: string) {
  const rows = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return new Map(rows.map((row) => [row.id, row.dateOfBirth]));
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

/**
 * What backs "registered": a signup Hale's run finished with a confirmation (status
 * `completed` is written only then, signup/run.ts `confirmedOutcome`), a booking a
 * provider's confirmation email recorded and nobody called off, and a window the parent
 * said the child got into. Newest first; the r slot's cap names any overflow.
 */
async function registrationRows(
  database: Database,
  familyId: string,
  now: Date,
): Promise<ClaimCandidateRow[]> {
  const [signups, bookings, reported] = await Promise.all([
    database
      .select({
        activityLabel: schema.authorizedSignupOffers.activityLabel,
        host: schema.authorizedSignupOffers.providerHost,
        childId: schema.authorizedSignupOffers.childId,
        childDateOfBirth: schema.children.dateOfBirth,
      })
      .from(schema.authorizedSignupOffers)
      .leftJoin(schema.children, eq(schema.children.id, schema.authorizedSignupOffers.childId))
      .where(
        and(
          eq(schema.authorizedSignupOffers.familyId, familyId),
          eq(schema.authorizedSignupOffers.status, 'completed'),
        ),
      )
      .orderBy(desc(schema.authorizedSignupOffers.updatedAt))
      .limit(CLAIM_ROW_SLOTS.r),
    database
      .select({
        title: schema.activityBookings.title,
        firstSessionAt: schema.activityBookings.firstSessionAt,
      })
      .from(schema.activityBookings)
      .where(
        and(
          eq(schema.activityBookings.familyId, familyId),
          isNull(schema.activityBookings.cancelledAt),
        ),
      )
      .orderBy(desc(schema.activityBookings.firstSessionAt))
      .limit(CLAIM_ROW_SLOTS.r),
    database
      .select({
        municipality: schema.registrationWindows.municipality,
        programDomain: schema.registrationWindows.programDomain,
        cycleLabel: schema.registrationWindows.cycleLabel,
      })
      .from(schema.registrationSequences)
      .leftJoin(
        schema.registrationWindows,
        eq(schema.registrationWindows.id, schema.registrationSequences.windowId),
      )
      .where(
        and(
          eq(schema.registrationSequences.familyId, familyId),
          eq(schema.registrationSequences.outcome, 'registered'),
        ),
      )
      .orderBy(desc(schema.registrationSequences.outcomeAt))
      .limit(CLAIM_ROW_SLOTS.r),
  ]);
  return [
    ...signups.map(
      (row): ClaimCandidateRow => ({
        familyId,
        source: 'signup_confirmed',
        kind: 'registration_done',
        what: claimRowLabel({ from: 'signup', ...row }, now),
      }),
    ),
    ...bookings.map(
      (row): ClaimCandidateRow => ({
        familyId,
        source: 'booking',
        kind: 'registration_done',
        what: claimRowLabel({ from: 'booking', title: row.title }, now),
        startsAt: row.firstSessionAt,
      }),
    ),
    ...reported.map(
      (row): ClaimCandidateRow => ({
        familyId,
        source: 'reported_outcome',
        kind: 'registration_done',
        what: claimRowLabel(
          {
            from: 'program',
            town: row.municipality === null ? null : townLabel(row.municipality),
            domain: row.programDomain,
            cycle: row.cycleLabel,
          },
          now,
        ),
      }),
    ),
  ];
}

function audienceOf(inGroupChat: boolean, role: string | null): SendAudience | null {
  if (inGroupChat) return 'group_chat';
  if (role === null) return null;
  if (role === 'co_parent') return 'co_parent';
  if (role === 'primary_parent') return 'other_parent';
  return 'caregiver';
}

/**
 * What backs "I sent it": a text an action sent in a group chat or to another adult of
 * this family, or an email Hale's executor sent for it, within the window. A text whose
 * provider said it arrived (Linq `message.delivered`, delivery-status.ts) is
 * `delivered`; the rest are only `sent`, and only `delivered` backs "they got it".
 * Nothing about the content travels.
 *
 * Read through the family's members, so the scan rides `channel_messages_cap_idx`
 * (parent_user_id first) rather than the whole ledger.
 */
async function sendReceiptRows(
  database: Database,
  familyId: string,
  recipientUserId: string,
  now: Date,
): Promise<ClaimCandidateRow[]> {
  const since = new Date(now.getTime() - SEND_RECEIPT_WINDOW_MS);
  const inGroupChat = sql<boolean>`${schema.channelMessages.providerChatId} is not null and exists (select 1 from ${schema.linqGroupMembers} where ${schema.linqGroupMembers.chatId} = ${schema.channelMessages.providerChatId})`;
  const members = database
    .select({ userId: schema.familyMembers.userId })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  const [texts, emails] = await Promise.all([
    database
      .select({
        sentAt: schema.channelMessages.sentAt,
        createdAt: schema.channelMessages.createdAt,
        status: schema.channelMessages.status,
        inGroupChat,
        role: schema.familyMembers.role,
      })
      .from(schema.channelMessages)
      // Only a text an action of this family sent: Hale's chat is never a receipt.
      .innerJoin(
        schema.actions,
        and(
          eq(schema.actions.id, schema.channelMessages.relatedActionId),
          eq(schema.actions.familyId, familyId),
        ),
      )
      .leftJoin(
        schema.familyMembers,
        and(
          eq(schema.familyMembers.familyId, schema.channelMessages.familyId),
          eq(schema.familyMembers.userId, schema.channelMessages.parentUserId),
        ),
      )
      .where(
        and(
          inArray(schema.channelMessages.parentUserId, members),
          eq(schema.channelMessages.familyId, familyId),
          eq(schema.channelMessages.direction, 'out'),
          inArray(schema.channelMessages.status, ['sent', 'delivered']),
          // A column, never a fragment: a Date compared to a fragment has no mapper.
          gte(schema.channelMessages.createdAt, since),
          or(inGroupChat, ne(schema.channelMessages.parentUserId, recipientUserId)),
        ),
      )
      .orderBy(desc(schema.channelMessages.createdAt))
      .limit(CLAIM_ROW_SLOTS.m),
    database
      .select({ sentAt: schema.outboundSends.sentAt })
      .from(schema.outboundSends)
      .innerJoin(schema.actions, eq(schema.actions.id, schema.outboundSends.actionId))
      .where(
        and(
          eq(schema.actions.familyId, familyId),
          inArray(schema.actions.actionType, EMAIL_SEND_ACTIONS),
          isNotNull(schema.outboundSends.sentAt),
          gte(schema.outboundSends.sentAt, since),
        ),
      )
      .orderBy(desc(schema.outboundSends.sentAt))
      .limit(CLAIM_ROW_SLOTS.m),
  ]);
  const rows: { at: Date; row: ClaimCandidateRow }[] = [];
  for (const text of texts) {
    const audience = audienceOf(text.inGroupChat, text.role);
    // A text to someone no longer in the family names no audience it could back.
    if (audience === null) continue;
    // sent_at is null on a row written before the provider answered.
    const at = text.sentAt ?? text.createdAt;
    rows.push({
      at,
      row: {
        familyId,
        source: 'send_receipt',
        kind: 'send_done',
        what: claimRowLabel({ from: 'send_receipt', channel: 'text', audience }, now),
        sentAt: at,
        delivered: text.status === 'delivered',
      },
    });
  }
  for (const email of emails) {
    if (email.sentAt === null) continue;
    rows.push({
      at: email.sentAt,
      row: {
        familyId,
        source: 'send_receipt',
        kind: 'send_done',
        what: claimRowLabel(
          { from: 'send_receipt', channel: 'email', audience: 'for_family' },
          now,
        ),
        sentAt: email.sentAt,
        delivered: false,
      },
    });
  }
  return rows.sort((a, b) => b.at.getTime() - a.at.getTime()).map(({ row }) => row);
}

/**
 * What backs "I cancelled it" / "it's off your calendar": within the window, a household
 * calendar row removed (its title through the same teen/sensitive redaction), a booking
 * the provider called off, a page Hale stopped watching, a signup plan the parent took
 * back that has ended without a payment starting and with nothing charged on record.
 */
async function cancellationRows(
  database: Database,
  familyId: string,
  now: Date,
): Promise<ClaimCandidateRow[]> {
  const since = new Date(now.getTime() - CANCELLATION_WINDOW_MS);
  const [events, bookings, spots, plans] = await Promise.all([
    database
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
          householdRemovedFamilyEvent(),
          gte(schema.familyEvents.deletedAt, since),
        ),
      )
      .orderBy(desc(schema.familyEvents.deletedAt))
      .limit(CLAIM_ROW_SLOTS.x),
    database
      .select({
        title: schema.activityBookings.title,
        firstSessionAt: schema.activityBookings.firstSessionAt,
      })
      .from(schema.activityBookings)
      .where(
        and(
          eq(schema.activityBookings.familyId, familyId),
          gte(schema.activityBookings.cancelledAt, since),
        ),
      )
      .orderBy(desc(schema.activityBookings.cancelledAt))
      .limit(CLAIM_ROW_SLOTS.x),
    database
      .select({ label: schema.watchedSpots.label })
      .from(schema.watchedSpots)
      .where(
        and(eq(schema.watchedSpots.familyId, familyId), gte(schema.watchedSpots.releasedAt, since)),
      )
      .orderBy(desc(schema.watchedSpots.releasedAt))
      .limit(CLAIM_ROW_SLOTS.x),
    database
      .select({
        activityLabel: schema.authorizedSignupOffers.activityLabel,
        host: schema.authorizedSignupOffers.providerHost,
        childId: schema.authorizedSignupOffers.childId,
        childDateOfBirth: schema.children.dateOfBirth,
      })
      .from(schema.authorizedSignupOffers)
      .leftJoin(schema.children, eq(schema.children.id, schema.authorizedSignupOffers.childId))
      .where(
        and(
          eq(schema.authorizedSignupOffers.familyId, familyId),
          // Over, not requested: a take-back of a run that is still going, or one whose
          // payment had started, can still end in a charge (cancelSignupPlan 'paying').
          eq(schema.authorizedSignupOffers.status, 'handed_back'),
          gte(schema.authorizedSignupOffers.planCancelRequestedAt, since),
          sql`coalesce(${schema.authorizedSignupOffers.planResume}->>'phase', '') <> 'paying'`,
          // The phase is not evidence: the checkout review runs before the take-back is
          // read and can place the order. Only a recorded "nothing charged" backs it — a
          // take-back before any run, or a run whose end says so.
          sql`exists (select 1 from ${schema.auditLog} where ${schema.auditLog.familyId} = ${schema.authorizedSignupOffers.familyId} and ${schema.auditLog.targetId} = ${schema.authorizedSignupOffers.id}::text and ${schema.auditLog.actionTaken} = 'authorized_signup_step' and (${schema.auditLog.after}->>'step' = 'plan_cancelled' or (${schema.auditLog.after}->>'step' = 'plan_finished' and ${schema.auditLog.after}->>'charged' = 'nothing')))`,
        ),
      )
      .orderBy(desc(schema.authorizedSignupOffers.planCancelRequestedAt))
      .limit(CLAIM_ROW_SLOTS.x),
  ]);
  const cancelled = (
    what: ClaimCandidateRow['what'],
    startsAt: Date | null,
  ): ClaimCandidateRow => ({
    familyId,
    source: 'cancelled',
    kind: 'cancelled',
    what,
    startsAt,
  });
  return [
    ...events.map(({ startsAt, ...row }) =>
      cancelled(claimRowLabel({ from: 'calendar', ...row }, now), startsAt),
    ),
    ...bookings.map((row) =>
      cancelled(claimRowLabel({ from: 'booking', title: row.title }, now), row.firstSessionAt),
    ),
    ...spots.map((row) =>
      cancelled(claimRowLabel({ from: 'watched_page', label: row.label }, now), null),
    ),
    ...plans.map((row) => cancelled(claimRowLabel({ from: 'signup', ...row }, now), null)),
  ];
}
