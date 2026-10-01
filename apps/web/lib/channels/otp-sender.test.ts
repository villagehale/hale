import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeOtpSender, type SmsTransport, createOtpSender } from './otp-sender';

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
