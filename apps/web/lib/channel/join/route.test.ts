import { type Database, schema } from '@hale/db';
import type { FamilyRole } from '~/lib/channel/role-scope';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  type FakeDb,
  fakeAckComposer,
  fakeRadar,
  fakeSilentAnswerComposer,
  makeFakeDb,
} from '~/lib/channel/intake/fakes';
import { greeting } from '~/lib/channel/intake/copy';
import { type IntakeDeps, handleInboundSms } from '~/lib/channel/intake/machine';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { joinTokenHash } from './code';
import { JOIN_LINK_TTL_MS } from './invites';

/**
 * The forwardable co-parent join link, driven end to end through the ONE inbound entry
 * point, against the intake Fakes. No provider, no database, no model.
 *
 * The two halves are deliberately in one file because they are one loop: what the
 * parent is handed is exactly what the partner has to be able to redeem, and a test
 * that minted its own fixture token would never catch the two ends disagreeing. Every
 * redeem below texts the token that came back on the wire.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165551234';
const PARTNER_PHONE = '+16475550199';
/** Somebody else who saw the forwarded link — the reuse attack, in one number. */
const BYSTANDER_PHONE = '+16475550143';
const NOW = new Date('2026-07-30T12:00:00.000Z');

interface Harness {
  fake: FakeDb;
  /** The handle under test: `fake.db` with every transaction's write-window recorded. */
  db: Database;
  transport: FakeTransport;
  threaded: Array<{ familyId: string; parentUserId: string; body: string }>;
  depsAt: (now: Date) => IntakeDeps;
  /** [first write index, last+1] for each committed transaction, in order. */
  windows: Array<[number, number]>;
}

function harness(): Harness {
  const fake = makeFakeDb();
  const transport = new FakeTransport();
  const threaded: Array<{ familyId: string; parentUserId: string; body: string }> = [];
  const windows: Array<[number, number]> = [];

  // The transaction boundary is the thing under test on the redeem path (a co-parent
  // must never exist without the consent row that authorises them), so it is OBSERVED
  // rather than assumed: every write's position is compared against the window the
  // transaction opened. Moving any insert outside the tx moves its index outside.
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
    fake,
    db,
    transport,
    threaded,
    windows,
    depsAt: (now: Date) => ({
      transport,
      threadMessage: async (_db, input) => {
        threaded.push(input);
        return 'conv-1';
      },
      extractor: new FakeExtractor([{ children: [], postalCode: null }]),
      intentReader: new FakeIntentReader([
        { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
      ]),
      radar: fakeRadar,
      ackComposer: fakeAckComposer,
      answerComposer: fakeSilentAnswerComposer,
      identityAsk: new FakeIdentityAsk(),
      limiter: new FakeRateLimiter(() => now.getTime()),
      now,
    }),
  };
}

/** A household that already exists: one member on a verified SMS channel, a primary
 * parent unless a test needs somebody who is not one. */
async function seedFamily(
  fake: FakeDb,
  role: FamilyRole = 'primary_parent',
): Promise<{ familyId: string; parentUserId: string }> {
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
    .values({ familyId, userId: parentUserId, role });
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

function text(h: Harness, from: string, body: string, now: Date = NOW) {
  return handleInboundSms(h.db, h.transport.inbound(from, body), h.depsAt(now));
}

function inserts(fake: FakeDb, table: unknown) {
  return fake.writes.filter((w) => w.op === 'insert' && w.table === table).map((w) => w.payload);
}

function auditActions(fake: FakeDb): string[] {
  return inserts(fake, schema.auditLog).map((p) => p.actionTaken as string);
}

/** The token as the parent was actually handed it, off the wire. */
function mintedCode(transport: FakeTransport): string {
  const match = transport.bodies().join(' ').match(/join-[0-9a-f]{32}/);
  if (!match) throw new Error(`no join link was texted: ${transport.bodies().join(' | ')}`);
  return match[0];
}

/** The body the /text page pre-writes for a forwarded link (apps/site buildSmsBody). */
function arrival(code: string): string {
  return `Hi (via ${code})`;
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

function insideOneTransaction(h: Harness, indices: number[]): boolean {
  return h.windows.some(([start, end]) => indices.every((i) => i >= start && i < end));
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});
afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
});

