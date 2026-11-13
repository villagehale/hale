import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSharedOptOutReader } from '~/lib/channel/intake/opt-out-reader';
import { FakeIntentReader } from '~/lib/channel/intake/fakes';
import {
  FakeExtractor,
  FakeIdentityAsk,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import { type IntakeDeps, handleInboundSms } from '~/lib/channel/intake/machine';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { assembleFamilyExport } from '~/lib/rights/export';
import { runDeletionSweep } from '~/lib/rights/delete';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { OneToOneSend } from './connect-link-1to1';
import { handleLinqGroupMessage } from './inbound';
import { deliverShared, forgetSharedGroupPresence, takeMultiFamilyTurn } from './multi-family';
import {
  type SantaLineRequest,
  type SecretSantaLineWriter,
  type SecretSantaTurnInput,
  type SecretSantaTurnModel,
  checkCalled,
  setSharedSecretSantaLineWriter,
  sweepSecretSantaRetention,
} from './secret-santa';
import { receiverForGiver } from './secret-santa-pairings';
import {
  releaseHeldDrawsForCustomer,
  runSecretSantaSweep,
  santaQuietNow,
} from './secret-santa-send';
import { fakeSharedGroupComposer } from './shared-group-voice-fake';
import { LinqSendError } from './transport';

/**
 * VIL-686 over the REAL DDL and through the REAL group door (handleLinqGroupMessage), the
 * real sweep and the real intake machine. The model's reading and its lines are SCRIPTED:
 * each test hands the code what a model would return and checks what that can and cannot
 * reach. The real model's reading and writing is evals/run-secret-santa-eval.mjs.
 *
 * The hard gate: a draw is never revealed to anyone but its giver.
 */
const KEY = Buffer.alloc(32, 11).toString('base64');
const CHAT = 'chat-santa-two-families';
const FROM = '+16415550100';
const MEI = '+16415550111';
const KEN = '+16415550112';
const ADA = '+16415550121';
const GUS = '+16415550131';
const GIA = '+16415550132';
const ALL = [MEI, KEN, ADA, GUS, GIA];
const NAMES: Record<string, string> = { [MEI]: 'Mei', [KEN]: 'Ken', [ADA]: 'Ada', [GUS]: 'Gus', [GIA]: 'Gia' };
/** Midday in UTC, which is every seeded user's zone unless a test sets one. */
const NOON = new Date('2026-11-20T17:00:00.000Z');

let db: TestDb;
let clock = NOON;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  clock = NOON;
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_FROM_E164', FROM);
  vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'true');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  setSharedOptOutReader({
    read: async ({ text }) =>
      /stop texting/i.test(text)
        ? { intent: 'stop', confirmation: 'Done, no more texts.', language: null }
        : { intent: 'none', confirmation: '', language: null },
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.env.APP_ENCRYPTION_KEY = KEY;
  setSharedOptOutReader(null);
  setSharedSecretSantaLineWriter(undefined);
  await db.exec(
    'truncate table secret_santa_participants, secret_santa_draws, shared_group_list_items, linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_multi_family_ledger, audit_log, channel_messages, parent_channels, opt_out_held_messages, linq_line_health, sms_intake_sessions, sms_intake_turn_claims, family_members, families, users cascade',
  );
});

// ---------------------------------------------------------------------------------------
// Seeding.

async function family(name: string, scheduledDeletionAt?: Date) {
  const [row] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON', scheduledDeletionAt })
    .returning({ id: schema.families.id });
  return row?.id as string;
}

async function customer(
  phone: string,
  familyId: string,
  role: 'primary_parent' | 'co_parent',
  timezone = 'UTC',
) {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${phone}`, name: NAMES[phone] ?? 'Parent', timezone })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({ familyId, userId, role });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOON,
  });
  return userId;
}

/** Two families (Mei and her co-parent Ken; Ada), two guests (Gus, Gia). */
async function seedChat() {
  const a = await family('Family A');
  const b = await family('Family B');
  const mei = await customer(MEI, a, 'primary_parent');
  const ken = await customer(KEN, a, 'co_parent');
  const ada = await customer(ADA, b, 'primary_parent');
  // Family A's parent joined the chat, so a guest's message has a host ledger.
  await db.database
    .insert(schema.linqMultiFamilyJoins)
    .values({ chatId: CHAT, familyId: a, joinedByUserId: mei, joinedAt: NOON });
  return { a, b, mei, ken, ada };
}

// ---------------------------------------------------------------------------------------
// Scripted model and lines.

type Decision = {
  santaTurn: boolean;
  start: boolean;
  joinSelf: { called: string | null } | null;
  leaveSelf: boolean;
  draw: boolean;
  cancel: boolean;
  language: string | null;
  reply: string | null;
};

const NOT_SANTA: Decision = {
  santaTurn: false,
  start: false,
  joinSelf: null,
  leaveSelf: false,
  draw: false,
  cancel: false,
  language: null,
  reply: null,
};

/** Answers by message text; anything unscripted is not a Secret Santa turn. */
function santaScript(answers: Record<string, Partial<Decision> | (() => unknown)>) {
  const inputs: SecretSantaTurnInput[] = [];
  const model: SecretSantaTurnModel = {
    async decide(input) {
      inputs.push(input);
      const answer = answers[input.text];
      if (typeof answer === 'function') return answer();
      if (!answer) return NOT_SANTA;
      return { ...NOT_SANTA, santaTurn: true, language: 'en', ...answer };
    },
  };
  return { model, inputs };
}

const join = (called: string | null, reply: string | null = null): Partial<Decision> => ({
  joinSelf: { called },
  reply,
});

const SCRIPT: Record<string, Partial<Decision>> = {
  "let's do Secret Santa! I'm Mei": {
    start: true,
    joinSelf: { called: 'Mei' },
    reply: 'Love it. Say you’re in with the name to use.',
  },
  "I'm in, Ken": join('Ken', 'Ken’s in.'),
  'count me in, Ada': join('Ada'),
  'me too, Gus here': join('Gus'),
  "I'm in! Gia": join('Gia'),
  'ok everyone, draw!': { draw: true },
  'count me out': { leaveSelf: true },
  'who did Ben get?': { reply: 'Nope, those stay private!' },
};

function lines(override: Partial<Record<SantaLineRequest['purpose'], string | null>> = {}) {
  const requests: SantaLineRequest[] = [];
  const writer: SecretSantaLineWriter = {
    async write(request) {
      requests.push(request);
      if (request.purpose in override) return override[request.purpose] ?? null;
      const facts = request.facts as Record<string, unknown>;
      switch (request.purpose) {
        case 'giver_draw':
          return `Hi ${facts.giver}! You're the Secret Santa for ${facts.receiver}. Keep it quiet.`;
        case 'group_done':
          return `Drawn! ${facts.participants} of you, each hears privately.`;
        case 'group_refusal':
          return `Not yet (${String(facts.outcome).replace(/_/g, ' ')}).`;
        case 'organizer_note':
          return facts.kind === 'missing'
            ? `Still waiting on ${(facts.waiting as { called: string }[]).map((w) => w.called).join(' and ')}.`
            : 'Someone left after the draw. Want to start over?';
      }
    },
  };
  return { writer, requests };
}

