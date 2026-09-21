import { describe, expect, it, vi } from 'vitest';
import type { CalendarChange } from './calendar-alert';
import type { GmailAlertEnvelope } from './email-alert';
import type { ActiveConnectorConnection } from './store';
import {
  type CalendarAlertBatch,
  type GmailAlertBatch,
  type GoogleFetch,
  syncConnection,
} from './sync';
import type { OAuthTokens } from './token-vault';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const FRESH: OAuthTokens = { accessToken: 'ya29.fresh', refreshToken: '1//refresh', expiresAt: Date.now() + 3600_000 };

/** Build a GoogleFetch that answers each requested URL from a route table (first
 * substring match), recording the bearer token it was called with. */
function routedFetch(routes: Array<{ match: string; status?: number; body: unknown }>) {
  const calls: Array<{ url: string; token: string }> = [];
  const fetchImpl: GoogleFetch = async (url, accessToken) => {
    calls.push({ url, token: accessToken });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`no route for ${url}`);
    const status = route.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => route.body };
  };
  return { fetchImpl, calls };
}

interface EnqueuedEvent {
  source: string;
  payload: Record<string, unknown>;
  familyId: string;
}

interface Captured {
  enqueued: EnqueuedEvent[];
  cursor?: Record<string, unknown>;
  errored: boolean;
  /** The PII-free reason markError was given (rule #11 — 'error' alone says nothing). */
  errorCode?: string;
  refreshed?: OAuthTokens;
  /** Every gmail batch handed to the alert port, in order. */
  alerted: GmailAlertBatch[];
  /** Every calendar batch handed to the alert port, in order. */
  calendarAlerted: CalendarAlertBatch[];
  /** Every gmail batch handed to the TRAVEL detect port, in order. The third alert-shaped
   * port on SyncDeps, and non-nullable for the reason the other two are. */
  travelDetected: GmailAlertBatch[];
}

/** The single enqueued event, asserting exactly one was emitted (narrows away the
 * noUncheckedIndexedAccess `undefined`). */
function onlyEvent(cap: Captured): EnqueuedEvent {
  expect(cap.enqueued).toHaveLength(1);
  const [event] = cap.enqueued;
  if (!event) throw new Error('no enqueued event');
  return event;
}

/** Deps stub: capture enqueue + cursor/error/token writes without a real queue/db. */
function stubDeps(overrides: Partial<Parameters<typeof syncConnection>[1]> = {}) {
  const cap: Captured = {
    enqueued: [],
    errored: false,
    alerted: [],
    calendarAlerted: [],
    travelDetected: [],
  };
  const deps: Parameters<typeof syncConnection>[1] = {
    googleFetch: overrides.googleFetch ?? routedFetch([]).fetchImpl,
    enqueue: async (event) => {
      cap.enqueued.push({ source: event.source, payload: event.payload, familyId: event.family_id });
    },
    childNames: overrides.childNames ?? ['Mila'],
    saveCursor: async (_id, meta) => {
      cap.cursor = meta;
    },
    markError: async (_id, code) => {
      cap.errored = true;
      cap.errorCode = code;
    },
    refreshTokens: overrides.refreshTokens ?? (async () => ({ accessToken: 'ya29.refreshed' })),
    saveTokens: async (_id, t) => {
      cap.refreshed = t;
    },
    alertGmailEnvelopes: async (batch) => {
      cap.alerted.push(batch);
      return batch.envelopes.map(() => ({ alert: 'dark' as const, booking: null }));
    },
    alertCalendarChanges: async (batch) => {
      cap.calendarAlerted.push(batch);
      return { changes: batch.changes.map(() => 'dark' as const), reoffers: [] };
    },
    detectTravelBookings: async (batch) => {
      cap.travelDetected.push(batch);
      return batch.envelopes.map(() => 'dark' as const);
    },
    ...overrides,
  };
  return { deps, cap };
}

/** The changes of the single calendar batch, asserting exactly one batch was handed over. */
function onlyChanges(cap: Captured): readonly CalendarChange[] {
  expect(cap.calendarAlerted).toHaveLength(1);
  const batch = cap.calendarAlerted[0];
  if (!batch) throw new Error('no alerted calendar batch');
  return batch.changes;
}

/** The single alerted envelope, asserting exactly one batch of exactly one. */
function onlyEnvelope(cap: Captured): GmailAlertEnvelope {
  expect(cap.alerted).toHaveLength(1);
  const envelopes = cap.alerted[0]?.envelopes ?? [];
  expect(envelopes).toHaveLength(1);
  const [envelope] = envelopes;
  if (!envelope) throw new Error('no alerted envelope');
  return envelope;
}

