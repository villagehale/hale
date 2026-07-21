import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResendTransport } from '../resend-transport';
import type { RenderedContent } from '../types';
import { RESEND_DEFAULT_FROM, createResendEmailChannel } from './resend-email';

// The email leg adapter (VIL-213 · A2): resolve the recipient, gate on config, and
// map the shared transport's {id,error} into the seam's ChannelSendOutcome. We fake
// the transport and the email resolver — no Resend, no db. Rule #1: no test asserts a
// recipient or body reaching a log.
const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMAIL: Extract<RenderedContent, { kind: 'email' }> = {
  kind: 'email',
  subject: 'Your Sunday plan',
  html: '<p>hi</p>',
  text: 'hi',
};

type SendArg = Parameters<ResendTransport['send']>[0];

/** A fake transport returning a scripted result + recording what it was asked to send. */
function fakeTransport(result: { id: string | null; error: { name: string; message: string } | null }): {
  transport: ResendTransport;
  calls: SendArg[];
} {
  const calls: SendArg[] = [];
  return {
    calls,
    transport: {
      async send(msg) {
        calls.push(msg);
        return result;
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createResendEmailChannel().send', () => {
  it('skips not_configured (never resolves or sends) when the injected flag is false', async () => {
    const { transport, calls } = fakeTransport({ id: 'x', error: null });
    const resolveEmail = vi.fn(async () => 'p@x.com');

    const outcome = await createResendEmailChannel({ transport, resolveEmail, configured: false }).send({
      userId: USER_ID,
      rendered: EMAIL,
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(resolveEmail).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('skips not_configured when RESEND_API_KEY is unset and no flag is injected', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const { transport, calls } = fakeTransport({ id: 'x', error: null });

    const outcome = await createResendEmailChannel({ transport, resolveEmail: async () => 'p@x.com' }).send({
      userId: USER_ID,
      rendered: EMAIL,
    });

    expect(outcome).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(calls).toEqual([]);
  });

  it('skips no_address (never sends) when the resolver returns null', async () => {
    const { transport, calls } = fakeTransport({ id: 'x', error: null });

    const outcome = await createResendEmailChannel({
      transport,
      resolveEmail: async () => null,
      configured: true,
    }).send({ userId: USER_ID, rendered: EMAIL });

    expect(outcome).toEqual({ status: 'skipped', reason: 'no_address' });
    expect(calls).toEqual([]);
  });

  it('maps an accepted send → sent with the provider id, sending the rendered email from the default identity', async () => {
    vi.stubEnv('RESEND_FROM', undefined);
    const { transport, calls } = fakeTransport({ id: 'resend-42', error: null });

    const outcome = await createResendEmailChannel({
      transport,
      resolveEmail: async () => 'parent@x.com',
      configured: true,
    }).send({ userId: USER_ID, rendered: EMAIL });

    expect(outcome).toEqual({ status: 'sent', providerMessageId: 'resend-42' });
    expect(calls).toEqual([
      {
        from: RESEND_DEFAULT_FROM,
        to: 'parent@x.com',
        subject: EMAIL.subject,
        html: EMAIL.html,
        text: EMAIL.text,
      },
    ]);
  });

  it('maps a provider error → transient error with the resend code and the narrowed message', async () => {
    const { transport } = fakeTransport({ id: null, error: { name: 'rate_limit_exceeded', message: 'Too many' } });

    const outcome = await createResendEmailChannel({
      transport,
      resolveEmail: async () => 'parent@x.com',
      configured: true,
    }).send({ userId: USER_ID, rendered: EMAIL });

    expect(outcome).toEqual({ status: 'error', transient: true, code: 'resend', message: 'Too many' });
  });
});
