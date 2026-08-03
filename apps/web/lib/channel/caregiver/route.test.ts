import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeExtractor, FakeIntentReader, type FakeDb, fakeRadar, makeFakeDb } from '~/lib/channel/intake/fakes';
import { type IntakeDeps, handleInboundSms } from '~/lib/channel/intake/machine';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import {
  ADD_EXAMPLE,
  ALREADY_INVITED,
  CAREGIVER_WELCOME,
  CO_PARENT_REDIRECT,
  NUMBER_IN_USE,
  OWN_NUMBER,
  TOO_MANY_INVITES,
} from './copy';
import { INVITE_DAILY_CAP, INVITE_SILENCE_MS } from './invites';

/**
 * VIL-241 · M6 — the caregiver invite driven end to end through the ONE inbound entry
 * point, against the intake Fakes. No provider, no database, no model: the whole flow
 * here is deterministic by design, so there is nothing a model could be mocked out of.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165551234';
const GRAN_PHONE = '+16475550199';
const NOW = new Date('2026-07-30T12:00:00.000Z');

function harness(now: Date = NOW): { fake: FakeDb; transport: FakeTransport; deps: IntakeDeps } {
  const fake = makeFakeDb();
  const transport = new FakeTransport();
  return {
    fake,
    transport,
    deps: {
      transport,
      extractor: new FakeExtractor([{ children: [], postalCode: null }]),
      intentReader: new FakeIntentReader([
        { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
      ]),
      radar: fakeRadar,
      limiter: new FakeRateLimiter(() => now.getTime()),
      now,
    },
  };
}

/** A household that already exists: one primary parent on a verified SMS channel. */
async function seedFamily(fake: FakeDb): Promise<{ familyId: string; parentUserId: string }> {
  const [user] = await fake.db
    .insert(schema.users)
    .values({ externalAuthId: `sms:${phoneBlindIndex(PARENT_PHONE)}`, email: null, name: 'Ana' })
    .returning({ id: schema.users.id });
  const [family] = await fake.db
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', onboardingStage: 'sms_active', country: 'CA' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await fake.db
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  await fake.db.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PARENT_PHONE),
    phoneE164Hash: phoneBlindIndex(PARENT_PHONE),
    verifiedAt: NOW,
  });
  return { familyId, parentUserId };
}

function text(
  fake: FakeDb,
  transport: FakeTransport,
  deps: IntakeDeps,
  from: string,
  body: string,
) {
  return handleInboundSms(fake.db, transport.inbound(from, body), deps);
}

function inserts(fake: FakeDb, table: unknown) {
  return fake.writes.filter((w) => w.op === 'insert' && w.table === table).map((w) => w.payload);
}

function auditActions(fake: FakeDb): string[] {
  return inserts(fake, schema.auditLog).map((p) => p.actionTaken as string);
}

/** Drive the invite to the point where the caregiver has been texted. */
async function upToInvite(fake: FakeDb, transport: FakeTransport, deps: IntakeDeps) {
  await seedFamily(fake);
  await text(fake, transport, deps, PARENT_PHONE, 'add grandma 647-555-0199 as grandparent');
  await text(fake, transport, deps, PARENT_PHONE, 'yes');
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});
afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
});