describe('minting the link · "add my partner", no number', () => {
  it('hands the parent one forwardable message carrying the /text link', async () => {
    const h = harness();
    await seedFamily(h.fake);

    const minted = await text(h, PARENT_PHONE, 'add my partner');

    expect(minted).toEqual({ status: 'join_link_minted' });
    expect(h.transport.sent).toHaveLength(1);
    expect(h.transport.sent[0]?.to).toBe(PARENT_PHONE);
    const body = h.transport.sent[0]?.body as string;
    expect(body).toContain(`https://www.villagehale.com/text?s=${mintedCode(h.transport)}`);
    // Nobody but the parent has been texted: the whole point of a forwardable link is
    // that Hale never contacts a number a parent typed (CASL).
    expect(h.transport.sent.every((s) => s.to === PARENT_PHONE)).toBe(true);
    // The parent's own thread holds what Hale said, or C1 answers "did they get it?"
    // having never seen the offer (channel/thread.ts).
    expect(h.threaded.at(-1)?.body).toBe(body);
  });

  it('stores only the DIGEST of the token, single-use and 7-day bounded', async () => {
    const h = harness();
    const { familyId, parentUserId } = await seedFamily(h.fake);
    await text(h, PARENT_PHONE, 'add my partner');
    const code = mintedCode(h.transport);

    const rows = inserts(h.fake, schema.joinInvites);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      familyId,
      invitedByUserId: parentUserId,
      role: 'co_parent',
      tokenHash: joinTokenHash(code),
      expiresAt: new Date(NOW.getTime() + JOIN_LINK_TTL_MS),
      consumedAt: null,
    });
    // Rule #1: a read of this table can never reconstruct a usable link.
    expect(JSON.stringify(rows)).not.toContain(code.replace('join-', ''));
  });

  it("records the parent's own words as the authorisation for full family access", async () => {
    const h = harness();
    const { familyId, parentUserId } = await seedFamily(h.fake);

    await text(h, PARENT_PHONE, 'add my partner');

    const grants = inserts(h.fake, schema.consentRecords).filter(
      (r) => r.consentType === 'co_parent_access_grant',
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      userId: parentUserId,
      familyId,
      granted: true,
      consentScope: 'family_role:co_parent',
    });
    expect((grants[0]?.evidence as Record<string, unknown>).verbatimReply).toBe(
      'add my partner',
    );
    expect(auditActions(h.fake)).toContain('co_parent_join_link_minted');

    // The instruction that started it is ledgered verbatim; nothing Hale wrote is.
    const messages = inserts(h.fake, schema.channelMessages);
    expect(messages.filter((m) => m.direction === 'in').map((m) => m.body)).toEqual([
      'add my partner',
    ]);
    expect(messages.filter((m) => m.direction === 'out').every((m) => m.body === null)).toBe(
      true,
    );
  });

  it('refuses to mint a link for a member who is not a parent', async () => {
    const h = harness();
    // `extended` is the legacy bucket the scope matrix gives NOTHING to, and it is
    // neither a caregiver role nor a parent one — so it reaches the mint gate rather
    // than being turned away by the scoped-reply branch above it. A co_parent seat is
    // the whole family surface; handing one out belongs to parents alone.
    await seedFamily(h.fake, 'extended');

    const asked = await text(h, PARENT_PHONE, 'add my partner');

    expect(asked).not.toEqual({ status: 'join_link_minted' });
    expect(inserts(h.fake, schema.joinInvites)).toHaveLength(0);
    expect(h.transport.bodies().join(' ')).not.toMatch(/join-[0-9a-f]{32}/);
    expect(auditActions(h.fake)).not.toContain('co_parent_join_link_minted');
  });
});

