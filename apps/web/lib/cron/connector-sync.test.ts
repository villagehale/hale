import { describe, expect, it, vi } from 'vitest';
import type { ActiveConnectorConnection } from '~/lib/integrations/store';
import { googleGetFetch, runConnectorSync } from './connector-sync';

const FAMILY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FAMILY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function conn(id: string, familyId: string): ActiveConnectorConnection {
  return {
    id,
    familyId,
    userId: 'u1',
    provider: 'gcal',
    providerMetadata: {},
    tokens: { accessToken: 'ya29.x' },
  };
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
      loadChildNames: async (familyId) => childNamesByFamily[familyId] ?? [],
      buildDeps: () => ({}) as never,
      syncOne: async (connection, _deps, childNames) => {
        seen.push({ id: connection.id, childNames });
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
      loadChildNames: async () => [],
      buildDeps: () => ({}) as never,
      syncOne: async (connection) => {
        if (connection.id === 'i1') throw new Error('boom');
        synced.push(connection.id);
      },
    });
    // i2 still ran despite i1 throwing.
    expect(synced).toEqual(['i2']);
    expect(summary.connections).toBe(2);
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
