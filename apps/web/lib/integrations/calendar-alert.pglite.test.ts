import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { OPT_OUT_LINE } from '~/lib/channel/opt-out';
import { PROACTIVE_CAP, PROACTIVE_CATEGORY } from '~/lib/channel/outbound-gate';
import { isPrintableGsm7Basic, smsSegments } from '~/lib/channel/sms-segments';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import {
  CALENDAR_ALERT_MAX_PER_SWEEP,
  CALENDAR_ALERT_PENDING_MAX_DAYS,
  CALENDAR_ALERT_TEMPLATE_KEY,
  type CalendarAlertOutcome,
  type CalendarAlertPorts,
  type CalendarAlertSweep,
  type CalendarChange,
  type PriorStart,
  alertParentForCalendarChanges,
  calendarAlertDedupeKey,
  calendarSeriesAlertDedupeKey,
  eventSpan,
  renderCalendarAlert,
} from './calendar-alert';

/**
 * A change on the parent's own calendar becomes ONE text, against the REAL DDL.
 *
 * pglite rather than a Drizzle fake for the same reason the email alert's suite is:
 * what makes "one text per change, and one more when it MOVES" true is the partial
 * unique index on `channel_messages.dedupe_key` plus the WHERE clause in `dedupeActive`,
 * and a fake answers both from whatever rows it happens to hold.
 *
 * There is no classifier here and nothing to mock: the calendar is the parent's own, so
 * whether a change is worth a text is a question about TIME, not about content.
 */

let db: TestDb;
let family: { familyId: string; parentUserId: string };

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

/** Fresh per test: the dedupe key is (connection, event, updated-stamp) and the pglite
 * instance is shared across the file. A REAL integrations row, because the snapshot
 * memory hangs off it by a cascading foreign key. */
let INTEGRATION: string;
const NOW = new Date('2026-09-17T15:00:00.000Z'); // 11:00 a.m. in Toronto
const PHONE = '+14165551234';

/** Thursday, Sep 17 2026, 4:15-5:00 p.m. Toronto. */
const TIMED: CalendarChange = {
  eventId: 'ev-cartwheels',
  updated: '2026-09-17T14:55:00.000Z',
  status: 'confirmed',
  title: 'Cartwheels Gym',
  start: { dateTime: '2026-09-17T20:15:00.000Z' },
  end: { dateTime: '2026-09-17T21:00:00.000Z' },
};

interface Harness {
  ports: CalendarAlertPorts;
  transport: FakeTransport;
  threaded: Array<{ familyId: string; parentUserId: string; body: string }>;
  /** Every parent the sweep asked the clock for — one read per sweep at most, and none
   * at all for a family Hale may not speak to. */
  timeZoneReads: string[];
}

function harness(
  over: {
    verdict?: Awaited<ReturnType<CalendarAlertPorts['gate']>>;
    phone?: string | null;
    sendThrows?: TwilioSendError;
  } = {},
): Harness {
  const transport = new FakeTransport();
  const threaded: Harness['threaded'] = [];
  const timeZoneReads: string[] = [];
  return {
    transport,
    threaded,
    timeZoneReads,
    ports: {
      gate: async () => over.verdict ?? { allowed: true, optOut: 'full' },
      resolvePhone: async () => (over.phone === undefined ? PHONE : over.phone),
      transport: over.sendThrows
        ? {
            async send() {
              throw over.sendThrows;
            },
          }
        : transport,
      threadMessage: async (_db, input) => {
        threaded.push(input);
        return 'conv-1';
      },
      timeZone: async (parentUserId) => {
        timeZoneReads.push(parentUserId);
        return 'America/Toronto';
      },
    },
  };
}

function sweepBoth(
  h: Harness,
  over: Partial<Parameters<typeof alertParentForCalendarChanges>[1]> = {},
): Promise<CalendarAlertSweep> {
  return alertParentForCalendarChanges(
    db.database,
    {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId: INTEGRATION,
      seeding: false,
      changes: [TIMED],
      now: NOW,
      ...over,
    },
    h.ports,
  );
}

/** The positional half — one outcome per change — which is what almost every case here
 * is about. The re-offer cases use {@link sweepBoth}. */
async function sweep(
  h: Harness,
  over: Partial<Parameters<typeof alertParentForCalendarChanges>[1]> = {},
): Promise<readonly CalendarAlertOutcome[]> {
  return (await sweepBoth(h, over)).changes;
}

function snapshotRows() {
  return db.database
    .select()
    .from(schema.calendarEventSnapshots)
    .where(eq(schema.calendarEventSnapshots.integrationId, INTEGRATION));
}

async function snapshotOf(eventId: string) {
  const rows = await snapshotRows();
  return rows.find((row) => row.eventId === eventId);
}

function ledgerRows() {
  return db.database
    .select()
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.familyId, family.familyId));
}

function auditRows() {
  return db.database
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, family.familyId));
}

