import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { forgetSharedGroupPeople, takeMultiFamilyTurn } from '~/lib/channel/linq/multi-family';
import type { ListChatHandles } from '~/lib/channel/linq/roster';
import type {
  SharedGroupReader,
  SharedGroupReading,
} from '~/lib/channel/linq/shared-group-reading';
import { fakeSharedGroupComposer } from '~/lib/channel/linq/shared-group-voice-fake';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  type SharedListPerson,
  type SharedListTurnContext,
  type SharedListTurnInput,
  type SharedListTurnModel,
  applySharedListTurn,
  readSharedListForAudience,
  readSharedListTurn,
  sharedListAudience,
  sharedListLineUsable,
} from './shared-group-lists';

/**
 * VIL-687 over the REAL DDL. The model's reading is SCRIPTED: each test hands the code the
 * object a model would return, and checks what that reading can and cannot reach. The real
 * model's reading of varied wording is evals/run-shared-group-list-turn-eval.mjs.
 */
const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-11-20T15:00:00.000Z');
const CHAT = 'chat-party-gifts';

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
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table shared_group_list_items, linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_multi_family_ledger, audit_log, channel_messages, families, users cascade',
  );
});

type Decision = {
  listTurn: boolean;
  list: string | null;
  add: string[];
  claim: { item: string | null; text: string | null }[];
  release: string[];
  gift: { forKid: string | null; keepFromKidFamily: boolean; kidFamily: string[] };
  reply: string | null;
};

const NO_GIFT = { forKid: null, keepFromKidFamily: false, kidFamily: [] };

function decision(extra: Partial<Decision>): Decision {
  return {
    listTurn: true,
    list: null,
    add: [],
    claim: [],
    release: [],
    gift: NO_GIFT,
    reply: null,
    ...extra,
  };
}

/** Answers in order, recording what it was shown. A function answer runs first. */
function scripted(...answers: unknown[]) {
  const seen: SharedListTurnInput[] = [];
  const model: SharedListTurnModel = {
    async decide(input) {
      seen.push(input);
      if (answers.length === 0) throw new Error('scripted model: no answer left');
      const next = answers.shift();
      return typeof next === 'function' ? await next() : next;
    },
  };
  return { model, seen };
}

let phoneSeq = 0;
async function person(extra: Partial<typeof schema.linqSharedGroupPeople.$inferInsert> = {}) {
  phoneSeq += 1;
  const phone = `+1641555${String(1000 + phoneSeq).slice(-4)}`;
  const [row] = await db.database
    .insert(schema.linqSharedGroupPeople)
    .values({
      chatId: CHAT,
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      seatedAt: new Date(NOW.getTime() + phoneSeq),
      ...extra,
    })
    .returning();
  if (!row) throw new Error('person insert');
  return row;
}

async function family(name: string) {
  const [row] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  return row?.id as string;
}

let itemSeq = 0;
async function item(
  addedBy: string,
  text: string,
  extra: Partial<typeof schema.sharedGroupListItems.$inferInsert> = {},
) {
  itemSeq += 1;
  const [row] = await db.database
    .insert(schema.sharedGroupListItems)
    .values({
      chatId: CHAT,
      listName: 'Potluck',
      listKey: 'potluck',
      text,
      textKey: text.toLowerCase(),
      addedByPersonId: addedBy,
      addedAt: new Date(NOW.getTime() - 60_000 + itemSeq),
      ...extra,
    })
    .returning();
  if (!row) throw new Error('item insert');
  return row;
}

const items = () => db.database.select().from(schema.sharedGroupListItems);

/** The list as these people may see it, through the production audience loader. */
const visibleTo = async (...people: SharedListPerson[]) =>
  readSharedListForAudience(db.database, CHAT, await sharedListAudience(db.database, people));

function context(speaker: SharedListPerson, people: SharedListPerson[], text = 'msg') {
  return {
    chatId: CHAT,
    text,
    language: null,
    speaker,
    people,
    haleKids: new Map(),
  } satisfies SharedListTurnContext;
}

