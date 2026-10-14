import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoopStopNotifier, dispatchLoopStopSideEffects } from './stop-alert';

const USER_ID = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  vi.stubEnv('RESEND_API_KEY', 'test-key');
  vi.stubEnv('FOUNDER_ALERT_EMAIL', 'founder@villagehale.com');
  vi.stubEnv('WELCOME_BCC', '');
  vi.stubEnv('WELCOME_FROM', '');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('createLoopStopNotifier', () => {
  it('posts to #ops naming only the loop stream — no parent/child identifying detail', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://hooks.slack.com/services/test');
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('ok', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchImpl);

    const sent = await createLoopStopNotifier().notifyStop('weekly_plan');

    expect(sent).toBe(true);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { text: string };
    expect(body.text).toContain('weekly_plan');
    expect(body.text).not.toContain('@');
  });

  it('does NOT send when #ops is not configured', async () => {
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', '');

    const sent = await createLoopStopNotifier().notifyStop('reminder');

    expect(sent).toBe(false);
  });
});

describe('dispatchLoopStopSideEffects', () => {
  it('fires the founder alert and loop_stop analytics in parallel', async () => {
    const notifyStop = vi.fn(async () => true);
    const capture = vi.fn(async () => 'sent' as const);

    await dispatchLoopStopSideEffects(
      { userId: USER_ID, category: 'weekly_plan' },
      { founder: { notifyStop }, captureServerEvent: capture },
    );

    expect(notifyStop).toHaveBeenCalledWith('weekly_plan');
    expect(capture).toHaveBeenCalledWith('loop_stop', USER_ID, { category: 'weekly_plan' });
  });

  it('says so when the alert was refused before it left (VIL-267)', async () => {
    // `false` is the notifier's "no founder address / no Resend key" answer — it does
    // not throw, so without this a CASL STOP nobody was paged about looks identical to
    // one that reached the founder.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notifyStop = vi.fn(async () => false);

    await dispatchLoopStopSideEffects(
      { userId: USER_ID, category: 'weekly_plan' },
      { founder: { notifyStop }, captureServerEvent: vi.fn(async () => 'sent' as const) },
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not delivered'), {
      category: 'weekly_plan',
    });
  });

  it('does NOT throw when the founder alert fails — the other effect still runs', async () => {
    const notifyStop = vi.fn(async () => {
      throw new Error('resend down');
    });
    const capture = vi.fn(async () => 'sent' as const);

    await expect(
      dispatchLoopStopSideEffects(
        { userId: USER_ID, category: 'reminder' },
        { founder: { notifyStop }, captureServerEvent: capture },
      ),
    ).resolves.toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('does NOT throw when analytics capture fails — the founder alert still runs', async () => {
    const notifyStop = vi.fn(async () => true);
    const capture = vi.fn(async () => {
      throw new Error('posthog down');
    });

    await expect(
      dispatchLoopStopSideEffects(
        { userId: USER_ID, category: 'alert' },
        { founder: { notifyStop }, captureServerEvent: capture },
      ),
    ).resolves.toBeUndefined();
    expect(notifyStop).toHaveBeenCalledTimes(1);
  });
});
