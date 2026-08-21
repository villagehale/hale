import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { POSTHOG_INIT_CONFIG } from './posthog-provider';

/**
 * THE MARKETING SITE'S ANALYTICS POSTURE, and the legal page that depends on it.
 *
 * The privacy policy has no Tracking Technologies / cookie section, deliberately — see
 * the header comment on app/[locale]/privacy/page.tsx, which named the marketing site's
 * unset `persistence` as the reason it could not yet be described. `persistence:
 * 'memory'` is what settles that: the site writes NOTHING to a visitor's device, so
 * there is no cookie table to omit. This file is the gate that keeps the two agreeing —
 * a future `persistence: 'localStorage+cookie'` would make the legal page wrong, and
 * fails here instead.
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

  it('makes no cookie claim about the marketing site it would now have to describe', () => {
    // Not "there is no cookie section" — that is true today and would stay true after a
    // regression. The pairing that matters: memory persistence above, no cookie table
    // here. Either one changing without the other is the drift.
    expect(privacyPage).not.toContain('Tracking Technologies');
    expect(privacyPage).not.toMatch(/marketing site[^.]*cookie/i);
  });
});