beforeEach(async () => {
  family = await seedFamily(db.database);
  INTEGRATION = await seedIntegration(db.database, family.familyId, family.parentUserId);
  vi.stubEnv('F14_ENABLED', 'true');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('alertParentForCalendarChanges', () => {
  it('sends exactly one text, ledgers it under the dedupe key, threads it and audits it', async () => {
    const h = harness();

    await expect(sweep(h)).resolves.toEqual(['sent']);

    expect(h.transport.sent).toHaveLength(1);
    const [rows, audit] = await Promise.all([ledgerRows(), auditRows()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: 'calendar_alert',
      direction: 'out',
      channel: 'sms',
      templateKey: CALENDAR_ALERT_TEMPLATE_KEY,
      dedupeKey: calendarAlertDedupeKey(INTEGRATION, TIMED.eventId, TIMED.updated),
      status: 'queued',
      providerMessageId: 'fake-out-1',
    });
    // Rule #1: the ledger never carries the sentence, let alone the event.
    expect(rows[0]?.body).toBeNull();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actionTaken: 'calendar_alert_sent',
      targetTable: 'channel_messages',
      targetId: rows[0]?.id,
      after: { status: 'confirmed', allDay: false },
    });
    expect(h.threaded).toHaveLength(1);
    expect(h.threaded[0]?.body).not.toContain(OPT_OUT_LINE);
    expect(h.transport.sent[0]?.body).toContain(OPT_OUT_LINE);
  });

  it('is dark behind F14 — no text and no receipt', async () => {
    vi.stubEnv('F14_ENABLED', 'false');
    const h = harness();

    await expect(sweep(h)).resolves.toEqual(['dark']);

    expect(h.transport.sent).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);

    // An EMPTY page costs nothing at all while dark, not even the clock read: the flag is
    // a pure function of the family id, so a query in front of it is a query for a family
    // Hale may not text.
    const quiet = harness();
    await expect(sweep(quiet, { changes: [] })).resolves.toEqual([]);
    expect(quiet.timeZoneReads).toEqual([]);
  });

  it('REMEMBERS the shape while it is dark, so the first change after the flip is a move', async () => {
    // A dark family's calendar keeps changing, and the syncToken keeps advancing past
    // those changes. A dark sweep that wrote nothing would leave the memory holding
    // whatever it last saw before the flag went off — so the first change AFTER the flip
    // reads as a first sighting, or worse, names a "was" the parent's calendar left
    // behind weeks ago. Shape only: no text, no receipt, none of the parent's words.
    vi.stubEnv('F14_ENABLED', 'false');
    await expect(sweep(harness())).resolves.toEqual(['dark']);
    expect(await snapshotOf(TIMED.eventId)).toMatchObject({
      startAt: new Date('2026-09-17T20:15:00.000Z'),
      allDay: false,
      status: 'confirmed',
      pendingSince: null,
      heldTitle: null,
      heldLocation: null,
    });

    vi.stubEnv('F14_ENABLED', 'true');
    const lit = harness();
    await expect(
      sweep(lit, {
        changes: [
          {
            ...TIMED,
            updated: '2026-09-17T14:58:00.000Z',
            start: { dateTime: '2026-09-18T20:15:00.000Z' },
            end: { dateTime: '2026-09-18T21:00:00.000Z' },
          },
        ],
      }),
    ).resolves.toEqual(['sent']);
    expect(lit.transport.sent[0]?.body).toContain(
      'Cartwheels Gym moved to Friday, Sep 18, 4:15-5:00 p.m. (was Thursday, Sep 17).',
    );
  });

  it('leaves a text it still owes exactly as it is when the flag goes off', async () => {
    // A hold outstanding when F14 goes dark ages out at CALENDAR_ALERT_PENDING_MAX_DAYS
    // like any other — it is not sent late, and it is not silently cancelled by a dark
    // sweep writing over the row that records it.
    await expect(
      sweep(harness({ verdict: { allowed: false, reason: 'quiet_hours' } })),
    ).resolves.toEqual(['gate_refused:quiet_hours']);
    const owed = await snapshotOf(TIMED.eventId);

    vi.stubEnv('F14_ENABLED', 'false');
    await expect(
      sweep(harness(), {
        changes: [
          {
            ...TIMED,
            updated: '2026-09-17T14:58:00.000Z',
            start: { dateTime: '2026-09-18T20:15:00.000Z' },
            end: { dateTime: '2026-09-18T21:00:00.000Z' },
          },
        ],
      }),
    ).resolves.toEqual(['dark']);

    expect(await snapshotOf(TIMED.eventId)).toMatchObject({
      pendingSince: owed?.pendingSince,
      startAt: owed?.startAt,
      heldTitle: 'Cartwheels Gym',
    });
  });

  it('alerts NOTHING on a seeding run — a fresh connection is not 200 texts', async () => {
    const h = harness();
    await expect(
      sweep(h, { seeding: true, changes: [TIMED, { ...TIMED, eventId: 'ev-2' }] }),
    ).resolves.toEqual(['seeding_run', 'seeding_run']);
    expect(h.transport.sent).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
  });

  it('REMEMBERS the whole calendar while it seeds, so the first edit to it is a move', async () => {
    // The seeding run is the only sighting Hale ever gets of an event the parent set up
    // before connecting, and there are two hundred of them. A run that alerted nobody and
    // remembered nobody would make the next edit to any of them read as a first
    // sighting — which is follow-up (a) again, for every event that pre-dates the
    // connection and for everything after a 410 full resync.
    const seeded = harness();
    await expect(sweep(seeded, { seeding: true })).resolves.toEqual(['seeding_run']);
    expect(await snapshotOf(TIMED.eventId)).toMatchObject({
      startAt: new Date('2026-09-17T20:15:00.000Z'),
      allDay: false,
      status: 'confirmed',
      // Nothing is owed, so nothing of the parent's is kept (rule #1).
      pendingSince: null,
      heldTitle: null,
      heldLocation: null,
    });

    const moved = harness();
    await expect(
      sweep(moved, {
        changes: [
          {
            ...TIMED,
            updated: '2026-09-17T14:58:00.000Z',
            start: { dateTime: '2026-09-18T20:15:00.000Z' },
            end: { dateTime: '2026-09-18T21:00:00.000Z' },
          },
        ],
      }),
    ).resolves.toEqual(['sent']);
    expect(moved.transport.sent[0]?.body).toContain(
      'Cartwheels Gym moved to Friday, Sep 18, 4:15-5:00 p.m. (was Thursday, Sep 17).',
    );
  });

  it('a calendar with no connecting user has nobody to text, and says so', async () => {
    const h = harness();
    await expect(sweep(h, { parentUserId: null })).resolves.toEqual(['no_parent_user']);
    expect(h.transport.sent).toEqual([]);
  });

  it('stays quiet about a date 40 days out and about a cancellation already past', async () => {
    const h = harness();
    const far: CalendarChange = {
      ...TIMED,
      eventId: 'ev-far',
      start: { dateTime: '2026-10-27T20:15:00.000Z' },
      end: { dateTime: '2026-10-27T21:00:00.000Z' },
    };
    const pastCancel: CalendarChange = {
      ...TIMED,
      eventId: 'ev-gone',
      status: 'cancelled',
      start: { dateTime: '2026-09-10T20:15:00.000Z' },
      end: { dateTime: '2026-09-10T21:00:00.000Z' },
    };

    await expect(sweep(h, { changes: [far, pastCancel] })).resolves.toEqual([
      'outside_window',
      'outside_window',
    ]);
    expect(h.transport.sent).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
  });

  it('DOES text about a cancellation still in the future, however far out', async () => {
    // The positive control for the two refusals above: without it, a window check that
    // refused everything would pass that test.
    const h = harness();
    await expect(
      sweep(h, {
        changes: [
          {
            ...TIMED,
            eventId: 'ev-march',
            status: 'cancelled',
            start: { dateTime: '2027-03-04T20:15:00.000Z' },
            end: { dateTime: '2027-03-04T21:00:00.000Z' },
          },
        ],
      }),
    ).resolves.toEqual(['sent']);
  });

  it('still texts about an all-day event added for TODAY at nine at night', async () => {
    // The parent's day, not UTC's. At 9 p.m. in Toronto it is already tomorrow in UTC, so
    // an all-day span anchored there is OVER — and tomorrow's PA day, added tonight, is
    // the single most ordinary thing this feature exists to say.
    const h = harness();
    const lateEvening = new Date('2026-09-18T01:00:00.000Z'); // Sep 17, 9 p.m. Toronto
    const allDay = (date: string, end: string): CalendarChange => ({
      ...TIMED,
      eventId: `ev-${date}`,
      title: 'PA day',
      start: { date },
      end: { date: end },
    });

    await expect(
      sweep(h, { now: lateEvening, changes: [allDay('2026-09-17', '2026-09-18')] }),
    ).resolves.toEqual(['sent']);
    expect(h.transport.sent[0]?.body).toContain('PA day is on your calendar for Thursday, Sep 17.');

    // The control for it: YESTERDAY's all-day is over in the parent's zone too, so this
    // is a day boundary moving, not a window that stopped refusing anything.
    const past = harness();
    await expect(
      sweep(past, { now: lateEvening, changes: [allDay('2026-09-16', '2026-09-17')] }),
    ).resolves.toEqual(['outside_window']);
  });

  it('texts about a cancelled recurring instance, which carries a start and nothing else', async () => {
    // The shape Google actually sends for "Friday's class is off": id + recurringEventId +
    // originalStartTime + status, mapped to a start with no summary and no location. The
    // master's title is not in the response to borrow, so the sentence says what it knows.
    const h = harness();
    const instance: CalendarChange = {
      eventId: 'ev-cartwheels_20260919T001500Z',
      // No `updated` on the wire either — the sync keyed this one on the item's etag.
      updated: '"3181161784712000"',
      status: 'cancelled',
      start: { dateTime: '2026-09-18T20:15:00.000Z' },
      end: { dateTime: '2026-09-18T20:15:00.000Z' },
    };

    await expect(sweep(h, { changes: [instance] })).resolves.toEqual(['sent']);
    expect(h.transport.sent[0]?.body).toContain('An event on Friday, Sep 18 was cancelled.');
    // The etag keys the row like any other stamp: the same instance read twice is one text.
    await expect(sweep(harness(), { changes: [instance] })).resolves.toEqual(['already_sent']);
  });

  it('spends nothing on a sweep with no changes at all, not even the clock read', async () => {
    const h = harness();
    await expect(sweep(h, { changes: [] })).resolves.toEqual([]);
    expect(h.timeZoneReads).toEqual([]);
    // The positive control: the SAME harness reads the clock the moment there is one
    // change, so the assertion above is about the empty list and not about the fake.
    await expect(sweep(h)).resolves.toEqual(['sent']);
    expect(h.timeZoneReads).toEqual([family.parentUserId]);
  });

  it('names a deleted single event Google sent with no start rather than counting it as far away', async () => {
    // A deleted SINGLE event is the one tombstone with nothing to place: id + status and
    // no originalStartTime either. "We cannot place this in time" is a different fact from
    // "this is in 40 days", and a sweep that says the second is a sweep nobody can diagnose.
    const h = harness();
    await expect(
      sweep(h, {
        changes: [{ ...TIMED, eventId: 'ev-bare', status: 'cancelled', start: {}, end: {} }],
      }),
    ).resolves.toEqual(['no_start']);
    await expect(ledgerRows()).resolves.toEqual([]);
  });

  it('re-alerts when the event MOVES, and stays quiet on a no-op re-sync', async () => {
    // The dedupe key carries Google's own `updated` stamp: the same change seen twice
    // costs nothing, and a real edit is a new key.
    await expect(sweep(harness())).resolves.toEqual(['sent']);
    await expect(sweep(harness())).resolves.toEqual(['already_sent']);

    const moved: CalendarChange = {
      ...TIMED,
      updated: '2026-09-17T14:58:00.000Z',
      start: { dateTime: '2026-09-17T21:15:00.000Z' },
      end: { dateTime: '2026-09-17T22:00:00.000Z' },
    };
    const second = harness();
    await expect(sweep(second, { changes: [moved] })).resolves.toEqual(['sent']);
    expect(second.transport.sent[0]?.body).toContain('5:15-6:00 p.m.');
    await expect(ledgerRows()).resolves.toHaveLength(2);
  });

  it('a DIFFERENT event on the same calendar is still alerted', async () => {
    // Kills the mutation that drops the WHERE clause from the dedupe read.
    await expect(sweep(harness())).resolves.toEqual(['sent']);
    await expect(sweep(harness(), { changes: [{ ...TIMED, eventId: 'ev-2' }] })).resolves.toEqual([
      'sent',
    ]);
    await expect(ledgerRows()).resolves.toHaveLength(2);
  });

  it('a quiet-hours hold leaves a RECEIPT and spends nothing', async () => {
    const held = harness({ verdict: { allowed: false, reason: 'quiet_hours' } });
    await expect(sweep(held)).resolves.toEqual(['gate_refused:quiet_hours']);
    expect(held.transport.sent).toEqual([]);

    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: 'calendar_alert',
      direction: 'out',
      templateKey: CALENDAR_ALERT_TEMPLATE_KEY,
      status: 'suppressed_quiet_hours',
      // NEVER the key: the unique index is total over non-null keys, so a suppression
      // carrying it would block the very send it is a record of not making.
      dedupeKey: null,
      providerMessageId: null,
      body: null,
    });
    await expect(auditRows()).resolves.toEqual([]);

    const later = harness();
    await expect(sweep(later)).resolves.toEqual(['sent']);
    expect(later.transport.sent).toHaveLength(1);
  });

  it('names each gate hold separately and records it under its own suppression status', async () => {
    for (const reason of ['not_enrolled', 'no_watch_consent', 'frequency_cap'] as const) {
      await expect(sweep(harness({ verdict: { allowed: false, reason } }))).resolves.toEqual([
        `gate_refused:${reason}`,
      ]);
    }
    const rows = await ledgerRows();
    expect(rows.map((r) => r.status).sort()).toEqual([
      'suppressed_cap',
      'suppressed_consent',
      'suppressed_consent',
    ]);
    expect(rows.map((r) => r.dedupeKey)).toEqual([null, null, null]);
  });

  it('a provider refusal fails the claimed row in place and keeps the key spent', async () => {
    const h = harness({ sendThrows: new TwilioSendError('21610', 400) });
    await expect(sweep(h)).resolves.toEqual(['send_failed']);

    const rows = await ledgerRows();
    expect(rows[0]).toMatchObject({ status: 'failed', errorCode: '21610' });
    // At-most-once: a failed delivery must never un-consume idempotency.
    await expect(sweep(harness())).resolves.toEqual(['already_sent']);
    await expect(auditRows()).resolves.toEqual([]);
  });

  it('an allowed verdict with no sendable number is recorded, not thrown', async () => {
    const h = harness({ phone: null });
    await expect(sweep(h)).resolves.toEqual(['no_send_target']);
    const rows = await ledgerRows();
    expect(rows[0]).toMatchObject({ status: 'failed', errorCode: 'no_send_target' });
  });

  it('reads at most CALENDAR_ALERT_MAX_PER_SWEEP, SOONEST first, and names the rest', async () => {
    const h = harness();
    // Seven events on seven consecutive days; the two LATEST must be the ones dropped.
    const changes = Array.from({ length: 7 }, (_, i) => ({
      ...TIMED,
      eventId: `ev-${i}`,
      start: { dateTime: `2026-09-${String(18 + i).padStart(2, '0')}T20:15:00.000Z` },
      end: { dateTime: `2026-09-${String(18 + i).padStart(2, '0')}T21:00:00.000Z` },
    }));

    const outcomes = await sweep(h, { changes });

    // One outcome per change, positionally — the two dropped are the two LAST, which is
    // only visible because the answer is in input order.
    expect(outcomes).toEqual([
      ...Array.from({ length: CALENDAR_ALERT_MAX_PER_SWEEP }, () => 'sent'),
      'over_sweep_cap',
      'over_sweep_cap',
    ]);
    const keys = new Set((await ledgerRows()).map((r) => r.dedupeKey));
    expect(keys.has(calendarAlertDedupeKey(INTEGRATION, 'ev-0', TIMED.updated))).toBe(true);
    expect(keys.has(calendarAlertDedupeKey(INTEGRATION, 'ev-6', TIMED.updated))).toBe(false);
  });

  it('never lets stale edits to events already OVER spend the sweep', async () => {
    // The shape that made this real: with singleEvents=true, renaming a weekly class
    // returns every instance of the series with a fresh `updated`, the past ones
    // included. Capped before the window is judged — and sorted soonest-first, which puts
    // the finished ones at the front — five September Tuesdays that already happened take
    // all five slots, and tomorrow's class is never offered again, because syncCalendar
    // advanced the syncToken the moment it read the page.
    const h = harness();
    const stale = Array.from({ length: CALENDAR_ALERT_MAX_PER_SWEEP }, (_, i) => ({
      ...TIMED,
      eventId: `ev-past-${i}`,
      start: { dateTime: `2026-09-0${i + 1}T20:15:00.000Z` },
      end: { dateTime: `2026-09-0${i + 1}T21:00:00.000Z` },
    }));
    const tomorrow: CalendarChange = {
      ...TIMED,
      eventId: 'ev-tomorrow',
      start: { dateTime: '2026-09-18T20:15:00.000Z' },
      end: { dateTime: '2026-09-18T21:00:00.000Z' },
    };

    await expect(sweep(h, { changes: [...stale, tomorrow] })).resolves.toEqual([
      ...stale.map(() => 'outside_window'),
      'sent',
    ]);
    expect(h.transport.sent).toHaveLength(1);
    expect(h.transport.sent[0]?.body).toContain('Friday, Sep 18');
  });

  it('answers one outcome per change, in the order the changes arrived', async () => {
    const h = harness();
    const far: CalendarChange = {
      ...TIMED,
      eventId: 'ev-far',
      start: { dateTime: '2026-10-27T20:15:00.000Z' },
      end: { dateTime: '2026-10-27T21:00:00.000Z' },
    };
    const tombstone: CalendarChange = {
      ...TIMED,
      eventId: 'ev-bare',
      status: 'cancelled',
      start: {},
      end: {},
    };

    await expect(sweep(h, { changes: [far, TIMED, tombstone] })).resolves.toEqual([
      'outside_window',
      'sent',
      'no_start',
    ]);
  });

  it('carries the title and the time and NOTHING else off the event', async () => {
    // Rule #1 with a positive control: the title MUST be there, so the three
    // `not.toContain`s cannot pass on an empty body.
    const h = harness();
    await sweep(h, {
      changes: [
        {
          ...TIMED,
          description: 'Bring Leo. Questions to coach@cartwheels.example',
          location: 'Stouffville Leisure Centre',
          attendees: ['parent@example.test'],
        } as CalendarChange & { description: string; attendees: string[] },
      ],
    });

    for (const body of [h.transport.sent[0]?.body, h.threaded[0]?.body]) {
      expect(body).toContain('Cartwheels Gym');
      expect(body).toContain('Stouffville Leisure Centre');
      expect(body).not.toContain('Bring Leo');
      expect(body).not.toContain('@');
    }
  });
});

