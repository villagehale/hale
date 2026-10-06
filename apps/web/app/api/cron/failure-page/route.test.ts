import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The failure-page cron door: nothing — no ledger read, no Slack post — happens
 * for a caller without the cron secret, and the sweep's counts are the route's
 * whole answer.
 */

const pageFailureAlertsMock = vi.fn();

vi.mock('~/lib/monitoring/failure-page', () => ({
  pageFailureAlerts: (...args: unknown[]) => pageFailureAlertsMock(...args),
}));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));

const SECRET = 'test-cron-secret';

function request(headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }): Request {
  return new Request('https://app.example.com/api/cron/failure-page', { headers });
}

describe('GET /api/cron/failure-page', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    pageFailureAlertsMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(process.env, 'CRON_SECRET');
  });

  it('answers 401 and does nothing without the secret', async () => {
    const { GET } = await import('./route');

    const response = await GET(request({}));

    expect(response.status).toBe(401);
    expect(pageFailureAlertsMock).not.toHaveBeenCalled();
  });

  it('answers 401 and does nothing on a wrong bearer token', async () => {
    const { GET } = await import('./route');

    const response = await GET(request({ authorization: 'Bearer wrong' }));

    expect(response.status).toBe(401);
    expect(pageFailureAlertsMock).not.toHaveBeenCalled();
  });

  it('runs the sweep and answers its counts', async () => {
    const { GET } = await import('./route');
    pageFailureAlertsMock.mockResolvedValue({
      turns: { posted: 1, deduped: 0, failed: 0 },
      firstHellos: { posted: 0, deduped: 0, failed: 0 },
      providerIncidents: { posted: 0, deduped: 0, failed: 0 },
      deadLetters: { posted: 0, deduped: 0, failed: 0 },
      deferredPileups: { posted: 0, deduped: 0, failed: 0 },
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      turns: { posted: 1, deduped: 0, failed: 0 },
      firstHellos: { posted: 0, deduped: 0, failed: 0 },
      providerIncidents: { posted: 0, deduped: 0, failed: 0 },
      deadLetters: { posted: 0, deduped: 0, failed: 0 },
      deferredPileups: { posted: 0, deduped: 0, failed: 0 },
    });
    expect(pageFailureAlertsMock).toHaveBeenCalledTimes(1);
  });
});
