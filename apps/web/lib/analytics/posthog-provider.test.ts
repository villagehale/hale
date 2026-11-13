import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  POSTHOG_AUTOCAPTURE_URL_ALLOWLIST,
  POSTHOG_INIT_CONFIG,
  POSTHOG_MASK_INPUT_SELECTOR,
  POSTHOG_PII_SELECTOR,
} from './posthog-provider';

/**
 * The "deploys safely now" contract: with no NEXT_PUBLIC_POSTHOG_KEY the
 * analytics layer must be a clean no-op — the module imports without throwing
 * and reports itself disabled, so nothing is initialised and no network call is
 * made. The key is read at module-eval time, so we reset modules and control the
 * env per case.
 */

const KEY = 'NEXT_PUBLIC_POSTHOG_KEY';
const WEB = 'NEXT_PUBLIC_POSTHOG_WEB_ENABLED';

describe('PostHog provider env-gating', () => {
  const originalKey = process.env[KEY];
  const originalWeb = process.env[WEB];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env[KEY];
    else process.env[KEY] = originalKey;
    if (originalWeb === undefined) delete process.env[WEB];
    else process.env[WEB] = originalWeb;
  });

  it('imports without throwing and is disabled when no key is set', async () => {
    delete process.env[KEY];
    process.env[WEB] = 'true';
    const mod = await import('./posthog-provider');
    expect(mod.analyticsEnabled()).toBe(false);
    expect(typeof mod.PostHogProvider).toBe('function');
    expect(typeof mod.useAnalytics).toBe('function');
  });

  it('stays disabled with a key while the web flag is unset', async () => {
    process.env[KEY] = 'phc_test_key';
    delete process.env[WEB];
    const mod = await import('./posthog-provider');
    expect(mod.analyticsEnabled()).toBe(false);
  });

  it('reports enabled only when a key is present AND the web flag is exactly true', async () => {
    process.env[KEY] = 'phc_test_key';
    process.env[WEB] = 'true';
    const mod = await import('./posthog-provider');
    expect(mod.analyticsEnabled()).toBe(true);
  });
});

/**
 * The session-replay + error-tracking posture (hard rule #1). Replay stays off
 * until NEXT_PUBLIC_POSTHOG_REPLAY_ENABLED is exactly `true` (VIL-483 default).
 * The masking pair is always configured so turning the flag on cannot record
 * children's names or typed phone/code values. Autocapture is allowlisted to
 * the phone-code door, never logged-in pages. Privacy-page copy is VIL-428.
 */
describe('PostHog replay + exception config', () => {
  it('does not record sessions on the portal while the replay flag is unset', () => {
    expect(POSTHOG_INIT_CONFIG.disable_session_recording).toBe(true);
  });

  it('masks every typed input value in the replay', () => {
    expect(POSTHOG_INIT_CONFIG.session_recording.maskAllInputs).toBe(true);
  });

  it('masks rendered PII text via the [data-hale-pii] selector', () => {
    expect(POSTHOG_PII_SELECTOR).toContain('[data-hale-pii]');
    expect(POSTHOG_PII_SELECTOR).toContain('[data-hale-mask-input]');
    expect(POSTHOG_INIT_CONFIG.session_recording.maskTextSelector).toBe(POSTHOG_PII_SELECTOR);
  });

  it('also names phone and code fields with rrweb mask/block classes', () => {
    expect(POSTHOG_MASK_INPUT_SELECTOR).toContain('ph-mask');
    expect(POSTHOG_MASK_INPUT_SELECTOR).toContain('ph-no-capture');
  });

  it('captures unhandled exceptions so errors link to the session replay', () => {
    expect(POSTHOG_INIT_CONFIG.capture_exceptions).toBe(true);
  });

  it('autocaptures only the phone-code login / sign-up door, never logged-in pages', () => {
    expect(POSTHOG_INIT_CONFIG.autocapture).toEqual({
      url_allowlist: POSTHOG_AUTOCAPTURE_URL_ALLOWLIST,
    });
    const joined = POSTHOG_AUTOCAPTURE_URL_ALLOWLIST.map((re) => re.source).join('\n');
    expect(joined).toContain('sign-in');
    expect(joined).not.toContain('/home');
    expect(joined).not.toContain('/family');
  });

  it('captures pageviews, pageleave, and heatmaps, and leaves web surveys on', () => {
    expect(POSTHOG_INIT_CONFIG.capture_pageview).toBe('history_change');
    expect(POSTHOG_INIT_CONFIG.capture_pageleave).toBe(true);
    expect(POSTHOG_INIT_CONFIG.capture_heatmaps).toBe(true);
    expect(POSTHOG_INIT_CONFIG.disable_surveys).toBe(false);
  });

  it('honours Do Not Track', () => {
    expect(POSTHOG_INIT_CONFIG.respect_dnt).toBe(true);
  });
});

/**
 * The privacy policy's PostHog disclosure must match the actual posture (VIL-483):
 * session replay runs only on the marketing site, masked, after cookie consent, and
 * the app does not record. Error tracking is on, autocapture stays off, identity is
 * an opaque id. Asserted against the page source so the legal copy can't silently
 * drift from the config.
 *
 * The policy itself now lives on the marketing site (D20 — the app's /privacy is a
 * 308 to it), but the config it describes lives HERE, so the guard stays beside the
 * config assertions above and reaches across to the page it must agree with.
 */
describe('privacy page PostHog disclosure', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../../site/app/[locale]/privacy/page.tsx', import.meta.url)),
    'utf8',
  );

  it('no longer claims session replay is turned off', () => {
    expect(source).not.toContain('session replay turned off');
  });

  it('says the app does not record and replay runs only on the marketing site', () => {
    expect(source).not.toContain('Session replay is on');
    expect(source).toContain('Session replay runs only on the marketing site');
    expect(source).toContain('only after the visitor taps Accept in the cookie banner');
    expect(source).toContain('app at app.villagehale.com does not record session replays');
  });

  it('discloses masked session replay, error tracking, and opaque-id identity', () => {
    expect(source).toContain('masked');
    expect(source).toContain('Error tracking');
    expect(source).toContain('opaque account id');
    expect(source).toContain('Autocapture stays off');
  });
});
