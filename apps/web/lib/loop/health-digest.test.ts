import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLoopHealthDigestSender,
  formatLoopHealthDigest,
  type LoopHealthSummary,
  runLoopHealthDigestCron,
} from './health-digest';

/**
 * X1 (VIL-227) · the weekly founder digest. The DB aggregation (aggregateLoopHealth)
 * stays thin/untested-in-isolation here, mirroring monitoring/spend.ts's split —
 * the pure formatter and the injected-deps orchestration are what's unit-tested.
 */

describe('formatLoopHealthDigest — pure, worked summaries', () => {
  it('formats plans composed, STOP count, and a per-channel/category/status breakdown', () => {
    const summary: LoopHealthSummary = {
      windowStart: new Date('2026-07-13T00:00:00Z'),
      windowEnd: new Date('2026-07-20T00:00:00Z'),
      messageCounts: [
        { channel: 'email', category: 'weekly_plan', status: 'sent', count: 42 },
        { channel: 'push', category: 'weekly_plan', status: 'sent', count: 30 },
        { channel: 'email', category: 'reminder', status: 'suppressed_quiet_hours', count: 3 },
      ],
      stopCount: 1,
      weekPlansComposed: 45,
    };

    const body = formatLoopHealthDigest(summary);

    expect(body).toContain('2026-07-13');
    expect(body).toContain('2026-07-20');
    expect(body).toContain('Weekly plans composed: 45');
    expect(body).toContain('STOPs (loop unsubscribes): 1');
    expect(body).toContain('email · weekly_plan · sent: 42');
    expect(body).toContain('push · weekly_plan · sent: 30');
    expect(body).toContain('email · reminder · suppressed_quiet_hours: 3');
  });

  it('is honest about an empty week — "(none)", never a fabricated row', () => {
    const summary: LoopHealthSummary = {
      windowStart: new Date('2026-07-13T00:00:00Z'),
      windowEnd: new Date('2026-07-20T00:00:00Z'),
      messageCounts: [],
      stopCount: 0,
      weekPlansComposed: 0,
    };

    expect(formatLoopHealthDigest(summary)).toContain('(none)');
  });
});

interface SendPayload {
  to: string;
  from: string;
  subject: string;
  text: string;
}

function fakeResend() {
  const send = vi.fn(async (_payload: SendPayload) => ({ data: { id: 'resend-digest-1' }, error: null }));
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
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createLoopHealthDigestSender', () => {
  it('emails the founder the given body', async () => {
    const client = fakeResend();

    const sent = await createLoopHealthDigestSender(client).send('the digest body');

    expect(sent).toBe(true);
    const payload = sendOf(client).mock.calls[0]?.[0];
    expect(payload?.to).toBe('founder@villagehale.com');
    expect(payload?.text).toBe('the digest body');
  });

  it('does NOT send when no founder address is configured', async () => {
    vi.stubEnv('FOUNDER_ALERT_EMAIL', '');
    const client = fakeResend();

    expect(await createLoopHealthDigestSender(client).send('body')).toBe(false);
    expect(sendOf(client)).not.toHaveBeenCalled();
  });
});

describe('runLoopHealthDigestCron', () => {
  const NOW = new Date('2026-07-20T14:00:00Z');
  const summary: LoopHealthSummary = {
    windowStart: new Date('2026-07-13T14:00:00Z'),
    windowEnd: NOW,
    messageCounts: [{ channel: 'email', category: 'weekly_plan', status: 'sent', count: 5 }],
    stopCount: 0,
    weekPlansComposed: 5,
  };

  it('aggregates the trailing 7-day window and emails the founder the formatted digest', async () => {
    const aggregate = vi.fn(async (_db: unknown, windowStart: Date, windowEnd: Date) => {
      expect(windowEnd).toEqual(NOW);
      expect(windowStart).toEqual(new Date('2026-07-13T14:00:00Z'));
      return summary;
    });
    const send = vi.fn(async () => true);

    const result = await runLoopHealthDigestCron({} as never, { aggregate, sender: { send } }, NOW);

    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(formatLoopHealthDigest(summary));
    expect(result).toEqual({ sent: true, summary });
  });

  it('reports sent: false when the sender skips (no founder address configured)', async () => {
    const aggregate = vi.fn(async () => summary);
    const send = vi.fn(async () => false);

    const result = await runLoopHealthDigestCron({} as never, { aggregate, sender: { send } }, NOW);

    expect(result.sent).toBe(false);
  });
});
