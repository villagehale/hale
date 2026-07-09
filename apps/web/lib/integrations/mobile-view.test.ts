import { describe, expect, it } from 'vitest';
import type { ConnectionSummary } from './store';
import { toConnectorStates } from './mobile-view';

const CONNECTED_AT = new Date('2026-07-01T00:00:00.000Z');
const SYNCED_AT = new Date('2026-07-08T00:00:00.000Z');

function summary(over: Partial<ConnectionSummary>): ConnectionSummary {
  return {
    provider: 'gcal',
    status: 'active',
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    lastSyncAt: SYNCED_AT,
    connectedAt: CONNECTED_AT,
    ...over,
  };
}

describe('toConnectorStates — normalized per-provider state, no token material', () => {
  it('always returns exactly the three connectors, in a stable order', () => {
    const states = toConnectorStates([]);
    expect(states.map((s) => s.provider)).toEqual(['gcal', 'gmail', 'gdrive']);
  });

  it("reports a provider with NO row as 'not_connected' with no connectedAt", () => {
    const states = toConnectorStates([]);
    for (const s of states) {
      expect(s.status).toBe('not_connected');
      expect(s.connectedAt).toBeUndefined();
    }
  });

  it("maps active → 'connected' and carries the connect timestamp as ISO", () => {
    const [gcal] = toConnectorStates([summary({ provider: 'gcal', status: 'active' })]);
    expect(gcal).toEqual({
      provider: 'gcal',
      status: 'connected',
      connectedAt: CONNECTED_AT.toISOString(),
    });
  });

  it("maps error and expired → 'error' (needs reconnecting)", () => {
    const states = toConnectorStates([
      summary({ provider: 'gmail', status: 'error' }),
      summary({ provider: 'gdrive', status: 'expired' }),
    ]);
    expect(states.find((s) => s.provider === 'gmail')?.status).toBe('error');
    expect(states.find((s) => s.provider === 'gdrive')?.status).toBe('error');
  });

  it("maps revoked and connecting → 'not_connected' (fails closed, never a false green)", () => {
    const states = toConnectorStates([
      summary({ provider: 'gmail', status: 'revoked' }),
      summary({ provider: 'gdrive', status: 'connecting' }),
    ]);
    expect(states.find((s) => s.provider === 'gmail')?.status).toBe('not_connected');
    expect(states.find((s) => s.provider === 'gdrive')?.status).toBe('not_connected');
  });

  it('collapses two rows for one provider by the strongest status, order-independently', () => {
    const active = summary({ provider: 'gcal', status: 'active' });
    const revoked = summary({ provider: 'gcal', status: 'revoked' });
    // A live connection must never render as 'Not connected' just because a stale
    // revoked row sorts first — the result is the same regardless of row order.
    const activeFirst = toConnectorStates([active, revoked]);
    const revokedFirst = toConnectorStates([revoked, active]);
    expect(activeFirst.find((s) => s.provider === 'gcal')?.status).toBe('connected');
    expect(revokedFirst.find((s) => s.provider === 'gcal')?.status).toBe('connected');
  });

  it('drops any non-connector provider row (e.g. stripe) — only the three surface', () => {
    const states = toConnectorStates([summary({ provider: 'stripe', status: 'active' })]);
    expect(states).toHaveLength(3);
    for (const s of states) expect(s.status).toBe('not_connected');
  });

  it('never leaks scopes or a token field into a state', () => {
    const states = toConnectorStates([summary({ provider: 'gcal', status: 'active' })]);
    const serialized = JSON.stringify(states);
    expect(serialized).not.toContain('scopes');
    expect(serialized).not.toContain('googleapis.com');
    expect(serialized).not.toContain('token');
  });
});