// ---------------------------------------------------------------------------------------
// The door.

function wire() {
  const group: { chatId: string; text: string }[] = [];
  const direct: { to: string; body: string }[] = [];
  let n = 0;
  const oneToOne: OneToOneSend & { fail?: () => never } = {
    text: async ({ to, body }) => {
      if (oneToOne.fail) oneToOne.fail();
      n += 1;
      direct.push({ to, body });
      return { providerMessageId: `dm-${n}`, chatId: `dm-chat-${to.slice(-4)}` };
    },
    link: async () => ({ providerMessageId: 'link' }),
  };
  return {
    group,
    direct,
    oneToOne,
    sendGroupText: async ({ chatId, text }: { chatId: string; text: string }) => {
      n += 1;
      group.push({ chatId, text });
      return { providerMessageId: `g-${n}` };
    },
  };
}

type Wire = ReturnType<typeof wire>;

function deps(
  w: Wire,
  santa: SecretSantaTurnModel,
  writer: SecretSantaLineWriter | null,
  extra: Record<string, unknown> = {},
) {
  return {
    database: db.database,
    intake: () => {
      throw new Error('the group door does not reach intake in these tests');
    },
    enqueue: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    countOutcome: async () => {},
    now: () => clock,
    sendGroupText: w.sendGroupText,
    oneToOne: w.oneToOne,
    sharedGroupVoice: fakeSharedGroupComposer(),
    privateAsideModel: {
      async read() {
        return [];
      },
      async draft() {
        return null;
      },
    },
    secretSantaTurn: santa,
    secretSantaLine: writer,
    ...extra,
  } as never;
}

let seq = 0;
function nextId() {
  seq += 1;
  return `in-${seq}`;
}
async function say(d: never, from: string, text: string, id = nextId()) {
  const res = await handleLinqGroupMessage(d, {
    messageId: id,
    chatId: CHAT,
    senderHandle: from,
    text,
    mediaCount: 0,
    receivedAt: clock,
    otherHandles: ALL.filter((h) => h !== from),
    isGroup: true,
    mentions: [],
  });
  return (await res.json()) as { outcome: string; notice?: string };
}

const draws = () => db.database.select().from(schema.secretSantaDraws);
const participants = () => db.database.select().from(schema.secretSantaParticipants);

async function personId(phone: string) {
  const [row] = await db.database
    .select({ id: schema.linqSharedGroupPeople.id })
    .from(schema.linqSharedGroupPeople)
    .where(eq(schema.linqSharedGroupPeople.phoneE164Hash, phoneBlindIndex(phone)));
  return row?.id as string;
}

async function participantOf(phone: string) {
  const pid = await personId(phone);
  const [row] = await db.database
    .select()
    .from(schema.secretSantaParticipants)
    .where(eq(schema.secretSantaParticipants.personId, pid));
  return row;
}

/** Start, five joins and a draw, through the door. */
async function fiveDrawn(w: Wire = wire(), writer = lines().writer) {
  const s = santaScript(SCRIPT);
  const d = deps(w, s.model, writer);
  await say(d, MEI, "let's do Secret Santa! I'm Mei");
  await say(d, KEN, "I'm in, Ken");
  await say(d, ADA, 'count me in, Ada');
  await say(d, GUS, 'me too, Gus here');
  await say(d, GIA, "I'm in! Gia");
  const drawn = await say(d, MEI, 'ok everyone, draw!');
  return { d, s, w, drawn };
}

/** Test-only: who each giver drew, read through the one module that may. */
async function truePairing(): Promise<Map<string, string>> {
  const rows = await participants();
  const out = new Map<string, string>();
  for (const row of rows) {
    const r = await receiverForGiver(db.database, { drawId: row.drawId, giverParticipantId: row.id });
    if (r !== 'unresolvable') out.set(row.called as string, r.called);
  }
  return out;
}

const sweepPorts = (w: Wire, writer: SecretSantaLineWriter | null) => ({
  writer,
  oneToOne: w.oneToOne,
  deliverGroup: (database: Parameters<typeof deliverShared>[0], input: Parameters<typeof deliverShared>[1]) =>
    deliverShared(database, { ...input, send: w.sendGroupText }),
});

// ---------------------------------------------------------------------------------------

