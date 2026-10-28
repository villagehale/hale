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
  clockBearingFacts,
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

type Draft = { send: boolean; about: string; text: string } | null;

function recorder(opts: {
  read: string[] | null | Error;
  draft?: Draft | ((input: PrivateAsideDraftInput) => Draft);
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
      if (typeof opts.draft === 'function') return opts.draft(input);
      return opts.draft === undefined
        ? { send: true, about: 'own conflict', text: `note:${input.private.children[0]}` }
        : opts.draft;
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
  text: 'Hale can everyone do the park Saturday at 10?',
  senderFamilyId: null,
  recent: [],
  language: null,
  ...over,
});

async function asideRows() {
  return db.database
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.actionTaken, PRIVATE_ASIDE_AUDIT));
}

describe('VIL-457 private aside', () => {
  it('a clash across families: each family gets one text, and each draft sees only its own data', async () => {
    const { ada, bao } = await twoFamilies();
    const r = recorder({ read: ['f1', 'f2'] });
    const out = await runPrivateAside(db.database, r, turn({ senderFamilyId: ada.familyId }));

    expect(out).toEqual({
      outcome: 'ran',
      families: [
        { familyId: ada.familyId, outcome: 'sent' },
        { familyId: bao.familyId, outcome: 'sent' },
      ],
    });
    // The read gets refs, kid names, and clock facts: no memory, inbox or sign-ups.
    expect(r.reads[0]?.senderFamily).toBe('f1');
    expect(r.reads[0]?.planTimes).toEqual([]);
    expect(r.reads[0]?.families.map((f) => f.times)).toEqual([[], []]);
    expect(r.drafts[0]?.ownTimes).toEqual([]);
    expect(JSON.stringify(r.reads[0])).not.toContain('leo-ot-saturday');
    expect(r.drafts).toHaveLength(2);
    expect(r.drafts[0]?.private.memory).toEqual(['maya-swim-tuesdays']);
    expect(JSON.stringify(r.drafts[0])).not.toMatch(/Leo|leo-ot-saturday/);
    expect(r.drafts[1]?.private.memory).toEqual(['leo-ot-saturday']);
    expect(JSON.stringify(r.drafts[1])).not.toMatch(/Maya|maya-swim-tuesdays/);
    expect(r.sent.map((s) => [s.familyId, s.text])).toEqual([
      [ada.familyId, 'note:Maya'],
      [bao.familyId, 'note:Leo'],
    ]);
    expect(r.sent[1]?.dedupeKey).toBe(`linq:private_aside:${CHAT}:inbound-1:${bao.familyId}`);
    expect(await asideRows()).toHaveLength(2);
  });

  it("answers a family's own private question 1:1 to that same family", async () => {
    const { ada } = await twoFamilies();
    const r = recorder({ read: ['f1'] });
    const out = await runPrivateAside(
      db.database,
      r,
      turn({ text: 'hale did my card get charged for swim?', senderFamilyId: ada.familyId }),
    );
    expect(out).toEqual({
      outcome: 'ran',
      families: [{ familyId: ada.familyId, outcome: 'sent' }],
    });
    expect(r.drafts[0]?.askedByThisFamily).toBe(true);
    expect(r.sent.map((s) => s.familyId)).toEqual([ada.familyId]);
  });

  it('another family asking about a kid sends nothing 1:1 (the read returns no family)', async () => {
    const { ada } = await twoFamilies();
    const r = recorder({ read: [] });
    const out = await runPrivateAside(
      db.database,
      r,
      turn({ text: "hale what's Leo doing Saturday?", senderFamilyId: ada.familyId }),
    );
    expect(out).toEqual({ outcome: 'none' });
    expect(r.drafts).toHaveLength(0);
    expect(r.sent).toHaveLength(0);
    expect(await asideRows()).toHaveLength(0);
  });

  it('caps at one text per (group message, family)', async () => {
    const { ada, bao } = await twoFamilies();
    await runPrivateAside(db.database, recorder({ read: ['f1'] }), turn());
    const r = recorder({ read: ['f1', 'f2'] });
    const again = await runPrivateAside(db.database, r, turn());
    expect(again).toEqual({
      outcome: 'ran',
      families: [
        { familyId: ada.familyId, outcome: 'already_handled' },
        { familyId: bao.familyId, outcome: 'sent' },
      ],
    });
    expect(r.sent.map((s) => s.familyId)).toEqual([bao.familyId]);
    const rows = await db.database
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actionTaken, PRIVATE_ASIDE_AUDIT),
          eq(schema.auditLog.targetId, 'inbound-1'),
        ),
      );
    expect(rows).toHaveLength(2);
  });

  it("gives the draft that family's own last aside, holds a repeat back, and sends a real change", async () => {
    const { ada, bao } = await twoFamilies();
    await runPrivateAside(
      db.database,
      recorder({ read: ['f2'], draft: { send: true, about: 'Leo OT Sat 10', text: 'first' } }),
      turn(),
    );

    // A second message on the same thing: the draft sees the last aside and declines.
    const repeat = recorder({ read: ['f1', 'f2'], draft: { send: false, about: '', text: '' } });
    const held = await runPrivateAside(
      db.database,
      repeat,
      turn({ inboundId: 'inbound-2', text: 'so Saturday at 10 then?' }),
    );
    expect(held).toEqual({
      outcome: 'ran',
      families: [
        { familyId: ada.familyId, outcome: 'declined' },
        { familyId: bao.familyId, outcome: 'declined' },
      ],
    });
    expect(repeat.drafts[0]?.lastAside).toBeNull(); // Ada never got one; Bao's is not hers.
    expect(repeat.drafts[1]?.lastAside).toMatchObject({ about: 'Leo OT Sat 10', text: 'first' });
    expect(repeat.sent).toHaveLength(0);

    // The time moves: the draft decides it is new and sends.
    const change = recorder({
      read: ['f2'],
      draft: { send: true, about: 'Leo OT vs Sat 11', text: 'second' },
    });
    const sent = await runPrivateAside(
      db.database,
      change,
      turn({ inboundId: 'inbound-3', text: 'actually can we move it to 11?' }),
    );
    expect(sent).toEqual({
      outcome: 'ran',
      families: [{ familyId: bao.familyId, outcome: 'sent' }],
    });
    expect(change.drafts[0]?.lastAside).toMatchObject({ text: 'first' });

    // Next time the newest delivered aside is the one shown.
    const next = recorder({ read: ['f2'], draft: { send: false, about: '', text: '' } });
    await runPrivateAside(db.database, next, turn({ inboundId: 'inbound-4' }));
    expect(next.drafts[0]?.lastAside).toMatchObject({ about: 'Leo OT vs Sat 11', text: 'second' });
  });

  it.each([
    ['a failed read', { read: null }, 'read_failed'],
    ['a thrown read', { read: new Error('boom') }, null],
    ['an empty read', { read: [] }, 'none'],
    ['a ref outside this chat', { read: ['f2', 'f9'] }, 'unknown_ref'],
    ['a failed draft', { read: ['f2'], draft: null }, 'draft_failed'],
    ['a declined draft', { read: ['f2'], draft: { send: false, about: '', text: '' } }, 'declined'],
    [
      'an empty draft',
      { read: ['f2'], draft: { send: true, about: 'x', text: '   ' } },
      'declined',
    ],
  ] as const)('sends nothing on %s', async (_label, opts, outcome) => {
    await twoFamilies();
    const r = recorder(opts as unknown as Parameters<typeof recorder>[0]);
    const run = runPrivateAside(db.database, r, turn());
    if (outcome === null) await expect(run).rejects.toThrow();
    else {
      const out = await run;
      const got = out.outcome === 'ran' ? out.families[0]?.outcome : out.outcome;
      expect(got).toBe(outcome);
    }
    expect(r.sent).toHaveLength(0);
    expect(await asideRows()).toHaveLength(0);
  });

  it('never addresses a family that left or never joined, and does nothing with no joined family', async () => {
    const { ada, bao } = await twoFamilies();
    const outsider = await seedFamily('+14165550333', 'Cy', 'Zoe', 'zoe-private');
    await leaveFamilyFromSharedGroup(db.database, {
      chatId: CHAT,
      familyId: bao.familyId,
      userId: bao.userId,
      verbatim: 'we are leaving',
      now: NOW,
      send: async () => ({ providerMessageId: 'x' }),
    });
    const r = recorder({ read: ['f2'] });
    const out = await runPrivateAside(db.database, r, turn({ senderFamilyId: ada.familyId }));
    expect(out).toEqual({ outcome: 'unknown_ref', refs: ['f2'] });
    // Only Ada is listed: Bao left and Cy never joined or consented.
    expect(r.reads[0]?.families.map((f) => f.ref)).toEqual(['f1']);
    expect(JSON.stringify(r.reads[0])).not.toMatch(/Leo|Zoe/);
    expect(r.sent.map((s) => s.familyId)).not.toContain(outsider.familyId);
    expect(r.sent).toHaveLength(0);

    await db.exec('truncate table linq_multi_family_joins cascade');
    expect(await runPrivateAside(db.database, recorder({ read: ['f1'] }), turn())).toEqual({
      outcome: 'no_families',
    });
  });

  it("hands the read and draft the plan and this family's event times as facts", async () => {
    const ada = await seedFamily(
      '+14165550111',
      'Ada',
      'Maya',
      'Maya sees a speech therapist on Saturdays at 10am',
    );
    const bao = await seedFamily(
      '+14165550222',
      'Bao',
      'Leo',
      'Leo has occupational therapy Saturday 10-11am at Bloorview',
    );
    await join(ada, NOW);
    await join(bao, new Date(NOW.getTime() + 1000));
    const r = recorder({ read: ['f2'] });
    await runPrivateAside(
      db.database,
      r,
      turn({ text: 'Hale, on peut tous se retrouver au parc samedi à 9h, pour une heure ?' }),
    );
    expect(r.reads[0]?.planTimes).toEqual([
      'Hale, on peut tous se retrouver au parc samedi à 9h, pour une heure ?',
    ]);
    expect(r.reads[0]?.families.map((f) => [f.ref, f.times])).toEqual([
      ['f1', ['Maya sees a speech therapist on Saturdays at 10am']],
      ['f2', ['Leo has occupational therapy Saturday 10-11am at Bloorview']],
    ]);
    expect(JSON.stringify(r.reads[0]?.families[0])).not.toMatch(/Leo|Bloorview/);
    expect(r.drafts[0]?.planTimes).toEqual(r.reads[0]?.planTimes);
    expect(r.drafts[0]?.ownTimes).toEqual([
      'Leo has occupational therapy Saturday 10-11am at Bloorview',
    ]);
    expect(JSON.stringify(r.drafts[0])).not.toMatch(/Maya|speech/);
  });
});

describe('clockBearingFacts', () => {
  it('keeps strings that carry a clock, and drops ones that do not', () => {
    expect(
      clockBearingFacts([
        'Hale, on peut tous se retrouver au parc samedi à 9h, pour une heure ?',
        'Maya sees a speech therapist on Saturdays at 10am',
        'Leo has occupational therapy Saturday 10-11am at Bloorview',
        'Zoé est en garde partagée, chez son père le samedi',
        'Natation, samedi 9h',
        'Receipt: Little Fins Swim, fall session, $240 charged to Visa ending 4411',
      ]),
    ).toEqual([
      'Hale, on peut tous se retrouver au parc samedi à 9h, pour une heure ?',
      'Maya sees a speech therapist on Saturdays at 10am',
      'Leo has occupational therapy Saturday 10-11am at Bloorview',
      'Natation, samedi 9h',
    ]);
  });
});
