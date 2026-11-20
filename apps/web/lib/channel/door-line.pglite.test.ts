import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadOpenInviteByPhone,
  recordParentAssent,
  startCaregiverInvite,
} from '~/lib/channel/caregiver/invites';
import {
  type CaregiverDeps,
  handleInviteReply,
  handleKnownNumberInbound,
} from '~/lib/channel/caregiver/route';
import { fakeNoOpenQuestions } from '~/lib/channel/intake/fakes';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { mintJoinInvite } from '~/lib/channel/join/invites';
import { type JoinDeps, handleJoinArrival, handleJoinRequest } from '~/lib/channel/join/route';
import {
  type SpokenLineRequest,
  type SpokenLineWriter,
  createSpokenLineWriter,
  setSharedSpokenLineWriter,
} from '~/lib/channel/spoken-line';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { failurePageOpsPager } from '~/lib/monitoring/failure-page';
import { askWriter, yesNoReader } from '~/lib/testing/consent-double';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { scriptedSpokenLineWriter } from '~/lib/testing/spoken-line.fixture';

/**
 * VIL-706 · the join and caregiver doors against a real database.
 *
 * The routes run whole: rows, transactions, the ledger, and the #ops claim. The writer is
 * either the repo's scripted spoken-line writer wrapped to record each request (request
 * mechanics only: which line was asked for, with which facts and addendum), or the REAL
 * writer with a client that throws, which is failure injection at the client port: the
 * real writer retries on the smaller lane, holds the line, and pages through the real
 * ops pager. No model output is stood in for in the failure cases.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const FLAG = 'JOIN_DOOR_MODEL_COPY_ENABLED';
/** 12:00 in Toronto: outside every quiet window. */
const NOON = new Date('2026-07-30T16:00:00.000Z');

let db: TestDb;
let posted: string[];
/** Fresh numbers for every case: the database is shared, and a number Hale has already
 * invited or seated is a different door. */
let PARENT: string;
let PARTNER: string;
let GRAN: string;
let numbered = 100;
function nextSerial(): number {
  numbered += 1;
  return numbered;
}
function nextNumber(area: string): string {
  return `+1${area}555${String(nextSerial()).padStart(4, '0')}`;
}
/** An inbound with a provider id no earlier case used: the ledger keeps them unique. */
function inbound(transport: FakeTransport, from: string, body: string) {
  return transport.inbound(from, body, { providerId: `door-in-${nextSerial()}` });
}

const post = async (text: string) => {
  posted.push(text);
  return 'sent' as const;
};

const downClient = (): AgentClient => {
  throw new Error('provider down');
};

function recordingWriter(): { writer: SpokenLineWriter; calls: SpokenLineRequest[] } {
  const calls: SpokenLineRequest[] = [];
  return {
    calls,
    writer: {
      async write(request) {
        calls.push(request);
        return scriptedSpokenLineWriter.write(request);
      },
    },
  };
}

function downedWriter(): SpokenLineWriter {
  return createSpokenLineWriter(
    downClient,
    failurePageOpsPager(() => db.database, { post, now: NOON }),
  );
}

const threadMessage = (async () => undefined) as unknown as JoinDeps['threadMessage'];

function joinDeps(transport: FakeTransport): JoinDeps {
  return { transport, threadMessage };
}

function caregiverDeps(transport: FakeTransport): CaregiverDeps {
  return {
    transport,
    threadMessage,
    openQuestions: fakeNoOpenQuestions,
    consent: yesNoReader(),
    ask: askWriter(),
  };
}

async function enrol(familyId: string, userId: string, phone: string): Promise<void> {
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOON,
  });
}

/** A caregiver invite the parent said yes to: grandma's number is waiting on her answer. */
async function inviteAwaitingGran(familyId: string, parentUserId: string) {
  const started = await startCaregiverInvite(db.database, {
    familyId,
    invitedByUserId: parentUserId,
    inviterPhoneE164: PARENT,
    parsed: { ok: true, name: 'grandma', phoneE164: GRAN, role: 'grandparent' },
    now: NOON,
    ask: askWriter(),
  });
  if (started.status !== 'started') throw new Error(`invite not started: ${started.status}`);
  const assent = await recordParentAssent(db.database, {
    invite: started.invite,
    inviterName: 'Test Parent',
    verbatimReply: 'yes',
    channelMessageId: null,
    now: NOON,
    ask: askWriter(),
  });
  if (assent.status !== 'ready') throw new Error(`invite not ready: ${assent.status}`);
  const invite = await loadOpenInviteByPhone(db.database, GRAN, NOON);
  if (!invite) throw new Error('no open invite for grandma');
  return invite;
}

beforeAll(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  posted = [];
  PARENT = nextNumber('416');
  PARTNER = nextNumber('647');
  GRAN = nextNumber('647');
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv(FLAG, 'true');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  // One #ops claim per site per hour: each case starts with none.
  await db.database.delete(schema.rateLimits);
});

