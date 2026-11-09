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
const runFirstReplyRecoveryCronMock = vi.fn();
const providerPreflightMock = vi.fn();
const runGroupReminderTickMock = vi.fn();
const recoverHeldOptOutReadsMock = vi.fn();

vi.mock('~/lib/cron/drain', async (importActual) => ({
  ...(await importActual<typeof import('~/lib/cron/drain')>()),
  runDrainCron: (...args: unknown[]) => runDrainCronMock(...args),
}));
vi.mock('~/lib/telemetry/langfuse', () => ({ flushTelemetry: async () => {} }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/channel/intake/first-reply-recovery', async (importActual) => ({
  ...(await importActual<typeof import('~/lib/channel/intake/first-reply-recovery')>()),
  runFirstReplyRecoveryCron: (...args: unknown[]) => runFirstReplyRecoveryCronMock(...args),
}));
vi.mock('~/lib/channel/intake/opt-out-recovery', async (importActual) => ({
  ...(await importActual<typeof import('~/lib/channel/intake/opt-out-recovery')>()),
  recoverHeldOptOutReads: (...args: unknown[]) => recoverHeldOptOutReadsMock(...args),
}));
vi.mock('~/lib/monitoring/provider-health', async (importActual) => ({
  ...(await importActual<typeof import('~/lib/monitoring/provider-health')>()),
  providerPreflight: (...args: unknown[]) => providerPreflightMock(...args),
}));
vi.mock('~/lib/loop/reminders/group/fire', async (importActual) => ({
  ...(await importActual<typeof import('~/lib/loop/reminders/group/fire')>()),
  runGroupReminderTick: (...args: unknown[]) => runGroupReminderTickMock(...args),
}));

function lightGroupReminders(): void {
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_TURN_AI_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_REMINDERS_ENABLED', 'true');
}
const afterCallbacks: Array<() => Promise<void> | void> = [];
vi.mock('next/server', async (importActual) => ({
  ...(await importActual<typeof import('next/server')>()),
  after: (fn: () => Promise<void> | void) => {
    afterCallbacks.push(fn);
  },
}));

const SECRET = 'test-cron-secret';
const OPT_OUT_RECOVERY_RESULT = {
  repointed: 1,
  legacyNoChannel: 0,
  legacyUnpointed: 0,
  outcomes: { stopped: 1 },
  deferred: 0,
  halted: null,
};

function request(url = 'https://app.example.com/api/cron/drain'): Request {
  return new Request(url, { headers: { authorization: `Bearer ${SECRET}` } });
}

