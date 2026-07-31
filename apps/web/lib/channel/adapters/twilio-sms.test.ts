import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderedContent } from '../types';
import { createTwilioSmsChannel } from './twilio-sms';

// The LOOP's SMS leg adapter (VIL-213 · A2) — still a scaffold after VIL-214 · A3,
// which built the raw send behind M2's bare-E.164 transport instead. This seam is
// handed a userId and no phone, and the reader that resolves one to a SENDABLE number
// does not exist yet. Rule #1: no test asserts a phone number or body reaching a log.
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SMS: Extract<RenderedContent, { kind: 'sms' }> = { kind: 'sms', text: 'A check-up is coming up' };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createTwilioSmsChannel().send', () => {
  it('skips not_configured while the loop leg is unwired', async () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', '');
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');
    vi.stubEnv('TWILIO_FROM_NUMBER', '');

    const outcome = await createTwilioSmsChannel().send({ userId: USER_ID, rendered: SMS });

    expect(outcome).toEqual({ status: 'skipped', reason: 'not_configured' });
  });

  it('still skips — never throws — once A3 sets the credentials for the INBOUND webhook', async () => {
    // The regression this locks: these creds now power the Twilio webhook, so their
    // presence says nothing about THIS leg. Throwing here would fail every loop SMS
    // job the moment A3's env vars land in prod.
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC_test');
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'tok_test');
    vi.stubEnv('TWILIO_API_KEY_SID', 'SK_test');
    vi.stubEnv('TWILIO_API_KEY_SECRET', 'secret_test');
    vi.stubEnv('TWILIO_FROM_NUMBER', '+15005550006');

    const outcome = await createTwilioSmsChannel().send({ userId: USER_ID, rendered: SMS });

    expect(outcome).toEqual({ status: 'skipped', reason: 'not_configured' });
  });

  it('refuses content that is not SMS — a wiring bug, not a runtime condition', async () => {
    await expect(
      createTwilioSmsChannel().send({
        userId: USER_ID,
        rendered: { kind: 'push', title: 'x', body: 'y' },
      }),
    ).rejects.toThrow(/received push content/);
  });
});
