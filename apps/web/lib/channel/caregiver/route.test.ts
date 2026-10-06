import { type Database, schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INVITE_EXPIRED_BY_LANGUAGE } from '~/lib/channel/coparent/copy';
import type { IntakeCollected } from '~/lib/channel/intake/extract';
import {
  FakeAddThemYourself,
  type FakeDb,
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeAckComposer,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
  makeFakeDb,
} from '~/lib/channel/intake/fakes';
import { type IntakeDeps, handleInboundSms } from '~/lib/channel/intake/machine';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { seedTextedInvite } from '~/lib/testing/texted-invite';
import { CAREGIVER_WELCOME } from './copy';
import { INVITE_SILENCE_MS, loadOpenInviteByPhone } from './invites';

/**
 * VIL-241 · M6 — the caregiver invite driven end to end through the ONE inbound entry
 * point, against the intake Fakes. No provider, no database, no model: the whole flow
 * here is deterministic by design, so there is nothing a model could be mocked out of.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165551234';
const GRAN_PHONE = '+16475550199';
const NOW = new Date('2026-07-30T12:00:00.000Z');

function harness(
  now: Date = NOW,
  /** What the (faked) extractor reads out of each inbound, in order. The default reads
   * nothing out of anything, which is the script every test that predates intake
   * appearing in this file is written against. */
  extractions: IntakeCollected[] = [{ children: [], postalCode: null }],
  voice: FakeAddThemYourself = new FakeAddThemYourself(),
): {
  fake: FakeDb;
  transport: FakeTransport;
  deps: IntakeDeps;
  voice: FakeAddThemYourself;
  /** Everything that landed in the PARENT's own coach thread (channel/thread.ts). */
  threaded: Array<{ familyId: string; parentUserId: string; body: string }>;
  /** [first write index, last+1] for each COMMITTED transaction, in order. */
  windows: Array<[number, number]>;
} {
  const fake = makeFakeDb();
  const transport = new FakeTransport();
  const threaded: Array<{ familyId: string; parentUserId: string; body: string }> = [];
  const windows: Array<[number, number]> = [];

  // The transaction boundary is OBSERVED rather than assumed, for the same reason the
  // co-parent link's is (join/route.test.ts): closing an invite in the same transaction
  // that enrols its number is the whole fix, and a closure that merely ran near the
  // enrolment would be undone by a rollback the enrolment survives — or survive one the
  // enrolment does not. Every write's index is compared against the window the
  // transaction opened, so moving the call outside it moves its index outside.
  const db = new Proxy(fake.db, {
    get(target, prop, receiver) {
      if (prop !== 'transaction') return Reflect.get(target, prop, receiver);
      return async (cb: (tx: unknown) => Promise<unknown>) => {
        const start = fake.writes.length;
        const result = await (target as Database).transaction(cb as never);
        windows.push([start, fake.writes.length]);
        return result;
      };
    },
  }) as Database;

  return {
    fake: { ...fake, db },
    transport,
    threaded,
    windows,
    voice,
    deps: {
      transport,
      // Recorded rather than executed: a FakeDb has no `conversations` to resolve, and
      // what this file pins is WHICH sends reach the thread, not how the row is written.
      threadMessage: async (_db, input) => {
        threaded.push(input);
        return 'conv-1';
      },
      extractor: new FakeExtractor(extractions),
      intentReader: new FakeIntentReader([
        { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
      ]),
      radar: fakeRadar,
      ackComposer: fakeAckComposer,
      answerComposer: fakeSilentAnswerComposer,
      openQuestions: fakeNoOpenQuestions,
      identityAsk: new FakeIdentityAsk(),
      addThemYourself: voice,
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

/** Where a write landed relative to the transactions that ran. */
function writeIndex(
  fake: FakeDb,
  table: unknown,
  op: 'insert' | 'update',
  match: (p: Record<string, unknown>) => boolean = () => true,
) {
  return fake.writes.findIndex((w) => w.table === table && w.op === op && match(w.payload));
}

function insideOneTransaction(windows: Array<[number, number]>, indices: number[]): boolean {
  return windows.some(([start, end]) => indices.every((i) => i >= start && i < end));
}

/** A household whose grandma Hale texted an invite before it stopped texting first. */
async function upToInvite(fake: FakeDb, now: Date = NOW) {
  const { familyId, parentUserId } = await seedFamily(fake);
  await seedTextedInvite(fake.db, {
    familyId,
    invitedByUserId: parentUserId,
    role: 'grandparent',
    displayName: 'grandma',
    phoneE164: GRAN_PHONE,
    now,
  });
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});
afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
});

describe('an add by number · Hale texts nobody first', () => {
  it('answers the parent with how grandma gets in, and texts nobody else', async () => {
    const { fake, transport, deps, voice, threaded } = harness();
    await seedFamily(fake);

    const outcome = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add grandma 647-555-0199 as grandparent',
    );

    expect(outcome).toEqual({ status: 'add_them_yourself', role: 'grandparent', reply: 'sent' });
    expect(transport.sent).toEqual([{ to: PARENT_PHONE, body: 'ADD THEM YOURSELF' }]);
    expect(threaded.map((t) => t.body)).toEqual(['ADD THEM YOURSELF']);
    // The model is handed the name and the role, never the number.
    expect(voice.calls).toEqual([
      { language: 'en', name: 'grandma', role: 'grandparent', channel: 'sms' },
    ]);
    expect(JSON.stringify(voice.calls)).not.toContain('555');
    expect(inserts(fake, schema.caregiverInvites)).toHaveLength(0);
    expect(inserts(fake, schema.consentRecords)).toHaveLength(0);
    // The parent's instruction and the reply are on the record (rule #6).
    const rows = inserts(fake, schema.channelMessages).filter((r) => r.category === 'caregiver');
    expect(rows.map((r) => r.direction)).toEqual(['in', 'out']);
  });

  it('answers a co-parent add the same way: no invite, no group opened', async () => {
    const { fake, transport, deps } = harness();
    await seedFamily(fake);

    const outcome = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add Sam 647-555-0199 as co-parent',
    );

    expect(outcome).toEqual({ status: 'add_them_yourself', role: 'co_parent', reply: 'sent' });
    expect(transport.sent.every((s) => s.to === PARENT_PHONE)).toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(inserts(fake, schema.caregiverInvites)).toHaveLength(0);
    const rows = inserts(fake, schema.channelMessages);
    expect(rows.filter((r) => r.category === 'co_parent_invite').map((r) => r.direction)).toEqual([
      'in',
      'out',
    ]);
  });

  it('answers an add it cannot read without guessing a role', async () => {
    const { fake, transport, deps, voice } = harness();
    await seedFamily(fake);

    const outcome = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add my mum 647-555-0199 as chauffeur',
    );

    expect(outcome).toEqual({ status: 'add_them_yourself', role: null, reply: 'sent' });
    expect(voice.calls[0]).toMatchObject({ name: null, role: null });
    expect(inserts(fake, schema.caregiverInvites)).toHaveLength(0);
  });

  it('names a reply it could not write, and sends nothing', async () => {
    const { fake, transport, deps, threaded } = harness(
      NOW,
      undefined,
      new FakeAddThemYourself({ status: 'unsent', reason: 'model_failed' }),
    );
    await seedFamily(fake);

    const outcome = await text(
      fake,
      transport,
      deps,
      PARENT_PHONE,
      'add grandma 647-555-0199 as grandparent',
    );

    expect(outcome).toEqual({
      status: 'add_them_yourself',
      role: 'grandparent',
      reply: 'model_failed',
    });
    expect(transport.sent).toEqual([]);
    expect(threaded).toEqual([]);
    // The instruction is still on the record.
    expect(inserts(fake, schema.channelMessages).filter((r) => r.category === 'caregiver')).toEqual(
      [expect.objectContaining({ direction: 'in' })],
    );
  });

  /**
   * An add Hale asked "Reply YES" about before this change. The parent's yes no longer
   * texts anybody: they get the same reply, and the invite lapses on its own clock.
   */
  it.each(['yes', 'yes please', '👍'])(
    'answers %j to an add asked about earlier without texting the person',
    async (answer) => {
      const { fake, transport, deps } = harness();
      const { familyId, parentUserId } = await seedFamily(fake);
      await fake.db.insert(schema.caregiverInvites).values({
        familyId,
        invitedByUserId: parentUserId,
        role: 'grandparent',
        displayName: 'grandma',
        phoneE164Encrypted: encryptString(GRAN_PHONE),
        phoneE164Hash: phoneBlindIndex(GRAN_PHONE),
        state: 'awaiting_parent_assent',
        expiresAt: new Date(NOW.getTime() + INVITE_SILENCE_MS),
        createdAt: NOW,
      });

      const outcome = await text(fake, transport, deps, PARENT_PHONE, answer);

      expect(outcome).toEqual({ status: 'add_them_yourself', role: 'grandparent', reply: 'sent' });
      expect(transport.sent).toEqual([{ to: PARENT_PHONE, body: 'ADD THEM YOURSELF' }]);
      expect(transport.sent.some((s) => s.to === GRAN_PHONE)).toBe(false);
      expect(inserts(fake, schema.consentRecords)).toHaveLength(0);
      expect(fake.rows(schema.caregiverInvites)[0]?.state).toBe('awaiting_parent_assent');
    },
  );

  it('drops an add asked about earlier when the parent says no', async () => {
    const { fake, transport, deps } = harness();
    const { familyId, parentUserId } = await seedFamily(fake);
    await fake.db.insert(schema.caregiverInvites).values({
      familyId,
      invitedByUserId: parentUserId,
      role: 'grandparent',
      displayName: 'grandma',
      phoneE164Encrypted: encryptString(GRAN_PHONE),
      phoneE164Hash: phoneBlindIndex(GRAN_PHONE),
      state: 'awaiting_parent_assent',
      expiresAt: new Date(NOW.getTime() + INVITE_SILENCE_MS),
      createdAt: NOW,
    });

    const dropped = await text(fake, transport, deps, PARENT_PHONE, 'no');

    expect(dropped).toEqual({ status: 'caregiver_invite_dropped' });
    expect(transport.sent.every((s) => s.to === PARENT_PHONE)).toBe(true);
    expect(inserts(fake, schema.consentRecords)).toHaveLength(0);
    expect(auditActions(fake)).toContain('caregiver_invite_withdrawn');
  });

  /**
   * VIL-260 · WS4 — "add" is what a parent says about their calendar far more often than
   * about a caregiver. The message falls through untouched, which is what the webhook
   * hands to C1.
   */
  it.each([
    'Add library story time Saturday 10am',
    'add swim Thursday at 4:30',
    'add gymnastics as a weekly thing',
  ])('lets the calendar ask %j fall through to the conversational layer', async (body) => {
    const { fake, transport, deps, voice } = harness();
    await seedFamily(fake);

    const outcome = await text(fake, transport, deps, PARENT_PHONE, body);

    expect(outcome).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    expect(transport.sent).toHaveLength(0);
    expect(voice.calls).toEqual([]);
  });

  it('leaves an ordinary message alone and threads nothing', async () => {
    const { fake, transport, deps, threaded } = harness();
    await seedFamily(fake);

    const outcome = await text(fake, transport, deps, PARENT_PHONE, 'what is on saturday');

    expect(outcome).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    expect(transport.sent).toHaveLength(0);
    expect(threaded).toEqual([]);
  });
});

