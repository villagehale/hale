import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadOpenInviteByPhone,
  loadPendingAssent,
  recordCoParentAssent,
  recordParentAssent,
  startCaregiverInvite,
  startCoParentInvite,
} from '~/lib/channel/caregiver/invites';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import { type Inbound, type IntakeDeps, handleInboundSms } from '~/lib/channel/intake/machine';
import { scriptedFriendVoice } from '~/lib/channel/intake/scripted-friend-voice.fixture';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { type SpokenLineRequest, setSharedSpokenLineWriter } from '~/lib/channel/spoken-line';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { askWriter, yesNoReader } from '~/lib/testing/consent-double';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { scriptedSpokenLineWriter } from '~/lib/testing/spoken-line.fixture';

/**
 * The join and invite doors through the real machine and a real database.
 *
 * With the door flag on, the line an answer earns is a model write inside Linq's webhook
 * window, so Linq can resend the same provider id while it runs. By then the invite is
 * closed, and an unclaimed resend finds no invite and greets the person who just answered.
 * The writer here is the scripted one, wrapped only to deliver the resend mid-write.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
/** 12:00 in Toronto: outside every quiet window. */
const NOON = new Date('2026-07-30T16:00:00.000Z');

let db: TestDb;
let PARENT: string;
let INVITEE: string;
let serial = 300;

const nextSerial = () => {
  serial += 1;
  return serial;
};
const nextNumber = (area: string) => `+1${area}555${String(nextSerial()).padStart(4, '0')}`;

function intakeDeps(transport: FakeTransport): IntakeDeps {
  return {
    transport,
    threadMessage: async () => 'conv-1',
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([{ intent: 'assent', verbatim: 'x', interpretation: 'x' }]),
    radar: fakeRadar,
    answerComposer: fakeSilentAnswerComposer,
    openQuestions: fakeNoOpenQuestions,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => NOON.getTime()),
    consent: yesNoReader(),
    consentAsk: askWriter(),
    friendVoice: scriptedFriendVoice,
    now: NOON,
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

async function caregiverInviteAwaiting(familyId: string, parentUserId: string): Promise<void> {
  const started = await startCaregiverInvite(db.database, {
    familyId,
    invitedByUserId: parentUserId,
    inviterPhoneE164: PARENT,
    parsed: { ok: true, name: 'grandma', phoneE164: INVITEE, role: 'grandparent' },
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
}

async function coParentInviteAwaiting(familyId: string, parentUserId: string): Promise<void> {
  const started = await startCoParentInvite(db.database, {
    familyId,
    invitedByUserId: parentUserId,
    inviterPhoneE164: PARENT,
    inviterName: 'Test Parent',
    parsed: { ok: true, name: 'Sam', phoneE164: INVITEE, role: 'co_parent' },
    language: 'en',
    now: NOON,
    ask: askWriter(),
  });
  if (started.status !== 'started') throw new Error(`invite not started: ${started.status}`);
  const pending = await loadPendingAssent(db.database, parentUserId, NOON);
  if (pending?.role !== 'co_parent') throw new Error('no pending co-parent assent');
  await recordCoParentAssent(db.database, {
    invite: pending,
    inviterName: 'Test Parent',
    language: 'en',
    verbatimReply: 'yes',
    channelMessageId: null,
    now: NOON,
    ask: askWriter(),
  });
}

const sessionsFor = (phone: string) =>
  db.database
    .select({ id: schema.smsIntakeSessions.id })
    .from(schema.smsIntakeSessions)
    .where(eq(schema.smsIntakeSessions.phoneHash, phoneBlindIndex(phone)));

const claimsFor = (providerMessageId: string) =>
  db.database
    .select({ completedAt: schema.smsIntakeTurnClaims.completedAt })
    .from(schema.smsIntakeTurnClaims)
    .where(eq(schema.smsIntakeTurnClaims.providerMessageId, providerMessageId));

const joinInvites = (familyId: string) =>
  db.database
    .select({ id: schema.joinInvites.id })
    .from(schema.joinInvites)
    .where(eq(schema.joinInvites.familyId, familyId));

const joinInboundAudit = (familyId: string) =>
  db.database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'join_sms_inbound'),
      ),
    );