function connection(provider: ActiveConnectorConnection['provider'], meta: Record<string, unknown> = {}, tokens = FRESH): ActiveConnectorConnection {
  return { id: 'i1', familyId: FAMILY, userId: USER, provider, providerMetadata: meta, tokens };
}

describe('syncConnection — Calendar', () => {
  it('maps events.list results → redacted events.ingested and advances syncToken', async () => {
    const { fetchImpl } = routedFetch([
      {
        match: 'calendar/v3/calendars/primary/events',
        body: {
          items: [
            { id: 'ev1', summary: 'Mila swim class', start: { dateTime: '2026-07-10T15:00:00Z' } },
          ],
          nextSyncToken: 'SYNC-2',
        },
      },
    ]);
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);

    expect(cap.errored).toBe(false);
    const event = onlyEvent(cap);
    expect(event.source).toBe('gcal');
    expect(event.familyId).toBe(FAMILY);
    // Redacted: the known child name is masked (rule #1).
    expect(JSON.stringify(event.payload)).not.toContain('Mila');
    expect(event.payload.summary).toBe('[CHILD] swim class');
    // Cursor advanced to the returned nextSyncToken.
    expect(cap.cursor).toEqual({ syncToken: 'SYNC-2' });
  });

  it('on 410 GONE drops the stale syncToken and full-resyncs', async () => {
    let calls = 0;
    const fetchImpl: GoogleFetch = async (url) => {
      calls += 1;
      if (url.includes('syncToken=STALE')) {
        return { ok: false, status: 410, json: async () => ({ error: 'gone' }) };
      }
      // Full resync (no syncToken) succeeds.
      return { ok: true, status: 200, json: async () => ({ items: [], nextSyncToken: 'SYNC-FULL' }) };
    };
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'STALE' }), deps);

    expect(calls).toBe(2); // stale (410) then full resync
    expect(cap.errored).toBe(false);
    expect(cap.cursor).toEqual({ syncToken: 'SYNC-FULL' });
  });

  it('the incremental URL carries nothing events.list forbids alongside syncToken', async () => {
    // events.list, syncToken: "All events deleted since the previous list request
    // will always be in the result set and it is not allowed to set showDeleted to
    // False. There are several query parameters that cannot be specified together
    // with nextSyncToken ... iCalUID, orderBy, privateExtendedProperty, q,
    // sharedExtendedProperty, timeMin, timeMax, updatedMin."
    const { fetchImpl, calls } = routedFetch([
      { match: 'calendar/v3/calendars/primary/events', body: { items: [], nextSyncToken: 'SYNC-2' } },
    ]);
    const { deps } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);

    const query = new URLSearchParams(new URL(calls[0]?.url ?? 'https://x.invalid/').search);
    expect(query.get('syncToken')).toBe('SYNC-1');
    for (const forbidden of [
      'iCalUID',
      'orderBy',
      'privateExtendedProperty',
      'q',
      'sharedExtendedProperty',
      'timeMin',
      'timeMax',
      'updatedMin',
    ]) {
      expect(query.has(forbidden)).toBe(false);
    }
    expect(query.get('showDeleted')).not.toBe('false');
  });

  it('survives a Google that enforces the syncToken contract (the full sync is legal, the incremental must be too)', async () => {
    // The prod shape: a base carrying showDeleted=false passes the FULL sync and
    // 400s every incremental, so a connection syncs once at connect and never
    // again -- last_sync_at frozen seconds after created_at.
    const fetchImpl: GoogleFetch = async (url) => {
      if (url.includes('syncToken=') && url.includes('showDeleted=false')) {
        return { ok: false, status: 400, json: async () => ({ error: { code: 400 } }) };
      }
      return { ok: true, status: 200, json: async () => ({ items: [], nextSyncToken: 'SYNC-2' }) };
    };
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);

    expect(cap.errored).toBe(false);
    expect(cap.cursor).toEqual({ syncToken: 'SYNC-2' });
  });

  it('does not ingest a cancelled event (showDeleted=true is forced on us; a tombstone is not an event)', async () => {
    const { fetchImpl } = routedFetch([
      {
        match: 'calendar/v3/calendars/primary/events',
        body: {
          items: [
            { id: 'ev1', summary: 'swim class', status: 'confirmed' },
            { id: 'ev2', summary: 'swim class', status: 'cancelled' },
          ],
          nextSyncToken: 'SYNC-2',
        },
      },
    ]);
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);

    expect(cap.enqueued.map((e) => e.payload.id)).toEqual(['ev1']);
    expect(cap.cursor).toEqual({ syncToken: 'SYNC-2' });
  });

  it('hands the cancelled event to the ALERT path even though the ingest drops it', async () => {
    // The two halves disagree on purpose: Hale holds no event store to delete from, so a
    // tombstone is not an appointment — but "your Thursday class was cancelled" is the
    // single most useful thing this feature says, and the ingest events structurally
    // cannot carry it.
    const { fetchImpl } = routedFetch([
      {
        match: 'calendar/v3/calendars/primary/events',
        body: {
          items: [
            {
              id: 'ev2',
              summary: 'Cartwheels Gym',
              status: 'cancelled',
              updated: '2026-09-17T14:55:00.000Z',
              start: { dateTime: '2026-09-17T20:15:00-04:00' },
              end: { dateTime: '2026-09-17T21:00:00-04:00' },
              location: 'Stouffville Leisure Centre',
              organizer: { self: true },
            },
          ],
          nextSyncToken: 'SYNC-2',
        },
      },
    ]);
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);

    expect(cap.enqueued).toEqual([]);
    expect(onlyChanges(cap)).toEqual([
      {
        eventId: 'ev2',
        updated: '2026-09-17T14:55:00.000Z',
        status: 'cancelled',
        title: 'Cartwheels Gym',
        start: { dateTime: '2026-09-17T20:15:00-04:00', date: undefined },
        end: { dateTime: '2026-09-17T21:00:00-04:00', date: undefined },
        location: 'Stouffville Leisure Centre',
        selfOrganized: true,
      },
    ]);
  });

  it('marks a first sync and a 410 resync as SEEDING, and an ordinary incremental as not', async () => {
    // Both read the whole calendar. A seeding run that alerted would text a new family
    // about every event they have ever put in it.
    const full = stubDeps({
      googleFetch: routedFetch([
        { match: 'calendar/v3', body: { items: [], nextSyncToken: 'SYNC-1' } },
      ]).fetchImpl,
    });
    await syncConnection(connection('gcal', {}), full.deps);
    expect(full.cap.calendarAlerted[0]?.seeding).toBe(true);

    const gone: GoogleFetch = async (url) =>
      url.includes('syncToken=STALE')
        ? { ok: false, status: 410, json: async () => ({ error: 'gone' }) }
        : { ok: true, status: 200, json: async () => ({ items: [], nextSyncToken: 'SYNC-FULL' }) };
    const resynced = stubDeps({ googleFetch: gone });
    await syncConnection(connection('gcal', { syncToken: 'STALE' }), resynced.deps);
    expect(resynced.cap.calendarAlerted[0]?.seeding).toBe(true);

    const incremental = stubDeps({
      googleFetch: routedFetch([
        { match: 'calendar/v3', body: { items: [], nextSyncToken: 'SYNC-2' } },
      ]).fetchImpl,
    });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), incremental.deps);
    expect(incremental.cap.calendarAlerted[0]?.seeding).toBe(false);
  });

  it('returns the calendar port outcomes, and alerts only AFTER the cursor advanced', async () => {
    const { fetchImpl } = routedFetch([
      {
        match: 'calendar/v3',
        body: {
          items: [{ id: 'ev1', updated: '2026-09-17T14:55:00.000Z', summary: 'Swim' }],
          nextSyncToken: 'SYNC-2',
        },
      },
    ]);
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    const result = await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);

    expect(result.calendarAlerts).toEqual(['dark']);
    expect(cap.cursor).toEqual({ syncToken: 'SYNC-2' });
    // The control for the drop counter below: a clean page reports nothing dropped, so
    // `1` there cannot be a counter that is simply always on.
    expect(result.calendarDroppedNoId).toBe(0);
  });

  it('a throw from the CALENDAR alert path is named, and never marks the calendar broken', async () => {
    // Mirrors the Gmail case: the two halves fail for unrelated reasons and only one of
    // them is Google's. A bug in Hale's own alert path must not stop the ingest.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetchImpl } = routedFetch([
      {
        match: 'calendar/v3',
        body: {
          items: [{ id: 'ev1', updated: '2026-09-17T14:55:00.000Z', summary: 'Swim' }],
          nextSyncToken: 'SYNC-2',
        },
      },
    ]);
    const { deps, cap } = stubDeps({
      googleFetch: fetchImpl,
      alertCalendarChanges: async () => {
        throw new Error('boom');
      },
    });
    const thrown = await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();

    expect(thrown.calendarAlerts).toEqual(['alert_failed']);
    expect(cap.errored).toBe(false);
    expect(cap.cursor).toEqual({ syncToken: 'SYNC-2' });
    expect(cap.enqueued).toHaveLength(1);
  });

  it('drops an item with no id and COUNTS it — the one field nothing can stand in for', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchImpl } = routedFetch([
      {
        match: 'calendar/v3',
        body: {
          items: [
            { updated: '2026-09-17T14:55:00.000Z', summary: 'no id' },
            { id: 'ev3', updated: '2026-09-17T14:56:00.000Z', summary: 'complete' },
          ],
          nextSyncToken: 'SYNC-2',
        },
      },
    ]);
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    const result = await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);

    expect(onlyChanges(cap).map((c) => c.eventId)).toEqual(['ev3']);
    // A silent drop is a connector going blind (rule #11): the item is still gone, but
    // the sweep says how many and the cron summary carries it.
    expect(result.calendarDroppedNoId).toBe(1);
    expect(warned).toHaveBeenCalledTimes(1);
    warned.mockRestore();
  });

  it('keys an item Google sent with no `updated` on its etag — the same page twice, the same key', async () => {
    // events.list documents a deleted event as "only guaranteed to have the id field
    // populated". Dropping every item without `updated` drops the cancellations, which
    // are the single most useful thing this feature says. The etag is a VERSION, so it
    // keys a replay to the same string and costs one text rather than two.
    const items = [
      {
        id: 'ev1',
        etag: '"3181161784712000"',
        summary: 'Swim',
        start: { dateTime: '2026-09-18T20:15:00-04:00' },
      },
    ];
    const stamps: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      const { fetchImpl } = routedFetch([
        { match: 'calendar/v3', body: { items, nextSyncToken: 'SYNC-2' } },
      ]);
      const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
      await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);
      stamps.push(onlyChanges(cap)[0]?.updated ?? 'MISSING');
    }
    expect(stamps).toEqual(['"3181161784712000"', '"3181161784712000"']);
  });

  it('keys an item with neither `updated` nor etag on the run\'s own clock rather than dropping it', async () => {
    const before = Date.now();
    const { fetchImpl } = routedFetch([
      {
        match: 'calendar/v3',
        body: {
          items: [{ id: 'ev1', summary: 'Swim', start: { dateTime: '2026-09-18T20:15:00-04:00' } }],
          nextSyncToken: 'SYNC-2',
        },
      },
    ]);
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);

    const [change] = onlyChanges(cap);
    expect(change?.eventId).toBe('ev1');
    const stamp = Date.parse(change?.updated ?? '');
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(Date.now());
  });

  it('places a cancelled recurring instance by its originalStartTime — the only time it carries', async () => {
    // Google returns a cancelled instance of a recurring event as id + recurringEventId +
    // originalStartTime + status, with no `start` at all. Read literally that is a change
    // nobody can place in time; read as Google means it, it is "Friday's class is off".
    const { fetchImpl } = routedFetch([
      {
        match: 'calendar/v3',
        body: {
          items: [
            {
              id: 'ev2_20260918T201500Z',
              status: 'cancelled',
              updated: '2026-09-17T14:55:00.000Z',
              recurringEventId: 'ev2',
              originalStartTime: { dateTime: '2026-09-18T20:15:00-04:00' },
            },
          ],
          nextSyncToken: 'SYNC-2',
        },
      },
    ]);
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);

    expect(onlyChanges(cap)).toEqual([
      {
        eventId: 'ev2_20260918T201500Z',
        // The SERIES this instance belongs to, carried through because it is the only
        // field that says six changes are one edit. Drop it and one moved weekly class is
        // six texts, or five texts and a silently dropped Tuesday.
        recurringEventId: 'ev2',
        updated: '2026-09-17T14:55:00.000Z',
        status: 'cancelled',
        title: undefined,
        start: { dateTime: '2026-09-18T20:15:00-04:00', date: undefined },
        end: { dateTime: '2026-09-18T20:15:00-04:00', date: undefined },
        location: undefined,
        selfOrganized: undefined,
      },
    ]);
    // ...and a one-off carries none, so nothing groups two unrelated events together.
    const { fetchImpl: plain } = routedFetch([
      {
        match: 'calendar/v3',
        body: {
          items: [{ id: 'ev9', updated: '2026-09-17T14:55:00.000Z', summary: 'Dentist' }],
          nextSyncToken: 'SYNC-2',
        },
      },
    ]);
    const single = stubDeps({ googleFetch: plain });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), single.deps);
    expect(onlyChanges(single.cap)[0]?.recurringEventId).toBeUndefined();
  });

  it('counts a RE-OFFERED text in the sweep outcomes, not only the changes on the page', async () => {
    // The alert answers in two lists because only the first is positional; a re-offer
    // answers no change on this page. A summary that counted the first alone would report
    // a sweep that texted three parents as a sweep that did nothing (rule #11).
    const { fetchImpl } = routedFetch([
      {
        match: 'calendar/v3',
        body: {
          items: [{ id: 'ev1', updated: '2026-09-17T14:55:00.000Z', summary: 'Swim' }],
          nextSyncToken: 'SYNC-2',
        },
      },
    ]);
    const { deps } = stubDeps({
      googleFetch: fetchImpl,
      alertCalendarChanges: async () => ({
        changes: ['outside_window'] as const,
        reoffers: ['sent', 'pending_expired'] as const,
      }),
    });
    const result = await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);
    expect(result.calendarAlerts).toEqual(['outside_window', 'sent', 'pending_expired']);
  });
});

