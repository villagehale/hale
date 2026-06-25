import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The "deploys safely now" contract: with no NEXT_PUBLIC_POSTHOG_KEY the
 * analytics layer must be a clean no-op — the module imports without throwing
 * and reports itself disabled, so nothing is initialised and no network call is
 * made. The key is read at module-eval time, so we reset modules and control the
 * env per case.
 */

const KEY = 'NEXT_PUBLIC_POSTHOG_KEY';

describe('PostHog provider env-gating', () => {
  const original = process.env[KEY];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('imports without throwing and is disabled when no key is set', async () => {
    delete process.env[KEY];
    const mod = await import('./posthog-provider');
    expect(mod.analyticsEnabled()).toBe(false);
    expect(typeof mod.PostHogProvider).toBe('function');
    expect(typeof mod.useAnalytics).toBe('function');
  });

  it('reports enabled once a key is present', async () => {
    process.env[KEY] = 'phc_test_key';
    const mod = await import('./posthog-provider');
    expect(mod.analyticsEnabled()).toBe(true);
  });
});
