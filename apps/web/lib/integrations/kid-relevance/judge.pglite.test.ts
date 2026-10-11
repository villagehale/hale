import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import { judgeKidRelevance, seriesKeyForEvent } from './judge';
import {
  KID_JUDGE_ITEMS_PER_CALL,
  KID_VERDICT_TOOL,
  type KidRelevanceChild,
  type KidRelevanceItem,
  type KidSkillInput,
} from './skill-contract';

/**
 * The judge's code paths against a real Postgres: the verdict cache, the parent row's
 * precedence, teen handling, refusal, retry, hold and deferral. The model is NOT under
 * test here - the client is a scripted fake at the AgentClient port, and what the skill
 * actually decides is the cached eval (rule #8). Every title is invented.
 */

let db: TestDb;
const NOW = new Date('2026-10-11T15:00:00.000Z');
const LATER = new Date('2099-01-01T00:00:00.000Z');

let familyId: string;
let integrationId: string;
let children: KidRelevanceChild[];

type Verdict = 'kid' | 'adult' | 'unsure';
type Scripted = (input: KidSkillInput, request: Record<string, unknown>) => unknown;

interface Call {
  input: KidSkillInput;
  request: Record<string, unknown>;
}

/** A scripted AgentClient. Each step answers one request: a verdict map by item text, a
 * stop reason, or a missing tool call. */