describe('starting and joining, through the group door', () => {
  it('a customer starts one collecting draw; a second start is a no-op', async () => {
    await seedChat();
    const w = wire();
    const s = santaScript(SCRIPT);
    const d = deps(w, s.model, lines().writer);
    const out = await say(d, MEI, "let's do Secret Santa! I'm Mei");
    expect(out).toMatchObject({ outcome: 'secret_santa', notice: 'sent' });
    await say(d, MEI, "let's do Secret Santa! I'm Mei");
    const rows = await draws();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'collecting', organizerPersonId: await personId(MEI) });
    expect((await participants()).map((p) => p.called)).toEqual(['Mei']);
    expect(w.group[0]?.text).toBe('Love it. Say you’re in with the name to use.');
  });

  it("a guest's start writes nothing and hands the turn on", async () => {
    await seedChat();
    const s = santaScript({ 'santa time?': { start: true, joinSelf: { called: null } } });
    const out = await say(deps(wire(), s.model, lines().writer), GUS, 'santa time?');
    // Positive control: the model was asked, and read it as a start.
    expect(s.inputs.map((i) => i.text)).toContain('santa time?');
    expect(out.outcome).not.toBe('secret_santa');
    expect(await draws()).toEqual([]);
  });

  it('a start while the organizer is stopped cancels the old draw and opens a new one', async () => {
    await seedChat();
    const s = santaScript({
      ...SCRIPT,
      'new santa please, Ada': { start: true, joinSelf: { called: 'Ada' } },
    });
    const d = deps(wire(), s.model, lines().writer);
    await say(d, MEI, "let's do Secret Santa! I'm Mei");
    await db.database
      .update(schema.linqSharedGroupPeople)
      .set({ stoppedAt: NOON })
      .where(eq(schema.linqSharedGroupPeople.id, await personId(MEI)));
    await say(d, ADA, 'new santa please, Ada');
    const rows = await draws();
    expect(rows.map((r) => r.status).sort()).toEqual(['cancelled', 'collecting']);
    expect(rows.find((r) => r.status === 'collecting')?.organizerPersonId).toBe(await personId(ADA));
  });

  it("a non-organizer's start after the draw, with the organizer gone, leaves the drawn draw standing", async () => {
    await seedChat();
    const w = wire();
    await fiveDrawn(w);
    const [before] = await draws();
    const pairing = await truePairing();
    await db.database
      .update(schema.linqSharedGroupPeople)
      .set({ stoppedAt: NOON })
      .where(eq(schema.linqSharedGroupPeople.id, await personId(MEI)));
    const groupBefore = w.group.length;
    const directBefore = w.direct.length;
    const restart = santaScript({
      "let's do Secret Santa! I'm Ada": {
        start: true,
        joinSelf: { called: 'Ada' },
        reply: 'Love it. Say you’re in with the name to use.',
      },
    });
    await say(deps(w, restart.model, lines().writer), ADA, "let's do Secret Santa! I'm Ada");
    // Positive control: the model was asked, and read it as a start.
    expect(restart.inputs.map((i) => i.text)).toContain("let's do Secret Santa! I'm Ada");
    const rows = await draws();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before?.id, status: 'drawn', cancelledAt: null });
    expect(await truePairing()).toEqual(pairing);
    expect((await participants()).map((p) => p.called).sort()).toEqual(['Ada', 'Gia', 'Gus', 'Ken', 'Mei']);
    expect(w.direct.length).toBe(directBefore);
    for (const g of w.group.slice(groupBefore)) {
      for (const name of Object.values(NAMES)) expect(g.text).not.toContain(name);
    }
  });
});

describe('door order while a draw is collecting', () => {
  it('"count me out" removes only that participant and never leaves the family from the chat', async () => {
    const { a } = await seedChat();
    const s = santaScript(SCRIPT);
    const d = deps(wire(), s.model, lines().writer);
    await say(d, MEI, "let's do Secret Santa! I'm Mei");
    await say(d, KEN, "I'm in, Ken");
    await say(d, KEN, 'count me out');
    expect((await participants()).map((p) => p.called)).toEqual(['Mei']);
    const [joinRow] = await db.database
      .select()
      .from(schema.linqMultiFamilyJoins)
      .where(eq(schema.linqMultiFamilyJoins.familyId, a));
    expect(joinRow?.leftAt).toBeNull();
  });

  it('"Ana, I\'m in" stores the name and sends no who-confirmed line', async () => {
    await seedChat();
    const w = wire();
    const s = santaScript({ ...SCRIPT, "Ana, I'm in": join('Ana') });
    const d = deps(w, s.model, lines().writer);
    await say(d, MEI, "let's do Secret Santa! I'm Mei");
    w.group.length = 0;
    const out = await say(d, ADA, "Ana, I'm in");
    expect(out.outcome).toBe('secret_santa');
    expect((await participantOf(ADA))?.called).toBe('Ana');
    expect(w.group).toEqual([]);
    const joins = await db.database.select().from(schema.linqMultiFamilyJoins);
    expect(joins).toHaveLength(1);
  });

  it('with RSVP on, "I\'m in" goes to the draw and the RSVP reader is never asked', async () => {
    await seedChat();
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
    let rsvpReads = 0;
    const s = santaScript({ ...SCRIPT, "I'm in": join(null) });
    const d = deps(wire(), s.model, lines().writer, {
      groupPlanRsvpReader: {
        async read() {
          rsvpReads += 1;
          return null;
        },
      },
    });
    await say(d, MEI, "let's do Secret Santa! I'm Mei");
    const readsAfterStart = rsvpReads;
    await say(d, ADA, "I'm in");
    expect(rsvpReads).toBe(readsAfterStart);
    expect(await participantOf(ADA)).toBeDefined();
  });

  it('a stop still wins over a Secret Santa turn', async () => {
    await seedChat();
    const s = santaScript({
      ...SCRIPT,
      "stop texting me, I'm in": join('Ken'),
    });
    const d = deps(wire(), s.model, lines().writer);
    await say(d, MEI, "let's do Secret Santa! I'm Mei");
    expect(s.inputs).toHaveLength(1);
    const out = await say(d, KEN, "stop texting me, I'm in");
    expect(out.outcome).toBe('member_stopped');
    expect(await participantOf(KEN)).toBeUndefined();
  });
});

describe('names', () => {
  it('keeps a Chinese name the speaker wrote', () => {
    expect(checkCalled('小明', '我叫小明', [])).toEqual({ called: '小明' });
  });

  it('refuses a name the message never said, a link and a phone shape', () => {
    expect(checkCalled('Benjamin', "I'm in, Ben", [])).toEqual({ fact: 'name_needed' });
    expect(checkCalled('Ben bit.ly/x', 'Ben bit.ly/x in', [])).toEqual({ fact: 'name_needed' });
    expect(checkCalled('416 555 0199', 'in! 416 555 0199', [])).toEqual({ fact: 'name_needed' });
  });

  it('a second Ana is in with no name, and the group hears name_taken', async () => {
    await seedChat();
    const w = wire();
    const l = lines();
    const s = santaScript({ ...SCRIPT, "Ana here, I'm in": join('Ana'), 'me too, Ana': join('Ana') });
    const d = deps(w, s.model, l.writer);
    await say(d, MEI, "let's do Secret Santa! I'm Mei");
    await say(d, ADA, "Ana here, I'm in");
    await say(d, GUS, 'me too, Ana');
    expect((await participantOf(GUS))?.called).toBeNull();
    expect(l.requests.at(-1)).toMatchObject({
      purpose: 'group_refusal',
      facts: { outcome: 'name_taken' },
    });
  });

  it("a guest's redelivered join writes one row", async () => {
    await seedChat();
    const s = santaScript(SCRIPT);
    const d = deps(wire(), s.model, lines().writer);
    await say(d, MEI, "let's do Secret Santa! I'm Mei");
    await say(d, GUS, 'me too, Gus here', 'in-gus');
    await say(d, GUS, 'me too, Gus here', 'in-gus');
    expect((await participants()).filter((p) => p.called === 'Gus')).toHaveLength(1);
  });
});