describe('GET /api/cron/drain', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    runDrainCronMock.mockReset();
    runFirstReplyRecoveryCronMock
      .mockReset()
      .mockResolvedValue({ evaluated: 0, sent: 0, skipped: 0, failed: 0, deferred: 0 });
    providerPreflightMock.mockReset();
    recoverHeldOptOutReadsMock.mockReset().mockResolvedValue(OPT_OUT_RECOVERY_RESULT);
    runGroupReminderTickMock.mockReset().mockResolvedValue({
      due: 0,
      sent: 0,
      dropped: 0,
      failed: 0,
      lost: 0,
      retrying: 0,
    });
    afterCallbacks.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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
    const response = await GET(
      request('https://app.example.com/api/cron/drain?queues=channel.message.received'),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      kicked: true,
      queues: ['channel.message.received'],
    });
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
    const response = await GET(
      request('https://app.example.com/api/cron/drain?queues=channel.message.received'),
    );
    expect(response.status).toBe(202);
    await expect(afterCallbacks[0]?.()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      expect.objectContaining({ dbUnavailable: false }),
      'cron/drain kicked run failed',
    );
  });

  it('answers the summary on a clean run', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-a-secret');
    const { GET } = await import('./route');
    runDrainCronMock.mockResolvedValue({ processed: 2, failed: 0, dropped: 1 });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      processed: 2,
      failed: 0,
      dropped: 1,
      socialSignup: { skipped: 'flag_off' },
      firstReply: expect.any(Object),
      groupReminders: { skipped: 'flag_off' },
      optOutRecovery: OPT_OUT_RECOVERY_RESULT,
    });
    expect(runGroupReminderTickMock).not.toHaveBeenCalled();
  });

  it('sends due group reminders every scheduled minute once all three flags are on', async () => {
    lightGroupReminders();
    const { GET } = await import('./route');
    runDrainCronMock.mockResolvedValue({ processed: 0, failed: 0, dropped: 0 });
    const summary = { due: 3, sent: 2, dropped: 1, failed: 0, lost: 0, retrying: 0 };
    runGroupReminderTickMock.mockResolvedValue(summary);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(runGroupReminderTickMock).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({ groupReminders: summary });
  });

  it('keeps the reminder leg dark until the AI turn reader is on too', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_REMINDERS_ENABLED', 'true');
    const { GET } = await import('./route');
    runDrainCronMock.mockResolvedValue({ processed: 0, failed: 0, dropped: 0 });

    const response = await GET(request());

    expect(await response.json()).toMatchObject({ groupReminders: { skipped: 'flag_off' } });
    expect(runGroupReminderTickMock).not.toHaveBeenCalled();
  });

  it('names a failed reminder leg and still drains', async () => {
    lightGroupReminders();
    const { GET } = await import('./route');
    runGroupReminderTickMock.mockRejectedValue(new Error('leg blew up'));
    runDrainCronMock.mockResolvedValue({ processed: 1, failed: 0, dropped: 0 });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(runDrainCronMock).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({
      processed: 1,
      groupReminders: { skipped: 'tick_failed' },
    });
  });

  it('runs the first-reply leg every scheduled minute with the friend-voice composer', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-a-secret');
    const { GET } = await import('./route');
    runDrainCronMock.mockResolvedValue({ processed: 0, failed: 0, dropped: 0 });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(runFirstReplyRecoveryCronMock).toHaveBeenCalledTimes(1);
    const [, deps] = runFirstReplyRecoveryCronMock.mock.calls[0] ?? [];
    expect(typeof deps.friendVoice?.compose).toBe('function');
    expect(typeof deps.limiter?.check).toBe('function');
  });

  it('asks the provider pre-flight with the same client before the leg speaks', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-a-secret');
    const held = {
      proceed: false,
      abort: {
        failure: 'billing',
        httpStatus: 400,
        errorType: 'invalid_request_error',
        alerted: true,
      },
    };
    providerPreflightMock.mockResolvedValue(held);
    const { GET } = await import('./route');
    runDrainCronMock.mockResolvedValue({ processed: 0, failed: 0, dropped: 0 });

    await GET(request());
    const [, deps] = runFirstReplyRecoveryCronMock.mock.calls[0] ?? [];

    await expect(deps.preflight()).resolves.toEqual(held);
    expect(providerPreflightMock).toHaveBeenCalledWith(
      expect.anything(),
      'first_reply_recovery',
      expect.objectContaining({ messages: expect.anything() }),
      expect.any(Date),
    );
  });

  it('names a failed first-reply leg and still drains', async () => {
    const { GET } = await import('./route');
    runFirstReplyRecoveryCronMock.mockRejectedValue(new Error('leg blew up'));
    runDrainCronMock.mockResolvedValue({ processed: 1, failed: 0, dropped: 0 });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      processed: 1,
      firstReply: { skipped: 'tick_failed' },
    });
  });

  it('VIL-553: re-reads held opt-out texts every scheduled minute, before the first reply', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-a-secret');
    const order: string[] = [];
    recoverHeldOptOutReadsMock.mockImplementation(async () => {
      order.push('opt_out_recovery');
      return OPT_OUT_RECOVERY_RESULT;
    });
    runFirstReplyRecoveryCronMock.mockImplementation(async () => {
      order.push('first_reply');
      return { evaluated: 0, sent: 0, skipped: 0, failed: 0, deferred: 0 };
    });
    const { GET } = await import('./route');
    runDrainCronMock.mockResolvedValue({ processed: 0, failed: 0, dropped: 0 });

    const response = await GET(request());

    expect(await response.json()).toMatchObject({ optOutRecovery: OPT_OUT_RECOVERY_RESULT });
    expect(order).toEqual(['opt_out_recovery', 'first_reply']);
    const [, deps] = recoverHeldOptOutReadsMock.mock.calls[0] ?? [];
    expect(typeof deps.reader?.read).toBe('function');
    expect(typeof deps.transport?.send).toBe('function');
    expect(deps.now).toBeInstanceOf(Date);
  });

  it('asks the pre-flight on its own window before re-reading held texts', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-a-secret');
    const held = {
      proceed: false,
      abort: {
        failure: 'billing',
        httpStatus: 400,
        errorType: 'invalid_request_error',
        alerted: true,
      },
    };
    providerPreflightMock.mockResolvedValue(held);
    const { GET } = await import('./route');
    runDrainCronMock.mockResolvedValue({ processed: 0, failed: 0, dropped: 0 });

    await GET(request());
    const [, deps] = recoverHeldOptOutReadsMock.mock.calls[0] ?? [];

    await expect(deps.preflight()).resolves.toEqual(held);
    expect(providerPreflightMock).toHaveBeenCalledWith(
      expect.anything(),
      'opt_out_recovery',
      expect.objectContaining({ messages: expect.anything() }),
      expect.any(Date),
    );
  });

  it('names a failed opt-out recovery leg and still drains', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-a-secret');
    const { GET } = await import('./route');
    const thrown = new Error('leg blew up near a held text');
    recoverHeldOptOutReadsMock.mockRejectedValue(thrown);
    runDrainCronMock.mockResolvedValue({ processed: 1, failed: 0, dropped: 0 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(runDrainCronMock).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({
      processed: 1,
      optOutRecovery: { skipped: 'tick_failed' },
    });
    // The error's name only: its message or stack may carry what the leg was reading.
    const leg = errors.mock.calls.find((call) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('opt-out recovery leg failed')),
    );
    expect(leg?.[0]).toEqual({ err: 'Error', skipped: 'tick_failed' });
    expect(errors.mock.calls.flat()).not.toContain(thrown);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('near a held text');
  });

  it('skips the opt-out recovery leg on Preview, which shares the prod database', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-a-secret');
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('PREVIEW_FAMILY_ALLOWLIST', '00000000-0000-4000-8000-0000000000aa');
    vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', 'on');
    const { GET } = await import('./route');
    runDrainCronMock.mockResolvedValue({ processed: 0, failed: 0, dropped: 0 });

    const response = await GET(request());

    expect(await response.json()).toMatchObject({ optOutRecovery: { skipped: 'preview' } });
    expect(recoverHeldOptOutReadsMock).not.toHaveBeenCalled();
  });

  it('leaves the first-reply leg out of a kicked run', async () => {
    const { GET } = await import('./route');
    runDrainCronMock.mockResolvedValue({ processed: 1, failed: 0, dropped: 0 });
    await GET(request('https://app.example.com/api/cron/drain?queues=channel.message.received'));
    await afterCallbacks[0]?.();
    expect(runFirstReplyRecoveryCronMock).not.toHaveBeenCalled();
    expect(runGroupReminderTickMock).not.toHaveBeenCalled();
    expect(recoverHeldOptOutReadsMock).not.toHaveBeenCalled();
  });
});
