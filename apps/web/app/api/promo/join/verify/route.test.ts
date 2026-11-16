import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROMO_JOIN_COOKIE } from '~/lib/billing/promo-join-cookie';

const verifyMock = vi.fn();

vi.mock('~/lib/billing/new-visitor-join', () => ({
  verifyPromoJoinCode: (...args: unknown[]) => verifyMock(...args),
}));
vi.mock('~/lib/auth/rate-limit', () => ({ authRateLimited: async () => false }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));

async function post(body: unknown) {
  const { POST } = await import('./route');
  return POST(
    new Request('https://app.example.com/api/promo/join/verify', {
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
  });

  it('404s unless both payment flags are exact true', async () => {
    const res = await post({ phone: '+15195551234', code: '123456' });
    expect(res.status).toBe(404);
    expect(verifyMock).not.toHaveBeenCalled();
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
  });
});
