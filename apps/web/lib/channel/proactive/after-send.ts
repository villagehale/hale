import { type Database, schema } from '@hale/db';
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
  await database
    .insert(schema.emailAlertOccasions)
    .values({
      occasionKey: queued.occasionKey,
      channelMessageId: input.channelMessageId,
      anchorKeys: queued.anchorKeys,
      receivedAt: new Date(queued.receivedAt),
    })
    .onConflictDoNothing();

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