describe('syncConnection — Gmail', () => {
  it('first run: messages.list then per-message metadata; advances historyId', async () => {
    const fetchImpl: GoogleFetch = async (url) => {
      if (url.includes('/messages/m1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'm1',
            snippet: 'Reminder for Mila from daycare',
            payload: { headers: [{ name: 'Subject', value: 'Daycare note about Mila' }] },
          }),
        };
      }
      // getProfile carries the mailbox historyId — the REAL cursor source. The
      // messages.list resource does NOT return a historyId (the seed bug this
      // guards: reading it from the list yields undefined -> a {} cursor -> the
      // next run re-seeds and re-emits every message).
      if (url.includes('/profile')) {
        return { ok: true, status: 200, json: async () => ({ historyId: '9002' }) };
      }
      // messages.list (no historyId cursor yet on first run) — NO historyId field.
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'm1' }] }) };
    };
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gmail', {}), deps);

    expect(cap.errored).toBe(false);
    const event = onlyEvent(cap);
    expect(event.source).toBe('gmail');
    expect(JSON.stringify(event.payload)).not.toContain('Mila');
    // First run seeds the historyId cursor from the list response.
    expect(cap.cursor).toEqual({ historyId: '9002' });
  });

  it('a 410 GONE on incremental history.list ERRORS — never wipes the historyId cursor (no re-seed double-enqueue)', async () => {
    // 410 is a Calendar-only full-resync signal. For Gmail it must NOT be treated
    // as an empty success: that would advance the cursor to {historyId: undefined},
    // and the next run re-runs the first-run seed, re-enqueuing up to 25 messages.
    const fetchImpl: GoogleFetch = async () => ({ ok: false, status: 410, json: async () => ({}) });
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gmail', { historyId: '9002' }), deps);

    expect(cap.errored).toBe(true);
    expect(cap.cursor).toBeUndefined(); // cursor untouched
    expect(cap.enqueued).toHaveLength(0);
  });

  it('an incremental run whose history pages carry NO historyId ERRORS — cursor never wiped', async () => {
    // Guard mirroring calendar/drive: draining to a run with no terminal historyId
    // must not advance {historyId: undefined}; throw so the cursor holds.
    const fetchImpl: GoogleFetch = async (url) => {
      if (url.includes('/messages/m5')) {
        return { ok: true, status: 200, json: async () => ({ id: 'm5', snippet: 'x', payload: { headers: [] } }) };
      }
      // history.list returns a change but omits historyId (no terminal cursor).
      return {
        ok: true,
        status: 200,
        json: async () => ({ history: [{ messagesAdded: [{ message: { id: 'm5' } }] }] }),
      };
    };
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gmail', { historyId: '9002' }), deps);

    expect(cap.errored).toBe(true);
    expect(cap.cursor).toBeUndefined();
    expect(cap.enqueued).toHaveLength(0);
  });

  it('incremental run: history.list from stored historyId; advances to the new historyId', async () => {
    const fetchImpl: GoogleFetch = async (url) => {
      if (url.includes('/messages/m2')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'm2', snippet: 'hello', payload: { headers: [{ name: 'Subject', value: 'Hi' }] } }),
        };
      }
      // history.list from startHistoryId
      return {
        ok: true,
        status: 200,
        json: async () => ({
          history: [{ messagesAdded: [{ message: { id: 'm2' } }] }],
          historyId: '9100',
        }),
      };
    };
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gmail', { historyId: '9002' }), deps);

    onlyEvent(cap);
    expect(cap.cursor).toEqual({ historyId: '9100' });
  });
});

