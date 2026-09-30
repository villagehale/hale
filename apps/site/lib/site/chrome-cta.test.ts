import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromeCta } from './chrome-cta';

/**
 * The shared header and footer wrap every page, so whatever they point at is the
 * product's real front door across the site. There is no signup; these assertions
 * are what stop the chrome from quietly re-opening one.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('site chrome CTA', () => {
  it('sends a reader to the composer', () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
    const cta = chromeCta();
    expect(cta.label).toBe('Text Hale');
    expect(cta.href).toBe('sms:+16475551234?&body=Hey%20Hale%2C%20what%27s%20going%20on%3F');
    expect(cta.href).not.toContain('/onboarding');
  });

  it('prefills the French twin on a French page, still the cross-platform form', () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
    const cta = chromeCta('fr');
    expect(cta.label).toBe('Texter Hale');
    expect(cta.href).toContain('sms:+16475551234?&body=');
    expect(cta.href).toContain('Salut%20Hale');
    expect(cta.href).toContain('%27');
    expect(cta.href).not.toContain('%E2%80%99');
    expect(decodeURIComponent(cta.href.slice(cta.href.indexOf('body=') + 5))).toBe(
      "Salut Hale, qu'est-ce qui se passe?",
    );
  });

  it('degrades to email rather than a dead sms: link when no number is provisioned', () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '');
    const cta = chromeCta();
    expect(cta.href).toBe('mailto:aloha@villagehale.com');
    expect(cta.href).not.toContain('sms:');
  });
});
