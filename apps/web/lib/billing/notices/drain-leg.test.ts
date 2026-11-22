import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VIL-735 · the billing notice leg on the scheduled drain: flag off, Preview and a thrown
 * leg are each a named result, the queues still run first, and a kicked run never takes it.
 */

const runDrainCronMock = vi.fn(async () => ({ drained: 0 }));
vi.mock('~/lib/cron/drain', () => ({
  DRAINABLE_QUEUES: ['channel.send', 'channel.message.received'],
  isConnectionExhaustion: () => false,
  runDrainCron: (...a: unknown[]) => runDrainCronMock(...(a as [])),
}));
vi.mock('~/lib/cron/kicked-drain', () => ({
  defaultKickedDrainTiming: {},
  runKickedDrain: vi.fn(async () => {}),
}));
vi.mock('~/lib/channel/intake/first-reply-recovery', () => ({
  firstReplyRecoveryDeps: () => ({}),
  runFirstReplyRecoveryCron: async () => ({ checked: 0 }),
}));
vi.mock('~/lib/channel/intake/opt-out-recovery', () => ({
  recoverHeldOptOutReads: async () => ({ read: 0 }),
}));
vi.mock('~/lib/channel/inbound-deps', () => ({ optOutRecoveryPorts: () => ({}) }));
vi.mock('~/lib/loop/reminders/group/flag', () => ({ groupRemindersLive: () => false }));
vi.mock('~/lib/loop/reminders/run', () => ({
  recheckHeldReminders: async () => ({ rechecked: 0 }),
}));
vi.mock('~/lib/monitoring/anthropic-credit', () => ({
  anthropicCreditAlertEnabled: () => false,
}));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/cron/heartbeat', () => ({ stampCronHeartbeat: vi.fn() }));
vi.mock('~/lib/telemetry/langfuse', () => ({ flushTelemetry: async () => {} }));
vi.mock('next/server', async (importActual) => ({
  ...(await importActual<typeof import('next/server')>()),
  after: () => {},
}));

const tickMock = vi.fn();
const depsMock = vi.fn((_database: unknown, _startedAt: number) => ({ wired: true }));
vi.mock('~/lib/billing/notices/run', () => ({
  defaultBillingNoticeDeps: (database: unknown, startedAt: number) => depsMock(database, startedAt),
  runBillingNoticeTick: (...a: unknown[]) => tickMock(...a),
}));

const SECRET = 'test-cron-secret';
const SINCE = '2026-11-01T00:00:00Z';

async function drain(path = '/api/cron/drain') {
  const { GET } = await import('~/app/api/cron/drain/route');
  const res = await GET(
    new Request(`https://hale.test${path}`, { headers: { authorization: `Bearer ${SECRET}` } }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('DATABASE_URL', 'postgres://x');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  runDrainCronMock.mockClear();
  tickMock.mockReset();
  depsMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the billing notice leg', () => {
  it('flag off: a named skip, no tick, and the drain still runs', async () => {
    vi.stubEnv('BILLING_THREAD_NOTICES_ENABLED', undefined);
    const { status, body } = await drain();
    expect(status).toBe(200);
    expect(body.billingNotices).toEqual({ skipped: 'flag_off' });
    expect(tickMock).not.toHaveBeenCalled();
    expect(runDrainCronMock).toHaveBeenCalledTimes(1);
  });

  it('armed: runs after the queues, with the run’s own start time', async () => {
    vi.stubEnv('BILLING_THREAD_NOTICES_ENABLED', 'true');
    vi.stubEnv('BILLING_THREAD_NOTICES_SINCE', SINCE);
    const order: string[] = [];
    runDrainCronMock.mockImplementationOnce(async () => {
      order.push('queues');
      return { drained: 0 };
    });
    const summary = {
      due: 1,
      sent: 1,
      held: 0,
      retrying: 0,
      dropped: 0,
      skipped: 0,
      stopped: null,
    };
    tickMock.mockImplementationOnce(async () => {
      order.push('notices');
      return summary;
    });
    const before = Date.now();
    const { body } = await drain();
    expect(order).toEqual(['queues', 'notices']);
    expect(body.billingNotices).toEqual(summary);
    const startedAt = depsMock.mock.calls[0]?.[1] as number;
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(startedAt).toBeLessThanOrEqual(Date.now());
  });

  it('on Preview: a named skip and no tick, even armed', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('PREVIEW_FAMILY_ALLOWLIST', '11111111-1111-4111-8111-111111111111');
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
    vi.stubEnv('APP_URL', 'https://villagehale.com');
    vi.stubEnv('BILLING_THREAD_NOTICES_ENABLED', 'true');
    vi.stubEnv('BILLING_THREAD_NOTICES_SINCE', SINCE);
    const { body } = await drain();
    expect(body.billingNotices).toEqual({ skipped: 'preview' });
    expect(tickMock).not.toHaveBeenCalled();
  });

  it('a thrown leg is tick_failed and the run still answers 200', async () => {
    vi.stubEnv('BILLING_THREAD_NOTICES_ENABLED', 'true');
    vi.stubEnv('BILLING_THREAD_NOTICES_SINCE', SINCE);
    tickMock.mockRejectedValueOnce(new Error('boom with private words'));
    const { status, body } = await drain();
    expect(status).toBe(200);
    expect(body.billingNotices).toEqual({ skipped: 'tick_failed' });
    const logged = JSON.stringify(
      (console.error as unknown as { mock: { calls: unknown[] } }).mock.calls,
    );
    expect(logged).not.toContain('private words');
  });

  it('a kicked run never takes the leg', async () => {
    vi.stubEnv('BILLING_THREAD_NOTICES_ENABLED', 'true');
    vi.stubEnv('BILLING_THREAD_NOTICES_SINCE', SINCE);
    const { status, body } = await drain('/api/cron/drain?queues=channel.send');
    expect(status).toBe(202);
    expect(body.billingNotices).toBeUndefined();
    expect(tickMock).not.toHaveBeenCalled();
  });
});
