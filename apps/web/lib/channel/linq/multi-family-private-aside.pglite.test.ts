import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { type OneToOneSend, privateAsideOneToOne } from './connect-link-1to1';
import {
  PRIVATE_ASIDE_AUDIT,
  type PrivateAsideDraftInput,
  type PrivateAsideModel,
  type PrivateAsideReadInput,
} from './group-private-aside';
import { joinFamilyToSharedGroup, takeMultiFamilyTurn } from './multi-family';
import type { SharedGroupReader } from './shared-group-reading';
import { fakeSharedGroupComposer } from './shared-group-voice-fake';

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

async function twoJoined() {
  const ada = await seedFamily(PARENT_A, 'Ada');
  const bao = await seedFamily(PARENT_B, 'Bao');
  await seedPrivate(bao.familyId);
  const wire = sender();
  for (const [fam, phone] of [
    [ada, PARENT_A],
    [bao, PARENT_B],
  ] as const) {
    await joinFamilyToSharedGroup(db.database, {
      chatId: CHAT,
      familyId: fam.familyId,
      userId: fam.userId,
      phone,
      verbatim: 'our family is in this group',
      now: NOW,
      send: wire.send,
    });
  }
  return { ada, bao, wire };
}

/** 'clash' picks the family whose own facts name the kid (refs follow join order, which can tie). */
function fakeModel(read: 'clash' | string[] | Error) {
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
  text: 'Hale can everyone do the park Saturday at 10am?',
  providerMessageId,
  receivedAt: NOW,
  now: NOW,
  send: wire.send,
});

describe('VIL-457 shared-group turn wires the private aside', () => {
  it('texts the clashing family 1:1 with its own facts; the group line carries none', async () => {
    const { bao, wire } = await twoJoined();
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
  });

  it('sends nothing 1:1 when the read picks no family', async () => {
    const { wire } = await twoJoined();
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
    const { wire } = await twoJoined();
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
    const { wire } = await twoJoined();
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
    const { wire } = await twoJoined();
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
      const { bao, wire } = await twoJoined();
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

  it('group quiet and no family touched: hands the message back (no hold-stealing)', async () => {
    const { wire } = await twoJoined();
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

  it('a redelivered message after a quiet group does not aside twice', async () => {
    const { wire } = await twoJoined();
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
