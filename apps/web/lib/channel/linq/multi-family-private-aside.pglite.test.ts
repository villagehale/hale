import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { runDeletionSweep } from '~/lib/rights/delete';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { type OneToOneSend, privateAsideOneToOne } from './connect-link-1to1';
import { fakeGroupOnboardingComposer } from './group-onboarding-voice-fake';
import {
  PRIVATE_ASIDE_AUDIT,
  type PrivateAsideDraftInput,
  type PrivateAsideModel,
  type PrivateAsideReadInput,
} from './group-private-aside';
import { handleLinqInboundRequest } from './inbound';
import { takeMultiFamilyTurn } from './multi-family';
import type { SharedGroupReader } from './shared-group-reading';
import { fakeSharedGroupComposer } from './shared-group-voice-fake';
import { LinqSendError } from './transport';

const SHARED_REPLY = 'shared-reply-line';
const questionReader: SharedGroupReader = {
  async read() {
    return {
      intent: 'question',
      role: 'unclear',
      familyLabel: null,
      kidName: null,
      confidence: 'high',
    };
  },
};
/** VIL-456: the shared turn reads and speaks through ports; fakes here, never a word list. */
const readerOf = (intent: 'chatter' | 'unclear'): SharedGroupReader => ({
  async read() {
    return { intent, role: 'unclear', familyLabel: null, kidName: null, confidence: 'high' };
  },
});
const ports = () => ({
  reader: questionReader,
  composer: fakeSharedGroupComposer({ body: SHARED_REPLY }),
});

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_A = '+14165550111';
const PARENT_B = '+14165550222';
const FROM = '+16462352164';
const NOW = new Date('2026-10-02T15:00:00.000Z');
const CHAT = 'chat-shared-group';
const CHILD = 'Zephyrina';
const MEMORY = 'zephyr-memory-token';
const CALENDAR = 'zephyr-calendar-token';

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_FROM_E164', FROM);
  vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users, linq_multi_family_joins, audit_log cascade');
});

function sender() {
  const texts: string[] = [];
  const send = async (notice: { chatId: string; text: string }) => {
    texts.push(notice.text);
    return { providerMessageId: `msg-${texts.length}` };
  };
  return { send, texts };
}

