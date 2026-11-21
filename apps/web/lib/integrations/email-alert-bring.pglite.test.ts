import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { BringItemsInput, BringItemsRead } from '~/lib/loop/reminders/bring/read';
import { bringSourceRef } from '~/lib/loop/reminders/bring/store';
import type { ExtractedEvent, ExtractionKind, SentinelClassification } from '~/lib/sentinel';
import { scriptedNoticeWriter } from '~/lib/testing/email-alert-notice';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { type EmailAlertPorts, alertParentForEmail } from './email-alert';

/**
 * VIL-720 · the Gmail alert's two bring-list hooks, through the real `alertParentForEmail`
 * on PGlite: an email about an event the family holds keeps its list against that event
 * (the quiet path), and an email Hale offers to add keeps its list pending on the offer.
 * The classifier, the notice writer and the bring reader are ports with scripted answers:
 * where a reading goes is under test here, never what a model reads. Invented throughout.
 */

let db: TestDb;
let familyId: string;
let parentUserId: string;
let integrationId: string;

const NOW = new Date('2026-09-17T15:00:00.000Z');
const ENVELOPE = {
  subject: 'Swim lessons this Saturday',
  from: 'Riverside Pool <info@riverside.example>',
  snippet: 'Swim lessons this Saturday at 9',
  receivedAt: '2026-09-17T14:00:00.000Z',
};
const BODY =
  'Hi families, swim lessons are on this Saturday at 9. Please bring a swimsuit and a towel.';

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  ({ familyId, parentUserId } = await seedFamily(db.database));
  integrationId = randomUUID();
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('EMAIL_ALERT_ENABLED', 'true');
  vi.stubEnv('EMAIL_ALERT_BODY_ENABLED', '');
  vi.stubEnv('BRING_ITEMS_REMINDER_ENABLED', 'true');
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function classified(
  kind: ExtractionKind,
  event: Partial<ExtractedEvent>,
  matched: { id: string } | null,
  teenAttributed = false,
): SentinelClassification {
  return {
    status: 'classified',
    familyId,
    messageId: 'm1',
    extraction: {
      kind,
      event: {
        title: 'Swim lessons',
        childRef: null,
        originalTime: null,
        newTime: null,
        location: null,
        ...event,
      },
      sourceConfidence: 0.9,
      quoteEvidence: 'swim lessons are on this Saturday',
      teenContent: false,
      teenAttributed,
      matchedEventRef: matched ? { table: 'family_events', id: matched.id } : null,
      ...(matched ? { matchedEventCount: 1 } : {}),
    },
    usage: { triage: { promptTokens: 1, completionTokens: 1 }, extract: null },
  };
}

function harness(classification: SentinelClassification, read: BringItemsRead) {
  const writer = scriptedNoticeWriter({ children: [] });
  const reads: BringItemsInput[] = [];
  let bodyReads = 0;
  const ports: EmailAlertPorts = {
    familyChildren: writer.familyChildren,
    writeNotice: writer.writeNotice,
    parentLanguage: writer.parentLanguage,
    readAlertBody: async () => {
      bodyReads += 1;
      return BODY;
    },
    readBringItems: async (input) => {
      reads.push(input);
      return read;
    },
    classify: async () => classification,
    gate: async () => ({ allowed: true, optOut: 'full' }),
    resolvePhone: async () => '+14165551234',
    transport: new FakeTransport(),
    threadMessage: async () => 'conv-1',
    timeZone: async () => 'America/Toronto',
    rereadEnvelope: async () => null,
  };
  return { ports, reads, bodyReads: () => bodyReads };
}

function alert(ports: EmailAlertPorts) {
  return alertParentForEmail(
    db.database,
    {
      familyId,
      parentUserId,
      integrationId,
      messageId: 'm1',
      threadId: 't-m1',
      labelIds: ['INBOX'],
      envelope: ENVELOPE,
      timeZone: 'America/Toronto',
      now: NOW,
    },
    ports,
  );
}

async function seedEvent(): Promise<string> {
  const [event] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      title: 'Swim lessons',
      startsAt: new Date('2026-09-19T13:00:00.000Z'),
      source: 'placement',
    })
    .returning({ id: schema.familyEvents.id });
  if (!event) throw new Error('no event');
  return event.id;
}

function bringRows() {
  return db.database
    .select()
    .from(schema.familyEventBringItems)
    .where(eq(schema.familyEventBringItems.familyId, familyId));
}

const READ: BringItemsRead = { status: 'read', items: ['a swimsuit', 'a towel'], dropped: 0 };

describe('the Gmail alert keeps what an email says to bring (VIL-720)', () => {
  it('an email about an event the family holds: quiet, and the list is kept against it', async () => {
    const eventId = await seedEvent();
    const h = harness(
      classified('reminder_only', { originalTime: '2026-09-19T13:00:00.000Z' }, { id: eventId }),
      READ,
    );

    const result = await alert(h.ports);

    expect(result.alert).toBe('already_on_calendar');
    expect(h.reads).toHaveLength(1);
    expect(h.reads[0]?.source).toMatchObject({ kind: 'email', body: BODY });
    const [row] = await bringRows();
    expect(row).toMatchObject({
      ownerUserId: parentUserId,
      eventId,
      sourceKind: 'email',
      sourceRef: bringSourceRef(integrationId, 'm1'),
      items: ['a swimsuit', 'a towel'],
    });
  });

  it('an email Hale offers to add: the text goes, and the list waits on that offer', async () => {
    const h = harness(classified('new_event', { newTime: '2026-09-19T13:00:00.000Z' }, null), READ);

    const result = await alert(h.ports);

    expect(result.alert).toBe('sent');
    const offers = await db.database
      .select({ integrationId: schema.emailAlertOffers.integrationId })
      .from(schema.emailAlertOffers)
      .where(eq(schema.emailAlertOffers.familyId, familyId));
    expect(offers).toEqual([{ integrationId }]);
    const [row] = await bringRows();
    expect(row).toMatchObject({
      ownerUserId: parentUserId,
      eventId: null,
      sourceRef: bringSourceRef(integrationId, 'm1'),
    });
  });

  it("a 13+ child's email is never read for a list", async () => {
    const eventId = await seedEvent();
    const h = harness(
      classified(
        'reminder_only',
        { originalTime: '2026-09-19T13:00:00.000Z' },
        { id: eventId },
        true,
      ),
      READ,
    );

    await alert(h.ports);

    expect(h.reads).toEqual([]);
    expect(h.bodyReads()).toBe(0);
    expect(await bringRows()).toEqual([]);
  });

  it('flag off: no body is read for a list and nothing is kept, on either path', async () => {
    vi.stubEnv('BRING_ITEMS_REMINDER_ENABLED', '');
    const eventId = await seedEvent();
    const quiet = harness(
      classified('reminder_only', { originalTime: '2026-09-19T13:00:00.000Z' }, { id: eventId }),
      READ,
    );
    expect((await alert(quiet.ports)).alert).toBe('already_on_calendar');
    expect(quiet.reads).toEqual([]);
    expect(quiet.bodyReads()).toBe(0);

    integrationId = randomUUID();
    const offered = harness(
      classified('new_event', { newTime: '2026-09-19T13:00:00.000Z' }, null),
      READ,
    );
    expect((await alert(offered.ports)).alert).toBe('sent');
    expect(offered.reads).toEqual([]);
    expect(offered.bodyReads()).toBe(0);
    expect(await bringRows()).toEqual([]);
  });
});