describe('draw refusals', () => {
  it("a non-organizer's draw writes nothing; three is too few; an unnamed joiner blocks it", async () => {
    await seedChat();
    const w = wire();
    const l = lines();
    const s = santaScript({ ...SCRIPT, 'draw it': { draw: true }, "I'm in": join(null) });
    const d = deps(w, s.model, l.writer);
    await say(d, MEI, "let's do Secret Santa! I'm Mei");
    await say(d, KEN, "I'm in, Ken");
    await say(d, ADA, 'count me in, Ada');
    await say(d, KEN, 'draw it');
    expect(l.requests.at(-1)?.facts).toMatchObject({ outcome: 'not_organizer' });
    await say(d, MEI, 'draw it', 'in-draw-3');
    expect(l.requests.at(-1)?.facts).toMatchObject({ outcome: 'too_few', count: 3 });
    expect(
      (
        await db.database
          .select()
          .from(schema.channelMessages)
          .where(eq(schema.channelMessages.dedupeKey, 'linq:secret_santa_refusal:in-draw-3'))
      ).length,
    ).toBe(1);
    await say(d, GUS, "I'm in");
    await say(d, MEI, 'draw it');
    expect(l.requests.at(-1)?.facts).toMatchObject({ outcome: 'unnamed', count: 1 });
    expect((await draws())[0]?.status).toBe('collecting');
    // The refusals never consumed the done key: a later draw still says it is done.
    await say(d, GUS, 'me too, Gus here');
    await say(d, MEI, 'ok everyone, draw!');
    expect((await draws())[0]?.status).toBe('drawn');
    expect(w.group.at(-1)?.text).toBe('Drawn! 4 of you, each hears privately.');
  });

  it('a stopped participant is left out of the draw, not a reason to refuse', async () => {
    await seedChat();
    const s = santaScript(SCRIPT);
    const d = deps(wire(), s.model, lines().writer);
    await say(d, MEI, "let's do Secret Santa! I'm Mei");
    await say(d, KEN, "I'm in, Ken");
    await say(d, ADA, 'count me in, Ada');
    await say(d, GUS, 'me too, Gus here');
    await say(d, GIA, "I'm in! Gia");
    // Stopped outside the stop branch (e.g. before this build): the draw leaves them out.
    await db.database
      .update(schema.linqSharedGroupPeople)
      .set({ stoppedAt: NOON })
      .where(eq(schema.linqSharedGroupPeople.id, await personId(GIA)));
    await say(d, MEI, 'ok everyone, draw!');
    expect((await draws())[0]?.status).toBe('drawn');
    const pairing = await truePairing();
    expect([...pairing.keys()].sort()).toEqual(['Ada', 'Gus', 'Ken', 'Mei']);
    expect((await participantOf(GIA))?.heldReason).toBe('stopped');
  });
});

describe('the draw with five', () => {
  it('is a derangement over everyone, and the group hears exactly one line that names nobody', async () => {
    await seedChat();
    const w = wire();
    const { drawn } = await fiveDrawn(w);
    expect(drawn.outcome).toBe('secret_santa');
    const pairing = await truePairing();
    const givers = [...pairing.keys()].sort();
    expect(givers).toEqual(['Ada', 'Gia', 'Gus', 'Ken', 'Mei']);
    expect([...pairing.values()].sort()).toEqual(givers);
    for (const [giver, receiver] of pairing) expect(giver).not.toBe(receiver);
    const afterDraw = w.group.slice(-1);
    expect(afterDraw.map((g) => g.text)).toEqual(['Drawn! 5 of you, each hears privately.']);
  });

  it('an organizer redelivery draws once; a join racing the draw is refused and in no pairing', async () => {
    await seedChat();
    const w = wire();
    const { d } = await fiveDrawn(w);
    const before = await truePairing();
    expect(before.size).toBe(5);
    const groupBefore = w.group.length;
    await say(d, MEI, 'ok everyone, draw!');
    expect(await truePairing()).toEqual(before);
    expect(w.group.length).toBe(groupBefore);
    const late = santaScript({ 'wait me too, Zed': join('Zed') });
    const lateDoor = deps(w, late.model, lines().writer);
    await db.database.insert(schema.linqSharedGroupPeople).values({
      chatId: CHAT,
      phoneE164Encrypted: encryptString('+16415550141'),
      phoneE164Hash: phoneBlindIndex('+16415550141'),
    });
    await say(lateDoor, '+16415550141', 'wait me too, Zed');
    expect((await participants()).some((p) => p.called === 'Zed')).toBe(false);
    expect([...(await truePairing()).values()]).not.toContain('Zed');
  });

  it('two draws at once still draw once', async () => {
    await seedChat();
    const s = santaScript(SCRIPT);
    const d = deps(wire(), s.model, lines().writer);
    for (const [from, text] of [
      [MEI, "let's do Secret Santa! I'm Mei"],
      [KEN, "I'm in, Ken"],
      [ADA, 'count me in, Ada'],
      [GUS, 'me too, Gus here'],
    ] as const) {
      await say(d, from, text);
    }
    await Promise.all([
      say(d, MEI, 'ok everyone, draw!', 'in-a'),
      say(d, MEI, 'ok everyone, draw!', 'in-b'),
    ]);
    const rows = await participants();
    expect(rows.filter((r) => r.receiverEncrypted !== null)).toHaveLength(4);
    expect((await draws()).filter((r) => r.status === 'drawn')).toHaveLength(1);
  });

  it('a done line lost after the commit goes once from the sweep', async () => {
    await seedChat();
    const w = wire();
    await fiveDrawn(w, lines({ group_done: null }).writer);
    expect(w.group.some((g) => g.text.startsWith('Drawn!'))).toBe(false);
    const l = lines();
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    expect(w.group.filter((g) => g.text.startsWith('Drawn!'))).toHaveLength(1);
  });
});

