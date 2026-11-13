import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { isEnabled } from '@hale/flags';
import { type SQL, and, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ChatReaders } from '~/lib/channel/linq/participant-readers';
import type { FamilyClaim } from '~/lib/channel/linq/shared-group-reading';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape } from '~/lib/format/link-shape';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { foldListText } from './tools';

/**
 * VIL-687 — a multi-family group's shared list, where each thing gets an owner.
 *
 * "I'll get Mia the Lego" or "we'll bring the salad" gives that item to the person who
 * said it, so gifts and potluck dishes aren't doubled. "What's left?" is answered from
 * the list. A second claim on a taken item is said back, never written over.
 *
 * Nothing here judges words. One model call reads the message against the list as this
 * chat may see it and returns what to write plus the line Hale would say; code checks
 * the writes against what the model saw and sends that line only when the two agree.
 *
 * What the structure decides:
 * - SCOPE IS THE CHAT. Every read and write is bound to `chatId`. Ids the model sees are
 *   per-turn refs (`i1`, `p2`) that code maps back; a ref it did not see is refused.
 * - A HIDDEN GIFT IS SHOWN ONLY ON AN ALLOW-LIST. The model decides whether the group
 *   wants a gift kept from the child's family. Any keep-secret verdict hides the item,
 *   whether or not it names the child or anyone in their family; once it is hidden, it is
 *   shown only while everyone reading the chat was here, seated and cleared when it was
 *   hidden (SharedListAudience). A child or person the model names only takes more people
 *   off. Everyone else hides it, and clearance is only ever taken away. A hidden item left
 *   out is left out before the model sees the list, and a turn that touches one sends
 *   nothing.
 * - THE MODEL'S LINE MUST MATCH WHAT HAPPENED. The line is written from the list the model
 *   saw. If a write came out differently (someone claimed it a moment earlier), the turn
 *   is read once more from the fresh list; a second miss sends nothing.
 * - A FAILED READ IS NOT A LIST TURN. The message goes on to the rest of the group door.
 */

export const SHARED_LIST_TURN_SKILL = 'shared-group-list-turn';
export const SHARED_LIST_TURN_TOOL = 'record_shared_list_turn';
export const SHARED_LIST_TURN_TOOL_DESCRIPTION =
  'What this message does to the shared lists, and the one line Hale says, or null.';
/** Room for adaptive thinking plus the object; the lane caps both together. */
export const SHARED_LIST_TURN_MAX_TOKENS = 2000;
/** At most this many items (the newest) go to the model in one turn; the rest are counted. */
export const SHARED_LIST_READ_MAX = 60;

export type SharedListPerson = Pick<
  schema.LinqSharedGroupPerson,
  | 'id'
  | 'familyId'
  | 'firstName'
  | 'inferredKidName'
  | 'inferredKidNames'
  | 'claimsUnnamedKid'
  | 'phoneE164Hash'
  | 'stoppedAt'
>;

type ItemRow = schema.SharedGroupListItem;
type Hiding = Pick<
  ItemRow,
  | 'hidden'
  | 'hiddenForKid'
  | 'hiddenFromPersonIds'
  | 'hiddenFromFamilyIds'
  | 'hiddenClearedPhoneHashes'
>;

/**
 * First word, folded without accents, possessives or punctuation, so "Zoé Chen", " zoe",
 * "Zoe's" and "Zoe’s" are one child, and "Anne Marie" is "Anne-Marie", for hiding. Whole
 * words are compared, so "Mial" is never "Mia".
 */
