import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import sitemap from './sitemap.js';
import PrivacyPage, { metadata as privacyMetadata } from './privacy/page.js';
import TermsPage, { metadata as termsMetadata } from './terms/page.js';

/**
 * B-legal (VIL-250 · M14) — terms and privacy get canonical homes on the
 * marketing domain, in the landing's design system. The copy migrated verbatim
 * from the app's pages (a legal-copy change is its own change) with exactly one
 * planned addition: the SMS-transit disclosure from Technical Design §7, which
 * has to exist before the Twilio soft-launch.
 *
 * The routes ship unlinked and noindexed — nothing points at them until the
 * landing flips, so a crawler must not index a second copy of a policy while
 * app.villagehale.com still serves the canonical one.
 */

const termsHtml = renderToStaticMarkup(createElement(TermsPage));
const privacyHtml = renderToStaticMarkup(createElement(PrivacyPage));

/** Every TOC target must exist in the body — a dead anchor in a policy is a broken policy. */
function danglingAnchors(html: string): string[] {
  const targets = [...html.matchAll(/href="#([a-z-]+)"/g)].flatMap((m) => (m[1] ? [m[1]] : []));
  return [...new Set(targets)].filter((id) => !html.includes(`id="${id}"`));
}

describe('legal routes (unlinked until the flip)', () => {
  it('are noindex, nofollow while the app still serves the canonical copy', () => {
    expect(termsMetadata.robots).toEqual({ index: false, follow: false });
    expect(privacyMetadata.robots).toEqual({ index: false, follow: false });
  });

  it('claim their own canonical rather than inheriting the homepage’s', () => {
    expect(termsMetadata.alternates?.canonical).toBe('/terms');
    expect(privacyMetadata.alternates?.canonical).toBe('/privacy');
  });

  it('are absent from the sitemap', () => {
    for (const entry of sitemap()) {
      expect(entry.url.endsWith('/terms')).toBe(false);
      expect(entry.url.endsWith('/privacy')).toBe(false);
    }
  });

  it('carry no signup funnel', () => {
    for (const html of [termsHtml, privacyHtml]) {
      expect(html).not.toContain('/onboarding');
      expect(html).not.toContain('Get started');
    }
  });
});

describe('legal pages (long-form shell)', () => {
  it('give each page a table of contents whose every link lands on a real section', () => {
    for (const html of [termsHtml, privacyHtml]) {
      expect(html).toContain('On this page');
      expect(danglingAnchors(html)).toEqual([]);
    }
  });

  it('cross-link the two policies', () => {
    expect(termsHtml).toContain('href="/privacy"');
    expect(privacyHtml).toContain('href="/terms"');
  });

  it('says plainly that the document is not legal advice', () => {
    for (const html of [termsHtml, privacyHtml]) {
      expect(html).toContain('is not legal advice');
    }
  });
});

describe('terms (migrated verbatim)', () => {
  it('keeps the approval model, the AI disclaimer, and Ontario governing law', () => {
    expect(termsHtml).toContain('Hale drafts; you decide.');
    expect(termsHtml).toContain(
      'Hale is not a substitute for professional advice. It does not provide medical, legal,',
    );
    expect(termsHtml).toContain('governed by the laws of the Province of Ontario');
    expect(termsHtml).toContain('Village Hale Technologies Inc.');
  });
});

describe('privacy (migrated verbatim, plus the SMS-transit disclosure)', () => {
  it('keeps the Canadian residency, teen-redaction, and rights sections', () => {
    expect(privacyHtml).toContain('redacted from parents by default');
    expect(privacyHtml).toContain('Toronto');
    expect(privacyHtml).toContain('Office of the Privacy Commissioner of Canada');
    expect(privacyHtml).toContain('privacy@villagehale.com');
  });

  it('discloses that SMS is not end-to-end encrypted and transits carriers and Twilio', () => {
    expect(privacyHtml).toContain('not end-to-end encrypted');
    expect(privacyHtml).toContain('Twilio');
    expect(privacyHtml).toContain('United States');
  });

  it('names what is held back from a text message by design', () => {
    expect(privacyHtml).toContain('names the task, never the condition');
    expect(privacyHtml).toContain('reply STOP');
  });

  it('lists the SMS section in the table of contents', () => {
    expect(privacyHtml).toContain('href="#sms"');
    expect(privacyHtml).toContain('id="sms"');
  });
});