function scriptedClient(...steps: Scripted[]) {
  const calls: Call[] = [];
  const respond = async (request: Record<string, unknown>) => {
    const messages = request.messages as { content: string }[];
    const input = JSON.parse(messages[0]?.content ?? '{}') as KidSkillInput;
    calls.push({ input, request });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (!step) throw new Error('no scripted step');
    const answer = await step(input, request);
    if (answer && typeof answer === 'object' && 'stop_reason' in answer) {
      return { content: [], usage: { input_tokens: 1, output_tokens: 1 }, ...answer };
    }
    return {
      content: [{ type: 'tool_use', id: 't', name: KID_VERDICT_TOOL, input: answer }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  };
  const client = {
    messages: {
      create: respond,
      stream: (request: Record<string, unknown>) => ({ finalMessage: () => respond(request) }),
    },
  } as unknown as AgentClient;
  return { client, calls };
}

/** Answers every item by a substring of its text; anything unmatched is unsure. */
function byText(rules: Record<string, { verdict: Verdict; childName?: string }>): Scripted {
  return (input) => ({
    verdicts: input.items.map((item) => {
      const hit = Object.entries(rules).find(([needle]) => item.text.includes(needle));
      return {
        ref: item.ref,
        reason: hit ? `about ${hit[0]}` : 'unclear',
        verdict: hit ? hit[1].verdict : 'unsure',
        childName: hit?.[1].childName ?? null,
      };
    }),
  });
}

function item(ref: string, title: string, overrides: Partial<KidRelevanceItem> = {}) {
  return {
    ref,
    source: 'google_calendar' as const,
    integrationId,
    itemKey: `key-${ref}`,
    title,
    startsAt: '2026-10-14T15:00:00.000Z',
    place: null,
    sender: null,
    ...overrides,
  } satisfies KidRelevanceItem;
}

function judge(
  client: AgentClient,
  items: readonly KidRelevanceItem[],
  options: { deadline?: Date; notMineHints?: string[] } = {},
) {
  return judgeKidRelevance(
    db.database,
    { familyId, items, now: NOW, deadline: options.deadline ?? LATER },
    { client, children, notMineHints: options.notMineHints ?? [] },
  );
}

function storedVerdicts() {
  return db.database
    .select()
    .from(schema.kidRelevanceVerdicts)
    .where(eq(schema.kidRelevanceVerdicts.familyId, familyId));
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  process.env.HALE_LLM_NO_STREAM = '1';
  const family = await seedFamily(db.database);
  familyId = family.familyId;
  integrationId = await seedIntegration(db.database, familyId, family.parentUserId, 'gcal');
  const [toddler, teen] = await db.database
    .insert(schema.children)
    .values([
      { familyId, name: 'Wren', dateOfBirth: '2024-09-01' },
      { familyId, name: 'Juno', dateOfBirth: '2012-03-01' },
    ])
    .returning({ id: schema.children.id, name: schema.children.name });
  children = [
    { id: toddler?.id ?? '', name: 'Wren', dateOfBirth: '2024-09-01' },
    { id: teen?.id ?? '', name: 'Juno', dateOfBirth: '2012-03-01' },
  ];
});

describe('judgeKidRelevance', () => {
  it('stores a kid verdict with its child and reason, and an adult one with no reason', async () => {
    const { client } = scriptedClient(
      byText({ 'Wren swim': { verdict: 'kid', childName: 'Wren' }, Standup: { verdict: 'adult' } }),
    );
    const judged = await judge(client, [item('a', 'Wren swim'), item('b', 'Standup')]);

    const [kid, adult] = judged;
    expect(kid).toMatchObject({ ref: 'a', verdict: 'kid', childId: children[0]?.id, teen: false });
    expect(adult).toMatchObject({ ref: 'b', verdict: 'adult', childId: null, teen: false });

    const stored = await storedVerdicts();
    const kidRow = stored.find((row) => row.itemKey === 'key-a');
    const adultRow = stored.find((row) => row.itemKey === 'key-b');
    expect(kidRow).toMatchObject({
      verdict: 'kid',
      reason: 'about Wren swim',
      decidedBy: 'model',
      source: 'google_calendar',
      integrationId,
    });
    expect(kid && 'verdictId' in kid ? kid.verdictId : null).toBe(kidRow?.id);
    expect(adultRow).toMatchObject({ verdict: 'adult', reason: null, childId: null });
    expect(JSON.stringify(stored)).not.toContain('Standup');
  });

  it('reuses a verdict while the input is unchanged and re-judges when it changes', async () => {
    const first = scriptedClient(byText({ Physio: { verdict: 'adult' } }));
    await judge(first.client, [item('a', 'Physio')]);
    expect(first.calls).toHaveLength(1);

    const again = scriptedClient(byText({ Physio: { verdict: 'kid' } }));
    const cached = await judge(again.client, [item('a', 'Physio')]);
    expect(again.calls).toHaveLength(0);
    expect(cached[0]).toMatchObject({ verdict: 'adult' });

    const changed = scriptedClient(byText({ 'Physio moved': { verdict: 'adult' } }));
    await judge(changed.client, [item('a', 'Physio moved')]);
    expect(changed.calls).toHaveLength(1);
  });

  it('re-judges a group item with no integration in place, one row per item', async () => {
    const group = (title: string) =>
      item('g', title, { source: 'group', integrationId: null, itemKey: 'title-hash' });
    await judge(scriptedClient(byText({ Brunch: { verdict: 'adult' } })).client, [group('Brunch')]);
    const second = await judge(
      scriptedClient(byText({ 'Brunch moved': { verdict: 'unsure' } })).client,
      [group('Brunch moved')],
    );
    expect(second[0]).toMatchObject({ verdict: 'unsure' });
    const stored = await storedVerdicts();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ source: 'group', integrationId: null, verdict: 'unsure' });
  });

  it("never re-judges or overwrites a parent's own verdict", async () => {
    await db.database.insert(schema.kidRelevanceVerdicts).values({
      familyId,
      source: 'google_calendar',
      integrationId,
      itemKey: 'key-a',
      inputHash: 'parent',
      verdict: 'adult',
      decidedBy: 'parent',
    });
    const { client, calls } = scriptedClient(byText({ Swim: { verdict: 'kid' } }));
    const judged = await judge(client, [item('a', 'Swim')]);
    expect(calls).toHaveLength(0);
    expect(judged[0]).toMatchObject({ verdict: 'adult' });
    const [row] = await storedVerdicts();
    expect(row).toMatchObject({ decidedBy: 'parent', verdict: 'adult' });
  });

  it("a parent's verdict written while the model was answering is not overwritten", async () => {
    const { client, calls } = scriptedClient(async (input) => {
      await db.database.insert(schema.kidRelevanceVerdicts).values({
        familyId,
        source: 'google_calendar',
        integrationId,
        itemKey: 'key-a',
        inputHash: 'parent',
        verdict: 'adult',
        decidedBy: 'parent',
      });
      return byText({ Swim: { verdict: 'kid', childName: 'Wren' } })(input, {});
    });
    const judged = await judge(client, [item('a', 'Swim')]);
    expect(calls).toHaveLength(1);
    expect(judged[0]).toMatchObject({ verdict: 'adult', childId: null });
    const stored = await storedVerdicts();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ decidedBy: 'parent', verdict: 'adult', reason: null });
  });

  it('an unattributed kid item stores no reason when the family has a teenager', async () => {
    const { client } = scriptedClient(byText({ 'Bake sale': { verdict: 'kid' } }));
    const [judged] = await judge(client, [item('a', 'Bake sale')]);
    expect(judged).toMatchObject({ verdict: 'kid', childId: null });
    const [row] = await storedVerdicts();
    expect(row).toMatchObject({ verdict: 'kid', childId: null, reason: null });
  });

  it('an unattributed kid item keeps its reason when no child is a teenager', async () => {
    await db.database.delete(schema.children).where(eq(schema.children.id, children[1]?.id ?? ''));
    children = children.slice(0, 1);
    const { client } = scriptedClient(byText({ 'Bake sale': { verdict: 'kid' } }));
    await judge(client, [item('a', 'Bake sale')]);
    const [row] = await storedVerdicts();
    expect(row).toMatchObject({ verdict: 'kid', childId: null, reason: 'about Bake sale' });
  });

  it("marks a teenager's item as teen with the child set and stores no reason", async () => {
    const { client } = scriptedClient(
      byText({ 'Juno practice': { verdict: 'kid', childName: 'Juno' } }),
    );
    const [judged] = await judge(client, [item('a', 'Juno practice')]);
    expect(judged).toMatchObject({ verdict: 'kid', childId: children[1]?.id, teen: true });
    const [row] = await storedVerdicts();
    expect(row).toMatchObject({ verdict: 'kid', teen: true, reason: null });
    expect(row?.childId).toBe(children[1]?.id);
  });

  it('offers the model only this family\'s children as names', async () => {
    const { client, calls } = scriptedClient(byText({ Swim: { verdict: 'kid' } }));
    await judge(client, [item('a', 'Swim')]);
    const tools = calls[0]?.request.tools as { input_schema: unknown }[];
    expect(JSON.stringify(tools[0]?.input_schema)).toContain('"enum":["Wren","Juno",null]');
  });

  it('a child name the family does not have fails validation and is held, never stored', async () => {
    const { client, calls } = scriptedClient(
      byText({ 'Juno practice': { verdict: 'kid', childName: 'Jun' } }),
    );
    const judged = await judge(client, [item('a', 'Juno practice')]);
    expect(calls).toHaveLength(2);
    expect(judged).toEqual([{ ref: 'a', verdict: 'held', why: 'judge_failed' }]);
    expect(await storedVerdicts()).toEqual([]);
  });

  it('re-asks a refused batch one item per call, so each item gets its own verdict', async () => {
    const { client, calls } = scriptedClient(
      () => ({ stop_reason: 'refusal' }),
      byText({ 'Wren swim': { verdict: 'kid', childName: 'Wren' }, Lesson: { verdict: 'kid' } }),
    );
    const judged = await judge(client, [item('a', 'Wren swim'), item('b', 'Lesson')]);
    expect(calls.map((call) => call.input.items.length)).toEqual([2, 1, 1]);
    expect(judged.map((row) => row.verdict)).toEqual(['kid', 'kid']);
    const stored = await storedVerdicts();
    expect(stored.map((row) => row.verdict).sort()).toEqual(['kid', 'kid']);
  });

  it('stores an item refused on its own as unsure with no reason, and does not ask again', async () => {
    const { client } = scriptedClient(
      () => ({ stop_reason: 'refusal' }),
      byText({ 'Wren swim': { verdict: 'kid', childName: 'Wren' } }),
      () => ({ stop_reason: 'refusal' }),
    );
    const judged = await judge(client, [item('a', 'Wren swim'), item('b', 'Appointment')]);
    expect(judged.map((row) => row.verdict)).toEqual(['kid', 'unsure']);
    const unsure = (await storedVerdicts()).filter((row) => row.verdict === 'unsure');
    expect(unsure.map((row) => [row.itemKey, row.reason])).toEqual([['key-b', null]]);

    const again = scriptedClient(byText({ Appointment: { verdict: 'kid' } }));
    await judge(again.client, [item('b', 'Appointment')]);
    expect(again.calls).toHaveLength(0);
  });

  it('defers the items of a refused batch the deadline stops, writing nothing for them', async () => {
    const deadline = new Date(Date.now() + 60_000);
    const { client, calls } = scriptedClient(() => {
      deadline.setTime(Date.now() - 1);
      return { stop_reason: 'refusal' };
    });
    const judged = await judgeKidRelevance(
      db.database,
      { familyId, items: [item('a', 'Swim'), item('b', 'Lesson')], now: NOW, deadline },
      { client, children, notMineHints: [] },
    );
    expect(calls).toHaveLength(1);
    expect(judged).toEqual([
      { ref: 'a', verdict: 'held', why: 'judge_deferred' },
      { ref: 'b', verdict: 'held', why: 'judge_deferred' },
    ]);
    expect(await storedVerdicts()).toEqual([]);
  });

  it('retries a failed call once with thinking off, then holds it and writes nothing', async () => {
    const { client, calls } = scriptedClient(
      () => ({ stop_reason: 'end_turn' }),
      () => ({ stop_reason: 'max_tokens' }),
    );
    const judged = await judge(client, [item('a', 'Swim')]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.request.thinking).toEqual({ type: 'adaptive' });
    expect(calls[1]?.request.thinking).toEqual({ type: 'disabled' });
    expect(judged).toEqual([{ ref: 'a', verdict: 'held', why: 'judge_failed' }]);
    expect(await storedVerdicts()).toEqual([]);
  });

  it('an answer that leaves an item out counts as a failure and is retried', async () => {
    const { client, calls } = scriptedClient(
      (input) => ({
        verdicts: [{ ref: input.items[0]?.ref, reason: 'swim', verdict: 'kid', childName: null }],
      }),
      byText({ Swim: { verdict: 'kid' }, Dentist: { verdict: 'adult' } }),
    );
    const judged = await judge(client, [item('a', 'Swim'), item('b', 'Dentist')]);
    expect(calls).toHaveLength(2);
    expect(judged.map((row) => row.verdict)).toEqual(['kid', 'adult']);
  });

  it('defers every item past the deadline without calling the model', async () => {
    const { client, calls } = scriptedClient(byText({ Swim: { verdict: 'kid' } }));
    const judged = await judge(client, [item('a', 'Swim')], {
      deadline: new Date(Date.now() - 1),
    });
    expect(calls).toHaveLength(0);
    expect(judged).toEqual([{ ref: 'a', verdict: 'held', why: 'judge_deferred' }]);
  });

  it('splits a long list into calls no larger than the per-call bound', async () => {
    const { client, calls } = scriptedClient(byText({ Class: { verdict: 'kid' } }));
    const count = KID_JUDGE_ITEMS_PER_CALL * 2 + 1;
    const items = Array.from({ length: count }, (_, index) => item(`r${index}`, `Class ${index}`));
    const judged = await judge(client, items);
    expect(calls.map((call) => call.input.items.length)).toEqual([
      KID_JUDGE_ITEMS_PER_CALL,
      KID_JUDGE_ITEMS_PER_CALL,
      1,
    ]);
    expect(judged).toHaveLength(count);
    expect(judged.every((row) => row.verdict === 'kid')).toBe(true);
  });

  it('judges one series once and answers every ref that carried it', async () => {
    const { client, calls } = scriptedClient(byText({ Swim: { verdict: 'kid' } }));
    const judged = await judge(client, [
      item('first', 'Swim', { itemKey: 'series-1' }),
      item('second', 'Swim', { itemKey: 'series-1' }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input.items).toHaveLength(1);
    expect(judged.map((row) => row.ref)).toEqual(['first', 'second']);
    expect(judged.map((row) => row.verdict)).toEqual(['kid', 'kid']);
  });

  it('hands the model the not-mine hints and no ids', async () => {
    const { client, calls } = scriptedClient(byText({ 'Harbour Inn': { verdict: 'adult' } }));
    await judge(client, [item('a', 'Harbour Inn check-in', { place: 'Lakeview' })], {
      notMineHints: ['a hotel stay'],
    });
    const sent = calls[0]?.input;
    expect(sent?.notMineHints).toEqual(['a hotel stay']);
    expect(sent?.items).toEqual([
      {
        ref: 'i0',
        text: 'Harbour Inn check-in at Lakeview',
        source: 'google_calendar',
        startsAt: '2026-10-14T15:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(calls[0]?.request)).not.toContain(integrationId);
    expect(JSON.stringify(calls[0]?.request)).not.toContain(children[0]?.id ?? 'x');
  });
});

describe('seriesKeyForEvent', () => {
  it("is the snapshot's series when Hale saw one, and the event id when it did not", async () => {
    await db.database.insert(schema.calendarEventSnapshots).values({
      integrationId,
      eventId: 'instance-1',
      recurringEventId: 'series-9',
      updatedStamp: 'u1',
      status: 'confirmed',
    });
    expect(await seriesKeyForEvent(db.database, integrationId, 'instance-1')).toBe('series-9');
    expect(await seriesKeyForEvent(db.database, integrationId, 'one-off')).toBe('one-off');
  });
});
