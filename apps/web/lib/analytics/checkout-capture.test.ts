import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureCheckoutEvent } from './checkout-capture';
import { resetPosthogClientsForTests } from './posthog-node';
import { decodeBatch, ours } from './posthog-wire.testkit';

const PERSON = `cs:${'a'.repeat(64)}`;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetPosthogClientsForTests();
});

describe('captureCheckoutEvent', () => {
  it('does not resolve until the purchase batch request finishes', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://ph.example.com');
    vi.stubEnv('POSTHOG_HOST', '');
    vi.stubEnv('POSTHOG_PROJECT_API_KEY', '');
    resetPosthogClientsForTests();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      await held;
      return new Response(JSON.stringify({ status: 'Ok' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    let settled = false;
    const pending = captureCheckoutEvent('purchase', PERSON, {
      currency: 'CAD',
      value: 59,
      amount: 59,
      plan: 'plus',
      tier: 'plus',
      interval: 'annual',
      region: 'CA',
      sku: 'promo_plus_annual',
    }).then((outcome) => {
      settled = true;
      return outcome;
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(settled).toBe(false);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://ph.example.com/batch/');
    const decoded = decodeBatch(init);
    expect(decoded.events).toHaveLength(1);
    expect(decoded.events[0]?.event).toBe('purchase');
    expect(decoded.events[0]?.distinct_id).toBe(PERSON);
    expect(ours(decoded.events[0]?.properties ?? {})).toMatchObject({
      currency: 'CAD',
      value: 59,
      amount: 59,
      plan: 'plus',
      region: 'CA',
    });

    release();
    await expect(pending).resolves.toBe('sent');
    expect(settled).toBe(true);
  });
});
