import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { POSTHOG_AUTOCAPTURE_URL_ALLOWLIST, POSTHOG_INIT_CONFIG } from './posthog-provider';

/**
 * THE MARKETING SITE'S POSTHOG POSTURE, and the legal page that depends on it.
 *
 * PostHog on this site is still storage-free (`persistence: 'memory'`). Google Ads
 * is a separate head tag that may set advertising cookies — that pairing lives in
 * google-ads.test.ts, not here. This file keeps PostHog and the sentences that
 * describe it from drifting: a future `persistence: 'localStorage+cookie'` would
 * make the PostHog bullet wrong, and fails here instead.
 *
 * Expected values are derived from the posture (anonymous, explicit-only, storage-free),
 * not echoed back from the config.
 */

const privacyPage = readFileSync(
  fileURLToPath(new URL('../../app/[locale]/privacy/page.tsx', import.meta.url)),
  'utf8',
);

describe('marketing-site PostHog posture', () => {
  it('writes nothing to the visitor: persistence is in memory only', () => {
    expect(POSTHOG_INIT_CONFIG.persistence).toBe('memory');
  });

  it('keeps replay off until NEXT_PUBLIC_POSTHOG_REPLAY_ENABLED, with inputs always masked', () => {
    // Default-off is the launch gate. Masking stays configured so turning the
    // flag on cannot record a typed value. Persistence stays in memory (above),
    // which is what keeps the privacy policy's write-nothing sentence true.
    // Privacy-page copy that names when replay runs is VIL-428.
    expect(POSTHOG_INIT_CONFIG.disable_session_recording).toBe(true);
    expect(POSTHOG_INIT_CONFIG.session_recording.maskAllInputs).toBe(true);
  });

  it('autocaptures only the landing page and /privacy / /terms, never a named funnel by inference', () => {
    expect(POSTHOG_INIT_CONFIG.autocapture).toEqual({
      url_allowlist: POSTHOG_AUTOCAPTURE_URL_ALLOWLIST,
    });
    const joined = POSTHOG_AUTOCAPTURE_URL_ALLOWLIST.map((re) => re.source).join('\n');
    expect(joined).toContain('privacy');
    expect(joined).toContain('terms');
  });

  it('captures heatmaps and keeps surveys off (surveys live on the logged-in dashboard)', () => {
    expect(POSTHOG_INIT_CONFIG.capture_heatmaps).toBe(true);
    expect(POSTHOG_INIT_CONFIG.disable_surveys).toBe(true);
  });

  it('captures pageviews on every client-side navigation, and page leaves', () => {
    // Attribution rides as a super property registered in `loaded`, which posthog-js
    // runs before its initial pageview (posthog-provider.tsx).
    expect(POSTHOG_INIT_CONFIG.capture_pageview).toBe('history_change');
    expect(POSTHOG_INIT_CONFIG.capture_pageleave).toBe(true);
  });

  it('keeps web vitals on', () => {
    expect(POSTHOG_INIT_CONFIG.capture_performance.web_vitals).toBe(true);
  });

  it('honours Do Not Track', () => {
    expect(POSTHOG_INIT_CONFIG.respect_dnt).toBe(true);
  });
});

describe('the privacy policy still matches that posture', () => {
  it('is the page we think it is', () => {
    // Positive control for the absence assertions below: prove this file is the policy
    // and that it does discuss cookies where it has something true to say (Vercel).
    expect(privacyPage).toContain('<strong>PostHog</strong>');
    expect(privacyPage).toContain('cookieless');
  });

  it('still describes PostHog as writing nothing to the visitor’s device', () => {
    // Google Ads may set advertising cookies (google-ads.test.ts). PostHog must not
    // quietly start doing the same, or this sentence becomes a lie.
    expect(privacyPage).toContain('On the marketing site, PostHog is configured');
    expect(privacyPage).toContain('to write nothing to your device');
    expect(privacyPage).not.toContain('Tracking Technologies');
  });
});
