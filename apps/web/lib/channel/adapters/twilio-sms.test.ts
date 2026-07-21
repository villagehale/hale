import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderedContent } from '../types';
import { createTwilioSmsChannel } from './twilio-sms';

// The SMS leg adapter (VIL-213 · A2) — scaffold. Twilio isn't provisioned (A3), so
// today it always skips not_configured; when the three creds are present it throws a
// clear "not implemented" so a half-configured deploy fails loudly. Rule #1: no test
// asserts a phone number or body reaching a log.
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SMS: Extract<RenderedContent, { kind: 'sms' }> = { kind: 'sms', text: 'A check-up is coming up' };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createTwilioSmsChannel().send', () => {
  it('skips not_configured while Twilio is unprovisioned', async () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', '');
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');
    vi.stubEnv('TWILIO_FROM_NUMBER', '');

    const outcome = await createTwilioSmsChannel().send({ userId: USER_ID, rendered: SMS });

    expect(outcome).toEqual({ status: 'skipped', reason: 'not_configured' });
  });

  it('throws not-implemented when all three creds are present (the A3 seam)', async () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC_test');
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'tok_test');
    vi.stubEnv('TWILIO_FROM_NUMBER', '+15005550006');

    await expect(createTwilioSmsChannel().send({ userId: USER_ID, rendered: SMS })).rejects.toThrow(
      'twilio send not implemented',
    );
  });
});