afterEach(() => {
  setSharedSpokenLineWriter(scriptedSpokenLineWriter);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the join door', () => {
  it('asks the writer for the forward line with the link verbatim, and sends what it wrote', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Alder Family');
    const { writer, calls } = recordingWriter();
    setSharedSpokenLineWriter(writer);
    const transport = new FakeTransport();

    const outcome = await handleJoinRequest(
      db.database,
      {
        owner: { userId: parentUserId, familyId },
        phoneE164: PARENT,
        inbound: inbound(transport, PARENT, 'add my partner'),
        now: NOON,
      },
      joinDeps(transport),
    );

    expect(outcome).toEqual({ status: 'join_link_minted', lineHeld: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: 'join_invite_forward', addendum: 'door-line' });
    const link = calls[0]?.verbatim?.[0] ?? '';
    expect(link).toContain('join-');
    expect(calls[0]?.facts).toEqual({ link });
    expect(transport.sent).toEqual([{ to: PARENT, body: expect.stringContaining(link) }]);
    expect(posted).toEqual([]);
  }, 30_000);

  it('holds the forward line when the model writes nothing: nothing sent, named, one page', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Birch Family');
    setSharedSpokenLineWriter(downedWriter());
    const transport = new FakeTransport();

    const outcome = await handleJoinRequest(
      db.database,
      {
        owner: { userId: parentUserId, familyId },
        phoneE164: PARENT,
        inbound: inbound(transport, PARENT, 'add my partner'),
        now: NOON,
      },
      joinDeps(transport),
    );

    expect(outcome).toEqual({ status: 'join_link_minted', lineHeld: 'unwritten' });
    expect(transport.sent).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('site spoken_line_unwritten.');
    // The link itself was minted: the parent's request stands, only the words are held.
    const invites = await db.database
      .select({ id: schema.joinInvites.id })
      .from(schema.joinInvites)
      .where(eq(schema.joinInvites.familyId, familyId));
    expect(invites).toHaveLength(1);
  }, 30_000);

  it('dark: no writer call, nothing sent, and the outcome says flag_off', async () => {
    vi.stubEnv(FLAG, '');
    const { familyId, parentUserId } = await seedFamily(db.database, 'Cedar Family');
    const { writer, calls } = recordingWriter();
    setSharedSpokenLineWriter(writer);
    const transport = new FakeTransport();

    const outcome = await handleJoinRequest(
      db.database,
      {
        owner: { userId: parentUserId, familyId },
        phoneE164: PARENT,
        inbound: inbound(transport, PARENT, 'add my partner'),
        now: NOON,
      },
      joinDeps(transport),
    );

    expect(outcome).toEqual({ status: 'join_link_minted', lineHeld: 'flag_off' });
    expect(calls).toEqual([]);
    expect(transport.sent).toEqual([]);
    expect(posted).toEqual([]);
  }, 30_000);

  it('the partner arrives: the welcome and the inviter ack are written from facts and sent', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Dogwood Family');
    await enrol(familyId, parentUserId, PARENT);
    const { code } = await mintJoinInvite(db.database, {
      familyId,
      invitedByUserId: parentUserId,
      verbatimRequest: 'add my partner',
      channelMessageId: null,
      now: NOON,
    });
    const { writer, calls } = recordingWriter();
    setSharedSpokenLineWriter(writer);
    const transport = new FakeTransport();

    const arrived = await handleJoinArrival(
      db.database,
      { code, phoneE164: PARTNER, inbound: inbound(transport, PARTNER, code), now: NOON },
      joinDeps(transport),
    );

    expect(arrived).toMatchObject({
      status: 'join_link_accepted',
      welcomeHeld: null,
      inviterHeld: null,
      inviterNotified: true,
    });
    expect(calls.map((c) => [c.purpose, c.addendum])).toEqual([
      ['join_welcome', 'door-line'],
      ['join_accepted_ack', 'door-line'],
    ]);
    expect(calls[0]?.facts).toEqual({ inviterName: 'Test Parent' });
    expect(transport.sent.map((s) => s.to)).toEqual([PARTNER, PARENT]);
    expect(posted).toEqual([]);
  }, 30_000);

  it('the partner arrives and the model writes nothing: seated, nothing sent, one page', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Elm Family');
    await enrol(familyId, parentUserId, PARENT);
    const { code } = await mintJoinInvite(db.database, {
      familyId,
      invitedByUserId: parentUserId,
      verbatimRequest: 'add my partner',
      channelMessageId: null,
      now: NOON,
    });
    setSharedSpokenLineWriter(downedWriter());
    const transport = new FakeTransport();

    const arrived = await handleJoinArrival(
      db.database,
      { code, phoneE164: PARTNER, inbound: inbound(transport, PARTNER, code), now: NOON },
      joinDeps(transport),
    );

    expect(arrived).toMatchObject({
      status: 'join_link_accepted',
      welcomeHeld: 'unwritten',
      inviterHeld: 'unwritten',
      inviterNotified: false,
    });
    expect(transport.sent).toEqual([]);
    // Two lines held in the same hour: one page, deduped by the claim.
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('site spoken_line_unwritten.');
    const members = await db.database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.familyId, familyId));
    expect(members.map((m) => m.role).sort()).toEqual(['co_parent', 'primary_parent']);
  }, 30_000);
});