describe('an invite Hale texted before · the invitee half still answers', () => {
  it("turns the caregiver's yes into their OWN consent, channel, membership and audit", async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake);

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
      expect.arrayContaining(['caregiver_invite_accepted', 'channel_sms_enrolled']),
    );
    expect(transport.sent.at(-1)).toEqual({ to: GRAN_PHONE, body: CAREGIVER_WELCOME });
  });

  it("never stores an outbound body, and stores the caregiver's own words verbatim", async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake);
    await text(fake, transport, deps, GRAN_PHONE, 'yes');

    const rows = inserts(fake, schema.channelMessages).filter((r) => r.category === 'caregiver');
    expect(rows.filter((r) => r.direction === 'out').length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.direction === 'out').every((r) => r.body === null)).toBe(true);
    expect(rows.filter((r) => r.direction === 'in').map((r) => r.body)).toEqual(['yes']);
  });

  it('lapses after 72h of silence rather than staying open forever', async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake);

    const later = new Date(NOW.getTime() + INVITE_SILENCE_MS + 1);
    const lateDeps: IntakeDeps = { ...deps, now: later };

    const outcome = await text(fake, transport, lateDeps, GRAN_PHONE, 'yes');

    // The invite is gone, so the yes buys them nothing — and they are TOLD that, in one
    // sentence, instead of being handed an intake greeting.
    expect(outcome).toEqual({ status: 'invite_expired_answered', role: 'grandparent' });
    expect(transport.sent.at(-1)?.body).toBe(INVITE_EXPIRED_BY_LANGUAGE.en);
    expect(auditActions(fake)).toContain('caregiver_invite_expired');
    expect(auditActions(fake)).toContain('caregiver_invite_expired_answered');
    expect(inserts(fake, schema.familyMembers).some((r) => r.role === 'grandparent')).toBe(false);
    expect(transport.sent.every((s) => s.body !== CAREGIVER_WELCOME)).toBe(true);
  });

  it('asks once more when the caregiver replies with neither a yes nor a STOP', async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake);

    const outcome = await text(fake, transport, deps, GRAN_PHONE, 'who is this?');

    expect(outcome).toEqual({ status: 'caregiver_prompted' });
    expect(inserts(fake, schema.familyMembers).some((r) => r.role === 'grandparent')).toBe(false);
  });
});

