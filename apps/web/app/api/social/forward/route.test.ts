import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SECRET = 'test-cron-secret';

function request(body?: unknown, auth = `Bearer ${SECRET}`): Request {
  return new Request('https://app.example.com/api/social/forward', {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('POST /api/social/forward', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    Reflect.deleteProperty(process.env, 'SOCIAL_WATCHLIST');
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, 'CRON_SECRET');
    Reflect.deleteProperty(process.env, 'SOCIAL_WATCHLIST');
  });

  it('rejects a caller without the cron secret', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      request({ familyId: 'x', url: 'https://instagram.com/p/a' }, 'Bearer no'),
    );
    expect(response.status).toBe(401);
  });

  it('stays dark when the watchlist flag is off', async () => {
    const { POST } = await import('./route');
    const response = await POST(request({ familyId: 'x', url: 'https://instagram.com/p/a' }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ skipped: 'flag_off' });
  });
});
