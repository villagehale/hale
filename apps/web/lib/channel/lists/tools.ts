import { type RegisteredTool, type Skill, defineTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';

/**
 * VIL-447 (T23) — the coach's shared-list verbs for a family group.
 *
 * Nothing here judges words. The model reads, in any language and any wording, that
 * someone is adding ("we're out of milk"), checking something off ("got it"), or asking
 * what's on a list, and calls a verb. Hale's reply is the model's own text from what the
 * verb returns (list name, items, who added what); this module writes no parent-facing
 * copy at all. When the flag is on, the reply's tone is the coach-group-lists skill
 * (a friend in the chat, in any language, not a record of what was saved), loaded by
 * name and appended by
 * appendGroupListsReply. A dark flag does not load it, so other coach prompt bytes stay put.
 *
 * What the structure decides:
 * - SCOPE IS THE GROUP THREAD, from the turn, never from the model. Every read and write
 *   is bound to `conversationId`; a tool context whose family differs is refused. So a
 *   list made in one group is never read in another group or in a 1:1.
 * - IDS ARE HALE'S. Checking off takes `itemId`s that list_group_lists returned for this
 *   thread; anything else is refused.
 * - NO SIZE CAP on what is STORED (ticket scope); items are bounded only by the column
 *   check (500 chars). What one list_group_lists call RETURNS is bounded (see
 *   READ_BUDGET_CHARS) so a long list stays readable under the tool-result ceiling: the
 *   most recent open items, and an `omittedCount` the model can read and say.
 * - THE THREAD IS THE FAMILY'S. Every verb first confirms the conversation is this
 *   family's (and 0199's composite FK makes the pairing impossible to store otherwise).
 * - A FAILED TURN LEAVES NO LIST WRITE. Writes go in the turn's journal; when the turn
 *   fails (no reply goes out), the runtime undoes them, so the router's "nothing was
 *   changed" stays true. Hale never writes a sentence about it.
 * - NAMES ARE READ, NOT STORED. `addedBy` is the first name on the person's user row,
 *   read at call time; a person the group has not named shows as null.
 */
export const LIST_GROUP_LISTS_TOOL = 'list_group_lists';
export const ADD_TO_GROUP_LIST_TOOL = 'add_to_group_list';
export const CHECK_OFF_GROUP_LIST_TOOL = 'check_off_group_list_items';
export const GROUP_LIST_TOOL_NAMES = [
  LIST_GROUP_LISTS_TOOL,
  ADD_TO_GROUP_LIST_TOOL,
  CHECK_OFF_GROUP_LIST_TOOL,
] as const;

export interface GroupListToolPorts {
  database: Database;
  familyId: string;
  /** The group thread this turn belongs to. */
  conversationId: string;
  /** The person who sent this group message. */
  actorUserId: string;
  now: Date;
  /** This turn's write journal; the runtime undoes it when the turn fails. */
  journal?: GroupListJournal;
}

/**
 * What one turn wrote, so a turn that fails before any reply leaves the lists as it found
 * them. Undo is narrow on purpose: it deletes only items this turn inserted that are
 * still open AND that no other turn was told were already on (`claimedAt`, set when a
 * concurrent add lands on this row; their `alreadyOn` stays true), un-checks only items this turn checked (same instant, same person), and
 * removes a list this turn made only if nothing else is on it.
 */
export interface GroupListJournal {
  createdListIds: string[];
  insertedItemIds: string[];
  checkedItemIds: string[];
}

export function createGroupListJournal(): GroupListJournal {
  return { createdListIds: [], insertedItemIds: [], checkedItemIds: [] };
}

export async function undoGroupListWrites(
  ports: Pick<GroupListToolPorts, 'database' | 'actorUserId' | 'now'>,
  journal: GroupListJournal,
): Promise<void> {
  const db = ports.database;
  const { createdListIds, insertedItemIds, checkedItemIds } = journal;
  if (checkedItemIds.length > 0) {
    await db
      .update(schema.groupListItems)
      .set({ checkedAt: null, checkedByUserId: null })
      .where(
        and(
          inArray(schema.groupListItems.id, checkedItemIds),
          eq(schema.groupListItems.checkedAt, ports.now),
          eq(schema.groupListItems.checkedByUserId, ports.actorUserId),
        ),
      )
      // Someone re-added the same thing meanwhile: the open-key index refuses a second
      // open row, and their row is the one that stays.
      .catch(() => undefined);
  }
  if (insertedItemIds.length > 0) {
    await db
      .delete(schema.groupListItems)
      .where(
        and(
          inArray(schema.groupListItems.id, insertedItemIds),
          isNull(schema.groupListItems.checkedAt),
          isNull(schema.groupListItems.claimedAt),
        ),
      );
  }
  if (createdListIds.length > 0) {
    await db
      .delete(schema.groupLists)
      .where(
        and(
          inArray(schema.groupLists.id, createdListIds),
          sql`NOT EXISTS (SELECT 1 FROM ${schema.groupListItems} WHERE ${schema.groupListItems.listId} = ${schema.groupLists.id})`,
        ),
      );
  }
  journal.createdListIds = [];
  journal.insertedItemIds = [];
  journal.checkedItemIds = [];
}

/**
 * The most a single list_group_lists result spends on items, in JSON characters. The
 * loop's tool-result ceiling is 8,000; this leaves room for names, ids and counts.
 */
export const READ_BUDGET_CHARS = 6000;
/** Lists beyond this many (newest first per page) are counted, not returned, in one read. */
export const READ_MAX_LISTS = 20;

/** Case, width and spacing folded, so "Milk" and "milk " are one item and one list. */
export function foldListText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function requireScope(ports: GroupListToolPorts, familyId: string): void {
  if (familyId !== ports.familyId) {
    throw new Error('This tool only acts for the group in this conversation.');
  }
}

/** The thread must be this family's; a mismatched pair reads and writes nothing. */
async function requireThread(ports: GroupListToolPorts): Promise<void> {
  const [row] = await ports.database
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, ports.conversationId),
        eq(schema.conversations.familyId, ports.familyId),
      ),
    )
    .limit(1);
  if (!row) throw new Error('This tool only acts for the group in this conversation.');
}

