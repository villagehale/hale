// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { readConsent, readStoredConsent, writeConsent } from './consent';
import {
  CONSENT_GEO_HEADER,
  consentDecisionFromHeaders,
  consentModeForGeo,
  measurementAllowed,
  parseConsentGeoOverride,
} from './consent-region';

function headers(values: Record<string, string | null>): { get(name: string): string | null } {
  return {
    get(name: string) {
      return values[name.toLowerCase()] ?? null;
    },
  };
}

describe('consent region', () => {
  it('keeps Quebec opt-in and Ontario and the US default-on', () => {
    expect(consentModeForGeo('CA', 'QC')).toBe('opt-in');
    expect(consentModeForGeo('ca', 'qc')).toBe('opt-in');
    expect(consentModeForGeo('CA', 'CA-QC')).toBe('opt-in');
    expect(consentModeForGeo('CA', 'Quebec')).toBe('opt-in');
    expect(consentModeForGeo('CA', 'ON')).toBe('opt-out');
    expect(consentModeForGeo('CA', 'BC')).toBe('opt-out');
    expect(consentModeForGeo('US', null)).toBe('opt-out');
    expect(consentModeForGeo('US', 'CA')).toBe('opt-out');
    expect(consentModeForGeo('US', 'NY')).toBe('opt-out');
  });

  it('keeps the EU, the EEA, the UK, and Switzerland opt-in', () => {
    for (const country of ['DE', 'FR', 'IE', 'SE', 'IS', 'LI', 'NO', 'GB', 'UK', 'CH']) {
      expect(consentModeForGeo(country, null), country).toBe('opt-in');
    }
  });

  it('treats an unknown country, and Canada with no province, as opt-in', () => {
    expect(consentModeForGeo(null, null)).toBe('opt-in');
    expect(consentModeForGeo('', '')).toBe('opt-in');
    expect(consentModeForGeo('  ', null)).toBe('opt-in');
    expect(consentModeForGeo('XX', null)).toBe('opt-in');
    expect(consentModeForGeo('T1', null)).toBe('opt-in');
    expect(consentModeForGeo('CA', null)).toBe('opt-in');
    expect(consentModeForGeo('CA', '')).toBe('opt-in');
    expect(consentModeForGeo('CA', 'not-a-province')).toBe('opt-in');
  });

  it('loads by default only outside an opt-in region, and never when GPC is set', () => {
    expect(
      measurementAllowed({ stored: null, mode: consentModeForGeo('CA', 'ON'), gpc: false }),
    ).toBe(true);
    expect(
      measurementAllowed({ stored: null, mode: consentModeForGeo('US', 'NY'), gpc: false }),
    ).toBe(true);
    expect(
      measurementAllowed({ stored: null, mode: consentModeForGeo('CA', 'QC'), gpc: false }),
    ).toBe(false);
    expect(
      measurementAllowed({ stored: null, mode: consentModeForGeo(null, null), gpc: false }),
    ).toBe(false);
    expect(
      measurementAllowed({ stored: null, mode: consentModeForGeo('US', null), gpc: true }),
    ).toBe(false);
    expect(
      measurementAllowed({ stored: null, mode: consentModeForGeo('CA', 'ON'), gpc: true }),
    ).toBe(false);
  });

  it('keeps a stored opt-out off, and a stored Accept on, in every region', () => {
    expect(
      measurementAllowed({ stored: 'denied', mode: consentModeForGeo('US', null), gpc: false }),
    ).toBe(false);
    expect(
      measurementAllowed({ stored: 'denied', mode: consentModeForGeo('CA', 'ON'), gpc: false }),
    ).toBe(false);
    expect(
      measurementAllowed({ stored: 'granted', mode: consentModeForGeo('CA', 'QC'), gpc: false }),
    ).toBe(true);
    expect(
      measurementAllowed({ stored: 'granted', mode: consentModeForGeo('US', null), gpc: true }),
    ).toBe(true);
  });
});

describe('preview geo override', () => {
  it('parses a country, a country-region, and unknown', () => {
    expect(parseConsentGeoOverride('US')).toEqual({ country: 'US', region: null });
    expect(parseConsentGeoOverride('ca-qc')).toEqual({ country: 'CA', region: 'QC' });
    expect(parseConsentGeoOverride('unknown')).toEqual({ country: null, region: null });
    expect(parseConsentGeoOverride('nope')).toBeNull();
    expect(parseConsentGeoOverride('')).toBeNull();
  });

  it('uses the override outside production and ignores it in production', () => {
    const list = headers({
      'x-vercel-ip-country': 'CA',
      'x-vercel-ip-country-region': 'QC',
      [CONSENT_GEO_HEADER]: 'US',
    });
    expect(consentDecisionFromHeaders(list, { VERCEL_ENV: 'preview' })).toEqual({
      mode: 'opt-out',
      gpc: false,
    });
    expect(consentDecisionFromHeaders(list, { VERCEL_ENV: 'production' })).toEqual({
      mode: 'opt-in',
      gpc: false,
    });
    expect(
      consentDecisionFromHeaders(
        headers({
          'x-vercel-ip-country': 'US',
          [CONSENT_GEO_HEADER]: 'unknown',
        }),
        { VERCEL_ENV: 'preview' },
      ),
    ).toEqual({ mode: 'opt-in', gpc: false });
  });

  it('reads Sec-GPC from the request', () => {
    expect(
      consentDecisionFromHeaders(headers({ 'x-vercel-ip-country': 'US', 'sec-gpc': '1' }), {
        VERCEL_ENV: 'production',
      }),
    ).toEqual({ mode: 'opt-out', gpc: true });
    expect(
      measurementAllowed({
        stored: null,
        mode: consentDecisionFromHeaders(headers({ 'x-vercel-ip-country': 'US', 'sec-gpc': '1' }), {
          VERCEL_ENV: 'production',
        }).mode,
        gpc: true,
      }),
    ).toBe(false);
  });
});

describe('stored opt-out survives a default-on region', () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-consent');
    document.documentElement.removeAttribute('data-consent-mode');
    document.documentElement.removeAttribute('data-gpc');
  });

  it('does not load after Turn off, and does load with no choice in that region', () => {
    document.documentElement.dataset.consentMode = 'opt-out';
    expect(readStoredConsent()).toEqual({ choice: null, blocked: false });
    expect(readConsent()).toBe('granted');
    expect(writeConsent('denied')).toBe(true);
    expect(readStoredConsent()).toEqual({ choice: 'denied', blocked: false });
    expect(readConsent()).toBe('denied');
    document.documentElement.dataset.consentMode = 'opt-out';
    expect(readConsent()).toBe('denied');
  });

  it('does not load when the document carries Global Privacy Control', () => {
    document.documentElement.dataset.consentMode = 'opt-out';
    document.documentElement.dataset.gpc = '1';
    expect(readConsent()).toBeNull();
  });

  it('stays opt-in when the region was not set', () => {
    expect(readConsent()).toBeNull();
  });
});
