import { describe, expect, it } from 'vitest';
import type { ConnectionSummary } from '~/lib/integrations/store';
import { connectorChips } from './coach-context-panel';

function summary(over: Partial<ConnectionSummary> & { provider: string }): ConnectionSummary {
  return { status: 'active', scopes: [], lastSyncAt: null, ...over };
}

/**
 * The coach Context → Connectors panel derives its chips from the family's
 * connection summaries. Every supported connector is always shown (so the panel is
 * a stable catalog); a connector is "connected" only when the family has an ACTIVE
 * row for it — a revoked or errored connection reads as not connected.
 */
describe('connectorChips', () => {
  it('shows every supported connector even when the family has linked none', () => {
    expect(connectorChips([]).map((c) => c.provider)).toEqual(['gcal', 'gmail', 'gdrive']);
    expect(connectorChips([]).every((c) => c.connected === false)).toBe(true);
  });

  it('marks a connector connected only when its row is active', () => {
    const chips = connectorChips([
      summary({ provider: 'gcal', status: 'active' }),
      summary({ provider: 'gmail', status: 'revoked' }),
    ]);
    expect(chips.find((c) => c.provider === 'gcal')?.connected).toBe(true);
    expect(chips.find((c) => c.provider === 'gmail')?.connected).toBe(false);
    expect(chips.find((c) => c.provider === 'gdrive')?.connected).toBe(false);
  });
});
