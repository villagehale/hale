import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  PRIVATE_ASIDE_AUDIT,
  type PrivateAsideDraftInput,
  type PrivateAsideModel,
  type PrivateAsideReadInput,
  runPrivateAside,
} from './group-private-aside';
import { joinFamilyToSharedGroup, leaveFamilyFromSharedGroup } from './multi-family';

// VIL-457. The model is a recorder here: these tests check FACTS code owns (who the
// draft may see, who gets the text, how many per turn, nothing on failure). What the
// words mean is graded by the judge eval (run-group-private-aside-eval.mjs).

const KEY = Buffer.alloc(32, 7).toString('base64');
const FROM = '+16462352164';
const NOW = new Date('2026-10-28T15:00:00.000Z');
const CHAT = 'chat-private-aside';

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  for (const k of [
    'ANTHROPIC_API_KEY',
    'AI_GATEWAY_API_KEY',
    'LINQ_API_KEY',
    'LINQ_API_TOKEN',
    'DATABASE_URL',
    'BROWSER_USE_API_KEY',
  ])
    vi.stubEnv(k, '');
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_FROM_E164', FROM);
  vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'true');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

async function seedFamily(phone: string, name: string, kid: string, memory: string) {
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
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId, role: 'primary_parent' });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  await db.database
    .insert(schema.children)
    .values({ familyId, name: kid, dateOfBirth: '2019-04-01' });
  await db.database.insert(schema.familyMemoryFacts).values({
    familyId,
    factType: 'preference',
    factKey: memory,
    factValue: { note: memory },
  });
  return { familyId, userId, phone };
}

async function join(f: { familyId: string; userId: string; phone: string }, at: Date) {
  await joinFamilyToSharedGroup(db.database, {
    chatId: CHAT,
    familyId: f.familyId,
    userId: f.userId,
    phone: f.phone,
    verbatim: 'our family is in this group',
    now: at,
    send: async () => ({ providerMessageId: 'x' }),
  });
}

/** Two joined families: Ada (kid Maya) joins first = f1, Bao (kid Leo) second = f2. */
async function twoFamilies() {
  const ada = await seedFamily('+14165550111', 'Ada', 'Maya', 'maya-swim-tuesdays');
  const bao = await seedFamily('+14165550222', 'Bao', 'Leo', 'leo-ot-saturday');
  await join(ada, NOW);
  await join(bao, new Date(NOW.getTime() + 1000));
  return { ada, bao };
}

function recorder(opts: {
  read: string | null | Error;
  draft?: { send: boolean; text: string } | null;
}) {
  const reads: PrivateAsideReadInput[] = [];
  const drafts: PrivateAsideDraftInput[] = [];
  const sent: { familyId: string; text: string; dedupeKey: string }[] = [];
  const model: PrivateAsideModel = {
    async read(input) {
      reads.push(input);
      if (opts.read instanceof Error) throw opts.read;
      return opts.read;
    },
    async draft(input) {
      drafts.push(input);
      return opts.draft === undefined ? { send: true, text: 'private note' } : opts.draft;
    },
  };
  const sendOneToOne = async (input: { familyId: string; text: string; dedupeKey: string }) => {
    sent.push(input);
    return 'sent' as const;
  };
  return { model, sendOneToOne, reads, drafts, sent };
}

const turn = (over: Partial<Parameters<typeof runPrivateAside>[2]> = {}) => ({
  chatId: CHAT,
  inboundId: 'inbound-1',
  text: "what's Leo doing Saturday?",
  senderFamilyId: null,
  recent: [],
  language: null,
  ...over,
});

