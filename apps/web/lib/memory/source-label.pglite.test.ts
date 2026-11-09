import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
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
import { loadFactSources } from './source-label';
import { handleParentMemory } from './store';

const NOW = new Date('2026-10-09T15:00:00.000Z');
const ARRIVED = new Date('2026-10-03T14:00:00.000Z');
const ON = { FAMILY_MEMORY_KINDS_ENABLED: 'true' };
const OPENING = 'Here is what I have.';
const CLOSING = 'Wrong or old?';

function frameClient(): AgentClient {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: JSON.stringify({ opening: OPENING, closing: CLOSING }) }],
        usage: { input_tokens: 12, output_tokens: 8 },
        stop_reason: 'end_turn',
      })),
    },
  } as unknown as AgentClient;
}

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
  ): Promise<string | null> {
    const result = await handleParentMemory(db.database, {
      familyId,
      parentUserId,
      body: 'what do you know',
      now: NOW,
      inboundChannelMessageId: door ? await seedInbound(familyId, parentUserId, door) : null,
      env: ON,
      replyClient: frameClient(),
    });
    return result.reply;
  }

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
    const reply = await recall(familyId, parentUserId);
    const lines = (reply ?? '').split('\n');
    expect(lines[0]).toBe(OPENING);
    expect(lines.at(-1)).toBe(CLOSING);
    expect(lines.slice(1, -1).sort()).toEqual([
      '- soccer_day: I think Thursdays (from the Northside Rec email on Oct 3)',
      '- swimming: I think saturday (for now)',
    ]);
    expect(reply).not.toContain('SUBJECT_LINE_NEVER_SHOWN');
    expect(reply).not.toContain('BODY_NEVER_SHOWN');
    expect(reply).not.toContain('programs@');
  });

  it('never lists a Gmail fact without its source', async () => {
    const { familyId, parentUserId } = await mailFamily();
    // The sender is unreadable, so no label can be built.
    const blank = await seedEvent(familyId, 'gmail', { subject: 'no sender' });
    await seedInferred(familyId, 'pool_day', 'Mondays', blank);
    const reply = await recall(familyId, parentUserId);
    expect(reply).toContain('soccer_day');
    for (const line of (reply ?? '').split('\n').filter((l) => l.startsWith('- '))) {
      if (line.includes('soccer_day') || line.includes('pool_day')) {
        expect(line).toMatch(/from the .+ email on /);
      }
    }
    expect(reply).not.toContain('pool_day');
  });

  it("leaves a Gmail fact out for a co-parent, because the mailbox is the other adult's", async () => {
    const { familyId } = await mailFamily();
    const coParent = await seedCoParent(familyId);
    const reply = await recall(familyId, coParent);
    expect(reply).toContain('- swimming: I think saturday (for now)');
    expect(reply).not.toContain('soccer_day');
    expect(reply).not.toContain('Northside');
  });

  it('leaves out a fact whose email Hale no longer holds', async () => {
    const { familyId, parentUserId, mail } = await mailFamily();
    await db.database.delete(schema.events).where(eq(schema.events.id, mail));
    const reply = await recall(familyId, parentUserId);
    expect(reply).toContain('swimming');
    expect(reply).not.toContain('soccer_day');
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
    '- soccer_day: I think Thursdays (from Soccer practice on your calendar, Oct 2)';

  it('names a calendar event by title and day for the parent whose calendar it is', async () => {
    const { familyId, parentUserId } = await calendarFamily();
    const reply = await recall(familyId, parentUserId);
    expect(reply).toContain(CALENDAR_LINE);
    expect(reply).not.toContain('DESCRIPTION_NEVER_SHOWN');
  });

  it("leaves a calendar fact out for a co-parent, because the calendar is the other adult's", async () => {
    const { familyId, parentUserId, coParent, event } = await calendarFamily();
    await seedInferred(familyId, 'swimming', 'saturday');
    const reply = await recall(familyId, coParent);
    expect(reply).toContain('- swimming: I think saturday (for now)');
    expect(reply).not.toContain('soccer_day');
    expect(reply).not.toContain('Soccer practice');

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

  it('treats any turn not recorded as one-to-one as a group, and withholds every source', async () => {
    const { familyId, parentUserId } = await mailFamily();
    const groupOfFamilies = await recall(familyId, parentUserId, {
      inGroup: true,
      chatId: 'chat-not-the-household-group',
    });
    expect(groupOfFamilies).toContain('swimming');
    expect(groupOfFamilies).not.toContain('soccer_day');
    expect(groupOfFamilies).not.toContain('Northside');

    for (const door of [{ inGroup: null, chatId: null }, null]) {
      const reply = await recall(familyId, parentUserId, door);
      expect(reply).toContain('swimming');
      expect(reply).not.toContain('soccer_day');
    }

    const direct = await recall(familyId, parentUserId, {
      inGroup: false,
      chatId: 'chat-not-the-household-group',
    });
    expect(direct).toContain(
      '- soccer_day: I think Thursdays (from the Northside Rec email on Oct 3)',
    );
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
