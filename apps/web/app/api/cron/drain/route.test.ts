import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The drain route's ANSWER, which is a contract with the kicker.
 *
 * A drain that could not get a database connection must answer 503, because that is the
 * one failure where a retry makes things worse: the kicker's "retry once on a 5xx" would
 * send a second invocation to ask for a connection that is not there, and during a burst
 * every kick becomes two (lib/cron/kick-drain.ts). Every OTHER failure still throws, so
 * a bug in one handler stays a loud 500 instead of quietly telling the whole fleet to
 * stop kicking.
 */

const runDrainCronMock = vi.fn();

vi.mock('~/lib/cron/drain', async (importActual) => ({
  ...(await importActual<typeof import('~/lib/cron/drain')>()),
  runDrainCron: (...args: unknown[]) => runDrainCronMock(...args),
}));
vi.mock('~/lib/telemetry/langfuse', () => ({ flushTelemetry: async () => {} }));

const SECRET = 'test-cron-secret';

function request(url = 'https://app.example.com/api/cron/drain'): Request {
  return new Request(url, { headers: { authorization: `Bearer ${SECRET}` } });
}

describe('GET /api/cron/drain', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    runDrainCronMock.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(process.env, 'CRON_SECRET');
  });

  it('answers 503 when the database is out of connections', async () => {
    const { GET } = await import('./route');
    runDrainCronMock.mockRejectedValue(
      Object.assign(new Error('sorry, too many clients already'), { code: '53300' }),
    );

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'db_unavailable' });
  });

  it('still throws every other failure — a handler bug is not a fleet-wide back-off', async () => {
    const { GET } = await import('./route');
    runDrainCronMock.mockRejectedValue(new Error('orchestrator blew up'));

    await expect(GET(request())).rejects.toThrow('orchestrator blew up');
  });

  it('answers the summary on a clean run', async () => {
    const { GET } = await import('./route');
    runDrainCronMock.mockResolvedValue({ processed: 2, failed: 0, dropped: 1 });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, processed: 2, failed: 0, dropped: 1 });
  });
});
