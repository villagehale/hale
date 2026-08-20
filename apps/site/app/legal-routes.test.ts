import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import sitemap from './sitemap.js';
import PrivacyPage, { generateMetadata as privacyGenerateMetadata } from './[locale]/privacy/page.js';
import TermsPage, { generateMetadata as termsGenerateMetadata } from './[locale]/terms/page.js';

const EN = () => ({ params: Promise.resolve({ locale: 'en' as const }) });

/**
 * B-legal (VIL-250 · M14) — terms and privacy get canonical homes on the
 * marketing domain, in the landing's design system. The copy migrated verbatim
 * from the app's pages (a legal-copy change is its own change) with exactly one
 * planned addition: the SMS-transit disclosure from Technical Design §7, which
 * has to exist before the Twilio soft-launch.
 *
 * The routes ship noindexed. That first held back a second indexable copy of a
 * live policy; since VIL-256 made app.villagehale.com/{terms,privacy} permanent
 * 308s here these are the only copies, and the noindex now simply holds with the
 * rest of the dark marketing pivot until the flip. The footer links them either
 * way — noindex is not unreachable.
 */

const termsHtml = renderToStaticMarkup(await TermsPage(EN()));
const privacyHtml = renderToStaticMarkup(await PrivacyPage(EN()));
const termsMetadata = await termsGenerateMetadata(EN());
const privacyMetadata = await privacyGenerateMetadata(EN());

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

  /**
   * The terms were written before the messaging-first pivot and before dual auth,
   * so the governing document for a texting product described a Google-only
   * sign-in and never mentioned texting at all — a contradiction a reader hits
   * two clicks after the homepage. These pin the corrections; each one maps to a
   * shipped fact (SMS is the product surface, sign-in is Google + password, STOP
   * ends the conversation, carrier rates are the reader's).
   */
  it('governs the product that actually exists — a number you text, not a Google-only app', () => {
    expect(termsHtml).not.toContain('You sign in through Google.');
    expect(termsHtml).not.toContain('passive, event-driven assistant');
    expect(termsHtml).toContain('a phone number your family texts');
    expect(termsHtml).toContain('a Google account or an email address and password');
    // Agreement is reachable without an account, because most families never make one.
    expect(termsHtml).toContain('By texting Hale, creating an account, or otherwise using Hale');
  });

  it('carries the text-channel terms that lived only in the privacy policy', () => {
    expect(termsHtml).toContain('Reply STOP to any message and the messages stop');
    expect(termsHtml).toContain('reply HELP for help');
    expect(termsHtml).toContain('Standard message and data rates from your mobile carrier apply');
    expect(termsHtml).toContain('never text a number that has not texted us first');
    expect(termsHtml).toContain('id="text-messages"');
  });

  it('keeps every internal link inside the reader’s locale', async () => {
    // /fr/terms used to drop a reader into the English policy mid-document,
    // because two hrefs were hardcoded while every other link went through
    // localeHref. Rendered here in EN, where localeHref('/privacy') is '/privacy'
    // — so the pin is that NO raw href escapes the helper.
    const frTerms = renderToStaticMarkup(
      await TermsPage({ params: Promise.resolve({ locale: 'fr' as const }) }),
    );
    for (const href of [...frTerms.matchAll(/href="(\/[a-z/-]*)"/g)]) {
      expect(href[1], `${href[1]} is not locale-prefixed`).toMatch(/^\/fr(\/|$)/);
    }
    // Positive control: the document really does link out internally.
    expect(frTerms).toContain('href="/fr/privacy"');
  });
});

describe('privacy (migrated verbatim, plus the SMS-transit disclosure)', () => {
  it('keeps the Canadian residency, teen-redaction, and rights sections', () => {
    expect(privacyHtml).toContain('redacted from parents by default');
    expect(privacyHtml).toContain('Toronto');
    expect(privacyHtml).toContain('Office of the Privacy Commissioner of Canada');
    expect(privacyHtml).toContain('privacy@villagehale.com');
  });

  /**
   * VIL-147 · this page is a legal promise, so it may only describe teen controls
   * that actually exist. Each assertion maps to shipped behaviour in apps/web:
   * teen assent before anything opens and the bounded window (isTeenGrantActive,
   * MAX_GRANT_WINDOW_MS = 7 days), the 24h escalation (SAFETY_ESCALATION_WINDOW_MS),
   * and the two honest limits — in-app only (teen-access-outbound.test.ts) and the
   * undelivered teen notification (undeliverableTeenNotifier). If a control is ever
   * removed, this fails before the copy can keep claiming it.
   */
  it('describes only the teen access controls that are actually built', () => {
    expect(privacyHtml).toContain('only if the teen agrees');
    expect(privacyHtml).toContain('at most seven days');
    expect(privacyHtml).toContain('credible risk of harm');
    expect(privacyHtml).toContain('24 hours');
    expect(privacyHtml).toContain('access is only ever in-app');
    // The honest v1 state: a teen cannot be reached, so nothing can be granted yet.
    // If a future change enables activation, this assertion must be removed on
    // purpose — the copy can never quietly outrun the implementation again.
    expect(privacyHtml).toContain('no way to contact a teen at all');
    expect(privacyHtml).toContain('no request can be granted yet');
    expect(privacyHtml).toContain('it is policy, not a button');
    // And it must no longer use the old blanket "planned" hedge.
    expect(privacyHtml).not.toContain('not yet available');
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
