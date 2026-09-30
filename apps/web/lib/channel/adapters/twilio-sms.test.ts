import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import type { RenderedContent } from '../types';
import { createTwilioSmsChannel } from './twilio-sms';

// The LOOP's SMS leg adapter (VIL-213 · A2, lit up by VIL-260): resolve the parent's
// number, gate on the Linq outbound pair, and hand the rendered text to the phone
// transport. We fake the transport and the resolver — no network, no db. Rule #1:
// no test asserts a phone number or body reaching a log.
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

  it('reads the Linq outbound pair when no flag is injected, so a half-provisioned deploy skips', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    // The Hale line is unset: all-or-nothing, so the whole leg stays dark.
    vi.stubEnv('LINQ_FROM_E164', '');
    const transport = new FakeTransport();

    const outcome = await createTwilioSmsChannel({
      transport,
      resolveTarget: async () => PHONE,
    }).send({ userId: USER_ID, rendered: SMS });

    expect(outcome).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(transport.sent).toEqual([]);

    vi.stubEnv('LINQ_FROM_E164', '+16462352164');
    const sent = await createTwilioSmsChannel({
      transport,
      resolveTarget: async () => PHONE,
    }).send({ userId: USER_ID, rendered: SMS });

    expect(sent).toEqual({ status: 'sent', providerMessageId: 'fake-out-1' });
  });

  it('sends a family with no group through Linq, and does not call Twilio', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', '+16462352164');
    const fetchMock = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).includes('api.twilio.com')) {
        return Response.json({ message: 'twilio must not be called' }, { status: 500 });
      }
      return Response.json({ chat: { id: 'chat-1', message: { id: 'msg-1' } } }, { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await createTwilioSmsChannel({
      resolveTarget: async () => PHONE,
    }).send({ userId: USER_ID, rendered: SMS });

    expect(outcome).toEqual({
      status: 'sent',
      providerMessageId: 'msg-1',
      providerChatId: 'chat-1',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe('https://api.linqapp.com/api/partner/v3/chats');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      from: '+16462352164',
      to: [PHONE],
      message: { parts: [{ type: 'text', value: SMS.text }] },
    });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('preferred_service');
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
