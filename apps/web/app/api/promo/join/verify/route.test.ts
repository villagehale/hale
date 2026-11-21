import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROMO_JOIN_COOKIE } from '~/lib/billing/promo-join-cookie';

const verifyMock = vi.fn();
const threadMock = vi.fn();

vi.mock('~/lib/billing/new-visitor-join', () => ({
  verifyPromoJoinCode: (...args: unknown[]) => verifyMock(...args),
}));
vi.mock('~/lib/billing/checkout-payer', () => ({
  alreadyPaidParentHasThread: (...args: unknown[]) => threadMock(...args),
}));
vi.mock('~/lib/auth/rate-limit', () => ({ authRateLimited: async () => false }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));

async function post(body: unknown, url = 'https://app.example.com/api/promo/join/verify') {
  const { POST } = await import('./route');
  return POST(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/promo/join/verify', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    verifyMock.mockReset();
    threadMock.mockReset();
  });

  it('404s unless both payment flags are exact true', async () => {
    const res = await post({ phone: '+15195551234', code: '123456' });
    expect(res.status).toBe(404);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('404s with a wrong preview token while flags stay off', async () => {
    vi.stubEnv('PROMO_PREVIEW_TOKEN', 'secret');
    const res = await post(
      { phone: '+15195551234', code: '123456' },
      'https://app.example.com/api/promo/join/verify?preview=nope',
    );
    expect(res.status).toBe(404);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('verifies with a matching preview token while flags stay off', async () => {
    vi.stubEnv('PROMO_PREVIEW_TOKEN', 'secret');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    verifyMock.mockResolvedValue({
      status: 'ok',
      familyId: 'fam-9',
      userId: 'user-9',
      externalAuthId: 'sms:abc',
      alreadyPaid: false,
    });
    const res = await post(
      { phone: '+15195551234', code: '123456' },
      'https://app.example.com/api/promo/join/verify?preview=secret',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain(PROMO_JOIN_COOKIE);
  });

  it('sets the join cookie when the OTP spends', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_NEW_VISITOR_CHECKOUT_ENABLED', 'true');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    verifyMock.mockResolvedValue({
      status: 'ok',
      familyId: 'fam-9',
      userId: 'user-9',
      externalAuthId: 'sms:abc',
      alreadyPaid: false,
    });
    const res = await post({ phone: '+15195551234', code: '123456' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', alreadyPaid: false });
    expect(res.headers.get('set-cookie')).toContain(PROMO_JOIN_COOKIE);
    expect(threadMock).not.toHaveBeenCalled();
  });

  it.each([
    [true, { status: 'ok', alreadyPaid: true, hasThread: true }],
    [false, { status: 'ok', alreadyPaid: true }],
  ])('a paid number with a thread answer of %s gets %j', async (hasThread, expected) => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_NEW_VISITOR_CHECKOUT_ENABLED', 'true');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    verifyMock.mockResolvedValue({
      status: 'ok',
      familyId: 'fam-9',
      userId: 'user-9',
      externalAuthId: 'sms:abc',
      alreadyPaid: true,
    });
    threadMock.mockResolvedValue(hasThread);
    const res = await post({ phone: '+15195551234', code: '123456' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expected);
    expect(threadMock).toHaveBeenCalledWith(expect.anything(), 'fam-9', 'user-9');
  });
});
