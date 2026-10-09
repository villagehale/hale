import { describe, expect, it, vi } from 'vitest';

vi.mock('~/auth', () => ({ auth: async () => null }));
vi.mock('~/lib/auth-config', () => ({ authConfigured: () => false }));
vi.mock('~/lib/db', () => ({
  db: () => {
    throw new Error('DATABASE_URL is not set');
  },
}));

describe('loadViewerName without a database', () => {
  it('returns null instead of throwing when auth is off', async () => {
    const { loadViewerName } = await import('~/lib/family');
    await expect(loadViewerName()).resolves.toBeNull();
  });
});