describe('redeeming the link · the partner texts from their own phone', () => {
  it('attaches them to the EXISTING family instead of minting a new one', async () => {
    const h = harness();
    const { familyId, parentUserId } = await seedFamily(h.fake);
    await text(h, PARENT_PHONE, 'add my partner');
    const code = mintedCode(h.transport);

    const joined = await text(h, PARTNER_PHONE, arrival(code));

    expect(joined).toEqual({
      status: 'join_link_accepted',
      familyId,
      inviterNotified: true,
      supersededSessionId: null,
      supersededInviteId: null,
    });
    // No second household, and no intake conversation: the diversion happens BEFORE the
    // session is created, so nobody is asked for their children's ages.
    expect(inserts(h.fake, schema.families)).toHaveLength(1);
    expect(inserts(h.fake, schema.smsIntakeSessions)).toHaveLength(0);

    const member = inserts(h.fake, schema.familyMembers).find((r) => r.role === 'co_parent');
    expect(member).toMatchObject({ familyId, invitedByUserId: parentUserId });

    const channel = inserts(h.fake, schema.parentChannels).at(-1);
    expect(channel).toMatchObject({
      familyId,
      userId: member?.userId,
      phoneE164Hash: phoneBlindIndex(PARTNER_PHONE),
      // Verified by origination: the redemption arrived FROM the number, so an OTP
      // would be asking someone to prove they hold the phone they are texting from.
      verifiedAt: NOW,
    });

    const consent = inserts(h.fake, schema.consentRecords).filter(
      (r) => r.consentType === 'sms_service_messages',
    );
    expect(consent).toHaveLength(1);
    expect(consent[0]).toMatchObject({
      userId: member?.userId,
      familyId,
      granted: true,
      consentScope: 'sms_join_origination',
    });
    // Their OWN consent, from their OWN number — not inherited from the parent's grant.
    expect(consent[0]?.userId).not.toBe(parentUserId);

    const invite = h.fake.rows(schema.joinInvites)[0];
    expect(invite?.consumedAt).toEqual(NOW);
    expect(invite?.consumedByUserId).toBe(member?.userId);

    expect(auditActions(h.fake)).toEqual(
      expect.arrayContaining([
        'co_parent_join_link_minted',
        'co_parent_join_accepted',
        'channel_sms_enrolled',
      ]),
    );
  });

  it('writes the identity, the consent, the channel and the membership in ONE transaction', async () => {
    const h = harness();
    await seedFamily(h.fake);
    await text(h, PARENT_PHONE, 'add my partner');
    const code = mintedCode(h.transport);

    await text(h, PARTNER_PHONE, arrival(code));

    const partnerHash = phoneBlindIndex(PARTNER_PHONE);
    const indices = [
      writeIndex(h.fake, schema.users, 'insert', (p) => p.externalAuthId === `sms:${partnerHash}`),
      writeIndex(
        h.fake,
        schema.consentRecords,
        'insert',
        (p) => p.consentType === 'sms_service_messages',
      ),
      writeIndex(h.fake, schema.parentChannels, 'insert', (p) => p.phoneE164Hash === partnerHash),
      writeIndex(h.fake, schema.familyMembers, 'insert', (p) => p.role === 'co_parent'),
      // The BURN, not the mint's insert: the token is spent in the same transaction
      // that seats the co-parent, or a crash between them leaves a live link on a seat
      // that already exists.
      writeIndex(h.fake, schema.joinInvites, 'update'),
    ];
    expect(indices.every((i) => i >= 0)).toBe(true);
    // There is no state in which a co-parent is a member of a family without the
    // consent row saying they agreed to be.
    expect(insideOneTransaction(h, indices)).toBe(true);
  });

  it('tells the partner who added them, what they now share, and that STOP works', async () => {
    const h = harness();
    const { familyId } = await seedFamily(h.fake);
    await text(h, PARENT_PHONE, 'add my partner');
    const code = mintedCode(h.transport);

    await text(h, PARTNER_PHONE, arrival(code));

    const welcome = h.transport.sent.find((s) => s.to === PARTNER_PHONE);
    expect(welcome?.body).toContain('Ana');
    expect(welcome?.body).toMatch(/co-parent/i);
    expect(welcome?.body).toContain('Reply STOP anytime');
    // Their first Hale message has to be in THEIR OWN thread, or C1 answers their reply
    // with nothing above it.
    const member = inserts(h.fake, schema.familyMembers).find((r) => r.role === 'co_parent');
    expect(h.threaded).toContainEqual({
      familyId,
      parentUserId: member?.userId as string,
      body: welcome?.body as string,
    });
  });

  it('tells the inviting parent, in their own thread, that their partner is in', async () => {
    const h = harness();
    const { familyId, parentUserId } = await seedFamily(h.fake);
    await text(h, PARENT_PHONE, 'add my partner');
    const code = mintedCode(h.transport);
    const before = h.transport.sent.length;

    await text(h, PARTNER_PHONE, arrival(code));

    const toParent = h.transport.sent.slice(before).filter((s) => s.to === PARENT_PHONE);
    expect(toParent).toHaveLength(1);
    expect(toParent[0]?.body).toMatch(/in/i);
    expect(h.threaded).toContainEqual({
      familyId,
      parentUserId,
      body: toParent[0]?.body as string,
    });
  });
});