const inboundAt = (from: string, body: string, extra: Partial<Inbound> = {}): Inbound => ({
  from,
  body,
  providerId: `door-resend-${nextSerial()}`,
  receivedAt: NOON,
  ...extra,
});

beforeAll(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  PARENT = nextNumber('416');
  INVITEE = nextNumber('647');
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', 'true');
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  setSharedSpokenLineWriter(scriptedSpokenLineWriter);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ANSWERS = [
  {
    who: "a caregiver's no",
    seedInvite: caregiverInviteAwaiting,
    text: 'no thanks',
    answered: 'caregiver_declined',
    lineBeingWritten: 'caregiver_decline_ack',
  },
  {
    who: "a caregiver's yes",
    seedInvite: caregiverInviteAwaiting,
    text: 'yes',
    answered: 'caregiver_accepted',
    lineBeingWritten: 'caregiver_welcome',
  },
  {
    who: "a co-parent's no",
    seedInvite: coParentInviteAwaiting,
    text: 'no thanks',
    answered: 'co_parent_declined',
    lineBeingWritten: 'coparent_decline_ack',
  },
  {
    who: "a co-parent's yes",
    seedInvite: coParentInviteAwaiting,
    text: 'yes',
    answered: 'co_parent_accepted',
    lineBeingWritten: 'coparent_welcome',
  },
] as const;

describe('an answer at the invite door is one turn', () => {
  it.each(ANSWERS)(
    'control: $who delivered once sends one text to them and opens no session',
    async (lane) => {
      const { familyId, parentUserId } = await seedFamily(db.database, 'Once Family');
      await enrol(familyId, parentUserId, PARENT);
      await lane.seedInvite(familyId, parentUserId);
      const transport = new FakeTransport();

      const outcome = await handleInboundSms(
        db.database,
        inboundAt(INVITEE, lane.text),
        intakeDeps(transport),
      );

      expect(outcome.status).toBe(lane.answered);
      expect(transport.sent.filter((text) => text.to === INVITEE)).toHaveLength(1);
      expect(await sessionsFor(INVITEE)).toEqual([]);
    },
    30_000,
  );

  it.each(ANSWERS)(
    '$who, resent while its line is written: duplicate, one text, no session',
    async (lane) => {
      const { familyId, parentUserId } = await seedFamily(db.database, 'Resend Family');
      await enrol(familyId, parentUserId, PARENT);
      await lane.seedInvite(familyId, parentUserId);
      const transport = new FakeTransport();
      const delivery = inboundAt(INVITEE, lane.text);
      let resent: { status: string } | undefined;
      setSharedSpokenLineWriter({
        async write(request: SpokenLineRequest) {
          if (request.purpose === lane.lineBeingWritten && !resent) {
            resent = await handleInboundSms(db.database, delivery, intakeDeps(transport)).catch(
              (err: unknown) => ({ status: `threw: ${err instanceof Error ? err.message : err}` }),
            );
          }
          return scriptedSpokenLineWriter.write(request);
        },
      });

      const first = await handleInboundSms(db.database, delivery, intakeDeps(transport));
      const afterwards = await handleInboundSms(db.database, delivery, intakeDeps(transport)).catch(
        (err: unknown) => ({ status: `threw: ${err instanceof Error ? err.message : err}` }),
      );

      expect(first.status).toBe(lane.answered);
      expect(resent?.status).toBe('duplicate');
      expect(afterwards.status).toBe('duplicate');
      expect(transport.sent.filter((text) => text.to === INVITEE)).toHaveLength(1);
      expect(await sessionsFor(INVITEE)).toEqual([]);
    },
    30_000,
  );

  it('dark: the answer takes no claim, so a flag-off turn runs as it does today', async () => {
    vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', '');
    const { familyId, parentUserId } = await seedFamily(db.database, 'Dark Answer Family');
    await enrol(familyId, parentUserId, PARENT);
    await caregiverInviteAwaiting(familyId, parentUserId);
    const transport = new FakeTransport();
    const delivery = inboundAt(INVITEE, 'no thanks');

    const outcome = await handleInboundSms(db.database, delivery, intakeDeps(transport));

    expect(outcome).toEqual({ status: 'caregiver_declined', lineHeld: 'flag_off' });
    expect(transport.sent).toEqual([]);
    expect(await claimsFor(delivery.providerId)).toEqual([]);
  }, 30_000);

  it('lit: the same answer leaves its claim, stamped complete', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Lit Answer Family');
    await enrol(familyId, parentUserId, PARENT);
    await caregiverInviteAwaiting(familyId, parentUserId);
    const transport = new FakeTransport();
    const delivery = inboundAt(INVITEE, 'no thanks');

    await handleInboundSms(db.database, delivery, intakeDeps(transport));

    expect(await claimsFor(delivery.providerId)).toEqual([{ completedAt: NOON }]);
  }, 30_000);

  it('control: a different text from the same person is its own turn', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Second Answer Family');
    await enrol(familyId, parentUserId, PARENT);
    await caregiverInviteAwaiting(familyId, parentUserId);
    const transport = new FakeTransport();

    const unreadable = await handleInboundSms(
      db.database,
      inboundAt(INVITEE, 'who is this?'),
      intakeDeps(transport),
    );
    const realAnswer = await handleInboundSms(
      db.database,
      inboundAt(INVITEE, 'yes'),
      intakeDeps(transport),
    );

    expect(unreadable.status).toBe('caregiver_prompted');
    expect(realAnswer.status).toBe('caregiver_accepted');
    expect(await loadOpenInviteByPhone(db.database, INVITEE, NOON)).toBeNull();
  }, 30_000);
});

