import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POSTHOG_INIT_CONFIG, POSTHOG_PII_SELECTOR } from './posthog-provider';

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

/**
 * The session-replay + error-tracking posture (hard rule #1). Hale shows
 * newborn/child PII on screen, so the recording config MUST: record (replay on),
 * mask every typed value, mask the PII text marked at the render sites, and
 * capture exceptions into the same session. Expected values come from that
 * requirement, not from echoing the config back.
 */
describe('PostHog replay + exception config', () => {
  it('records sessions — recording is NOT disabled', () => {
    expect(POSTHOG_INIT_CONFIG.disable_session_recording).toBe(false);
  });

  it('masks every typed input value in the replay', () => {
    expect(POSTHOG_INIT_CONFIG.session_recording.maskAllInputs).toBe(true);
  });

  it('masks rendered PII text via the [data-hale-pii] selector', () => {
    expect(POSTHOG_PII_SELECTOR).toBe('[data-hale-pii]');
    expect(POSTHOG_INIT_CONFIG.session_recording.maskTextSelector).toBe('[data-hale-pii]');
  });

  it('captures unhandled exceptions so errors link to the session replay', () => {
    expect(POSTHOG_INIT_CONFIG.capture_exceptions).toBe(true);
  });

  it('never turns autocapture on', () => {
    expect(POSTHOG_INIT_CONFIG.autocapture).toBe(false);
  });
});

/**
 * The privacy policy's PostHog disclosure must match the actual posture: replay
 * is ON with inputs + personal data masked, error tracking is on, autocapture
 * stays off, identity is an opaque id. The old "session replay turned off" claim
 * is now false and must be gone. Asserted against the page source so the legal
 * copy can't silently drift from the config.
 */
describe('privacy page PostHog disclosure', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../app/privacy/page.tsx', import.meta.url)),
    'utf8',
  );

  it('no longer claims session replay is turned off', () => {
    expect(source).not.toContain('session replay turned off');
  });

  it('discloses masked session replay, error tracking, and opaque-id identity', () => {
    expect(source).toContain('Session replay is on');
    expect(source).toContain('masked');
    expect(source).toContain('Error tracking');
    expect(source).toContain('opaque account id');
    expect(source).toContain('Autocapture stays off');
  });
});