describe('delivery', () => {
  it("each customer giver gets only their own draw, at their own number; nothing about the pairing is kept", async () => {
    await seedChat();
    const w = wire();
    await fiveDrawn(w);
    const l = lines();
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    const pairing = await truePairingFromRequests(l.requests);
    const draws = w.direct.filter((m) => m.body.includes('Secret Santa for'));
    expect(draws.map((m) => NAMES[m.to]).sort()).toEqual(['Ada', 'Ken', 'Mei']);
    for (const m of draws) {
      const giver = NAMES[m.to] as string;
      expect(m.body).toContain(`for ${pairing.get(giver)}.`);
    }
    const rows = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.templateKey, 'linq:secret_santa_draw'));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.body === null)).toBe(true);
    const delivered = (await participants()).filter((p) => p.deliveredAt);
    expect(delivered).toHaveLength(3);
    expect(delivered.every((p) => p.receiverEncrypted === null)).toBe(true);
    const audits = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_secret_santa_draw_sent'));
    expect(audits).toHaveLength(3);
    const userOf = new Map(
      (
        await db.database
          .select({ id: schema.users.id, ext: schema.users.externalAuthId })
          .from(schema.users)
      ).map((u) => [u.id, u.ext]),
    );
    for (const row of audits) {
      expect(row.audience).toBe(row.actor);
      expect(userOf.get(row.audience as string)).toMatch(/^imessage:/);
      expect(row.targetTable).toBe('secret_santa_draws');
      expect(row.after).toEqual({ outcome: 'delivered' });
    }
  });

  it('the guests are held, and the organizer is told once who is missing', async () => {
    await seedChat();
    const w = wire();
    await fiveDrawn(w);
    const l = lines();
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    expect((await participantOf(GUS))?.heldReason).toBe('not_texted_hale');
    expect((await participantOf(GIA))?.heldReason).toBe('not_texted_hale');
    const notes = w.direct.filter((m) => m.body.startsWith('Still waiting'));
    expect(notes).toEqual([{ to: MEI, body: 'Still waiting on Gus and Gia.' }]);
    const noteRequest = l.requests.find((r) => r.purpose === 'organizer_note');
    expect(noteRequest?.facts).toEqual({
      kind: 'missing',
      waiting: [
        { called: 'Gus', why: 'needs_to_text_hale' },
        { called: 'Gia', why: 'needs_to_text_hale' },
      ],
    });
  });
});

/** Who drew whom, as the line writer was told it: only giver_draw requests carry it. */
async function truePairingFromRequests(requests: SantaLineRequest[]) {
  const out = new Map<string, string>();
  for (const r of requests) {
    if (r.purpose !== 'giver_draw') continue;
    out.set(String(r.facts.giver), String(r.facts.receiver));
  }
  return out;
}

describe('the wrong-adult blocker', () => {
  it("a guest's draw never reaches the host's primary parent, and goes only to the guest's own number once verified", async () => {
    await seedChat();
    const w = wire();
    await fiveDrawn(w);
    const l = lines();
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    const gusReceiver = (
      await receiverForGiver(db.database, {
        drawId: (await participantOf(GUS))?.drawId as string,
        giverParticipantId: (await participantOf(GUS))?.id as string,
      })
    ) as { called: string };
    // Before Gus texts: nothing anywhere carries Gus's draw.
    expect(l.requests.filter((r) => r.facts.giver === 'Gus')).toEqual([]);
    expect(w.direct.filter((m) => m.to !== MEI && m.to !== KEN && m.to !== ADA)).toEqual([]);
    for (const m of w.direct) {
      if (NAMES[m.to] === 'Gus') throw new Error('unexpected');
      if (m.body.includes('Secret Santa for')) {
        const giver = NAMES[m.to] as string;
        expect(m.body).not.toContain('Hi Gus');
        expect(giver).not.toBe('Gus');
      }
    }
    // Gus verifies a channel of his own (a family of his own).
    const g = await family('Family G');
    await customer(GUS, g, 'primary_parent');
    w.direct.length = 0;
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    const gusDraws = w.direct.filter((m) => m.body.includes('Secret Santa for'));
    expect(gusDraws).toEqual([
      {
        to: GUS,
        body: `Hi Gus! You're the Secret Santa for ${gusReceiver.called}. Keep it quiet.`,
      },
    ]);
  });
});

describe('holds', () => {
  it("waits for daytime in the giver's own zone, and a Florida number stops at 20:00 under cadence", async () => {
    const { a } = await seedChat();
    await db.database
      .update(schema.users)
      .set({ timezone: 'America/Toronto' })
      .where(eq(schema.users.externalAuthId, `imessage:${KEN}`));
    const w = wire();
    await fiveDrawn(w);
    clock = new Date('2026-11-21T07:30:00.000Z'); // 02:30 in Toronto
    const l = lines();
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    expect((await participantOf(KEN))?.heldReason).toBe('quiet_hours');
    clock = new Date('2026-11-21T13:05:00.000Z'); // 08:05 in Toronto
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    expect((await participantOf(KEN))?.deliveredAt).not.toBeNull();

    // Florida, under cadence: 20:30 local is already quiet; a Toronto number is not.
    const FL = '+13055550161';
    const fl = await customer(FL, a, 'co_parent', 'America/New_York');
    const ON = '+14165550161';
    const on = await customer(ON, a, 'co_parent', 'America/New_York');
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const evening = new Date('2026-11-22T01:30:00.000Z');
    expect(await santaQuietNow(db.database, { userId: fl, familyId: a }, evening)).toBe(true);
    expect(await santaQuietNow(db.database, { userId: on, familyId: a }, evening)).toBe(false);
  });

  it('an unknown zone falls back to the household zone', async () => {
    const { a, ken } = await seedChat();
    await db.database
      .update(schema.users)
      .set({ timezone: 'America/Vancouver' })
      .where(eq(schema.users.externalAuthId, `imessage:${MEI}`));
    // Ken's zone is the UTC default (never set), so Mei's household zone applies.
    const sixAmVancouver = new Date('2026-11-21T14:00:00.000Z');
    const tenAmVancouver = new Date('2026-11-21T18:00:00.000Z');
    expect(await santaQuietNow(db.database, { userId: ken, familyId: a }, sixAmVancouver)).toBe(true);
    expect(await santaQuietNow(db.database, { userId: ken, familyId: a }, tenAmVancouver)).toBe(false);
  });

  it('holds on a paused line, an opted-out guest is never named, a held opt-out read waits', async () => {
    await seedChat();
    const w = wire();
    await fiveDrawn(w);
    await db.database.insert(schema.linqLineHealth).values({ phoneNumber: FROM, status: 'flagged', paused: true });
    const l = lines();
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    expect((await participantOf(MEI))?.heldReason).toBe('line_held');
    expect(w.direct).toEqual([]);
    await db.database.delete(schema.linqLineHealth);

    // Gus once texted STOP: a revoked channel for his number.
    const g = await family('Family G');
    const [u] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'imessage:gus-stopped' })
      .returning({ id: schema.users.id });
    await db.database.insert(schema.parentChannels).values({
      userId: u?.id as string,
      familyId: g,
      kind: 'sms',
      phoneE164Encrypted: encryptString(GUS),
      phoneE164Hash: phoneBlindIndex(GUS),
      verifiedAt: NOON,
      revokedAt: NOON,
    });
    // Ken's last text could not be read for a stop.
    await db.database.insert(schema.optOutHeldMessages).values({
      providerMessageId: 'held-1',
      phoneHash: phoneBlindIndex(KEN),
      heldAt: NOON,
      nextReadAt: NOON,
    });
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    expect((await participantOf(GUS))?.heldReason).toBe('opted_out');
    expect((await participantOf(KEN))?.heldReason).toBe('opt_out_unread');
    const note = l.requests.find((r) => r.purpose === 'organizer_note');
    expect(JSON.stringify(note?.facts)).not.toContain('Gus');
  });
});