const FLAG_STATES = [
  {
    flag: 'on',
    value: 'true',
    oneToOne: { status: 'join_link_minted' },
    linkSent: 1,
  },
  {
    flag: 'off',
    value: '',
    oneToOne: { status: 'join_link_held', lineHeld: 'flag_off' },
    linkSent: 0,
  },
] as const;

describe.each(FLAG_STATES)('a join request, door flag $flag', (state) => {
  beforeEach(() => {
    vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', state.value);
  });

  const asks: Array<{ who: string; pipe: Partial<Inbound> }> = [
    { who: 'a Linq group', pipe: { transport: 'imessage', chatId: 'chat-family', isGroup: true } },
    {
      who: 'a chat Linq did not call a 1:1',
      pipe: { transport: 'imessage', chatId: 'chat-unsaid' },
    },
  ];

  it.each(asks)(
    '$who: no link exists, nothing is sent or written, and the ask is on the ledger',
    async ({ pipe }) => {
      const { familyId, parentUserId } = await seedFamily(db.database, 'Group Ask Family');
      await enrol(familyId, parentUserId, PARENT);
      const writes: SpokenLineRequest[] = [];
      setSharedSpokenLineWriter({
        async write(request: SpokenLineRequest) {
          writes.push(request);
          return scriptedSpokenLineWriter.write(request);
        },
      });
      const transport = new FakeTransport();

      const outcome = await handleInboundSms(
        db.database,
        inboundAt(PARENT, 'add my partner', pipe),
        intakeDeps(transport),
      );

      expect(outcome).toEqual({ status: 'join_link_held', lineHeld: 'group_chat' });
      expect(await joinInvites(familyId)).toEqual([]);
      expect(transport.sent).toEqual([]);
      expect(writes).toEqual([]);
      expect(await joinInboundAudit(familyId)).toHaveLength(1);
    },
    30_000,
  );

  it('control: the same ask in the parent 1:1 follows the flag', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Direct Ask Family');
    await enrol(familyId, parentUserId, PARENT);
    const transport = new FakeTransport();

    const outcome = await handleInboundSms(
      db.database,
      inboundAt(PARENT, 'add my partner', {
        transport: 'imessage',
        chatId: 'chat-direct',
        isGroup: false,
      }),
      intakeDeps(transport),
    );

    expect(outcome).toEqual(state.oneToOne);
    expect(await joinInvites(familyId)).toHaveLength(state.linkSent);
    expect(transport.sent).toHaveLength(state.linkSent);
    if (state.linkSent === 1) {
      expect(transport.sent[0]?.to).toBe(PARENT);
      expect(transport.sent[0]?.body).toMatch(/join-[0-9a-f]{32}/);
    }
  }, 30_000);
});