function kidKey(name: string | null): string | null {
  const folded = name
    ? foldListText(
        name
          .normalize('NFKD')
          .replace(/\p{M}/gu, '')
          .replace(/['‘’ʼ]s?(?=[^\p{L}\p{N}]|$)/giu, '')
          .replace(/['‘’ʼ]/gu, '')
          .replace(/[^\p{L}\p{N}]+/gu, ' '),
      )
    : '';
  return folded ? (folded.split(' ')[0] ?? null) : null;
}

/**
 * Who reads a list, as one turn knows it.
 *
 * THE ALLOW-LIST. A hidden item is shown only when everyone who can read the chat right now
 * is a seat that was live before this turn began, whose number (blind index) was cleared on
 * that item when it was hidden, and who is not, by anything Hale knows now, the child's
 * family. Anyone else (new, unseated, rejoined on any row, stopped, an Apple ID, a number Hale
 * never seated) hides it, and so does a participant list Hale could not read in full.
 * Clearance is written once, at the hide, for the people Linq lists in the chat at that
 * moment and says joined before the message was sent, on seats that predate the turn (a seat
 * whose person was not listed, such as one written from a webhook that still carries someone
 * who left, or one Linq says was added back after the send while Hale has not yet seen them
 * leave, is not cleared); afterwards it is only ever taken away (a kid-parent claim, leaving,
 * erasure).
 */
export interface SharedListAudience {
  /**
   * Everyone with a seat row in this chat when the turn began, for the model's refs. A live
   * seat outside it was written by someone else during the turn, and hides every hidden item.
   */
  people: readonly SharedListPerson[];
  /**
   * Seats that were live before this turn began and were seated, with a margin for clock
   * skew, before the message was sent. A seat the turn itself wrote (the sender or someone
   * the provider listed), or one written after the message went out, is never cleared at a
   * hide and never counts as placed at a read.
   */
  settledIds: ReadonlySet<string>;
  /**
   * Who can read the chat now, from the provider's participant list, or null when it could
   * not be read in full (failed, not a group, empty, without the speaker, or a handle that
   * is not a number). Asked only when an item in the chat is hidden, and kept until `reask`.
   */
  readers: () => Promise<ChatReaders | null>;
  /**
   * Asks the provider again if it was asked before, since a list read before the model call
   * is stale by the time the line is checked. Null, asking nothing, when it was never asked.
   */
  reask: () => Promise<ChatReaders | null> | null;
}

export function sharedListAudience(
  people: readonly SharedListPerson[],
  settledIds: ReadonlySet<string>,
  readers: () => Promise<ChatReaders | null>,
): SharedListAudience {
  let asked: Promise<ChatReaders | null> | null = null;
  const kept = () => {
    asked ??= readers();
    return asked;
  };
  const reask = () => {
    if (!asked) return null;
    asked = readers();
    return asked;
  };
  return { people, settledIds, readers: kept, reask };
}

/** The children's names in each Hale family's own record, by family id. Never sent to a model. */
async function haleKidsOf(
  database: Database,
  people: readonly SharedListPerson[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const familyIds = [
    ...new Set(people.flatMap((person) => (person.familyId ? [person.familyId] : []))),
  ];
  const rows =
    familyIds.length === 0
      ? []
      : await database
          .select({ familyId: schema.children.familyId, name: schema.children.name })
          .from(schema.children)
          .where(inArray(schema.children.familyId, familyIds));
  const haleKids = new Map<string, string[]>();
  for (const row of rows) {
    const names = haleKids.get(row.familyId);
    if (names) names.push(row.name);
    else haleKids.set(row.familyId, [row.name]);
  }
  return haleKids;
}

function hidesAnything(item: Hiding): boolean {
  return item.hidden;
}

/**
 * True when `person` is, by anything Hale knows now, the hidden child's family: a person the
 * model named, someone in one of their Hale families, someone whose Hale family has a child
 * of that name, or someone who said in the chat they are that child's family (or a child's
 * family without saying which).
 */
function isKidFamily(
  item: Hiding,
  person: SharedListPerson,
  haleKids: ReadonlyMap<string, readonly string[]>,
): boolean {
  const kid = kidKey(item.hiddenForKid);
  const isKid = (name: string | null) => kid !== null && kidKey(name) === kid;
  return (
    item.hiddenFromPersonIds.includes(person.id) ||
    person.claimsUnnamedKid ||
    isKid(person.inferredKidName) ||
    person.inferredKidNames.some(isKid) ||
    (person.familyId !== null &&
      (item.hiddenFromFamilyIds.includes(person.familyId) ||
        (haleKids.get(person.familyId)?.some(isKid) ?? false)))
  );
}

/** Live seats in the chat, read now. */
async function liveSeats(database: Database, chatId: string): Promise<SharedListPerson[]> {
  const people = schema.linqSharedGroupPeople;
  return database
    .select()
    .from(people)
    .where(and(eq(people.chatId, chatId), isNull(people.stoppedAt)));
}

interface Viewers {
  people: readonly SharedListPerson[];
  haleKids: ReadonlyMap<string, readonly string[]>;
}

/**
 * Everyone who can read the chat now, each matched by number to a live seat that predates
 * this turn, with what Hale knows about them read fresh. Null when anyone cannot be placed,
 * or when someone was seated in the chat since the turn began (the provider may not list
 * them yet).
 */
async function viewersNow(
  database: Database,
  chatId: string,
  audience: SharedListAudience,
): Promise<Viewers | null> {
  const listed = await audience.readers();
  if (!listed || listed.hashes.length === 0) return null;
  const live = await liveSeats(database, chatId);
  const known = new Set(audience.people.map((person) => person.id));
  if (live.some((seat) => !known.has(seat.id))) return null;
  const seats = new Map(live.map((row) => [row.phoneE164Hash, row]));
  const people: SharedListPerson[] = [];
  for (const hash of listed.hashes) {
    const seat = seats.get(hash);
    if (!seat || !audience.settledIds.has(seat.id)) return null;
    people.push(seat);
  }
  return { people, haleKids: await haleKidsOf(database, people) };
}

/** True when every viewer was cleared on this item at its hide and is not the child's family. */
function shownTo(item: Hiding, viewers: Viewers | null): boolean {
  if (!hidesAnything(item)) return true;
  if (!viewers) return false;
  const cleared = new Set(item.hiddenClearedPhoneHashes);
  return viewers.people.every(
    (person) => cleared.has(person.phoneE164Hash) && !isKidFamily(item, person, viewers.haleKids),
  );
}

/**
 * The rows `audience` may not see. The participant list is asked for only when one of
 * `rows` is hidden.
 */
async function withheldFrom(
  database: Database,
  chatId: string,
  audience: SharedListAudience,
  rows: readonly ItemRow[],
): Promise<Set<string>> {
  if (!rows.some(hidesAnything)) return new Set();
  const viewers = await viewersNow(database, chatId, audience);
  return new Set(rows.filter((row) => !shownTo(row, viewers)).map((row) => row.id));
}

/**
 * Serialises every write and check of hidden-gift clearance in one chat: a hide, a turn's
 * final check of what it may say, a kid-parent claim and a seat leaving. Whichever comes
 * second sees what the first wrote.
 */
export function withSharedListLock<T>(
  database: Database,
  chatId: string,
  work: (tx: Database) => Promise<T>,
): Promise<T> {
  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`shared_group_list:${chatId}`}))`);
    return work(tx);
  });
}

export interface SharedListItemView {
  id: string;
  listName: string;
  listKey: string;
  text: string;
  textKey: string;
  ownerPersonId: string | null;
  /** Kept from a child's family (who may not be in this audience). */
  secret: boolean;
  /** The child a secret gift is for, as said in the chat. */
  forKid: string | null;
}

/**
 * The chat's items as `audience` may see them: a hidden item the allow-list does not clear
 * for everyone reading now is left out entirely. The newest SHARED_LIST_READ_MAX, oldest
 * first, and a count of the rest.
 */
export async function readSharedListForAudience(
  database: Database,
  chatId: string,
  audience: SharedListAudience,
): Promise<{ items: SharedListItemView[]; omitted: number }> {
  const rows = await database
    .select()
    .from(schema.sharedGroupListItems)
    .where(eq(schema.sharedGroupListItems.chatId, chatId))
    // Things added in one message share a time; the text breaks the tie so refs are stable.
    .orderBy(
      desc(schema.sharedGroupListItems.addedAt),
      desc(schema.sharedGroupListItems.listKey),
      desc(schema.sharedGroupListItems.textKey),
    );
  const withheld = await withheldFrom(database, chatId, audience, rows);
  const visible = rows.filter((row) => !withheld.has(row.id));
  const shown = visible.slice(0, SHARED_LIST_READ_MAX).reverse();
  return {
    omitted: visible.length - shown.length,
    items: shown.map((row) => ({
      id: row.id,
      listName: row.listName,
      listKey: row.listKey,
      text: row.text,
      textKey: row.textKey,
      ownerPersonId: row.ownerPersonId,
      secret: hidesAnything(row),
      forKid: row.hiddenForKid,
    })),
  };
}

// ---------------------------------------------------------------------------------------
// The model's view and answer.

export interface SharedListTurnInput {
  text: string;
  language: string | null;
  speaker: string;
  people: { ref: string; firstName: string | null; kidName: string | null }[];
  items: {
    ref: string;
    list: string;
    text: string;
    owner: string | null;
    secret: boolean;
    forKid: string | null;
  }[];
  omitted: number;
}

export const sharedListTurnJsonSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    listTurn: { type: 'boolean' },
    list: { type: ['string', 'null'] },
    add: { type: 'array', items: { type: 'string' } },
    claim: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { item: { type: ['string', 'null'] }, text: { type: ['string', 'null'] } },
        required: ['item', 'text'],
      },
    },
    release: { type: 'array', items: { type: 'string' } },
    gift: {
      type: 'object',
      additionalProperties: false,
      properties: {
        forKid: { type: ['string', 'null'] },
        keepFromKidFamily: { type: 'boolean' },
        kidFamily: { type: 'array', items: { type: 'string' } },
      },
      required: ['forKid', 'keepFromKidFamily', 'kidFamily'],
    },
    reply: { type: ['string', 'null'] },
  },
  required: ['listTurn', 'list', 'add', 'claim', 'release', 'gift', 'reply'],
};

const decisionSchema = z
  .object({
    listTurn: z.boolean(),
    list: z.string().nullable(),
    add: z.array(z.string()),
    claim: z.array(z.object({ item: z.string().nullable(), text: z.string().nullable() }).strict()),
    release: z.array(z.string()),
    gift: z
      .object({
        forKid: z.string().nullable(),
        keepFromKidFamily: z.boolean(),
        kidFamily: z.array(z.string()),
      })
      .strict(),
    reply: z.string().nullable(),
  })
  .strict();

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function sharedListTurnUserMessage(input: SharedListTurnInput): string {
  return JSON.stringify(input);
}

export type SharedListClaim = { item: SharedListItemView } | { text: string };

export interface SharedListDecision {
  listName: string | null;
  add: string[];
  claim: SharedListClaim[];
  release: SharedListItemView[];
  /**
   * Set whenever the model chose to keep a gift from the child's family, whether or not it
   * named the child (a name it gave that is out of bounds is dropped) or anyone in the family.
   */
  hide: { forKid: string | null; personIds: string[] } | null;
  reply: string | null;
}

export interface SharedListRefs {
  items: ReadonlyMap<string, SharedListItemView>;
  people: ReadonlyMap<string, SharedListPerson>;
}

const clean = (value: string | null, max: number): string | null => {
  const text = value?.trim() ?? '';
  return text.length > 0 && text.length <= max ? text : null;
};

/**
 * The model's object, checked. `null` is a malformed answer (unknown ref, a write with no
 * list to put it on, a field out of bounds). `'none'` is a message that is not about a
 * shared list.
 */
export function parseSharedListDecision(
  value: unknown,
  refs: SharedListRefs,
): SharedListDecision | 'none' | null {
  const parsed = decisionSchema.safeParse(value);
  if (!parsed.success) return null;
  const raw = parsed.data;
  if (!raw.listTurn) return 'none';
  const listName = raw.list === null ? null : clean(raw.list, 200);
  if (raw.list !== null && listName === null) return null;
  const add: string[] = [];
  for (const text of raw.add) {
    const item = clean(text, 500);
    if (!item) return null;
    add.push(item);
  }
  const claim: SharedListClaim[] = [];
  for (const entry of raw.claim) {
    if (entry.item !== null) {
      const item = refs.items.get(entry.item);
      if (!item) return null;
      claim.push({ item });
      continue;
    }
    const text = clean(entry.text, 500);
    if (!text) return null;
    claim.push({ text });
  }
  const release: SharedListItemView[] = [];
  for (const ref of raw.release) {
    const item = refs.items.get(ref);
    if (!item) return null;
    release.push(item);
  }
  const needsList = add.length > 0 || claim.some((entry) => 'text' in entry);
  if (needsList && !listName) return null;
  const personIds: string[] = [];
  for (const ref of raw.gift.kidFamily) {
    const person = refs.people.get(ref);
    if (!person) return null;
    personIds.push(person.id);
  }
  const forKid = raw.gift.forKid === null ? null : clean(raw.gift.forKid, 100);
  const hide = raw.gift.keepFromKidFamily ? { forKid, personIds } : null;
  return { listName, add, claim, release, hide, reply: clean(raw.reply, 1000) };
}

export interface SharedListTurnModel {
  decide(input: SharedListTurnInput): Promise<unknown>;
}

let shared: SharedListTurnModel | null = null;

/** Production model, or null when no model may run (no key, or voice switched off). */
export function sharedListTurnModel(): SharedListTurnModel | null {
  if (!process.env.ANTHROPIC_API_KEY || !isEnabled('voice')) return null;
  shared ??= {
    async decide(input) {
      const skill = await loadCronSkill(SHARED_LIST_TURN_SKILL);
      const { value } = await forceToolJson({
        client: budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS, { stage: 'group' }),
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: sharedListTurnUserMessage(input),
        toolName: SHARED_LIST_TURN_TOOL,
        toolDescription: SHARED_LIST_TURN_TOOL_DESCRIPTION,
        inputJsonSchema: sharedListTurnJsonSchema,
        schema: decisionSchema,
        maxTokens: SHARED_LIST_TURN_MAX_TOKENS,
      });
      return value;
    },
  };
  return shared;
}

// ---------------------------------------------------------------------------------------
// One turn.

export interface SharedListTurnContext extends SharedListAudience {
  chatId: string;
  text: string;
  language: string | null;
  /** The person who sent this message. */
  speaker: SharedListPerson;
}

interface Snapshot {
  items: SharedListItemView[];
  refs: SharedListRefs;
  input: SharedListTurnInput;
}

export type SharedListRead =
  | { kind: 'unavailable' }
  | { kind: 'unread' }
  | { kind: 'none' }
  | { kind: 'list'; snapshot: Snapshot; decision: SharedListDecision };

async function snapshotFor(database: Database, context: SharedListTurnContext): Promise<Snapshot> {
  const { items, omitted } = await readSharedListForAudience(database, context.chatId, context);
  const personRef = new Map(context.people.map((person, index) => [person.id, `p${index + 1}`]));
  const itemRefs = new Map(items.map((item, index) => [`i${index + 1}`, item]));
  return {
    items,
    refs: {
      items: itemRefs,
      people: new Map(context.people.map((person, index) => [`p${index + 1}`, person])),
    },
    input: {
      text: context.text,
      language: context.language,
      speaker: personRef.get(context.speaker.id) ?? 'unknown',
      people: context.people.map((person, index) => ({
        ref: `p${index + 1}`,
        firstName: person.firstName,
        kidName: person.inferredKidName,
      })),
      items: [...itemRefs].map(([ref, item]) => ({
        ref,
        list: item.listName,
        text: item.text,
        owner: item.ownerPersonId ? (personRef.get(item.ownerPersonId) ?? 'someone') : null,
        secret: item.secret,
        forKid: item.forKid,
      })),
      omitted,
    },
  };
}

async function decideOnce(
  model: SharedListTurnModel,
  snapshot: Snapshot,
): Promise<SharedListDecision | 'none' | null> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const decision = parseSharedListDecision(await model.decide(snapshot.input), snapshot.refs);
      if (decision !== null) return decision;
      console.warn({ attempt }, 'shared list: malformed list read');
    } catch (err) {
      console.warn(
        { attempt, err: err instanceof Error ? err.name : 'unknown' },
        'shared list: list read failed',
      );
    }
  }
  return null;
}

/** Reads this message against the list. Writes nothing. */
export async function readSharedListTurn(
  database: Database,
  context: SharedListTurnContext,
  model: SharedListTurnModel | null,
): Promise<SharedListRead> {
  if (!model) {
    console.warn({ outcome: 'list_model_unavailable' }, 'shared list: no model, turn not read');
    return { kind: 'unavailable' };
  }
  const snapshot = await snapshotFor(database, context);
  const decision = await decideOnce(model, snapshot);
  if (decision === null) {
    console.error({ outcome: 'shared_list_unread' }, 'shared list: no list write');
    return { kind: 'unread' };
  }
  if (decision === 'none') return { kind: 'none' };
  return { kind: 'list', snapshot, decision };
}

export type SharedListOutcome =
  | 'added'
  | 'already_on'
  | 'claimed'
  | 'already_yours'
  | 'taken'
  | 'released'
  | 'not_yours'
  | 'held';

export type SharedListLine = 'model' | 'quiet' | 'withheld' | 'race';

export type SharedListTurnResult =
  | { handled: false; why: 'unavailable' | 'unread' | 'none' | 'failed' }
  | {
      handled: true;
      line: string | null;
      lineWhy: SharedListLine;
      counts: Partial<Record<SharedListOutcome, number>>;
    };

function uuidArray(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`'{}'::uuid[]`;
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}

function textArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`'{}'::text[]`;
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

const keyOf = (listKey: string, textKey: string) => `${listKey}\u0000${textKey}`;

interface Applied {
  touched: Set<string>;
  counts: Partial<Record<SharedListOutcome, number>>;
  matched: boolean;
}

async function applyOnce(
  database: Database,
  context: SharedListTurnContext,
  snapshot: Snapshot,
  decision: SharedListDecision,
  now: Date,
): Promise<Applied> {
  const items = schema.sharedGroupListItems;
  const speaker = context.speaker.id;
  const touched = new Set<string>();
  const counts: Partial<Record<SharedListOutcome, number>> = {};
  let matched = true;
  // What the model saw, played forward through this turn's own writes: the outcome each
  // write should have if nobody else touched the list in between.
  const seen = new Map(
    snapshot.items.map((item) => [keyOf(item.listKey, item.textKey), item.ownerPersonId]),
  );
  const note = (expected: SharedListOutcome, actual: SharedListOutcome, id: string | null) => {
    counts[actual] = (counts[actual] ?? 0) + 1;
    if (expected !== actual) matched = false;
    if (id) touched.add(id);
  };
  const hidePeople = decision.hide?.personIds ?? [];
  const named = context.people.filter((person) => hidePeople.includes(person.id));
  const hideFamilies = [
    ...new Set(
      named.filter((person) => person.familyId).map((person) => person.familyId as string),
    ),
  ];
  const hiding: Hiding = {
    hidden: decision.hide !== null,
    hiddenForKid: decision.hide?.forKid ?? null,
    hiddenFromPersonIds: hidePeople,
    hiddenFromFamilyIds: hideFamilies,
    hiddenClearedPhoneHashes: [],
  };
  // Cleared at the hide: people Linq lists in the chat now and says joined before the message
  // was sent, each on a seat that predates this turn and is still live, read under the chat's
  // lock so a leave or a kid-parent claim that landed during the model call counts, and not
  // the child's family by anything Hale knows now. A list Hale could not read clears nobody.
  // Never anyone else, ever after.
  const listed = decision.hide ? await context.readers() : null;
  const present = listed ? listed.presentAtSend : new Set<string>();
  const settled = decision.hide
    ? (await liveSeats(database, context.chatId)).filter(
        (person) => context.settledIds.has(person.id) && present.has(person.phoneE164Hash),
      )
    : [];
  const settledKids = await haleKidsOf(database, settled);
  const cleared = textArray(
    settled
      .filter((person) => !isKidFamily(hiding, person, settledKids))
      .map((person) => person.phoneE164Hash),
  );
  let viewers: Promise<Viewers | null> | null = null;
  const withheldNow = async (row: ItemRow) => {
    if (!hidesAnything(row)) return false;
    viewers ??= viewersNow(database, context.chatId, context);
    return !shownTo(row, await viewers);
  };
  const hideValues = decision.hide
    ? {
        hidden: true,
        hiddenForKid: decision.hide.forKid,
        hiddenFromPersonIds: uuidArray(hidePeople),
        hiddenFromFamilyIds: uuidArray(hideFamilies),
        hiddenClearedPhoneHashes: cleared,
      }
    : {};
  // Hiding an item already on the list only ever narrows who sees it, so it applies to any
  // write the speaker asked to keep secret: an add or claim of it, and a claim someone else won.
  const hideExisting = async (id: string) => {
    if (!decision.hide) return;
    await database
      .update(items)
      .set({
        hidden: true,
        hiddenForKid: sql`coalesce(${items.hiddenForKid}, ${decision.hide.forKid})`,
        hiddenFromPersonIds: sql`ARRAY(SELECT DISTINCT unnest(${items.hiddenFromPersonIds} || ${uuidArray(hidePeople)}))`,
        hiddenFromFamilyIds: sql`ARRAY(SELECT DISTINCT unnest(${items.hiddenFromFamilyIds} || ${uuidArray(hideFamilies)}))`,
        // Hidden twice, only someone cleared both times is cleared.
        hiddenClearedPhoneHashes: sql`CASE WHEN ${items.hidden} THEN ARRAY(SELECT unnest(${items.hiddenClearedPhoneHashes}) INTERSECT SELECT unnest(${cleared})) ELSE ${cleared} END`,
      })
      .where(eq(items.id, id));
  };
  const existing = async (listKey: string, textKey: string) => {
    const [row] = await database
      .select()
      .from(items)
      .where(
        and(
          eq(items.chatId, context.chatId),
          eq(items.listKey, listKey),
          eq(items.textKey, textKey),
        ),
      )
      .limit(1);
    return row;
  };
  const listName = decision.listName;
  const listKey = listName ? foldListText(listName) : null;

  for (const text of decision.add) {
    if (!listName || !listKey) break;
    const textKey = foldListText(text);
    const key = keyOf(listKey, textKey);
    const expected: SharedListOutcome = seen.has(key) ? 'already_on' : 'added';
    if (!seen.has(key)) seen.set(key, null);
    const [inserted] = await database
      .insert(items)
      .values({
        chatId: context.chatId,
        listName,
        listKey,
        text,
        textKey,
        addedByPersonId: speaker,
        addedAt: now,
        ...hideValues,
      })
      .onConflictDoNothing()
      .returning({ id: items.id });
    if (inserted) {
      note(expected, 'added', inserted.id);
      continue;
    }
    const row = await existing(listKey, textKey);
    if (!row) throw new Error('shared list: item insert returned no row');
    if (await withheldNow(row)) {
      note(expected, 'held', row.id);
      continue;
    }
    await hideExisting(row.id);
    note(expected, 'already_on', row.id);
  }

  for (const entry of decision.claim) {
    const target =
      'item' in entry
        ? { listKey: entry.item.listKey, textKey: entry.item.textKey, id: entry.item.id }
        : listName && listKey
          ? { listKey, textKey: foldListText(entry.text), id: null }
          : null;
    if (!target) continue;
    const key = keyOf(target.listKey, target.textKey);
    const before = seen.get(key);
    const expected: SharedListOutcome =
      before === undefined || before === null
        ? 'claimed'
        : before === speaker
          ? 'already_yours'
          : 'taken';
    if (expected === 'claimed') seen.set(key, speaker);
    let id = target.id;
    if (!id && 'text' in entry && listName) {
      const [inserted] = await database
        .insert(items)
        .values({
          chatId: context.chatId,
          listName,
          listKey: target.listKey,
          text: entry.text,
          textKey: target.textKey,
          addedByPersonId: speaker,
          ownerPersonId: speaker,
          claimedAt: now,
          addedAt: now,
          ...hideValues,
        })
        .onConflictDoNothing()
        .returning({ id: items.id });
      if (inserted) {
        note(expected, 'claimed', inserted.id);
        continue;
      }
      id = (await existing(target.listKey, target.textKey))?.id ?? null;
      if (!id) throw new Error('shared list: item insert returned no row');
    }
    if (!id) continue;
    const [row] = await database.select().from(items).where(eq(items.id, id)).limit(1);
    if (!row) {
      note(expected, 'held', null);
      continue;
    }
    if (await withheldNow(row)) {
      note(expected, 'held', row.id);
      continue;
    }
    const [won] = await database
      .update(items)
      .set({ ownerPersonId: speaker, claimedAt: now })
      .where(and(eq(items.id, id), isNull(items.ownerPersonId)))
      .returning({ id: items.id });
    if (won) {
      await hideExisting(won.id);
      note(expected, 'claimed', won.id);
      continue;
    }
    const [after] = await database
      .select({ owner: items.ownerPersonId })
      .from(items)
      .where(eq(items.id, id))
      .limit(1);
    await hideExisting(id);
    note(expected, after?.owner === speaker ? 'already_yours' : 'taken', id);
  }

  for (const item of decision.release) {
    const key = keyOf(item.listKey, item.textKey);
    const expected: SharedListOutcome = seen.get(key) === speaker ? 'released' : 'not_yours';
    if (expected === 'released') seen.set(key, null);
    const [freed] = await database
      .update(items)
      .set({ ownerPersonId: null, claimedAt: null })
      .where(and(eq(items.id, item.id), eq(items.ownerPersonId, speaker)))
      .returning({ id: items.id });
    note(expected, freed ? 'released' : 'not_yours', item.id);
  }

  return { touched, counts, matched };
}

/** Same format gates as the other shared-group lines: no link, no phone number. */
const PHONE_SHAPE = /\+\d[\d\s-]{7,}/;

/**
 * A line may not carry a household's private term (`deny`) unless someone in this chat
 * said it: the model only ever saw what was said here, so a term in its input came from
 * the chat, not from a family's inbox, calendar or kids.
 */
export function sharedListLineUsable(line: string, deny: readonly string[], said: string): boolean {
  if (!line.trim() || hasLinkShape(line) || PHONE_SHAPE.test(line)) return false;
  const folded = foldListText(line);
  const heard = foldListText(said);
  return !deny.some((token) => {
    const needle = foldListText(token);
    return needle.length >= 3 && folded.includes(needle) && !heard.includes(needle);
  });
}

interface Pass {
  applied: Applied;
  /** An item the line could name (touched now, or shown to the model) is not cleared now. */
  exposed: boolean;
}

/**
 * One write of a read, and the check of what its line may say, under the chat's lock: the
 * check reads seats and clearance as they are after every claim or leave that came first.
 */
async function applyLocked(
  database: Database,
  context: SharedListTurnContext,
  current: { snapshot: Snapshot; decision: SharedListDecision },
  now: Date,
): Promise<Pass> {
  // Who can read the chat is asked after the model call, outside the lock, so the check
  // below sees anyone added while the model was reading, and a provider call never holds
  // the chat's lock open. A list read for the snapshot is asked again; a hide asks it for who
  // it clears and for its line.
  await (context.reask() ?? (current.decision.hide ? context.readers() : null));
  return withSharedListLock(database, context.chatId, async (tx) => {
    const applied = await applyOnce(tx, context, current.snapshot, current.decision, now);
    const ids = [
      ...new Set([...applied.touched, ...current.snapshot.items.map((item) => item.id)]),
    ];
    const rows =
      ids.length === 0
        ? []
        : await tx
            .select()
            .from(schema.sharedGroupListItems)
            .where(inArray(schema.sharedGroupListItems.id, ids));
    const withheld = await withheldFrom(tx, context.chatId, context, rows);
    return { applied, exposed: withheld.size > 0 };
  });
}

/**
 * Applies a read. `read` came from readSharedListTurn on this same message; when a write
 * came out differently from what the model saw, the message is read once more from the
 * fresh list and applied again (every write is idempotent for the same speaker).
 */
export async function applySharedListTurn(
  database: Database,
  context: SharedListTurnContext,
  read: SharedListRead | { kind: 'failed' },
  options: {
    model: SharedListTurnModel | null;
    now: Date;
    deny: () => Promise<readonly string[]>;
  },
): Promise<SharedListTurnResult> {
  if (read.kind !== 'list') return { handled: false, why: read.kind };
  let current: { snapshot: Snapshot; decision: SharedListDecision } = read;
  let pass = await applyLocked(database, context, current, options.now);
  const counts = { ...pass.applied.counts };
  if (!pass.applied.matched && options.model) {
    // The second read calls the model, so it runs outside the lock.
    const again = await readSharedListTurn(database, context, options.model);
    if (again.kind === 'list') {
      current = again;
      pass = await applyLocked(database, context, current, options.now);
      for (const [outcome, n] of Object.entries(pass.applied.counts)) {
        counts[outcome as SharedListOutcome] = (counts[outcome as SharedListOutcome] ?? 0) + n;
      }
    }
  }
  // A write that met an item this chat may not see says nothing, in the group or 1:1.
  if (counts.held) return { handled: true, line: null, lineWhy: 'withheld', counts };
  if (!pass.applied.matched) {
    console.warn({ outcome: 'shared_list_race' }, 'shared list: list moved under the line');
    return { handled: true, line: null, lineWhy: 'race', counts };
  }
  const line = current.decision.reply;
  if (!line) return { handled: true, line: null, lineWhy: 'quiet', counts };
  if (pass.exposed) return { handled: true, line: null, lineWhy: 'withheld', counts };
  const said = sharedListTurnUserMessage(current.snapshot.input);
  if (!sharedListLineUsable(line, await options.deny(), said)) {
    console.warn({ outcome: 'shared_list_line_unusable' }, 'shared list: line not sent');
    return { handled: true, line: null, lineWhy: 'withheld', counts };
  }
  return { handled: true, line, lineWhy: 'model', counts };
}

/**
 * A kid-parent claim made in the chat. The seat keeps every child named, added to what it
 * held (never replaced), and the person's number comes off every hidden gift for any of
 * them. A claim that names no child takes the number off every hidden gift in the chat and
 * keeps the seat from being cleared at any later hide. Under the chat's lock, so a hide read
 * at the same time either sees the claim or is undone by it.
 */
export async function recordKidClaim(
  database: Database,
  input: { chatId: string; seatId: string; claim: FamilyClaim },
): Promise<void> {
  const people = schema.linqSharedGroupPeople;
  const items = schema.sharedGroupListItems;
  await withSharedListLock(database, input.chatId, async (tx) => {
    const [seat] = await tx
      .update(people)
      .set(
        input.claim === 'unnamed'
          ? { claimsUnnamedKid: true }
          : {
              inferredKidNames: sql`ARRAY(SELECT DISTINCT unnest(${people.inferredKidNames} || ${textArray(input.claim.kids)}))`,
            },
      )
      .where(eq(people.id, input.seatId))
      .returning({ hash: people.phoneE164Hash });
    if (!seat) return;
    const rows = await tx
      .select({ id: items.id, hiddenForKid: items.hiddenForKid })
      .from(items)
      .where(
        and(
          eq(items.chatId, input.chatId),
          sql`${seat.hash} = ANY(${items.hiddenClearedPhoneHashes})`,
        ),
      );
    const claim = input.claim;
    const kids =
      claim === 'unnamed' ? null : new Set(claim.kids.map(kidKey).filter((key) => key !== null));
    const ids = rows
      .filter((row) => {
        if (!kids) return true;
        const kid = kidKey(row.hiddenForKid);
        return kid !== null && kids.has(kid);
      })
      .map((row) => row.id);
    if (ids.length === 0) return;
    await tx
      .update(items)
      .set({
        hiddenClearedPhoneHashes: sql`array_remove(${items.hiddenClearedPhoneHashes}, ${seat.hash})`,
      })
      .where(inArray(items.id, ids));
  });
}

/** Why presence rows are forgotten: they or Hale left the chat, or their family was erased. */
export type SharedListForgetReason = 'left' | 'erased';

/**
 * When people's presence rows are forgotten, the items they added and their own claims go,
 * and the items they held reopen. On leaving, an item they added that someone staying has
 * claimed passes to that person; on erasure it goes too, since its text is what the erased
 * person typed. A stopped person's row is kept as a tombstone, so the cascade alone would
 * not reach their items; an item passed on first is out of the cascade's reach. Their
 * numbers come off every hidden gift's cleared numbers in that chat, so coming back on a
 * new seat counts as new, and no number is kept past the seat it belonged to.
 */
export async function forgetSharedListPeople(
  database: Database,
  personIds: readonly string[],
  reason: SharedListForgetReason,
): Promise<void> {
  if (personIds.length === 0) return;
  const items = schema.sharedGroupListItems;
  const people = schema.linqSharedGroupPeople;
  const ids = [...personIds];
  const seats = await database
    .select({ chatId: people.chatId, hash: people.phoneE164Hash })
    .from(people)
    .where(inArray(people.id, ids));
  for (const seat of seats) {
    await database
      .update(items)
      .set({
        hiddenClearedPhoneHashes: sql`array_remove(${items.hiddenClearedPhoneHashes}, ${seat.hash})`,
      })
      .where(
        and(
          eq(items.chatId, seat.chatId),
          sql`${seat.hash} = ANY(${items.hiddenClearedPhoneHashes})`,
        ),
      );
  }
  if (reason === 'left') {
    await database
      .update(items)
      .set({ addedByPersonId: sql`${items.ownerPersonId}` })
      .where(
        and(
          inArray(items.addedByPersonId, ids),
          isNotNull(items.ownerPersonId),
          notInArray(items.ownerPersonId, ids),
        ),
      );
  }
  await database.delete(items).where(inArray(items.addedByPersonId, ids));
  await database
    .update(items)
    .set({ ownerPersonId: null, claimedAt: null })
    .where(inArray(items.ownerPersonId, ids));
}
