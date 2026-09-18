import { describe, expect, it, vi } from 'vitest';
import { CALENDAR_ALERT_OUTCOMES } from '~/lib/integrations/calendar-alert';
import { EMAIL_ALERT_OUTCOMES } from '~/lib/integrations/email-alert';
import { googleGetFetch, runConnectorSync } from './connector-sync';

const NO_ALERTS = {
  emailAlerts: [] as const,
  calendarAlerts: [] as const,
  calendarDroppedNoId: 0,
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
          ? { ...NO_ALERTS, emailAlerts: ['sent', 'not_parenting', 'not_parenting'] as const }
          : { ...NO_ALERTS, emailAlerts: ['dark', 'gate_refused:quiet_hours'] as const },
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
          ? { ...NO_ALERTS, calendarAlerts: ['sent', 'outside_window'] as const }
          : { ...NO_ALERTS, emailAlerts: ['sent'] as const },
    });

    expect(summary.calendarAlerts).toMatchObject({ sent: 1, outside_window: 1 });
    expect(summary.emailAlerts.sent).toBe(1);
    expect(Object.keys(summary.calendarAlerts).sort()).toEqual([...CALENDAR_ALERT_OUTCOMES].sort());
    expect(Object.values(summary.calendarAlerts).reduce((a, b) => a + b, 0)).toBe(2);
    // Nothing was dropped here — the control for the tally below.
    expect(summary.calendarDroppedNoId).toBe(0);
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
        return { ...NO_ALERTS, emailAlerts: ['sent'] as const };
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
