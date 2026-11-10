import { beforeEach, describe, expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({
  query: vi.fn(),
  unsafe: vi.fn(),
  end: vi.fn(),
  migrate: vi.fn(),
  check: vi.fn(),
}));

vi.mock('postgres', () => ({
  default: () => Object.assign(ports.query, { unsafe: ports.unsafe, end: ports.end }),
}));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: (sql) => sql }));
vi.mock('drizzle-orm/postgres-js/migrator', () => ({ migrate: ports.migrate }));
vi.mock('./check-migration-drift.mjs', () => ({
  readDbUrl: () => 'postgres://localhost/migration-test',
  runMigrationCheck: ports.check,
  sanitizeDbError: (error) => error.message,
}));

import { applyPendingMigrations } from './apply-migrations.mjs';

beforeEach(() => {
  vi.resetAllMocks();
  // The old catalog exists and retirement is not recorded yet.
  ports.query.mockImplementation(async (strings) =>
    strings.join('').includes('to_regclass') ? [{ legacy_present: true, has_ledger: true }] : [],
  );
  ports.check.mockResolvedValue(0);
});

describe('approved catalog retirement through normal deployment', () => {
  it('applies pending migrations under the shared lock, then verifies hashes', async () => {
    expect(await applyPendingMigrations()).toBe(0);
    expect(ports.migrate).toHaveBeenCalledOnce();
    expect(ports.check).toHaveBeenCalledWith({ requireUrl: true });
    expect(ports.unsafe.mock.calls).toEqual([
      ['select pg_advisory_lock(841, 330)'],
      ['select pg_advisory_unlock(841, 330)'],
    ]);
    expect(ports.unsafe.mock.invocationCallOrder[0]).toBeLessThan(
      ports.migrate.mock.invocationCallOrder[0],
    );
    expect(ports.migrate.mock.invocationCallOrder[0]).toBeLessThan(
      ports.check.mock.invocationCallOrder[0],
    );
    expect(ports.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it('fails the deployment if the ledger check fails', async () => {
    ports.check.mockResolvedValue(1);
    expect(await applyPendingMigrations()).toBe(1);
    expect(ports.migrate).toHaveBeenCalledOnce();
    expect(ports.check).toHaveBeenCalledOnce();
    expect(ports.end).toHaveBeenCalledOnce();
  });

  it('fails and releases the lock if migration throws', async () => {
    ports.migrate.mockRejectedValue(new Error('migration failed'));
    expect(await applyPendingMigrations()).toBe(1);
    expect(ports.check).not.toHaveBeenCalled();
    expect(ports.unsafe).toHaveBeenLastCalledWith('select pg_advisory_unlock(841, 330)');
    expect(ports.end).toHaveBeenCalledOnce();
  });
});
