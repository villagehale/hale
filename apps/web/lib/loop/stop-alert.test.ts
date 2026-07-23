import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoopStopNotifier, dispatchLoopStopSideEffects } from './stop-alert';

// X1 (VIL-227) · the STOP guardrail: page the founder at ANY loop-category
// unsubscribe, immediately. Mirrors founder-signal.test.ts's fake-Resend-client
// conventions so no real Resend/PostHog is touched.

const USER_ID = '55555555-5555-4555-8555-555555555555';

interface SendPayload {
  to: string;
  from: string;
  subject: string;
  text: string;
}

function fakeResend() {
  const send = vi.fn(async (_payload: SendPayload) => ({ data: { id: 'resend-stop-1' }, error: null }));
  return { emails: { send } } as never;
}

function sendOf(client: unknown): Mock<(payload: SendPayload) => Promise<unknown>> {
  return (client as { emails: { send: Mock<(payload: SendPayload) => Promise<unknown>> } }).emails
    .send;
}

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
  it('alerts the founder naming only the loop stream — no parent/child identifying detail', async () => {
    const client = fakeResend();

    const sent = await createLoopStopNotifier(client).notifyStop('weekly_plan');

    expect(sent).toBe(true);
    const payload = sendOf(client).mock.calls[0]?.[0];
    expect(payload?.to).toBe('founder@villagehale.com');
    expect(payload?.subject).toContain('weekly_plan');
    expect(payload?.text).toContain('weekly_plan');
    // notifyStop takes only an enum category — no email/userId ever reaches the
    // body, so no '@' can appear in it regardless of who unsubscribed.
    expect(payload?.text).not.toContain('@');
  });

  it('does NOT send when no founder address is configured', async () => {
    vi.stubEnv('FOUNDER_ALERT_EMAIL', '');
    const client = fakeResend();

    const sent = await createLoopStopNotifier(client).notifyStop('reminder');

    expect(sent).toBe(false);
    expect(sendOf(client)).not.toHaveBeenCalled();
  });
});

describe('dispatchLoopStopSideEffects', () => {
  it('fires the founder alert and loop_stop analytics in parallel', async () => {
    const notifyStop = vi.fn(async () => true);
    const capture = vi.fn(async () => {});

    await dispatchLoopStopSideEffects(
      { userId: USER_ID, category: 'weekly_plan' },
      { founder: { notifyStop }, captureServerEvent: capture },
    );

    expect(notifyStop).toHaveBeenCalledWith('weekly_plan');
    expect(capture).toHaveBeenCalledWith('loop_stop', USER_ID, { category: 'weekly_plan' });
  });

  it('does NOT throw when the founder alert fails — the other effect still runs', async () => {
    const notifyStop = vi.fn(async () => {
      throw new Error('resend down');
    });
    const capture = vi.fn(async () => {});

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
