import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { isEnabled } from '@hale/flags';
import { type SQL, and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
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
 * - A HIDDEN GIFT IS NEVER RENDERED TO THE CHILD'S FAMILY. The model decides whether the
 *   group wants a gift kept from the child's family. Once that is written, every read is
 *   for an audience, and an item hidden from anyone in it is left out before the model
 *   sees the list. A turn that touches such an item sends nothing. There is no read
 *   without an audience.
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
  'id' | 'familyId' | 'firstName' | 'inferredKidName'
>;

type ItemRow = schema.SharedGroupListItem;
type Hiding = Pick<ItemRow, 'hiddenForKid' | 'hiddenFromPersonIds' | 'hiddenFromFamilyIds'>;

/** First word, folded: "Mia Chen" and "mia" are one child for hiding. */
function kidKey(name: string | null): string | null {
  const folded = name ? foldListText(name) : '';
  return folded ? (folded.split(' ')[0] ?? null) : null;
}

/**
 * True when anyone in `audience` is the hidden child's family: a person the model named,
 * someone in one of their Hale families, or someone who said in the chat they are that
 * child's parent.
 */
export function hiddenFromAudience(item: Hiding, audience: readonly SharedListPerson[]): boolean {
  const kid = kidKey(item.hiddenForKid);
  const people = new Set(item.hiddenFromPersonIds);
  const families = new Set(item.hiddenFromFamilyIds);
  if (!kid && people.size === 0 && families.size === 0) return false;
  return audience.some(
    (person) =>
      people.has(person.id) ||
      (person.familyId !== null && families.has(person.familyId)) ||
      (kid !== null && kidKey(person.inferredKidName) === kid),
  );
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
 * The chat's items as `audience` may see them: anything hidden from someone in it is
 * left out entirely. The newest SHARED_LIST_READ_MAX, oldest first, and a count of the rest.
 */
export async function readSharedListForAudience(
  database: Database,
  chatId: string,
  audience: readonly SharedListPerson[],
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
  const visible = rows.filter((row) => !hiddenFromAudience(row, audience));
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
      secret:
        row.hiddenForKid !== null ||
        row.hiddenFromPersonIds.length > 0 ||
        row.hiddenFromFamilyIds.length > 0,
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
  /** Set only when the model chose to keep a gift from the child's family and named them. */
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
  const hide =
    raw.gift.keepFromKidFamily && (forKid !== null || personIds.length > 0)
      ? { forKid, personIds }
      : null;
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

export interface SharedListTurnContext {
  chatId: string;
  text: string;
  language: string | null;
  /** The person who sent this message. */
  speaker: SharedListPerson;
  /** Everyone Hale has placed in this chat: they all read the group line. */
  people: readonly SharedListPerson[];
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
  const { items, omitted } = await readSharedListForAudience(
    database,
    context.chatId,
    context.people,
  );
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
  const hideFamilies = [
    ...new Set(
      context.people
        .filter((person) => hidePeople.includes(person.id) && person.familyId)
        .map((person) => person.familyId as string),
    ),
  ];
  const hideValues = decision.hide
    ? {
        hiddenForKid: decision.hide.forKid,
        hiddenFromPersonIds: uuidArray(hidePeople),
        hiddenFromFamilyIds: uuidArray(hideFamilies),
      }
    : {};
  const hideExisting = async (id: string) => {
    if (!decision.hide) return;
    await database
      .update(items)
      .set({
        hiddenForKid: sql`coalesce(${items.hiddenForKid}, ${decision.hide.forKid})`,
        hiddenFromPersonIds: sql`ARRAY(SELECT DISTINCT unnest(${items.hiddenFromPersonIds} || ${uuidArray(hidePeople)}))`,
        hiddenFromFamilyIds: sql`ARRAY(SELECT DISTINCT unnest(${items.hiddenFromFamilyIds} || ${uuidArray(hideFamilies)}))`,
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
    note(expected, hiddenFromAudience(row, context.people) ? 'held' : 'already_on', row.id);
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
    if (hiddenFromAudience(row, context.people)) {
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
    if (after?.owner === speaker) {
      await hideExisting(id);
      note(expected, 'already_yours', id);
    } else {
      note(expected, 'taken', id);
    }
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
  let applied = await applyOnce(database, context, current.snapshot, current.decision, options.now);
  const counts = { ...applied.counts };
  const touched = new Set(applied.touched);
  if (!applied.matched && options.model) {
    const again = await readSharedListTurn(database, context, options.model);
    if (again.kind === 'list') {
      current = again;
      applied = await applyOnce(database, context, again.snapshot, again.decision, options.now);
      for (const [outcome, n] of Object.entries(applied.counts)) {
        counts[outcome as SharedListOutcome] = (counts[outcome as SharedListOutcome] ?? 0) + n;
      }
      for (const id of applied.touched) touched.add(id);
    }
  }
  if (!applied.matched) {
    console.warn({ outcome: 'shared_list_race' }, 'shared list: list moved under the line');
    return { handled: true, line: null, lineWhy: 'race', counts };
  }
  const line = current.decision.reply;
  if (!line) return { handled: true, line: null, lineWhy: 'quiet', counts };
  const rows =
    touched.size === 0
      ? []
      : await database
          .select()
          .from(schema.sharedGroupListItems)
          .where(inArray(schema.sharedGroupListItems.id, [...touched]))
          .orderBy(asc(schema.sharedGroupListItems.addedAt));
  if (rows.some((row) => hiddenFromAudience(row, context.people))) {
    return { handled: true, line: null, lineWhy: 'withheld', counts };
  }
  const said = sharedListTurnUserMessage(current.snapshot.input);
  if (!sharedListLineUsable(line, await options.deny(), said)) {
    console.warn({ outcome: 'shared_list_line_unusable' }, 'shared list: line not sent');
    return { handled: true, line: null, lineWhy: 'withheld', counts };
  }
  return { handled: true, line, lineWhy: 'model', counts };
}

/**
 * When people's presence rows are forgotten (they left, Hale left, or their family was
 * erased), the items they added go and the items they held reopen. A stopped person's
 * row is kept as a tombstone, so the cascade alone would not reach their items.
 */
export async function forgetSharedListPeople(
  database: Database,
  personIds: readonly string[],
): Promise<void> {
  if (personIds.length === 0) return;
  const items = schema.sharedGroupListItems;
  await database.delete(items).where(inArray(items.addedByPersonId, [...personIds]));
  await database
    .update(items)
    .set({ ownerPersonId: null, claimedAt: null })
    .where(inArray(items.ownerPersonId, [...personIds]));
}