describe("a guest's own first text", () => {
  function intakeDeps(transport: FakeTransport): IntakeDeps {
    return {
      transport,
      threadMessage: async () => 'conv-1',
      extractor: new FakeExtractor([{ children: [], postalCode: null }]),
      intentReader: new FakeIntentReader([]),
      radar: fakeRadar,
      answerComposer: fakeSilentAnswerComposer,
      openQuestions: fakeNoOpenQuestions,
      identityAsk: new FakeIdentityAsk(),
      limiter: new FakeRateLimiter(() => clock.getTime()),
      now: clock,
      optOutReader: {
        read: async ({ text }) =>
          /stop/i.test(text)
            ? { intent: 'stop', confirmation: 'Done.', language: null }
            : { intent: 'none', confirmation: '', language: null },
      },
    };
  }

  it('gets their draw as the reply, with no greeting and no channel_messages row', async () => {
    await seedChat();
    const w = wire();
    await fiveDrawn(w);
    const l = lines();
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    setSharedSecretSantaLineWriter(l.writer);
    const transport = new FakeTransport();
    const out = await handleInboundSms(
      db.database,
      { from: GUS, body: 'hi', providerId: 'dm-in-gus', receivedAt: clock, transport: 'imessage', chatId: 'dm-gus' },
      intakeDeps(transport),
    );
    expect(out).toEqual({ status: 'secret_santa_draw', delivered: 1 });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.to).toBe(GUS);
    expect(transport.sent[0]?.body).toMatch(/^Hi Gus! You're the Secret Santa for /);
    const request = l.requests.find((r) => r.purpose === 'giver_draw' && r.facts.giver === 'Gus');
    expect(request?.facts).toMatchObject({ firstOneToOne: true, mayNotBeHaleFamily: true });
    expect((await participantOf(GUS))?.deliveredAt).not.toBeNull();
    const ledger = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.direction, 'out'));
    expect(ledger.some((r) => r.templateKey === 'linq:secret_santa_draw' && r.familyId === null)).toBe(false);
    const counted = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_secret_santa_delivery_counted'));
    expect(counted.map((r) => r.after)).toEqual([{ outcome: 'delivered', count: 1 }]);
    // Redelivery of the same text sends nothing more.
    await handleInboundSms(
      db.database,
      { from: GUS, body: 'hi', providerId: 'dm-in-gus', receivedAt: clock, transport: 'imessage', chatId: 'dm-gus' },
      intakeDeps(transport),
    );
    expect(transport.sent).toHaveLength(1);
  });

  it('a STOP gets no draw, and nothing is ever sent after it', async () => {
    await seedChat();
    const w = wire();
    await fiveDrawn(w);
    const l = lines();
    setSharedSecretSantaLineWriter(l.writer);
    const transport = new FakeTransport();
    await handleInboundSms(
      db.database,
      { from: GIA, body: 'stop', providerId: 'dm-gia-1', receivedAt: clock, transport: 'imessage', chatId: 'dm-gia' },
      intakeDeps(transport),
    );
    await handleInboundSms(
      db.database,
      { from: GIA, body: 'hello?', providerId: 'dm-gia-2', receivedAt: clock, transport: 'imessage', chatId: 'dm-gia' },
      intakeDeps(transport),
    );
    expect(transport.sent.some((m) => m.body.includes('Secret Santa'))).toBe(false);
    expect(l.requests.some((r) => r.facts.giver === 'Gia')).toBe(false);
    expect((await participantOf(GIA))?.deliveredAt).toBeNull();
  });
});

