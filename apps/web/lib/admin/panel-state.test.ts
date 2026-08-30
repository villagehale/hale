import { describe, expect, it } from 'vitest';
import { serviceStateLine } from './panel-state';

describe('serviceStateLine', () => {
  it('names the missing env var for a not_configured outcome', () => {
    expect(
      serviceStateLine('PostHog', {
        ok: false,
        status: 'not_configured',
        detail: 'POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID not set',
      }),
    ).toBe('POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID not set.');
  });

  it('says the provider did not answer, keeping the link promise', () => {
    const line = serviceStateLine('Twilio', {
      ok: false,
      status: 'unreachable',
      detail: 'Twilio answered 503',
    });
    expect(line).toContain('Twilio didn’t answer');
    expect(line).toContain('link below still works');
  });
});