function firstName(row: { givenName: string | null; name: string | null } | undefined) {
  const raw = row?.givenName?.trim() || row?.name?.trim() || '';
  return raw ? (raw.split(/\s+/)[0] ?? null) : null;
}

async function namesFor(db: Database, ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) return new Map<string, string | null>();
  const rows = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      givenName: schema.users.googleGivenName,
    })
    .from(schema.users)
    .where(inArray(schema.users.id, unique));
  return new Map(rows.map((r) => [r.id, firstName(r)]));
}

async function liveLists(ports: GroupListToolPorts, newestFirst = false) {
  return ports.database
    .select({
      id: schema.groupLists.id,
      name: schema.groupLists.name,
      nameKey: schema.groupLists.nameKey,
    })
    .from(schema.groupLists)
    .where(
      and(
        eq(schema.groupLists.conversationId, ports.conversationId),
        eq(schema.groupLists.familyId, ports.familyId),
        isNull(schema.groupLists.archivedAt),
      ),
    )
    .orderBy(
      newestFirst ? desc(schema.groupLists.createdAt) : asc(schema.groupLists.createdAt),
      newestFirst ? desc(schema.groupLists.id) : asc(schema.groupLists.id),
    );
}

export interface ReadGroupListsOptions {
  /** Read only the list whose folded name matches. */
  listName?: string;
  /** At most this many open items per list (the most recent ones). */
  limit?: number;
  /** Skip this many lists (newest first) — the next page after `omittedLists`. */
  offset?: number;
}