describe('a link that is no longer good · never an error to the person holding it', () => {
  it('gives a SECOND redeemer the ordinary greeting — the token is single-use', async () => {
    const h = harness();
    await seedFamily(h.fake);
    await text(h, PARENT_PHONE, 'add my partner');
    const code = mintedCode(h.transport);
    await text(h, PARTNER_PHONE, arrival(code));
    const before = h.transport.sent.length;

    const second = await text(h, BYSTANDER_PHONE, arrival(code));

    expect(second).toEqual({ status: 'greeted' });
    expect(h.transport.sent.slice(before).map((s) => s.body)).toEqual([greeting(null, 'en')]);
    // Exactly one co-parent was ever created.
    expect(inserts(h.fake, schema.familyMembers).filter((r) => r.role === 'co_parent')).toHaveLength(
      1,
    );
    expect(
      inserts(h.fake, schema.parentChannels).filter(
        (r) => r.phoneE164Hash === phoneBlindIndex(BYSTANDER_PHONE),
      ),
    ).toHaveLength(0);
  });

  it('gives a link redeemed on day 8 the ordinary greeting', async () => {
    const h = harness();
    await seedFamily(h.fake);
    await text(h, PARENT_PHONE, 'add my partner');
    const code = mintedCode(h.transport);
    const eightDaysOn = new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000);

    const late = await text(h, PARTNER_PHONE, arrival(code), eightDaysOn);

    expect(late).toEqual({ status: 'greeted' });
    expect(h.transport.sent.at(-1)?.body).toBe(greeting(null, 'en'));
    expect(inserts(h.fake, schema.familyMembers).filter((r) => r.role === 'co_parent')).toHaveLength(
      0,
    );
  });

  it('drops an unknown token rather than storing a capability string on the session', async () => {
    const h = harness();

    const stranger = await text(
      h,
      PARTNER_PHONE,
      arrival('join-deadbeefdeadbeefdeadbeefdeadbeef'),
    );

    expect(stranger).toEqual({ status: 'greeted' });
    expect(h.transport.sent.at(-1)?.body).toBe(greeting(null, 'en'));
    // The tag is dropped, not recorded: a source code rides on into the consent
    // evidence and the provisioning audit row, and a live-looking capability token has
    // no business in either.
    expect(inserts(h.fake, schema.smsIntakeSessions)[0]?.sourceCode).toBeNull();
  });
});
describe('a live link outranks whatever conversation is already open', () => {
  it('redeems for a partner who said hello first, and closes the session it supersedes', async () => {
    const h = harness();
    const { familyId } = await seedFamily(h.fake);
    await text(h, PARENT_PHONE, 'add my partner');
    const code = mintedCode(h.transport);
    // The partner texts before they tap the link — or taps a link that was already
    // spent — and an intake session opens on their number.
    expect(await text(h, PARTNER_PHONE, 'Hello')).toEqual({ status: 'greeted' });
    const session = h.fake.rows(schema.smsIntakeSessions).at(-1);

    const joined = await text(h, PARTNER_PHONE, arrival(code));

    expect(joined).toEqual({
      status: 'join_link_accepted',
      familyId,
      inviterNotified: true,
      supersededSessionId: session?.id,
      // No caregiver invite was in flight on this number, and the outcome SAYS so
      // rather than leaving it to be inferred.
      supersededInviteId: null,
    });
    // Seated in the household that already exists, not asked for their children's ages.
    expect(
      inserts(h.fake, schema.familyMembers).filter((r) => r.role === 'co_parent'),
    ).toHaveLength(1);
    expect(inserts(h.fake, schema.families)).toHaveLength(1);
    // The conversation the link interrupted is CLOSED, or it shadows their next text
    // exactly as it shadowed this one.
    expect(session?.closedAt).toEqual(NOW);
  });
});

