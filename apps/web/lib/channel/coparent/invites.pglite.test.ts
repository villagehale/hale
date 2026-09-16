import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type CoParentInvite,
  declineOpenInviteOnStop,
  loadPendingAssent,
  recordCoParentAssent,
  startCaregiverInvite,
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

  /**
   * The SUPPRESSION is family-blind — the same scope the STOP keyword already has: a
   * number that said no to one household has not volunteered for the next one. The
   * SENTENCE is not, and that is the fix: "that number already said no to me once" told
   * a parent in family A that a number they typed had been invited by some other
   * household and had refused. A parent may probe arbitrary numbers with this command,
   * so the answer has to distinguish fewer states than the database does.
   */
  it('suppresses a refusal made to another household WITHOUT saying one happened', async () => {
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
      reason: 'unavailable',
    });
    // And no row of the FIRST household's is named in the second's audit log: a
    // cross-tenant id inside the surface a PIPEDA access request exports.
    const rows = await db.database
      .select({
        familyId: schema.auditLog.familyId,
        actionTaken: schema.auditLog.actionTaken,
        targetId: schema.auditLog.targetId,
      })
      .from(schema.auditLog);
    const theirs = rows.filter((r) => r.familyId === second.familyId);
    // The generic verb, not the one whose sentence says a refusal happened: that sentence
    // is about a person this household has never asked.
    expect(theirs.map((r) => r.actionTaken)).toEqual(['co_parent_invite_blocked']);
    expect(theirs[0]?.targetId).toBeNull();
  });
});

/**
 * THE PROMISE ON THE COLD TEXT IS "Reply STOP anytime", and it has to hold against the
 * command next door. `startCaregiverInvite` consulted only OPEN invites, so somebody who
 * replied STOP to a co-parent invite could be re-texted by the same parent a minute later
 * with `add Sam <same number> as my nanny` — five a day, forever, on a path that
 * legitimately bypasses the outbound gate.
 */
/**
 * THE COMMAND MUST NOT ANSWER QUESTIONS ABOUT STRANGERS' HOUSEHOLDS.
 *
 * A parent may type ANY phone number here, so every guard that reads the number is a
 * question anyone can ask about anyone. "That number is already set up with Hale" is this
 * household's own fact when the account is theirs and a disclosure about somebody else's
 * when it is not — the same sentence, two completely different things to say.
 *
 * Both halves in reach of one another on purpose: a refusal that said `unavailable` for
 * every account would hide the oracle and also stop telling a parent the true, useful
 * thing about their own household, so neither assertion is worth anything alone.
 */
describe('what the refusal may say about a number', () => {
  async function seedVerifiedChannel(familyId: string, phoneE164: string, label: string) {
    const [owner] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `sms:${label}`, name: 'Jo' })
      .returning({ id: schema.users.id });
    await db.database.insert(schema.parentChannels).values({
      userId: owner?.id as string,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phoneE164),
      phoneE164Hash: phoneBlindIndex(phoneE164),
      verifiedAt: NOW,
    });
  }

  it('names the account when it is this household’s own', async () => {
    const seeded = await seedFamily();
    await seedVerifiedChannel(seeded.familyId, PARTNER_PHONE, 'ours');

    expect(await start(seeded, PARTNER_PHONE)).toEqual({
      status: 'refused',
      reason: 'number_in_use',
    });
  });

  it('will not confirm that a stranger’s number has a Hale account', async () => {
    const theirs = await seedFamily();
    await seedVerifiedChannel(theirs.familyId, PARTNER_PHONE, 'theirs');
    const asking = await seedFamily();

    // The same number, the same guard, a different household asking — and the answer says
    // only that Hale will not do it. `number_in_use` here would let a parent enumerate
    // which phone numbers in the country are on Hale, one add command at a time.
    expect(await start(asking, PARTNER_PHONE)).toEqual({
      status: 'refused',
      reason: 'unavailable',
    });
  });

  /**
   * The third fact behind the same sentence: an invite somebody else's household has open
   * on this number. Distinguishable from a refusal and from an account by the reply, it
   * would tell the asking parent that a stranger is mid-conversation with Hale.
   */
  it('will not confirm that a stranger’s number has an invite open on it', async () => {
    const theirs = await seedFamily();
    await start(theirs, PARTNER_PHONE);
    const asking = await seedFamily();

    expect(await start(asking, PARTNER_PHONE)).toEqual({
      status: 'refused',
      reason: 'unavailable',
    });
  });

  /** The positive control for that one: this household's OWN open invite is theirs to be
   * told about, and says so in the words that let them wait rather than retry. */
  it('tells this household when the open invite is its own', async () => {
    const seeded = await seedFamily();
    await start(seeded, PARTNER_PHONE);
    await db.database
      .update(schema.caregiverInvites)
      .set({ state: 'awaiting_caregiver_reply' })
      .where(eq(schema.caregiverInvites.familyId, seeded.familyId));

    expect(await start(seeded, FRESH_PHONE)).toMatchObject({ status: 'started' });
    expect(await start(seeded, PARTNER_PHONE)).toEqual({
      status: 'refused',
      reason: 'already_invited',
    });
  });
});

