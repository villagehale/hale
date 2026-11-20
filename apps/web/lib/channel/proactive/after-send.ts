import { type Database, schema } from '@hale/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NextDayCheckbackPayload } from '~/lib/channel/next-day-checkback/sweep';
import { setNotifiedMessage } from '~/lib/channel/spots/store';
import { fulfillCommitment } from '~/lib/commitments/ledger';
import { recordActivityBooking } from '~/lib/integrations/booking';
import { recordEmailAlertOffer } from '~/lib/integrations/email-alert-offer';
import { markWorkstreamFollowedUp } from '~/lib/memory/workstreams';
import type { ExtractionKind } from '~/lib/sentinel';

/**
 * VIL-612 · what a sweep stored so the decider can finish the class after a
 * verbatim send. Unknown keys are ignored.
 */
export interface CandidateAfterSend {
  auditVerb?: string;
  fulfillKind?: 'activity_followup' | 'plan_check_in';
  emailAlert?: {
    occasionKey: string;
    anchorKeys: string[] | null;
    receivedAt: string;
    integrationId: string;
    messageId: string;
    offer: {
      kind: ExtractionKind;
      title: string;
      startsAt: string;
      location: string | null;
    } | null;
    booking: {
      providerHost: string;
      title: string;
      firstSessionAt: string;
      location: string | null;
      address: string | null;
      eventId: string | null;
      sessionKey: string | null;
    } | null;
  };
  spotOpen?: { spotId: string };
  /** VIL-681 · the ask this check-back was about: neither follow-up lane picks it again. */
  nextDayCheckback?: NextDayCheckbackPayload;
}

/** A channel row that claims an email occasion before the decider sends it. Not a text. */
export const EMAIL_ALERT_OCCASION_RESERVED = 'occasion_reserved';

/**
 * True when live cadence already claimed this occasion, so a second message in the
 * thread is not written or queued. The claim is the occasion key, not the message id.
 */
export async function emailAlertOccasionReserved(
  database: Database,
  occasionBase: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.emailAlertOccasions.occasionKey })
    .from(schema.emailAlertOccasions)
    .innerJoin(
      schema.channelMessages,
      eq(schema.channelMessages.id, schema.emailAlertOccasions.channelMessageId),
    )
    .where(
      and(
        eq(schema.channelMessages.errorCode, EMAIL_ALERT_OCCASION_RESERVED),
        sql`(
          ${schema.emailAlertOccasions.occasionKey} = ${occasionBase}
          OR starts_with(${schema.emailAlertOccasions.occasionKey}, ${`${occasionBase}:`})
        )`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Claims the occasion before the decider sends, so a second email in the thread sees
 * it. The row carries no dedupe key: the send later spends the per-message key.
 * False when another message already claimed this occasion.
 */
export async function reserveEmailAlertOccasion(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    occasionKey: string;
    anchorKeys: string[] | null;
    receivedAt: Date;
  },
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [message] = await tx
      .insert(schema.channelMessages)
      .values({
        familyId: input.familyId,
        parentUserId: input.parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'email_alert',
        templateKey: 'connector:email_alert',
        dedupeKey: null,
        status: 'suppressed_pref',
        errorCode: EMAIL_ALERT_OCCASION_RESERVED,
      })
      .returning({ id: schema.channelMessages.id });
    if (!message) return false;
    const [occasion] = await tx
      .insert(schema.emailAlertOccasions)
      .values({
        occasionKey: input.occasionKey,
        channelMessageId: message.id,
        anchorKeys: input.anchorKeys,
        receivedAt: input.receivedAt,
      })
      .onConflictDoNothing()
      .returning({ occasionKey: schema.emailAlertOccasions.occasionKey });
    if (!occasion) {
      await tx.delete(schema.channelMessages).where(eq(schema.channelMessages.id, message.id));
      return false;
    }
    return true;
  });
}

/** Drops a reservation that never became a send, so a later email can still tell them. */
export async function releaseEmailAlertReservation(
  database: Database,
  occasionKey: string,
): Promise<void> {
  const [occasion] = await database
    .select({ channelMessageId: schema.emailAlertOccasions.channelMessageId })
    .from(schema.emailAlertOccasions)
    .where(eq(schema.emailAlertOccasions.occasionKey, occasionKey))
    .limit(1);
  if (!occasion) return;
  const [message] = await database
    .select({ errorCode: schema.channelMessages.errorCode })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.id, occasion.channelMessageId))
    .limit(1);
  if (message?.errorCode !== EMAIL_ALERT_OCCASION_RESERVED) return;
  await database
    .delete(schema.emailAlertOccasions)
    .where(eq(schema.emailAlertOccasions.occasionKey, occasionKey));
  await database
    .delete(schema.channelMessages)
    .where(eq(schema.channelMessages.id, occasion.channelMessageId));
}

