import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { bringSourceRef, recordBringItems } from './bring/store';
import { REMINDER_BRING_SKILL, type ReminderFacts, reminderInstructions } from './compose';
import {
  type ChannelSendJob,
  type ReminderRunDeps,
  defaultReminderRunDeps,
  runReminderCron,
} from './run';

/**
 * VIL-720 · what an email or flyer said to bring, in the reminders, through the SHIPPED
 * deps and the REAL writer (composeReminderTexts, its skills, its gates). Only the client
 * stands in, at the AgentClient port: it records each request and answers in the shape it
 * was asked for, so these tests read what the writer was handed, never what it wrote.
 *
 * One household, two parents. The list was read from the primary parent's mail, so it is
 * theirs alone: the co-parent hears the same event's reminder with no list. The two
 * parents' requests are told apart by language (English and French), set in the deps.
 * Toronto is EST (UTC-5) after Nov 1. Every title and item is invented.
 */

let db: TestDb;
let familyId: string;
let parentUserId: string;
let coParentUserId: string;
let eventId: string;
let enqueued: ChannelSendJob[];
let pages: string[];

/** Saturday 10:00 EST. */
const STARTS_AT = new Date('2026-11-21T15:00:00Z');
/** The evening-before slot is Friday 18:00 EST; the run ticks at :12. */
const EVENING_TICK = new Date('2026-11-20T23:12:00Z');
/** The hour-before slot is Saturday 09:00 EST. */
const HOUR_TICK = new Date('2026-11-21T14:12:00Z');
const ITEMS = ['a swimsuit', 'towel', 'goggles'];

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubEnv('LOOP_SEND_ENABLED', 'true');
  vi.stubEnv('PROACTIVE_CADENCE', 'off');
  vi.stubEnv('BRING_ITEMS_REMINDER_ENABLED', 'true');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  enqueued = [];
  pages = [];
  ({ familyId, parentUserId } = await seedFamily(db.database));
  const [coParent] = await db.database
    .insert(schema.users)
    .values({ email: `co-${familyId}@example.test`, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  if (!coParent) throw new Error('no co-parent');
  coParentUserId = coParent.id;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: coParentUserId, role: 'co_parent' });
  for (const id of [parentUserId, coParentUserId]) {
    await db.database
      .update(schema.users)
      .set({ timezone: 'America/Toronto' })
      .where(eq(schema.users.id, id));
  }
  eventId = await seedEvent();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function seedEvent(childId: string | null = null): Promise<string> {
  const [event] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      childId,
      title: 'Swim lessons',
      startsAt: STARTS_AT,
      endsAt: new Date(STARTS_AT.getTime() + 45 * 60_000),
      location: 'Riverside Pool',
      source: 'placement',
    })
    .returning({ id: schema.familyEvents.id });
  if (!event) throw new Error('no event');
  return event.id;
}

async function giveParentTheList(forEvent: string = eventId) {
  await recordBringItems(db.database, {
    familyId,
    ownerUserId: parentUserId,
    eventId: forEvent,
    sourceKind: 'email',
    sourceRef: bringSourceRef('33333333-3333-4000-8000-000000000720', `msg-${forEvent}`),
    items: ITEMS,
    now: new Date('2026-11-18T15:00:00Z'),
  });
}

interface Seen {
  system: string;
  facts: ReminderFacts;
}

function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  return (system as { text?: string }[]).map((block) => block.text ?? '').join('');
}

