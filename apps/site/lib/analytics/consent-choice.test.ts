import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../../app/api/analytics/consent/route';
import { consentChoiceRequest } from './consent-choice';
import { captureConsentChoice, resetSiteCaptureAbsenceForTests } from './server-capture';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetSiteCaptureAbsenceForTests();
});

describe('consentChoiceRequest', () => {
  it('posts only the choice, with no cookie and no distinct id', () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'ph_test_key');
    const request = consentChoiceRequest('denied');
    expect(request?.url).toBe('/api/analytics/consent');
    expect(request?.init.credentials).toBe('omit');
    expect(request?.init.body).toBe(JSON.stringify({ choice: 'denied' }));
    expect(String(request?.init.body)).not.toContain('distinct');
  });

  it('skips the request when the product key is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    expect(consentChoiceRequest('granted')).toBeNull();
  });
});

describe('captureConsentChoice', () => {
  it('counts granted and denied with no visitor id and no person profile', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response('ok', { status: 200 });
    });
    const env = {
      FUNNEL_ATTRIBUTION_ENABLED: 'true',
      NEXT_PUBLIC_POSTHOG_KEY: 'ph_test_key',
    };
    expect(await captureConsentChoice('granted', env, fetchImpl)).toBe('sent');
    expect(await captureConsentChoice('denied', env, fetchImpl)).toBe('sent');
    const parsed = bodies.map((body) => JSON.parse(body) as Record<string, unknown>);
    expect(parsed).toEqual([
      expect.objectContaining({
        event: 'consent_choice',
        distinct_id: 'consent',
        properties: expect.objectContaining({
          choice: 'granted',
          $process_person_profile: false,
          $geoip_disable: true,
        }),
      }),
      expect.objectContaining({
        distinct_id: 'consent',
        properties: expect.objectContaining({ choice: 'denied', $process_person_profile: false }),
      }),
    ]);
    expect(JSON.stringify(parsed)).not.toContain('@');
    expect(JSON.stringify(parsed)).not.toContain('cookie');
  });

  it('does not call PostHog while the funnel flag is off', async () => {
    const fetchImpl = vi.fn();
    expect(
      await captureConsentChoice('denied', { NEXT_PUBLIC_POSTHOG_KEY: 'ph_test_key' }, fetchImpl),
    ).toBe('flag_off');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('POST /api/analytics/consent', () => {
  it('returns the named skip and does not call PostHog while the flag is off', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const res = await POST(
      new Request('https://www.villagehale.com/api/analytics/consent', {
        method: 'POST',
        body: JSON.stringify({ choice: 'denied' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'flag_off' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
