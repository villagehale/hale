import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import type { RenderedContent } from '../types';
import { createTwilioSmsChannel } from './twilio-sms';

// The LOOP's SMS leg adapter (VIL-213 · A2, lit up by VIL-260): resolve the parent's
// number, gate on the Twilio config, and hand the rendered text to A3's transport.
// We fake the transport and the resolver — no Twilio, no db. Rule #1: no test asserts a
// phone number or body reaching a log.
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SMS: Extract<RenderedContent, { kind: 'sms' }> = {
  kind: 'sms',
  text: 'A check-up is coming up',
};
const PHONE = '+14165550100';

/** A transport that refuses every send with the given error. */
function refusingTransport(error: unknown) {
  return {
    async send(): Promise<{ providerMessageId: string }> {
      throw error;
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createTwilioSmsChannel().send', () => {
  it('sends the rendered text to the resolved number and returns Twilio’s id', async () => {
    const transport = new FakeTransport();

    const outcome = await createTwilioSmsChannel({
      transport,
      resolveTarget: async () => PHONE,
      configured: true,
    }).send({ userId: USER_ID, rendered: SMS });

    expect(outcome).toEqual({ status: 'sent', providerMessageId: 'fake-out-1' });
    expect(transport.sent).toEqual([{ to: PHONE, body: SMS.text }]);
  });

  it('skips no_address (never sends) for a parent with no live SMS channel', async () => {
    const transport = new FakeTransport();

    const outcome = await createTwilioSmsChannel({
      transport,
      resolveTarget: async () => null,
      configured: true,
    }).send({ userId: USER_ID, rendered: SMS });

    expect(outcome).toEqual({ status: 'skipped', reason: 'no_address' });
    expect(transport.sent).toEqual([]);
  });

  it('skips not_configured (never resolves a number) while the leg is unprovisioned', async () => {
    const transport = new FakeTransport();
    const resolveTarget = vi.fn(async () => PHONE);

    const outcome = await createTwilioSmsChannel({
      transport,
      resolveTarget,
      configured: false,
    }).send({ userId: USER_ID, rendered: SMS });

    expect(outcome).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(transport.sent).toEqual([]);
  });

  it('reads the Twilio config when no flag is injected, so a half-provisioned deploy skips', async () => {
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC_test');
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'tok_test');
    vi.stubEnv('TWILIO_API_KEY_SID', 'SK_test');
    vi.stubEnv('TWILIO_API_KEY_SECRET', 'secret_test');
    // The number A3 has not bought yet: all-or-nothing, so the whole leg stays dark.
    vi.stubEnv('TWILIO_FROM_NUMBER', '');
    const transport = new FakeTransport();

    const outcome = await createTwilioSmsChannel({
      transport,
      resolveTarget: async () => PHONE,
    }).send({ userId: USER_ID, rendered: SMS });

    expect(outcome).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(transport.sent).toEqual([]);

    vi.stubEnv('TWILIO_FROM_NUMBER', '+15005550006');
    const sent = await createTwilioSmsChannel({
      transport,
      resolveTarget: async () => PHONE,
    }).send({ userId: USER_ID, rendered: SMS });

    expect(sent).toEqual({ status: 'sent', providerMessageId: 'fake-out-1' });
  });

  it('maps a permanent Twilio refusal (21610 — this parent opted out) to a NON-transient error outcome', async () => {
    const outcome = await createTwilioSmsChannel({
      transport: refusingTransport(new TwilioSendError('21610', 400)),
      resolveTarget: async () => PHONE,
      configured: true,
    }).send({ userId: USER_ID, rendered: SMS });

    // Non-transient is the whole point: the dispatch writes the failed row instead of
    // throwing, so pg-boss stops re-earning the same refusal every backoff.
    expect(outcome).toEqual({
      status: 'error',
      transient: false,
      code: '21610',
      message: 'twilio send failed: HTTP 400, twilio code 21610',
    });
  });

  it('maps a provider outage to a TRANSIENT error outcome, which the dispatch turns back into a retry', async () => {
    const outcome = await createTwilioSmsChannel({
      transport: refusingTransport(new TwilioSendError('20500', 503)),
      resolveTarget: async () => PHONE,
      configured: true,
    }).send({ userId: USER_ID, rendered: SMS });

    expect(outcome).toEqual({
      status: 'error',
      transient: true,
      code: '20500',
      message: 'twilio send failed: HTTP 503, twilio code 20500',
    });
  });

  it('lets anything that is not a Twilio refusal escape — a bug here is not a delivery outcome', async () => {
    await expect(
      createTwilioSmsChannel({
        transport: refusingTransport(new TypeError('fetch is not a function')),
        resolveTarget: async () => PHONE,
        configured: true,
      }).send({ userId: USER_ID, rendered: SMS }),
    ).rejects.toThrow(/fetch is not a function/);
  });

  it('refuses content that is not SMS — a wiring bug, not a runtime condition', async () => {
    await expect(
      createTwilioSmsChannel({ resolveTarget: async () => PHONE, configured: true }).send({
        userId: USER_ID,
        rendered: { kind: 'email', subject: 'x', html: '<p>y</p>', text: 'y' },
      }),
    ).rejects.toThrow(/received email content/);
  });
});