describe('syncConnection — the gmail alert hand-off', () => {
  /** A mailbox whose one message carries internalDate and a child's name. */
  function mailbox(internalDate?: string): GoogleFetch {
    return async (url) => {
      if (url.includes('/messages/m2')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'm2',
            snippet: "Mila's swim class is cancelled",
            internalDate,
            payload: {
              headers: [
                { name: 'Subject', value: 'Swim cancelled' },
                { name: 'From', value: 'Pool <info@pool.example>' },
              ],
            },
          }),
        };
      }
      if (url.includes('/profile')) {
        return { ok: true, status: 200, json: async () => ({ historyId: '9002' }) };
      }
      if (url.includes('/history')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            history: [{ messagesAdded: [{ message: { id: 'm2' } }] }],
            historyId: '9100',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'm2' }] }) };
    };
  }

  it('hands the UNREDACTED envelope over, with internalDate as an ISO instant', async () => {
    // The triage stage matches on the family's child NAMES, so the alert path reads the
    // envelope before redactEventPayload masks them. Kills the mutation that reuses the
    // redacted `events` payloads: triage would then never recognise a child.
    const { deps, cap } = stubDeps({ googleFetch: mailbox('1789000000000') });
    await syncConnection(connection('gmail', { historyId: '9002' }), deps);

    expect(onlyEnvelope(cap)).toEqual({
      messageId: 'm2',
      subject: 'Swim cancelled',
      from: 'Pool <info@pool.example>',
      snippet: "Mila's swim class is cancelled",
      receivedAt: new Date(1789000000000).toISOString(),
    });
    // The ENQUEUED copy is still redacted — the alert path is an addition, not a hole.
    expect(JSON.stringify(onlyEvent(cap).payload)).not.toContain('Mila');
  });

  it('leaves receivedAt absent when Gmail returned no internalDate', async () => {
    // No Date header is requested, so there is nothing to fall back to. Anchoring the
    // extraction on `now` would move an appointment rather than decline to mention it.
    const { deps, cap } = stubDeps({ googleFetch: mailbox() });
    await syncConnection(connection('gmail', { historyId: '9002' }), deps);

    expect(onlyEnvelope(cap).receivedAt).toBeUndefined();
  });

  it('marks the SEEDING run so 25 old emails never become 25 texts', async () => {
    const { deps, cap } = stubDeps({ googleFetch: mailbox('1789000000000') });
    await syncConnection(connection('gmail', {}), deps);
    expect(cap.alerted[0]?.seeding).toBe(true);

    const incremental = stubDeps({ googleFetch: mailbox('1789000000000') });
    await syncConnection(connection('gmail', { historyId: '9002' }), incremental.deps);
    expect(incremental.cap.alerted[0]?.seeding).toBe(false);
  });

  it('never calls the GMAIL alert port for a provider that is not gmail', async () => {
    const { fetchImpl } = routedFetch([
      {
        match: 'calendar/v3/calendars/primary/events',
        body: { items: [{ id: 'ev1', summary: 'Swim' }], nextSyncToken: 'SYNC-2' },
      },
    ]);
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);
    expect(cap.alerted).toEqual([]);
  });

  it('returns the port\'s outcomes to the caller, and alerts only AFTER the cursor advanced', async () => {
    // Ordering is the invariant: the ingest contract is what this sweep owes, and a text
    // is a bonus on top of it. A throw from the alert port must therefore find the cursor
    // already saved — otherwise a slow alert pass would re-enqueue the whole batch next run.
    const ok = stubDeps({ googleFetch: mailbox('1789000000000') });
    const result = await syncConnection(connection('gmail', { historyId: '9002' }), ok.deps);
    expect(result.emailAlerts).toEqual([{ alert: 'dark', booking: null }]);
    expect(ok.cap.cursor).toEqual({ historyId: '9100' });
  });

  it('a throw from the ALERT path is named, and never marks the mailbox broken', async () => {
    // The two halves fail for unrelated reasons and only one of them is Google's. A
    // channel_messages insert that hits a missing enum value, a timezone read that races
    // a deletion — anything in Hale's own alert path — would otherwise reach this
    // module's catch, mark the CONNECTION errored and stop the INGEST too, so a bug in a
    // bonus feature silently ends the sync it rides on. One envelope in, one named
    // outcome out (rule #11).
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, cap } = stubDeps({
      googleFetch: mailbox('1789000000000'),
      alertGmailEnvelopes: async () => {
        throw new Error('boom');
      },
    });
    const thrown = await syncConnection(connection('gmail', { historyId: '9002' }), deps);
    // Before the restore: `mockRestore` clears the call record along with the stub.
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();

    // The PAIR, with a null booking and not a booking outcome: the alert pass threw, so
    // the booking decision was never reached, which is a different fact from a booking
    // that was refused (rule #11).
    expect(thrown.emailAlerts).toEqual([{ alert: 'alert_failed', booking: null }]);
    expect(cap.errored).toBe(false);
    expect(cap.cursor).toEqual({ historyId: '9100' });
    // The ingest half is untouched: the message still reached the queue.
    expect(cap.enqueued).toHaveLength(1);
  });

  it('hands the SAME batch to the travel detect pass, after the alert pass', async () => {
    // It reuses the envelopes and the access token this run already holds, so noticing a
    // trip costs no second Gmail call and no second token read.
    const { deps, cap } = stubDeps({ googleFetch: mailbox('1789000000000') });
    const result = await syncConnection(connection('gmail', { historyId: '9002' }), deps);
    expect(result.travelDetections).toEqual(['dark']);
    expect(cap.travelDetected).toHaveLength(1);
    expect(cap.travelDetected[0]?.envelopes).toEqual(cap.alerted[0]?.envelopes);
    expect(cap.travelDetected[0]?.accessToken).toBe(cap.alerted[0]?.accessToken);
  });

  it('a throw from the TRAVEL path is named, and never marks the mailbox broken', async () => {
    // Its own boundary, for exactly the reason the alert pass has one: a bug in Hale's
    // travel path must not mark the CONNECTION errored and stop the ingest. One envelope
    // in, one named outcome out (rule #11).
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps, cap } = stubDeps({
      googleFetch: mailbox('1789000000000'),
      detectTravelBookings: async () => {
        throw new Error('boom');
      },
    });
    const thrown = await syncConnection(connection('gmail', { historyId: '9002' }), deps);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();

    expect(thrown.travelDetections).toEqual(['detect_failed']);
    // The connection is healthy, the cursor advanced, the email alert still ran, and the
    // ingest still happened — the whole point of a boundary of its own.
    expect(cap.errored).toBe(false);
    expect(cap.cursor).toEqual({ historyId: '9100' });
    expect(thrown.emailAlerts).toEqual([{ alert: 'dark', booking: null }]);
    expect(cap.enqueued).toHaveLength(1);
  });
});

