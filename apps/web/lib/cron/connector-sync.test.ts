import { describe, expect, it, vi } from 'vitest';
import { CALENDAR_ALERT_OUTCOMES } from '~/lib/integrations/calendar-alert';
import { BOOKING_OUTCOMES, EMAIL_ALERT_OUTCOMES } from '~/lib/integrations/email-alert';
import { GOING_OUTCOMES } from '~/lib/integrations/going';
import { TRAVEL_DETECT_OUTCOMES } from '~/lib/travel/detect';
import { googleGetFetch, runConnectorSync } from './connector-sync';

const NO_ALERTS = {
  emailAlerts: [] as const,
  calendarAlerts: [] as const,
  calendarDroppedNoId: 0,
  travelDetections: [] as const,
  asides: [] as const,
};

const FAMILY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FAMILY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function conn(id: string, familyId: string) {
  return sweepConn(id, familyId, 'BLOB-OK');
}

const decryptOk = (enc: string) => {
  if (enc !== 'BLOB-OK') throw new Error('bad blob');
  return { accessToken: 'ya29.x' };
};

function sweepConn(id: string, familyId: string, enc: string) {
  return { id, familyId, userId: 'u1', provider: 'gcal' as const, providerMetadata: {}, enc };
}

describe('runConnectorSync', () => {
  it('syncs every active connection, passing per-family child names', async () => {
    const connections = [conn('i1', FAMILY_A), conn('i2', FAMILY_B)];
    const childNamesByFamily: Record<string, string[]> = {
      [FAMILY_A]: ['Mila'],
      [FAMILY_B]: ['Theo'],
    };
    const seen: Array<{ id: string; childNames: readonly string[] }> = [];

    const summary = await runConnectorSync({
      listConnections: async () => connections,
      decryptTokens: decryptOk,
      loadChildNames: async (familyId) => childNamesByFamily[familyId] ?? [],
      buildDeps: () => ({}) as never,
      syncOne: async (connection, _deps, childNames) => {
        seen.push({ id: connection.id, childNames });
        return NO_ALERTS;
      },
    });

    expect(summary.connections).toBe(2);
    expect(seen).toEqual([
      { id: 'i1', childNames: ['Mila'] },
      { id: 'i2', childNames: ['Theo'] },
    ]);
  });

  it('a throw in one connection does not abort the sweep', async () => {
    const connections = [conn('i1', FAMILY_A), conn('i2', FAMILY_B)];
    const synced: string[] = [];
    const summary = await runConnectorSync({
      listConnections: async () => connections,
      decryptTokens: decryptOk,
      loadChildNames: async () => [],
      buildDeps: () => ({}) as never,
      syncOne: async (connection) => {
        if (connection.id === 'i1') throw new Error('boom');
        synced.push(connection.id);
        return NO_ALERTS;
      },
    });
    // i2 still ran despite i1 throwing.
    expect(synced).toEqual(['i2']);
    expect(summary.connections).toBe(2);
  });

  it('a corrupted token blob marks THAT row errored and never halts the sweep', async () => {
    // Decryption must happen INSIDE the per-connection isolation: one tampered /
    // key-rotation-leftover blob may cost its own row, never the whole work-list.
    const connections = [sweepConn('bad', FAMILY_A, 'BLOB-BAD'), sweepConn('good', FAMILY_B, 'BLOB-GOOD')];
    const synced: string[] = [];
    const errored: Array<{ id: string; code: string }> = [];

    const summary = await runConnectorSync({
      listConnections: async () => connections,
      loadChildNames: async () => [],
      buildDeps: () =>
        ({
          markError: async (id: string, code: string) => {
            errored.push({ id, code });
          },
        }) as never,
      decryptTokens: (enc) => {
        if (enc === 'BLOB-BAD') throw new Error('bad auth tag');
        return { accessToken: 'ya29.ok' };
      },
      syncOne: async (connection) => {
        synced.push(connection.id);
        return NO_ALERTS;
      },
    });

    expect(synced).toEqual(['good']);
    // Rule #11: an unreadable blob is its OWN named outcome, not a bare 'error' that
    // reads the same as a Google request Hale could retry its way out of.
    expect(errored).toEqual([{ id: 'bad', code: 'decrypt_failed' }]);
    expect(summary.connections).toBe(2);
  });

  it('tallies every email-alert outcome across connections, one bucket per envelope', async () => {
    // Rule #11 in the summary: a sweep that texted nobody has to be able to say WHY, and
    // 'dark' reads very differently from 'not_parenting'.
    const summary = await runConnectorSync({
      listConnections: async () => [conn('i1', FAMILY_A), conn('i2', FAMILY_B)],
      decryptTokens: decryptOk,
      loadChildNames: async () => [],
      buildDeps: () => ({}) as never,
      syncOne: async (connection) =>
        connection.id === 'i1'
          ? {
              ...NO_ALERTS,
              emailAlerts: [
                { alert: 'sent', booking: 'recorded', going: null, aside: null },
                { alert: 'not_parenting', booking: null, going: null, aside: null },
                { alert: 'not_parenting', booking: null, going: null, aside: null },
              ] as const,
            }
          : {
              ...NO_ALERTS,
              emailAlerts: [
                { alert: 'dark', booking: null, going: null, aside: null },
                { alert: 'gate_refused:quiet_hours', booking: null, going: null, aside: null },
              ] as const,
            },
    });

    expect(summary.emailAlerts).toMatchObject({
      sent: 1,
      not_parenting: 2,
      dark: 1,
      'gate_refused:quiet_hours': 1,
    });
    // Every named outcome is present as a zero rather than absent — a missing key in a
    // dashboard reads as "never happens", which is a different claim from "did not today".
    expect(Object.keys(summary.emailAlerts).sort()).toEqual([...EMAIL_ALERT_OUTCOMES].sort());
    expect(Object.values(summary.emailAlerts).reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('tallies bookings on their OWN axis, and counts nothing for an envelope that never got there', async () => {
    // Two independent answers per envelope: whether a text went, and whether a place the
    // family now holds was written down. `booking: null` means "the alert never reached
    // the decision", which is already counted by name on the alert axis - folding it into
    // a booking bucket would be a counter that means two things (rule #11).
    const summary = await runConnectorSync({
      listConnections: async () => [conn('i1', FAMILY_A)],
      decryptTokens: decryptOk,
      loadChildNames: async () => [],
      buildDeps: () => ({}) as never,
      syncOne: async () => ({
        ...NO_ALERTS,
        emailAlerts: [
          { alert: 'sent', booking: 'recorded', going: null, aside: null },
          { alert: 'sent', booking: 'teen_content', going: null, aside: null },
          { alert: 'sent', booking: 'booked_dark', going: null, aside: null },
          { alert: 'dark', booking: null, going: null, aside: null },
        ] as const,
      }),
    });

    expect(summary.bookings).toMatchObject({ recorded: 1, teen_content: 1, booked_dark: 1 });
    // Three envelopes reached the decision; the fourth never did.
    expect(Object.values(summary.bookings).reduce((a, b) => a + b, 0)).toBe(3);
    expect(Object.values(summary.emailAlerts).reduce((a, b) => a + b, 0)).toBe(4);
    // Every named outcome present as a zero rather than absent — a missing key reads as
    // "never happens", which is a different claim from "did not today".
    expect(Object.keys(summary.bookings).sort()).toEqual([...BOOKING_OUTCOMES].sort());
  });

  it('tallies EVERY going outcome on its own third axis, one bucket per name', async () => {
    // The third answer an envelope has: whether a number about OTHER households was spoken.
    // Every member is driven through, because a name that no counter can ever show is a
    // name nobody can act on (rule #11) - and `below_floor` is precisely why this is a
    // counter and not a column on the audit row: it will be the answer ten thousand times.
    const summary = await runConnectorSync({
      listConnections: async () => [conn('i1', FAMILY_A)],
      decryptTokens: decryptOk,
      loadChildNames: async () => [],
      buildDeps: () => ({}) as never,
      syncOne: async () => ({
        ...NO_ALERTS,
        emailAlerts: GOING_OUTCOMES.map((going) => ({
          alert: 'sent' as const,
          booking: 'recorded' as const,
          going,
          aside: null,
        })).concat([{ alert: 'dark', booking: null, going: null }] as never),
      }),
    });

    for (const name of GOING_OUTCOMES) expect(summary.going[name]).toBe(1);
    // The null never reached the going decision, and is already named on the alert axis.
    expect(Object.values(summary.going).reduce((a, b) => a + b, 0)).toBe(GOING_OUTCOMES.length);
    // Every named outcome present as a zero rather than absent - a missing key in a
    // dashboard reads as "never happens", which is a different claim from "did not today".
    expect(Object.keys(summary.going).sort()).toEqual([...GOING_OUTCOMES].sort());
  });

  it('tallies calendar outcomes on their OWN counter, never the inbox one', async () => {
    // Kills the wiring that adds both connectors' outcomes to one tally: a September
    // calendar and a September inbox fail in different ways, and one bucket for both
    // makes each one's diagnosis unreadable.
    const summary = await runConnectorSync({
      listConnections: async () => [conn('i1', FAMILY_A), conn('i2', FAMILY_B)],
      decryptTokens: decryptOk,
      loadChildNames: async () => [],
      buildDeps: () => ({}) as never,
      syncOne: async (connection) =>
        connection.id === 'i1'
          ? {
              ...NO_ALERTS,
              // Including the three the snapshot memory added: a sweep that collapsed a
              // series and paid off a debt has to be readable as that in the summary.
              calendarAlerts: [
                'sent',
                'outside_window',
                'collapsed_into_series',
                'pending_expired',
                'pending_outside_window',
              ] as const,
            }
          : { ...NO_ALERTS, emailAlerts: [{ alert: 'sent', booking: null, going: null, aside: null }] as const },
    });

    expect(summary.calendarAlerts).toMatchObject({
      sent: 1,
      outside_window: 1,
      collapsed_into_series: 1,
      pending_expired: 1,
      pending_outside_window: 1,
    });
    expect(summary.emailAlerts.sent).toBe(1);
    expect(Object.keys(summary.calendarAlerts).sort()).toEqual([...CALENDAR_ALERT_OUTCOMES].sort());
    expect(Object.values(summary.calendarAlerts).reduce((a, b) => a + b, 0)).toBe(5);
    // Nothing was dropped here — the control for the tally below.
    expect(summary.calendarDroppedNoId).toBe(0);
  });

  it('tallies travel detections on their OWN counter, summed across connections', async () => {
    // The surface the founder reads the precision trade off week to week: `trip_written`
    // beside `no_child_evidence` is the miss rate, counted once per email. Its own tally
    // and not a widening of the inbox one, because an envelope has two independent
    // answers — whether a text went about it, and whether a trip was written down.
    const summary = await runConnectorSync({
      listConnections: async () => [conn('i1', FAMILY_A), conn('i2', FAMILY_B)],
      decryptTokens: decryptOk,
      loadChildNames: async () => [],
      buildDeps: () => ({}) as never,
      syncOne: async (connection) =>
        connection.id === 'i1'
          ? {
              ...NO_ALERTS,
              travelDetections: [
                'trip_written',
                'no_child_evidence',
                'not_booking_shaped',
              ] as const,
              emailAlerts: [{ alert: 'sent', booking: null, going: null, aside: null }] as const,
            }
          : { ...NO_ALERTS, travelDetections: ['no_child_evidence', 'dark'] as const },
    });

    expect(summary.travelDetections).toMatchObject({
      trip_written: 1,
      no_child_evidence: 2,
      not_booking_shaped: 1,
      dark: 1,
    });
    expect(Object.values(summary.travelDetections).reduce((a, b) => a + b, 0)).toBe(5);
    // Every named outcome present as a zero rather than absent — a missing key reads as
    // "never happens", which is a different claim from "did not today".
    expect(Object.keys(summary.travelDetections).sort()).toEqual([
      ...TRAVEL_DETECT_OUTCOMES,
    ].sort());
    // And it did NOT land on the inbox counter: one email alert, five detections.
    expect(Object.values(summary.emailAlerts).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('carries the un-keyable calendar items into the summary, summed across connections', async () => {
    // An item with no id has no outcome to count, because it never reached the alert path.
    // Left out of the summary entirely it is a connector going blind quietly (rule #11).
    const summary = await runConnectorSync({
      listConnections: async () => [conn('i1', FAMILY_A), conn('i2', FAMILY_B)],
      decryptTokens: decryptOk,
      loadChildNames: async () => [],
      buildDeps: () => ({}) as never,
      syncOne: async (connection) => ({
        ...NO_ALERTS,
        calendarDroppedNoId: connection.id === 'i1' ? 2 : 1,
      }),
    });

    expect(summary.calendarDroppedNoId).toBe(3);
  });

  it('keeps the counts of the connections that ran when one of them throws', async () => {
    const summary = await runConnectorSync({
      listConnections: async () => [conn('i1', FAMILY_A), conn('i2', FAMILY_B)],
      decryptTokens: decryptOk,
      loadChildNames: async () => [],
      buildDeps: () => ({}) as never,
      syncOne: async (connection) => {
        if (connection.id === 'i2') throw new Error('boom');
        return { ...NO_ALERTS, emailAlerts: [{ alert: 'sent', booking: null, going: null, aside: null }] as const };
      },
    });
    expect(summary.emailAlerts.sent).toBe(1);
  });
});

describe('googleGetFetch', () => {
  it('issues a bearer GET and normalizes the response', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hello: 'world' }),
    })) as unknown as typeof fetch;
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy;
    try {
      const res = await googleGetFetch('https://api.example/x', 'ya29.token');
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ hello: 'world' });
      expect(fetchSpy).toHaveBeenCalledWith('https://api.example/x', {
        method: 'GET',
        headers: { authorization: 'Bearer ya29.token' },
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});

/**
 * THE ASIDE TALLY REACHES A HUMAN.
 *
 * Rule #11's shape, not a log line: a feature whose whole justification is marginal has
 * to report what it did AND what it declined to do, and a count of zero nobody can tell
 * apart from "never ran" is the silent no-op. `asides.lane_dark` being a NUMBER on a dark
 * deploy is what the live probe asserts before a single model call is made.
 */
describe('the voice pass tally', () => {
  it('folds every connection asides into one histogram that sums to the texts it saw', async () => {
    const summary = await runConnectorSync({
      listConnections: async () => [conn('i1', FAMILY_A), conn('i2', FAMILY_B)],
      decryptTokens: decryptOk,
      loadChildNames: async () => [],
      buildDeps: () => ({}) as never,
      syncOne: async (connection) =>
        connection.id === 'i1'
          ? {
              ...NO_ALERTS,
              asides: [
                { outcome: 'aside' as const, refusals: [] },
                { outcome: 'empty' as const, refusals: [] },
                {
                  outcome: 'refused' as const,
                  refusals: ['too_many_segments' as const, 'solicits_reply' as const],
                },
              ],
            }
          : { ...NO_ALERTS, asides: [{ outcome: 'lane_dark' as const, refusals: [] }] },
    });

    // The mutation: drop the field from one lane's return and this sum is 3, not 4.
    const total = Object.values(summary.asides).reduce((a, b) => a + b, 0);
    expect(total).toBe(4);
    expect(summary.asides.aside).toBe(1);
    expect(summary.asides.empty).toBe(1);
    expect(summary.asides.refused).toBe(1);
    expect(summary.asides.lane_dark).toBe(1);
    expect(summary.asideRefusals.too_many_segments).toBe(1);
    expect(summary.asideRefusals.solicits_reply).toBe(1);
  });

  it('reports every key from zero, so dark reads as a number rather than an absence', async () => {
    const summary = await runConnectorSync({
      listConnections: async () => [],
      decryptTokens: decryptOk,
      loadChildNames: async () => [],
      buildDeps: () => ({}) as never,
      syncOne: async () => NO_ALERTS,
    });
    expect(summary.asides.lane_dark).toBe(0);
    expect(summary.asides.aside).toBe(0);
    expect(summary.asideRefusals.too_many_segments).toBe(0);
    // Eight outcome buckets and thirteen refusals, every one present. A key that only
    // appears once it is non-zero is a key nobody can graph.
    expect(Object.keys(summary.asides)).toHaveLength(8);
    expect(Object.keys(summary.asideRefusals)).toHaveLength(13);
  });
});
