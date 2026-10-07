import { afterEach, describe, expect, it, vi } from 'vitest';

describe('texted-invite test helper', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('refuses to load in a production build, so its fabricated consent reply cannot ship', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    await expect(import('./texted-invite')).rejects.toThrow(/production/);
  });

  it('loads outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.resetModules();
    const mod = await import('./texted-invite');
    expect(typeof mod.seedTextedInvite).toBe('function');
  });
});