describe('a change that MOVED says so', () => {
  /** Tuesday Sep 15, 11 a.m. Toronto — both Sep 16 and Sep 17 are still ahead of it. */
  const EARLY = new Date('2026-09-15T15:00:00.000Z');
  const wednesday: CalendarChange = {
    ...TIMED,
    updated: '2026-09-15T14:00:00.000Z',
    start: { dateTime: '2026-09-16T20:15:00.000Z' },
    end: { dateTime: '2026-09-16T21:00:00.000Z' },
  };

  it('names the new time AND the old one, once it has seen the event before', async () => {
    await expect(sweep(harness(), { now: EARLY, changes: [wednesday] })).resolves.toEqual(['sent']);

    const moved = harness();
    await expect(
      sweep(moved, {
        now: EARLY,
        changes: [
          {
            ...wednesday,
            updated: '2026-09-15T14:30:00.000Z',
            start: { dateTime: '2026-09-17T20:15:00.000Z' },
            end: { dateTime: '2026-09-17T21:00:00.000Z' },
          },
        ],
      }),
    ).resolves.toEqual(['sent']);
    expect(moved.transport.sent[0]?.body).toContain(
      'Cartwheels Gym moved to Thursday, Sep 17, 4:15-5:00 p.m. (was Wednesday, Sep 16).',
    );
  });

  it('says the clock twice, not the date twice, when only the time moved', async () => {
    await expect(sweep(harness())).resolves.toEqual(['sent']);

    const moved = harness();
    await expect(
      sweep(moved, {
        changes: [
          {
            ...TIMED,
            updated: '2026-09-17T14:58:00.000Z',
            start: { dateTime: '2026-09-17T21:00:00.000Z' },
            end: { dateTime: '2026-09-17T21:45:00.000Z' },
          },
        ],
      }),
    ).resolves.toEqual(['sent']);
    expect(moved.transport.sent[0]?.body).toContain(
      'Cartwheels Gym moved to 5:00-5:45 p.m. today (was 4:15).',
    );
  });

  it('says what changed when an event gains a clock, and when it loses one', async () => {
    // The day did not move, so the day is not the news — and "PA day moved to Friday,
    // Sep 18 (was Friday, Sep 18)" says the one thing that stayed the same, twice.
    const paDay: CalendarChange = {
      ...TIMED,
      eventId: 'ev-pa',
      title: 'PA day',
      start: { date: '2026-09-18' },
      end: { date: '2026-09-19' },
    };
    await expect(sweep(harness(), { changes: [paDay] })).resolves.toEqual(['sent']);

    const timed = harness();
    await expect(
      sweep(timed, {
        changes: [
          {
            ...paDay,
            updated: '2026-09-17T14:58:00.000Z',
            start: { dateTime: '2026-09-18T13:00:00.000Z' },
            end: { dateTime: '2026-09-18T14:00:00.000Z' },
          },
        ],
      }),
    ).resolves.toEqual(['sent']);
    expect(timed.transport.sent[0]?.body).toContain(
      'PA day moved to 9:00-10:00 a.m. on Friday, Sep 18 (was all day).',
    );

    const back = harness();
    await expect(
      sweep(back, { changes: [{ ...paDay, updated: '2026-09-17T14:59:00.000Z' }] }),
    ).resolves.toEqual(['sent']);
    expect(back.transport.sent[0]?.body).toContain(
      'PA day is now all day on Friday, Sep 18 (was 9:00 a.m.).',
    );
  });

  it('a FIRST sighting is not a move, and a cancellation is never one', async () => {
    // The control for both cases above: without it a renderer that always says "moved"
    // would pass them. And a cancellation Hale has seen before still reads as a
    // cancellation — "(was Thursday)" on top of it is a fact nobody asked about.
    const first = harness();
    await expect(sweep(first)).resolves.toEqual(['sent']);
    expect(first.transport.sent[0]?.body).toContain(
      'Cartwheels Gym is on your calendar for Thursday, Sep 17, 4:15-5:00 p.m.',
    );

    const cancelled = harness();
    await expect(
      sweep(cancelled, {
        changes: [
          {
            ...TIMED,
            updated: '2026-09-17T14:59:00.000Z',
            status: 'cancelled',
            start: { dateTime: '2026-09-18T20:15:00.000Z' },
            end: { dateTime: '2026-09-18T21:00:00.000Z' },
          },
        ],
      }),
    ).resolves.toEqual(['sent']);
    expect(cancelled.transport.sent[0]?.body).toContain(
      'Cartwheels Gym on Friday, Sep 18 was cancelled.',
    );
    expect(cancelled.transport.sent[0]?.body).not.toContain('was Thursday');
  });
});

