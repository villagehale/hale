import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitmentDebt } from '~/lib/commitments/ledger';
import { type FunnelScoreboard, formatFunnelScoreboard } from './funnel-scoreboard';
import {
  createLoopHealthDigestSender,
  formatLoopHealthDigest,
  type LoopHealthSummary,
  runLoopHealthDigestCron,
} from './health-digest';

/** The pre-launch scoreboard — the state every fixture below is in. */
const EMPTY_SCOREBOARD: FunnelScoreboard = {
  intake: { sessionsStarted: 0, provisioned: 0, watchConsented: 0 },
  ttfa: { p50Seconds: null, derivedFamilies: 0, notDerivableFamilies: 0 },
  nudges: { sent: 0, matured: 0, replied: 0 },
  cogs: { totalUsd: 0, families: 0 },
};

/** MEM-10 · an empty open-loops ledger: Hale has promised nothing and owes nothing. */
const NO_DEBT: CommitmentDebt = {
  overdueFamilies: 0,
  overdueCommitments: 0,
  openCommitments: 0,
};

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
      providerIncidents: [],
      scoreboard: EMPTY_SCOREBOARD,
      commitmentDebt: NO_DEBT,
      unmetIntents: [],
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
      providerIncidents: [],
      scoreboard: EMPTY_SCOREBOARD,
      commitmentDebt: NO_DEBT,
      unmetIntents: [],
    };

    expect(formatLoopHealthDigest(summary)).toContain('(none)');
  });

  // VIL-255 · the one-line provider-health status.
  it('says the LLM provider was quiet when no incident was raised all week', () => {
    const summary: LoopHealthSummary = {
      windowStart: new Date('2026-07-13T00:00:00Z'),
      windowEnd: new Date('2026-07-20T00:00:00Z'),
      messageCounts: [],
      stopCount: 0,
      weekPlansComposed: 0,
      providerIncidents: [],
      scoreboard: EMPTY_SCOREBOARD,
      commitmentDebt: NO_DEBT,
      unmetIntents: [],
    };

    expect(formatLoopHealthDigest(summary)).toContain('LLM provider: no incidents');
  });

  it('names each provider incident class and when it was last raised', () => {
    const summary: LoopHealthSummary = {
      windowStart: new Date('2026-07-27T00:00:00Z'),
      windowEnd: new Date('2026-08-03T00:00:00Z'),
      messageCounts: [],
      stopCount: 0,
      weekPlansComposed: 0,
      providerIncidents: [
        { kind: 'billing', at: new Date('2026-08-01T00:00:00Z') },
        { kind: 'run_spike', at: new Date('2026-07-29T00:00:00Z') },
        { kind: 'run_spike', at: new Date('2026-07-30T00:00:00Z') },
      ],
      scoreboard: EMPTY_SCOREBOARD,
      commitmentDebt: NO_DEBT,
      unmetIntents: [],
    };

    const line = formatLoopHealthDigest(summary)
      .split('\n')
      .find((l) => l.includes('LLM provider'));

    expect(line).toBe('LLM provider: 3 incidents — billing ×1, run_spike ×2 (last 2026-08-01)');
  });

  // X1 · the F14 intake-funnel scoreboard rides on this digest. Its own lines are
  // worked in funnel-scoreboard.test.ts; what matters here is that they are CARRIED.
  it('carries every F14 scoreboard line, honest before the first cohort arrives', () => {
    const body = formatLoopHealthDigest({
      windowStart: new Date('2026-07-13T00:00:00Z'),
      windowEnd: new Date('2026-07-20T00:00:00Z'),
      messageCounts: [],
      stopCount: 0,
      weekPlansComposed: 0,
      providerIncidents: [],
      scoreboard: EMPTY_SCOREBOARD,
      commitmentDebt: NO_DEBT,
      unmetIntents: [],
    });

    for (const line of formatFunnelScoreboard(EMPTY_SCOREBOARD)) {
      expect(body).toContain(line);
    }
    expect(body).toContain('no sessions started yet');
  });
});

/**
 * VIL-273 · the demand signal. Every text Hale declined to take on is one row, bucketed
 * and counted — the only place the founder finds out WHAT parents keep asking for that
 * Hale does not do yet.
 */