describe('the caregiver door', () => {
  it("grandma's yes: the welcome is written from her role and sent to her", async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Fir Family');
    const invite = await inviteAwaitingGran(familyId, parentUserId);
    const { writer, calls } = recordingWriter();
    setSharedSpokenLineWriter(writer);
    const transport = new FakeTransport();

    const outcome = await handleInviteReply(
      db.database,
      { invite, phoneE164: GRAN, inbound: inbound(transport, GRAN, 'yes'), now: NOON },
      caregiverDeps(transport),
    );

    expect(outcome).toEqual({ status: 'caregiver_accepted', lineHeld: null });
    expect(calls).toEqual([
      expect.objectContaining({
        purpose: 'caregiver_welcome',
        addendum: 'door-line',
        facts: { role: 'grandparent' },
      }),
    ]);
    expect(transport.sent).toEqual([{ to: GRAN, body: expect.any(String) }]);
    expect(posted).toEqual([]);
  }, 30_000);

  it("grandma's yes and the model writes nothing: she is seated, nothing is sent, one page", async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Gum Family');
    const invite = await inviteAwaitingGran(familyId, parentUserId);
    setSharedSpokenLineWriter(downedWriter());
    const transport = new FakeTransport();

    const outcome = await handleInviteReply(
      db.database,
      { invite, phoneE164: GRAN, inbound: inbound(transport, GRAN, 'yes'), now: NOON },
      caregiverDeps(transport),
    );

    expect(outcome).toEqual({ status: 'caregiver_accepted', lineHeld: 'unwritten' });
    expect(transport.sent).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('site spoken_line_unwritten.');
    const members = await db.database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.familyId, familyId));
    expect(members.map((m) => m.role)).toContain('grandparent');
  }, 30_000);

  it("grandma's no: the decline ack is asked for, and nothing about the family is in its facts", async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Hazel Family');
    const invite = await inviteAwaitingGran(familyId, parentUserId);
    const { writer, calls } = recordingWriter();
    setSharedSpokenLineWriter(writer);
    const transport = new FakeTransport();

    const outcome = await handleInviteReply(
      db.database,
      { invite, phoneE164: GRAN, inbound: inbound(transport, GRAN, 'no'), now: NOON },
      caregiverDeps(transport),
    );

    expect(outcome).toEqual({ status: 'caregiver_declined', lineHeld: null });
    expect(calls).toEqual([
      expect.objectContaining({ purpose: 'caregiver_decline_ack', addendum: 'door-line' }),
    ]);
    expect(calls[0]?.facts).toBeUndefined();
    expect(transport.sent).toEqual([{ to: GRAN, body: expect.any(String) }]);
  }, 30_000);

  it('a seated caregiver asking beyond the schedule: the scoped line carries no word of the ask', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Ivy Family');
    const invite = await inviteAwaitingGran(familyId, parentUserId);
    const transport = new FakeTransport();
    await handleInviteReply(
      db.database,
      { invite, phoneE164: GRAN, inbound: inbound(transport, GRAN, 'yes'), now: NOON },
      caregiverDeps(transport),
    );
    const [seat] = await db.database
      .select({ userId: schema.familyMembers.userId })
      .from(schema.familyMembers)
      .where(
        and(
          eq(schema.familyMembers.familyId, familyId),
          eq(schema.familyMembers.role, 'grandparent'),
        ),
      );
    if (!seat) throw new Error('grandma was not seated');
    const { writer, calls } = recordingWriter();
    setSharedSpokenLineWriter(writer);

    const outcome = await handleKnownNumberInbound(
      db.database,
      {
        owner: { userId: seat.userId, familyId },
        phoneE164: GRAN,
        inbound: inbound(transport, GRAN, 'is Mia feeling better after her shots?'),
        now: NOON,
      },
      caregiverDeps(transport),
    );

    expect(outcome).toEqual({ status: 'caregiver_scoped_reply', lineHeld: null });
    expect(calls).toEqual([
      expect.objectContaining({
        purpose: 'caregiver_scoped_reply',
        addendum: 'door-line',
        facts: { parentName: 'Test Parent' },
      }),
    ]);
    expect(JSON.stringify(calls[0])).not.toMatch(/Mia|shots/);
  }, 30_000);
});
