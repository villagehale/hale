import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.fn();
const sweepMock = vi.fn();
const prepMock = vi.fn();
const depsMock = vi.fn();
const prepDepsMock = vi.fn();
vi.mock('~/lib/db', () => ({ db: () => dbMock() }));
vi.mock('~/lib/cron/heartbeat', () => ({ stampCronHeartbeat: vi.fn() }));
vi.mock('~/lib/signup/plan/run', () => ({
  runDueSignupPlans: (...a: unknown[]) => sweepMock(...a),
}));
vi.mock('~/lib/signup/plan/prep', () => ({
  runDueSignupPlanPrep: (...a: unknown[]) => prepMock(...a),
}));
vi.mock('~/lib/signup/plan/notice', () => ({
  signupPlanDepsFromEnv: (...a: unknown[]) => depsMock(...a),
  signupPlanPrepDepsFromEnv: (...a: unknown[]) => prepDepsMock(...a),
}));

import { GET } from './route';

const req = (auth?: string) =>
  new Request('https://hale.test/api/cron/signup-plans', {
    headers: auth ? { authorization: auth } : {},
  });

describe('/api/cron/signup-plans', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'cron-fixture');
    vi.stubEnv('REGISTRATION_PLAN_RUN_ENABLED', '');
    dbMock.mockReset();
    sweepMock.mockReset();
    prepMock.mockReset();
    depsMock.mockReset();
    prepDepsMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('401s without the cron secret and does nothing', async () => {
    const res = await GET(req('Bearer wrong'));
    expect(res.status).toBe(401);
    expect(dbMock).not.toHaveBeenCalled();
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it('with the switch unset, builds nothing, claims nothing and says so', async () => {
    for (const value of ['', 'TRUE', 'true\n', '1']) {
      vi.stubEnv('REGISTRATION_PLAN_RUN_ENABLED', value);
      const res = await GET(req('Bearer cron-fixture'));
      expect(await res.json()).toEqual({ ok: true, skipped: 'flag_off' });
    }
    expect(sweepMock).not.toHaveBeenCalled();
    expect(prepMock).not.toHaveBeenCalled();
    expect(depsMock).not.toHaveBeenCalled();
  });

  it('armed, runs the sweep with the real wiring and returns what it did', async () => {
    vi.stubEnv('REGISTRATION_PLAN_RUN_ENABLED', 'true');
    const database = { tag: 'db' };
    const wiring = { runner: null, notifyParent: vi.fn() };
    dbMock.mockReturnValue(database);
    depsMock.mockReturnValue(wiring);
    const prepWiring = { writer: { write: vi.fn() }, deliver: vi.fn() };
    sweepMock.mockResolvedValue({ skipped: 'not_configured', plans: [] });
    prepMock.mockResolvedValue({ notices: [] });
    prepDepsMock.mockReturnValue(prepWiring);
    const res = await GET(req('Bearer cron-fixture'));
    expect(await res.json()).toEqual({
      ok: true,
      skipped: 'not_configured',
      plans: [],
      prep: { notices: [] },
    });
    expect(depsMock).toHaveBeenCalledWith(database);
    expect(prepDepsMock).toHaveBeenCalledWith(database);
    expect(prepMock).toHaveBeenCalledWith(database, { now: expect.any(Date) }, prepWiring);
    expect(sweepMock).toHaveBeenCalledWith(database, { now: expect.any(Date) }, wiring);
  });
});