describe('formatLoopHealthDigest — top unmet intents', () => {
  const base = {
    windowStart: new Date('2026-08-03T00:00:00Z'),
    windowEnd: new Date('2026-08-10T00:00:00Z'),
    messageCounts: [],
    stopCount: 0,
    weekPlansComposed: 0,
    providerIncidents: [],
    scoreboard: EMPTY_SCOREBOARD,
    commitmentDebt: NO_DEBT,
  };

  it('ranks the buckets by how often they were asked', () => {
    const body = formatLoopHealthDigest({
      ...base,
      unmetIntents: [
        { lane: 'provider_access', category: 'doctor-access', count: 3 },
        { lane: 'off_domain_general', category: 'weather', count: 11 },
        { lane: 'safety_critical', category: 'medical-symptom', count: 5 },
      ],
    });

    const listed = body
      .split('\n')
      .filter((l) => l.startsWith('  ') && l.includes('·') && l.includes(':'));
    expect(listed).toEqual([
      '  off_domain_general · weather: 11',
      '  safety_critical · medical-symptom: 5',
      '  provider_access · doctor-access: 3',
    ]);
  });

  /**
   * A zero here is a real measurement, not missing data — so the line says which of the
   * two it is rather than leaving a founder to guess whether the lane is even live.
   */
  it('says nothing was deflected rather than printing an empty heading', () => {
    const body = formatLoopHealthDigest({ ...base, unmetIntents: [] });

    expect(body).toContain('Top unmet intents (7d):');
    expect(body).toContain('  (none - no text was deflected this week)');
  });

  /** Counts and buckets only. A category is drawn from a closed vocabulary precisely so
   * this email can never carry a child's name or a symptom (rule #1). */
  it('carries the heading above the breakdown', () => {
    const body = formatLoopHealthDigest({
      ...base,
      unmetIntents: [{ lane: 'off_domain_general', category: 'other', count: 1 }],
    });
    const lines = body.split('\n');
    const heading = lines.indexOf('Top unmet intents (7d):');
    expect(heading).toBeGreaterThan(-1);
    expect(lines[heading + 1]).toBe('  off_domain_general · other: 1');
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
    providerIncidents: [],
    scoreboard: EMPTY_SCOREBOARD,
    commitmentDebt: NO_DEBT,
    unmetIntents: [{ lane: 'off_domain_general', category: 'weather', count: 2 }],
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


/**
 * MEM-10 · the open-loops line. What a founder is being told is how many FAMILIES are
 * waiting on something Hale said it would do — not how many rows are late, because one
 * family owed two things is still one apology to write.
 */
describe('formatLoopHealthDigest — overdue commitments', () => {
  const base = {
    windowStart: new Date('2026-08-04T00:00:00Z'),
    windowEnd: new Date('2026-08-11T00:00:00Z'),
    messageCounts: [],
    stopCount: 0,
    weekPlansComposed: 0,
    providerIncidents: [],
    scoreboard: EMPTY_SCOREBOARD,
    unmetIntents: [],
  };

  function debtLine(summary: LoopHealthSummary): string {
    const line = formatLoopHealthDigest(summary)
      .split('\n')
      .find((l) => l.startsWith('Open loops:'));
    if (!line) throw new Error('digest carries no open-loops line');
    return line;
  }

  it('counts families owed, and says how many promises that is', () => {
    const line = debtLine({
      ...base,
      commitmentDebt: { overdueFamilies: 3, overdueCommitments: 4, openCommitments: 9 },
    });

    expect(line).toBe(
      'Open loops: Hale owes 3 families something overdue (4 promises past due, 9 open)',
    );
  });

  it('does not pluralise a single family into a crowd', () => {
    const line = debtLine({
      ...base,
      commitmentDebt: { overdueFamilies: 1, overdueCommitments: 1, openCommitments: 1 },
    });

    expect(line).toBe(
      'Open loops: Hale owes 1 family something overdue (1 promise past due, 1 open)',
    );
  });

  /** The two zeros mean completely different things and only one of them is good news:
   * a ledger nothing has written to is not the same as a ledger with nothing late. */
  it('separates "nothing late" from "nothing tracked"', () => {
    expect(
      debtLine({
        ...base,
        commitmentDebt: { overdueFamilies: 0, overdueCommitments: 0, openCommitments: 6 },
      }),
    ).toBe('Open loops: none overdue - 6 open and still in time');

    expect(
      debtLine({
        ...base,
        commitmentDebt: { overdueFamilies: 0, overdueCommitments: 0, openCommitments: 0 },
      }),
    ).toBe('Open loops: no promise is open - nothing has been recorded yet');
  });
});