describe('caregiver · after they are in', () => {
  it('answers anything they ask with the one scoped line, never with household detail', async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake);
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
    await upToInvite(fake);

    const outcome = await text(fake, transport, deps, GRAN_PHONE, 'STOP');

    expect(outcome).toEqual({ status: 'stopped', ack: 'sent' });
    expect(auditActions(fake)).toContain('caregiver_invite_refused');
    expect(inserts(fake, schema.familyMembers).some((r) => r.role === 'grandparent')).toBe(false);
  });

  it('revokes only THEIR subscription on STOP — the parents stay subscribed', async () => {
    const { fake, transport, deps } = harness();
    await upToInvite(fake);
    await text(fake, transport, deps, GRAN_PHONE, 'yes');
    const caregiverUserId = inserts(fake, schema.consentRecords).find(
      (r) => r.consentType === 'caregiver_scoped_messages',
    )?.userId;
    const parentUserId = inserts(fake, schema.consentRecords).find(
      (r) => r.consentType === 'caregiver_access_grant',
    )?.userId;

    const outcome = await text(fake, transport, deps, GRAN_PHONE, 'STOP');

    expect(outcome).toEqual({ status: 'stopped', ack: 'sent' });
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

/**
 * VIL-305 — the collision the forwarded co-parent link had (#541), walked in through the
 * other door: the invited number enrols ITSELF.
 *
 * An invite is opened against a number with no channel, which is also the state a
 * stranger part-way through their own intake is in — so both can be true of one phone at
 * once. When that intake finishes, the invite is the older and smaller question, and
 * leaving it armed is not a cosmetic loose end: it OUTRANKS the channel provisioning has
 * just written (the machine reads invites before channels, deliberately, so a
 * caregiver's "yes" is not read as a stranger saying hello). Every later message is
 * answered with the invite's question, and the "yes" that ends the loop enrols the
 * number a SECOND time — against parent_channels_phone_hash_active_idx, which 500s the
 * webhook and leaves the carrier re-delivering the inbound.
 */
const NOTHING_YET: IntakeCollected = { children: [], postalCode: null };
const MIA: IntakeCollected = {
  children: [{ name: 'Mia', ageMonths: 30, agePrecision: 'months' }],
  postalCode: 'M5V 2T6',
};

/** Seed the household, open an intake session on the sitter's number, then invite it. */
async function upToInviteMidIntake(fake: FakeDb, transport: FakeTransport, deps: IntakeDeps) {
  const { familyId, parentUserId } = await seedFamily(fake);
  const greeted = await text(fake, transport, deps, GRAN_PHONE, 'hi');
  await seedTextedInvite(fake.db, {
    familyId,
    invitedByUserId: parentUserId,
    role: 'grandparent',
    displayName: 'grandma',
    phoneE164: GRAN_PHONE,
    now: NOW,
  });
  return greeted;
}

/**
 * `db` with ONE insert poisoned — a failure late inside the provisioning transaction,
 * after the channel row and the invite's closure are written and before it commits. The
 * transaction's own handle is wrapped too, or the failure would never reach the code
 * under test.
 */
function failingOn(db: Database, table: unknown, actionTaken: string): Database {
  const wrap = (handle: object): object =>
    new Proxy(handle, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (cb: (tx: unknown) => Promise<unknown>) =>
            (target as Database).transaction(((tx: object) => cb(wrap(tx))) as never);
        }
        if (prop !== 'insert') return Reflect.get(target, prop, receiver);
        return (t: unknown) => {
          const chain = (target as Database).insert(t as never) as unknown as {
            values: (payload: unknown) => unknown;
          };
          if (t !== table) return chain;
          const values = chain.values;
          chain.values = (payload: unknown) => {
            const list = Array.isArray(payload) ? payload : [payload];
            if (list.some((row) => (row as Record<string, unknown>).actionTaken === actionTaken)) {
              throw new Error('provisioning failed');
            }
            return values(payload);
          };
          return chain;
        };
      },
    });
  return wrap(db as unknown as object) as Database;
}

