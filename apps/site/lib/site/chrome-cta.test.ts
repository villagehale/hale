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
    expect(cta.href).toBe(
      'sms:+16475551234?&body=Maya%20is%204%2C%20Theo%20is%2018%20months%2C%20L3R',
    );
    expect(cta.href).not.toContain('/onboarding');
  });

  it('degrades to email rather than a dead sms: link when no number is provisioned', () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '');
    const cta = chromeCta();
    expect(cta.href).toBe('mailto:aloha@villagehale.com');
    expect(cta.href).not.toContain('sms:');
  });
});
