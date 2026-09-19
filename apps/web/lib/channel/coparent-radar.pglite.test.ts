import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POLICY_VERSION } from '~/lib/consent';
import { acceptCoParentInvite } from '~/lib/channel/coparent/accept';
import { departCoParent } from '~/lib/channel/coparent/depart';
import type { CoParentInvite } from '~/lib/channel/caregiver/invites';
import { loadFamilyTextRecipients } from '~/lib/channel/family-recipients';
import { buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import { WATCH_CONSENT_SCOPE } from '~/lib/channel/intake/watch-consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';

/**
 * THE CO-PARENT REACHES THE RADAR — the two reads that decide it, against the real DDL
 * and a real seating transaction (audit 2026-09-17).
 *
 * A fake cannot answer either question. The recipient reader is three INNER JOINs and a
 * partial unique index; the consent decision is a latest-row-wins read over a ledger
 * that carries BOTH withdrawal conventions and is written by a transaction this file
 * runs for real rather than stipulates. `acceptCoParentInvite` is the seam the whole
 * change rests on: if it ever stopped writing the row the gate now reads, a mocked
 * version of it would keep these green while every unprompted text to a co-parent was
 * held.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165551234';
const PARTNER_PHONE = '+16475550199';
const NANNY_PHONE = '+16475550177';
const NOW = new Date('2026-09-15T12:00:00.000Z');
/**
 * When the departing parent leaves — the REAL clock plus an hour, not `NOW` plus one.
 *
 * `consent_records.granted_at` defaults to the insert's own wall clock, and a withdrawal
 * is an APPENDED `granted=false` row that only supersedes the grant by being NEWER. In
 * production both stamps come from the same monotonic clock so the ordering is free; in
 * a fixture whose `NOW` sits in the past, a withdrawal stamped `NOW + 1h` is older than
 * the grant it is meant to end, and latest-row-wins correctly reads the grant.
 */
const LATER = new Date(Date.now() + 3_600_000);

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

let households = 0;

async function seedFamily(): Promise<{ familyId: string; parentUserId: string }> {
  households += 1;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON', onboardingStage: 'sms_active' })
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
  await db.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PARENT_PHONE),
    phoneE164Hash: phoneBlindIndex(PARENT_PHONE),
    verifiedAt: NOW,
  });
  return { familyId, parentUserId };
}

/** The intake watch-offer's own row — the ONE writer of `proactive_watch`. */
async function grantWatch(
  seeded: { familyId: string; parentUserId: string },
  granted = true,
): Promise<void> {
  await db.database.insert(schema.consentRecords).values({
    userId: seeded.parentUserId,
    familyId: seeded.familyId,
    consentType: 'proactive_watch',
    granted,
    consentScope: WATCH_CONSENT_SCOPE,
    policyVersion: POLICY_VERSION,
    evidence: { verbatimReply: granted ? 'yes please' : 'no thanks' },
  });
}

/** An invite already past the inviting parent's yes — the row the partner answers. */
async function armedInvite(seeded: {
  familyId: string;
  parentUserId: string;
}): Promise<CoParentInvite> {
  const [row] = await db.database
    .insert(schema.caregiverInvites)
    .values({
      familyId: seeded.familyId,
      invitedByUserId: seeded.parentUserId,
      role: 'co_parent',
      displayName: 'Sam',
      phoneE164Encrypted: encryptString(PARTNER_PHONE),
      phoneE164Hash: phoneBlindIndex(PARTNER_PHONE),
      state: 'awaiting_caregiver_reply',
      expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
      createdAt: NOW,
    })
    .returning({ id: schema.caregiverInvites.id });
  return {
    id: row?.id as string,
    familyId: seeded.familyId,
    invitedByUserId: seeded.parentUserId,
    role: 'co_parent',
    displayName: 'Sam',
    phoneE164: PARTNER_PHONE,
    state: 'awaiting_caregiver_reply',
    expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
  };
}

