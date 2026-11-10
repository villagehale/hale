import { describe, expect, it, vi } from 'vitest';
import { type CdpConnector, loadPlaywrightCore, playwrightSessionSeeder } from './seed';

// No browser and no network: the CDP client is a fake. BROWSER_USE_API_KEY stays unset.
function fakeConnector() {
  const addCookies = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const connectOverCDP = vi.fn(async () => ({
    contexts: () => [{ addCookies, newPage: vi.fn() }],
    close,
  }));
  return {
    connector: { connectOverCDP } as unknown as CdpConnector,
    connectOverCDP,
    addCookies,
    close,
  };
}

const STATE = {
  cookies: [{ name: 'sid', value: 'x', domain: 'provider.test', path: '/' }],
  origins: [],
} as never;

describe('playwrightSessionSeeder', () => {
  it('is never null, so a fresh profile is not reported seed_unavailable', () => {
    expect(process.env.BROWSER_USE_API_KEY ?? '').toBe('');
    expect(playwrightSessionSeeder()).not.toBeNull();
  });

  it('loads the CDP client lazily, once, and seeds cookies', async () => {
    const fake = fakeConnector();
    const load = vi.fn(async () => fake.connector);
    const seeder = playwrightSessionSeeder(load);
    expect(load).not.toHaveBeenCalled();
    await seeder.seed('wss://cdp.example.test/x', STATE);
    await seeder.seed('wss://cdp.example.test/x', STATE);
    expect(load).toHaveBeenCalledTimes(1);
    expect(fake.connectOverCDP).toHaveBeenCalledWith('wss://cdp.example.test/x');
    expect(fake.addCookies).toHaveBeenCalledTimes(2);
    expect(fake.close).toHaveBeenCalledTimes(2);
  });

  it('surfaces a load failure from seed and retries the load next time', async () => {
    const fake = fakeConnector();
    const load = vi
      .fn<() => Promise<CdpConnector>>()
      .mockRejectedValueOnce(new Error('missing'))
      .mockResolvedValueOnce(fake.connector);
    const seeder = playwrightSessionSeeder(load);
    await expect(seeder.seed('wss://cdp.example.test/x', STATE)).rejects.toThrow('missing');
    await seeder.seed('wss://cdp.example.test/x', STATE);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('resolves chromium from the real playwright-core dependency through import()', async () => {
    const chromium = await loadPlaywrightCore();
    expect(typeof chromium.connectOverCDP).toBe('function');
  });
});
