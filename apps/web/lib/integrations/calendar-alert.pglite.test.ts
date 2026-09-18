import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { OPT_OUT_LINE } from '~/lib/channel/opt-out';
import { PROACTIVE_CAP, PROACTIVE_CATEGORY } from '~/lib/channel/outbound-gate';
import { isPrintableGsm7Basic, smsSegments } from '~/lib/channel/sms-segments';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  CALENDAR_ALERT_MAX_PER_SWEEP,
  CALENDAR_ALERT_TEMPLATE_KEY,
  type CalendarAlertOutcome,
  type CalendarAlertPorts,
  type CalendarChange,
  alertParentForCalendarChanges,
  calendarAlertDedupeKey,
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
 * instance is shared across the file. */
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

function sweep(
  h: Harness,
  over: Partial<Parameters<typeof alertParentForCalendarChanges>[1]> = {},
): Promise<readonly CalendarAlertOutcome[]> {
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
  INTEGRATION = randomUUID();
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

  it('is dark behind F14 — no text, nothing written', async () => {
    vi.stubEnv('F14_ENABLED', 'false');
    const h = harness();

    await expect(sweep(h)).resolves.toEqual(['dark']);

    expect(h.transport.sent).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
    // Dark costs NOTHING, not even the clock read: the flag is a pure function of the
    // family id, so a query in front of it is a query for a family Hale may not text.
    expect(h.timeZoneReads).toEqual([]);
  });

  it('alerts NOTHING on a seeding run — a fresh connection is not 200 texts', async () => {
    const h = harness();
    await expect(
      sweep(h, { seeding: true, changes: [TIMED, { ...TIMED, eventId: 'ev-2' }] }),
    ).resolves.toEqual(['seeding_run', 'seeding_run']);
    expect(h.transport.sent).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
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

  it('names a tombstone Google sent with no start rather than counting it as far away', async () => {
    // Google's incremental list returns a deleted single event as id + status + updated
    // and nothing else. "We cannot place this in time" is a different fact from "this is
    // in 40 days", and a sweep that says the second is a sweep nobody can diagnose.
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

describe('the text itself', () => {
  const TZ = 'America/Toronto';

  /** The span is resolved ONCE per change by the sweep and handed to the renderer, so the
   * window decision and the sentence can never disagree about which day this is. */
  function render(change: CalendarChange): string {
    const span = eventSpan(change, TZ);
    if (span === null) throw new Error('render: this change has no placeable start');
    return renderCalendarAlert(change, span, TZ, NOW);
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
        const body = render({ ...TIMED, ...when, status, title: nasty, location: `${nasty} hall` });
        expect(isPrintableGsm7Basic(body)).toBe(true);
        expect(smsSegments(`${body}\n\n${OPT_OUT_LINE}`)).toBeLessThanOrEqual(2);
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
