import { invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGuardDeps } from '~/lib/coach/guards';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import type { ChannelDraftPort } from './draft';
import { PRIVATE_EVENT_WHAT, buildChannelCoachTools, channelScheduleReader } from './tools';

/**
 * The week the coach can actually see: Google Calendar occupancy in
 * `parent_calendar_blocks`, plus the activities and trips mail ingest already
 * wrote. Driven through `lookup_week` and the production reader, against real
 * Postgres, so a filter that only exists in a stub cannot pass.
 */

const NOW = new Date('2026-07-30T12:00:00.000Z'); // Thu 08:00 in Toronto
const MON_4PM = new Date('2026-07-27T20:00:00.000Z');
const TUE_9AM = new Date('2026-07-28T13:00:00.000Z');
const TUE_10AM = new Date('2026-07-28T14:00:00.000Z');
const WED_3PM = new Date('2026-07-29T19:00:00.000Z');
const THU_430 = new Date('2026-07-30T20:30:00.000Z');
const THU_530 = new Date('2026-07-30T21:30:00.000Z');
const NEXT_THU = new Date('2026-08-06T20:30:00.000Z');
const FAR = new Date('2026-08-20T20:30:00.000Z');
const MAIL_SINCE = new Date('2026-07-01T15:00:00.000Z');

const LEAKED_TITLE = 'Quarterly budget review';
const TEEN_TITLE = 'Nadia therapy';
const SECRET_SUBJECT = 'SECRET_SUBJECT_DO_NOT_LEAK';
const OTHER_SECRET = 'OTHER_FAMILY_SECRET_SUBJECT';

