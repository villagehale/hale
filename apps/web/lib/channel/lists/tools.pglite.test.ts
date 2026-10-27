import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, type Skill, runAgent } from '@hale/agent';
import { schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { GROUP_WITHHELD_TOOLS } from '../coach/group-privacy-scope';
import { groupSharedListsEnabled } from './flag';
import {
  ADD_TO_GROUP_LIST_TOOL,
  CHECK_OFF_GROUP_LIST_TOOL,
  GROUP_LIST_TOOL_NAMES,
  LIST_GROUP_LISTS_TOOL,
  type GroupListToolPorts,
  addToGroupList,
  augmentCoachSkillForGroupLists,
  checkOffGroupListItems,
  groupListTools,
  readGroupLists,
} from './tools';

/**
 * VIL-447 shared lists over the REAL DDL (0181 applied in journal order), driven through
 * the real agent loop by a SCRIPTED client that stands in for the model's reading of
 * intent. What is tested is what that reading can reach. No key is set; nothing leaves
 * the process. Judged reply quality lives in evals/run-group-lists-eval.mjs.
 */
const NOW = new Date('2026-10-26T14:00:00.000Z');
const SKILL: Skill = {
  meta: {
    name: 'lists-test',
    whenToUse: 'test',
    task: 'converse',
    tools: [...GROUP_LIST_TOOL_NAMES],
  },
  instructions: 'test',
};
const usage = { input_tokens: 10, output_tokens: 5 } as Anthropic.Usage;
const toolUse = (name: string, input: unknown): Anthropic.Message =>
  ({
    id: `m-${name}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    stop_reason: 'tool_use',
    stop_sequence: null,
    content: [{ type: 'tool_use', id: `tu-${randomUUID()}`, name, input }],
    usage,
  }) as Anthropic.Message;
const done = (text: string): Anthropic.Message =>
  ({
    id: 'm-done',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text, citations: null }],
    usage,
  }) as Anthropic.Message;

function scripted(script: Anthropic.Message[]) {
  const results: Array<{ content: unknown; is_error?: boolean }> = [];
  let calls = 0;
  const client = {
    messages: {
      create: vi.fn(async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        const last = params.messages.at(-1);
        if (last && Array.isArray(last.content)) {
          for (const block of last.content)
            if (block.type === 'tool_result') results.push(block as never);
        }
        const msg = script[calls];
        calls += 1;
        if (!msg) throw new Error('script exhausted');
        return msg;
      }),
    },
  } as unknown as AgentClient;
  return { client, results };
}

describe('group shared lists (VIL-447)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(() => {
    for (const key of [
      'ANTHROPIC_API_KEY',
      'AI_GATEWAY_API_KEY',
      'LINQ_API_KEY',
      'BROWSER_USE_API_KEY',
      'DATABASE_URL',
    ])
      vi.stubEnv(key, '');
  });

  async function group(name = 'Dana Smith') {
    const fam = await seedFamily(db.database);
    await db.database
      .update(schema.users)
      .set({ name })
      .where(eq(schema.users.id, fam.parentUserId));
    const [conv] = await db.database
      .insert(schema.conversations)
      .values({ familyId: fam.familyId })
      .returning({ id: schema.conversations.id });
    if (!conv) throw new Error('no conversation');
    const ports: GroupListToolPorts = {
      database: db.database,
      familyId: fam.familyId,
      conversationId: conv.id,
      actorUserId: fam.parentUserId,
      now: NOW,
    };
    return { ...fam, ports };
  }

  async function secondParent(familyId: string, name: string) {
    const [user] = await db.database
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, name })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('no user');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: user.id, role: 'co_parent' });
    return user.id;
  }

  it('the flag is off unless exactly "true"', () => {
    expect(groupSharedListsEnabled({})).toBe(false);
    for (const v of ['TRUE', '1', 'on', 'true\n']) {
      expect(groupSharedListsEnabled({ GROUP_SHARED_LISTS_ENABLED: v })).toBe(false);
    }
    expect(groupSharedListsEnabled({ GROUP_SHARED_LISTS_ENABLED: 'true' })).toBe(true);
  });

  it('leaves the skill byte-identical when off and appends the three names when on', () => {
    const base: Skill = { meta: { ...SKILL.meta, tools: ['lookup_week'] }, instructions: 'x' };
    expect(augmentCoachSkillForGroupLists(base, false)).toBe(base);
    expect(augmentCoachSkillForGroupLists(base, true).meta.tools).toEqual([
      'lookup_week',
      ...GROUP_LIST_TOOL_NAMES,
    ]);
    expect(augmentCoachSkillForGroupLists(base, true).instructions).toBe('x');
  });

  it("is never withheld from a group turn (the list is the group's own)", () => {
    for (const name of GROUP_LIST_TOOL_NAMES) expect(GROUP_WITHHELD_TOOLS.has(name)).toBe(false);
  });

  it('"we\'re out of milk" read as an add makes the list and records who added it', async () => {
    const g = await group('Dana Smith');
    const { client, results } = scripted([
      toolUse(ADD_TO_GROUP_LIST_TOOL, { listName: 'Groceries', items: ['milk'] }),
      done('(model reply)'),
    ]);
    await runAgent({
      skill: SKILL,
      context: {},
      tools: groupListTools(g.ports),
      client,
      maxSteps: 4,
      toolContext: { familyId: g.familyId, actor: g.parentUserId },
      guardDeps: { writeAudit: async () => {} },
    });
    expect(results[0]?.is_error).toBeFalsy();
    const lists = await readGroupLists(g.ports);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({
      name: 'Groceries',
      items: [{ text: 'milk', addedBy: 'Dana' }],
    });
  });

  it('several people adding at once land on ONE list with no duplicate items', async () => {
    const g = await group('Dana Smith');
    const other = await secondParent(g.familyId, 'Jordan Lee');
    await Promise.all([
      addToGroupList(g.ports, 'Groceries', ['milk', 'eggs']),
      addToGroupList({ ...g.ports, actorUserId: other }, 'groceries ', ['Bread', 'Milk']),
    ]);
    const lists = await readGroupLists(g.ports);
    expect(lists).toHaveLength(1);
    const texts = lists[0]?.items.map((i) => i.text.toLowerCase()).sort();
    expect(texts).toEqual(['bread', 'eggs', 'milk']);
    const bread = lists[0]?.items.find((i) => i.text === 'Bread');
    expect(bread?.addedBy).toBe('Jordan');
  });

  it('an item already on the list comes back as alreadyOn, not a second row', async () => {
    const g = await group();
    await addToGroupList(g.ports, 'Packing', ['sunscreen']);
    const again = await addToGroupList(g.ports, 'packing', ['Sunscreen', 'hats']);
    expect(again).toEqual({ listName: 'Packing', added: ['hats'], alreadyOn: ['Sunscreen'] });
  });

  it('"got it" checks off by id; the item leaves the open list and records who checked', async () => {
    const g = await group();
    await addToGroupList(g.ports, 'Groceries', ['milk', 'eggs']);
    const milk = (await readGroupLists(g.ports))[0]?.items.find((i) => i.text === 'milk');
    if (!milk) throw new Error('no milk');
    const { client, results } = scripted([
      toolUse(LIST_GROUP_LISTS_TOOL, {}),
      toolUse(CHECK_OFF_GROUP_LIST_TOOL, { itemIds: [milk.itemId] }),
      done('(model reply)'),
    ]);
    await runAgent({
      skill: SKILL,
      context: {},
      tools: groupListTools(g.ports),
      client,
      maxSteps: 5,
      toolContext: { familyId: g.familyId, actor: g.parentUserId },
      guardDeps: { writeAudit: async () => {} },
    });
    expect(results.every((r) => !r.is_error)).toBe(true);
    expect((await readGroupLists(g.ports))[0]?.items.map((i) => i.text)).toEqual(['eggs']);
    const [row] = await db.database
      .select()
      .from(schema.groupListItems)
      .where(eq(schema.groupListItems.id, milk.itemId));
    expect(row?.checkedByUserId).toBe(g.parentUserId);
    expect(row?.checkedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('a list in one group is invisible to another group, even in the same family', async () => {
    const g = await group();
    await addToGroupList(g.ports, 'Groceries', ['milk']);
    const [conv2] = await db.database
      .insert(schema.conversations)
      .values({ familyId: g.familyId })
      .returning({ id: schema.conversations.id });
    const other = { ...g.ports, conversationId: conv2?.id ?? '' };
    expect(await readGroupLists(other)).toEqual([]);
    const id = (await readGroupLists(g.ports))[0]?.items[0]?.itemId ?? '';
    const res = await checkOffGroupListItems(other, [id]);
    expect(res).toEqual({ checked: [], unknown: [id] });
    expect((await readGroupLists(g.ports))[0]?.items).toHaveLength(1);
  });

  it("refuses another family's tool context and a made-up item id", async () => {
    const g = await group();
    await addToGroupList(g.ports, 'Groceries', ['milk']);
    const { client, results } = scripted([
      toolUse(LIST_GROUP_LISTS_TOOL, {}),
      done('(model reply)'),
    ]);
    await runAgent({
      skill: SKILL,
      context: {},
      tools: groupListTools(g.ports),
      client,
      maxSteps: 3,
      toolContext: { familyId: randomUUID(), actor: g.parentUserId },
      guardDeps: { writeAudit: async () => {} },
    });
    expect(results[0]?.is_error).toBe(true);
    expect(await checkOffGroupListItems(g.ports, ['not-a-uuid'])).toEqual({
      checked: [],
      unknown: ['not-a-uuid'],
    });
  });

  it('has no size cap: 300 items go on one list', async () => {
    const g = await group();
    const many = Array.from({ length: 300 }, (_, i) => `item ${i}`);
    const res = await addToGroupList(g.ports, 'Big', many);
    expect(res.added).toHaveLength(300);
  });

  it('keeps any language and script verbatim', async () => {
    const g = await group('婷');
    await addToGroupList(g.ports, '买菜', ['牛奶', 'tofu']);
    await addToGroupList(g.ports, 'قائمة', ['حليب']);
    const lists = await readGroupLists(g.ports);
    expect(lists.map((l) => l.name)).toEqual(['买菜', 'قائمة']);
    expect(lists[0]?.items[0]).toMatchObject({ text: '牛奶', addedBy: '婷' });
  });

  it('0181 enables RLS on both tables', async () => {
    const res = (await db.database.execute(
      sql`select relname, relrowsecurity from pg_class where relname in ('group_lists','group_list_items') order by relname`,
    )) as unknown as { rows: Array<{ relname: string; relrowsecurity: boolean }> };
    expect(res.rows).toEqual([
      { relname: 'group_list_items', relrowsecurity: true },
      { relname: 'group_lists', relrowsecurity: true },
    ]);
  });
});