/**
 * The lists in this group thread with their open items. Bounded per call: each list gets
 * an equal share of READ_BUDGET_CHARS and shows its MOST RECENT open items that fit
 * (returned oldest first), with `omittedCount` for the rest; lists past READ_MAX_LISTS are
 * counted in `omittedLists`. Nothing is cut mid-item.
 */
export async function readGroupLists(
  ports: GroupListToolPorts,
  options: ReadGroupListsOptions = {},
) {
  return (await readGroupListsPage(ports, options)).lists;
}

export async function readGroupListsPage(
  ports: GroupListToolPorts,
  options: ReadGroupListsOptions = {},
) {
  await requireThread(ports);
  // Newest first, so a 21st list is the one shown, not the one hidden; `offset` pages
  // back to older ones. `listName` filters the whole thread before any paging.
  let lists = await liveLists(ports, true);
  if (options.listName !== undefined) {
    const key = foldListText(options.listName);
    lists = lists.filter((l) => l.nameKey === key);
  }
  const offset = options.offset ?? 0;
  const omittedLists = Math.max(0, lists.length - offset - READ_MAX_LISTS);
  // The page is picked newest first, then shown in creation order like before.
  lists = lists.slice(offset, offset + READ_MAX_LISTS).reverse();
  if (lists.length === 0) return { lists: [], omittedLists };
  const items = await ports.database
    .select({
      id: schema.groupListItems.id,
      listId: schema.groupListItems.listId,
      text: schema.groupListItems.text,
      addedByUserId: schema.groupListItems.addedByUserId,
    })
    .from(schema.groupListItems)
    .where(
      and(
        inArray(
          schema.groupListItems.listId,
          lists.map((l) => l.id),
        ),
        isNull(schema.groupListItems.checkedAt),
      ),
    )
    .orderBy(asc(schema.groupListItems.addedAt));
  const names = await namesFor(
    ports.database,
    items.map((i) => i.addedByUserId),
  );
  const perList = Math.floor(READ_BUDGET_CHARS / lists.length);
  return {
    omittedLists,
    lists: lists.map((list) => {
      const open = items
        .filter((i) => i.listId === list.id)
        .map((i) => ({
          itemId: i.id,
          text: i.text,
          addedBy: i.addedByUserId ? (names.get(i.addedByUserId) ?? null) : null,
        }));
      const shown: typeof open = [];
      let spent = 0;
      for (let k = open.length - 1; k >= 0; k -= 1) {
        if (options.limit !== undefined && shown.length >= options.limit) break;
        const item = open[k]!;
        const cost = JSON.stringify(item).length + 1;
        // Always show at least the newest item: one item is ≤ ~600 chars.
        if (shown.length > 0 && spent + cost > perList) break;
        spent += cost;
        shown.push(item);
      }
      shown.reverse();
      return {
        listId: list.id,
        name: list.name,
        items: shown,
        omittedCount: open.length - shown.length,
      };
    }),
  };
}

async function ensureList(ports: GroupListToolPorts, name: string) {
  const wanted = foldListText(name);
  if (!wanted) throw new Error('A list needs a name.');
  const existing = (await liveLists(ports)).find((l) => l.nameKey === wanted);
  if (existing) return existing;
  // Two people adding at once both reach here; the live-key unique index lets one row in.
  const made = await ports.database
    .insert(schema.groupLists)
    .values({
      familyId: ports.familyId,
      conversationId: ports.conversationId,
      name: name.trim(),
      nameKey: wanted,
      createdByUserId: ports.actorUserId,
    })
    .onConflictDoNothing()
    .returning({ id: schema.groupLists.id });
  for (const row of made) ports.journal?.createdListIds.push(row.id);
  const after = (await liveLists(ports)).find((l) => l.nameKey === wanted);
  if (!after) throw new Error('The list could not be saved.');
  return after;
}

