import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Settings connectors loader (VIL-156 follow-up). Two seams the verifier asked to see
 * pinned: the disconnect passes what Google confirmed through to the Settings label, and
 * the card learns when Hale stopped asking Google without hearing it confirm. The DB and
 * the disconnect primitive are faked here; both are pinned against real DDL in
 * google-disconnect.pglite.test.ts.
 */
const authMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/auth-config', () => ({ authConfigured: () => true }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: async () => 'family-1',
  resolveUserIdForUser: async () => 'user-1',
}));
const disconnectMock = vi.fn();
vi.mock('./google-disconnect', () => ({
  disconnectGoogle: (...args: unknown[]) => disconnectMock(...args),
}));
const listMock = vi.fn();
const unconfirmedMock = vi.fn();
vi.mock('./store', () => ({
  listConnections: (...args: unknown[]) => listMock(...args),
  listUserConnections: async () => [],
  googleRevokeUnconfirmedProviders: (...args: unknown[]) => unconfirmedMock(...args),
}));

import { loadFamilyConnectors, revokeFamilyConnector } from './load';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DATABASE_URL', 'postgres://example.invalid/hale');
  authMock.mockResolvedValue({ user: { id: 'auth-1' } });
});

describe('revokeFamilyConnector', () => {
  it.each(['revoked', 'pending_retry', 'not_confirmed'] as const)(
    'passes Google’s answer (%s) through to the Settings label',
    async (google) => {
      disconnectMock.mockResolvedValue({ status: 'disconnected', providers: ['gcal'], google });
      expect(await revokeFamilyConnector('gcal')).toEqual({ status: 'revoked', google });
      expect(disconnectMock).toHaveBeenCalledWith(
        {},
        { familyId: 'family-1', userId: 'user-1', via: 'settings', named: 'gcal' },
      );
    },
  );

  it('positive control: nothing of theirs connected is not_found, with no Google answer', async () => {
    disconnectMock.mockResolvedValue({ status: 'not_connected' });
    expect(await revokeFamilyConnector('gcal')).toEqual({ status: 'not_found' });
  });
});

describe('loadFamilyConnectors', () => {
  const base = { status: 'revoked', scopes: [], lastSyncAt: null };

  it("marks the viewer's own disconnected row whose Google revoke was never confirmed", async () => {
    listMock.mockResolvedValue([
      { ...base, provider: 'gcal', userId: 'user-1' },
      { ...base, provider: 'gmail', userId: 'user-1' },
      { ...base, provider: 'gcal', userId: 'co-parent' },
    ]);
    unconfirmedMock.mockResolvedValue(['gcal']);

    const views = await loadFamilyConnectors();

    expect(unconfirmedMock).toHaveBeenCalledWith({}, { familyId: 'family-1', userId: 'user-1' });
    expect(views).toEqual([
      { ...base, provider: 'gcal', ownedByViewer: true, googleRevokeUnconfirmed: true },
      { ...base, provider: 'gmail', ownedByViewer: true },
      { ...base, provider: 'gcal', ownedByViewer: false },
    ]);
  });
});