function userText(messages: unknown): string {
  const [first] = messages as { content: unknown }[];
  const content = first?.content;
  if (typeof content === 'string') return content;
  return (content as { type: string; text?: string }[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

/** Records every request; answers `texts` in whichever shape the request asked for. */
function recordingClient(texts: string[]) {
  const seen: Seen[] = [];
  const create = async (request: { tools?: unknown[]; system: unknown; messages: unknown }) => {
    seen.push({
      system: systemText(request.system),
      facts: JSON.parse(userText(request.messages)),
    });
    const input = { texts };
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'test',
      stop_reason: request.tools ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 900, output_tokens: 40 },
      content: request.tools
        ? [{ type: 'tool_use', id: 'tu_0', name: 'reminder_texts', input }]
        : [{ type: 'text', text: JSON.stringify(input) }],
    } as unknown as Anthropic.Message;
  };
  return { client: { messages: { create } } as unknown as AgentClient, seen };
}

function deps(client: AgentClient): ReminderRunDeps {
  return {
    ...defaultReminderRunDeps(),
    scopeFamilies: (rows) => rows.filter((row) => row.familyId === familyId),
    client,
    capture: (async () => 'sent') as unknown as ReminderRunDeps['capture'],
    enqueue: async (job) => {
      enqueued.push(job);
    },
    loadLanguage: async (_db, _familyId, userId) => (userId === parentUserId ? 'en' : 'fr'),
    pageOps: async (text) => {
      pages.push(text);
      return 'sent';
    },
  };
}

async function tick(at: Date, client: AgentClient) {
  vi.setSystemTime(at);
  return runReminderCron(db.database, deps(client), at);
}

function requestFor(seen: Seen[], language: 'en' | 'fr'): Seen {
  const found = seen.find((s) => s.facts.language === language);
  if (!found) throw new Error(`no ${language} request`);
  return found;
}

describe('reminders with what to bring (VIL-720), flag on', () => {
  it('the evening-before reminder hands the owner their list and the addendum; the co-parent gets neither', async () => {
    await giveParentTheList();
    const base = (await loadCronSkill('reminder')).instructions;
    const addendum = (await loadCronSkill(REMINDER_BRING_SKILL)).instructions;
    const { client, seen } = recordingClient(['Swim tomorrow at 10.']);

    const result = await tick(EVENING_TICK, client);

    expect(result).toMatchObject({ fired: 2, suppressed: 0 });
    const owner = requestFor(seen, 'en');
    expect(owner.facts.offset).toBe('-P1D');
    expect(owner.facts.events).toHaveLength(1);
    expect(owner.facts.events[0]?.bringItems).toEqual(ITEMS);
    expect(owner.system).toBe(reminderInstructions(base, addendum));

    const coParent = requestFor(seen, 'fr');
    expect(coParent.facts.events[0]).not.toHaveProperty('bringItems');
    expect(coParent.system).toBe(base);
    expect(JSON.stringify(coParent.facts)).not.toContain('swimsuit');

    expect(enqueued.map((job) => job.parentUserId).sort()).toEqual(
      [parentUserId, coParentUserId].sort(),
    );
    expect(pages).toEqual([]);
  });

  it("the hour-before reminder carries the owner's list too", async () => {
    await giveParentTheList();
    const { client, seen } = recordingClient(['Swim in 48 minutes.']);
    await tick(EVENING_TICK, recordingClient(['Swim tomorrow at 10.']).client);

    await tick(HOUR_TICK, client);

    const owner = requestFor(seen, 'en');
    expect(owner.facts.offset).toBe('-PT1H');
    expect(owner.facts.events[0]?.bringItems).toEqual(ITEMS);
    expect(requestFor(seen, 'fr').facts.events[0]).not.toHaveProperty('bringItems');
  });

  it("a 13+ child's event carries no list, even to its owner", async () => {
    const teen = await seedChild(db.database, familyId, 'Rowan', 14 * 12, undefined, EVENING_TICK);
    const teenEvent = await seedEvent(teen);
    await db.database.delete(schema.familyEvents).where(eq(schema.familyEvents.id, eventId));
    await giveParentTheList(teenEvent);
    const { client, seen } = recordingClient(['Something tomorrow at 10.']);

    await tick(EVENING_TICK, client);

    const owner = requestFor(seen, 'en');
    expect(owner.facts.events[0]).not.toHaveProperty('bringItems');
    expect(JSON.stringify(owner.facts)).not.toContain('swimsuit');
  });

  it('a reminder that carried a list and could not be written sends nothing and pages #ops once', async () => {
    await giveParentTheList();
    const { client } = recordingClient(['   ']);

    const result = await tick(EVENING_TICK, client);

    expect(result).toMatchObject({ fired: 0, suppressed: 2 });
    expect(enqueued).toEqual([]);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('1 due reminder');
    for (const item of ITEMS) expect(pages[0]).not.toContain(item);
  });

  it('a failure with no list anywhere pages nothing new', async () => {
    const { client } = recordingClient(['   ']);
    await tick(EVENING_TICK, client);
    expect(enqueued).toEqual([]);
    expect(pages).toEqual([]);
  });
});

describe('reminders with what to bring (VIL-720), flag off', () => {
  it("nobody's request carries a list or the addendum, even with one stored", async () => {
    vi.stubEnv('BRING_ITEMS_REMINDER_ENABLED', '');
    await giveParentTheList();
    const base = (await loadCronSkill('reminder')).instructions;
    const { client, seen } = recordingClient(['Swim tomorrow at 10.']);

    await tick(EVENING_TICK, client);

    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expect(request.facts.events[0]).not.toHaveProperty('bringItems');
      expect(request.system).toBe(base);
    }
  });

  it('an unwritten reminder pages nothing from this path', async () => {
    vi.stubEnv('BRING_ITEMS_REMINDER_ENABLED', '');
    await giveParentTheList();
    await tick(EVENING_TICK, recordingClient(['   ']).client);
    expect(pages).toEqual([]);
  });
});
