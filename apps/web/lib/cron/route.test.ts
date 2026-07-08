import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The cron-call AUTHENTICATION contract for all three scheduled routes: a request
 * without the matching `Authorization: Bearer <CRON_SECRET>` gets 401 and the
 * engine does NOTHING — no DB handle resolved, no agent run, no spend. Only a
 * legitimate cron call (correct bearer) reaches the run orchestrator. The run
 * orchestrators themselves are stubbed here (their behaviour is covered by the
 * digest/discovery/inference unit tests); this asserts the gate.
 */

const runDigestCronMock = vi.fn();
const runDiscoveryCronMock = vi.fn();
const runInferenceCronMock = vi.fn();
const runPushRemindersCronMock = vi.fn();
const dbMock = vi.fn();

vi.mock('~/lib/db', () => ({ db: () => dbMock() }));
// The discovery route enqueues a village.rerank + kicks the drain inside after();
// stub the queue + kick so the gate test never touches a real pg-boss or network,
// and run after() inline (the real one throws outside a Next request scope).
vi.mock('~/lib/queue', () => ({ getQueue: async () => ({ send: vi.fn() }) }));
vi.mock('~/lib/cron/kick-drain', () => ({ kickDrain: vi.fn() }));
vi.mock('next/server', async (importActual) => ({
  ...(await importActual<typeof import('next/server')>()),
  after: (fn: () => void) => fn(),
}));
vi.mock('~/lib/cron/digest', () => ({
  runDigestCron: (...a: unknown[]) => runDigestCronMock(...a),
}));
vi.mock('~/lib/cron/discovery', () => ({
  runDiscoveryCron: (...a: unknown[]) => runDiscoveryCronMock(...a),
}));
vi.mock('~/lib/cron/inference', () => ({
  runInferenceCron: (...a: unknown[]) => runInferenceCronMock(...a),
}));
vi.mock('~/lib/cron/push-reminders', () => ({
  runPushRemindersCron: (...a: unknown[]) => runPushRemindersCronMock(...a),
}));

const SECRET = 'cron-secret-xyz';

function request(authHeader?: string): Request {
  return new Request('http://localhost/api/cron/x', {
    method: 'GET',
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

const ROUTES = [
  { name: 'digest', path: '~/app/api/cron/digest/route', mock: runDigestCronMock },
  { name: 'discovery', path: '~/app/api/cron/discovery/route', mock: runDiscoveryCronMock },
  { name: 'inference', path: '~/app/api/cron/inference/route', mock: runInferenceCronMock },
  {
    name: 'push-reminders',
    path: '~/app/api/cron/push-reminders/route',
    mock: runPushRemindersCronMock,
  },
] as const;

describe.each(ROUTES)('GET /api/cron/$name — cron-secret gate', ({ path, mock }) => {
  beforeEach(() => {
    vi.resetModules();
    runDigestCronMock.mockReset().mockResolvedValue({ processed: 0, results: [] });
    runDiscoveryCronMock.mockReset().mockResolvedValue({ processed: 0, results: [] });
    runInferenceCronMock.mockReset().mockResolvedValue({ processed: 0, results: [] });
    runPushRemindersCronMock.mockReset().mockResolvedValue({ processed: 0, results: [] });
    dbMock.mockReset().mockReturnValue({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function callGet(req: Request) {
    const { GET } = await import(path);
    return GET(req);
  }

  it('returns 401 and does NO work when CRON_SECRET is unset (fail closed)', async () => {
    vi.stubEnv('CRON_SECRET', '');

    const res = await callGet(request(`Bearer ${SECRET}`));

    expect(res.status).toBe(401);
    expect(mock).not.toHaveBeenCalled();
    expect(dbMock).not.toHaveBeenCalled();
  });

  it('returns 401 and does NO work when the bearer token is missing', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);

    const res = await callGet(request());

    expect(res.status).toBe(401);
    expect(mock).not.toHaveBeenCalled();
    expect(dbMock).not.toHaveBeenCalled();
  });

  it('returns 401 and does NO work when the bearer token is wrong', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);

    const res = await callGet(request('Bearer wrong-token'));

    expect(res.status).toBe(401);
    expect(mock).not.toHaveBeenCalled();
    expect(dbMock).not.toHaveBeenCalled();
  });

  it('runs the cron exactly once when the bearer token matches', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);

    const res = await callGet(request(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
