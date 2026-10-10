import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Next.js loads route modules while collecting page data. The web drain route
 * imports `@hale/worker/orchestrator`, which imports this config. A Preview
 * build has no DATABASE_URL (Option B: Preview must not be able to reach the
 * production database). Module load has to succeed; a real connection still
 * refuses to start without a URL.
 */

const ORIGINAL_URL = process.env.DATABASE_URL;

function unsetDatabaseUrl(): void {
  // Assigning undefined stringifies to "undefined" and fails the URL check.
  // biome-ignore lint/performance/noDelete: the absent key is the case under test.
  delete process.env.DATABASE_URL;
}

afterEach(() => {
  if (ORIGINAL_URL === undefined) unsetDatabaseUrl();
  else process.env.DATABASE_URL = ORIGINAL_URL;
  vi.resetModules();
});

describe('worker config without DATABASE_URL', () => {
  it('imports the orchestrator the web build loads when DATABASE_URL is unset', async () => {
    unsetDatabaseUrl();
    vi.resetModules();
    await expect(import('./orchestrator/index.js')).resolves.toMatchObject({
      runOrchestrator: expect.any(Function),
    });
  });

  it('treats an empty DATABASE_URL as unset and does not throw at import', async () => {
    process.env.DATABASE_URL = '';
    vi.resetModules();
    const { config, requireDatabaseUrl } = await import('./config.js');
    expect(config.DATABASE_URL).toBeUndefined();
    expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL is not set/);
  });

  it('refuses to open a worker pool when DATABASE_URL is missing', async () => {
    unsetDatabaseUrl();
    vi.resetModules();
    const { db } = await import('./db.js');
    expect(() => db()).toThrow(/DATABASE_URL is not set/);
  });

  it('keeps a configured URL for production runtime', async () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
    vi.resetModules();
    const { requireDatabaseUrl } = await import('./config.js');
    expect(requireDatabaseUrl()).toBe('postgres://test:test@localhost:5432/test');
  });

  it('still rejects a malformed DATABASE_URL at load', async () => {
    process.env.DATABASE_URL = 'not-a-url';
    vi.resetModules();
    await expect(import('./config.js')).rejects.toThrow();
  });
});