async function seedFamily(phone: string, name: string) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}`, name })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId,
    userId,
    role: 'primary_parent',
  });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  return { familyId, userId };
}

async function seedPrivate(familyId: string) {
  await db.database.insert(schema.children).values({
    familyId,
    name: CHILD,
    dateOfBirth: '2022-04-01',
  });
  await db.database.insert(schema.familyMemoryFacts).values({
    familyId,
    factType: 'preference',
    factKey: MEMORY,
    factValue: { note: 'hidden-memory' },
  });
  await db.database.insert(schema.familyEvents).values({
    familyId,
    title: CALENDAR,
    startsAt: NOW,
    source: 'parent',
  });
}

/** Two households in the chat; neither parent has said a word about joining. */
async function twoPresent() {
  const ada = await seedFamily(PARENT_A, 'Ada');
  const bao = await seedFamily(PARENT_B, 'Bao');
  await seedPrivate(bao.familyId);
  return { ada, bao, wire: sender() };
}

/** 'clash' picks the family whose own facts name the kid (refs follow join order, which can tie). */
function fakeModel(read: 'clash' | string[] | Error, draft: { send: boolean } = { send: true }) {
  const reads: PrivateAsideReadInput[] = [];
  const drafts: PrivateAsideDraftInput[] = [];
  const model: PrivateAsideModel = {
    async read(input) {
      reads.push(input);
      if (read instanceof Error) throw read;
      if (read === 'clash') {
        return input.families.filter((f) => f.kids.includes(CHILD)).map((f) => f.ref);
      }
      return read;
    },
    async draft(input) {
      drafts.push(input);
      if (!draft.send) return { send: false, about: '', text: '' };
      // Stand-in for the model's own words; production text is always model-written.
      return { send: true, about: 'own clash', text: `aside:${input.private.children.join(',')}` };
    },
  };
  return { model, reads, drafts };
}

function fakeOneToOne() {
  const sent: { to: string; body: string }[] = [];
  const send: OneToOneSend = {
    text: async (input) => {
      sent.push(input);
      return { providerMessageId: `dm-${sent.length}`, chatId: `dm-chat-${sent.length}` };
    },
    link: async () => ({ providerMessageId: 'unused' }),
  };
  return { send, sent };
}

const turnInput = (wire: ReturnType<typeof sender>, providerMessageId = 'in-aside') => ({
  chatId: CHAT,
  senderHandle: PARENT_A,
  otherHandles: [PARENT_B],
  text: 'Hale can everyone do the park Saturday at 10am?',
  providerMessageId,
  receivedAt: NOW,
  now: NOW,
  send: wire.send,
});

describe('VIL-457 shared-group turn wires the private aside', () => {
  it('texts the clashing family 1:1 with its own facts; the group line carries none', async () => {
    const { bao, wire } = await twoPresent();
    const groupBefore = wire.texts.length;
    const m = fakeModel('clash');
    const dm = fakeOneToOne();

    const out = await takeMultiFamilyTurn(
      db.database,
      {
        ...turnInput(wire),
        privateAside: {
          model: m.model,
          sendOneToOne: privateAsideOneToOne(db.database, { now: NOW, send: dm.send }),
        },
      },
      ports(),
    );

    expect(out).toMatchObject({ handled: true, outcome: 'shared_reply', aside: 'ran' });
    const group = wire.texts.slice(groupBefore);
    expect(group).toEqual([SHARED_REPLY]);
    for (const line of group) {
      expect(line).not.toContain(CHILD);
      expect(line).not.toContain(MEMORY);
      expect(line).not.toContain('aside:');
    }
    expect(m.reads).toHaveLength(1);
    const adaRef = m.reads[0]?.families.find((f) => !f.kids.includes(CHILD))?.ref;
    expect(m.reads[0]?.senderFamily).toBe(adaRef);
    expect(m.drafts).toHaveLength(1);
    expect(m.drafts[0]?.private.children).toEqual([CHILD]);
    expect(m.drafts[0]?.askedByThisFamily).toBe(false);
    expect(dm.sent).toEqual([{ to: PARENT_B, body: `aside:${CHILD}` }]);

    const rows = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, PRIVATE_ASIDE_AUDIT));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.familyId).toBe(bao.familyId);
    const ledger = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.templateKey, 'linq:private_aside'));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.familyId).toBe(bao.familyId);
    // Presence alone: neither household joined, and no consent was written for them.
    expect(await db.database.select().from(schema.linqMultiFamilyJoins)).toEqual([]);
  });

  it('sends nothing 1:1 when the read picks no family', async () => {
    const { wire } = await twoPresent();
    const m = fakeModel([]);
    const dm = fakeOneToOne();
    const out = await takeMultiFamilyTurn(
      db.database,
      {
        ...turnInput(wire),
        privateAside: {
          model: m.model,
          sendOneToOne: privateAsideOneToOne(db.database, { now: NOW, send: dm.send }),
        },
      },
      ports(),
    );
    expect(out).toMatchObject({ outcome: 'shared_reply', aside: 'none' });
    expect(m.drafts).toEqual([]);
    expect(dm.sent).toEqual([]);
  });

  it('a failing model never fails the turn and sends no fallback', async () => {
    const { wire } = await twoPresent();
    const groupBefore = wire.texts.length;
    const m = fakeModel(new Error('boom'));
    const dm = fakeOneToOne();
    const out = await takeMultiFamilyTurn(
      db.database,
      {
        ...turnInput(wire),
        privateAside: {
          model: m.model,
          sendOneToOne: privateAsideOneToOne(db.database, { now: NOW, send: dm.send }),
        },
      },
      ports(),
    );
    expect(out).toMatchObject({ handled: true, outcome: 'shared_reply', aside: 'error' });
    expect(wire.texts.slice(groupBefore)).toEqual([SHARED_REPLY]);
    expect(dm.sent).toEqual([]);
  });

  it('a redelivered group message does not run the aside twice', async () => {
    const { wire } = await twoPresent();
    const m = fakeModel('clash');
    const dm = fakeOneToOne();
    const privateAside = {
      model: m.model,
      sendOneToOne: privateAsideOneToOne(db.database, { now: NOW, send: dm.send }),
    };
    await takeMultiFamilyTurn(db.database, { ...turnInput(wire), privateAside }, ports());
    const again = await takeMultiFamilyTurn(
      db.database,
      { ...turnInput(wire), privateAside },
      ports(),
    );
    expect(again).toMatchObject({ handled: true, outcome: 'duplicate' });
    expect(m.reads).toHaveLength(1);
    expect(dm.sent).toHaveLength(1);
  });

  it('without the aside port the turn reads no private model at all', async () => {
    const { wire } = await twoPresent();
    const out = await takeMultiFamilyTurn(db.database, turnInput(wire), ports());
    expect(out).toMatchObject({ handled: true, outcome: 'shared_reply' });
    expect(out).not.toHaveProperty('aside');
  });
});

describe('VIL-496 aside sends even when the group line does not', () => {
  for (const [label, composer] of [
    ['declined', () => fakeSharedGroupComposer({ decline: true })],
    ['refused (model failed)', () => fakeSharedGroupComposer({ fail: true })],
  ] as const) {
    it(`group ${label}: the clashing family still hears 1:1; the turn is owned, not held`, async () => {
      const { bao, wire } = await twoPresent();
      const groupBefore = wire.texts.length;
      const m = fakeModel('clash');
      const dm = fakeOneToOne();
      const out = await takeMultiFamilyTurn(
        db.database,
        {
          ...turnInput(wire),
          privateAside: {
            model: m.model,
            sendOneToOne: privateAsideOneToOne(db.database, { now: NOW, send: dm.send }),
          },
        },
        { reader: questionReader, composer: composer() },
      );
      expect(out).toMatchObject({ handled: true, outcome: 'aside_only', aside: 'ran' });
      expect(out).toHaveProperty('notice');
      expect((out as { notice?: string }).notice).not.toMatch(/^(already_)?sent$/);
      expect(wire.texts.slice(groupBefore)).toEqual([]);
      expect(dm.sent).toEqual([{ to: PARENT_B, body: `aside:${CHILD}` }]);
      const rows = await db.database
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.actionTaken, PRIVATE_ASIDE_AUDIT));
      expect(rows.map((r) => r.familyId)).toEqual([bao.familyId]);
    });
  }

  it('group quiet and the aside declines: hands the message back so a text RSVP can still be read', async () => {
    const { wire } = await twoPresent();
    const m = fakeModel('clash', { send: false });
    const dm = fakeOneToOne();
    const out = await takeMultiFamilyTurn(
      db.database,
      {
        ...turnInput(wire),
        privateAside: {
          model: m.model,
          sendOneToOne: privateAsideOneToOne(db.database, { now: NOW, send: dm.send }),
        },
      },
      { reader: questionReader, composer: fakeSharedGroupComposer({ decline: true }) },
    );
    expect(out).toEqual({ handled: false });
    expect(m.drafts).toHaveLength(1);
    expect(dm.sent).toEqual([]);
  });

  it('group quiet and the 1:1 fails to send: hands the message back', async () => {
    const { wire } = await twoPresent();
    const m = fakeModel('clash');
    const send: OneToOneSend = {
      text: async () => {
        throw new LinqSendError('unavailable', 503, false);
      },
      link: async () => ({ providerMessageId: 'unused' }),
    };
    const out = await takeMultiFamilyTurn(
      db.database,
      {
        ...turnInput(wire),
        privateAside: {
          model: m.model,
          sendOneToOne: privateAsideOneToOne(db.database, { now: NOW, send }),
        },
      },
      { reader: questionReader, composer: fakeSharedGroupComposer({ decline: true }) },
    );
    expect(out).toEqual({ handled: false });
    expect(m.drafts).toHaveLength(1);
  });

  it('group quiet and no family touched: hands the message back (no hold-stealing)', async () => {
    const { wire } = await twoPresent();
    const m = fakeModel([]);
    const dm = fakeOneToOne();
    const out = await takeMultiFamilyTurn(
      db.database,
      {
        ...turnInput(wire),
        privateAside: {
          model: m.model,
          sendOneToOne: privateAsideOneToOne(db.database, { now: NOW, send: dm.send }),
        },
      },
      { reader: questionReader, composer: fakeSharedGroupComposer({ decline: true }) },
    );
    expect(out).toEqual({ handled: false });
    expect(dm.sent).toEqual([]);
  });

  for (const intent of ['chatter', 'unclear'] as const) {
    it(`reader says ${intent}: the clashing family still hears 1:1; group stays silent`, async () => {
      const { wire } = await twoPresent();
      const groupBefore = wire.texts.length;
      const m = fakeModel('clash');
      const dm = fakeOneToOne();
      const out = await takeMultiFamilyTurn(
        db.database,
        {
          ...turnInput(wire),
          privateAside: {
            model: m.model,
            sendOneToOne: privateAsideOneToOne(db.database, { now: NOW, send: dm.send }),
          },
        },
        { reader: readerOf(intent), composer: fakeSharedGroupComposer({ decline: true }) },
      );
      expect(out).toMatchObject({ handled: true, outcome: 'aside_only', aside: 'ran' });
      expect(wire.texts.slice(groupBefore)).toEqual([]);
      expect(dm.sent).toEqual([{ to: PARENT_B, body: `aside:${CHILD}` }]);
    });

    it(`reader says ${intent} and no family touched: hands the message back`, async () => {
      const { wire } = await twoPresent();
      const m = fakeModel([]);
      const dm = fakeOneToOne();
      const out = await takeMultiFamilyTurn(
        db.database,
        {
          ...turnInput(wire),
          privateAside: {
            model: m.model,
            sendOneToOne: privateAsideOneToOne(db.database, { now: NOW, send: dm.send }),
          },
        },
        { reader: readerOf(intent), composer: fakeSharedGroupComposer({ decline: true }) },
      );
      expect(out).toEqual({ handled: false });
      expect(dm.sent).toEqual([]);
    });
  }

  it('a redelivered message after a quiet group does not aside twice', async () => {
    const { wire } = await twoPresent();
    const m = fakeModel('clash');
    const dm = fakeOneToOne();
    const privateAside = {
      model: m.model,
      sendOneToOne: privateAsideOneToOne(db.database, { now: NOW, send: dm.send }),
    };
    const quiet = () => ({
      reader: questionReader,
      composer: fakeSharedGroupComposer({ decline: true }),
    });
    await takeMultiFamilyTurn(db.database, { ...turnInput(wire), privateAside }, quiet());
    const again = await takeMultiFamilyTurn(
      db.database,
      { ...turnInput(wire), privateAside },
      quiet(),
    );
    expect(again).toMatchObject({ handled: true, outcome: 'duplicate' });
    expect(m.reads).toHaveLength(1);
    expect(dm.sent).toHaveLength(1);
  });
});

const SECRET_BYTES = Buffer.alloc(32, 9);
const TS = String(Math.floor(NOW.getTime() / 1000));

/** participant.removed through the real Linq door: one member, or Hale itself. */
async function removedAtTheDoor(handle: string, isMe: boolean) {
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${SECRET_BYTES.toString('base64')}`);
  const eventId = `evt_removed_${isMe ? 'hale' : 'member'}`;
  const raw = JSON.stringify({
    api_version: 'v3',
    webhook_version: '2026-02-03',
    event_type: 'participant.removed',
    event_id: eventId,
    created_at: NOW.toISOString(),
    data: {
      chat_id: CHAT,
      handle,
      participant: { handle, is_me: isMe, service: 'iMessage', status: 'removed' },
    },
  });
  const mac = createHmac('sha256', SECRET_BYTES).update(`${eventId}.${TS}.${raw}`).digest('base64');
  const response = await handleLinqInboundRequest(
    new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': eventId,
        'webhook-timestamp': TS,
        'webhook-signature': `v1,${mac}`,
      },
      body: raw,
    }),
    {
      database: db.database,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      countOutcome: async () => {},
      enqueue: async () => {},
      now: () => NOW,
      groupVoice: fakeGroupOnboardingComposer(),
    } as unknown as Parameters<typeof handleLinqInboundRequest>[1],
  );
  expect(response.status).toBe(200);
}