/** Seat the partner the way production does, and hand back their user id. */
async function seatCoParent(seeded: {
  familyId: string;
  parentUserId: string;
}): Promise<string> {
  const accepted = await acceptCoParentInvite(db.database, {
    invite: await armedInvite(seeded),
    verbatimReply: 'YES',
    now: NOW,
  });
  if (accepted.outcome !== 'seated') throw new Error(`seating failed: ${accepted.outcome}`);
  return accepted.coParentUserId;
}

describe('who the family-scoped sweeps text', () => {
  it('returns both parent seats, the primary first', async () => {
    const seeded = await seedFamily();
    const coParentUserId = await seatCoParent(seeded);

    expect(await loadFamilyTextRecipients(db.database, seeded.familyId)).toEqual([
      { parentUserId: seeded.parentUserId, timeZone: 'America/Toronto', role: 'primary_parent' },
      { parentUserId: coParentUserId, timeZone: 'America/Toronto', role: 'co_parent' },
    ]);
  });

  it('drops a co-parent who has left, because departure revoked their channel', async () => {
    const seeded = await seedFamily();
    const coParentUserId = await seatCoParent(seeded);
    const departure = await departCoParent(db.database, {
      familyId: seeded.familyId,
      actorUserId: coParentUserId,
      now: LATER,
    });
    expect(departure.outcome).toBe('departed');

    expect(await loadFamilyTextRecipients(db.database, seeded.familyId)).toEqual([
      { parentUserId: seeded.parentUserId, timeZone: 'America/Toronto', role: 'primary_parent' },
    ]);
  });

  /**
   * THE SEAT WITHOUT THE NUMBER — a co-parent who pressed STOP.
   *
   * Departure is not the only way a co-parent stops being textable, and it is the only
   * one the case above exercises: `departCoParent` DELETES the `family_members` row as
   * well as revoking the channel, so the role join alone would drop them and the
   * revocation predicate could be deleted with every case here still green (mutation
   * M4, verifier r1). A STOP revokes the channel and leaves the seat exactly where it
   * was — the co-parent still holds the household's scope in the app — so this is the
   * case that makes `revoked_at IS NULL` load-bearing in THIS reader rather than only
   * in the gate behind it.
   */
  it('drops a co-parent who pressed STOP, seat and all', async () => {
    const seeded = await seedFamily();
    const coParentUserId = await seatCoParent(seeded);
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: LATER })
      .where(eq(schema.parentChannels.userId, coParentUserId));

    // The premise: the seat is untouched, so nothing but the channel can drop them.
    const seats = await db.database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.userId, coParentUserId));
    expect(seats).toEqual([{ role: 'co_parent' }]);

    expect(await loadFamilyTextRecipients(db.database, seeded.familyId)).toEqual([
      { parentUserId: seeded.parentUserId, timeZone: 'America/Toronto', role: 'primary_parent' },
    ]);
  });

  /**
   * THE POSITIVE CONTROL for the role filter. A caregiver is seated on the same table,
   * with the same kind of verified channel, and must never appear — their lane is a
   * scoped slice of the week, not the household's radar. Without this the filter could
   * be deleted and every other case here would still pass.
   */
  it('never returns a caregiver, however live their number is', async () => {
    const seeded = await seedFamily();
    const [nanny] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `sms:nanny-${households}`, name: 'Bea' })
      .returning({ id: schema.users.id });
    const nannyUserId = nanny?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: seeded.familyId, userId: nannyUserId, role: 'nanny' });
    await db.database.insert(schema.parentChannels).values({
      userId: nannyUserId,
      familyId: seeded.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(NANNY_PHONE),
      phoneE164Hash: phoneBlindIndex(NANNY_PHONE),
      verifiedAt: NOW,
    });

    const recipients = await loadFamilyTextRecipients(db.database, seeded.familyId);
    expect(recipients.map((row) => row.parentUserId)).toEqual([seeded.parentUserId]);
  });

  it('drops a parent whose channel was never verified', async () => {
    const seeded = await seedFamily();
    await db.database.update(schema.parentChannels).set({ verifiedAt: null });

    expect(await loadFamilyTextRecipients(db.database, seeded.familyId)).toEqual([]);
  });
});

