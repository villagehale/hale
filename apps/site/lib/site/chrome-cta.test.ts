import { afterEach, describe, expect, it, vi } from 'vitest';
import { F14_LANDING_ENV } from '~/lib/flags/landing';
import { chromeCta, featuresHref } from './chrome-cta';

/**
 * The shared header and footer wrap every page except the homepage, so whatever
 * they point at is the product's real front door on eleven surfaces. Under F14 the
 * homepage closed the signup funnel; these assertions are what stop the chrome from
 * quietly re-opening it.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('site chrome CTA', () => {
  it('keeps the signup funnel while the F14 landing is dark', () => {
    vi.stubEnv(F14_LANDING_ENV, '');
    expect(chromeCta()).toEqual({
      label: 'Get started',
      href: 'https://app.villagehale.com/onboarding',
    });
  });

  it('sends a reader to the composer once the landing is flipped on', () => {
    vi.stubEnv(F14_LANDING_ENV, 'true');
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
    const cta = chromeCta();
    expect(cta.label).toBe('Text Hale');
    expect(cta.href).toBe('sms:+16475551234?&body=Hi');
    expect(cta.href).not.toContain('/onboarding');
  });

  it('degrades to email rather than a dead sms: link when no number is provisioned', () => {
    vi.stubEnv(F14_LANDING_ENV, 'true');
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '');
    const cta = chromeCta();
    expect(cta.href).toBe('mailto:aloha@villagehale.com');
    expect(cta.href).not.toContain('sms:');
  });

  it('stops pointing at #features when the homepage that has one is not being served', () => {
    vi.stubEnv(F14_LANDING_ENV, '');
    expect(featuresHref()).toBe('/#features');
    vi.stubEnv(F14_LANDING_ENV, 'true');
    expect(featuresHref()).toBe('/');
  });
});
