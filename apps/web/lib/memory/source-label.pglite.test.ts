import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { loadFactSources } from '@hale/worker/fact-sources';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type TestDb,
  createTestDb,
  seedChild,
  seedFamily,
  seedIntegration,
} from '~/lib/testing/pglite';
import { writeFact } from './facts';
import { asked, scriptedMemoryScreen } from './scripted-memory-screen.fixture';
import { handleParentMemory } from './store';

const NOW = new Date('2026-10-09T15:00:00.000Z');
const ARRIVED = new Date('2026-10-03T14:00:00.000Z');
const ON = { FAMILY_MEMORY_KINDS_ENABLED: 'true' };
const WRITTEN = 'Here is what I remember about your family.';

interface Composed {
  purpose?: string;
  audience: string;
  facts: string[];
}

/**
 * The model at its client port: it records what the composer handed it and returns one
 * fixed answer. No judgement is under test here; what is under test is which facts, with
 * which provenance, reach the writer of the list (VIL-429, VIL-723). The list's own words
 * are the model's, so no line is asserted.
 */
function capturingClient(): { client: AgentClient; composed: Composed[] } {
  const composed: Composed[] = [];
  const client = {
    messages: {
      create: vi.fn(async (request: { messages: Array<{ content: unknown }> }) => {
        const first = request.messages[0]?.content;
        const text =
          typeof first === 'string'
            ? first
            : ((first as Array<{ type: string; text?: string }>).find(
                (block) => block.type === 'text',
              )?.text ?? '{}');
        composed.push(JSON.parse(text) as Composed);
        return {
          content: [{ type: 'text', text: JSON.stringify({ text: WRITTEN }) }],
          usage: { input_tokens: 12, output_tokens: 8 },
          stop_reason: 'end_turn',
        };
      }),
    },
  } as unknown as AgentClient;
  return { client, composed };
}

/** Scripted: the screen read "what do you know about us" as a list (the eval reads words). */
const LISTING = scriptedMemoryScreen({ request: () => asked('list') });