/** Releases reservations for dropped candidates. A real send's claim stays. */
export async function releaseEmailAlertReservationsFor(
  database: Database,
  familyId: string,
  candidateIds: readonly string[],
): Promise<void> {
  if (candidateIds.length === 0) return;
  const rows = await database
    .select({ payload: schema.proactiveCandidates.payload })
    .from(schema.proactiveCandidates)
    .where(
      and(
        eq(schema.proactiveCandidates.familyId, familyId),
        inArray(schema.proactiveCandidates.id, [...candidateIds]),
      ),
    );
  for (const row of rows) {
    const key = payloadOf(row.payload)?.emailAlert?.occasionKey;
    if (typeof key === 'string') await releaseEmailAlertReservation(database, key);
  }
}

/**
 * Points the occasion at the text that left. A reservation row is removed so it is
 * not a second outbound. A claim that already names this text is left as it is.
 */
export async function adoptEmailAlertOccasion(
  database: Database,
  input: {
    occasionKey: string;
    channelMessageId: string;
    anchorKeys: string[] | null;
    receivedAt: Date;
  },
): Promise<void> {
  const [existing] = await database
    .select({ channelMessageId: schema.emailAlertOccasions.channelMessageId })
    .from(schema.emailAlertOccasions)
    .where(eq(schema.emailAlertOccasions.occasionKey, input.occasionKey))
    .limit(1);
  if (!existing) {
    await database
      .insert(schema.emailAlertOccasions)
      .values({
        occasionKey: input.occasionKey,
        channelMessageId: input.channelMessageId,
        anchorKeys: input.anchorKeys,
        receivedAt: input.receivedAt,
      })
      .onConflictDoNothing();
    return;
  }
  if (existing.channelMessageId === input.channelMessageId) return;
  const [prior] = await database
    .select({ errorCode: schema.channelMessages.errorCode })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.id, existing.channelMessageId))
    .limit(1);
  await database
    .update(schema.emailAlertOccasions)
    .set({
      channelMessageId: input.channelMessageId,
      anchorKeys: input.anchorKeys,
      receivedAt: input.receivedAt,
    })
    .where(eq(schema.emailAlertOccasions.occasionKey, input.occasionKey));
  if (prior?.errorCode === EMAIL_ALERT_OCCASION_RESERVED) {
    await database
      .delete(schema.channelMessages)
      .where(eq(schema.channelMessages.id, existing.channelMessageId));
  }
}

export function payloadOf(value: unknown): CandidateAfterSend | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as CandidateAfterSend;
}

export async function applyCandidateAfterSend(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    channelMessageId: string;
    payload: CandidateAfterSend | null;
    now: Date;
  },
): Promise<void> {
  const payload = input.payload;
  if (payload === null) return;

  if (payload.emailAlert) {
    await finishQueuedEmailAlert(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channelMessageId: input.channelMessageId,
      queued: payload.emailAlert,
      now: input.now,
    });
  }

  if (payload.spotOpen) {
    await setNotifiedMessage(database, {
      spotId: payload.spotOpen.spotId,
      channelMessageId: input.channelMessageId,
      now: input.now,
    });
  }

  if (payload.nextDayCheckback) {
    await markWorkstreamFollowedUp(database, payload.nextDayCheckback.workstreamId, input.now);
  }

  if (payload.fulfillKind) {
    await fulfillCommitment(database, {
      familyId: input.familyId,
      kind: payload.fulfillKind,
      channelMessageId: input.channelMessageId,
      now: input.now,
    });
  }
}

async function finishQueuedEmailAlert(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    channelMessageId: string;
    queued: NonNullable<CandidateAfterSend['emailAlert']>;
    now: Date;
  },
): Promise<void> {
  const { queued } = input;
  await adoptEmailAlertOccasion(database, {
    occasionKey: queued.occasionKey,
    channelMessageId: input.channelMessageId,
    anchorKeys: queued.anchorKeys,
    receivedAt: new Date(queued.receivedAt),
  });

  if (queued.offer) {
    await recordEmailAlertOffer(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      integrationId: queued.integrationId,
      messageId: queued.messageId,
      channelMessageId: input.channelMessageId,
      draft: {
        kind: queued.offer.kind,
        title: queued.offer.title,
        startsAt: new Date(queued.offer.startsAt),
        location: queued.offer.location,
      },
      now: input.now,
    });
  }

  if (queued.booking) {
    const recorded = await recordActivityBooking(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      integrationId: queued.integrationId,
      messageId: queued.messageId,
      channelMessageId: input.channelMessageId,
      draft: {
        providerHost: queued.booking.providerHost,
        title: queued.booking.title,
        firstSessionAt: new Date(queued.booking.firstSessionAt),
        location: queued.booking.location,
        address: queued.booking.address,
        eventId: queued.booking.eventId,
        sessionKey: queued.booking.sessionKey,
      },
      receivedAt: new Date(queued.receivedAt),
    });
    if (recorded.outcome === 'recorded' && recorded.bookingId !== null) {
      await database.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: 'system',
        actionTaken: 'activity_booking_recorded',
        targetTable: 'activity_bookings',
        targetId: recorded.bookingId,
        after: { offered: queued.offer !== null },
      });
    }
  }
}