describe('the refusal binds BOTH doors', () => {
  function startCaregiver(
    seeded: { familyId: string; parentUserId: string },
    phoneE164: string,
  ) {
    return startCaregiverInvite(db.database, {
      familyId: seeded.familyId,
      invitedByUserId: seeded.parentUserId,
      inviterPhoneE164: PARENT_PHONE,
      parsed: { ok: true, name: 'Sam', phoneE164, role: 'nanny' },
      now: NOW,
    });
  }

  it('refuses a caregiver ask on a number that said STOP to a co-parent invite', async () => {
    const seeded = await seedFamily();
    await start(seeded, PARTNER_PHONE);
    expect(await declineOpenInviteOnStop(db.database, PARTNER_PHONE, NOW)).toBe(true);

    expect(await startCaregiver(seeded, PARTNER_PHONE)).toEqual({
      status: 'previously_declined',
    });
  });

  /** The positive control: a number that never refused still opens on the same door. */
  it('still opens a caregiver invite for a number that never refused', async () => {
    const seeded = await seedFamily();
    expect((await startCaregiver(seeded, FRESH_PHONE)).status).toBe('started');
  });
});

/**
 * THE ASSENT IS A CLAIM, and it had none: the state advance ran `where id = …` with no
 * test that the invite was still awaiting an answer, while its sibling in accept.ts
 * re-tests `closed_at IS NULL` for exactly this reason. Two affirmatives arriving
 * together both read the pending invite, both wrote a grant row, and both reached the
 * send — two unsolicited messages to a stranger for one authorisation.
 */
describe('the parent assent, claimed exactly once', () => {
  it('advances once and returns nothing the second time', async () => {
    const seeded = await seedFamily();
    const opened = await start(seeded, PARTNER_PHONE);
    if (opened.status !== 'started') throw new Error('expected an open invite');
    const invite = opened.invite;

    const first = await recordCoParentAssent(db.database, {
      invite,
      inviterName: 'Ana',
      language: 'en',
      verbatimReply: 'yes',
      channelMessageId: null,
      now: NOW,
    });
    // The same stale invite the losing turn is holding.
    const second = await recordCoParentAssent(db.database, {
      invite,
      inviterName: 'Ana',
      language: 'en',
      verbatimReply: 'yes',
      channelMessageId: null,
      now: new Date(NOW.getTime() + 1_000),
    });

    expect(first).toBeTypeOf('string');
    // Null is the loser's answer, and the caller has nothing to send — which is the
    // point: the body IS the licence to text the stranger.
    expect(second).toBeNull();
    const grants = await db.database
      .select({ consentType: schema.consentRecords.consentType })
      .from(schema.consentRecords);
    expect(grants.filter((g) => g.consentType === 'co_parent_access_grant')).toHaveLength(1);
    expect((await auditVerbs()).filter((v) => v === 'co_parent_access_granted')).toHaveLength(1);
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
