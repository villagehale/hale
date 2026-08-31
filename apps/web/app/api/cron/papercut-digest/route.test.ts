import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The papercut digest's cron door: nothing — no DB read, no aggregation, no email —
 * happens for a caller without the cron secret, and the named outcome the runner
 * returns is the route's whole answer.
 */

const runPapercutDigestCronMock = vi.fn();

vi.mock('~/lib/loop/papercut-digest', async (importActual) => ({
  ...(await importActual<typeof import('~/lib/loop/papercut-digest')>()),
  runPapercutDigestCron: (...args: unknown[]) => runPapercutDigestCronMock(...args),
}));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));

const SECRET = 'test-cron-secret';

function request(headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }): Request {
  return new Request('https://app.example.com/api/cron/papercut-digest', { headers });
}

describe('GET /api/cron/papercut-digest', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    runPapercutDigestCronMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(process.env, 'CRON_SECRET');
  });

  it('answers 401 and does nothing without the secret', async () => {
    const { GET } = await import('./route');

    const response = await GET(request({}));

    expect(response.status).toBe(401);
    expect(runPapercutDigestCronMock).not.toHaveBeenCalled();
  });

  it('answers 401 and does nothing on a wrong bearer token', async () => {
    const { GET } = await import('./route');

    const response = await GET(request({ authorization: 'Bearer wrong' }));

    expect(response.status).toBe(401);
    expect(runPapercutDigestCronMock).not.toHaveBeenCalled();
  });

  it('runs the digest and answers its named outcome', async () => {
    const { GET } = await import('./route');
    runPapercutDigestCronMock.mockResolvedValue({
      outcome: 'digest_skipped_empty',
      summary: { buckets: [] },
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: 'digest_skipped_empty' });
    expect(runPapercutDigestCronMock).toHaveBeenCalledTimes(1);
  });
});