describe('caregiver invite · the double opt-in', () => {
  it('states the scope to the parent and texts NOBODY until they confirm', async () => {
    const { fake, transport, deps } = harness();
    await seedFamily(fake);

    const started = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add grandma 647-555-0199 as grandparent',
    );

    expect(started).toEqual({ status: 'caregiver_invite_started' });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.to).toBe(PARENT_PHONE);
    expect(transport.sent[0]?.body).toContain('Adding grandma as grandparent');
    // The scope, in the parent's own reading, before anyone is contacted.
    expect(transport.sent[0]?.body).toContain("the week's schedule");
    expect(transport.sent[0]?.body).toContain('Never health or appointments');
    expect(transport.sent[0]?.body).toContain('Reply YES');
    // Nothing has been authorised yet, so nothing has been consented to.
    expect(inserts(fake, schema.consentRecords)).toHaveLength(0);
    expect(inserts(fake, schema.familyMembers)).toHaveLength(1); // only the seeded parent
  });

  it("records the parent's authorisation, then texts the caregiver what they'd get", async () => {
    const { fake, transport, deps } = harness();
    await seedFamily(fake);
    await text(fake, transport, deps, PARENT_PHONE, 'add grandma 647-555-0199 as grandparent');

    const sent = await text(fake, transport, deps, PARENT_PHONE, 'yes');

    expect(sent).toEqual({ status: 'caregiver_invite_sent' });
    const grantRows = inserts(fake, schema.consentRecords).filter(
      (r) => r.consentType === 'caregiver_access_grant',
    );
    expect(grantRows).toHaveLength(1);
    expect(grantRows[0]).toMatchObject({ granted: true, consentScope: 'caregiver:grandparent' });
    // The parent's own words are the instrument, not an assertion that they agreed.
    expect((grantRows[0]?.evidence as Record<string, unknown>).verbatimReply).toBe('yes');

    const toGran = transport.sent.find((s) => s.to === GRAN_PHONE);
    expect(toGran?.body).toContain('Ana added you');
    expect(toGran?.body).toContain("the week's schedule");
    expect(toGran?.body).toContain('Reply STOP anytime');
    expect(transport.sent.at(-1)?.to).toBe(PARENT_PHONE);
    expect(transport.sent.at(-1)?.body).toContain("I've texted grandma");
  });

  it("turns the caregiver's yes into their OWN consent, channel, membership and audit", async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake, transport, deps);

    const accepted = await text(fake, transport, deps, GRAN_PHONE, 'yes');

    expect(accepted).toEqual({ status: 'caregiver_accepted' });

    const caregiverConsent = inserts(fake, schema.consentRecords).filter(
      (r) => r.consentType === 'caregiver_scoped_messages',
    );
    expect(caregiverConsent).toHaveLength(1);
    expect(caregiverConsent[0]).toMatchObject({
      granted: true,
      consentScope: 'caregiver:grandparent',
    });
    expect((caregiverConsent[0]?.evidence as Record<string, unknown>).verbatimReply).toBe('yes');

    // Two consents, two people: the parent's authorisation and the caregiver's own.
    const caregiverUserId = caregiverConsent[0]?.userId;
    const grant = inserts(fake, schema.consentRecords).find(
      (r) => r.consentType === 'caregiver_access_grant',
    );
    expect(caregiverUserId).not.toBe(grant?.userId);

    const member = inserts(fake, schema.familyMembers).find((r) => r.role === 'grandparent');
    expect(member).toMatchObject({ role: 'grandparent', userId: caregiverUserId });

    const channel = inserts(fake, schema.parentChannels).at(-1);
    expect(channel).toMatchObject({
      userId: caregiverUserId,
      phoneE164Hash: phoneBlindIndex(GRAN_PHONE),
    });
    // Verified by origination — the acceptance arrived FROM the number, no OTP.
    expect(channel?.verifiedAt).toEqual(NOW);

    expect(auditActions(fake)).toEqual(
      expect.arrayContaining([
        'caregiver_invite_started',
        'caregiver_access_granted',
        'caregiver_invite_accepted',
        'channel_sms_enrolled',
      ]),
    );
    expect(transport.sent.at(-1)).toEqual({ to: GRAN_PHONE, body: CAREGIVER_WELCOME });
  });

  it("never stores an outbound body, and stores the caregiver's own words verbatim", async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake, transport, deps);
    await text(fake, transport, deps, GRAN_PHONE, 'yes');

    const rows = inserts(fake, schema.channelMessages).filter((r) => r.category === 'caregiver');
    expect(rows.filter((r) => r.direction === 'out').length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.direction === 'out').every((r) => r.body === null)).toBe(true);
    expect(rows.filter((r) => r.direction === 'in').map((r) => r.body)).toEqual([
      'add grandma 647-555-0199 as grandparent',
      'yes',
      'yes',
    ]);
  });
});