describe('one edit to a series is one text', () => {
  const SERIES = 'swim-master';
  /** Six Tuesdays at 5:00-5:45 p.m. Toronto from Sep 22 — the shape `singleEvents=true`
   * turns one edit to a weekly class into. */
  function instances(over: Partial<CalendarChange> = {}): CalendarChange[] {
    return Array.from({ length: 6 }, (_, i) => ({
      ...TIMED,
      eventId: `swim-${i}`,
      recurringEventId: SERIES,
      title: 'Swim lessons',
      updated: '2026-09-17T14:55:00.000Z',
      start: { dateTime: `2026-${i < 2 ? '09' : '10'}-${String(i < 2 ? 22 + i * 7 : i * 7 - 8).padStart(2, '0')}T21:00:00.000Z` },
      end: { dateTime: `2026-${i < 2 ? '09' : '10'}-${String(i < 2 ? 22 + i * 7 : i * 7 - 8).padStart(2, '0')}T21:45:00.000Z` },
      ...over,
    }));
  }

  it('sends ONE text for six moved instances and names the other five as collapsed', async () => {
    // Every instance is seen once at its old hour, so the second sweep is a real move.
    const before = instances({ updated: '2026-09-17T14:00:00.000Z' }).map((one) => ({
      ...one,
      start: { dateTime: one.start.dateTime?.replace('T21:00', 'T20:15') },
      end: { dateTime: one.end.dateTime?.replace('T21:45', 'T21:00') },
    }));
    await sweep(harness(), { changes: before });

    const h = harness();
    await expect(sweep(h, { changes: instances() })).resolves.toEqual([
      'sent',
      ...Array.from({ length: 5 }, () => 'collapsed_into_series'),
    ]);
    expect(h.transport.sent).toHaveLength(1);
    expect(h.transport.sent[0]?.body).toContain(
      'Swim lessons moved: 6 sessions now Tuesdays 5:00-5:45 p.m. starting Sep 22.',
    );
    // ONE claim for the whole series, keyed on the series and its stamp — so the same six
    // instances read a second time cost nothing.
    const keys = (await ledgerRows()).map((row) => row.dedupeKey);
    expect(keys).toEqual([
      calendarSeriesAlertDedupeKey(INTEGRATION, SERIES, 'live', '2026-09-17T14:00:00.000Z'),
      calendarSeriesAlertDedupeKey(INTEGRATION, SERIES, 'live', instances()[0]!.updated),
    ]);
    await expect(sweep(harness(), { changes: instances() })).resolves.toEqual([
      'already_sent',
      ...Array.from({ length: 5 }, () => 'collapsed_into_series'),
    ]);
  });

  it('never lets a CANCELLED instance ride along inside a live series sentence', async () => {
    // The one collapse that would be a lie. Five instances of a class were moved and the
    // sixth was called off; grouped on the series alone they become "6 sessions now
    // Tuesdays", which tells the parent the cancelled Tuesday is still on. The news is
    // (series, cancelled-or-not), so the batch is two texts: the live five, and the one
    // that is off.
    const live = instances().slice(0, 5);
    const gone: CalendarChange = {
      ...instances()[5]!,
      // The shape Google actually sends for a cancelled instance: no summary, and the
      // sync's etag fallback in place of an `updated` stamp.
      status: 'cancelled',
      title: undefined,
      updated: '"3181161784712000"',
    };

    const h = harness();
    await expect(sweep(h, { changes: [...live, gone] })).resolves.toEqual([
      'sent',
      ...Array.from({ length: 4 }, () => 'collapsed_into_series'),
      'sent',
    ]);

    expect(h.transport.sent.map((one) => one.body.split('\n')[0])).toEqual([
      'Swim lessons: 5 sessions on your calendar, Tuesdays 5:00-5:45 p.m. starting Sep 22.',
      'An event on Tuesday, Oct 27 was cancelled.',
    ]);
    // Two texts, two keys — the cancellation is not the series text's twin, so it may not
    // be swallowed as a duplicate of it.
    const keys = (await ledgerRows()).map((row) => row.dedupeKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toContain(calendarAlertDedupeKey(INTEGRATION, gone.eventId, gone.updated));
  });

  it('sends BOTH halves when one term is rescheduled and two of its sessions are called off', async () => {
    // The same series, the same latest stamp, two different pieces of news — which is what
    // one save in Google Calendar looks like when the sync has no `updated` to tell the
    // items apart. A key that did not carry the kind would make whichever text went second
    // a duplicate of the first, and the parent would hear one of the two.
    const live = instances().slice(0, 4);
    const gone = instances()
      .slice(4)
      .map((one) => ({ ...one, status: 'cancelled' as const }));

    const h = harness();
    await expect(sweep(h, { changes: [...live, ...gone] })).resolves.toEqual([
      'sent',
      ...Array.from({ length: 3 }, () => 'collapsed_into_series'),
      'sent',
      'collapsed_into_series',
    ]);
    expect(h.transport.sent.map((one) => one.body.split('\n')[0])).toEqual([
      'Swim lessons: 4 sessions on your calendar, Tuesdays 5:00-5:45 p.m. starting Sep 22.',
      'Swim lessons: 2 sessions were cancelled from Oct 20.',
    ]);
    expect(new Set((await ledgerRows()).map((row) => row.dedupeKey)).size).toBe(2);
  });

  it('keeps two DIFFERENT series in one sweep as two texts', async () => {
    // Kills the grouping that buckets every recurring instance into one group: nine
    // changes about two classes are two things to say, not "9 sessions" of a term that
    // does not exist.
    const art = instances()
      .slice(0, 3)
      .map((one) => ({
        ...one,
        eventId: `art-${one.eventId}`,
        recurringEventId: 'art-master',
        title: 'Art club',
        start: { dateTime: one.start.dateTime?.replace('T21:00', 'T22:00') },
        end: { dateTime: one.end.dateTime?.replace('T21:45', 'T22:45') },
      }));

    const h = harness();
    await expect(sweep(h, { changes: [...instances(), ...art] })).resolves.toEqual([
      'sent',
      ...Array.from({ length: 5 }, () => 'collapsed_into_series'),
      'sent',
      'collapsed_into_series',
      'collapsed_into_series',
    ]);
    expect(h.transport.sent.map((one) => one.body.split('\n')[0])).toEqual([
      'Swim lessons: 6 sessions on your calendar, Tuesdays 5:00-5:45 p.m. starting Sep 22.',
      'Art club: 3 sessions on your calendar, Tuesdays 6:00-6:45 p.m. starting Sep 22.',
    ]);
  });

  it('refuses to claim a weekday and a clock the instances do not actually share', async () => {
    // "Tuesdays 5:00-5:45 p.m." is a pattern, and a pattern that is not there is the one
    // thing this sentence must not invent. Two shapes of scatter, one per claim: the
    // weekday moves with the clock held, then the clock moves with the weekday held —
    // either one alone would be caught by the other's check and prove nothing.
    const scattered = harness();
    await sweep(scattered, {
      changes: [
        instances()[0]!,
        {
          ...instances()[1]!,
          start: { dateTime: '2026-09-24T21:00:00.000Z' }, // Thursday, same 5 p.m.
          end: { dateTime: '2026-09-24T21:45:00.000Z' },
        },
      ],
    });
    expect(scattered.transport.sent[0]?.body).toContain(
      'Swim lessons: 2 sessions on your calendar, the first on Tuesday, Sep 22, 5:00-5:45 p.m.',
    );
    expect(scattered.transport.sent[0]?.body).not.toContain('Tuesdays');

    // Same weekday, different hour: still not a pattern anyone could plan against.
    const offHour = harness();
    await sweep(offHour, {
      changes: [
        { ...instances()[0]!, eventId: 'hour-0', recurringEventId: 'hour-master' },
        {
          ...instances()[1]!,
          eventId: 'hour-1',
          recurringEventId: 'hour-master',
          start: { dateTime: '2026-09-29T22:00:00.000Z' }, // Tuesday, but 6 p.m.
          end: { dateTime: '2026-09-29T22:45:00.000Z' },
        },
      ],
    });
    expect(offHour.transport.sent[0]?.body).toContain(
      'Swim lessons: 2 sessions on your calendar, the first on Tuesday, Sep 22, 5:00-5:45 p.m.',
    );
    expect(offHour.transport.sent[0]?.body).not.toContain('Tuesdays');
  });

  it('says a cancelled term is cancelled, and names an unnamed one honestly', async () => {
    const h = harness();
    await expect(
      sweep(h, { changes: instances({ status: 'cancelled' }) }),
    ).resolves.toHaveLength(6);
    expect(h.transport.sent[0]?.body).toContain(
      'Swim lessons: 6 sessions were cancelled from Sep 22.',
    );
    // Under the CANCELLED key: a term called off and a term rescheduled are two texts, so
    // one key over both would let the second read as a duplicate of the first.
    expect((await ledgerRows())[0]?.dedupeKey).toBe(
      calendarSeriesAlertDedupeKey(INTEGRATION, SERIES, 'cancelled', instances()[0]!.updated),
    );

    // Google's cancelled instances usually carry no summary at all, and "An event: 6
    // sessions" is a disagreement inside one sentence.
    const bare = harness();
    await sweep(bare, {
      changes: instances({ status: 'cancelled', title: undefined }).map((one) => ({
        ...one,
        eventId: `bare-${one.eventId}`,
        recurringEventId: 'bare-master',
      })),
    });
    expect(bare.transport.sent[0]?.body).toContain(
      'A repeating event: 6 sessions were cancelled from Sep 22.',
    );
  });

  it('counts the sessions still AHEAD, never the ones already behind', async () => {
    // The whole reason the fortnight is judged on the group and the past is judged per
    // instance. Renaming a weekly class returns the finished Tuesdays too, and "8 sessions
    // now Tuesdays" describes a term nobody is going to.
    const past = Array.from({ length: 2 }, (_, i) => ({
      ...TIMED,
      eventId: `swim-past-${i}`,
      recurringEventId: SERIES,
      title: 'Swim lessons',
      start: { dateTime: `2026-09-0${i + 1}T21:00:00.000Z` },
      end: { dateTime: `2026-09-0${i + 1}T21:45:00.000Z` },
    }));

    const h = harness();
    await expect(sweep(h, { changes: [...past, ...instances()] })).resolves.toEqual([
      'outside_window',
      'outside_window',
      'sent',
      ...Array.from({ length: 5 }, () => 'collapsed_into_series'),
    ]);
    expect(h.transport.sent[0]?.body).toContain('6 sessions');
  });

  it('holds two GSM-7 segments with the FULL opt-out, however long the class is called', async () => {
    // The series sentence has its own widest shape — a count, a weekday, a clock range and
    // a starting date on top of the clamped title — so the budget the singles' property
    // test proves does not carry over to it for free.
    const nasty = 'Registration — 秋の遠足 '.repeat(30);
    const h = harness();
    await sweep(h, { changes: instances({ title: nasty }) });
    const body = h.transport.sent[0]?.body ?? '';
    expect(body).not.toBe('');
    expect(isPrintableGsm7Basic(body.replace(`\n\n${OPT_OUT_LINE}`, ''))).toBe(true);
    expect(smsSegments(body)).toBeLessThanOrEqual(2);
  });

  it('collapses TWO instances of one series into one text, and leaves ONE alone', async () => {
    // The floor is SERIES_MIN_INSTANCES = 2: a second change about the same class in one
    // sweep is the same news said twice, and one text costs one of the five slots instead
    // of two. A lone instance is below the floor and stays an ordinary single — which is
    // what a cancelled Tuesday inside a live term reduces to.
    const h = harness();
    const pair = instances().slice(0, 2);
    await expect(sweep(h, { changes: pair })).resolves.toEqual(['sent', 'collapsed_into_series']);
    expect(h.transport.sent[0]?.body).toContain('2 sessions');

    const alone = harness();
    await expect(
      sweep(alone, { changes: [{ ...instances()[0]!, eventId: 'lone-instance' }] }),
    ).resolves.toEqual(['sent']);
    expect(alone.transport.sent[0]?.body).toContain(
      'Swim lessons is on your calendar for Tuesday, Sep 22, 5:00-5:45 p.m.',
    );
  });

  it('spends ONE of the five per-sweep slots on a whole series', async () => {
    // Before the collapse, one edit to a weekly class spent the entire budget on itself
    // and everything else that sweep went unsaid for good.
    const h = harness();
    const others = Array.from({ length: 4 }, (_, i) => ({
      ...TIMED,
      eventId: `other-${i}`,
      updated: '2026-09-17T14:55:00.000Z',
      start: { dateTime: `2026-09-${18 + i}T18:00:00.000Z` },
      end: { dateTime: `2026-09-${18 + i}T19:00:00.000Z` },
    }));
    const outcomes = await sweep(h, { changes: [...instances(), ...others] });
    expect(outcomes.filter((one) => one === 'sent')).toHaveLength(5);
    expect(outcomes.filter((one) => one === 'over_sweep_cap')).toEqual([]);
    expect(h.transport.sent).toHaveLength(5);
  });
});

describe('a change the gate held is offered again', () => {
  it('keeps a quiet-hours hold and sends it on a later sweep with no new Google change', async () => {
    const held = harness({ verdict: { allowed: false, reason: 'quiet_hours' } });
    await expect(sweep(held)).resolves.toEqual(['gate_refused:quiet_hours']);

    const pending = await snapshotOf(TIMED.eventId);
    expect(pending?.pendingSince).toBeInstanceOf(Date);
    expect(pending?.heldTitle).toBe('Cartwheels Gym');

    // Daylight, and Google has nothing new to say — the sweep's own memory is the only
    // thing that can produce this text.
    const daylight = harness();
    const later = await sweepBoth(daylight, { changes: [], now: new Date('2026-09-17T16:00:00.000Z') });
    expect(later).toEqual({ changes: [], reoffers: ['sent'] });
    expect(daylight.transport.sent).toHaveLength(1);
    expect(daylight.transport.sent[0]?.body).toContain(
      'Cartwheels Gym is on your calendar for Thursday, Sep 17, 4:15-5:00 p.m.',
    );

    // The debt is settled: the hold is cleared and the parent's words are gone with it.
    const settled = await snapshotOf(TIMED.eventId);
    expect(settled?.pendingSince).toBeNull();
    expect(settled?.heldTitle).toBeNull();
    expect(settled?.heldLocation).toBeNull();
  });

  it('re-offers a held MOVE as a move, not as a bare "is on your calendar"', async () => {
    const EARLY = new Date('2026-09-15T15:00:00.000Z');
    const wednesday: CalendarChange = {
      ...TIMED,
      updated: '2026-09-15T14:00:00.000Z',
      start: { dateTime: '2026-09-16T20:15:00.000Z' },
      end: { dateTime: '2026-09-16T21:00:00.000Z' },
    };
    await sweep(harness(), { now: EARLY, changes: [wednesday] });
    await expect(
      sweep(harness({ verdict: { allowed: false, reason: 'quiet_hours' } }), {
        now: EARLY,
        changes: [
          {
            ...wednesday,
            updated: '2026-09-15T14:30:00.000Z',
            start: { dateTime: '2026-09-17T20:15:00.000Z' },
            end: { dateTime: '2026-09-17T21:00:00.000Z' },
          },
        ],
      }),
    ).resolves.toEqual(['gate_refused:quiet_hours']);

    const daylight = harness();
    const later = await sweepBoth(daylight, {
      changes: [],
      now: new Date('2026-09-15T16:00:00.000Z'),
    });
    expect(later.reoffers).toEqual(['sent']);
    expect(daylight.transport.sent[0]?.body).toContain(
      'Cartwheels Gym moved to Thursday, Sep 17, 4:15-5:00 p.m. (was Wednesday, Sep 16).',
    );
  });

  it('re-offers a held SHAPE change as the shape change it was, not as an invented clock', async () => {
    // The worst of the three all-day cases: the revived prior start took its all-day flag
    // from the row's CURRENT one, so a held "this is 9 a.m. now, it used to be all day"
    // came back out as "(was 12:00)" — a clock read off a local midnight that the calendar
    // never had.
    const paDay: CalendarChange = {
      ...TIMED,
      eventId: 'ev-pa',
      title: 'PA day',
      start: { date: '2026-09-18' },
      end: { date: '2026-09-19' },
    };
    await sweep(harness(), { changes: [paDay] });
    await expect(
      sweep(harness({ verdict: { allowed: false, reason: 'quiet_hours' } }), {
        changes: [
          {
            ...paDay,
            updated: '2026-09-17T14:58:00.000Z',
            start: { dateTime: '2026-09-18T13:00:00.000Z' },
            end: { dateTime: '2026-09-18T14:00:00.000Z' },
          },
        ],
      }),
    ).resolves.toEqual(['gate_refused:quiet_hours']);

    const daylight = harness();
    const later = await sweepBoth(daylight, {
      changes: [],
      now: new Date('2026-09-17T16:00:00.000Z'),
    });
    expect(later.reoffers).toEqual(['sent']);
    const body = daylight.transport.sent[0]?.body ?? '';
    expect(body).toContain('PA day moved to 9:00-10:00 a.m. on Friday, Sep 18 (was all day).');
    expect(body).not.toContain('12:00');
  });

  it('names the start the parent was TOLD when a second move lands before the hold clears', async () => {
    // While a text is owed the row's own start is the HELD one — true of the calendar and
    // never heard by anybody — so "(was Friday)" would name a Friday nobody was told about.
    await expect(sweep(harness())).resolves.toEqual(['sent']); // Thursday, 4:15 p.m.
    await expect(
      sweep(harness({ verdict: { allowed: false, reason: 'quiet_hours' } }), {
        changes: [
          {
            ...TIMED,
            updated: '2026-09-17T14:58:00.000Z',
            start: { dateTime: '2026-09-18T20:15:00.000Z' },
            end: { dateTime: '2026-09-18T21:00:00.000Z' },
          },
        ],
      }),
    ).resolves.toEqual(['gate_refused:quiet_hours']);

    const second = harness();
    await expect(
      sweep(second, {
        changes: [
          {
            ...TIMED,
            updated: '2026-09-17T14:59:00.000Z',
            start: { dateTime: '2026-09-19T20:15:00.000Z' },
            end: { dateTime: '2026-09-19T21:00:00.000Z' },
          },
        ],
      }),
    ).resolves.toEqual(['sent']);
    const body = second.transport.sent[0]?.body ?? '';
    expect(body).toContain(
      'Cartwheels Gym moved to Saturday, Sep 19, 4:15-5:00 p.m. (was Thursday, Sep 17).',
    );
    expect(body).not.toContain('Friday');
  });

  it('writes ONE receipt for a text it owes, however many sweeps refuse it again', async () => {
    const night = { verdict: { allowed: false, reason: 'quiet_hours' } } as const;
    await expect(sweep(harness(night))).resolves.toEqual(['gate_refused:quiet_hours']);
    const owedSince = (await snapshotOf(TIMED.eventId))?.pendingSince;

    for (const minutes of [15, 30]) {
      const again = await sweepBoth(harness(night), {
        changes: [],
        now: new Date(NOW.getTime() + minutes * 60_000),
      });
      expect(again.reoffers).toEqual(['gate_refused:quiet_hours']);
    }

    // One text owed, one receipt. At a 15-minute sweep the alternative is forty-odd
    // identical rows per held text per quiet-hours night, on the surface a parent reads.
    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'suppressed_quiet_hours', dedupeKey: null });
    // ...and the debt itself is untouched: the same instant, still owed.
    expect((await snapshotOf(TIMED.eventId))?.pendingSince).toEqual(owedSince);

    const daylight = harness();
    const paid = await sweepBoth(daylight, {
      changes: [],
      now: new Date(NOW.getTime() + 45 * 60_000),
    });
    expect(paid.reoffers).toEqual(['sent']);
  });

  /** A hold on an event far enough ahead that the AGE is the only thing that can end it.
   * `pending_outside_window` would otherwise fire first and prove nothing about expiry. */
  const AHEAD: CalendarChange = {
    ...TIMED,
    eventId: 'ev-ahead',
    start: { dateTime: '2026-09-25T20:15:00.000Z' },
    end: { dateTime: '2026-09-25T21:00:00.000Z' },
  };
  const afterDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000 + 60_000);

  it('gives up on a hold older than three days, by name', async () => {
    await expect(
      sweep(harness({ verdict: { allowed: false, reason: 'frequency_cap' } }), {
        changes: [AHEAD],
      }),
    ).resolves.toEqual(['gate_refused:frequency_cap']);

    const tooLate = harness();
    const past = await sweepBoth(tooLate, {
      changes: [],
      now: afterDays(CALENDAR_ALERT_PENDING_MAX_DAYS),
    });
    expect(past.reoffers).toEqual(['pending_expired']);
    expect(tooLate.transport.sent).toEqual([]);
    expect((await snapshotOf(AHEAD.eventId))?.pendingSince).toBeNull();
  });

  it('is still owed one day inside the limit — the control for the expiry above', async () => {
    await sweep(harness({ verdict: { allowed: false, reason: 'frequency_cap' } }), {
      changes: [AHEAD],
    });

    const inTime = harness();
    const owed = await sweepBoth(inTime, {
      changes: [],
      now: afterDays(CALENDAR_ALERT_PENDING_MAX_DAYS - 1),
    });
    expect(owed.reoffers).toEqual(['sent']);
    expect(inTime.transport.sent).toHaveLength(1);
  });

  it('drops a hold the calendar overtook, under its own name', async () => {
    await expect(
      sweep(harness({ verdict: { allowed: false, reason: 'quiet_hours' } })),
    ).resolves.toEqual(['gate_refused:quiet_hours']);

    const afterwards = harness();
    const later = await sweepBoth(afterwards, {
      changes: [],
      now: new Date('2026-09-17T22:00:00.000Z'), // 6 p.m. Toronto: the class is over
    });
    expect(later.reoffers).toEqual(['pending_outside_window']);
    expect(afterwards.transport.sent).toEqual([]);
  });

  it('puts the oldest debt first, and spends the SAME five slots on debts and new news', async () => {
    // Four debts, four fresh changes, five slots: the debts go first and one fresh change
    // is held over. A cap that counted them separately would send eight.
    for (let i = 0; i < 4; i += 1) {
      await sweep(harness({ verdict: { allowed: false, reason: 'quiet_hours' } }), {
        now: new Date(NOW.getTime() + i * 1000),
        changes: [
          {
            ...TIMED,
            eventId: `owed-${i}`,
            start: { dateTime: `2026-09-2${5 - i}T20:15:00.000Z` },
            end: { dateTime: `2026-09-2${5 - i}T21:00:00.000Z` },
          },
        ],
      });
    }

    const h = harness();
    const both = await sweepBoth(h, {
      changes: Array.from({ length: 4 }, (_, i) => ({
        ...TIMED,
        eventId: `new-${i}`,
        start: { dateTime: `2026-09-${18 + i}T18:00:00.000Z` },
        end: { dateTime: `2026-09-${18 + i}T19:00:00.000Z` },
      })),
    });

    expect(both.reoffers).toEqual(['sent', 'sent', 'sent', 'sent']);
    expect(both.changes).toEqual(['sent', 'over_sweep_cap', 'over_sweep_cap', 'over_sweep_cap']);
    expect(h.transport.sent).toHaveLength(5);
    // The debts were paid in the order they were owed, not soonest-event-first: owed-0 is
    // the LATEST event and still went first.
    expect(h.transport.sent[0]?.body).toContain('Friday, Sep 25');
    // ...and the three that lost the cap are owed now, so nothing was dropped.
    const carried = (await snapshotRows()).filter((row) => row.pendingSince !== null);
    expect(carried.map((row) => row.eventId).sort()).toEqual(['new-1', 'new-2', 'new-3']);
  });
});