describe('lookup_week reads the connected calendar and processed mail', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;
  let integrationId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const family = await seedFamily(db.database);
    familyId = family.familyId;
    parentUserId = family.parentUserId;
    integrationId = await seedIntegration(db.database, familyId, parentUserId, 'gcal');
  });

  afterEach(async () => {
    await db.close();
  });

  async function seedBlock(values: {
    eventId: string;
    startAt: Date | null;
    endAt?: Date | null;
    title?: string | null;
    kidRelated: boolean;
    status?: string;
    familyId?: string;
    integrationId?: string;
    userId?: string;
  }): Promise<void> {
    await db.database.insert(schema.parentCalendarBlocks).values({
      integrationId: values.integrationId ?? integrationId,
      eventId: values.eventId,
      familyId: values.familyId ?? familyId,
      userId: values.userId ?? parentUserId,
      startAt: values.startAt,
      endAt: values.endAt ?? null,
      kidRelated: values.kidRelated,
      title: values.title ?? null,
      status: values.status ?? 'confirmed',
      updatedStamp: `stamp-${values.eventId}`,
    });
  }

  function harness(forFamily = familyId) {
    const draftPort: ChannelDraftPort = {
      async draft() {
        return { actionId: 'action-1' };
      },
    };
    const tools = buildChannelCoachTools({
      familyId: forFamily,
      reader: channelScheduleReader(db.database, NOW),
      draftPort,
      villageTool: null,
      activity: null,
      spots: null,
      now: NOW,
    });
    const deps = buildGuardDeps(db.database);
    return {
      call(name: string, input: unknown) {
        const tool = tools.find((entry) => entry.name === name);
        if (!tool) throw new Error(`no tool named ${name}`);
        return invokeTool(tool, input, { familyId: forFamily, actor: parentUserId }, deps);
      },
    };
  }

  it('merges confirmed blocks with family events, de-duplicated and sorted, inside the window', async () => {
    await db.database.insert(schema.familyEvents).values([
      {
        familyId,
        title: 'Dentist',
        startsAt: MON_4PM,
        location: 'Main Street',
        source: 'parent',
      },
      {
        familyId,
        title: 'School play',
        startsAt: WED_3PM,
        source: 'email',
      },
    ]);
    await seedBlock({
      eventId: 'dentist-on-gcal',
      startAt: MON_4PM,
      title: 'Dentist',
      kidRelated: true,
    });
    await seedBlock({
      eventId: 'gym-a',
      startAt: THU_430,
      endAt: THU_530,
      title: 'Maya gymnastics',
      kidRelated: true,
    });
    await seedBlock({
      eventId: 'gym-b',
      startAt: THU_430,
      endAt: THU_530,
      title: 'Maya gymnastics',
      kidRelated: true,
    });
    await seedBlock({
      eventId: 'standup',
      startAt: TUE_9AM,
      endAt: TUE_10AM,
      kidRelated: false,
    });
    await seedBlock({
      eventId: 'tentative',
      startAt: THU_430,
      title: 'Tentative picnic',
      kidRelated: true,
      status: 'tentative',
    });
    await seedBlock({
      eventId: 'cancelled',
      startAt: THU_430,
      title: 'Cancelled recital',
      kidRelated: true,
      status: 'cancelled',
    });
    await seedBlock({
      eventId: 'next-week',
      startAt: NEXT_THU,
      title: 'Next week swim',
      kidRelated: true,
    });
    await seedBlock({
      eventId: 'far',
      startAt: FAR,
      title: 'August far away',
      kidRelated: true,
    });

    const other = await seedFamily(db.database, 'Other household');
    const otherIntegration = await seedIntegration(
      db.database,
      other.familyId,
      other.parentUserId,
      'gcal',
    );
    await seedBlock({
      eventId: 'other-piano',
      startAt: THU_430,
      title: 'Other household piano',
      kidRelated: true,
      familyId: other.familyId,
      integrationId: otherIntegration,
      userId: other.parentUserId,
    });

    const week = (await harness().call('lookup_week', {})) as {
      calendarSync: string;
      events: Array<{
        kind: string;
        eventId?: string;
        what?: string;
        when: string;
        until?: string | null;
        source?: string;
      }>;
    };

    expect(week.calendarSync).toBe('connected');
    expect(week.events.map((event) => event.what ?? event.kind)).toEqual([
      'Dentist',
      'busy',
      'School play',
      'Maya gymnastics',
    ]);
    expect(week.events[0]).toMatchObject({
      kind: 'event',
      what: 'Dentist',
      when: 'Mon 4:00pm',
      source: 'parent',
    });
    expect(week.events[0]?.eventId).toBeTruthy();
    expect(week.events[1]).toEqual({
      kind: 'busy',
      when: 'Tue 9:00am',
      until: 'Tue 10:00am',
      allDay: false,
    });
    expect(week.events[2]).toMatchObject({
      kind: 'event',
      what: 'School play',
      when: 'Wed 3:00pm',
      source: 'email',
    });
    expect(week.events[3]).toMatchObject({
      kind: 'calendar',
      what: 'Maya gymnastics',
      when: 'Thu 4:30pm',
      until: 'Thu 5:30pm',
      allDay: false,
    });
    expect(week.events[3]).not.toHaveProperty('eventId');

    const body = JSON.stringify(week);
    expect(body).not.toContain('Tentative picnic');
    expect(body).not.toContain('Cancelled recital');
    expect(body).not.toContain('Next week swim');
    expect(body).not.toContain('August far away');
    expect(body).not.toContain('Other household piano');

    const next = (await harness().call('lookup_week', { weekOffset: 1 })) as {
      events: Array<{ what?: string }>;
    };
    expect(next.events.map((event) => event.what)).toEqual(['Next week swim']);
  });

  it('never returns a title for a non-kid block, and withholds a teen name', async () => {
    await db.database.execute(
      sql`alter table parent_calendar_blocks drop constraint parent_calendar_blocks_title_kid_only`,
    );
    await seedBlock({
      eventId: 'budget',
      startAt: TUE_9AM,
      endAt: TUE_10AM,
      title: LEAKED_TITLE,
      kidRelated: false,
    });
    await db.database.insert(schema.children).values({
      familyId,
      name: 'Nadia',
      dateOfBirth: '2010-06-01',
    });
    await seedBlock({
      eventId: 'teen',
      startAt: THU_430,
      title: TEEN_TITLE,
      kidRelated: true,
    });

    const week = await harness().call('lookup_week', {});
    const body = JSON.stringify(week);

    expect(body).not.toContain(LEAKED_TITLE);
    expect(body).not.toContain('Quarterly');
    expect(body).not.toContain('Nadia');
    expect(body).not.toContain('therapy');
    expect(body).toContain(PRIVATE_EVENT_WHAT);
    const events = (week as { events: Array<Record<string, unknown>> }).events;
    const busy = events.find((event) => event.kind === 'busy');
    expect(busy).toEqual({
      kind: 'busy',
      when: 'Tue 9:00am',
      until: 'Tue 10:00am',
      allDay: false,
    });
    expect(busy).not.toHaveProperty('what');
    expect(busy).not.toHaveProperty('title');
  });

  it('says mail sync is paused when Gmail is in error, and does not return the message', async () => {
    await db.database.insert(schema.integrations).values({
      familyId,
      userId: parentUserId,
      provider: 'gmail',
      status: 'error',
    });
    await db.database.insert(schema.events).values({
      familyId,
      source: 'gmail',
      eventType: 'school_communication',
      payload: { subject: SECRET_SUBJECT, snippet: 'the body of the email' },
      dedupHash: 'gmail-1',
      receivedAt: MAIL_SINCE,
    });
    const other = await seedFamily(db.database, 'Other mailbox');
    await db.database.insert(schema.events).values({
      familyId: other.familyId,
      source: 'gmail',
      eventType: 'school_communication',
      payload: { subject: OTHER_SECRET },
      dedupHash: 'gmail-other',
      receivedAt: MAIL_SINCE,
    });

    const week = (await harness().call('lookup_week', {})) as {
      calendarSync: string;
      mail: { sync: string; note: string | null; processedCount: number; since: string | null };
    };

    expect(week.calendarSync).toBe('connected');
    expect(week.mail.sync).toBe('paused');
    expect(week.mail.note).toBe('Mail sync is currently paused.');
    expect(week.mail.processedCount).toBe(1);
    expect(week.mail.since).toBe(MAIL_SINCE.toISOString());
    const body = JSON.stringify(week);
    expect(body).not.toContain(SECRET_SUBJECT);
    expect(body).not.toContain('the body of the email');
    expect(body).not.toContain(OTHER_SECRET);
  });

  it('surfaces extracted activities and trips when Gmail is connected, and only inside the window', async () => {
    await db.database.insert(schema.integrations).values({
      familyId,
      userId: parentUserId,
      provider: 'gmail',
      status: 'active',
      lastSyncAt: MAIL_SINCE,
    });
    const [message] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'email_alert',
        status: 'sent',
      })
      .returning({ id: schema.channelMessages.id });
    if (!message) throw new Error('channel message insert returned no row');

    await db.database.insert(schema.activityBookings).values([
      {
        familyId,
        parentUserId,
        integrationId,
        messageId: 'msg-swim',
        providerHost: 'pool.example.ca',
        title: 'Swim level 2',
        firstSessionAt: THU_430,
        location: 'West pool',
        channelMessageId: message.id,
      },
      {
        familyId,
        parentUserId,
        integrationId,
        messageId: 'msg-later',
        providerHost: 'pool.example.ca',
        title: 'August far camp',
        firstSessionAt: FAR,
        channelMessageId: message.id,
      },
      {
        familyId,
        parentUserId,
        integrationId,
        messageId: 'msg-teen',
        providerHost: 'pool.example.ca',
        title: 'Nadia soccer',
        firstSessionAt: WED_3PM,
        channelMessageId: message.id,
      },
      {
        familyId,
        parentUserId,
        integrationId,
        messageId: 'msg-cancelled',
        providerHost: 'pool.example.ca',
        title: 'Cancelled swim camp',
        firstSessionAt: THU_430,
        cancelledAt: NOW,
        channelMessageId: message.id,
      },
    ]);
    await db.database.insert(schema.children).values({
      familyId,
      name: 'Nadia',
      dateOfBirth: '2010-06-01',
    });
    await db.database.insert(schema.familyTrips).values({
      familyId,
      parentUserId,
      integrationId,
      messageId: 'msg-trip',
      destinationCity: 'Ottawa',
      startsOn: '2026-07-30',
      endsOn: '2026-08-02',
      childEvidence: 'child_fare',
    });
    await db.database.insert(schema.events).values({
      familyId,
      source: 'gmail',
      eventType: 'school_communication',
      payload: { subject: SECRET_SUBJECT },
      dedupHash: 'gmail-active',
      receivedAt: MAIL_SINCE,
    });

    const week = (await harness().call('lookup_week', {})) as {
      mail: {
        sync: string;
        note: string | null;
        processedCount: number;
        since: string | null;
        items: Array<{ kind: string; what: string; when: string; where: string | null }>;
      };
    };

    expect(week.mail.sync).toBe('connected');
    expect(week.mail.note).toBeNull();
    expect(week.mail.processedCount).toBe(1);
    expect(week.mail.since).toBe(MAIL_SINCE.toISOString());
    expect(week.mail.items).toEqual([
      { kind: 'activity', what: 'Swim level 2', when: 'Thu 4:30pm', where: 'West pool' },
      { kind: 'trip', what: 'Ottawa', when: '2026-07-30 to 2026-08-02', where: null },
    ]);
    const body = JSON.stringify(week);
    expect(body).not.toContain('August far camp');
    expect(body).not.toContain('Nadia');
    expect(body).not.toContain('soccer');
    expect(body).not.toContain('Cancelled swim camp');
    expect(body).not.toContain(SECRET_SUBJECT);
    expect(body).not.toContain('pool.example.ca');
  });
});
