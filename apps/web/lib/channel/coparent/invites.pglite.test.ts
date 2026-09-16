import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type CoParentInvite,
  declineOpenInviteOnStop,
  loadPendingAssent,
  startCoParentInvite,
} from '~/lib/channel/caregiver/invites';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';

/**
 * VIL-355 · the co-parent invite's guards against the REAL DDL.
 *
 * WHY NOT THE FAKE. Every guard here is a QUERY — a blind-index equality over closed
 * rows, a role filter over `family_members`, a check-at-use expiry, and the partial
 * unique index that makes "one open invite per number" true rather than merely intended.
 * The Drizzle chain fake hands back whatever rows the test seeded, so it passes just as
 * happily with the `where` clause deleted: a fake of an index can never prove the index.
 * What these guards decide is whether a phone number belonging to somebody who has never
 * heard of Hale gets texted, so they are proven by Postgres.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165551234';
const PARTNER_PHONE = '+16475550199';
const FRESH_PHONE = '+16475550188';
const NOW = new Date('2026-09-15T12:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

/** A household with one primary parent, and nothing else. Several tests seed two, so
 * the parent's identity is per-household rather than per-number. */
let households = 0;

async function seedFamily(): Promise<{ familyId: string; parentUserId: string }> {
  households += 1;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:household-${households}`, name: 'Ana' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  return { familyId, parentUserId };
}

function start(
  seeded: { familyId: string; parentUserId: string },
  phoneE164: string,
  now: Date = NOW,
) {
  return startCoParentInvite(db.database, {
    familyId: seeded.familyId,
    invitedByUserId: seeded.parentUserId,
    inviterPhoneE164: PARENT_PHONE,
    inviterName: 'Ana',
    parsed: { ok: true, name: 'Sam', phoneE164, role: 'co_parent' },
    language: 'en',
    now,
  });
}

async function auditVerbs(): Promise<string[]> {
  const rows = await db.database
    .select({ actionTaken: schema.auditLog.actionTaken })
    .from(schema.auditLog);
  return rows.map((r) => r.actionTaken);
}

async function inviteStates(): Promise<Array<{ state: string; closed: boolean }>> {
  const rows = await db.database
    .select({ state: schema.caregiverInvites.state, closedAt: schema.caregiverInvites.closedAt })
    .from(schema.caregiverInvites);
  return rows.map((r) => ({ state: r.state, closed: r.closedAt !== null }));
}

describe('the refusal a closed row remembers', () => {
  /**
   * The un-stoppable-message fix, with its positive control in the same test. Before
   * VIL-355 only OPEN invites were consulted, so a number that had said no could be
   * asked again tomorrow, five a day, forever. A lookback that refused EVERY number
   * would pass the first half alone — the fresh number is what proves the memory is
   * keyed on the number that actually refused.
   */
  it('refuses a number with a declined row, and still opens for a number without one', async () => {
    const seeded = await seedFamily();
    await db.database.insert(schema.caregiverInvites).values({
      familyId: seeded.familyId,
      invitedByUserId: seeded.parentUserId,
      role: 'co_parent',
      displayName: 'Sam',
      phoneE164Encrypted: encryptString(PARTNER_PHONE),
      phoneE164Hash: phoneBlindIndex(PARTNER_PHONE),
      state: 'declined',
      expiresAt: NOW,
      closedAt: NOW,
      createdAt: NOW,
    });

    expect(await start(seeded, PARTNER_PHONE)).toEqual({
      status: 'refused',
      reason: 'previously_declined',
    });
    expect(await auditVerbs()).toContain('co_parent_invite_blocked_prior_refusal');

    const fresh = await start(seeded, FRESH_PHONE);
    expect(fresh.status).toBe('started');
  });

  /** The refusal is FAMILY-BLIND, the same scope the STOP keyword already has: a number
   * that said no to one household has not volunteered for the next one. */
  it('remembers the refusal against a household that never asked before', async () => {
    const first = await seedFamily();
    await db.database.insert(schema.caregiverInvites).values({
      familyId: first.familyId,
      invitedByUserId: first.parentUserId,
      role: 'co_parent',
      displayName: 'Sam',
      phoneE164Encrypted: encryptString(PARTNER_PHONE),
      phoneE164Hash: phoneBlindIndex(PARTNER_PHONE),
      state: 'declined',
      expiresAt: NOW,
      closedAt: NOW,
      createdAt: NOW,
    });
    const second = await seedFamily();

    expect(await start(second, PARTNER_PHONE)).toEqual({
      status: 'refused',
      reason: 'previously_declined',
    });
  });
});

describe('STOP, and what it leaves behind', () => {
  it('closes an open co-parent invite under the CO-PARENT verb, and bars the re-ask', async () => {
    const seeded = await seedFamily();
    await start(seeded, PARTNER_PHONE);

    expect(await declineOpenInviteOnStop(db.database, PARTNER_PHONE, NOW)).toBe(true);

    expect(await inviteStates()).toEqual([{ state: 'declined', closed: true }]);
    // The landmine this ticket found: `closeInvite` used to name a caregiver verb
    // unconditionally, so a co-parent's STOP rendered in the trail as "a caregiver
    // invite" — about the other parent of these children.
    expect(await auditVerbs()).toContain('co_parent_invite_refused');
    expect(await auditVerbs()).not.toContain('caregiver_invite_refused');

    // And the STOP is remembered by the same closed row the NO is: one terminal state.
    expect(await start(seeded, PARTNER_PHONE)).toEqual({
      status: 'refused',
      reason: 'previously_declined',
    });
  });
});

describe('the 72h silence bound, applied on read', () => {
  it('expires a lapsed assent under the co-parent verb, and keeps a live one', async () => {
    const seeded = await seedFamily();
    const opened = await start(seeded, PARTNER_PHONE);
    expect(opened.status).toBe('started');

    // Still inside the window: the parent's yes is still claimable.
    const live = await loadPendingAssent(
      db.database,
      seeded.parentUserId,
      new Date(NOW.getTime() + 71 * 3_600_000),
    );
    expect(live?.role).toBe('co_parent');

    const lapsed = await loadPendingAssent(
      db.database,
      seeded.parentUserId,
      new Date(NOW.getTime() + 73 * 3_600_000),
    );
    expect(lapsed).toBeNull();
    expect(await inviteStates()).toEqual([{ state: 'expired', closed: true }]);
    expect(await auditVerbs()).toContain('co_parent_invite_expired');
    expect(await auditVerbs()).not.toContain('caregiver_invite_expired');
  });
});

describe('the one seat', () => {
  it('refuses a second co-parent, and opens when the seat is free', async () => {
    const seeded = await seedFamily();
    expect((await start(seeded, FRESH_PHONE)).status).toBe('started');
    await db.exec('truncate table caregiver_invites cascade');

    const [other] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'sms:already-here', name: 'Jo' })
      .returning({ id: schema.users.id });
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: seeded.familyId, userId: other?.id as string, role: 'co_parent' });

    expect(await start(seeded, PARTNER_PHONE)).toEqual({
      status: 'refused',
      reason: 'co_parent_seat_taken',
    });
  });

  /** A co-parent in a DIFFERENT household does not fill this one's seat — the role
   * filter has to be family-scoped, and a query missing the family predicate returns
   * rows either way against the fake. */
  it('does not count another household co-parent against this family', async () => {
    const seeded = await seedFamily();
    const elsewhere = await seedFamily();
    const [other] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'sms:elsewhere', name: 'Jo' })
      .returning({ id: schema.users.id });
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: elsewhere.familyId, userId: other?.id as string, role: 'co_parent' });

    expect((await start(seeded, PARTNER_PHONE)).status).toBe('started');
  });
});

describe('one open invite per number', () => {
  /**
   * `already_invited` is a read, and the partial unique index is what makes the read's
   * answer true under concurrency. Proving the index exists is the positive control for
   * the guard: without it the guard is advice, and two racing adds would both open.
   */
  it('is the database that says so, not only the guard', async () => {
    const seeded = await seedFamily();
    const opened = await start(seeded, PARTNER_PHONE);
    expect(opened.status).toBe('started');

    expect(await start(seeded, PARTNER_PHONE)).toEqual({
      status: 'refused',
      reason: 'already_invited',
    });

    await expect(
      db.database.insert(schema.caregiverInvites).values({
        familyId: seeded.familyId,
        invitedByUserId: seeded.parentUserId,
        role: 'co_parent',
        displayName: 'Sam',
        phoneE164Encrypted: encryptString(PARTNER_PHONE),
        phoneE164Hash: phoneBlindIndex(PARTNER_PHONE),
        state: 'awaiting_parent_assent',
        expiresAt: NOW,
        createdAt: NOW,
      }),
    ).rejects.toThrow(/caregiver_invites_phone_open_idx/);

    // And a CLOSED row on the same number does not hold the slot: the index is partial.
    const invite = (opened as { invite: CoParentInvite }).invite;
    await db.database
      .update(schema.caregiverInvites)
      .set({ state: 'declined', closedAt: NOW })
      .where(eq(schema.caregiverInvites.id, invite.id));
    await db.database.insert(schema.caregiverInvites).values({
      familyId: seeded.familyId,
      invitedByUserId: seeded.parentUserId,
      role: 'co_parent',
      displayName: 'Sam',
      phoneE164Encrypted: encryptString(PARTNER_PHONE),
      phoneE164Hash: phoneBlindIndex(PARTNER_PHONE),
      state: 'awaiting_parent_assent',
      expiresAt: NOW,
      createdAt: NOW,
    });
    expect(await inviteStates()).toHaveLength(2);
  });
});
