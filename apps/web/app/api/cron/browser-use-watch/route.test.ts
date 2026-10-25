import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.fn();
const sweepMock = vi.fn();
vi.mock('~/lib/db', () => ({ db: () => dbMock() }));
vi.mock('~/lib/cron/heartbeat', () => ({ stampCronHeartbeat: vi.fn() }));
vi.mock('~/lib/signup/browser-use/watch/sweep', () => ({
  runBrowserUseWatchSweep: (...a: unknown[]) => sweepMock(...a),
}));

import { GET } from './route';

const req = (auth?: string) =>
  new Request('https://hale.test/api/cron/browser-use-watch', {
    headers: auth ? { authorization: auth } : {},
  });

describe('/api/cron/browser-use-watch', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'cron-fixture');
    vi.stubEnv('BROWSER_USE_API_KEY', '');
    vi.stubEnv('BROWSER_USE_WATCH_ENABLED', '');
    dbMock.mockReset();
    sweepMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('401s without the cron secret and does nothing', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(dbMock).not.toHaveBeenCalled();
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it('with the flag off runs nothing; only the heartbeat touches the database', async () => {
    for (const value of ['', 'TRUE', 'true\n', '1']) {
      vi.stubEnv('BROWSER_USE_WATCH_ENABLED', value);
      const res = await GET(req('Bearer cron-fixture'));
      expect(await res.json()).toEqual({ ok: true, skipped: 'flag_off' });
    }
    // cronRoute's dead-man stamp, once per call; the handler itself never opens one.
    expect(dbMock).toHaveBeenCalledTimes(4);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it('with the flag on and no key, the sweep is told it is not configured', async () => {
    vi.stubEnv('BROWSER_USE_WATCH_ENABLED', 'true');
    dbMock.mockReturnValue({});
    sweepMock.mockResolvedValue({ skipped: 'not_configured' });
    const res = await GET(req('Bearer cron-fixture'));
    expect(await res.json()).toEqual({ ok: true, skipped: 'not_configured' });
    expect(sweepMock).toHaveBeenCalledWith({}, null, true);
  });
});
