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
const afterCallbacks: Array<() => Promise<void> | void> = [];
vi.mock('next/server', async (importActual) => ({
  ...(await importActual<typeof import('next/server')>()),
  after: (fn: () => Promise<void> | void) => {
    afterCallbacks.push(fn);
  },
}));

const SECRET = 'test-cron-secret';

function request(url = 'https://app.example.com/api/cron/drain'): Request {
  return new Request(url, { headers: { authorization: `Bearer ${SECRET}` } });
}

describe('GET /api/cron/drain', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    runDrainCronMock.mockReset();
    afterCallbacks.length = 0;
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

  it('answers a KICKED run 202 before working, and does the work after the response', async () => {
    const { GET } = await import('./route');
    let settled = false;
    runDrainCronMock.mockImplementation(async () => {
      settled = true;
      return { processed: 1, failed: 0, dropped: 0 };
    });
    const response = await GET(request('https://app.example.com/api/cron/drain?queues=channel.message.received'));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, kicked: true, queues: ['channel.message.received'] });
    // Nothing ran while the kicker was waiting.
    expect(settled).toBe(false);
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]?.();
    expect(runDrainCronMock).toHaveBeenCalledWith({ queues: ['channel.message.received'] });
    expect(settled).toBe(true);
  });

  it('logs a kicked run that fails instead of throwing after the 202', async () => {
    const { GET } = await import('./route');
    runDrainCronMock.mockRejectedValue(new Error('orchestrator blew up'));
    const response = await GET(request('https://app.example.com/api/cron/drain?queues=channel.message.received'));
    expect(response.status).toBe(202);
    await expect(afterCallbacks[0]?.()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ dbUnavailable: false }),
      'cron/drain kicked run failed',
    );
  });

  it('answers the summary on a clean run', async () => {
    const { GET } = await import('./route');
    runDrainCronMock.mockResolvedValue({ processed: 2, failed: 0, dropped: 1 });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, processed: 2, failed: 0, dropped: 1 });
  });
});