const stopReader: SharedGroupReader = {
  async read() {
    return {
      intent: 'stop_me',
      role: 'unclear',
      familyLabel: null,
      kidName: null,
      confidence: 'high',
    };
  },
};

const joinReader: SharedGroupReader = {
  async read() {
    return {
      intent: 'join',
      role: 'unclear',
      familyLabel: null,
      kidName: null,
      confidence: 'high',
    };
  },
};

async function personRow(phone: string) {
  const rows = await db.database
    .select()
    .from(schema.linqSharedGroupPeople)
    .where(eq(schema.linqSharedGroupPeople.phoneE164Hash, phoneBlindIndex(phone)));
  return rows;
}

/** Bao's parent is in the chat with a first name and an inferred kid name on their row. */
async function baoNamed() {
  await db.database
    .update(schema.linqSharedGroupPeople)
    .set({ firstName: 'Bao', inferredKidName: CHILD, inferredFamilyLabel: 'Bao family' })
    .where(eq(schema.linqSharedGroupPeople.phoneE164Hash, phoneBlindIndex(PARENT_B)));
}

describe('a STOP in a shared chat outlives leaving it', () => {
  for (const [label, removal] of [
    ['the member is removed', () => removedAtTheDoor(PARENT_B, false)],
    ['Hale is removed', () => removedAtTheDoor(FROM, true)],
  ] as const) {
    it(`${label} and re-added: the stopped parent stays stopped and their household gets no aside`, async () => {
      const { wire } = await twoPresent();
      const stopped = await takeMultiFamilyTurn(
        db.database,
        {
          ...turnInput(wire, 'in-stop'),
          senderHandle: PARENT_B,
          otherHandles: [PARENT_A],
          text: 'stop',
        },
        { reader: stopReader, composer: fakeSharedGroupComposer({ body: SHARED_REPLY }) },
      );
      expect(stopped).toMatchObject({ handled: true, outcome: 'member_stopped', count: 'intake' });
      await baoNamed();

      await removal();

      // Only the stop survives: the hash and when, nothing that names the person or a family.
      const [tombstone, ...extra] = await personRow(PARENT_B);
      expect(extra).toEqual([]);
      expect(tombstone).toMatchObject({
        chatId: CHAT,
        familyId: null,
        userId: null,
        firstName: null,
        inferredKidName: null,
        inferredFamilyLabel: null,
        inferredRole: null,
      });
      expect(tombstone?.stoppedAt).toEqual(NOW);

      // Re-added: Bao's parent texts the group, and Ada's question touches Bao's own kid.
      const again = await takeMultiFamilyTurn(
        db.database,
        {
          ...turnInput(wire, 'in-back'),
          senderHandle: PARENT_B,
          otherHandles: [PARENT_A],
          text: 'Hale is anyone free Saturday?',
        },
        ports(),
      );
      expect(again).toMatchObject({ handled: true, outcome: 'member_stopped', count: 'ignored' });

      const m = fakeModel('clash');
      const dm = fakeOneToOne();
      await takeMultiFamilyTurn(
        db.database,
        {
          ...turnInput(wire, 'in-ada'),
          privateAside: {
            model: m.model,
            sendOneToOne: privateAsideOneToOne(db.database, { now: NOW, send: dm.send }),
          },
        },
        ports(),
      );
      expect(dm.sent).toEqual([]);
      expect(m.reads.flatMap((read) => read.families.flatMap((f) => f.kids))).not.toContain(CHILD);
    });
  }

  it('erasing the household keeps only the stop: re-added, the parent is still stopped and nameless; the unstopped row is gone', async () => {
    const PARENT_C = '+12025550133';
    const BAO_COPARENT = '+12025550144';
    const { bao, wire } = await twoPresent();
    await seedFamily(PARENT_C, 'Cai');
    const [coParent] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: 'imessage:Bao-coparent', name: 'Bao co-parent' })
      .returning({ id: schema.users.id });
    await db.database.insert(schema.familyMembers).values({
      familyId: bao.familyId,
      userId: coParent?.id as string,
      role: 'co_parent',
    });
    await db.database.insert(schema.parentChannels).values({
      userId: coParent?.id as string,
      familyId: bao.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(BAO_COPARENT),
      phoneE164Hash: phoneBlindIndex(BAO_COPARENT),
      verifiedAt: NOW,
    });
    const everyone = [PARENT_A, PARENT_C, BAO_COPARENT];
    const stopped = await takeMultiFamilyTurn(
      db.database,
      {
        ...turnInput(wire, 'in-stop'),
        senderHandle: PARENT_B,
        otherHandles: everyone,
        text: 'stop',
      },
      { reader: stopReader, composer: fakeSharedGroupComposer({ body: SHARED_REPLY }) },
    );
    expect(stopped).toMatchObject({ handled: true, outcome: 'member_stopped', count: 'intake' });
    await baoNamed();
    expect(await personRow(BAO_COPARENT)).toHaveLength(1);
    // Ada's household joins, so the chat keeps a host once Bao's household is gone.
    const joined = await takeMultiFamilyTurn(
      db.database,
      { ...turnInput(wire, 'in-join'), otherHandles: everyone, text: 'count us in' },
      { reader: joinReader, composer: fakeSharedGroupComposer({ body: SHARED_REPLY }) },
    );
    expect(joined).toMatchObject({ handled: true, outcome: 'joined' });

    await db.database
      .update(schema.families)
      .set({ scheduledDeletionAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000) })
      .where(eq(schema.families.id, bao.familyId));
    const summary = await runDeletionSweep(db.database, NOW, async () => {});
    expect(summary.erased).toBe(1);

    // Control: the household's unstopped row goes with it.
    expect(await personRow(BAO_COPARENT)).toEqual([]);
    const [tombstone, ...extra] = await personRow(PARENT_B);
    expect(extra).toEqual([]);
    expect(tombstone).toMatchObject({
      chatId: CHAT,
      familyId: null,
      userId: null,
      firstName: null,
      inferredKidName: null,
      inferredFamilyLabel: null,
      inferredRole: null,
    });
    expect(tombstone?.stoppedAt).toEqual(NOW);

    const groupBefore = wire.texts.length;
    const again = await takeMultiFamilyTurn(
      db.database,
      {
        ...turnInput(wire, 'in-back'),
        senderHandle: PARENT_B,
        otherHandles: [PARENT_A, PARENT_C],
        text: 'Hale is anyone free Saturday?',
      },
      ports(),
    );
    expect(again).toMatchObject({ handled: true, outcome: 'member_stopped', count: 'ignored' });
    expect(wire.texts.length).toBe(groupBefore);
    const [back] = await personRow(PARENT_B);
    expect(back).toMatchObject({ familyId: null, firstName: null, inferredKidName: null });
    expect(back?.stoppedAt).toEqual(NOW);
  });

  it('positive control: a parent who never stopped is forgotten when removed, and live again when re-added', async () => {
    const { wire } = await twoPresent();
    await takeMultiFamilyTurn(db.database, turnInput(wire, 'in-first'), ports());
    await baoNamed();
    expect(await personRow(PARENT_B)).toHaveLength(1);

    await removedAtTheDoor(PARENT_B, false);

    expect(await personRow(PARENT_B)).toEqual([]);
    const m = fakeModel('clash');
    const dm = fakeOneToOne();
    await takeMultiFamilyTurn(
      db.database,
      {
        ...turnInput(wire, 'in-ada'),
        privateAside: {
          model: m.model,
          sendOneToOne: privateAsideOneToOne(db.database, { now: NOW, send: dm.send }),
        },
      },
      ports(),
    );
    expect(dm.sent).toEqual([{ to: PARENT_B, body: `aside:${CHILD}` }]);
    const [back] = await personRow(PARENT_B);
    expect(back?.stoppedAt).toBeNull();
    expect(back?.firstName).toBeNull();
  });
});
