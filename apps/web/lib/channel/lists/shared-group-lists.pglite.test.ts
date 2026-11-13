import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { runDeletionSweep } from '~/lib/rights/delete';
import { assembleFamilyExport } from '~/lib/rights/export';
import {
  forgetSharedGroupPeople,
  forgetSharedGroupPresence,
  noticeSharedGroupAdded,
  takeMultiFamilyTurn,
} from '~/lib/channel/linq/multi-family';
import type { ListChatHandles } from '~/lib/channel/linq/roster';
import {
  type SharedGroupReader,
  type SharedGroupReading,
  parseSharedGroupReading,
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
  vi.unstubAllGlobals();
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

async function family(name: string, scheduledDeletionAt?: Date) {
  const [row] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON', scheduledDeletionAt })
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

/**
 * These people read the chat, all seated before this turn. Every other seat in the chat now
 * is known to the turn too (refs after theirs), as the real turn knows every seat it found.
 */
async function audienceOf(people: readonly SharedListPerson[]) {
  const ids = new Set(people.map((person) => person.id));
  const others = (
    await db.database
      .select()
      .from(schema.linqSharedGroupPeople)
      .where(eq(schema.linqSharedGroupPeople.chatId, CHAT))
  ).filter((seat) => !ids.has(seat.id));
  return sharedListAudience([...people, ...others], ids, async () =>
    people.map((person) => person.phoneE164Hash),
  );
}

/** The list as these people may see it, through the production audience. */
const visibleTo = async (...people: SharedListPerson[]) =>
  readSharedListForAudience(db.database, CHAT, await audienceOf(people));

async function context(speaker: SharedListPerson, people: SharedListPerson[], text = 'msg') {
  return {
    chatId: CHAT,
    text,
    language: null,
    speaker,
    ...(await audienceOf(people)),
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
    const out = await turn(await context(sam, [sam, ada], "I'll get Mia the Lego"), model);
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
    expect(
      await turn(await context(sam, [sam, ada], 'we will bring the salad'), first.model),
    ).toEqual({
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
    const out = await turn(await context(ada, [sam, ada], "I'll do salad"), second.model);
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
    const out = await turn(await context(ada, [sam, ada], "what's left?"), model);
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
    const ctx = await context(sam, [sam, ada, priya], 'we have drinks');
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
    const ctx = await context(sam, [sam, ada, priya]);
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
    expect(await turn(await context(sam, [sam, ada], "can't do cupcakes"), model)).toMatchObject({
      counts: { released: 1 },
    });
    const forged = scripted(decision({ release: ['i2'], reply: null }));
    expect(await turn(await context(sam, [sam, ada]), forged.model)).toMatchObject({
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
    const out = await turn(await context(sam, [sam]), model);
    expect(seen).toHaveLength(2);
    expect(out).toEqual({ handled: false, why: 'unread' });
    expect(await items()).toEqual([]);
  });

  it('hands a message that is not about a list on, writing nothing', async () => {
    const sam = await person();
    const { model } = scripted({ ...decision({}), listTurn: false });
    expect(await turn(await context(sam, [sam]), model)).toEqual({ handled: false, why: 'none' });
  });

  it('names a missing model instead of reading nothing silently', async () => {
    const sam = await person();
    const read = await readSharedListTurn(db.database, await context(sam, [sam]), null);
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
    const out = await turn(await context(sam, [ada, sam, priya], "I'll get Mia the Lego"), model);
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
    const out = await turn(await context(sam, [sam, priya], "I'll get Mia the Lego, shh"), model);
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
    await turn(await context(ada, [ada, sam, priya], "what's left?"), model);
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
    const out = await turn(await context(priya, [ada, sam, priya], 'I can get Mia Lego'), model);
    expect(seen[0]?.items).toEqual([]);
    // Withheld, not a race: a withheld turn keeps the 1:1 aside quiet too.
    expect(out).toEqual({ handled: true, line: null, lineWhy: 'withheld', counts: { held: 2 } });
    expect((await items())[0]?.ownerPersonId).toBe(sam.id);
  });

  it('does not clear someone who left while the model was reading, so their rejoin is new', async () => {
    const { sam, priya, later: guest } = await partyChat();
    const { model } = scripted(async () => {
      await forgetSharedGroupPeople(
        db.database,
        eq(schema.linqSharedGroupPeople.id, guest.id),
        NOW,
        'left',
      );
      return decision({
        list: 'Gifts for Leo',
        claim: [{ item: null, text: 'kite for Leo' }],
        gift: { forKid: 'Leo', keepFromKidFamily: true, kidFamily: [] },
        reply: 'Kite is yours.',
      });
    });
    await turn(await context(sam, [sam, priya, guest], "I'll get Leo a kite, shh"), model);
    const [row] = await items();
    expect(row?.hiddenClearedPhoneHashes.sort()).toEqual(
      [sam.phoneE164Hash, priya.phoneE164Hash].sort(),
    );
    const back = await person({ phoneE164Hash: guest.phoneE164Hash });
    expect((await visibleTo(sam, priya)).items).toHaveLength(1);
    expect((await visibleTo(sam, priya, back)).items).toEqual([]);
  });

  it('keeps a potluck in the open when the model does not ask to hide it', async () => {
    const { ada, sam } = await partyChat();
    const { model } = scripted(
      decision({ list: 'Potluck', claim: [{ item: null, text: 'salad' }], reply: 'Salad, nice.' }),
    );
    expect(await turn(await context(sam, [ada, sam]), model)).toMatchObject({ lineWhy: 'model' });
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
    await forgetSharedGroupPeople(
      db.database,
      eq(schema.linqSharedGroupPeople.chatId, CHAT),
      NOW,
      'left',
    );
    expect(await items()).toEqual([]);

    const keep = await person();
    const gone = await person();
    await item(keep.id, 'plates', { ownerPersonId: gone.id });
    await item(gone.id, 'cups');
    await forgetSharedGroupPeople(
      db.database,
      eq(schema.linqSharedGroupPeople.id, gone.id),
      NOW,
      'left',
    );
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
      await forgetSharedGroupPeople(
        db.database,
        eq(schema.linqSharedGroupPeople.id, host.id),
        NOW,
        'left',
      );
      const rows = (await items()).map((r) => [r.text, r.ownerPersonId, r.addedByPersonId]).sort();
      expect(rows).toEqual([
        ['chips', null, mei.id],
        ['ice', null, stayer.id],
        ['salad', mei.id, mei.id],
      ]);
    },
  );

  it("erasure deletes everything the erased person added, claimed or not, and frees what they held; other families' items stay", async () => {
    const erasedFamily = await family('Erased', new Date(NOW.getTime() - 24 * 60 * 60 * 1000));
    const meiFamily = await family('Mei');
    const erased = await person({ familyId: erasedFamily });
    const mei = await person({ familyId: meiFamily });
    const stayer = await person();
    await item(erased.id, 'salad', { ownerPersonId: mei.id });
    await item(erased.id, 'cups');
    await item(mei.id, 'chips', { ownerPersonId: erased.id });
    await item(mei.id, 'plates', { ownerPersonId: mei.id });
    await item(stayer.id, 'ice');

    const summary = await runDeletionSweep(db.database, NOW, async () => {});

    expect(summary.erased).toBe(1);
    const rows = (await items()).map((r) => [r.text, r.ownerPersonId, r.addedByPersonId]).sort();
    expect(rows).toEqual([
      ['chips', null, mei.id],
      ['ice', null, stayer.id],
      ['plates', mei.id, mei.id],
    ]);
  });
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

  function reading(
    intent: SharedGroupReading['intent'],
    extra: Partial<SharedGroupReading> = {},
  ): SharedGroupReader {
    return {
      async read() {
        return {
          intent,
          role: 'unclear',
          familyLabel: null,
          kidName: null,
          confidence: 'high',
          ...extra,
        } as SharedGroupReading;
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
        seatedAt: NOW,
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

  const PRIYA = '+16415550202';

  /**
   * One message through the real turn. `handles` is what Linq lists for the chat;
   * 'production' leaves the port out, so the turn asks Linq itself over `fetch`.
   */
  async function say(
    from: string,
    text: string,
    id: string,
    handles: readonly string[] | ListChatHandles | 'production',
    answer: (input: SharedListTurnInput) => unknown,
    wire: ReturnType<typeof sender>,
    extra: {
      privateAside?: Parameters<typeof takeMultiFamilyTurn>[1]['privateAside'];
      reader?: SharedGroupReader;
      /** The webhook's chat.handles, which can still carry people who left. */
      otherHandles?: readonly string[];
      /** When the message was sent, and when Hale took it (later on a retry). */
      receivedAt?: Date;
      now?: Date;
    } = {},
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
        receivedAt: extra.receivedAt ?? NOW,
        now: extra.now ?? NOW,
        send: wire.send,
        ...(extra.privateAside ? { privateAside: extra.privateAside } : {}),
        ...(extra.otherHandles ? { otherHandles: extra.otherHandles } : {}),
      },
      {
        ...(handles === 'production'
          ? {}
          : { listHandles: typeof handles === 'function' ? handles : listOf(handles) }),
        reader: extra.reader ?? reading('chatter'),
        composer: fakeSharedGroupComposer(),
        listTurn: model,
      },
    );
    return { out, seen };
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
    /**
     * Priya adds an open cake, then Mei claims a secret Lego for Mia before Ada is here.
     * With `adaAtHide` Ada was seated before the hide, so being new cannot be what hides it:
     * only whether her Hale child's name matches decides.
     */
    async function secretBeforeAda(adaKid: string, forKid: string, adaAtHide = false) {
      vi.stubEnv('GROUP_BRING_LIST_ENABLED', 'true');
      await parent(MEI, 'Mei');
      await parent(PRIYA, 'Priya');
      await parent(ADA, 'Ada', adaKid);
      const wire = sender();
      await say(
        PRIYA,
        'we still need a cake',
        'in-cake',
        adaAtHide ? [MEI, PRIYA, ADA] : [MEI, PRIYA],
        () => decision({ list: 'Party', add: ['cake'], reply: null }),
        wire,
      );
      const before = await say(
        MEI,
        `I'll get ${forKid} the Lego, keep it a surprise`,
        'in-lego',
        adaAtHide ? [MEI, PRIYA, ADA] : [MEI, PRIYA],
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
      if (!adaAtHide) expect(before.out).toMatchObject({ outcome: 'shared_list', notice: 'sent' });
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

    it.each([
      ['Mia', "Mia's"],
      ['Mia', 'Mia\u2019s'],
      ['Jess', "Jess'"],
      ['Anne-Marie', 'Anne Marie'],
    ])(
      'matches her Hale child %j across possessives and punctuation (%j)',
      async (adaKid, forKid) => {
        const wire = await secretBeforeAda(adaKid, forKid, true);
        const { seen } = await say(
          PRIYA,
          "what's left?",
          'in-left',
          [MEI, PRIYA, ADA],
          () => decision({ reply: 'Cake is still open.' }),
          wire,
        );
        expect(seen.map((input) => input.items.map((i) => i.text))).toEqual([['cake']]);
      },
    );

    it('does not hide a gift for a different name that only starts the same', async () => {
      const wire = await secretBeforeAda('Mia', 'Mial', true);
      const { seen } = await say(
        PRIYA,
        "what's left?",
        'in-left',
        [MEI, PRIYA, ADA],
        () => decision({ reply: 'Cake is still open.' }),
        wire,
      );
      expect(seen.map((input) => input.items.map((i) => i.text).sort())).toEqual([
        ['Lego for Mial', 'cake'],
      ]);
    });

    it('matches her Hale child across case, accents and surrounding spaces', async () => {
      const wire = await secretBeforeAda(' Zoé ', 'ZOE', true);
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

  describe('a hidden gift fails closed', () => {
    const GWEN = '+16415550404';
    const NEWCOMER = '+16415550505';
    const LEGO = 'Lego for Mia';
    const shown = (seen: SharedListTurnInput[]) =>
      seen.flatMap((input) => input.items.map((i) => i.text));
    const whatsLeft = (input: SharedListTurnInput) =>
      decision({
        reply: input.items.length
          ? `On the list: ${input.items.map((i) => i.text).join(', ')}`
          : 'Nothing on the list yet.',
      });
    /** A turn nobody answers. It seats everyone Linq lists before anything is hidden. */
    const hello = (handles: readonly string[], wire: ReturnType<typeof sender>) =>
      say(PRIYA, 'hi all', 'in-hello', handles, () => decision({ listTurn: false }), wire);
    const secretLego = (kidFamily: string[]) =>
      decision({
        list: 'Gifts for Mia',
        claim: [{ item: null, text: LEGO }],
        gift: { forKid: 'Mia', keepFromKidFamily: true, kidFamily },
        reply: 'Nice, the Lego is yours.',
      });

    /** Mei and Priya are Hale parents. Gwen, a guest Hale knows only by her number, is the
     * parent Mei names as Mia's family; she then leaves the chat. */
    async function hiddenFromGwenWhoLeft() {
      vi.stubEnv('GROUP_BRING_LIST_ENABLED', 'true');
      const mei = await parent(MEI, 'Mei');
      await parent(PRIYA, 'Priya');
      // Mei's family brought Hale into the chat, so a guest's message has a host.
      await db.database.insert(schema.linqMultiFamilyJoins).values({
        chatId: CHAT,
        familyId: mei.familyId,
        joinedByUserId: mei.userId,
        joinedAt: NOW,
      });
      const [gwen] = await db.database
        .insert(schema.linqSharedGroupPeople)
        .values({
          chatId: CHAT,
          phoneE164Encrypted: encryptString(GWEN),
          phoneE164Hash: phoneBlindIndex(GWEN),
          firstName: 'Gwen',
          seatedAt: NOW,
        })
        .returning();
      const wire = sender();
      await hello([MEI, PRIYA, GWEN], wire);
      await say(
        MEI,
        "I'll get Mia the Lego, don't tell Gwen",
        'in-lego',
        [MEI, PRIYA, GWEN],
        (input) => {
          const ref = input.people.find((p) => p.firstName === 'Gwen')?.ref;
          if (!ref) throw new Error('Gwen was not shown to the model');
          return secretLego([ref]);
        },
        wire,
      );
      // Gwen is here: the claim stands, hidden from her by name, and nothing is said.
      expect(wire.texts).toEqual([]);
      expect((await items()).map((r) => [r.text, r.hiddenFromPersonIds])).toEqual([
        [LEGO, [gwen?.id]],
      ]);
      await forgetSharedGroupPresence(db.database, {
        chatId: CHAT,
        participantHandle: GWEN,
        participantIsMe: false,
        now: NOW,
      });
      // Positive control: with Gwen gone, the people who were here when it was hidden see it.
      const open = await say(PRIYA, "what's left?", 'in-left-open', [MEI, PRIYA], whatsLeft, wire);
      expect(shown(open.seen)).toEqual([LEGO]);
      expect(wire.texts).toEqual([`On the list: ${LEGO}`]);
      wire.texts.length = 0;
      return wire;
    }

    it('stays hidden from the parent it was hidden from after she leaves and rejoins', async () => {
      const wire = await hiddenFromGwenWhoLeft();
      const back = await say(
        GWEN,
        "what's left?",
        'in-gwen-back',
        [MEI, PRIYA, GWEN],
        whatsLeft,
        wire,
      );
      expect(back.out).toMatchObject({ handled: true, outcome: 'shared_list' });
      expect(shown(back.seen)).toEqual([]);
      expect(wire.texts.join(' ')).not.toContain('Lego');
    });

    it('once the parent it was hidden from is gone, stays hidden from anyone new', async () => {
      const wire = await hiddenFromGwenWhoLeft();
      const later = await say(
        PRIYA,
        "what's left?",
        'in-newcomer',
        [MEI, PRIYA, NEWCOMER],
        whatsLeft,
        wire,
      );
      expect(later.out).toMatchObject({ handled: true, outcome: 'shared_list' });
      expect(shown(later.seen)).toEqual([]);
      expect(wire.texts.join(' ')).not.toContain('Lego');
    });

    /** Mei hides a Lego for Mia while nobody from Mia's family is in the chat. */
    async function secretWhileMiaFamilyAway() {
      vi.stubEnv('GROUP_BRING_LIST_ENABLED', 'true');
      const mei = await parent(MEI, 'Mei');
      const priya = await parent(PRIYA, 'Priya');
      // Mei's family brought Hale into the chat, so a guest's message has a host.
      await db.database.insert(schema.linqMultiFamilyJoins).values({
        chatId: CHAT,
        familyId: mei.familyId,
        joinedByUserId: mei.userId,
        joinedAt: NOW,
      });
      const wire = sender();
      await hello([MEI, PRIYA], wire);
      await say(
        MEI,
        "I'll get Mia the Lego, shh",
        'in-lego',
        [MEI, PRIYA],
        () => secretLego([]),
        wire,
      );
      // Positive control: everyone Linq lists is placed, so the list shows it.
      const open = await say(PRIYA, "what's left?", 'in-left-open', [MEI, PRIYA], whatsLeft, wire);
      expect(shown(open.seen)).toEqual([LEGO]);
      wire.texts.length = 0;
      return { wire, priya };
    }

    const forgetAda = () =>
      forgetSharedGroupPresence(db.database, {
        chatId: CHAT,
        participantHandle: ADA,
        participantIsMe: false,
        now: NOW,
      });
    const adaIsMiasMom = reading('who_i_am', { role: 'parent', kidName: 'Mia' });
    const adaKid = async () =>
      (await db.database.select().from(schema.linqSharedGroupPeople)).find(
        (row) => row.phoneE164Hash === phoneBlindIndex(ADA),
      )?.inferredKidName;

    it("stays hidden from a guest who says she is the child's mom after the hide, leaves and rejoins", async () => {
      const { wire } = await secretWhileMiaFamilyAway();
      await say(
        ADA,
        "hi all, I'm Mia's mom",
        'in-ada-intro',
        [MEI, PRIYA, ADA],
        () => decision({ listTurn: false }),
        wire,
        { reader: adaIsMiasMom },
      );
      expect(await adaKid()).toBe('Mia');
      const known = await say(
        PRIYA,
        "what's left?",
        'in-known',
        [MEI, PRIYA, ADA],
        whatsLeft,
        wire,
      );
      expect(shown(known.seen)).toEqual([]);
      await forgetAda();
      const back = await say(
        ADA,
        "what's left?",
        'in-ada-back',
        [MEI, PRIYA, ADA],
        whatsLeft,
        wire,
      );
      expect(back.out).toMatchObject({ handled: true, outcome: 'shared_list' });
      expect(shown(back.seen)).toEqual([]);
      expect(wire.texts.join(' ')).not.toContain('Lego');
    });

    /** Ada is in the chat, and cleared, when Mei hides the Lego; then she says she is Mia's mom. */
    async function clearedAdaSaysShesMom() {
      vi.stubEnv('GROUP_BRING_LIST_ENABLED', 'true');
      const mei = await parent(MEI, 'Mei');
      await parent(PRIYA, 'Priya');
      await db.database.insert(schema.linqMultiFamilyJoins).values({
        chatId: CHAT,
        familyId: mei.familyId,
        joinedByUserId: mei.userId,
        joinedAt: NOW,
      });
      const wire = sender();
      const here = [MEI, PRIYA, ADA];
      await hello(here, wire);
      // Ada is a guest nobody has placed yet, so the model hides the Lego from no one by name.
      await say(MEI, "I'll get Mia the Lego, shh", 'in-lego', here, () => secretLego([]), wire);
      const open = await say(PRIYA, "what's left?", 'in-open', here, whatsLeft, wire);
      expect(shown(open.seen)).toEqual([LEGO]);
      await say(
        ADA,
        "oh I'm Mia's mom btw",
        'in-ada-intro',
        here,
        () => decision({ listTurn: false }),
        wire,
        { reader: adaIsMiasMom },
      );
      expect(await adaKid()).toBe('Mia');
      const known = await say(PRIYA, "what's left?", 'in-known', here, whatsLeft, wire);
      expect(shown(known.seen)).toEqual([]);
      wire.texts.length = 0;
      return { wire, here };
    }

    it('stays hidden from someone who was here at the hide, then said she is the mom, left and rejoined', async () => {
      const { wire, here } = await clearedAdaSaysShesMom();
      await forgetAda();
      const back = await say(ADA, "what's left?", 'in-ada-back', here, whatsLeft, wire);
      expect(shown(back.seen)).toEqual([]);
      expect(wire.texts.join(' ')).not.toContain('Lego');
    });

    it("stays hidden from someone who said she is the child's mom and later names another child", async () => {
      const { wire, here } = await clearedAdaSaysShesMom();
      await say(
        ADA,
        "and Leo's too",
        'in-ada-leo',
        here,
        () => decision({ listTurn: false }),
        wire,
        { reader: reading('who_i_am', { role: 'parent', kidName: 'Leo' }) },
      );
      expect(await adaKid()).toBe('Leo');
      const later = await say(PRIYA, "what's left?", 'in-later', here, whatsLeft, wire);
      expect(shown(later.seen)).toEqual([]);
      expect(wire.texts.join(' ')).not.toContain('Lego');
    });

    it('keeps no number of someone who left or was erased on a hidden gift', async () => {
      const wire = await hiddenFromGwenWhoLeft();
      const [row] = await items();
      expect(row?.hiddenClearedPhoneHashes.sort()).toEqual(
        [phoneBlindIndex(MEI), phoneBlindIndex(PRIYA)].sort(),
      );
      // Gwen rejoins and is hidden from; then Priya's family is erased.
      await say(GWEN, 'hi again', 'in-gwen-hi', [MEI, PRIYA, GWEN], () => decision({}), wire);
      await db.database
        .update(schema.families)
        .set({ scheduledDeletionAt: new Date(NOW.getTime() - 60_000) })
        .where(eq(schema.families.displayName, 'Priya'));
      await runDeletionSweep(db.database, NOW, async () => {});
      const [after] = await items();
      expect(after?.hiddenClearedPhoneHashes).toEqual([phoneBlindIndex(MEI)]);
      expect(Object.keys(after ?? {})).not.toContain('hiddenFromPhoneHashes');
    }, 30_000);

    it('hides every secret item while Linq lists someone Hale has not placed', async () => {
      const { wire } = await secretWhileMiaFamilyAway();
      const out = await say(
        PRIYA,
        "what's left?",
        'in-left-unplaced',
        [MEI, PRIYA, 'someone@icloud.com'],
        whatsLeft,
        wire,
      );
      expect(out.out).toMatchObject({ handled: true, outcome: 'shared_list' });
      expect(shown(out.seen)).toEqual([]);
      expect(wire.texts.join(' ')).not.toContain('Lego');
    });

    it('hides every secret item when the participant list cannot be read', async () => {
      const { wire } = await secretWhileMiaFamilyAway();
      const unreadable: ListChatHandles = async () => ({
        status: 'unreachable',
        reason: 'timeout',
      });
      const out = await say(PRIYA, "what's left?", 'in-left-unread', unreadable, whatsLeft, wire);
      expect(out.out).toMatchObject({ handled: true, outcome: 'shared_list' });
      expect(shown(out.seen)).toEqual([]);
      expect(wire.texts.join(' ')).not.toContain('Lego');
    });

    const linqAnswers = (body: string, status = 200) => {
      vi.stubEnv('LINQ_API_KEY', 'test-key-not-real');
      const calls: string[] = [];
      vi.stubGlobal('fetch', async (url: string) => {
        calls.push(String(url));
        return new Response(body, { status, headers: { 'content-type': 'application/json' } });
      });
      return calls;
    };
    const linqTimesOut = () => {
      vi.stubEnv('LINQ_API_KEY', 'test-key-not-real');
      vi.stubGlobal('fetch', async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      });
    };
    const linqLists = (...handles: string[]) =>
      linqAnswers(
        JSON.stringify({
          chat: {
            is_group: true,
            handles: [
              ...handles.map((handle) => ({ handle, status: 'active' })),
              { handle: FROM, is_me: true },
            ],
          },
        }),
      );

    const unreadable: [string, () => ListChatHandles | 'production'][] = [
      ['a list with nobody on it', () => listOf([])],
      ['a list without the speaker', () => listOf([MEI])],
      [
        'a list Linq says is not a group',
        () => async () => ({
          status: 'ok',
          handles: [MEI, PRIYA],
          isGroup: false,
        }),
      ],
      [
        'a 200 with no handles',
        () => {
          linqAnswers(JSON.stringify({ chat: { id: CHAT, is_group: true } }));
          return 'production';
        },
      ],
      [
        'a 200 edge page',
        () => {
          linqAnswers('<html>ok</html>');
          return 'production';
        },
      ],
      [
        'a 503',
        () => {
          linqAnswers(JSON.stringify({ error: 'overloaded' }), 503);
          return 'production';
        },
      ],
      [
        'nothing before the timeout',
        () => {
          linqTimesOut();
          return 'production';
        },
      ],
    ];
    it.each(unreadable)(
      "hides every secret item when Linq answers %s while the child's mom is here unseated",
      async (_label, handles) => {
        const { wire } = await secretWhileMiaFamilyAway();
        await parent(ADA, 'Ada', 'Mia');
        const out = await say(PRIYA, "what's left?", 'in-left-empty', handles(), whatsLeft, wire);
        expect(out.out).toMatchObject({ handled: true, outcome: 'shared_list' });
        expect(shown(out.seen)).toEqual([]);
        expect(wire.texts.join(' ')).not.toContain('Lego');
      },
    );

    it('shows a secret item when Linq, asked over the wire, lists only people Hale placed', async () => {
      const { wire } = await secretWhileMiaFamilyAway();
      await parent(ADA, 'Ada', 'Mia');
      const calls = linqAnswers(
        JSON.stringify({
          chat: {
            is_group: true,
            handles: [
              { handle: MEI, status: 'active' },
              { handle: PRIYA, status: 'active' },
              { handle: ADA, status: 'left' },
              { handle: FROM, is_me: true },
            ],
          },
        }),
      );
      const out = await say(PRIYA, "what's left?", 'in-left-wire', 'production', whatsLeft, wire);
      // Once for what the model sees, once more after it, for the line.
      expect(calls).toHaveLength(2);
      expect(shown(out.seen)).toEqual([LEGO]);
      expect(wire.texts).toEqual([`On the list: ${LEGO}`]);
    });

    it('a claim that meets a hidden gift keeps the 1:1 aside quiet too', async () => {
      const { wire } = await secretWhileMiaFamilyAway();
      await parent(ADA, 'Ada', 'Mia');
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
      const blind = await say(
        PRIYA,
        'I can get Mia a Lego',
        'in-blind',
        [MEI, PRIYA, ADA],
        () =>
          decision({
            list: 'Gifts for Mia',
            claim: [{ item: null, text: LEGO }],
            reply: 'Lego is yours.',
          }),
        wire,
        { privateAside },
      );
      expect(blind.out).toMatchObject({ handled: true, outcome: 'shared_list' });
      expect(asideReads).toBe(0);
      expect(wire.texts).toEqual([]);
    });

    it("leaves the speaker's family audit and export the same as a turn with nothing to do", async () => {
      const { wire, priya } = await secretWhileMiaFamilyAway();
      const { familyId, userId } = priya;
      await parent(ADA, 'Ada', 'Mia');
      const here = [MEI, PRIYA, ADA];
      // Ada is Mia's family: Priya's claim of the hidden Lego is held, unseen.
      const blind = await say(
        PRIYA,
        'I can get Mia a Lego',
        'in-blind',
        here,
        () =>
          decision({
            list: 'Gifts for Mia',
            claim: [{ item: null, text: LEGO }],
            reply: 'Lego is yours.',
          }),
        wire,
      );
      expect(shown(blind.seen)).toEqual([]);
      const idle = await say(PRIYA, 'sounds good', 'in-idle', here, () => decision({}), wire);
      expect([blind.out, idle.out]).toMatchObject([
        { handled: true, outcome: 'shared_list' },
        { handled: true, outcome: 'shared_list' },
      ]);
      expect(wire.texts).toEqual([]);

      const rows = await db.database
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.familyId, familyId))
        .orderBy(schema.auditLog.occurredAt);
      // The last two: the setup's own "what's left?" came first.
      const turns = rows
        .filter((row) => row.actionTaken === 'linq_multi_family_list_turn')
        .slice(-2);
      expect(turns).toHaveLength(2);
      const [heldRow, idleRow] = turns.map(({ id, occurredAt, ...rest }) => rest);
      expect(heldRow).toEqual(idleRow);

      const copy = await assembleFamilyExport(db.database, familyId, {
        actorUserId: userId,
        now: NOW,
      });
      const ids = turns.map((row) => row.id);
      const exported = copy.trail.filter((row) => ids.includes(row.id));
      expect(exported).toHaveLength(2);
      // The clock fields come from the real insert time, so only the row's content is compared.
      const [heldLine, idleLine] = exported.map(({ id, time, date, dayKey, ...rest }) => rest);
      expect(heldLine).toEqual(idleLine);
    }, 30_000);

    describe('the allow-list: only people here, seated and cleared at the hide see it', () => {
      const RAJ = '+16415550606';
      const peopleRows = () => db.database.select().from(schema.linqSharedGroupPeople);
      const seatOf = async (phone: string) =>
        (await peopleRows()).find((row) => row.phoneE164Hash === phoneBlindIndex(phone));

      async function seatPerson(
        phone: string,
        extra: Partial<typeof schema.linqSharedGroupPeople.$inferInsert> = {},
      ) {
        const [row] = await db.database
          .insert(schema.linqSharedGroupPeople)
          .values({
            chatId: CHAT,
            phoneE164Encrypted: encryptString(phone),
            phoneE164Hash: phoneBlindIndex(phone),
            seatedAt: NOW,
            ...extra,
          })
          .returning();
        if (!row) throw new Error('seat insert');
        return row;
      }

      /**
       * Mei and Priya are Hale parents and Ada a guest, all seated before anything is hidden.
       * Mei's family brought Hale in, so a guest's message has a host.
       */
      async function chatBeforeTheHide() {
        vi.stubEnv('GROUP_BRING_LIST_ENABLED', 'true');
        const mei = await parent(MEI, 'Mei');
        const priya = await parent(PRIYA, 'Priya');
        await db.database.insert(schema.linqMultiFamilyJoins).values({
          chatId: CHAT,
          familyId: mei.familyId,
          joinedByUserId: mei.userId,
          joinedAt: NOW,
        });
        await seatPerson(MEI, { familyId: mei.familyId, userId: mei.userId, firstName: 'Mei' });
        await seatPerson(PRIYA, {
          familyId: priya.familyId,
          userId: priya.userId,
          firstName: 'Priya',
        });
        const ada = await seatPerson(ADA, { firstName: 'Ada' });
        return { mei, priya, ada, wire: sender(), here: [MEI, PRIYA, ADA] };
      }

      /** The chat above, with the Lego for Mia hidden while all three were here. */
      async function hiddenWithAdaHere() {
        const chat = await chatBeforeTheHide();
        await say(
          MEI,
          "I'll get Mia the Lego, shh",
          'in-lego',
          chat.here,
          () => secretLego([]),
          chat.wire,
        );
        // Positive control: Ada was here, seated and not Mia's family when it was hidden.
        const open = await say(PRIYA, "what's left?", 'in-open', chat.here, whatsLeft, chat.wire);
        expect(shown(open.seen)).toEqual([LEGO]);
        expect(chat.wire.texts).toEqual(['Nice, the Lego is yours.', `On the list: ${LEGO}`]);
        chat.wire.texts.length = 0;
        return chat;
      }

      const quiet = () => decision({ listTurn: false });
      const adaSays = (
        text: string,
        id: string,
        here: readonly string[],
        wire: ReturnType<typeof sender>,
        reader: SharedGroupReader,
      ) => say(ADA, text, id, here, quiet, wire, { reader });
      const adaIsMomOf = (...kidNames: string[]) =>
        reading('who_i_am', { role: 'parent', kidName: kidNames[0] ?? null, kidNames });

      it('hole 1: a cleared guest who leaves and comes back on a new seat no longer sees it', async () => {
        const { wire, here, ada } = await hiddenWithAdaHere();
        await forgetAda();
        await say(ADA, 'back again!', 'in-ada-back', here, quiet, wire);
        expect((await seatOf(ADA))?.id).not.toBe(ada.id);
        const later = await say(PRIYA, "what's left?", 'in-later', here, whatsLeft, wire);
        expect(shown(later.seen)).toEqual([]);
        expect(wire.texts.join(' ')).not.toContain('Lego');
      });

      it('hole 2: a number Linq lists that has no seat here hides every hidden item', async () => {
        const { wire } = await hiddenWithAdaHere();
        linqLists(MEI, PRIYA, ADA, NEWCOMER);
        const out = await say(PRIYA, "what's left?", 'in-unseated', 'production', whatsLeft, wire);
        expect(out.out).toMatchObject({ handled: true, outcome: 'shared_list' });
        expect(await seatOf(NEWCOMER)).toBeUndefined();
        expect(shown(out.seen)).toEqual([]);
        expect(wire.texts.join(' ')).not.toContain('Lego');
      });

      it('hole 4: someone first listed on the turn that hides a gift is seated by it but never cleared', async () => {
        const { wire, here } = await chatBeforeTheHide();
        const withNewcomer = [...here, NEWCOMER];
        await say(
          MEI,
          "I'll get Mia the Lego, shh",
          'in-lego',
          withNewcomer,
          () => secretLego([]),
          wire,
        );
        expect(await seatOf(NEWCOMER)).toBeDefined();
        expect((await items())[0]?.hiddenClearedPhoneHashes.sort()).toEqual(
          [MEI, PRIYA, ADA].map(phoneBlindIndex).sort(),
        );
        const later = await say(PRIYA, "what's left?", 'in-later', withNewcomer, whatsLeft, wire);
        expect(shown(later.seen)).toEqual([]);
        expect(wire.texts.join(' ')).not.toContain('Lego');
      });

      it('hole 5: a cleared person who stops Hale but stays in the chat hides it', async () => {
        const { wire, here } = await hiddenWithAdaHere();
        await adaSays('stop', 'in-ada-stop', here, wire, reading('stop_me'));
        expect((await seatOf(ADA))?.stoppedAt).not.toBeNull();
        const later = await say(PRIYA, "what's left?", 'in-later', here, whatsLeft, wire);
        expect(shown(later.seen)).toEqual([]);
        expect(wire.texts.join(' ')).not.toContain('Lego');
      });

      it('hole 5: a seat stopped before the hide is never cleared', async () => {
        const { wire, here } = await chatBeforeTheHide();
        await adaSays('stop', 'in-ada-stop', here, wire, reading('stop_me'));
        await say(MEI, "I'll get Mia the Lego, shh", 'in-lego', here, () => secretLego([]), wire);
        expect((await items())[0]?.hiddenClearedPhoneHashes.sort()).toEqual(
          [MEI, PRIYA].map(phoneBlindIndex).sort(),
        );
      });

      it('hole 7: naming two children takes clearance off the hidden gifts for both, in any wording', async () => {
        const { wire, here } = await hiddenWithAdaHere();
        await say(
          MEI,
          'and a kite for Leo, also secret',
          'in-kite',
          here,
          () =>
            decision({
              list: 'Gifts for Leo',
              claim: [{ item: null, text: 'Kite for Leo' }],
              gift: { forKid: 'Leo', keepFromKidFamily: true, kidFamily: [] },
              reply: null,
            }),
          wire,
        );
        const both = await say(PRIYA, "what's left?", 'in-both', here, whatsLeft, wire);
        expect(shown(both.seen).sort()).toEqual(['Kite for Leo', LEGO]);
        wire.texts.length = 0;
        await adaSays(
          'soy la mamá de Mia y Leo',
          'in-ada-two',
          here,
          wire,
          adaIsMomOf('Mia', 'Leo'),
        );
        const later = await say(PRIYA, "what's left?", 'in-later', here, whatsLeft, wire);
        expect(shown(later.seen)).toEqual([]);
        expect(wire.texts.join(' ')).not.toMatch(/Lego|Kite/);
        for (const row of await items()) {
          expect(row.hiddenClearedPhoneHashes).not.toContain(phoneBlindIndex(ADA));
        }
      });

      it('hole 7: a parent claim that names no child takes her clearance off every hidden gift, now and later', async () => {
        const { wire, here } = await hiddenWithAdaHere();
        await adaSays("I'm the birthday girl's mom!", 'in-ada-vague', here, wire, adaIsMomOf());
        const later = await say(PRIYA, "what's left?", 'in-later', here, whatsLeft, wire);
        expect(shown(later.seen)).toEqual([]);
        // A gift hidden after she said it does not clear her either.
        await say(
          PRIYA,
          'I got Mia a puzzle, secret',
          'in-puzzle',
          here,
          () =>
            decision({
              list: 'Gifts for Mia',
              claim: [{ item: null, text: 'Puzzle for Mia' }],
              gift: { forKid: 'Mia', keepFromKidFamily: true, kidFamily: [] },
              reply: 'Puzzle is yours.',
            }),
          wire,
        );
        for (const row of await items()) {
          expect(row.hiddenClearedPhoneHashes).not.toContain(phoneBlindIndex(ADA));
        }
        expect(wire.texts.join(' ')).not.toMatch(/Lego|Puzzle/);
      });

      it('hole 8: a later claim never drops an earlier one, so a gift hidden after both stays hidden from her', async () => {
        const { wire, here } = await chatBeforeTheHide();
        await adaSays("hi, I'm Mia's mom", 'in-ada-mia', here, wire, adaIsMomOf('Mia'));
        await adaSays("and Leo's too", 'in-ada-leo', here, wire, adaIsMomOf('Leo'));
        expect((await seatOf(ADA))?.inferredKidName).toBe('Leo');
        wire.texts.length = 0;
        await say(MEI, "I'll get Mia the Lego, shh", 'in-lego', here, () => secretLego([]), wire);
        expect((await items())[0]?.hiddenClearedPhoneHashes).not.toContain(phoneBlindIndex(ADA));
        const later = await say(PRIYA, "what's left?", 'in-later', here, whatsLeft, wire);
        expect(shown(later.seen)).toEqual([]);
        expect(wire.texts.join(' ')).not.toContain('Lego');
      });

      it("hole 9: a whose-parent claim that lands while a turn is read keeps the gift out of that turn's line", async () => {
        const { wire, here } = await hiddenWithAdaHere();
        const racing = await say(
          PRIYA,
          "what's left?",
          'in-race',
          here,
          async (input) => {
            await adaSays("oh I'm Mia's mom", 'in-ada-mid', here, wire, adaIsMiasMom);
            return whatsLeft(input);
          },
          wire,
        );
        // The read began before her claim, so the model saw it; the line it wrote is held.
        expect(shown(racing.seen)).toEqual([LEGO]);
        expect(wire.texts.join(' ')).not.toContain('Lego');
      });

      it('hole 9: a whose-parent claim that lands while the hide is read keeps her off the cleared list', async () => {
        const { wire, here } = await chatBeforeTheHide();
        await say(
          MEI,
          "I'll get Mia the Lego, shh",
          'in-lego',
          here,
          async () => {
            await adaSays("oh I'm Mia's mom", 'in-ada-mid', here, wire, adaIsMiasMom);
            return secretLego([]);
          },
          wire,
        );
        expect((await items())[0]?.hiddenClearedPhoneHashes).not.toContain(phoneBlindIndex(ADA));
        expect(wire.texts.join(' ')).not.toContain('Lego');
      });

      it("hole 10: a cleared person's number leaves every hidden gift when they leave and when their family is erased", async () => {
        const { here, wire } = await hiddenWithAdaHere();
        const ids = () => items().then((rows) => rows[0]?.hiddenClearedPhoneHashes.sort());
        expect(await ids()).toEqual([MEI, PRIYA, ADA].map(phoneBlindIndex).sort());
        await adaSays("I'm Leo's mom", 'in-ada-leo', here, wire, adaIsMomOf('Leo'));
        await forgetAda();
        expect(await ids()).toEqual([MEI, PRIYA].map(phoneBlindIndex).sort());
        expect(await seatOf(ADA)).toBeUndefined();
        await db.database
          .update(schema.families)
          .set({ scheduledDeletionAt: new Date(NOW.getTime() - 60_000) })
          .where(eq(schema.families.displayName, 'Priya'));
        await runDeletionSweep(db.database, NOW, async () => {});
        expect(await ids()).toEqual([phoneBlindIndex(MEI)]);
      }, 30_000);

      it("hole 11: clearance is a number, not a family: a cleared parent's co-parent who joins later does not see it", async () => {
        const { wire, here, priya } = await hiddenWithAdaHere();
        const [raj] = await db.database
          .insert(schema.users)
          .values({ externalAuthId: `imessage:raj-${RAJ}`, name: 'Raj' })
          .returning({ id: schema.users.id });
        await db.database
          .insert(schema.familyMembers)
          .values({ familyId: priya.familyId, userId: raj?.id as string, role: 'co_parent' });
        await db.database.insert(schema.parentChannels).values({
          userId: raj?.id as string,
          familyId: priya.familyId,
          kind: 'sms',
          phoneE164Encrypted: encryptString(RAJ),
          phoneE164Hash: phoneBlindIndex(RAJ),
          verifiedAt: NOW,
        });
        const withRaj = [...here, RAJ];
        await say(RAJ, 'hi all', 'in-raj', withRaj, quiet, wire);
        expect((await seatOf(RAJ))?.familyId).toBe(priya.familyId);
        const later = await say(PRIYA, "what's left?", 'in-later', withRaj, whatsLeft, wire);
        expect(shown(later.seen)).toEqual([]);
        expect(wire.texts.join(' ')).not.toContain('Lego');
      });

      it('hole 12: asks Linq who is here only while the chat holds a hidden item', async () => {
        const { wire } = await chatBeforeTheHide();
        const calls = linqLists(MEI, PRIYA, ADA);
        await say(
          PRIYA,
          'we need a cake',
          'in-cake',
          'production',
          () => decision({ list: 'Party', add: ['cake'] }),
          wire,
        );
        const open = await say(PRIYA, "what's left?", 'in-open', 'production', whatsLeft, wire);
        expect(shown(open.seen)).toEqual(['cake']);
        expect(calls).toEqual([]);
        await say(
          MEI,
          "I'll get Mia the Lego, shh",
          'in-lego',
          'production',
          () => secretLego([]),
          wire,
        );
        expect(calls).toHaveLength(1);
        const later = await say(PRIYA, "what's left?", 'in-later', 'production', whatsLeft, wire);
        expect(calls).toHaveLength(3);
        expect(shown(later.seen).sort()).toEqual([LEGO, 'cake']);
      });

      it('hole 12: a hide whose line needs the participant list, and cannot read it, says nothing', async () => {
        const { wire } = await chatBeforeTheHide();
        linqAnswers('', 503);
        await say(
          MEI,
          "I'll get Mia the Lego, shh",
          'in-lego',
          'production',
          () => secretLego([]),
          wire,
        );
        expect((await items()).map((row) => row.text)).toEqual([LEGO]);
        expect(wire.texts).toEqual([]);
      });

      it('a hide that cannot read the participant list clears nobody, even once Linq answers again', async () => {
        const { wire, here } = await chatBeforeTheHide();
        const unreadable: ListChatHandles = async () => ({
          status: 'unreachable',
          reason: 'timeout',
        });
        await say(
          MEI,
          "I'll get Mia the Lego, shh",
          'in-lego',
          unreadable,
          () => secretLego([]),
          wire,
        );
        expect((await items())[0]?.hiddenClearedPhoneHashes).toEqual([]);
        const later = await say(PRIYA, "what's left?", 'in-later', here, whatsLeft, wire);
        expect(shown(later.seen)).toEqual([]);
        expect(wire.texts.join(' ')).not.toContain(LEGO);
      });

      describe('someone who joins while the model reads the turn', () => {
        /** Linq's GET for the chat, listing `joiner` too once `joined` is set. */
        const linqWithJoiner = (here: readonly string[], joiner: string) => {
          vi.stubEnv('LINQ_API_KEY', 'test-key-not-real');
          const state = { joined: false, calls: 0 };
          vi.stubGlobal('fetch', async () => {
            state.calls += 1;
            const listed = state.joined ? [...here, joiner] : here;
            return new Response(
              JSON.stringify({
                chat: {
                  is_group: true,
                  handles: [
                    ...listed.map((handle) => ({ handle, status: 'active' })),
                    { handle: FROM, is_me: true },
                  ],
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          });
          return state;
        };
        /** The participant-added webhook, landing in the middle of the turn. */
        const added = (handle: string) =>
          noticeSharedGroupAdded(
            db.database,
            { chatId: CHAT, adderHandle: MEI, now: NOW, handles: [handle] },
            { send: sender().send, composer: fakeSharedGroupComposer() },
          );

        it('a guest Linq starts listing during a "what\'s left?" keeps the hidden gift out of its line', async () => {
          const { wire, here } = await hiddenWithAdaHere();
          const linq = linqWithJoiner(here, NEWCOMER);
          const out = await say(
            PRIYA,
            "what's left?",
            'in-joined',
            'production',
            (input) => {
              linq.joined = true;
              return whatsLeft(input);
            },
            wire,
          );
          expect(out.out).toMatchObject({ handled: true, outcome: 'shared_list' });
          // Positive control: the model saw it, so only asking Linq again keeps it out.
          expect(shown(out.seen)).toEqual([LEGO]);
          expect(linq.calls).toBe(2);
          expect(wire.texts.join(' ')).not.toContain(LEGO);
        });

        it("the child's parent, listed by the port before any webhook seats her, never gets it", async () => {
          const { wire, here } = await hiddenWithAdaHere();
          await parent(RAJ, 'Raj', 'Mia');
          let joined = false;
          const port: ListChatHandles = async () => ({
            status: 'ok',
            handles: joined ? [...here, RAJ] : [...here],
            isGroup: true,
          });
          const out = await say(
            PRIYA,
            "what's left?",
            'in-joined',
            port,
            (input) => {
              joined = true;
              return whatsLeft(input);
            },
            wire,
          );
          expect(await seatOf(RAJ)).toBeUndefined();
          expect(shown(out.seen)).toEqual([LEGO]);
          expect(wire.texts.join(' ')).not.toContain(LEGO);
        });

        it('someone seated during the turn hides it even while Linq does not list them yet', async () => {
          const { wire, here } = await hiddenWithAdaHere();
          const out = await say(
            PRIYA,
            "what's left?",
            'in-joined',
            here,
            async (input) => {
              await added(RAJ);
              return whatsLeft(input);
            },
            wire,
          );
          expect(await seatOf(RAJ)).toBeDefined();
          expect(shown(out.seen)).toEqual([LEGO]);
          expect(wire.texts.join(' ')).not.toContain(LEGO);
        });
      });

      it('a hide Hale takes late clears nobody seated after the message was sent', async () => {
        const { wire, here } = await chatBeforeTheHide();
        const welcomed = new Date(NOW.getTime() + 60_000);
        const retried = new Date(NOW.getTime() + 120_000);
        const withRaj = [...here, RAJ];
        await say(PRIYA, 'welcome Raj!', 'in-welcome', withRaj, quiet, wire, {
          receivedAt: welcomed,
          now: welcomed,
        });
        expect(await seatOf(RAJ)).toBeDefined();
        // Mei's hide went out at NOW, before Raj was added; Hale takes it on a retry.
        await say(
          MEI,
          "I'll get Mia the Lego, shh",
          'in-lego',
          withRaj,
          () => secretLego([]),
          wire,
          {
            receivedAt: NOW,
            now: retried,
          },
        );
        expect((await items())[0]?.hiddenClearedPhoneHashes.sort()).toEqual(
          [MEI, PRIYA, ADA].map(phoneBlindIndex).sort(),
        );
        const later = await say(PRIYA, "what's left?", 'in-later', withRaj, whatsLeft, wire, {
          receivedAt: retried,
          now: retried,
        });
        expect(shown(later.seen)).toEqual([]);
        expect(wire.texts.join(' ')).not.toContain(LEGO);
      });

      /** Linq's GET for the chat: `present` active, `departed` still listed as removed. */
      const linqListsWith = (present: readonly string[], departed: readonly string[] = []) =>
        linqAnswers(
          JSON.stringify({
            chat: {
              is_group: true,
              handles: [
                ...present.map((handle) => ({ handle, status: 'active' })),
                ...departed.map((handle) => ({
                  handle,
                  status: 'removed',
                  left_at: NOW.toISOString(),
                })),
                { handle: FROM, is_me: true },
              ],
            },
          }),
        );

      it('present at the hide: a guest seated from a webhook that still lists her as removed is never cleared', async () => {
        const { wire, here } = await chatBeforeTheHide();
        // The webhook's chat.handles still carries Gwen, whom Linq lists as removed.
        await say(PRIYA, 'hi all', 'in-hi', 'production', quiet, wire, {
          otherHandles: [MEI, ADA, GWEN],
        });
        expect(await seatOf(GWEN)).toBeDefined();
        linqListsWith(here, [GWEN]);
        await say(
          MEI,
          "I'll get Mia the Lego, shh",
          'in-lego',
          'production',
          () => secretLego([]),
          wire,
        );
        expect((await items())[0]?.hiddenClearedPhoneHashes.sort()).toEqual(
          here.map(phoneBlindIndex).sort(),
        );
        // Positive control: everyone Linq lists now was here at the hide.
        const open = await say(PRIYA, "what's left?", 'in-open', 'production', whatsLeft, wire);
        expect(shown(open.seen)).toEqual([LEGO]);
        wire.texts.length = 0;
        // Gwen is added back.
        linqListsWith([...here, GWEN]);
        const back = await say(PRIYA, "what's left?", 'in-back', 'production', whatsLeft, wire);
        expect(shown(back.seen)).toEqual([]);
        expect(wire.texts.join(' ')).not.toContain('Lego');
      });

      it('present at the hide: a mom who left and was re-seated from a stale webhook is not cleared by a hide while she is away', async () => {
        const { wire, here } = await chatBeforeTheHide();
        await adaSays("hi, I'm Mia's mom", 'in-ada-mia', here, wire, adaIsMomOf('Mia'));
        await forgetAda();
        // The next message's webhook still lists her (as left): she is seated again, unknown.
        const away = [MEI, PRIYA];
        await say(PRIYA, 'hi all', 'in-hi', away, quiet, wire, { otherHandles: [MEI, ADA] });
        expect((await seatOf(ADA))?.inferredKidNames).toEqual([]);
        await say(MEI, "I'll get Mia the Lego, shh", 'in-lego', away, () => secretLego([]), wire);
        expect((await items())[0]?.hiddenClearedPhoneHashes.sort()).toEqual(
          away.map(phoneBlindIndex).sort(),
        );
        wire.texts.length = 0;
        const back = await say(ADA, "what's left?", 'in-ada-back', here, whatsLeft, wire);
        expect(back.out).toMatchObject({ handled: true, outcome: 'shared_list' });
        expect(shown(back.seen)).toEqual([]);
        expect(wire.texts.join(' ')).not.toContain('Lego');
      });

      it('a second hide that names someone cleared at the first takes her off; it never adds anyone', async () => {
        const { wire, here } = await hiddenWithAdaHere();
        await say(
          MEI,
          "the Lego for Mia is mine, and don't tell Ada, she's Mia's aunt",
          'in-lego-again',
          here,
          (input) => {
            const lego = input.items.find((entry) => entry.text === LEGO)?.ref;
            const ada = input.people.find((entry) => entry.firstName === 'Ada')?.ref;
            if (!lego || !ada) throw new Error('the model was not shown the Lego and Ada');
            return decision({
              claim: [{ item: lego, text: null }],
              gift: { forKid: 'Mia', keepFromKidFamily: true, kidFamily: [ada] },
            });
          },
          wire,
        );
        expect((await items())[0]?.hiddenClearedPhoneHashes.sort()).toEqual(
          [MEI, PRIYA].map(phoneBlindIndex).sort(),
        );
        const later = await say(PRIYA, "what's left?", 'in-later', here, whatsLeft, wire);
        expect(shown(later.seen)).toEqual([]);
      });

      it('a participant record Linq sends without a handle makes the list unreadable', async () => {
        const { wire, here } = await hiddenWithAdaHere();
        linqAnswers(
          JSON.stringify({
            chat: {
              is_group: true,
              handles: [
                ...here.map((handle) => ({ handle, status: 'active' })),
                { handle: null, status: 'active' },
                { handle: FROM, is_me: true },
              ],
            },
          }),
        );
        const out = await say(PRIYA, "what's left?", 'in-null', 'production', whatsLeft, wire);
        expect(out.out).toMatchObject({ handled: true, outcome: 'shared_list' });
        expect(shown(out.seen)).toEqual([]);
        expect(wire.texts.join(' ')).not.toContain('Lego');
      });

      /** The group reader's model object, through the real parser. */
      const modelSaid = (raw: Record<string, unknown>): SharedGroupReader => ({
        async read() {
          return parseSharedGroupReading({
            familyLabel: null,
            ruledOut: [],
            picked: null,
            planTitle: null,
            ...raw,
          });
        },
      });
      const familyClaims: [string, Record<string, unknown>][] = [
        [
          'a question that names her child',
          { intent: 'question', role: 'parent', kidNames: ['Mia'], confidence: 'high' },
        ],
        [
          'chatter that names her child',
          { intent: 'chatter', role: 'parent', kidNames: ['Mia'], confidence: 'high' },
        ],
        [
          'a low-confidence who-I-am the parser reads as unclear',
          { intent: 'who_i_am', role: 'parent', kidNames: ['Mia'], confidence: 'low' },
        ],
        [
          'a join with a family role and no child named',
          { intent: 'join', role: 'parent', kidNames: [], confidence: 'high' },
        ],
        [
          'a who-I-am naming more children than the bound',
          {
            intent: 'who_i_am',
            role: 'parent',
            kidNames: Array.from({ length: 11 }, (_, i) => `Kid${i}`),
            confidence: 'high',
          },
        ],
        [
          'a question from a grandparent who names no child',
          { intent: 'question', role: 'grandparent', kidNames: [], confidence: 'high' },
        ],
      ];
      it.each(familyClaims)(
        'hole 7: %s takes her clearance off the hidden gift',
        async (_label, raw) => {
          const { wire, here } = await hiddenWithAdaHere();
          await adaSays('(her message)', 'in-ada-claim', here, wire, modelSaid(raw));
          expect((await items())[0]?.hiddenClearedPhoneHashes).not.toContain(phoneBlindIndex(ADA));
          const later = await say(PRIYA, "what's left?", 'in-later', here, whatsLeft, wire);
          expect(shown(later.seen)).toEqual([]);
          expect(wire.texts.join(' ')).not.toContain('Lego');
        },
      );

      it('hole 7 control: a message with no family role and no child keeps her clearance', async () => {
        const { wire, here } = await hiddenWithAdaHere();
        await adaSays(
          'lol same',
          'in-ada-chatter',
          here,
          wire,
          modelSaid({ intent: 'chatter', role: 'unclear', kidNames: [], confidence: 'high' }),
        );
        await adaSays(
          "I'm just a friend of the family",
          'in-ada-guest',
          here,
          wire,
          modelSaid({ intent: 'who_i_am', role: 'guest', kidNames: [], confidence: 'high' }),
        );
        const later = await say(PRIYA, "what's left?", 'in-later', here, whatsLeft, wire);
        expect(shown(later.seen)).toEqual([LEGO]);
      });

      describe('the chat lock', () => {
        // A witness, test-only: a write that can change who is cleared, made without this
        // chat's advisory lock held in the same transaction, is refused by the database.
        const WITNESS = `
          create or replace function test_chat_lock_held() returns trigger language plpgsql as $$
          declare chat text := coalesce(NEW.chat_id, OLD.chat_id);
          begin
            if not exists (
              select 1 from pg_locks
              where locktype = 'advisory' and pid = pg_backend_pid() and granted
                and objid = (hashtext('shared_group_list:' || chat)::bigint & 4294967295)::oid
            ) then
              raise exception 'clearance write without the chat lock';
            end if;
            return coalesce(NEW, OLD);
          end $$;
          create trigger test_items_lock before insert or update or delete on shared_group_list_items
            for each row execute function test_chat_lock_held();
          create trigger test_people_lock
            before update of inferred_kid_names, claims_unnamed_kid or delete on linq_shared_group_people
            for each row execute function test_chat_lock_held();`;

        afterEach(async () => {
          await db.exec(`
            drop trigger if exists test_items_lock on shared_group_list_items;
            drop trigger if exists test_people_lock on linq_shared_group_people;
            drop function if exists test_chat_lock_held();`);
        });

        it('positive control: a clearance write outside the lock is refused', async () => {
          const { ada } = await chatBeforeTheHide();
          await db.exec(WITNESS);
          await expect(
            db.database
              .update(schema.linqSharedGroupPeople)
              .set({ claimsUnnamedKid: true })
              .where(eq(schema.linqSharedGroupPeople.id, ada.id)),
          ).rejects.toThrow();
        });

        it('a hide, a kid claim, a leave and an erasure each write under it', async () => {
          const chat = await chatBeforeTheHide();
          await db.exec(WITNESS);
          await say(
            MEI,
            "I'll get Mia the Lego, shh",
            'in-lego',
            chat.here,
            () => secretLego([]),
            chat.wire,
          );
          const cleared = () => items().then((rows) => rows[0]?.hiddenClearedPhoneHashes.sort());
          expect(await cleared()).toEqual(chat.here.map(phoneBlindIndex).sort());
          await adaSays("I'm Mia's mom", 'in-ada-mia', chat.here, chat.wire, adaIsMomOf('Mia'));
          expect((await seatOf(ADA))?.inferredKidNames).toEqual(['Mia']);
          expect(await cleared()).toEqual([MEI, PRIYA].map(phoneBlindIndex).sort());
          await forgetAda();
          expect(await seatOf(ADA)).toBeUndefined();
          await db.database
            .update(schema.families)
            .set({ scheduledDeletionAt: new Date(NOW.getTime() - 60_000) })
            .where(eq(schema.families.displayName, 'Priya'));
          await runDeletionSweep(db.database, NOW, async () => {});
          expect(await cleared()).toEqual([phoneBlindIndex(MEI)]);
        }, 30_000);
      });
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

describe('migration 0243 over rows written before it', () => {
  const MIGRATION = '0243_shared_list_hidden_cleared.sql';

  it('clears nobody on an item hidden before it, even run twice, and keeps a family role with no child as a claim', async () => {
    const parentNoKid = await person({ inferredRole: 'parent' });
    const guest = await person({ inferredRole: 'guest' });
    const miasMom = await person({ inferredRole: 'parent', inferredKidName: 'Mia' });
    await item(guest.id, 'Lego for Mia', { hiddenForKid: 'Mia' });
    await db.applyMigration(MIGRATION);
    await db.applyMigration(MIGRATION);
    expect((await items())[0]?.hiddenClearedPhoneHashes).toEqual([]);
    const seats = new Map(
      (await db.database.select().from(schema.linqSharedGroupPeople)).map((row) => [row.id, row]),
    );
    expect(seats.get(parentNoKid.id)?.claimsUnnamedKid).toBe(true);
    expect(seats.get(guest.id)?.claimsUnnamedKid).toBe(false);
    expect(seats.get(miasMom.id)?.claimsUnnamedKid).toBe(false);
    expect(seats.get(miasMom.id)?.inferredKidNames).toEqual(['Mia']);
  });
});
