import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The registration ladder's lane switch lives in this route (VIL-226): unless
 * REGISTRATION_LADDER_ENABLED is exactly `true` the ladder runs nothing and the route
 * names why. The group-decision flush is not part of the ladder and runs either way.
 */

const runRegistrationSequenceCronMock = vi.fn();
const flushGroupDecisionSyncsMock = vi.fn();

vi.mock('~/lib/registration/sequence/run', () => ({
  runRegistrationSequenceCron: (...args: unknown[]) => runRegistrationSequenceCronMock(...args),
}));
vi.mock('~/lib/channel/linq/family-outbound', () => ({
  flushGroupDecisionSyncs: (...args: unknown[]) => flushGroupDecisionSyncsMock(...args),
}));
vi.mock('~/lib/telemetry/langfuse', () => ({ flushTelemetry: async () => {} }));
vi.mock('~/lib/cron/heartbeat', () => ({ stampCronHeartbeat: vi.fn() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));

const SECRET = 'test-cron-secret';

function request(): Request {
  return new Request('https://app.example.com/api/cron/registration-sequence', {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

describe('GET /api/cron/registration-sequence — the registration_ladder lane', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', SECRET);
    runRegistrationSequenceCronMock.mockReset().mockResolvedValue({ evaluated: 0, sent: 0 });
    flushGroupDecisionSyncsMock.mockReset().mockResolvedValue({ flushed: 0 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('runs no ladder while REGISTRATION_LADDER_ENABLED is unset, and names lane_off', async () => {
    vi.stubEnv('REGISTRATION_LADDER_ENABLED', undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { GET } = await import('./route');

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      lane: 'registration_ladder',
      outcome: 'lane_off',
      groupSync: 'lane_off',
    });
    expect(runRegistrationSequenceCronMock).not.toHaveBeenCalled();
    expect(flushGroupDecisionSyncsMock).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      { lane: 'registration_ladder', env: 'REGISTRATION_LADDER_ENABLED', outcome: 'lane_off' },
      'registration ladder: lane off, nothing run',
    );
  });

  it('fails closed on a value that only prints as true', async () => {
    vi.stubEnv('REGISTRATION_LADDER_ENABLED', 'true\n');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { GET } = await import('./route');

    await GET(request());

    expect(runRegistrationSequenceCronMock).not.toHaveBeenCalled();
  });

  it('runs the ladder once when the lane is exactly true', async () => {
    vi.stubEnv('REGISTRATION_LADDER_ENABLED', 'true');
    const { GET } = await import('./route');

    const response = await GET(request());

    expect(runRegistrationSequenceCronMock).toHaveBeenCalledTimes(1);
    expect(flushGroupDecisionSyncsMock).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({
      ok: true,
      evaluated: 0,
      sent: 0,
      groupSync: { flushed: 0 },
    });
  });
});