/** Adds items to a list in this thread (made if missing). Open duplicates are skipped. */
export async function addToGroupList(
  ports: GroupListToolPorts,
  listName: string,
  texts: readonly string[],
) {
  await requireThread(ports);
  const list = await ensureList(ports, listName);
  // One open row per folded text, enforced by the index: two people adding "milk" at
  // the same moment write one row, and the loser hears it was already on.
  const wanted: { text: string; key: string }[] = [];
  const keys = new Set<string>();
  const alreadyOn: string[] = [];
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) continue;
    const key = foldListText(text);
    if (keys.has(key)) continue;
    keys.add(key);
    wanted.push({ text, key });
  }
  const inserted =
    wanted.length === 0
      ? []
      : await ports.database
          .insert(schema.groupListItems)
          .values(
            wanted.map((w) => ({
              listId: list.id,
              text: w.text,
              textKey: w.key,
              addedByUserId: ports.actorUserId,
              addedAt: ports.now,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: schema.groupListItems.id, textKey: schema.groupListItems.textKey });
  for (const row of inserted) ports.journal?.insertedItemIds.push(row.id);
  const won = new Set(inserted.map((r) => r.textKey));
  const added: string[] = [];
  for (const w of wanted) (won.has(w.key) ? added : alreadyOn).push(w.text);
  // We were told it is already on: claim the open row so a failing turn that inserted it
  // cannot undo it out from under us.
  const lost = wanted.filter((w) => !won.has(w.key)).map((w) => w.key);
  const ownIds = ports.journal?.insertedItemIds ?? [];
  if (lost.length > 0) {
    await ports.database
      .update(schema.groupListItems)
      .set({ claimedAt: ports.now })
      .where(
        and(
          eq(schema.groupListItems.listId, list.id),
          inArray(schema.groupListItems.textKey, lost),
          isNull(schema.groupListItems.checkedAt),
          // A same-turn repeat is not another turn's claim: leave our own rows undoable.
          ownIds.length > 0 ? notInArray(schema.groupListItems.id, ownIds) : undefined,
        ),
      );
  }
  return { listName: list.name, added, alreadyOn };
}

/** Checks off open items in THIS thread's lists; unknown ids are returned, not written. */
export async function checkOffGroupListItems(
  ports: GroupListToolPorts,
  itemIds: readonly string[],
) {
  await requireThread(ports);
  const lists = await liveLists(ports);
  const ids = [...new Set(itemIds)];
  if (lists.length === 0 || ids.length === 0)
    return { checked: [], alreadyChecked: [], unknown: ids };
  const uuid = z.string().uuid();
  const valid = ids.filter((id) => uuid.safeParse(id).success);
  const rows =
    valid.length === 0
      ? []
      : await ports.database
          .select({
            id: schema.groupListItems.id,
            text: schema.groupListItems.text,
            listId: schema.groupListItems.listId,
          })
          .from(schema.groupListItems)
          .where(
            and(
              inArray(schema.groupListItems.id, valid),
              inArray(
                schema.groupListItems.listId,
                lists.map((l) => l.id),
              ),
              isNull(schema.groupListItems.checkedAt),
            ),
          );
  // The conditional update is the truth: a row someone else checked between the read
  // and this write updates 0 rows and is reported as alreadyChecked, never as checked.
  const updated =
    rows.length === 0
      ? []
      : await ports.database
          .update(schema.groupListItems)
          .set({ checkedAt: ports.now, checkedByUserId: ports.actorUserId })
          .where(
            and(
              inArray(
                schema.groupListItems.id,
                rows.map((r) => r.id),
              ),
              isNull(schema.groupListItems.checkedAt),
            ),
          )
          .returning({ id: schema.groupListItems.id });
  const won = new Set(updated.map((r) => r.id));
  for (const id of won) ports.journal?.checkedItemIds.push(id);
  const found = new Set(rows.map((r) => r.id));
  const listName = new Map(lists.map((l) => [l.id, l.name]));
  const view = (r: (typeof rows)[number]) => ({
    text: r.text,
    listName: listName.get(r.listId) ?? null,
  });
  return {
    checked: rows.filter((r) => won.has(r.id)).map(view),
    alreadyChecked: rows.filter((r) => !won.has(r.id)).map(view),
    unknown: ids.filter((id) => !found.has(id)),
  };
}

export function groupListTools(ports: GroupListToolPorts): RegisteredTool[] {
  const list = defineTool({
    name: LIST_GROUP_LISTS_TOOL,
    description:
      "The shared lists in THIS group chat (groceries, packing, anything the group keeps), each with its open items and who added each one (`addedBy`, a first name or null). Call it when someone asks what's on a list, before checking anything off, and to see a list's exact name before adding to it. Answer only from what it returns; never add an item, name or list it did not return. A long list shows its most recent open items and `omittedCount` for the rest (and `omittedLists` for lists not shown); the newest lists are shown first page, so pass `offset` (newest lists to skip) for older ones; pass `listName` to read one list, and never claim an omitted item is or isn't there.",
    inputSchema: z.object({
      listName: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).max(10000).optional(),
    }),
    monetary: false,
    touchesChildContent: false,
    handler: async (input, ctx) => {
      requireScope(ports, ctx.familyId);
      return readGroupListsPage(ports, input);
    },
  });

  const add = defineTool({
    name: ADD_TO_GROUP_LIST_TOOL,
    description:
      "Add things to one of this group's shared lists, making the list if it doesn't exist yet. Use it whenever someone in the group, in any words or language, says something should go on a list or that they're out of or need something (\"we're out of milk\" is an add). Put each thing in `items` in the words the person used; never add something nobody in this chat said. `listName` is the list's name as list_group_lists returned it, or a short plain name for a new list in the group's language. Only things said in this group chat go on a list: never anything from a 1:1 text, an inbox, a calendar, or about a teenager. Report what came back, including anything already on the list.",
    inputSchema: z.object({
      listName: z.string().min(1).max(200),
      items: z.array(z.string().min(1).max(500)).min(1),
    }),
    monetary: false,
    touchesChildContent: false,
    handler: async (input, ctx) => {
      requireScope(ports, ctx.familyId);
      return addToGroupList(ports, input.listName, input.items);
    },
  });

  const check = defineTool({
    name: CHECK_OFF_GROUP_LIST_TOOL,
    description:
      'Check items off this group\'s shared lists when someone says, in any words or language, that they got, packed or handled them ("got it" right after an item, "picked up the milk"). `itemIds` must come from list_group_lists. If it isn\'t clear which item they mean, ask once instead of guessing. `alreadyChecked` items were checked off by someone else first.',
    inputSchema: z.object({ itemIds: z.array(z.string().min(1).max(64)).min(1) }),
    monetary: false,
    touchesChildContent: false,
    handler: async (input, ctx) => {
      requireScope(ports, ctx.familyId);
      return checkOffGroupListItems(ports, input.itemIds);
    },
  });

  return [list, add, check];
}

/**
 * The coach skill on disk does not name these tools, so with the flag off (or on a 1:1
 * turn) its bytes and every eval cache key are unchanged. On a group turn with the flag
 * on, the names are appended the way augmentCoachSkillForProviderWatch does it.
 */
export function augmentCoachSkillForGroupLists(skill: Skill, enabled: boolean): Skill {
  if (!enabled) return skill;
  const missing = GROUP_LIST_TOOL_NAMES.filter((name) => !skill.meta.tools.includes(name));
  if (missing.length === 0) return skill;
  return { ...skill, meta: { ...skill.meta, tools: [...skill.meta.tools, ...missing] } };
}

/**
 * Reply tone for a shared-list turn. Loaded by name, and only appended when the flag
 * is on, so a dark flag leaves every other coach prompt byte (and its eval cache key)
 * unchanged. Direction only: the skill names no phrase to copy, require, or ban.
 * The judge scores the tone.
 */
export async function appendGroupListsReply(skill: Skill): Promise<Skill> {
  const tone = await loadCronSkill('coach-group-lists');
  return { ...skill, instructions: `${skill.instructions}\n\n${tone.instructions}` };
}