describe('the watch gate, for a seat that never saw the watch offer', () => {
  it('lets a seated co-parent through on their own seating consent', async () => {
    const seeded = await seedFamily();
    await grantWatch(seeded);
    const coParentUserId = await seatCoParent(seeded);
    const ports = buildOutboundGatePorts(db.database);

    // The premise, asserted rather than assumed: the seating transaction writes no
    // `proactive_watch` row, so without the fallback this parent is refused forever.
    const watchRows = await db.database
      .select({ id: schema.consentRecords.id })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.userId, coParentUserId));
    expect(watchRows).toHaveLength(1);

    expect(await ports.watchConsentGranted(seeded.parentUserId)).toBe(true);
    expect(await ports.watchConsentGranted(coParentUserId)).toBe(true);
    expect(await ports.channelEnrolled(coParentUserId)).toBe(true);
  });

  it('refuses a co-parent who has left — departure withdrew the very row it reads', async () => {
    const seeded = await seedFamily();
    const coParentUserId = await seatCoParent(seeded);
    await departCoParent(db.database, {
      familyId: seeded.familyId,
      actorUserId: coParentUserId,
      now: LATER,
    });
    const ports = buildOutboundGatePorts(db.database);

    expect(await ports.watchConsentGranted(coParentUserId)).toBe(false);
    expect(await ports.channelEnrolled(coParentUserId)).toBe(false);
  });

  /**
   * THE HOUSEHOLD'S ANSWER, not just the answerer's (rule #1, audit 2026-09-17 r1).
   *
   * Both unprompted sweeps select families on `onboarding_stage = 'sms_active'`, which
   * a DECLINE sets exactly as a grant does, so this gate is the only thing standing
   * between "should I watch the registration dates at least?" - "no" and the full
   * radar. A per-user fallback would have handed that household the whole ladder the
   * moment a co-parent was seated: the decline is the primary parent's row, and the
   * co-parent has none of their own to be overruled.
   */
  it('never reaches a co-parent in a household that declined the watch', async () => {
    const seeded = await seedFamily();
    await grantWatch(seeded, false);
    const coParentUserId = await seatCoParent(seeded);
    const ports = buildOutboundGatePorts(db.database);

    // Their seating consent is live — the fallback's own precondition — and it is the
    // HOUSEHOLD's no that closes it.
    expect(await ports.channelEnrolled(coParentUserId)).toBe(true);
    expect(await ports.watchConsentGranted(coParentUserId)).toBe(false);
  });

  /**
   * A household nobody has asked yet is not a yes. The primary parent is held here too
   * (no watch row, no seating scope), so the co-parent waiting with them is the
   * consistent answer rather than a second, quieter policy.
   */
  it('waits for the watch offer to be answered at all', async () => {
    const seeded = await seedFamily();
    const coParentUserId = await seatCoParent(seeded);
    const ports = buildOutboundGatePorts(db.database);

    expect(await ports.watchConsentGranted(seeded.parentUserId)).toBe(false);
    expect(await ports.watchConsentGranted(coParentUserId)).toBe(false);
  });

  /**
   * THE NARROWING, and the reason the fallback keys on "no watch row AT ALL" rather
   * than on "no grant". Somebody who answered the watch offer with a NO holds a
   * `proactive_watch` row that says so, and a seat they also hold must never overrule
   * it — that would be the product deciding it had heard yes.
   */
  it('never overrules a watch offer the parent declined', async () => {
    const seeded = await seedFamily();
    await grantWatch(seeded, false);
    await db.database.insert(schema.consentRecords).values({
      userId: seeded.parentUserId,
      familyId: seeded.familyId,
      consentType: 'sms_service_messages',
      granted: true,
      consentScope: 'sms_join_origination',
      policyVersion: POLICY_VERSION,
      evidence: { verbatimReply: 'hi' },
    });

    expect(await buildOutboundGatePorts(db.database).watchConsentGranted(seeded.parentUserId)).toBe(
      false,
    );
  });
});
