import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { POSTHOG_INIT_CONFIG } from './posthog-provider';

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

  it('never records a session on the marketing site', () => {
    expect(POSTHOG_INIT_CONFIG.disable_session_recording).toBe(true);
  });

  it('infers nothing: autocapture is off, so every event is a named call site', () => {
    expect(POSTHOG_INIT_CONFIG.autocapture).toBe(false);
  });

  it('leaves the pageview to the provider, which stamps attribution on it first', () => {
    expect(POSTHOG_INIT_CONFIG.capture_pageview).toBe(false);
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