async function turn(ctx: SharedListTurnContext, model: SharedListTurnModel, deny: string[] = []) {
  const read = await readSharedListTurn(db.database, ctx, model);
  return applySharedListTurn(db.database, ctx, read, {
    model,
    now: NOW,
    deny: async () => deny,
  });
}

describe('shared list owners', () => {
  it('gives a new gift to the person who claimed it, and says the line', async () => {
    const sam = await person();
    const ada = await person();
    const { model } = scripted(
      decision({
        list: 'Gifts for Mia',
        claim: [{ item: null, text: 'Lego for Mia' }],
        reply: 'Nice, the Lego is yours.',
      }),
    );
    const out = await turn(context(sam, [sam, ada], "I'll get Mia the Lego"), model);
    expect(out).toEqual({
      handled: true,
      line: 'Nice, the Lego is yours.',
      lineWhy: 'model',
      counts: { claimed: 1 },
    });
    const [row] = await items();
    expect(row).toMatchObject({
      listName: 'Gifts for Mia',
      text: 'Lego for Mia',
      ownerPersonId: sam.id,
      addedByPersonId: sam.id,
      claimedAt: NOW,
      hiddenForKid: null,
    });
  });

  it('owns an open item by ref, and a second claim keeps the first owner and is said', async () => {
    const sam = await person({ firstName: 'Sam' });
    const ada = await person();
    const salad = await item(ada.id, 'salad');
    const first = scripted(decision({ claim: [{ item: 'i1', text: null }], reply: null }));
    expect(await turn(context(sam, [sam, ada], 'we will bring the salad'), first.model)).toEqual({
      handled: true,
      line: null,
      lineWhy: 'quiet',
      counts: { claimed: 1 },
    });
    expect(first.seen[0]?.items).toEqual([
      { ref: 'i1', list: 'Potluck', text: 'salad', owner: null, secret: false, forKid: null },
    ]);

    const second = scripted(
      decision({ claim: [{ item: 'i1', text: null }], reply: 'Sam already has the salad.' }),
    );
    const out = await turn(context(ada, [sam, ada], "I'll do salad"), second.model);
    // The model saw Sam as the owner, so the line it wrote matches what happened.
    expect(second.seen[0]?.items[0]?.owner).toBe('p1');
    expect(out).toEqual({
      handled: true,
      line: 'Sam already has the salad.',
      lineWhy: 'model',
      counts: { taken: 1 },
    });
    const [row] = await db.database
      .select()
      .from(schema.sharedGroupListItems)
      .where(eq(schema.sharedGroupListItems.id, salad.id));
    expect(row?.ownerPersonId).toBe(sam.id);
  });

  it('answers "what\'s left" from the list it was shown, writing nothing', async () => {
    const sam = await person();
    const ada = await person();
    await item(ada.id, 'salad', { ownerPersonId: sam.id });
    await item(ada.id, 'drinks');
    const { model, seen } = scripted(decision({ reply: 'Drinks are still open.' }));
    const out = await turn(context(ada, [sam, ada], "what's left?"), model);
    expect(seen[0]?.items.map((i) => [i.text, i.owner])).toEqual([
      ['salad', 'p1'],
      ['drinks', null],
    ]);
    expect(out).toEqual({
      handled: true,
      line: 'Drinks are still open.',
      lineWhy: 'model',
      counts: {},
    });
  });

  it('re-reads once when someone claimed between the read and the write', async () => {
    const sam = await person();
    const ada = await person();
    const priya = await person();
    const drinks = await item(ada.id, 'drinks');
    const ctx = context(sam, [sam, ada, priya], 'we have drinks');
    const { model, seen } = scripted(
      decision({ claim: [{ item: 'i1', text: null }], reply: 'Drinks are yours.' }),
      decision({ claim: [{ item: 'i1', text: null }], reply: 'Someone beat you to drinks.' }),
    );
    const read = await readSharedListTurn(db.database, ctx, model);
    // Priya takes it after the model read an open item.
    await db.database
      .update(schema.sharedGroupListItems)
      .set({ ownerPersonId: priya.id })
      .where(eq(schema.sharedGroupListItems.id, drinks.id));
    const out = await applySharedListTurn(db.database, ctx, read, {
      model,
      now: NOW,
      deny: async () => [],
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.items[0]?.owner).toBe('p3');
    expect(out).toEqual({
      handled: true,
      line: 'Someone beat you to drinks.',
      lineWhy: 'model',
      counts: { taken: 2 },
    });
  });

  it('sends nothing when the list moves again under the second read', async () => {
    const sam = await person();
    const ada = await person();
    const priya = await person();
    const drinks = await item(ada.id, 'drinks');
    const ctx = context(sam, [sam, ada, priya]);
    const setOwner = (owner: string | null) =>
      db.database
        .update(schema.sharedGroupListItems)
        .set({ ownerPersonId: owner })
        .where(eq(schema.sharedGroupListItems.id, drinks.id));
    const claim = decision({ claim: [{ item: 'i1', text: null }], reply: 'Drinks?' });
    const { model, seen } = scripted(claim, async () => {
      // Priya lets it go while the second read is out: what it saw is stale again.
      await setOwner(null);
      return claim;
    });
    const read = await readSharedListTurn(db.database, ctx, model);
    await setOwner(priya.id);
    expect(
      await applySharedListTurn(db.database, ctx, read, { model, now: NOW, deny: async () => [] }),
    ).toEqual({ handled: true, line: null, lineWhy: 'race', counts: { taken: 1, claimed: 1 } });
    expect(seen).toHaveLength(2);
  });

  it("releases only the speaker's own claim", async () => {
    const sam = await person();
    const ada = await person();
    await item(ada.id, 'cupcakes', { ownerPersonId: sam.id });
    await item(ada.id, 'plates', { ownerPersonId: ada.id });
    const { model } = scripted(decision({ release: ['i1'], reply: null }));
    expect(await turn(context(sam, [sam, ada], "can't do cupcakes"), model)).toMatchObject({
      counts: { released: 1 },
    });
    const forged = scripted(decision({ release: ['i2'], reply: null }));
    expect(await turn(context(sam, [sam, ada]), forged.model)).toMatchObject({
      counts: { not_yours: 1 },
    });
    const rows = await items();
    expect(rows.find((r) => r.text === 'cupcakes')?.ownerPersonId).toBeNull();
    expect(rows.find((r) => r.text === 'plates')?.ownerPersonId).toBe(ada.id);
  });

  it('refuses a ref the model was not shown, then hands the turn on', async () => {
    const sam = await person();
    const bad = decision({ claim: [{ item: 'i9', text: null }], reply: 'Done.' });
    const { model, seen } = scripted(bad, bad);
    const out = await turn(context(sam, [sam]), model);
    expect(seen).toHaveLength(2);
    expect(out).toEqual({ handled: false, why: 'unread' });
    expect(await items()).toEqual([]);
  });

  it('hands a message that is not about a list on, writing nothing', async () => {
    const sam = await person();
    const { model } = scripted({ ...decision({}), listTurn: false });
    expect(await turn(context(sam, [sam]), model)).toEqual({ handled: false, why: 'none' });
  });

  it('names a missing model instead of reading nothing silently', async () => {
    const sam = await person();
    const read = await readSharedListTurn(db.database, context(sam, [sam]), null);
    expect(read).toEqual({ kind: 'unavailable' });
  });
});

describe('hidden gifts', () => {
  async function partyChat() {
    const adaFamily = await family('Ada');
    const ada = await person({ familyId: adaFamily, inferredKidName: 'Mia' });
    const jordan = await person({ familyId: adaFamily });
    const sam = await person({ firstName: 'Sam' });
    const priya = await person();
    const later = await person({ inferredKidName: 'mia chen' });
    return { adaFamily, ada, jordan, sam, priya, later };
  }

  it("keeps a secret gift from the parent the model named, her co-parent, and anyone who says they are the child's parent", async () => {
    const { adaFamily, ada, jordan, sam, priya, later } = await partyChat();
    const { model } = scripted(
      decision({
        list: 'Gifts for Mia',
        claim: [{ item: null, text: 'Lego for Mia' }],
        gift: { forKid: 'Mia', keepFromKidFamily: true, kidFamily: ['p1'] },
        reply: 'Lego is yours.',
      }),
    );
    // Ada is in the chat, so the write stands and the line is never sent.
    const out = await turn(context(sam, [ada, sam, priya], "I'll get Mia the Lego"), model);
    expect(out).toEqual({
      handled: true,
      line: null,
      lineWhy: 'withheld',
      counts: { claimed: 1 },
    });
    const [row] = await items();
    expect(row).toMatchObject({
      ownerPersonId: sam.id,
      hiddenForKid: 'Mia',
      hiddenFromPersonIds: [ada.id],
      hiddenFromFamilyIds: [adaFamily],
    });

    // Positive control: an audience without Mia's family sees it, marked secret.
    const outside = await visibleTo(sam, priya);
    expect(outside.items.map((i) => [i.text, i.secret, i.forKid])).toEqual([
      ['Lego for Mia', true, 'Mia'],
    ]);
    for (const viewer of [ada, jordan, later]) {
      const seen = await visibleTo(sam, viewer);
      expect(seen).toEqual({ items: [], omitted: 0 });
    }
  });

  it("says the claim when the child's family is not in the chat, and hides it once one of them is", async () => {
    const { sam, priya, later } = await partyChat();
    const { model } = scripted(
      decision({
        list: 'Gifts for Mia',
        claim: [{ item: null, text: 'Lego for Mia' }],
        gift: { forKid: 'Mia', keepFromKidFamily: true, kidFamily: [] },
        reply: 'Lego is yours.',
      }),
    );
    const out = await turn(context(sam, [sam, priya], "I'll get Mia the Lego, shh"), model);
    expect(out).toMatchObject({ line: 'Lego is yours.', lineWhy: 'model' });
    expect((await visibleTo(priya)).items).toHaveLength(1);
    expect((await visibleTo(priya, later)).items).toEqual([]);
  });

  it("a turn that only asks never shows a secret gift to the child's family", async () => {
    const { ada, sam, priya } = await partyChat();
    await item(sam.id, 'Lego for Mia', {
      ownerPersonId: sam.id,
      hiddenForKid: 'Mia',
      hiddenFromPersonIds: [ada.id],
    });
    await item(priya.id, 'cake');
    const { model, seen } = scripted(decision({ reply: 'Cake is still open.' }));
    await turn(context(ada, [ada, sam, priya], "what's left?"), model);
    expect(seen[0]?.items.map((i) => i.text)).toEqual(['cake']);
  });

  it('a second claim on a secret gift the chat cannot see writes nothing and says nothing', async () => {
    const { ada, sam, priya } = await partyChat();
    await item(sam.id, 'Lego for Mia', {
      listName: 'Gifts for Mia',
      listKey: 'gifts for mia',
      textKey: 'lego for mia',
      ownerPersonId: sam.id,
      hiddenForKid: 'Mia',
      hiddenFromPersonIds: [ada.id],
    });
    const blind = decision({
      list: 'Gifts for Mia',
      claim: [{ item: null, text: 'Lego for Mia' }],
      reply: 'Lego is yours.',
    });
    const { model, seen } = scripted(blind, blind);
    const out = await turn(context(priya, [ada, sam, priya], 'I can get Mia Lego'), model);
    expect(seen[0]?.items).toEqual([]);
    expect(out).toEqual({ handled: true, line: null, lineWhy: 'race', counts: { held: 2 } });
    expect((await items())[0]?.ownerPersonId).toBe(sam.id);
  });

  it('keeps a potluck in the open when the model does not ask to hide it', async () => {
    const { ada, sam } = await partyChat();
    const { model } = scripted(
      decision({ list: 'Potluck', claim: [{ item: null, text: 'salad' }], reply: 'Salad, nice.' }),
    );
    expect(await turn(context(sam, [ada, sam]), model)).toMatchObject({ lineWhy: 'model' });
    const seen = await visibleTo(ada);
    expect(seen.items.map((i) => i.text)).toEqual(['salad']);
  });
});

describe('the line', () => {
  it('holds a household term nobody said in the chat, and lets one through that was said', () => {
    expect(sharedListLineUsable('Zephyrina gets the Lego', ['Zephyrina'], '{"text":"lego"}')).toBe(
      false,
    );
    expect(
      sharedListLineUsable(
        'Zephyrina gets the Lego',
        ['Zephyrina'],
        '{"text":"Lego for Zephyrina"}',
      ),
    ).toBe(true);
    expect(sharedListLineUsable('see https://x.example', [], '')).toBe(false);
    expect(sharedListLineUsable('call +1 416 555 0100', [], '')).toBe(false);
  });
});

describe('retention', () => {
  it('forgets the items a person added and frees the ones they held, tombstone included', async () => {
    const sam = await person();
    const stopped = await person({ stoppedAt: NOW });
    const ada = await person();
    await item(sam.id, 'salad');
    await item(stopped.id, 'cups');
    await item(ada.id, 'plates', { ownerPersonId: sam.id });
    await item(ada.id, 'napkins', { ownerPersonId: stopped.id });
    await forgetSharedGroupPeople(db.database, eq(schema.linqSharedGroupPeople.chatId, CHAT), NOW);
    expect(await items()).toEqual([]);

    const keep = await person();
    const gone = await person();
    await item(keep.id, 'plates', { ownerPersonId: gone.id });
    await item(gone.id, 'cups');
    await forgetSharedGroupPeople(db.database, eq(schema.linqSharedGroupPeople.id, gone.id), NOW);
    expect((await items()).map((r) => [r.text, r.ownerPersonId])).toEqual([['plates', null]]);
  });

  it.each([
    ['left', null],
    ['stopped', NOW],
  ])(
    'keeps what someone else claimed when the person who added it is forgotten (%s)',
    async (_, stoppedAt) => {
      const host = await person({ stoppedAt });
      const mei = await person();
      const stayer = await person();
      await item(host.id, 'salad', { ownerPersonId: mei.id });
      await item(host.id, 'cups');
      await item(host.id, 'napkins', { ownerPersonId: host.id });
      await item(mei.id, 'chips', { ownerPersonId: host.id });
      await item(stayer.id, 'ice');
      await forgetSharedGroupPeople(db.database, eq(schema.linqSharedGroupPeople.id, host.id), NOW);
      const rows = (await items()).map((r) => [r.text, r.ownerPersonId, r.addedByPersonId]).sort();
      expect(rows).toEqual([
        ['chips', null, mei.id],
        ['ice', null, stayer.id],
        ['salad', mei.id, mei.id],
      ]);
    },
  );
});

describe('in a multi-family group turn', () => {
  const FROM = '+16462352164';
  const MEI = '+16415550101';
  const ADA = '+16415550201';
  const GUEST = '+16415550303';

  function sender() {
    const texts: string[] = [];
    const send = async (notice: { chatId: string; text: string }) => {
      texts.push(notice.text);
      return { providerMessageId: `msg-${texts.length}` };
    };
    return { send, texts };
  }

  const listOf =
    (handles: readonly string[]): ListChatHandles =>
    async () => ({ status: 'ok', handles: [...handles], isGroup: true });

  function reading(intent: SharedGroupReading['intent']): SharedGroupReader {
    return {
      async read() {
        return { intent, role: 'unclear', familyLabel: null, kidName: null, confidence: 'high' };
      },
    };
  }

  async function parent(phone: string, name: string, haleKid?: string) {
    const familyId = await family(name);
    if (haleKid) {
      await db.database
        .insert(schema.children)
        .values({ familyId, name: haleKid, dateOfBirth: '2020-03-01' });
    }
    const [user] = await db.database
      .insert(schema.users)
      .values({ externalAuthId: `imessage:${name}-${phone}`, name })
      .returning({ id: schema.users.id });
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
    return { familyId, userId };
  }

  beforeEach(() => {
    vi.stubEnv('LINQ_FROM_E164', FROM);
    vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'true');
  });

  async function claimTurn(
    intent: SharedGroupReading['intent'],
    extra: { optOut?: boolean; answer?: Decision; adaKid?: string } = {},
  ) {
    await parent(MEI, 'Mei');
    const ada = await parent(ADA, 'Ada');
    if (extra.adaKid) {
      // Ada said in the chat whose parent she is.
      await db.database.insert(schema.linqSharedGroupPeople).values({
        chatId: CHAT,
        phoneE164Encrypted: encryptString(ADA),
        phoneE164Hash: phoneBlindIndex(ADA),
        familyId: ada.familyId,
        userId: ada.userId,
        inferredKidName: extra.adaKid,
      });
    }
    const wire = sender();
    const { model, seen } = scripted(
      extra.answer ??
        decision({
          list: 'Potluck',
          claim: [{ item: null, text: 'the salad' }],
          reply: 'Salad is yours.',
        }),
    );
    let asideReads = 0;
    const privateAside = {
      model: {
        async read() {
          asideReads += 1;
          return [];
        },
        async draft() {
          return null;
        },
      },
      sendOneToOne: async () => 'failed' as const,
    };
    const out = await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: MEI,
        text: "we'll bring the salad",
        providerMessageId: `in-${intent}`,
        receivedAt: NOW,
        now: NOW,
        send: wire.send,
        privateAside,
      },
      {
        listHandles: listOf([MEI, ADA, GUEST]),
        reader: reading(intent),
        composer: fakeSharedGroupComposer(),
        listTurn: model,
        ...(extra.optOut ? { optOut: async () => 'stop' as const } : {}),
      },
    );
    return { out, wire, seen, asideReads: () => asideReads };
  }

  it('a claim gets an owner, one line and an audit row with no item text', async () => {
    vi.stubEnv('GROUP_BRING_LIST_ENABLED', 'true');
    const { out, wire, asideReads } = await claimTurn('chatter');
    expect(out).toMatchObject({ handled: true, outcome: 'shared_list', notice: 'sent' });
    expect(asideReads()).toBe(1);
    expect(wire.texts).toEqual(['Salad is yours.']);
    const mei = (await db.database.select().from(schema.linqSharedGroupPeople)).find(
      (row) => row.phoneE164Hash === phoneBlindIndex(MEI),
    );
    expect((await items()).map((r) => [r.text, r.ownerPersonId])).toEqual([['the salad', mei?.id]]);
    const audits = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_multi_family_list_turn'));
    expect(audits).toEqual([{ after: { claimed: 1, line: 'model', notice: 'sent' } }]);
  });

  it('a turn that touched a secret gift sends nothing, in the group or 1:1', async () => {
    vi.stubEnv('GROUP_BRING_LIST_ENABLED', 'true');
    const { out, wire, asideReads } = await claimTurn('chatter', {
      adaKid: 'Zara',
      answer: decision({
        list: 'Gifts for Zara',
        claim: [{ item: null, text: 'Lego for Zara' }],
        gift: { forKid: 'Zara', keepFromKidFamily: true, kidFamily: [] },
        reply: 'Lego is yours.',
      }),
    });
    expect(out).toMatchObject({ handled: true, outcome: 'shared_list', notice: 'declined' });
    expect(wire.texts).toEqual([]);
    expect(asideReads()).toBe(0);
    expect((await items()).map((r) => [r.text, r.hiddenForKid])).toEqual([
      ['Lego for Zara', 'Zara'],
    ]);
  });

  it('a group question still goes to the list when the model reads a claim', async () => {
    vi.stubEnv('GROUP_BRING_LIST_ENABLED', 'true');
    const { out } = await claimTurn('question');
    expect(out).toMatchObject({ outcome: 'shared_list' });
  });

  describe('a Hale parent who never said whose parent she is', () => {
    const PRIYA = '+16415550202';

    async function say(
      from: string,
      text: string,
      id: string,
      handles: string[],
      answer: (input: SharedListTurnInput) => unknown,
      wire: ReturnType<typeof sender>,
    ) {
      const seen: SharedListTurnInput[] = [];
      const model: SharedListTurnModel = {
        async decide(input) {
          seen.push(input);
          return answer(input);
        },
      };
      const out = await takeMultiFamilyTurn(
        db.database,
        {
          chatId: CHAT,
          senderHandle: from,
          text,
          providerMessageId: id,
          receivedAt: NOW,
          now: NOW,
          send: wire.send,
        },
        {
          listHandles: listOf(handles),
          reader: reading('chatter'),
          composer: fakeSharedGroupComposer(),
          listTurn: model,
        },
      );
      return { out, seen };
    }

    /** Priya adds an open cake, then Mei claims a secret Lego for Mia before Ada is here. */
    async function secretBeforeAda(adaKid: string, forKid: string) {
      vi.stubEnv('GROUP_BRING_LIST_ENABLED', 'true');
      await parent(MEI, 'Mei');
      await parent(PRIYA, 'Priya');
      await parent(ADA, 'Ada', adaKid);
      const wire = sender();
      await say(
        PRIYA,
        'we still need a cake',
        'in-cake',
        [MEI, PRIYA],
        () => decision({ list: 'Party', add: ['cake'], reply: null }),
        wire,
      );
      const before = await say(
        MEI,
        `I'll get ${forKid} the Lego, keep it a surprise`,
        'in-lego',
        [MEI, PRIYA],
        () =>
          decision({
            list: `Gifts for ${forKid}`,
            claim: [{ item: null, text: `Lego for ${forKid}` }],
            gift: { forKid, keepFromKidFamily: true, kidFamily: [] },
            reply: 'Nice, the Lego is yours.',
          }),
        wire,
      );
      // Mia's family is not in the chat yet, so the line goes out.
      expect(before.out).toMatchObject({ outcome: 'shared_list', notice: 'sent' });
      wire.texts.length = 0;
      return wire;
    }

    it('never hands the model or the group a secret gift for her Hale child, even when she claims it', async () => {
      const wire = await secretBeforeAda('Mia', 'Mia');
      const lego = 'Lego for Mia';
      const { seen } = await say(
        ADA,
        "I'll get Mia the Lego",
        'in-ada',
        [MEI, PRIYA, ADA],
        (input) => {
          const shown = input.items.find((i) => i.text === lego);
          return shown
            ? decision({
                claim: [{ item: shown.ref, text: null }],
                reply: 'Someone already has the Lego for Mia.',
              })
            : decision({
                list: 'Gifts for Mia',
                claim: [{ item: null, text: lego }],
                reply: 'Lego is yours.',
              });
        },
        wire,
      );
      expect(seen.flatMap((input) => input.items.map((i) => i.text))).not.toContain(lego);
      expect(wire.texts).toEqual([]);
      const mei = (await db.database.select().from(schema.linqSharedGroupPeople)).find(
        (p) => p.phoneE164Hash === phoneBlindIndex(MEI),
      );
      expect((await items()).find((r) => r.text === lego)?.ownerPersonId).toBe(mei?.id);
    });

    it('a "what\'s left?" asked with her present names the open cake and never the secret gift', async () => {
      const wire = await secretBeforeAda('Mia', 'Mia');
      const { seen } = await say(
        PRIYA,
        "what's left?",
        'in-left',
        [MEI, PRIYA, ADA],
        () => decision({ reply: 'Cake is still open.' }),
        wire,
      );
      // Positive control: the open, non-secret cake is shown and the answer is sent.
      expect(seen.map((input) => input.items.map((i) => i.text))).toEqual([['cake']]);
      expect(wire.texts).toEqual(['Cake is still open.']);
    });

    it('matches her Hale child across case, accents and surrounding spaces', async () => {
      const wire = await secretBeforeAda(' Zoé ', 'ZOE');
      const { seen } = await say(
        PRIYA,
        "what's left?",
        'in-left',
        [MEI, PRIYA, ADA],
        () => decision({ reply: 'Cake is still open.' }),
        wire,
      );
      expect(seen.map((input) => input.items.map((i) => i.text))).toEqual([['cake']]);
    });
  });

  it('does not read lists while the flag is off', async () => {
    const { out, wire, seen } = await claimTurn('chatter');
    expect(seen).toEqual([]);
    expect(out).toEqual({ handled: false });
    expect(wire.texts).toEqual([]);
    expect(await items()).toEqual([]);
  });

  it('a stop wins over a claim read in the same message', async () => {
    vi.stubEnv('GROUP_BRING_LIST_ENABLED', 'true');
    const { out, wire } = await claimTurn('stop_me', { optOut: true });
    expect(out).toMatchObject({ outcome: 'member_stopped' });
    expect(await items()).toEqual([]);
    expect(wire.texts).not.toContain('Salad is yours.');
  });
});
