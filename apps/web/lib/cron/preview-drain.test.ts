import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #921 Devin reds: Preview work must drain on Preview, from Preview's own pg-boss
 * schema, never from the queue production claims.
 */

const pgBossCtor = vi.fn();
vi.mock('pg-boss', () => ({
  default: class {
    constructor(opts: unknown) {
      pgBossCtor(opts);
    }
    async start() {}
  },
}));

const runDrainCronMock = vi.fn(async () => ({ drained: 0 }));
const firstReplyMock = vi.fn();
const groupTickMock = vi.fn();
vi.mock('~/lib/cron/drain', () => ({
  DRAINABLE_QUEUES: ['channel.send', 'channel.message.received'],
  isConnectionExhaustion: () => false,
  runDrainCron: (...a: unknown[]) => runDrainCronMock(...(a as [])),
}));
vi.mock('~/lib/channel/intake/first-reply-recovery', () => ({
  firstReplyRecoveryDeps: () => ({}),
  runFirstReplyRecoveryCron: (...a: unknown[]) => firstReplyMock(...a),
}));
vi.mock('~/lib/loop/reminders/group/flag', () => ({ groupRemindersLive: () => true }));
vi.mock('~/lib/loop/reminders/group/fire', () => ({
  groupReminderTickPorts: () => ({}),
  runGroupReminderTick: (...a: unknown[]) => groupTickMock(...a),
}));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/cron/heartbeat', () => ({ stampCronHeartbeat: vi.fn() }));
vi.mock('~/lib/telemetry/langfuse', () => ({ flushTelemetry: async () => {} }));
const runReminderCronMock = vi.fn(async () => ({ fired: 1 }));
vi.mock('~/lib/loop/reminders/run', () => ({
  runReminderCron: (...a: unknown[]) => runReminderCronMock(...(a as [])),
}));
const afterFns: (() => unknown)[] = [];
vi.mock('next/server', async (importActual) => ({
  ...(await importActual<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    afterFns.push(fn);
  },
}));

const SECRET = 'test-cron-secret';
const TEST_FAM = '11111111-1111-4111-8111-111111111111';
const PREVIEW_ORIGIN = 'https://hale-git-x.vercel.app';
const req = (path: string, origin = PREVIEW_ORIGIN) =>
  new Request(`${origin}${path}`, { headers: { authorization: `Bearer ${SECRET}` } });

function previewEnv() {
  vi.stubEnv('VERCEL_ENV', 'preview');
  vi.stubEnv('PREVIEW_FAMILY_ALLOWLIST', TEST_FAM);
  vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
  vi.stubEnv('APP_URL', 'https://villagehale.com');
}

describe('Preview drains its own queue', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
  beforeEach(() => {
    vi.resetModules();
    afterFns.length = 0;
    vi.stubEnv('CRON_SECRET', SECRET);
    vi.stubEnv('DATABASE_URL', 'postgres://x');
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    pgBossCtor.mockClear();
    fetchMock.mockClear();
    runDrainCronMock.mockClear();
    firstReplyMock.mockClear();
    groupTickMock.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a Preview producer enqueues into the Preview schema; production stays on pgboss', async () => {
    previewEnv();
    await (await import('~/lib/queue')).getQueue();
    expect(pgBossCtor).toHaveBeenLastCalledWith(
      expect.objectContaining({ schema: 'pgboss_preview' }),
    );
    vi.resetModules();
    vi.stubEnv('VERCEL_ENV', 'production');
    await (await import('~/lib/queue')).getQueue();
    expect(pgBossCtor).toHaveBeenLastCalledWith(expect.objectContaining({ schema: 'pgboss' }));
  });

  it('the scheduled drain runs on Preview and skips the shared-table legs', async () => {
    previewEnv();
    const { GET } = await import('~/app/api/cron/drain/route');
    const res = await GET(req('/api/cron/drain'));
    expect(res.status).toBe(200);
    expect(runDrainCronMock).toHaveBeenCalledTimes(1);
    expect(firstReplyMock).not.toHaveBeenCalled();
    expect(groupTickMock).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.firstReply).toEqual({ skipped: 'preview' });
    expect(body.groupReminders).toEqual({ skipped: 'preview' });
  });

  it('a kicked inbound drain runs on Preview', async () => {
    previewEnv();
    const { GET } = await import('~/app/api/cron/drain/route');
    const res = await GET(req('/api/cron/drain?queues=channel.message.received'));
    expect(res.status).toBe(202);
    for (const fn of afterFns) await fn();
    expect(runDrainCronMock).toHaveBeenCalledWith({ queues: ['channel.message.received'] });
  });

  it('the Preview reminder cron kicks its own channel.send drain at its own origin', async () => {
    previewEnv();
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'bypass');
    const { GET } = await import('~/app/api/cron/reminders/route');
    await GET(req('/api/cron/reminders'));
    for (const fn of afterFns) await fn();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(`${PREVIEW_ORIGIN}/api/cron/drain?queues=channel.send`);
    expect(init.headers).toEqual({
      authorization: `Bearer ${SECRET}`,
      'x-vercel-protection-bypass': 'bypass',
    });
  });

  it('production reminders do not kick; production drain origin is still APP_URL', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('APP_URL', 'https://villagehale.com');
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'bypass');
    const { GET } = await import('~/app/api/cron/reminders/route');
    await GET(req('/api/cron/reminders'));
    for (const fn of afterFns) await fn();
    expect(fetchMock).not.toHaveBeenCalled();
    const { drainOrigin } = await import('~/lib/cron/kick-drain');
    expect(drainOrigin(req('/x'))).toBe('https://villagehale.com');
  });

  it('Preview inbound kicks its own origin, not APP_URL', async () => {
    previewEnv();
    const { drainOrigin } = await import('~/lib/cron/kick-drain');
    expect(drainOrigin(req('/api/channels/preview/inbound'))).toBe(PREVIEW_ORIGIN);
  });
});
