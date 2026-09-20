import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The cron-call AUTHENTICATION contract for all three scheduled routes: a request
 * without the matching `Authorization: Bearer <CRON_SECRET>` gets 401 and the
 * engine does NOTHING — no DB handle resolved, no agent run, no spend. Only a
 * legitimate cron call (correct bearer) reaches the run orchestrator. The run
 * orchestrators themselves are stubbed here (their behaviour is covered by the
 * discovery/inference unit tests); this asserts the gate.
 */

const runDiscoveryCronMock = vi.fn();
const runInferenceCronMock = vi.fn();
const runWeekPlanCronMock = vi.fn();
const sweepAttachmentsMock = vi.fn();
const runNudgeCronMock = vi.fn();
const runSittingReminderCronMock = vi.fn();
const runFirstReplyRecoveryCronMock = vi.fn();
const runWelcomeCardRedriveMock = vi.fn();
const runDepartureNoticeRedriveMock = vi.fn();
const dbMock = vi.fn();

vi.mock('~/lib/db', () => ({ db: () => dbMock() }));
// The cronRoute wrapper stamps the dead-man ledger after the handler; stub it
// so the gate tests stay about the gate (the stamp is covered by deadman.test.ts).
vi.mock('~/lib/cron/heartbeat', () => ({ stampCronHeartbeat: vi.fn() }));
// The discovery route enqueues a village.rerank + kicks the drain inside after();
// stub the queue + kick so the gate test never touches a real pg-boss or network,
// and run after() inline (the real one throws outside a Next request scope).
vi.mock('~/lib/queue', () => ({ getQueue: async () => ({ send: vi.fn() }) }));
vi.mock('~/lib/cron/kick-drain', () => ({ kickDrain: vi.fn() }));
vi.mock('next/server', async (importActual) => ({
  ...(await importActual<typeof import('next/server')>()),
  after: (fn: () => void) => fn(),
}));
vi.mock('~/lib/cron/discovery', () => ({
  runDiscoveryCron: (...a: unknown[]) => runDiscoveryCronMock(...a),
}));
vi.mock('~/lib/cron/inference', () => ({
  runInferenceCron: (...a: unknown[]) => runInferenceCronMock(...a),
}));
vi.mock('~/lib/loop/cron', () => ({
  runWeekPlanCron: (...a: unknown[]) => runWeekPlanCronMock(...a),
}));
vi.mock('~/lib/coach/attachments', () => ({
  sweepUnlinkedAttachments: (...a: unknown[]) => sweepAttachmentsMock(...a),
}));
vi.mock('~/lib/channel/nudge/run', () => ({
  runNudgeCron: (...a: unknown[]) => runNudgeCronMock(...a),
}));
vi.mock('~/lib/channel/intake/sitting-reminder', () => ({
  runSittingReminderCron: (...a: unknown[]) => runSittingReminderCronMock(...a),
}));
vi.mock('~/lib/channel/intake/first-reply-recovery', () => ({
  runFirstReplyRecoveryCron: (...a: unknown[]) => runFirstReplyRecoveryCronMock(...a),
}));
// The nudge route's other riders each read a dark-launch flag and return before they
// touch a handle; the two 08:00 re-drives deliberately have none (each finishes a send
// another module already owed), so they are the ones that would reach the stub db here.
vi.mock('~/lib/channel/intake/welcome-card-redrive', () => ({
  runWelcomeCardRedrive: (...a: unknown[]) => runWelcomeCardRedriveMock(...a),
}));
vi.mock('~/lib/channel/coparent/departure-redrive', () => ({
  runDepartureNoticeRedrive: (...a: unknown[]) => runDepartureNoticeRedriveMock(...a),
}));

const SECRET = 'cron-secret-xyz';

function request(authHeader?: string): Request {
  return new Request('http://localhost/api/cron/x', {
    method: 'GET',
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

const ROUTES = [
  { name: 'discovery', path: '~/app/api/cron/discovery/route', mock: runDiscoveryCronMock },
  { name: 'inference', path: '~/app/api/cron/inference/route', mock: runInferenceCronMock },
  {
    name: 'attachment-sweep',
    path: '~/app/api/cron/attachment-sweep/route',
    mock: sweepAttachmentsMock,
  },
  { name: 'week-plan', path: '~/app/api/cron/week-plan/route', mock: runWeekPlanCronMock },
  { name: 'nudge', path: '~/app/api/cron/nudge/route', mock: runNudgeCronMock },
  {
    name: 'intake-sitting-reminder',
    path: '~/app/api/cron/intake-sitting-reminder/route',
    mock: runSittingReminderCronMock,
  },
] as const;

describe.each(ROUTES)('GET /api/cron/$name — cron-secret gate', ({ path, mock }) => {
  beforeEach(() => {
    vi.resetModules();
    runDiscoveryCronMock.mockReset().mockResolvedValue({ processed: 0, results: [] });
    runInferenceCronMock.mockReset().mockResolvedValue({ processed: 0, results: [] });
    runWeekPlanCronMock.mockReset().mockResolvedValue({ processed: 0, results: [] });
    sweepAttachmentsMock.mockReset().mockResolvedValue({ swept: 0 });
    runNudgeCronMock.mockReset().mockResolvedValue({ enabled: false, evaluated: 0 });
    runWelcomeCardRedriveMock.mockReset().mockResolvedValue({ held: 0, due: 0, sent: 0 });
    runDepartureNoticeRedriveMock.mockReset().mockResolvedValue({ open: 0, due: 0, sent: 0 });
    runSittingReminderCronMock
      .mockReset()
      .mockResolvedValue({ evaluated: 0, sent: 0, skipped: 0, failed: 0 });
    runFirstReplyRecoveryCronMock
      .mockReset()
      .mockResolvedValue({ evaluated: 0, sent: 0, skipped: 0, failed: 0 });
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
    if (path.includes('intake-sitting-reminder')) {
      expect(runFirstReplyRecoveryCronMock).toHaveBeenCalledTimes(1);
    }
    // THE 08:00 CARD RE-DRIVE IS A LEG OF THE NUDGE ROUTE, pinned here because this is
    // its only production call site: mocking the module without asserting the call left
    // "the cron stopped re-driving the card" a green change. The negative arm is the
    // control — no other cron may quietly acquire it.
    if (path.includes('cron/nudge')) {
      expect(runWelcomeCardRedriveMock).toHaveBeenCalledTimes(1);
      expect(runWelcomeCardRedriveMock).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ ports: expect.anything() }),
      );
      expect(runDepartureNoticeRedriveMock).toHaveBeenCalledTimes(1);
      expect(runDepartureNoticeRedriveMock).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ ports: expect.anything() }),
      );
    } else {
      expect(runWelcomeCardRedriveMock).not.toHaveBeenCalled();
      expect(runDepartureNoticeRedriveMock).not.toHaveBeenCalled();
    }
  });
});