describe('syncConnection — Drive', () => {
  it('first run: getStartPageToken then changes.list; advances pageToken', async () => {
    const fetchImpl: GoogleFetch = async (url) => {
      if (url.includes('changes/startPageToken')) {
        return { ok: true, status: 200, json: async () => ({ startPageToken: 'P1' }) };
      }
      // changes.list from P1
      return {
        ok: true,
        status: 200,
        json: async () => ({
          changes: [{ file: { id: 'f1', name: 'Mila report card.pdf', mimeType: 'application/pdf' } }],
          newStartPageToken: 'P2',
        }),
      };
    };
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gdrive', {}), deps);

    expect(cap.errored).toBe(false);
    const event = onlyEvent(cap);
    expect(event.source).toBe('gdrive');
    expect(JSON.stringify(event.payload)).not.toContain('Mila');
    expect(cap.cursor).toEqual({ pageToken: 'P2' });
  });
});

describe('syncConnection — pagination (drain all pages before advancing)', () => {
  it('Calendar drains every page; the terminal nextSyncToken arrives only on the last', async () => {
    const { fetchImpl } = routedFetch([
      // page 2 (matched first): terminal nextSyncToken, no nextPageToken
      { match: 'pageToken=PAGE2', body: { items: [{ id: 'ev2', summary: 'park' }], nextSyncToken: 'SYNC-2' } },
      // page 1: items + nextPageToken, NO nextSyncToken
      {
        match: 'calendar/v3/calendars/primary/events',
        body: { items: [{ id: 'ev1', summary: 'library' }], nextPageToken: 'PAGE2' },
      },
    ]);
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);

    expect(cap.errored).toBe(false);
    // BOTH pages' items emitted — page-2 items are silently lost without pagination.
    expect(cap.enqueued.map((e) => e.payload.id)).toEqual(['ev1', 'ev2']);
    // Cursor advances to the LAST page's sync token, not {syncToken: undefined}.
    expect(cap.cursor).toEqual({ syncToken: 'SYNC-2' });
  });

  it('Calendar: a page with items but NO terminal token errors — cursor untouched, nothing emitted (no double-emit)', async () => {
    const { fetchImpl } = routedFetch([
      { match: 'calendar/v3/calendars/primary/events', body: { items: [{ id: 'ev1' }] } },
    ]);
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);

    expect(cap.errored).toBe(true);
    expect(cap.errorCode).toBe('cursor_missing');
    expect(cap.cursor).toBeUndefined();
    expect(cap.enqueued).toHaveLength(0);
  });

  it('Gmail drains all history pages before advancing historyId (later-page messages are not skipped)', async () => {
    const fetchImpl: GoogleFetch = async (url) => {
      if (url.includes('/messages/m1')) {
        return { ok: true, status: 200, json: async () => ({ id: 'm1', snippet: 'a', payload: { headers: [] } }) };
      }
      if (url.includes('/messages/m2')) {
        return { ok: true, status: 200, json: async () => ({ id: 'm2', snippet: 'b', payload: { headers: [] } }) };
      }
      if (url.includes('pageToken=H2')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ history: [{ messagesAdded: [{ message: { id: 'm2' } }] }], historyId: '9200' }),
        };
      }
      // history page 1: m1 + nextPageToken H2 (no terminal historyId advance yet)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          history: [{ messagesAdded: [{ message: { id: 'm1' } }] }],
          nextPageToken: 'H2',
          historyId: '9100',
        }),
      };
    };
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gmail', { historyId: '9002' }), deps);

    expect(cap.errored).toBe(false);
    expect(cap.enqueued.map((e) => e.payload.id).sort()).toEqual(['m1', 'm2']);
    // historyId advances to the last page's value, past all drained messages.
    expect(cap.cursor).toEqual({ historyId: '9200' });
  });
});