describe('distinct send outcomes', () => {
  it('a permanent refusal holds cannot_open_1to1 with no retry; their next 1:1 text releases it', async () => {
    await seedChat();
    const w = wire();
    await fiveDrawn(w);
    w.oneToOne.fail = () => {
      throw new LinqSendError('chat_not_allowed', 403, true);
    };
    const l = lines();
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    expect((await participantOf(ADA))?.heldReason).toBe('cannot_open_1to1');
    const attempts = (await participantOf(ADA))?.attempts;
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    expect((await participantOf(ADA))?.attempts).toBe(attempts);
    w.oneToOne.fail = undefined;
    const released = await releaseHeldDrawsForCustomer(
      db.database,
      { phone: ADA, now: clock },
      { writer: l.writer, oneToOne: w.oneToOne },
    );
    expect(released.delivered).toBe(1);
    expect((await participantOf(ADA))?.deliveredAt).not.toBeNull();
  });

  it('a transient failure retries up to six times, then is terminal and named', async () => {
    await seedChat();
    const w = wire();
    await fiveDrawn(w);
    w.oneToOne.fail = () => {
      throw new LinqSendError('upstream_503', 503, false);
    };
    const l = lines();
    for (let i = 0; i < 8; i += 1) {
      await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    }
    const ada = await participantOf(ADA);
    expect(ada).toMatchObject({ heldReason: 'send_failed', attempts: 6 });
  });

  it('a non-Linq throw leaves the claim, which reads claim_stuck later and is never resent', async () => {
    await seedChat();
    const w = wire();
    await fiveDrawn(w);
    w.oneToOne.fail = () => {
      throw new TypeError('boom');
    };
    const l = lines();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    w.oneToOne.fail = undefined;
    clock = new Date(NOON.getTime() + 20 * 60_000);
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    expect((await participantOf(MEI))?.heldReason).toBe('claim_stuck');
    expect(w.direct.filter((m) => m.to === MEI && m.body.includes('Secret Santa for'))).toEqual([]);
  });

  it('already_sent with no provider id is claim_stuck', async () => {
    await seedChat();
    const w = wire();
    await fiveDrawn(w);
    const mei = await participantOf(MEI);
    const [meiUser] = await db.database
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.externalAuthId, `imessage:${MEI}`));
    const [fam] = await db.database
      .select({ id: schema.familyMembers.familyId })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.userId, meiUser?.id as string));
    await db.database.insert(schema.channelMessages).values({
      familyId: fam?.id as string,
      parentUserId: meiUser?.id as string,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: 'linq:secret_santa_draw',
      dedupeKey: `linq:secret_santa_draw:${mei?.drawId}:${mei?.id}`,
      status: 'sent',
      sentAt: NOON,
    });
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, lines().writer));
    expect((await participantOf(MEI))?.heldReason).toBe('claim_stuck');
  });

  it('a giver line the model cannot write is line_unwritten; the others still go', async () => {
    await seedChat();
    const w = wire();
    await fiveDrawn(w);
    const l = lines();
    const writer: SecretSantaLineWriter = {
      async write(request) {
        if (request.purpose === 'giver_draw' && request.facts.giver === 'Ken') return null;
        return l.writer.write(request);
      },
    };
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, writer));
    expect((await participantOf(KEN))?.heldReason).toBe('line_unwritten');
    expect((await participantOf(MEI))?.deliveredAt).not.toBeNull();
    expect((await participantOf(ADA))?.deliveredAt).not.toBeNull();
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    expect((await participantOf(KEN))?.deliveredAt).not.toBeNull();
  });
});

describe('leaving after the draw', () => {
  async function afterLeave(leave: (ids: { b: string }) => Promise<void>) {
    const ids = await seedChat();
    const w = wire();
    await fiveDrawn(w);
    await leave(ids);
    const rows = await participants();
    const [draw] = await draws();
    expect(draw?.staleAt).not.toBeNull();
    expect(rows.find((r) => r.called === 'Ada')).toBeUndefined();
    expect(rows.every((r) => r.heldReason === 'draw_stale')).toBe(true);
    const l = lines();
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    expect(w.direct.filter((m) => m.body.includes('Secret Santa for'))).toEqual([]);
    expect(w.direct.filter((m) => m.body.startsWith('Someone left'))).toEqual([
      { to: MEI, body: 'Someone left after the draw. Want to start over?' },
    ]);
    expect(l.requests.find((r) => r.purpose === 'organizer_note')?.facts).toEqual({ kind: 'stale' });
  }

  it("a participant's family is erased", async () => {
    await afterLeave(async ({ b }) => {
      await db.database
        .update(schema.families)
        .set({ scheduledDeletionAt: new Date(NOON.getTime() - 86_400_000) })
        .where(eq(schema.families.id, b));
      await runDeletionSweep(db.database, NOON);
    });
  });

  it('a participant leaves the chat', async () => {
    await afterLeave(async () => {
      await forgetSharedGroupPresence(db.database, {
        chatId: CHAT,
        participantHandle: ADA,
        participantIsMe: false,
        now: NOON,
      });
    });
  });
});

describe('group STOP', () => {
  it('takes the person out of a collecting draw, and holds them as stopped after a draw', async () => {
    await seedChat();
    const s = santaScript({ ...SCRIPT, 'stop texting me': {} });
    const w = wire();
    const d = deps(w, s.model, lines().writer);
    await say(d, MEI, "let's do Secret Santa! I'm Mei");
    await say(d, KEN, "I'm in, Ken");
    expect((await participantOf(KEN))?.called).toBe('Ken');
    await say(d, KEN, 'stop texting me');
    expect(await participantOf(KEN)).toBeUndefined();
  });

  it('after a draw the stopped giver is never texted', async () => {
    await seedChat();
    const w = wire();
    const { d } = await fiveDrawn(w);
    await say(d, ADA, 'stop texting me');
    expect((await participantOf(ADA))?.heldReason).toBe('stopped');
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, lines().writer));
    expect(w.direct.filter((m) => m.to === ADA)).toEqual([]);
  });
});

describe('stuck draws and retention, with the flag off', () => {
  it('cancels an orphaned or 14-day-old collecting draw and purges at 45 days', async () => {
    await seedChat();
    const s = santaScript(SCRIPT);
    const d = deps(wire(), s.model, lines().writer);
    await say(d, MEI, "let's do Secret Santa! I'm Mei");
    vi.stubEnv('SECRET_SANTA', 'false');
    expect(await sweepSecretSantaRetention(db.database, new Date(NOON.getTime() + 86_400_000))).toEqual({
      cancelled: 0,
      deleted: 0,
    });
    expect(
      await sweepSecretSantaRetention(db.database, new Date(NOON.getTime() + 15 * 86_400_000)),
    ).toEqual({ cancelled: 1, deleted: 0 });
    expect(
      await sweepSecretSantaRetention(db.database, new Date(NOON.getTime() + 61 * 86_400_000)),
    ).toEqual({ cancelled: 0, deleted: 1 });
    expect(await draws()).toEqual([]);
    vi.stubEnv('SECRET_SANTA', '');
    await say(d, MEI, "let's do Secret Santa! I'm Mei");
    expect((await draws()).map((r) => r.status)).toEqual(['collecting']);
  });

  it('cancels a collecting draw whose organizer was erased', async () => {
    const { a } = await seedChat();
    const s = santaScript(SCRIPT);
    const d = deps(wire(), s.model, lines().writer);
    await say(d, MEI, "let's do Secret Santa! I'm Mei");
    await db.database
      .update(schema.families)
      .set({ scheduledDeletionAt: new Date(NOON.getTime() - 86_400_000) })
      .where(eq(schema.families.id, a));
    await runDeletionSweep(db.database, NOON);
    vi.stubEnv('SECRET_SANTA', 'false');
    await sweepSecretSantaRetention(db.database, NOON);
    expect((await draws()).map((r) => r.status)).toEqual(['cancelled']);
  });
});