describe('a live link outranks an OPEN CAREGIVER INVITE on the same number', () => {
  it('closes the invite as it seats them, so their next text is an ordinary turn', async () => {
    const h = harness();
    await seedFamily(h.fake);
    // The same number is in both flows at once — a household described it as a sitter
    // and Hale texted it the invite, and it is also the number the forwarded co-parent
    // link reaches. Nothing prevents that: the invite is opened while the number still
    // has no channel, which is exactly the state a redemption walks into.
    await text(h, PARENT_PHONE, 'add Sam 647-555-0199 as babysitter');
    await text(h, PARENT_PHONE, 'yes');
    expect(h.fake.rows(schema.caregiverInvites)[0]?.state).toBe('awaiting_caregiver_reply');

    await text(h, PARENT_PHONE, 'add my partner');
    const code = mintedCode(h.transport);
    const joined = await text(h, PARTNER_PHONE, arrival(code));

    // Closed by the turn that seated them, and closed as what it WAS: a question
    // overtaken by a bigger answer, not a refusal by the person holding the phone.
    const invite = h.fake.rows(schema.caregiverInvites)[0];
    expect(invite).toMatchObject({ state: 'superseded_by_join', closedAt: NOW });
    expect(auditActions(h.fake)).toContain('caregiver_invite_superseded_by_join');
    expect(auditActions(h.fake)).not.toContain('caregiver_invite_refused');
    expect(joined).toMatchObject({
      status: 'join_link_accepted',
      supersededInviteId: invite?.id,
    });

    // So their next ordinary message is a KNOWN-NUMBER turn. Left armed, the invite
    // outranks the channel they were just given and re-asks its question at them
    // forever, and the conversation belongs to a role they already left behind.
    const before = h.transport.sent.length;
    const next = await text(h, PARTNER_PHONE, "what's on this week?");
    expect(next).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    expect(h.transport.sent.slice(before)).toHaveLength(0);

    // And their "yes" can never mint a SECOND active row on this number —
    // parent_channels_phone_hash_active_idx would refuse it, taking the whole webhook
    // down with it and leaving the carrier to re-deliver the inbound.
    const yes = await text(h, PARTNER_PHONE, 'yes');
    expect(yes).toEqual({ status: 'ignored', reason: 'no_open_conversation' });
    expect(
      inserts(h.fake, schema.parentChannels).filter(
        (r) => r.phoneE164Hash === phoneBlindIndex(PARTNER_PHONE),
      ),
    ).toHaveLength(1);
  });
});

describe('two people redeem the same link at once', () => {
  it('seats exactly ONE co-parent and hands the loser the ordinary greeting', async () => {
    const h = harness();
    await seedFamily(h.fake);
    await text(h, PARENT_PHONE, 'add my partner');
    const code = mintedCode(h.transport);

    // The forward went to a group thread: two phones open it in the same second, so
    // both read the invite as open before either has spent it.
    const [first, second] = await Promise.all([
      text(h, PARTNER_PHONE, arrival(code)),
      text(h, BYSTANDER_PHONE, arrival(code)),
    ]);

    const statuses = [first?.status, second?.status].sort();
    expect(statuses).toEqual(['greeted', 'join_link_accepted']);
    expect(
      inserts(h.fake, schema.familyMembers).filter((r) => r.role === 'co_parent'),
    ).toHaveLength(1);
    const redeemerHashes = [PARTNER_PHONE, BYSTANDER_PHONE].map(phoneBlindIndex);
    expect(
      inserts(h.fake, schema.parentChannels).filter((r) =>
        redeemerHashes.includes(r.phoneE164Hash as string),
      ),
    ).toHaveLength(1);
    // One seat, one consent row: the loser wrote nothing at all.
    expect(
      inserts(h.fake, schema.consentRecords).filter(
        (r) => r.consentScope === 'sms_join_origination',
      ),
    ).toHaveLength(1);
  });
});
