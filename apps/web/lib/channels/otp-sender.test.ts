import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeOtpSender, OtpSendError, type SmsTransport, createOtpSender } from './otp-sender';

describe('FakeOtpSender', () => {
  it('records each sent code and reports sent by default', async () => {
    const fake = new FakeOtpSender();
    const result = await fake.sendCode({ phoneE164: '+15195551234', code: '428913' });
    expect(result).toEqual({ status: 'sent' });
    expect(fake.sent).toEqual([{ phoneE164: '+15195551234', code: '428913' }]);
  });

  it('can be told to report not_configured (models the CPaaS-absent state)', async () => {
    const fake = new FakeOtpSender({ status: 'not_configured' });
    const result = await fake.sendCode({ phoneE164: '+15195551234', code: '428913' });
    expect(result).toEqual({ status: 'not_configured' });
    // Nothing is recorded when the transport can't send.
    expect(fake.sent).toEqual([]);
  });
});

describe('createOtpSender', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns not_configured when no SMS transport is provisioned', async () => {
    const sender = createOtpSender(null);
    const result = await sender.sendCode({ phoneE164: '+15195551234', code: '428913' });
    expect(result).toEqual({ status: 'not_configured' });
  });

  it('delivers the code via the transport when one is configured', async () => {
    const transport: SmsTransport = { sendSms: vi.fn().mockResolvedValue(undefined) };
    const sender = createOtpSender(transport);
    const result = await sender.sendCode({ phoneE164: '+15195551234', code: '428913' });

    expect(result).toEqual({ status: 'sent' });
    expect(transport.sendSms).toHaveBeenCalledTimes(1);
    const [to, body] = (transport.sendSms as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(to).toBe('+15195551234');
    // The message carries the code but never the parent's identity.
    expect(body).toContain('428913');
  });
});

describe('the env transport — bounded, and typed on refusal', () => {
  beforeEach(() => {
    vi.stubEnv('SMS_OTP_ACCOUNT_SID', 'AC00000000000000000000000000000000');
    vi.stubEnv('SMS_OTP_AUTH_TOKEN', 'otp_auth_token');
    vi.stubEnv('SMS_OTP_FROM', '+15195550000');
    vi.stubEnv('SMS_OTP_API_BASE', 'https://api.twilio.example/2010-04-01');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('sends with an abort timeout — a hung CPaaS must not pin a sign-in request', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response('{}', { status: 201 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createOtpSender().sendCode({ phoneE164: '+15195551234', code: '428913' });

    expect(result).toEqual({ status: 'sent' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('types a 4xx refusal permanent — the identical request re-sent earns the identical answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 400 })),
    );

    const attempt = createOtpSender().sendCode({ phoneE164: '+15195551234', code: '428913' });

    await expect(attempt).rejects.toThrowError(OtpSendError);
    await attempt.catch((err: OtpSendError) => {
      expect(err.httpStatus).toBe(400);
      expect(err.permanent).toBe(true);
    });
  });

  it.each([429, 503])('types a %i as transient — a retry can fix it', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status })),
    );

    const attempt = createOtpSender().sendCode({ phoneE164: '+15195551234', code: '428913' });

    await expect(attempt).rejects.toThrowError(OtpSendError);
    await attempt.catch((err: OtpSendError) => {
      expect(err.httpStatus).toBe(status);
      expect(err.permanent).toBe(false);
    });
  });

  it('never puts the number or the code in the thrown error (rule #1)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );

    const err: unknown = await createOtpSender()
      .sendCode({ phoneE164: '+15195551234', code: '428913' })
      .catch((e: unknown) => e);

    const written = `${(err as Error).message}${JSON.stringify(err)}`;
    expect(written).not.toContain('5195551234');
    expect(written).not.toContain('428913');
  });
});
