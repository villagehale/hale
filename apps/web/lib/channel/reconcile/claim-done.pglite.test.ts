import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { scriptedClaimReader } from '~/lib/testing/claim-reader';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
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

async function seed() {
  const primary = await user();
  const [fam] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Household',
      provinceOrState: 'CO',
      onboardingStage: 'sms_active',
      primaryLanguage: 'en',
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
  status: 'pending' | 'submitting' | 'completed' | 'handed_back',
) {
  await db.database.insert(schema.authorizedSignupOffers).values({
    familyId: ids.familyId,
    childId: ids.childId,
    parentUserId: ids.primary,
    activityKey: 'swim-sat',
    activityLabel: 'Saturday swim',
    registrationUrl: 'https://register.example.org/swim',
    sessions: [],
    providerHost: 'register.example.org',
    status,
  });
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
  it('no text to anyone else: refused; a delivered text to the co-parent backs it', async () => {
    const ids = await seed();
    const coParent = await user();
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: ids.familyId, userId: coParent, role: 'co_parent' });
    const sent: ReadClaim[] = [{ segment: 0, kind: 'send_done', row: 'm1' }];
    // A text to the recipient themself is the conversation, not a receipt for another.
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
    await db.database.insert(schema.channelMessages).values({
      familyId: ids.familyId,
      parentUserId: coParent,
      channel: 'imessage',
      direction: 'out',
      category: 'reminder',
      status: 'delivered',
      sentAt: at(-0.1),
    });
    expect(await sweep(ids.familyId, SENT, sent)).toEqual([]);
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