describe('caregiver invite · the ways it does not happen', () => {
  it('answers an unreadable add command with an example instead of guessing', async () => {
    const { fake, transport, deps } = harness();
    await seedFamily(fake);

    // The command's SHAPE is unmistakable (a real number, the "as" separator) — only
    // the role word is one we do not grant.
    const outcome = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add my mum 647-555-0199 as chauffeur',
    );

    expect(outcome).toEqual({ status: 'caregiver_add_refused', reason: 'unparseable' });
    expect(transport.sent.at(-1)).toEqual({ to: PARENT_PHONE, body: ADD_EXAMPLE });
    expect(inserts(fake, schema.caregiverInvites)).toHaveLength(0);
  });

  /**
   * VIL-260 · WS4 — "add" is what a parent says about their calendar far more often than
   * about a caregiver. Claiming the prefix meant the headline toddler ask was answered
   * with a caregiver example and never reached the coach at all; the message now falls
   * through untouched, which is what the webhook hands to C1.
   */
  it.each([
    'Add library story time Saturday 10am',
    'add swim Thursday at 4:30',
    'add gymnastics as a weekly thing',
  ])('lets the calendar ask %j fall through to the conversational layer', async (body) => {
    const { fake, transport, deps } = harness();
    await seedFamily(fake);

    const outcome = await text(fake, transport, deps, PARENT_PHONE, body);

    expect(outcome).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    expect(transport.sent).toHaveLength(0);
    expect(inserts(fake, schema.caregiverInvites)).toHaveLength(0);
  });

  it('refuses to grant a co-parent the full surface over text, and says why', async () => {
    const { fake, transport, deps } = harness();
    await seedFamily(fake);

    const outcome = await text(fake, transport, deps, PARENT_PHONE, 'add Sam 647-555-0199 as co-parent');

    expect(outcome).toEqual({ status: 'caregiver_add_refused', reason: 'unsupported_role' });
    expect(transport.sent.at(-1)).toEqual({ to: PARENT_PHONE, body: CO_PARENT_REDIRECT });
    expect(inserts(fake, schema.caregiverInvites)).toHaveLength(0);
  });

  it('refuses a number that already has its own Hale channel', async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake, transport, deps);
    await text(fake, transport, deps, GRAN_PHONE, 'yes');

    // Grandma is already in. Re-adding her under a different role would try to hand one
    // number a second active channel — which the partial unique index forbids, and
    // which would silently re-scope someone who never agreed to the new role.
    const outcome = await text(fake, transport, deps, PARENT_PHONE, 'add grandma 647-555-0199 as nanny');

    expect(outcome).toEqual({ status: 'caregiver_add_refused', reason: 'number_in_use' });
    expect(transport.sent.at(-1)).toEqual({ to: PARENT_PHONE, body: NUMBER_IN_USE });
    expect(inserts(fake, schema.familyMembers).some((r) => r.role === 'nanny')).toBe(false);
  });

  it('confirms the caregiver the parent described LAST, not the one they moved on from', async () => {
    const { fake, transport, deps } = harness();
    await seedFamily(fake);
    await text(fake, transport, deps, PARENT_PHONE, 'add grandma 647-555-0199 as grandparent');
    // They changed their mind mid-thought and described someone else instead of answering.
    await text(fake, transport, deps, PARENT_PHONE, 'add Priya 416-555-0143 as nanny');

    await text(fake, transport, deps, PARENT_PHONE, 'yes');

    const invited = transport.sent.filter((s) => s.to !== PARENT_PHONE);
    expect(invited).toHaveLength(1);
    expect(invited[0]?.to).toBe('+14165550143');
    expect(invited[0]?.body).toContain('as nanny');
    // The abandoned one is closed as superseded, not left open to be confirmed later.
    expect(auditActions(fake)).toContain('caregiver_invite_superseded');
  });

  it('will not ask the same person twice while they are still deciding', async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake, transport, deps);
    const sentSoFar = transport.sent.length;

    const again = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add grandma 647-555-0199 as nanny',
    );

    expect(again).toEqual({ status: 'caregiver_add_refused', reason: 'already_invited' });
    expect(transport.sent.at(-1)).toEqual({ to: PARENT_PHONE, body: ALREADY_INVITED });
    // One reply to the parent, and not a second text to grandma.
    expect(transport.sent.slice(sentSoFar).every((s) => s.to === PARENT_PHONE)).toBe(true);
  });

  it('meters invites per family per day, so a text cannot point Hale at a phone book', async () => {
    const { fake, transport, deps } = harness();
    await seedFamily(fake);

    const numbers = ['647-555-0101', '647-555-0102', '647-555-0103', '647-555-0104', '647-555-0105'];
    for (const number of numbers) {
      await text(fake, transport, deps, PARENT_PHONE, `add helper ${number} as nanny`);
      expect(await text(fake, transport, deps, PARENT_PHONE, 'yes')).toEqual({
        status: 'caregiver_invite_sent',
      });
    }
    const strangersTexted = transport.sent.filter((s) => s.to !== PARENT_PHONE).length;
    expect(strangersTexted).toBe(INVITE_DAILY_CAP);

    const capped = await text(fake, transport, deps, PARENT_PHONE, 'add helper 647-555-0106 as nanny');

    expect(capped).toEqual({ status: 'caregiver_add_refused', reason: 'too_many' });
    expect(transport.sent.at(-1)).toEqual({ to: PARENT_PHONE, body: TOO_MANY_INVITES });
    // The meter stopped a SIXTH stranger being texted, which is the only thing it is for.
    expect(transport.sent.filter((s) => s.to !== PARENT_PHONE)).toHaveLength(INVITE_DAILY_CAP);
  });

  it('does not charge a fumbled wording against the meter — nobody was texted', async () => {
    const { fake, transport, deps } = harness();
    await seedFamily(fake);

    for (const number of ['647-555-0101', '647-555-0102', '647-555-0103', '647-555-0104', '647-555-0105']) {
      await text(fake, transport, deps, PARENT_PHONE, `add helper ${number} as nanny`);
    }

    // Five descriptions, zero confirmations: every one superseded the last, so no
    // stranger has heard from Hale and the sixth attempt is still allowed.
    await text(fake, transport, deps, PARENT_PHONE, 'add helper 647-555-0106 as nanny');
    expect(await text(fake, transport, deps, PARENT_PHONE, 'yes')).toEqual({
      status: 'caregiver_invite_sent',
    });
    expect(transport.sent.filter((s) => s.to !== PARENT_PHONE)).toHaveLength(1);
  });

  it('lets the meter roll off a day later', async () => {
    const { fake, transport, deps } = harness();
    await seedFamily(fake);
    for (const number of ['647-555-0101', '647-555-0102', '647-555-0103', '647-555-0104', '647-555-0105']) {
      await text(fake, transport, deps, PARENT_PHONE, `add helper ${number} as nanny`);
      await text(fake, transport, deps, PARENT_PHONE, 'yes');
    }

    const tomorrow: IntakeDeps = { ...deps, now: new Date(NOW.getTime() + 25 * 60 * 60 * 1000) };
    const outcome = await text(fake, transport, tomorrow, PARENT_PHONE, 'add helper 647-555-0106 as nanny');

    expect(outcome).toEqual({ status: 'caregiver_invite_started' });
  });

  it("refuses the parent's own number", async () => {
    const { fake, transport, deps } = harness();
    await seedFamily(fake);

    const outcome = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add Ana 416-555-1234 as babysitter',
    );

    expect(outcome).toEqual({ status: 'caregiver_add_refused', reason: 'own_number' });
    expect(transport.sent.at(-1)).toEqual({ to: PARENT_PHONE, body: OWN_NUMBER });
  });

  it('leaves an ordinary message alone rather than inventing a reply', async () => {
    const { fake, transport, deps } = harness();
    await seedFamily(fake);

    const outcome = await text(fake, transport, deps, PARENT_PHONE, 'what is on saturday');

    expect(outcome).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    expect(transport.sent).toHaveLength(0);
  });

  /**
   * VIL-260 · WS4 — M6 held its own nine-word affirmative list, so a parent who answered
   * the confirmation the way parents actually answer ("yes please", a thumbs-up) was
   * read as unclear and the invite was left to lapse in silence. One vocabulary now.
   */
  it.each(['yes please', 'sounds good', '👍'])(
    'reads %j as the parent authorising the invite',
    async (answer) => {
      const { fake, transport, deps } = harness();
      await seedFamily(fake);
      await text(fake, transport, deps, PARENT_PHONE, 'add grandma 647-555-0199 as grandparent');

      const sent = await text(fake, transport, deps, PARENT_PHONE, answer);

      expect(sent).toEqual({ status: 'caregiver_invite_sent' });
      expect(transport.sent.some((s) => s.to === GRAN_PHONE)).toBe(true);
    },
  );

  it('drops the invite when the parent answers the confirmation with no', async () => {
    const { fake, transport, deps } = harness();
    await seedFamily(fake);
    await text(fake, transport, deps, PARENT_PHONE, 'add grandma 647-555-0199 as grandparent');

    const dropped = await text(fake, transport, deps, PARENT_PHONE, 'no');

    expect(dropped).toEqual({ status: 'caregiver_invite_dropped' });
    expect(transport.sent.every((s) => s.to === PARENT_PHONE)).toBe(true);
    expect(inserts(fake, schema.consentRecords)).toHaveLength(0);
    expect(auditActions(fake)).toContain('caregiver_invite_withdrawn');
  });

  it('lapses after 72h of silence rather than staying open forever', async () => {
    const { fake, transport, deps } = harness();
    await seedFamily(fake);
    await text(fake, transport, deps, PARENT_PHONE, 'add grandma 647-555-0199 as grandparent');
    await text(fake, transport, deps, PARENT_PHONE, 'yes');
    const sentByInvite = transport.sent.length;

    const later = new Date(NOW.getTime() + INVITE_SILENCE_MS + 1);
    const lateDeps: IntakeDeps = { ...deps, now: later };

    const outcome = await text(fake, transport, lateDeps, GRAN_PHONE, 'yes');

    // The invite is gone, so a late yes is a stranger texting Hale — greeted, never
    // silently accepted into a family.
    expect(outcome).toEqual({ status: 'greeted' });
    expect(auditActions(fake)).toContain('caregiver_invite_expired');
    expect(inserts(fake, schema.familyMembers).some((r) => r.role === 'grandparent')).toBe(false);
    expect(transport.sent.slice(sentByInvite).every((s) => s.body !== CAREGIVER_WELCOME)).toBe(
      true,
    );
  });

  it('asks once more when the caregiver replies with neither a yes nor a STOP', async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake, transport, deps);

    const outcome = await text(fake, transport, deps, GRAN_PHONE, 'who is this?');

    expect(outcome).toEqual({ status: 'caregiver_prompted' });
    expect(inserts(fake, schema.familyMembers).some((r) => r.role === 'grandparent')).toBe(false);
  });
});

