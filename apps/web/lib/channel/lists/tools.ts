import { type RegisteredTool, type Skill, defineTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

/**
 * VIL-447 (T23) — the coach's shared-list verbs for a family group.
 *
 * Nothing here judges words. The model reads, in any language and any wording, that
 * someone is adding ("we're out of milk"), checking something off ("got it"), or asking
 * what's on a list, and calls a verb. Hale's reply is the model's own text from what the
 * verb returns (list name, items, who added what); this module writes no parent-facing
 * copy at all.
 *
 * What the structure decides:
 * - SCOPE IS THE GROUP THREAD, from the turn, never from the model. Every read and write
 *   is bound to `conversationId`; a tool context whose family differs is refused. So a
 *   list made in one group is never read in another group or in a 1:1.
 * - IDS ARE HALE'S. Checking off takes `itemId`s that list_group_lists returned for this
 *   thread; anything else is refused.
 * - NO SIZE CAP (ticket scope). Items are bounded only by the column check (500 chars).
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
}

/** Case, width and spacing folded, so "Milk" and "milk " are one item and one list. */
export function foldListText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function requireScope(ports: GroupListToolPorts, familyId: string): void {
  if (familyId !== ports.familyId) {
    throw new Error('This tool only acts for the group in this conversation.');
  }
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

async function liveLists(ports: GroupListToolPorts) {
  return ports.database
    .select({ id: schema.groupLists.id, name: schema.groupLists.name })
    .from(schema.groupLists)
    .where(
      and(
        eq(schema.groupLists.conversationId, ports.conversationId),
        eq(schema.groupLists.familyId, ports.familyId),
        isNull(schema.groupLists.archivedAt),
      ),
    )
    .orderBy(asc(schema.groupLists.createdAt));
}

/** Every list in this group thread with its open items, oldest first. */
export async function readGroupLists(ports: GroupListToolPorts) {
  const lists = await liveLists(ports);
  if (lists.length === 0) return [];
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
  return lists.map((list) => ({
    listId: list.id,
    name: list.name,
    items: items
      .filter((i) => i.listId === list.id)
      .map((i) => ({
        itemId: i.id,
        text: i.text,
        addedBy: i.addedByUserId ? (names.get(i.addedByUserId) ?? null) : null,
      })),
  }));
}

async function ensureList(ports: GroupListToolPorts, name: string) {
  const wanted = foldListText(name);
  const existing = (await liveLists(ports)).find((l) => foldListText(l.name) === wanted);
  if (existing) return existing;
  // Two people adding at once both reach here; the live-name unique index lets one row in.
  await ports.database
    .insert(schema.groupLists)
    .values({
      familyId: ports.familyId,
      conversationId: ports.conversationId,
      name: name.trim(),
      createdByUserId: ports.actorUserId,
    })
    .onConflictDoNothing();
  const after = (await liveLists(ports)).find((l) => foldListText(l.name) === wanted);
  if (!after) throw new Error('The list could not be saved.');
  return after;
}

/** Adds items to a list in this thread (made if missing). Open duplicates are skipped. */
export async function addToGroupList(
  ports: GroupListToolPorts,
  listName: string,
  texts: readonly string[],
) {
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
          .returning({ textKey: schema.groupListItems.textKey });
  const won = new Set(inserted.map((r) => r.textKey));
  const added: string[] = [];
  for (const w of wanted) (won.has(w.key) ? added : alreadyOn).push(w.text);
  return { listName: list.name, added, alreadyOn };
}

/** Checks off open items in THIS thread's lists; unknown ids are returned, not written. */
export async function checkOffGroupListItems(
  ports: GroupListToolPorts,
  itemIds: readonly string[],
) {
  const lists = await liveLists(ports);
  const ids = [...new Set(itemIds)];
  if (lists.length === 0 || ids.length === 0) return { checked: [], unknown: ids };
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
  if (rows.length > 0) {
    await ports.database
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
      );
  }
  const found = new Set(rows.map((r) => r.id));
  const listName = new Map(lists.map((l) => [l.id, l.name]));
  return {
    checked: rows.map((r) => ({ text: r.text, listName: listName.get(r.listId) ?? null })),
    unknown: ids.filter((id) => !found.has(id)),
  };
}

export function groupListTools(ports: GroupListToolPorts): RegisteredTool[] {
  const list = defineTool({
    name: LIST_GROUP_LISTS_TOOL,
    description:
      "The shared lists in THIS group chat (groceries, packing, anything the group keeps), each with its open items and who added each one (`addedBy`, a first name or null). Call it when someone asks what's on a list, before checking anything off, and to see a list's exact name before adding to it. Answer only from what it returns; never add an item, name or list it did not return.",
    inputSchema: z.object({}),
    monetary: false,
    touchesChildContent: false,
    handler: async (_input, ctx) => {
      requireScope(ports, ctx.familyId);
      return { lists: await readGroupLists(ports) };
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
      'Check items off this group\'s shared lists when someone says, in any words or language, that they got, packed or handled them ("got it" right after an item, "picked up the milk"). `itemIds` must come from list_group_lists. If it isn\'t clear which item they mean, ask once instead of guessing.',
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