describe('a number with an invite in flight finishes its OWN intake', () => {
  it('closes the invite as it provisions, so their next text is an ordinary turn', async () => {
    const { fake, transport, deps } = harness(NOW, [NOTHING_YET, MIA]);

    expect(await upToInviteMidIntake(fake, transport, deps)).toEqual({ status: 'greeted' });
    expect(fake.rows(schema.caregiverInvites)[0]?.state).toBe('awaiting_caregiver_reply');

    // Their yes is SWALLOWED: the machine reads the open conversation first, so an
    // answer to the invite is read as an answer to intake's own question.
    expect(await text(fake, transport, deps, GRAN_PHONE, 'yes')).toEqual({
      status: 'helped',
      ack: 'sent',
    });
    const provisioned = await text(fake, transport, deps, GRAN_PHONE, "Mia's 2, M5V 2T6");
    expect(provisioned.status).toBe('provisioned');

    // Closed by the turn that enrolled them, and closed as what it WAS: a question
    // overtaken by the person answering a bigger one somewhere else. Not 'declined' —
    // nobody refused, and the inviting parent's trail must not say that they did.
    const invite = fake.rows(schema.caregiverInvites)[0];
    expect(invite).toMatchObject({ state: 'superseded_by_enrollment', closedAt: NOW });
    expect(auditActions(fake)).toContain('caregiver_invite_superseded_by_enrollment');
    expect(auditActions(fake)).not.toContain('caregiver_invite_refused');
    expect(auditActions(fake)).not.toContain('caregiver_invite_accepted');

    // Watching is implied by the live find — there is no YES gate. The year find
    // sends the card and the name; later replies close the ladder. After that, a
    // stale invite cannot take the number: the turn finds no open conversation.
    expect(
      inserts(fake, schema.consentRecords).filter((c) => c.consentType === 'proactive_watch'),
    ).toEqual([expect.objectContaining({ granted: true })]);

    const beats = [];
    for (let beat = 0; beat < 8; beat += 1) {
      const advanced = await text(fake, transport, deps, GRAN_PHONE, 'later');
      if (advanced.status !== 'ladder_advanced') break;
      beats.push(advanced);
    }
    // This harness's name lookup declines, so the year-find turn parks on the
    // calendar card. The ladder still closes, and the invite does not take the number.
    expect(beats[0]).toEqual({ status: 'ladder_advanced', step: 'calendar', closed: false });
    expect(beats.at(-1)).toEqual({ status: 'ladder_advanced', step: 'coparent', closed: true });

    const before = transport.sent.length;
    const afterProvision = await text(fake, transport, deps, GRAN_PHONE, 'yes');
    expect(afterProvision).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    expect(transport.sent.slice(before)).toHaveLength(0);

    const next = await text(fake, transport, deps, GRAN_PHONE, "what's on this week?");
    expect(next).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    expect(transport.sent.slice(before)).toHaveLength(0);

    // And a later "yes" can never mint a SECOND active row on this number.
    const yes = await text(fake, transport, deps, GRAN_PHONE, 'yes');
    expect(yes).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    expect(
      inserts(fake, schema.parentChannels).filter(
        (r) => r.phoneE164Hash === phoneBlindIndex(GRAN_PHONE),
      ),
    ).toHaveLength(1);
    // Nor were they ever seated in the inviting household: they are a parent in their
    // own, and the role nobody accepted is not one they now hold.
    expect(inserts(fake, schema.familyMembers).some((r) => r.role === 'grandparent')).toBe(false);
  });

  it('closes it INSIDE the provisioning transaction, not alongside it', async () => {
    const { fake, transport, deps, windows } = harness(NOW, [NOTHING_YET, MIA]);
    await upToInviteMidIntake(fake, transport, deps);
    await text(fake, transport, deps, GRAN_PHONE, 'yes');

    await text(fake, transport, deps, GRAN_PHONE, "Mia's 2, M5V 2T6");

    const indices = [
      writeIndex(
        fake,
        schema.parentChannels,
        'insert',
        (p) => p.phoneE164Hash === phoneBlindIndex(GRAN_PHONE),
      ),
      writeIndex(
        fake,
        schema.caregiverInvites,
        'update',
        (p) => p.state === 'superseded_by_enrollment',
      ),
    ];
    expect(indices.every((i) => i >= 0)).toBe(true);
    // One rollback, one outcome. A closure that commits separately can outlive a
    // provisioning that failed — closing a family's invite for an enrolment that never
    // happened — or be lost to a crash the enrolment survives, which is the armed invite
    // this ticket is about.
    expect(insideOneTransaction(windows, indices)).toBe(true);
  });

  it('leaves the invite open and answerable when provisioning rolls back', async () => {
    const { fake, transport, deps } = harness(NOW, [NOTHING_YET, MIA]);
    await upToInviteMidIntake(fake, transport, deps);
    await text(fake, transport, deps, GRAN_PHONE, 'yes');
    const poisoned = failingOn(fake.db, schema.auditLog, 'sms_intake_provisioned');

    await expect(
      handleInboundSms(poisoned, transport.inbound(GRAN_PHONE, "Mia's 2, M5V 2T6"), deps),
    ).rejects.toThrow('provisioning failed');

    // Nothing was enrolled, so nothing superseded anything: the invite is still the open
    // question it was, on its own clock, and the caregiver can still answer it.
    expect(fake.rows(schema.caregiverInvites)[0]).toMatchObject({
      state: 'awaiting_caregiver_reply',
      closedAt: null,
    });
    expect(auditActions(fake)).not.toContain('caregiver_invite_superseded_by_enrollment');
    expect(
      inserts(fake, schema.parentChannels).filter(
        (r) => r.phoneE164Hash === phoneBlindIndex(GRAN_PHONE),
      ),
    ).toHaveLength(0);
    // Answerable, through the reader that answers it — not merely present in a row.
    expect(await loadOpenInviteByPhone(fake.db, GRAN_PHONE, NOW)).toMatchObject({
      state: 'awaiting_caregiver_reply',
    });
  });
});