describe('the memory itself', () => {
  it('writes a snapshot for every change it placed, whatever the ending', async () => {
    const far: CalendarChange = {
      ...TIMED,
      eventId: 'ev-far',
      start: { dateTime: '2026-10-27T20:15:00.000Z' },
      end: { dateTime: '2026-10-27T21:00:00.000Z' },
    };
    const bare: CalendarChange = { ...TIMED, eventId: 'ev-bare', start: {}, end: {} };

    await expect(sweep(harness(), { changes: [TIMED, far, bare] })).resolves.toEqual([
      'sent',
      'outside_window',
      'no_start',
    ]);

    const rows = await snapshotRows();
    expect(rows.map((row) => row.eventId).sort()).toEqual([TIMED.eventId, 'ev-far'].sort());
    expect(await snapshotOf(TIMED.eventId)).toMatchObject({
      startAt: new Date('2026-09-17T20:15:00.000Z'),
      endAt: new Date('2026-09-17T21:00:00.000Z'),
      allDay: false,
      updatedStamp: TIMED.updated,
      status: 'confirmed',
      pendingSince: null,
      // Rule #1: a sent text owes nothing, so the parent's words are not kept.
      heldTitle: null,
      heldLocation: null,
    });
  });

  it("keeps the parent's words ONLY while a text is owed, and only the words it would say", async () => {
    // The same positive control the body test carries, against the memory: a description
    // written here is a description one re-offer away from being on a wire, and `toBe`
    // rather than `toMatchObject` is what makes that a test rather than a hope.
    await sweep(harness({ verdict: { allowed: false, reason: 'quiet_hours' } }), {
      changes: [
        {
          ...TIMED,
          location: 'Stouffville Leisure Centre',
          description: 'Bring Leo. Questions to coach@cartwheels.example',
          attendees: ['parent@example.test'],
        } as CalendarChange & { description: string; attendees: string[] },
      ],
    });
    const held = await snapshotOf(TIMED.eventId);
    expect(held?.heldTitle).toBe('Cartwheels Gym');
    expect(held?.heldLocation).toBe('Stouffville Leisure Centre');
  });

  it('a full resync re-reads the calendar without dropping a text it still owes', async () => {
    // Google forces a seeding run whenever the syncToken goes stale, and a seeding write
    // that clobbered the pending columns would cancel a text nobody ever heard — under an
    // outcome that means "alerted nobody", not "gave up on one" (rule #11).
    await expect(
      sweep(harness({ verdict: { allowed: false, reason: 'quiet_hours' } })),
    ).resolves.toEqual(['gate_refused:quiet_hours']);

    await expect(sweep(harness(), { seeding: true })).resolves.toEqual(['seeding_run']);
    expect((await snapshotOf(TIMED.eventId))?.pendingSince).toBeInstanceOf(Date);

    const daylight = harness();
    const later = await sweepBoth(daylight, {
      changes: [],
      now: new Date('2026-09-17T16:00:00.000Z'),
    });
    expect(later.reoffers).toEqual(['sent']);
  });

  it('keeps one memory per connection, so two calendars never read each other', async () => {
    const other = await seedIntegration(db.database, family.familyId, family.parentUserId, 'gdrive');
    await sweep(harness());
    const rows = await db.database
      .select()
      .from(schema.calendarEventSnapshots)
      .where(eq(schema.calendarEventSnapshots.integrationId, other));
    expect(rows).toEqual([]);
  });

  it('costs one query and no clock read on a quiet calendar with nothing owed', async () => {
    const h = harness();
    await expect(sweepBoth(h, { changes: [] })).resolves.toEqual({ changes: [], reoffers: [] });
    expect(h.timeZoneReads).toEqual([]);
  });
});

