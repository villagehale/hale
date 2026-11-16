import { afterEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();

vi.mock('~/lib/billing/new-visitor-join', () => ({
  requestPromoJoinCode: (...args: unknown[]) => requestMock(...args),
}));
vi.mock('~/lib/auth/claim-code-sender', () => ({
  createClaimCodeSender: () => ({ sendCode: async () => ({ status: 'sent' }) }),
}));
vi.mock('~/lib/auth/rate-limit', () => ({ authRateLimited: async () => false }));
vi.mock('~/lib/rate-limit/apply', () => ({ enforceRateLimit: async () => null }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/crypto/blind-index', () => ({ phoneBlindIndex: () => 'hash' }));

async function post(
  body: unknown,
  url = 'https://app.example.com/api/promo/join/request',
  cookie?: string,
) {
  const { POST } = await import('./route');
  return POST(
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/promo/join/request', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    requestMock.mockReset();
  });

  it('404s unless both payment flags are exact true', async () => {
    const res = await post({ phone: '+15195551234' });
    expect(res.status).toBe(404);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('404s with a wrong preview token while flags stay off', async () => {
    vi.stubEnv('PROMO_PREVIEW_TOKEN', 'secret');
    const res = await post(
      { phone: '+15195551234' },
      'https://app.example.com/api/promo/join/request?preview=nope',
    );
    expect(res.status).toBe(404);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('accepts the HttpOnly preview cookie while flags stay off', async () => {
    vi.stubEnv('PROMO_PREVIEW_TOKEN', 'secret');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    const { PROMO_PREVIEW_COOKIE, signPromoPreviewCookie } = await import(
      '~/lib/billing/promo-preview'
    );
    const cookie = signPromoPreviewCookie({
      AUTH_SECRET: 'test-secret',
      PROMO_PREVIEW_TOKEN: 'secret',
    });
    requestMock.mockResolvedValue({ status: 'sent' });
    const res = await post(
      { phone: '+15195551234' },
      'https://app.example.com/api/promo/join/request',
      `${PROMO_PREVIEW_COOKIE}=${cookie}`,
    );
    expect(res.status).toBe(200);
    expect(requestMock).toHaveBeenCalled();
  });

  it('accepts a matching preview token while flags stay off', async () => {
    vi.stubEnv('PROMO_PREVIEW_TOKEN', 'secret');
    requestMock.mockResolvedValue({ status: 'sent' });
    const res = await post(
      { phone: '+15195551234' },
      'https://app.example.com/api/promo/join/request?preview=secret',
    );
    expect(res.status).toBe(200);
    expect(requestMock).toHaveBeenCalled();
  });

  it('collapses a send into accepted when both flags are on', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_NEW_VISITOR_CHECKOUT_ENABLED', 'true');
    requestMock.mockResolvedValue({ status: 'sent' });
    const res = await post({ phone: '+15195551234' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'accepted' });
    expect(requestMock).toHaveBeenCalled();
  });
});
