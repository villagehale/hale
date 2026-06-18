import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route persists via createWaitlistStore() and emails via createEmailSender().
// Stub the store so the route never needs a live Postgres connection; mock the
// Resend SDK so we can assert whether a send was attempted.
const addMock = vi.fn(async () => ({ created: true }));
vi.mock('~/lib/waitlist-store', () => ({
  createWaitlistStore: () => ({ add: addMock }),
}));

const resendSendMock = vi.fn();
vi.mock('resend', () => ({
  Resend: vi.fn(() => ({ emails: { send: resendSendMock } })),
}));

import { POST } from '../app/api/waitlist/route.js';

function postWith(body: unknown): Request {
  return new Request('http://localhost/api/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/waitlist — confirmation email', () => {
  beforeEach(() => {
    addMock.mockClear();
    resendSendMock.mockReset();
    resendSendMock.mockResolvedValue({ data: { id: 'resend-1' }, error: null });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('joins AND attempts the send when RESEND_API_KEY is configured', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');

    const res = await POST(postWith({ email: 'New@Example.com' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(addMock).toHaveBeenCalledWith('new@example.com');
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect(resendSendMock.mock.calls[0]?.[0]).toMatchObject({
      to: 'new@example.com',
      subject: "You're on the Hale waitlist",
    });
  });

  it('joins AND skips the send (logged) when RESEND_API_KEY is absent', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const res = await POST(postWith({ email: 'noconfig@example.com' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(addMock).toHaveBeenCalledWith('noconfig@example.com');
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('waitlist email skipped: RESEND_API_KEY not set');
  });

  it('still returns ok:true when the email send throws (best-effort)', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    resendSendMock.mockRejectedValue(new Error('resend down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(postWith({ email: 'boom@example.com' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(error).toHaveBeenCalled();
  });
});
