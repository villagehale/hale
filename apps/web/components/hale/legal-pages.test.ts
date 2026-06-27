import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PrivacyPage from '~/app/privacy/page';
import TermsPage from '~/app/terms/page';

/**
 * The Terms and Privacy pages are the consent step the onboarding wizard links
 * to, so they must carry real, complete policy copy — not the old placeholder.
 * We render each page to static markup and assert the load-bearing sections are
 * present and the stub text is gone. Assertions trace to the legal requirements
 * (PIPEDA / Law 25 / CASL for Privacy; eligibility + AI disclaimer + liability
 * for Terms), not to whatever the components happen to emit.
 */

const privacyHtml = renderToStaticMarkup(PrivacyPage());
const termsHtml = renderToStaticMarkup(TermsPage());

const STUB_PHRASES = ['being finalized', 'placeholder'];

describe('Privacy Policy page', () => {
  it('no longer shows the placeholder copy', () => {
    for (const phrase of STUB_PHRASES) {
      expect(privacyHtml).not.toContain(phrase);
    }
  });

  it('covers the required privacy sections', () => {
    for (const heading of [
      'What we collect',
      'Children&#x27;s data',
      'Teen privacy',
      'AI and automated processing',
      'Sub-processors',
      'Your rights',
      'CASL',
    ]) {
      expect(privacyHtml).toContain(heading);
    }
  });

  it('names every disclosed sub-processor', () => {
    for (const processor of [
      'Anthropic',
      'Google Maps',
      'Supabase',
      'Vercel',
      'Langfuse',
      'Resend',
      'PostHog',
    ]) {
      expect(privacyHtml).toContain(processor);
    }
  });

  it('discloses PostHog as coarse, no-child-data analytics and Vercel as cookieless', () => {
    expect(privacyHtml).toContain('no child data');
    expect(privacyHtml).toContain('cookieless');
  });

  it('states the Canadian data residency and the regulators to complain to', () => {
    expect(privacyHtml).toContain('Toronto');
    expect(privacyHtml).toContain('Privacy Commissioner of Canada');
    expect(privacyHtml).toContain('Commission d’accès à l’information du Québec');
  });

  it('describes the teen redaction default and marks grant/escalation as planned', () => {
    expect(privacyHtml).toContain('redacted from parents by default');
    expect(privacyHtml).toContain('safety-escalation');
    expect(privacyHtml).toContain('not yet available');
  });

  it('carries the not-legal-advice caveat and the last-updated date', () => {
    expect(privacyHtml).toContain('not legal advice');
    expect(privacyHtml).toContain('June 25, 2026');
  });

  it('links to the Terms of Service', () => {
    expect(privacyHtml).toContain('href="/terms"');
  });
});

describe('Terms of Service page', () => {
  it('no longer shows the placeholder copy', () => {
    for (const phrase of STUB_PHRASES) {
      expect(termsHtml).not.toContain(phrase);
    }
  });

  it('covers eligibility, the approval model, and the AI disclaimer', () => {
    expect(termsHtml).toContain('18 years old');
    expect(termsHtml).toContain('Hale drafts; you decide');
    expect(termsHtml).toContain('AI disclaimer');
    expect(termsHtml).toContain('not a substitute for professional advice');
  });

  it('warns that Hale is not medical advice and to use emergency services', () => {
    expect(termsHtml).toContain('does not provide medical');
    expect(termsHtml).toContain('emergency services');
  });

  it('disclaims warranty and limits liability under Ontario law', () => {
    expect(termsHtml).toContain('as is');
    expect(termsHtml).toContain('Limitation of liability');
    expect(termsHtml).toContain('Province of Ontario');
  });

  it('carries the not-legal-advice caveat and the last-updated date', () => {
    expect(termsHtml).toContain('not legal advice');
    expect(termsHtml).toContain('June 25, 2026');
  });

  it('links to the Privacy Policy', () => {
    expect(termsHtml).toContain('href="/privacy"');
  });
});
