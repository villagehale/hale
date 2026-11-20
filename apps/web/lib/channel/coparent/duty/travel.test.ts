import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultTravelTimeClient, travelMinutesBetween } from './travel';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('travelMinutesBetween', () => {
  it('is null when either venue has no address', async () => {
    const client = { driveMinutes: vi.fn(async () => 12) };
    await expect(
      travelMinutesBetween({ address: '14 Alder Ave' }, { address: null }, client),
    ).resolves.toBeNull();
    await expect(
      travelMinutesBetween(null, { address: '14 Alder Ave' }, client),
    ).resolves.toBeNull();
    expect(client.driveMinutes).not.toHaveBeenCalled();
  });

  it('is zero minutes when both addresses are the same place', async () => {
    const client = { driveMinutes: vi.fn(async () => 40) };
    await expect(
      travelMinutesBetween({ address: '14 Alder Ave' }, { address: '14 Alder Ave' }, client),
    ).resolves.toBe(0);
    expect(client.driveMinutes).not.toHaveBeenCalled();
  });

  it('uses the injected client for two real addresses', async () => {
    const client = { driveMinutes: vi.fn(async () => 18) };
    await expect(
      travelMinutesBetween({ address: '14 Alder Ave' }, { address: '221 Guelph St' }, client),
    ).resolves.toBe(18);
    expect(client.driveMinutes).toHaveBeenCalledWith('14 Alder Ave', '221 Guelph St');
  });
});

describe('defaultTravelTimeClient', () => {
  it('returns null with no Maps key, and does not call the network', async () => {
    vi.stubEnv('GOOGLE_MAPS_API_KEY', '');
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', '');
    const fetchImpl = vi.fn();
    const client = defaultTravelTimeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.driveMinutes('14 Alder Ave', '221 Guelph St')).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads duration seconds from Routes and rounds up to minutes', async () => {
    vi.stubEnv('GOOGLE_MAPS_API_KEY', 'test-key');
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ routes: [{ duration: '125s' }] }),
    }));
    const client = defaultTravelTimeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.driveMinutes('14 Alder Ave', '221 Guelph St')).resolves.toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns null when Routes has no duration', async () => {
    vi.stubEnv('GOOGLE_MAPS_API_KEY', 'test-key');
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ routes: [] }),
    }));
    const client = defaultTravelTimeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.driveMinutes('14 Alder Ave', '221 Guelph St')).resolves.toBeNull();
  });
});
