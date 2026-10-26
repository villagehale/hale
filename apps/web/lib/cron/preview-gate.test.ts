import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/cron/heartbeat', () => ({ stampCronHeartbeat: vi.fn() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));

import { cronRoute } from './auth';

const SECRET = 'test-cron-secret';
const TEST_FAM = '11111111-1111-4111-8111-111111111111';
const req = () =>
  new Request('https://x.example/api/cron/x', { headers: { authorization: `Bearer ${SECRET}` } });

describe('cronRoute on preview', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('skips an unscoped cron (drain) without running it', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('PREVIEW_FAMILY_ALLOWLIST', TEST_FAM);
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
    const handler = vi.fn(async () => new Response('ran'));
    const res = await cronRoute('drain', handler)(req());
    expect(handler).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ ok: true, skipped: 'preview_cron_not_scoped' });
  });

  it('skips a scoped cron when no test family or no capture door is set', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    const handler = vi.fn(async () => new Response('ran'));
    await cronRoute('reminders', handler)(req());
    vi.stubEnv('PREVIEW_FAMILY_ALLOWLIST', TEST_FAM);
    await cronRoute('reminders', handler)(req());
    expect(handler).not.toHaveBeenCalled();
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
    await cronRoute('reminders', handler)(req());
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('runs every cron unchanged in production', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    const handler = vi.fn(async () => new Response('ran'));
    const res = await cronRoute('drain', handler)(req());
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe('ran');
  });

  it('still 401s without the secret', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    const res = await cronRoute('drain', vi.fn())(new Request('https://x.example/'));
    expect(res.status).toBe(401);
  });
});