describe('the text itself', () => {
  const TZ = 'America/Toronto';

  /** The span is resolved ONCE per change by the sweep and handed to the renderer, so the
   * window decision and the sentence can never disagree about which day this is. */
  function render(change: CalendarChange, previous: PriorStart | null = null): string {
    const span = eventSpan(change, TZ);
    if (span === null) throw new Error('render: this change has no placeable start');
    return renderCalendarAlert(change, span, TZ, NOW, previous);
  }

  it('names the day and the clock range for a timed event', () => {
    expect(render(TIMED)).toBe(
      'Cartwheels Gym is on your calendar for Thursday, Sep 17, 4:15-5:00 p.m.',
    );
  });

  it('keeps both halves of the day when the event straddles noon', () => {
    expect(
      render({
        ...TIMED,
        start: { dateTime: '2026-09-17T15:30:00.000Z' },
        end: { dateTime: '2026-09-17T17:00:00.000Z' },
      }),
    ).toContain('11:30 a.m.-1:00 p.m.');
  });

  it('names the second day when the event crosses midnight', () => {
    expect(
      render({
        ...TIMED,
        title: 'Cousins sleepover',
        start: { dateTime: '2026-09-18T02:00:00.000Z' }, // Sep 17, 10 p.m.
        end: { dateTime: '2026-09-18T11:00:00.000Z' }, // Sep 18, 7 a.m.
      }),
    ).toBe(
      'Cousins sleepover is on your calendar for Thursday, Sep 17, 10:00 p.m. to Friday, Sep 18, 7:00 a.m.',
    );
  });

  it('keeps an event that ends AT midnight on the day it started', () => {
    // "10:00 p.m. to Saturday, Sep 19, 12:00 a.m." names a day the parent is not out for
    // and reads as a typo.
    expect(
      render({
        ...TIMED,
        title: 'Party',
        start: { dateTime: '2026-09-19T02:00:00.000Z' }, // Sep 18, 10 p.m.
        end: { dateTime: '2026-09-19T04:00:00.000Z' }, // Sep 19, midnight
      }),
    ).toBe('Party is on your calendar for Friday, Sep 18, 10:00 p.m.-12:00 a.m.');
  });

  it('names both ends of a multi-day all-day event', () => {
    // Google's all-day `end.date` is EXCLUSIVE: a camp written Sep 21 → Sep 26 is the
    // 21st to the 25th, and naming only its first day loses the week.
    expect(
      render({
        ...TIMED,
        title: 'March break camp',
        start: { date: '2026-09-21' },
        end: { date: '2026-09-26' },
      }),
    ).toBe('March break camp is on your calendar for Monday, Sep 21 to Friday, Sep 25.');
  });

  it('says the day alone for an all-day event, in the day the calendar wrote', () => {
    expect(
      render({
        ...TIMED,
        title: 'PA day',
        start: { date: '2026-09-18' },
        end: { date: '2026-09-19' },
      }),
    ).toBe('PA day is on your calendar for Friday, Sep 18.');
  });

  it('puts a cancellation in the past tense and drops the clock', () => {
    expect(render({ ...TIMED, status: 'cancelled' })).toBe(
      'Cartwheels Gym on Thursday, Sep 17 was cancelled.',
    );
  });

  it('adds the year once the date leaves this one', () => {
    expect(
      render({
        ...TIMED,
        status: 'cancelled',
        start: { dateTime: '2027-03-04T21:15:00.000Z' },
        end: { dateTime: '2027-03-04T22:00:00.000Z' },
      }),
    ).toBe('Cartwheels Gym on Thursday, Mar 4, 2027 was cancelled.');
  });

  it('calls an event with no summary Untitled rather than saying nothing', () => {
    expect(render({ ...TIMED, title: undefined })).toContain('Untitled is on your calendar');
  });

  it('calls a CANCELLED event with no summary "An event" — a tombstone has no title to find', () => {
    // "Untitled was cancelled" reads as a bug in Hale. The recurring master's title would
    // be the honest answer and the incremental page does not carry it, so the sentence
    // says the one true thing instead.
    expect(render({ ...TIMED, status: 'cancelled', title: undefined })).toBe(
      'An event on Thursday, Sep 17 was cancelled.',
    );
  });

  it('drops a title with a mailbox in it, exactly as the location is dropped', () => {
    // A parent writes the person they owe a reply to into the title, and a mailbox in a
    // text is a mailbox anyone holding the phone can write to (rule #1).
    expect(render({ ...TIMED, title: 'Email coach@gym.ca re Leo' })).toBe(
      'Untitled is on your calendar for Thursday, Sep 17, 4:15-5:00 p.m.',
    );
    expect(render({ ...TIMED, status: 'cancelled', title: 'Email coach@gym.ca re Leo' })).toBe(
      'An event on Thursday, Sep 17 was cancelled.',
    );
  });

  it('names the start alone for a timed event Google sent with no end', () => {
    // `end` is absent often enough to matter, and the span collapses onto the start —
    // which "11:00-11:00 a.m." renders as a typo rather than as the one fact there is.
    expect(
      render({
        ...TIMED,
        title: 'Pickup',
        start: { dateTime: '2026-09-17T15:00:00.000Z' },
        end: {},
      }),
    ).toBe('Pickup is on your calendar for Thursday, Sep 17, 11:00 a.m.');
  });

  it('carries a short, clean location and refuses a long one or one with an address in it', () => {
    expect(render({ ...TIMED, location: 'Stouffville Leisure Centre' })).toBe(
      'Cartwheels Gym is on your calendar for Thursday, Sep 17, 4:15-5:00 p.m. at Stouffville Leisure Centre.',
    );
    // A joining link is an address anyone holding the phone can write to, and a pasted
    // street block is a paragraph.
    expect(render({ ...TIMED, location: 'meet@zoom.example/j/9' })).toBe(
      'Cartwheels Gym is on your calendar for Thursday, Sep 17, 4:15-5:00 p.m.',
    );
    expect(render({ ...TIMED, location: 'x'.repeat(41) })).toBe(
      'Cartwheels Gym is on your calendar for Thursday, Sep 17, 4:15-5:00 p.m.',
    );
  });

  it('folds a typographic title back into GSM-7 rather than paying UCS-2 for it', () => {
    const body = render({ ...TIMED, title: 'Leo’s class — swim 🏊' });
    expect(body).toContain("Leo's class - swim");
    expect(isPrintableGsm7Basic(body)).toBe(true);
  });

  it('holds two GSM-7 segments including the FULL opt-out, for every shape it renders', () => {
    // The budget is what makes the two clamps load-bearing: drop either and one pasted
    // calendar title becomes a three-segment bill per family per edit.
    const nasty = 'Registration — 秋の遠足 '.repeat(30);
    for (const status of ['confirmed', 'tentative', 'cancelled'] as const) {
      for (const when of [
        {
          start: { dateTime: '2027-01-05T18:00:00.000Z' },
          end: { dateTime: '2027-01-06T05:00:00.000Z' },
        },
        { start: { date: '2027-01-05' }, end: { date: '2027-01-06' } },
        // The two widest shapes: a week-long camp names both its ends, and an overnight
        // names the second day as well as both clocks.
        { start: { date: '2027-01-05' }, end: { date: '2027-01-11' } },
        {
          start: { dateTime: '2027-01-05T18:00:00.000Z' },
          end: { dateTime: '2027-01-06T12:00:00.000Z' },
        },
        {
          start: { dateTime: '2027-01-05T18:00:00.000Z' },
          end: { dateTime: '2027-01-05T19:00:00.000Z' },
        },
      ]) {
        const change = { ...TIMED, ...when, status, title: nasty, location: `${nasty} hall` };
        // The MOVED shapes too: the widest `(was …)` there is — another year, so the
        // parenthetical carries the weekday, the month, the day AND the year — and the
        // SAME-DAY prior, which is what turns an all-day shape into "is now all day on".
        for (const previous of [
          null,
          { startMs: Date.parse('2026-12-30T18:00:00.000Z'), allDay: false },
          { startMs: Date.parse('2027-01-05T17:00:00.000Z'), allDay: false },
        ]) {
          const body = render(change, previous);
          expect(isPrintableGsm7Basic(body)).toBe(true);
          expect(smsSegments(`${body}\n\n${OPT_OUT_LINE}`)).toBeLessThanOrEqual(2);
        }
      }
    }
  });
});

describe('the gate registration', () => {
  it('counts calendar alerts on their OWN budget, three a day', () => {
    // Kills PROACTIVE_CATEGORY.calendar_alert = 'email_alert', which would let a busy
    // calendar spend the inbox's budget.
    expect(PROACTIVE_CATEGORY.calendar_alert).toBe('calendar_alert');
    expect(PROACTIVE_CAP.calendar_alert).toEqual({ max: 3, windowHours: 24 });
  });
});