describe('VIL-429 · a connector fact says where Hale saw it', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function seedEvent(
    familyId: string,
    source: string,
    payload: Record<string, unknown>,
    extra: { teenContent?: boolean; childId?: string | null } = {},
  ): Promise<string> {
    const [row] = await db.database
      .insert(schema.events)
      .values({
        familyId,
        source,
        eventType: 'activity_signup_open',
        payload,
        dedupHash: `${source}-${Math.random()}`,
        receivedAt: ARRIVED,
        teenContent: extra.teenContent ?? false,
        childId: extra.childId ?? null,
      })
      .returning({ id: schema.events.id });
    if (!row) throw new Error('event insert returned no row');
    return row.id;
  }

  async function seedInferred(
    familyId: string,
    factKey: string,
    factValue: string,
    sourceEventId?: string,
  ): Promise<void> {
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'routine',
      factKey,
      factValue,
      confidence: 0.9,
      inferredBy: 'memory_inferencer',
      // Recorded as the household's, so the connector-owner rule is the only thing that
      // holds a fact back here: an unrecorded routine reaches neither adult once a
      // co-parent is on record (VIL-599).
      heard: { in: 'family', userId: null },
      sourceEventId,
      validFrom: NOW,
      memoryKind: 'lasting',
      memorySource: 'inferred',
      sourcedAt: NOW,
      signalCount: 0,
    });
  }

  async function seedCoParent(familyId: string): Promise<string> {
    const [user] = await db.database
      .insert(schema.users)
      .values({ email: `co-${familyId}@example.test`, name: 'Other Parent' })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('user insert returned no row');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: user.id, role: 'co_parent' });
    return user.id;
  }

  async function seedInbound(
    familyId: string,
    parentUserId: string,
    door: { inGroup: boolean | null; chatId: string | null },
  ): Promise<string> {
    const [row] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel: 'imessage',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        body: 'what do you know',
        providerChatId: door.chatId,
        inGroup: door.inGroup,
      })
      .returning({ id: schema.channelMessages.id });
    if (!row) throw new Error('channel message insert returned no row');
    return row.id;
  }

  async function recall(
    familyId: string,
    parentUserId: string,
    door: { inGroup: boolean | null; chatId: string | null } | null = {
      inGroup: false,
      chatId: 'chat-direct',
    },
  ): Promise<{
    reply: string | null;
    outcome: string;
    onlyToAsker: boolean;
    purpose: string | undefined;
    facts: string[];
  }> {
    const { client, composed } = capturingClient();
    const result = await handleParentMemory(db.database, {
      familyId,
      parentUserId,
      body: 'what do you know about us?',
      now: NOW,
      inboundChannelMessageId: door ? await seedInbound(familyId, parentUserId, door) : null,
      env: ON,
      replyClient: client,
      screen: LISTING,
    });
    expect(composed).toHaveLength(1);
    return {
      reply: result.reply,
      outcome: result.outcome,
      onlyToAsker: result.onlyToAsker,
      purpose: composed[0]?.purpose,
      facts: composed[0]?.facts ?? [],
    };
  }

  const MAIL_LINE =
    "soccer_day: Thursdays (source: Hale's own guess; seen: an email from Northside Rec, Oct 3; kept until they change it)";
  const SWIM_LINE = "swimming: saturday (source: Hale's own guess; kept until they change it)";

  async function mailFamily() {
    const seeded = await seedFamily(db.database);
    await seedIntegration(db.database, seeded.familyId, seeded.parentUserId, 'gmail');
    const mail = await seedEvent(seeded.familyId, 'gmail', {
      sender: 'Northside Rec <programs@northside-rec.example>',
      subject: 'SUBJECT_LINE_NEVER_SHOWN',
      snippet: 'BODY_NEVER_SHOWN',
    });
    await seedInferred(seeded.familyId, 'soccer_day', 'Thursdays', mail);
    await seedInferred(seeded.familyId, 'swimming', 'saturday');
    return { ...seeded, mail };
  }

  it('names the sender and the day for the parent whose mailbox it was', async () => {
    const { familyId, parentUserId } = await mailFamily();
    const read = await recall(familyId, parentUserId);
    expect(read.purpose).toBe('memory_list');
    expect(read.reply).toBe(WRITTEN);
    expect(read.onlyToAsker).toBe(false);
    expect([...read.facts].sort()).toEqual([MAIL_LINE, SWIM_LINE]);
    const handed = JSON.stringify(read.facts);
    expect(handed).not.toContain('SUBJECT_LINE_NEVER_SHOWN');
    expect(handed).not.toContain('BODY_NEVER_SHOWN');
    expect(handed).not.toContain('programs@');
  });

  it('never lists a Gmail fact without its source', async () => {
    const { familyId, parentUserId } = await mailFamily();
    // The sender is unreadable, so no label can be built.
    const blank = await seedEvent(familyId, 'gmail', { subject: 'no sender' });
    await seedInferred(familyId, 'pool_day', 'Mondays', blank);
    const { facts } = await recall(familyId, parentUserId);
    expect(facts).toContain(MAIL_LINE);
    expect(JSON.stringify(facts)).not.toContain('pool_day');
  });

  it("leaves a Gmail fact out for a co-parent, because the mailbox is the other adult's", async () => {
    const { familyId } = await mailFamily();
    const coParent = await seedCoParent(familyId);
    const { facts } = await recall(familyId, coParent);
    expect(facts).toEqual([SWIM_LINE]);
    expect(JSON.stringify(facts)).not.toContain('Northside');
  });

  it('leaves out a fact whose email Hale no longer holds', async () => {
    const { familyId, parentUserId, mail } = await mailFamily();
    await db.database.delete(schema.events).where(eq(schema.events.id, mail));
    const { facts } = await recall(familyId, parentUserId);
    expect(facts).toEqual([SWIM_LINE]);
  });

  async function calendarFamily() {
    const seeded = await seedFamily(db.database);
    const coParent = await seedCoParent(seeded.familyId);
    await seedIntegration(db.database, seeded.familyId, seeded.parentUserId, 'gcal');
    const event = await seedEvent(seeded.familyId, 'gcal', {
      summary: 'Soccer practice',
      start: { dateTime: '2026-10-02T22:00:00.000Z' },
      description: 'DESCRIPTION_NEVER_SHOWN',
    });
    await seedInferred(seeded.familyId, 'soccer_day', 'Thursdays', event);
    return { ...seeded, coParent, event };
  }

  const CALENDAR_LINE =
    "soccer_day: Thursdays (source: Hale's own guess; seen: Soccer practice on their calendar, Oct 2; kept until they change it)";

  it('names a calendar event by title and day for the parent whose calendar it is', async () => {
    const { familyId, parentUserId } = await calendarFamily();
    const { facts } = await recall(familyId, parentUserId);
    expect(facts).toContain(CALENDAR_LINE);
    expect(JSON.stringify(facts)).not.toContain('DESCRIPTION_NEVER_SHOWN');
  });

  it("leaves a calendar fact out for a co-parent, because the calendar is the other adult's", async () => {
    const { familyId, parentUserId, coParent, event } = await calendarFamily();
    await seedInferred(familyId, 'swimming', 'saturday');
    const { facts } = await recall(familyId, coParent);
    expect(facts).toEqual([SWIM_LINE]);
    expect(JSON.stringify(facts)).not.toContain('Soccer practice');

    const read = (readerUserId: string) =>
      loadFactSources(db.database, {
        familyId,
        readerUserId,
        inGroup: false,
        now: NOW,
        sourceEventIds: [event],
      });
    expect((await read(coParent)).get(event)).toEqual({ connector: true, label: null });
    expect((await read(parentUserId)).get(event)).toEqual({
      connector: true,
      label: {
        kind: 'calendar',
        title: 'Soccer practice',
        on: new Date('2026-10-02T22:00:00.000Z'),
      },
    });
  });

  it('withholds the source of a mirrored calendar item from the adult who did not connect it', async () => {
    const { familyId, parentUserId, coParent } = await calendarFamily();
    const mirrored = await seedEvent(familyId, 'google_calendar', { summary: 'Swim lesson' });
    const read = (readerUserId: string) =>
      loadFactSources(db.database, {
        familyId,
        readerUserId,
        inGroup: false,
        now: NOW,
        sourceEventIds: [mirrored],
      });
    expect((await read(coParent)).get(mirrored)).toEqual({ connector: true, label: null });
    expect((await read(parentUserId)).get(mirrored)).toMatchObject({
      connector: true,
      label: { kind: 'calendar', title: 'Swim lesson' },
    });
  });

  it('never says the list in a group: a group turn answers the asker alone, and an unplaced turn says no value', async () => {
    const { familyId, parentUserId } = await mailFamily();
    // A group turn: the list is written for the asker and goes only to their phone
    // (router `onlyToAsker`), so it reads as their own 1:1, sources included.
    const groupOfFamilies = await recall(familyId, parentUserId, {
      inGroup: true,
      chatId: 'chat-not-the-household-group',
    });
    expect(groupOfFamilies.onlyToAsker).toBe(true);
    expect(groupOfFamilies.purpose).toBe('memory_list');
    expect([...groupOfFamilies.facts].sort()).toEqual([MAIL_LINE, SWIM_LINE]);

    // A turn the door could not place: nobody knows who reads it, so no value is handed
    // to the writer at all; it says the list is theirs to ask for one to one.
    for (const door of [{ inGroup: null, chatId: null }, null]) {
      const unplaced = await recall(familyId, parentUserId, door);
      expect(unplaced.outcome).toBe('recall_withheld');
      expect(unplaced.purpose).toBe('memory_list_private');
      expect(unplaced.facts).toEqual([]);
      expect(unplaced.onlyToAsker).toBe(false);
    }

    const direct = await recall(familyId, parentUserId, {
      inGroup: false,
      chatId: 'chat-not-the-household-group',
    });
    expect(direct.onlyToAsker).toBe(false);
    expect(direct.facts).toContain(MAIL_LINE);
  });

  it('withholds a source in the group thread, from a teen item, and from no reader', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await seedIntegration(db.database, familyId, parentUserId, 'gmail');
    const teen = await seedChild(db.database, familyId, 'Teen', 170, undefined, NOW);
    const mail = await seedEvent(familyId, 'gmail', { sender: 'Northside Rec <a@b.example>' });
    const teenMail = await seedEvent(
      familyId,
      'gmail',
      { sender: 'Club <c@d.example>' },
      {
        childId: teen,
      },
    );
    const flagged = await seedEvent(
      familyId,
      'gcal',
      { summary: 'Private' },
      { teenContent: true },
    );
    const sms = await seedEvent(familyId, 'channel_sms', { body: 'hi' });
    const read = (readerUserId: string | null, inGroup: boolean) =>
      loadFactSources(db.database, {
        familyId,
        readerUserId,
        inGroup,
        now: NOW,
        sourceEventIds: [mail, teenMail, flagged, sms, null],
      });

    const own = await read(parentUserId, false);
    expect(own.get(mail)).toEqual({
      connector: true,
      label: { kind: 'email', from: 'Northside Rec', on: ARRIVED },
    });
    expect(own.get(teenMail)).toEqual({ connector: true, label: null });
    expect(own.get(flagged)).toEqual({ connector: true, label: null });
    expect(own.get(sms)).toEqual({ connector: false });

    const group = await read(parentUserId, true);
    expect(group.get(mail)).toEqual({ connector: true, label: null });
    expect(group.get(sms)).toEqual({ connector: false });

    const nobody = await read(null, false);
    expect(nobody.get(mail)).toEqual({ connector: true, label: null });
  });
});