describe('leak suite', () => {
  it('no group send, model input, audit row or family export carries a pairing', async () => {
    const { a, b, mei, ada } = await seedChat();
    const w = wire();
    const l = lines();
    const { s, d } = await fiveDrawn(w, l.writer);
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    await say(d, ADA, 'who did Ben get?');
    const pairing = await truePairingFromRequests(l.requests);
    expect(pairing.size).toBe(3);
    const names = Object.values(NAMES);

    // Every group send after the draw names nobody.
    const drawIndex = w.group.findIndex((g) => g.text.startsWith('Drawn!'));
    for (const g of w.group.slice(drawIndex)) {
      for (const name of names) expect(g.text).not.toContain(name);
    }
    // Only giver_draw requests carry a receiver; each went to its own giver's number.
    for (const r of l.requests) {
      if (r.purpose !== 'giver_draw') expect(JSON.stringify(r)).not.toMatch(/receiver/);
    }
    for (const m of w.direct.filter((x) => x.body.includes('Secret Santa for'))) {
      const giver = NAMES[m.to] as string;
      for (const [other, receiver] of pairing) {
        if (other !== giver) expect(m.body).not.toContain(`for ${receiver}.`);
      }
    }
    // The turn reader never sees anything drawn.
    for (const input of s.inputs) {
      expect(Object.keys(input.santa).sort()).toEqual([
        'count',
        'minimum',
        'participants',
        'status',
        'youAreOrganizer',
      ]);
      for (const p of input.santa.participants) expect(Object.keys(p).sort()).toEqual(['called', 'ref']);
    }
    // Audit rows: no name, no participant id, outcome tokens and counts only.
    const participantIds = (await participants()).map((p) => p.id);
    const audits = await db.database.select().from(schema.auditLog);
    const santaAudits = audits.filter((r) => r.actionTaken.startsWith('linq_secret_santa'));
    expect(santaAudits.length).toBeGreaterThan(0);
    for (const row of santaAudits) {
      const wireRow = JSON.stringify(row);
      for (const name of names) expect(wireRow).not.toContain(`"${name}"`);
      for (const id of participantIds) expect(wireRow).not.toContain(id);
      expect(row.targetTable).toBe('secret_santa_draws');
    }
    // Family exports (family-wide copies) of the giver's and a receiver's families.
    const outsiders = { [a]: ['Ada', 'Gus', 'Gia'], [b]: ['Mei', 'Ken', 'Gus', 'Gia'] };
    for (const [familyId, actor] of [
      [a, mei],
      [b, ada],
    ] as const) {
      const doc = JSON.stringify(
        await assembleFamilyExport(db.database, familyId, { actorUserId: actor, now: NOON }),
      );
      // Its own members' names are its own; nobody else in the draw may appear.
      for (const name of outsiders[familyId] ?? []) expect(doc).not.toContain(name);
      for (const id of participantIds) expect(doc).not.toContain(id);
      // Positive control: the export does carry this family's own rows.
      expect(doc).toContain(familyId);
    }
  });

  it('console carries no name and no participant id across a full flow and a forced Postgres error', async () => {
    const spies = (['info', 'warn', 'error', 'log'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    await seedChat();
    const w = wire();
    const l = lines();
    await fiveDrawn(w, l.writer);
    w.oneToOne.fail = () => {
      throw Object.assign(new Error("duplicate key value violates unique constraint (Mei, Ken)"), {
        code: '23505',
      });
    };
    await runSecretSantaSweep(db.database, clock, sweepPorts(w, l.writer));
    const ids = (await participants()).map((p) => p.id);
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged.length).toBeGreaterThan(2);
    for (const name of Object.values(NAMES)) expect(logged).not.toContain(name);
    for (const id of ids) expect(logged).not.toContain(id);
    // Positive control: the forced error was logged by name, by its label.
    expect(logged).toContain('secret_santa_send_threw');
  });
});

describe('flag and model', () => {
  it('with the flag off the Santa model is never called and nothing is written', async () => {
    await seedChat();
    vi.stubEnv('SECRET_SANTA', 'false');
    const s = santaScript(SCRIPT);
    await say(deps(wire(), s.model, lines().writer), MEI, "let's do Secret Santa! I'm Mei");
    expect(s.inputs).toEqual([]);
    expect(await draws()).toEqual([]);
  });

  it('a malformed read writes nothing and the list path still runs', async () => {
    await seedChat();
    vi.stubEnv('GROUP_BRING_LIST_ENABLED', 'true');
    const s = santaScript({ "we'll bring the salad": () => ({ santaTurn: 'yes' }) });
    const w = wire();
    const out = await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: MEI,
        otherHandles: ALL.filter((h) => h !== MEI),
        text: "we'll bring the salad",
        providerMessageId: 'in-salad',
        receivedAt: clock,
        now: clock,
        send: w.sendGroupText,
      },
      {
        composer: fakeSharedGroupComposer(),
        santaTurn: s.model,
        santaLine: lines().writer,
        listTurn: {
          async decide() {
            return {
              listTurn: true,
              list: 'Potluck',
              add: [],
              claim: [{ item: null, text: 'the salad' }],
              release: [],
              gift: { forKid: null, keepFromKidFamily: false, kidFamily: [] },
              reply: 'Salad is yours.',
            };
          },
        },
      },
    );
    expect(s.inputs.length).toBe(2);
    expect(await draws()).toEqual([]);
    expect(out).toMatchObject({ handled: true, outcome: 'shared_list', notice: 'sent' });
    expect(w.group.map((g) => g.text)).toEqual(['Salad is yours.']);
  });
});

describe('migration', () => {
  it('0245 survives a second pass', async () => {
    await db.applyMigration('0245_secret_santa.sql');
    const result = await db.client.query(
      "select to_regclass('secret_santa_draws')::text as d, to_regclass('secret_santa_participants')::text as p",
    );
    expect(result.rows).toEqual([{ d: 'secret_santa_draws', p: 'secret_santa_participants' }]);
  });
});