describe('VIL-457 private aside', () => {
  it("sends the private part 1:1 to the family it belongs to, and the draft sees only that family's data", async () => {
    const { ada, bao } = await twoFamilies();
    const r = recorder({ read: 'f2' });
    const out = await runPrivateAside(db.database, r, turn({ senderFamilyId: ada.familyId }));

    expect(out).toEqual({ outcome: 'sent', familyId: bao.familyId });
    expect(r.reads[0]?.senderFamily).toBe('f1');
    expect(r.reads[0]?.families.map((f) => f.ref)).toEqual(['f1', 'f2']);
    // The read gets refs and kid names only: no memory, inbox or sign-ups.
    expect(JSON.stringify(r.reads[0])).not.toContain('leo-ot-saturday');
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]?.askedByThisFamily).toBe(false);
    expect(r.drafts[0]?.private.memory).toEqual(['leo-ot-saturday']);
    expect(JSON.stringify(r.drafts[0])).not.toContain('Maya');
    expect(JSON.stringify(r.drafts[0])).not.toContain('maya-swim-tuesdays');
    expect(r.sent).toEqual([
      {
        familyId: bao.familyId,
        text: 'private note',
        dedupeKey: `linq:private_aside:${CHAT}:inbound-1`,
      },
    ]);
  });

  it("answers a family's own private question 1:1 to that same family", async () => {
    const { ada } = await twoFamilies();
    const r = recorder({ read: 'f1' });
    const out = await runPrivateAside(
      db.database,
      r,
      turn({ text: 'hale did my card get charged for swim?', senderFamilyId: ada.familyId }),
    );
    expect(out).toEqual({ outcome: 'sent', familyId: ada.familyId });
    expect(r.drafts[0]?.askedByThisFamily).toBe(true);
    expect(r.sent.map((s) => s.familyId)).toEqual([ada.familyId]);
  });

  it('sends at most one aside per inbound group message', async () => {
    await twoFamilies();
    const r = recorder({ read: 'f2' });
    await runPrivateAside(db.database, r, turn());
    const again = await runPrivateAside(db.database, r, turn());
    expect(again).toEqual({ outcome: 'already_handled' });
    expect(r.sent).toHaveLength(1);
    const rows = await db.database
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actionTaken, PRIVATE_ASIDE_AUDIT),
          eq(schema.auditLog.targetId, 'inbound-1'),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it.each([
    ['a failed read', { read: null }, 'read_failed'],
    ['a thrown read', { read: new Error('boom') }, null],
    ['a failed draft', { read: 'f2', draft: null }, 'draft_failed'],
    ['a declined draft', { read: 'f2', draft: { send: false, text: '' } }, 'declined'],
    ['an empty draft', { read: 'f2', draft: { send: true, text: '   ' } }, 'declined'],
    ['a read of none', { read: 'none' }, 'none'],
    ['a ref outside this chat', { read: 'f9' }, 'unknown_ref'],
  ] as const)('sends nothing on %s', async (_label, opts, outcome) => {
    await twoFamilies();
    const r = recorder(opts as Parameters<typeof recorder>[0]);
    const run = runPrivateAside(db.database, r, turn());
    if (outcome === null) await expect(run).rejects.toThrow();
    else expect((await run).outcome).toBe(outcome);
    expect(r.sent).toHaveLength(0);
    const rows = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, PRIVATE_ASIDE_AUDIT));
    expect(rows).toHaveLength(0);
  });

  it('never addresses a family that left the chat, and does nothing with no joined family', async () => {
    const { ada, bao } = await twoFamilies();
    await leaveFamilyFromSharedGroup(db.database, {
      chatId: CHAT,
      familyId: bao.familyId,
      userId: bao.userId,
      verbatim: 'we are leaving',
      now: NOW,
      send: async () => ({ providerMessageId: 'x' }),
    });
    const r = recorder({ read: 'f2' });
    const out = await runPrivateAside(db.database, r, turn({ senderFamilyId: ada.familyId }));
    expect(out).toEqual({ outcome: 'unknown_ref', ref: 'f2' });
    expect(r.reads[0]?.families.map((f) => f.ref)).toEqual(['f1']);
    expect(r.sent).toHaveLength(0);

    await db.exec('truncate table linq_multi_family_joins cascade');
    expect(await runPrivateAside(db.database, recorder({ read: 'f1' }), turn())).toEqual({
      outcome: 'no_families',
    });
  });
});