describe('caregiver · after they are in', () => {
  it('answers anything they ask with the one scoped line, never with household detail', async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake, transport, deps);
    await text(fake, transport, deps, GRAN_PHONE, 'yes');

    const outcome = await text(fake, transport, deps, GRAN_PHONE, 'is Maya feeling better?');

    expect(outcome).toEqual({ status: 'caregiver_scoped_reply' });
    expect(transport.sent.at(-1)).toEqual({
      to: GRAN_PHONE,
      body: "That's one for Ana - I only share the schedule here.",
    });
  });

  it('closes an un-answered invite when the invitee sends STOP', async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake, transport, deps);

    const outcome = await text(fake, transport, deps, GRAN_PHONE, 'STOP');

    expect(outcome).toEqual({ status: 'stopped' });
    expect(auditActions(fake)).toContain('caregiver_invite_refused');
    expect(inserts(fake, schema.familyMembers).some((r) => r.role === 'grandparent')).toBe(false);
  });

  it("revokes only THEIR subscription on STOP — the parents stay subscribed", async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake, transport, deps);
    await text(fake, transport, deps, GRAN_PHONE, 'yes');
    const caregiverUserId = inserts(fake, schema.consentRecords).find(
      (r) => r.consentType === 'caregiver_scoped_messages',
    )?.userId;
    const parentUserId = inserts(fake, schema.consentRecords).find(
      (r) => r.consentType === 'caregiver_access_grant',
    )?.userId;

    const outcome = await text(fake, transport, deps, GRAN_PHONE, 'STOP');

    expect(outcome).toEqual({ status: 'stopped' });
    // The withdrawal is recorded against the CAREGIVER. Which channel row the update
    // touches is decided by a `where user_id = …` the in-memory fake does not evaluate;
    // the user the revocation was aimed at is the decision under test here.
    const withdrawals = inserts(fake, schema.consentRecords).filter((r) => r.granted === false);
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0]?.userId).toBe(caregiverUserId);
    expect(withdrawals[0]?.userId).not.toBe(parentUserId);

    const revoked = inserts(fake, schema.auditLog).filter(
      (r) => r.actionTaken === 'channel_sms_revoked',
    );
    expect(revoked).toHaveLength(1);
    expect(revoked[0]?.actor).toBe(caregiverUserId);
  });
});