describe('syncConnection — failure isolation & token refresh', () => {
  it('a failed fetch sets status=error and does NOT advance the cursor (no double-emit / no loss)', async () => {
    const fetchImpl: GoogleFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', { syncToken: 'SYNC-1' }), deps);

    expect(cap.errored).toBe(true);
    // The status Google answered with, never a line of its body (rule #1/#11).
    expect(cap.errorCode).toBe('google_500');
    expect(cap.cursor).toBeUndefined(); // cursor untouched
    expect(cap.enqueued).toHaveLength(0);
  });

  it('an expiring token with NO refresh grant is a NAMED failure, not a stale-token retry', async () => {
    // Returning the expired token instead would 401 on every run from the first hour
    // on, under a status that says only "error" — the exact shape rule #11 forbids.
    const stranded: OAuthTokens = { accessToken: 'ya29.old', expiresAt: Date.now() - 1000 };
    const { fetchImpl, calls } = routedFetch([
      { match: 'calendar/v3', body: { items: [], nextSyncToken: 'S' } },
    ]);
    const { deps, cap } = stubDeps({ googleFetch: fetchImpl });
    await syncConnection(connection('gcal', {}, stranded), deps);

    expect(calls).toHaveLength(0); // a dead token is never spent on Google
    expect(cap.errored).toBe(true);
    expect(cap.errorCode).toBe('no_refresh_token');
    expect(cap.cursor).toBeUndefined();
  });

  it('a rejected refresh grant is named apart from a failed request', async () => {
    const expired: OAuthTokens = { accessToken: 'ya29.old', refreshToken: '1//revoked', expiresAt: Date.now() - 1000 };
    const { fetchImpl } = routedFetch([{ match: 'calendar/v3', body: { items: [], nextSyncToken: 'S' } }]);
    const { deps, cap } = stubDeps({
      googleFetch: fetchImpl,
      refreshTokens: async () => {
        throw new Error('invalid_grant');
      },
    });
    await syncConnection(connection('gcal', {}, expired), deps);

    expect(cap.errorCode).toBe('token_refresh_failed');
  });

  it('refreshes an expired access token before fetching, then persists it', async () => {
    const expired: OAuthTokens = { accessToken: 'ya29.old', refreshToken: '1//refresh', expiresAt: Date.now() - 1000 };
    const { fetchImpl, calls } = routedFetch([
      { match: 'calendar/v3', body: { items: [], nextSyncToken: 'S' } },
    ]);
    let refreshCalled = false;
    const { deps, cap } = stubDeps({
      googleFetch: fetchImpl,
      refreshTokens: async () => {
        refreshCalled = true;
        return { accessToken: 'ya29.refreshed' };
      },
    });
    await syncConnection(connection('gcal', {}, expired), deps);

    expect(refreshCalled).toBe(true);
    // The refreshed access token (not the stale one) is what hit Google.
    expect(calls[0]?.token).toBe('ya29.refreshed');
    // The refreshed token is persisted, preserving the original refresh token.
    expect(cap.refreshed?.accessToken).toBe('ya29.refreshed');
    expect(cap.refreshed?.refreshToken).toBe('1//refresh');
  });

  it('does NOT refresh a still-valid token', async () => {
    const { fetchImpl } = routedFetch([{ match: 'calendar/v3', body: { items: [], nextSyncToken: 'S' } }]);
    let refreshCalled = false;
    const { deps } = stubDeps({
      googleFetch: fetchImpl,
      refreshTokens: async () => {
        refreshCalled = true;
        return { accessToken: 'x' };
      },
    });
    await syncConnection(connection('gcal', {}, FRESH), deps);
    expect(refreshCalled).toBe(false);
  });
});

describe('syncConnection — cursor never advances past a failed enqueue', () => {
  it('enqueue rejecting mid-batch marks errored and leaves the cursor untouched', async () => {
    const { fetchImpl } = routedFetch([
      {
        match: 'calendar/v3/calendars/primary/events',
        body: {
          items: [
            { id: 'e1', summary: 'One', updated: '2026-07-01T00:00:00Z' },
            { id: 'e2', summary: 'Two', updated: '2026-07-01T00:00:00Z' },
            { id: 'e3', summary: 'Three', updated: '2026-07-01T00:00:00Z' },
          ],
          nextSyncToken: 'TOK-NEW',
        },
      },
    ]);
    let sent = 0;
    const { deps, cap } = stubDeps({
      googleFetch: fetchImpl,
      enqueue: async () => {
        sent += 1;
        if (sent === 2) throw new Error('queue down');
      },
    });

    await syncConnection(connection('gcal'), deps);

    expect(cap.errored).toBe(true);
    // The cursor must NOT move: unemitted items would be lost forever.
    expect(cap.cursor).toBeUndefined();
  });
});
