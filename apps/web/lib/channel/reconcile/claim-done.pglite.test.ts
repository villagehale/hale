import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { scriptedClaimReader } from '~/lib/testing/claim-reader';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { cancelSignupPlan } from '~/lib/signup/plan/store';
import { loadClaimShadowContext } from './candidate-rows';
import { bindDispatchClaimEnforce, createClaimEnforcer } from './claim-enforce';
import type { ReadClaim } from './claim-reader';
import type { ClaimShadow } from './claim-shadow';
import { refuseUnbackedSend } from './gate';

/**
 * VIL-581 · "registered", "sent" and "cancelled" are sent only with a row that backs
 * them, read from the real family against the real DDL. The reader is a scripted port
 * (what the model reads is the claim-read eval's job, on real recordings); the rows
 * the code offers and the verdict it reaches on them are the real ones.
 */

const NOW = new Date('2026-11-03T17:00:00Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const REGISTERED = 'She is registered for Saturday swim.';
const SENT = 'I texted your co-parent the pickup time.';
const CANCELLED = 'I took Saturday swim off your calendar.';

let db: TestDb;
let seq = 0;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

async function user(): Promise<string> {
  seq += 1;
  const [row] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:claim-done-${seq}`, name: 'Parent', timezone: 'America/Denver' })
    .returning({ id: schema.users.id });
  return row?.id as string;
}

async function seed(primaryLanguage = 'en') {
  const primary = await user();
  const [fam] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Household',
      provinceOrState: 'CO',
      onboardingStage: 'sms_active',
      primaryLanguage,
    })
    .returning({ id: schema.families.id });
  const familyId = fam?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: primary, role: 'primary_parent' });
  const [kid] = await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Kid', dateOfBirth: '2022-05-01' })
    .returning({ id: schema.children.id });
  return { familyId, primary, childId: kid?.id as string };
}

async function signupOffer(
  ids: { familyId: string; primary: string; childId: string },
  status: 'pending' | 'planned' | 'submitting' | 'completed' | 'handed_back',
  extra: Partial<typeof schema.authorizedSignupOffers.$inferInsert> = {},
): Promise<string> {
  const [row] = await db.database
    .insert(schema.authorizedSignupOffers)
    .values({
      familyId: ids.familyId,
      childId: ids.childId,
      parentUserId: ids.primary,
      activityKey: 'swim-sat',
      activityLabel: 'Saturday swim',
      registrationUrl: 'https://register.example.org/swim',
      sessions: [],
      providerHost: 'register.example.org',
      status,
      ...extra,
    })
    .returning({ id: schema.authorizedSignupOffers.id });
  return row?.id as string;
}

const noShadow: ClaimShadow = {
  sweep: () => 'off',
  coachTurn: () => 'off',
  dispatch: () => 'off',
};

/** The real loader and verifier; only the model's answer is scripted. */
function enforcerSaying(claims: ReadClaim[]) {
  return createClaimEnforcer({
    enforces: () => true,
    reader: scriptedClaimReader(() => claims),
    loadContext: loadClaimShadowContext,
  });
}

const sweep = (familyId: string, body: string, claims: ReadClaim[]) =>
  refuseUnbackedSend(
    db.database,
    { familyId, body, now: NOW, lane: 'activity_followup' },
    noShadow,
    enforcerSaying(claims),
  );

const dispatch = (familyId: string, parentUserId: string, body: string, claims: ReadClaim[]) =>
  bindDispatchClaimEnforce(db.database, enforcerSaying(claims)).decide({
    familyId,
    parentUserId,
    body,
    now: NOW,
  });

const registered = (row: ReadClaim['row']): ReadClaim[] => [
  { segment: 0, kind: 'registration_done', row },
];

describe('a "registered" claim needs a confirmation row', () => {
  it('no confirmation row: the sweep refuses it and dispatch does not send it', async () => {
    const ids = await seed();
    // Not confirmed: a pending and a handed-back offer back nothing.
    await signupOffer(ids, 'handed_back');
    expect(await sweep(ids.familyId, REGISTERED, registered('r1'))).toEqual([
      'no_registration_record',
    ]);
    expect(await dispatch(ids.familyId, ids.primary, REGISTERED, registered('r1'))).toEqual({
      status: 'unbacked',
    });
  });

  it('a confirmed signup backs it: the sweep and dispatch both send', async () => {
    const ids = await seed();
    await signupOffer(ids, 'completed');
    expect(await sweep(ids.familyId, REGISTERED, registered('r1'))).toEqual([]);
    expect(await dispatch(ids.familyId, ids.primary, REGISTERED, registered('r1'))).toEqual({
      status: 'clean',
    });
  });

  it('a booking a confirmation email recorded backs it; a cancelled one does not', async () => {
    const ids = await seed();
    const booking = (cancelledAt: Date | null) =>
      db.database.insert(schema.activityBookings).values({
        familyId: ids.familyId,
        parentUserId: ids.primary,
        integrationId: '00000000-0000-4000-8000-0000000000c1',
        messageId: `msg-${cancelledAt ? 'gone' : 'live'}`,
        providerHost: 'register.example.org',
        title: 'Saturday swim',
        firstSessionAt: at(4),
        cancelledAt,
      });
    await booking(NOW);
    expect(await sweep(ids.familyId, REGISTERED, registered('r1'))).toEqual([
      'no_registration_record',
    ]);
    await booking(null);
    expect(await sweep(ids.familyId, REGISTERED, registered('r1'))).toEqual([]);
  });

  it('a calendar row is not a registration: citing one is refused', async () => {
    const ids = await seed();
    await db.database.insert(schema.familyEvents).values({
      familyId: ids.familyId,
      title: 'Saturday swim',
      startsAt: at(4),
      source: 'parent',
    });
    expect(await sweep(ids.familyId, REGISTERED, registered('e1'))).toEqual([
      'no_registration_record',
    ]);
  });
});

describe('a "sent" claim needs a send receipt', () => {
  async function withCoParent() {
    const ids = await seed();
    const coParent = await user();
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: ids.familyId, userId: coParent, role: 'co_parent' });
    return { ...ids, coParent };
  }

  /** A text Hale sent because an action said to: the only kind of text that is a receipt. */
  async function actionText(
    ids: { familyId: string },
    parentUserId: string,
    status: 'sent' | 'delivered',
  ) {
    const [event] = await db.database
      .insert(schema.events)
      .values({
        familyId: ids.familyId,
        source: 'test',
        eventType: 'test',
        dedupHash: `dedup-${ids.familyId}-${parentUserId}-${status}`,
      })
      .returning({ id: schema.events.id });
    const [action] = await db.database
      .insert(schema.actions)
      .values({
        familyId: ids.familyId,
        eventId: event?.id as string,
        actionType: 'share_photos_with_family',
        payload: {},
      })
      .returning({ id: schema.actions.id });
    await db.database.insert(schema.channelMessages).values({
      familyId: ids.familyId,
      parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reminder',
      status,
      sentAt: at(-0.1),
      relatedActionId: action?.id as string,
    });
  }

  const sent: ReadClaim[] = [{ segment: 0, kind: 'send_done', row: 'm1' }];
  const received: ReadClaim[] = [{ segment: 0, kind: 'send_received', row: 'm1' }];
  const GOT_IT = 'Your co-parent got the pickup time.';

  it("Hale's chat to the recipient themself is not a receipt", async () => {
    const ids = await withCoParent();
    await db.database.insert(schema.channelMessages).values({
      familyId: ids.familyId,
      parentUserId: ids.primary,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      status: 'delivered',
      sentAt: at(-0.1),
    });
    expect(await sweep(ids.familyId, SENT, sent)).toEqual(['no_send_record']);
  });

  it("Hale's chat reply to the co-parent is not a receipt for the primary parent", async () => {
    const ids = await withCoParent();
    await db.database.insert(schema.channelMessages).values({
      familyId: ids.familyId,
      parentUserId: ids.coParent,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      status: 'delivered',
      sentAt: at(-0.1),
    });
    expect(await sweep(ids.familyId, SENT, sent)).toEqual(['no_send_record']);
  });

  it("Hale's own reply in a group chat is not a receipt", async () => {
    const ids = await withCoParent();
    await db.database.insert(schema.linqGroupMembers).values({
      familyId: ids.familyId,
      chatId: 'chat-group-1',
      userId: ids.primary,
      phoneE164Encrypted: 'enc',
      phoneE164Hash: 'hash',
      role: 'parent',
    });
    await db.database.insert(schema.channelMessages).values({
      familyId: ids.familyId,
      parentUserId: ids.primary,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      status: 'delivered',
      providerChatId: 'chat-group-1',
      sentAt: at(-0.1),
    });
    expect(await sweep(ids.familyId, 'I posted the RSVP in the group.', sent)).toEqual([
      'no_send_record',
    ]);
  });

  it('a text an action sent to the co-parent backs "I sent it" once the provider took it', async () => {
    const ids = await withCoParent();
    await actionText(ids, ids.coParent, 'sent');
    expect(await sweep(ids.familyId, SENT, sent)).toEqual([]);
  });

  it('"they got it" needs the provider to have said it was delivered', async () => {
    const ids = await withCoParent();
    await actionText(ids, ids.coParent, 'sent');
    expect(await sweep(ids.familyId, GOT_IT, received)).toEqual(['no_delivery_record']);
    expect(await dispatch(ids.familyId, ids.primary, GOT_IT, received)).toEqual({
      status: 'unbacked',
    });
    await db.database
      .update(schema.channelMessages)
      .set({ status: 'delivered' })
      .where(eq(schema.channelMessages.familyId, ids.familyId));
    expect(await sweep(ids.familyId, GOT_IT, received)).toEqual([]);
  });
});

describe('a booking or a cancellation that names a day must be that day', () => {
  const SATURDAY = new Date('2026-11-07T17:00:00Z'); // 10:00 in America/Denver

  async function bookingOn(ids: { familyId: string; primary: string }, when: Date) {
    await db.database.insert(schema.activityBookings).values({
      familyId: ids.familyId,
      parentUserId: ids.primary,
      integrationId: '00000000-0000-4000-8000-0000000000c2',
      messageId: 'msg-day',
      providerHost: 'register.example.org',
      title: 'Saturday swim',
      firstSessionAt: when,
    });
  }

  it('fr: "réservé pour jeudi" cited to a Saturday booking is refused', async () => {
    const ids = await seed('fr');
    await bookingOn(ids, SATURDAY);
    const booked: ReadClaim[] = [{ segment: 0, kind: 'scheduled_event', row: 'r1' }];
    expect(
      await sweep(ids.familyId, 'Le cours de natation est réservé pour jeudi à 16 h.', booked),
    ).toEqual(['no_scheduled_row']);
    expect(
      await sweep(ids.familyId, 'Le cours de natation est réservé pour samedi à 10 h.', booked),
    ).toEqual([]);
  });

  it('en: "registered … Thursday at 4pm" cited to a Saturday booking is refused', async () => {
    const ids = await seed();
    await bookingOn(ids, SATURDAY);
    expect(
      await sweep(
        ids.familyId,
        'She is registered for swim lessons on Thursday at 4pm.',
        registered('r1'),
      ),
    ).toEqual(['no_registration_record']);
    expect(
      await sweep(
        ids.familyId,
        'She is registered for swim lessons on Saturday at 10am.',
        registered('r1'),
      ),
    ).toEqual([]);
  });

  it('a removed Saturday row does not back "I cancelled Thursday\'s swim"', async () => {
    const ids = await seed();
    await db.database.insert(schema.familyEvents).values({
      familyId: ids.familyId,
      title: 'Swim lesson',
      startsAt: SATURDAY,
      source: 'placement',
      deletedAt: at(-0.1),
    });
    const cancelled: ReadClaim[] = [{ segment: 0, kind: 'cancelled', row: 'x1' }];
    expect(await sweep(ids.familyId, "I cancelled Thursday's swim.", cancelled)).toEqual([
      'no_cancel_record',
    ]);
    expect(await sweep(ids.familyId, "I cancelled Saturday's swim.", cancelled)).toEqual([]);
  });
});

describe('a "cancelled" claim needs a cancellation row', () => {
  it('nothing removed: refused; a calendar row removed this week backs it', async () => {
    const ids = await seed();
    const cancelled: ReadClaim[] = [{ segment: 0, kind: 'cancelled', row: 'x1' }];
    expect(await sweep(ids.familyId, CANCELLED, cancelled)).toEqual(['no_cancel_record']);
    await db.database.insert(schema.familyEvents).values({
      familyId: ids.familyId,
      title: 'Saturday swim',
      startsAt: at(4),
      source: 'placement',
      deletedAt: at(-0.1),
    });
    expect(await sweep(ids.familyId, CANCELLED, cancelled)).toEqual([]);
  });
});

describe('a cancelled sign-up counts only once it is over', () => {
  const CANCELLED_SWIM = "I cancelled Saturday swim, so you won't be charged.";
  const cancelled: ReadClaim[] = [{ segment: 0, kind: 'cancelled', row: 'x1' }];
  const PAYING = {
    phase: 'paying' as const,
    runId: 'run-1',
    sessionId: 'session-1',
    browserId: null,
    choiceIndex: 0,
    cartTotalCents: 9000,
    holdExpiresAt: null,
    costUsd: null,
  };

  it('a take-back while the payment runs is only a request: refused', async () => {
    const ids = await seed();
    const offerId = await signupOffer(ids, 'submitting', { planResume: PAYING });
    expect(
      await cancelSignupPlan(db.database, {
        offerId,
        familyId: ids.familyId,
        actor: ids.primary,
        now: at(-0.1),
      }),
    ).toBe('paying');
    expect(await sweep(ids.familyId, CANCELLED_SWIM, cancelled)).toEqual(['no_cancel_record']);
    // The run then ends without the registration: the payment was under way, so it is
    // still not a cancellation anyone can promise "no charge" on.
    await db.database
      .update(schema.authorizedSignupOffers)
      .set({ status: 'handed_back' })
      .where(eq(schema.authorizedSignupOffers.id, offerId));
    expect(await sweep(ids.familyId, CANCELLED_SWIM, cancelled)).toEqual(['no_cancel_record']);
  });

  it('a take-back before the run started is a cancellation: backed', async () => {
    const ids = await seed();
    const offerId = await signupOffer(ids, 'planned');
    expect(
      await cancelSignupPlan(db.database, {
        offerId,
        familyId: ids.familyId,
        actor: ids.primary,
        now: at(-0.1),
      }),
    ).toBe('cancelled');
    expect(await sweep(ids.familyId, 'I cancelled the swim sign-up.', cancelled)).toEqual([]);
  });
});
