import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DigestEmailSender } from './email';
import { runDigestForFamily } from './digest';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-06-17T13:00:00Z'); // 9am Toronto (EDT)

/** A child young enough that companionForChild yields a soon-due health item +
 * an in-window milestone (so get_companion_brief returns a highlight). */
const TODDLER_DOB = '2024-06-01';

interface Capture {
  auditLog: unknown[];
  dailyDigests: unknown[];
  agentRuns: Record<string, unknown>[];
  emailSends: unknown[];
}

/**
 * Fakes the exact Drizzle chains runDigestForFamily + its tools run. Selects are
 * routed by the FROM table (robust to ordering); inserts by table identity. No
 * real DB. The recipient select reads {userId,email}; the opt-out select reads
 * email_opt_outs (returns rows iff optedOut).
 */
function fakeDb(args: {
  recipient: { userId: string; email: string } | null;
  children: Array<{ id: string; name: string; dateOfBirth: string }>;
  optedOut?: boolean;
  capture: Capture;
}) {
  const select = vi.fn().mockImplementation(() => ({
    from: (table: unknown) => {
      if (table === schema.familyMembers) {
        return {
          innerJoin: () => ({
            where: () => ({
              limit: async () =>
                args.recipient ? [{ userId: args.recipient.userId, email: args.recipient.email }] : [],
            }),
          }),
        };
      }
      if (table === schema.children) {
        return { where: async () => args.children };
      }
      if (table === schema.emailOptOuts) {
        return { where: () => ({ limit: async () => (args.optedOut ? [{ id: 'opt-1' }] : []) }) };
      }
      // village candidates: from().where().orderBy().limit()
      return { where: () => ({ orderBy: () => ({ limit: async () => [] }) }) };
    },
  }));

  const insert = vi.fn().mockImplementation((table: unknown) => {
    if (table === schema.dailyDigests) {
      return {
        values: (row: unknown) => ({
          onConflictDoUpdate: async () => {
            args.capture.dailyDigests.push(row);
          },
        }),
      };
    }
    if (table === schema.agentRuns) {
      return {
        values: (row: Record<string, unknown>) => ({
          returning: async () => {
            args.capture.agentRuns.push(row);
            return [{ id: 'run-1' }];
          },
        }),
      };
    }
    if (table === schema.auditLog) {
      return {
        values: async (row: unknown) => {
          args.capture.auditLog.push(row);
        },
      };
    }
    if (table === schema.emailSends) {
      return {
        values: async (row: unknown) => {
          args.capture.emailSends.push(row);
        },
      };
    }
    throw new Error('unexpected insert target');
  });

  return { select, insert } as never;
}

/**
 * A fake Anthropic client that drives the harness loop: first response calls both
 * brief tools, second response is the final prose. This exercises the loop
 * MECHANICS (a tool call fed back, a final answer) — not LLM quality, which is an
 * eval against cached Claude (rule #8).
 */
function fakeClient(): AgentClient {
  let turn = 0;
  const create = vi.fn().mockImplementation(async () => {
    turn += 1;
    if (turn === 1) {
      return {
        content: [
          { type: 'tool_use', id: 't1', name: 'get_companion_brief', input: {} },
          { type: 'tool_use', id: 't2', name: 'get_week_village', input: {} },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    }
    return {
      content: [{ type: 'text', text: 'good morning — a calm day ahead for your family.' }],
      usage: { input_tokens: 8, output_tokens: 12 },
    };
  });
  return { messages: { create } } as unknown as AgentClient;
}

function fakeEmail(): {
  sender: DigestEmailSender;
  sent: Array<{ to: string; subject: string; body: string; unsubscribeUrl: string }>;
} {
  const sent: Array<{ to: string; subject: string; body: string; unsubscribeUrl: string }> = [];
  return {
    sent,
    sender: {
      async sendDigest(to, subject, body, unsubscribeUrl) {
        sent.push({ to, subject, body, unsubscribeUrl });
        return { accepted: true, providerMessageId: 'resend-msg-1' };
      },
    },
  };
}

describe('runDigestForFamily', () => {
  // Sending is gated behind the flag + a configured unsubscribe secret; the
  // happy-path tests turn both on. The gate tests below leave the flag off / opt
  // the recipient out to prove the send is suppressed.
  beforeEach(() => {
    vi.stubEnv('DIGEST_SEND_ENABLED', 'true');
    vi.stubEnv('UNSUBSCRIBE_SECRET', 'test-unsub-secret');
    vi.stubEnv('APP_URL', 'https://app.example.com');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('composes the brief on the harness, stores it in daily_digests, audits each tool, emails it, and records the send', async () => {
    const capture: Capture = { auditLog: [], dailyDigests: [], agentRuns: [], emailSends: [] };
    const db = fakeDb({
      recipient: { userId: USER_ID, email: 'parent@example.com' },
      children: [{ id: 'c1', name: 'Maya', dateOfBirth: TODDLER_DOB }],
      capture,
    });
    const email = fakeEmail();

    const result = await runDigestForFamily(
      FAMILY_ID,
      db,
      { client: fakeClient(), email: email.sender },
      NOW,
    );

    expect(result).toEqual({ status: 'sent', emailed: true });

    // The composed brief is stored in daily_digests for the Toronto-local day.
    expect(capture.dailyDigests).toHaveLength(1);
    const digestRow = capture.dailyDigests[0] as {
      familyId: string;
      digestDate: string;
      perChildBreakdown: { briefText: string };
    };
    expect(digestRow.familyId).toBe(FAMILY_ID);
    expect(digestRow.digestDate).toBe('2026-06-17');
    expect(digestRow.perChildBreakdown.briefText).toContain('good morning');

    // The same brief is emailed to the family's primary parent, with a CASL
    // unsubscribe URL bound to that user + stream.
    expect(email.sent).toHaveLength(1);
    const sent = email.sent[0];
    expect(sent?.to).toBe('parent@example.com');
    expect(sent?.subject).toBe('your hale daily brief');
    expect(sent?.body).toBe(digestRow.perChildBreakdown.briefText);
    const unsub = new URL(sent?.unsubscribeUrl as string);
    expect(unsub.pathname).toBe('/unsubscribe');
    expect(unsub.searchParams.get('u')).toBe(USER_ID);
    expect(unsub.searchParams.get('t')).toBe('daily_digest');

    // The accepted send is recorded in the email_sends ledger (CASL: who + when).
    expect(capture.emailSends).toHaveLength(1);
    expect(capture.emailSends[0]).toMatchObject({
      userId: USER_ID,
      familyId: FAMILY_ID,
      emailType: 'daily_digest',
      recipient: 'parent@example.com',
      providerMessageId: 'resend-msg-1',
    });

    // Rule #6: every tool call wrote an immutable audit row, actor 'system'.
    expect(capture.auditLog).toHaveLength(2);
    for (const row of capture.auditLog as Array<{ familyId: string; actor: string; actionTaken: string }>) {
      expect(row.familyId).toBe(FAMILY_ID);
      expect(row.actor).toBe('system');
      expect(row.actionTaken).toMatch(/^tool:(get_companion_brief|get_week_village)$/);
    }

    // Exactly one agent_runs row, family-scoped, with the real model + token
    // counts (summed across the two round-trips) + latency, marked completed.
    expect(capture.agentRuns).toHaveLength(1);
    const run = capture.agentRuns[0] as Record<string, unknown>;
    expect(run.familyId).toBe(FAMILY_ID);
    expect(run.agentName).toBe('daily-brief');
    expect(run.modelUsed).toBe('claude-sonnet-4-6');
    expect(run.promptTokens).toBe(18);
    expect(run.completionTokens).toBe(17);
    expect(typeof run.latencyMs).toBe('number');
    expect(run.status).toBe('completed');
  });

  it('records a FAILED agent_runs row and rethrows when the harness call throws (rule #8)', async () => {
    const capture: Capture = { auditLog: [], dailyDigests: [], agentRuns: [], emailSends: [] };
    const db = fakeDb({
      recipient: { userId: USER_ID, email: 'parent@example.com' },
      children: [{ id: 'c1', name: 'Maya', dateOfBirth: TODDLER_DOB }],
      capture,
    });
    const boom = {
      messages: {
        create: vi.fn(async () => {
          throw new Error('anthropic 529 overloaded');
        }),
      },
    } as unknown as AgentClient;

    await expect(
      runDigestForFamily(FAMILY_ID, db, { client: boom, email: fakeEmail().sender }, NOW),
    ).rejects.toThrow('anthropic 529 overloaded');

    // The failure was recorded — one row, family-scoped, status 'failed'.
    expect(capture.agentRuns).toHaveLength(1);
    const run = capture.agentRuns[0] as Record<string, unknown>;
    expect(run.familyId).toBe(FAMILY_ID);
    expect(run.agentName).toBe('daily-brief');
    expect(run.status).toBe('failed');
    // No digest was stored on the failure path.
    expect(capture.dailyDigests).toEqual([]);
  });

  it('returns no_recipient and does NOT run the agent when the family has no primary parent', async () => {
    const capture: Capture = { auditLog: [], dailyDigests: [], agentRuns: [], emailSends: [] };
    const db = fakeDb({ recipient: null, children: [], capture });
    const email = fakeEmail();
    const client = fakeClient();

    const result = await runDigestForFamily(FAMILY_ID, db, { client, email: email.sender }, NOW);

    expect(result).toEqual({ status: 'no_recipient' });
    expect(capture.dailyDigests).toEqual([]);
    expect(email.sent).toEqual([]);
  });

  it('stores the brief but SKIPS the send when DIGEST_SEND_ENABLED is not "true" (off by default)', async () => {
    vi.stubEnv('DIGEST_SEND_ENABLED', '');
    const capture: Capture = { auditLog: [], dailyDigests: [], agentRuns: [], emailSends: [] };
    const db = fakeDb({
      recipient: { userId: USER_ID, email: 'parent@example.com' },
      children: [{ id: 'c1', name: 'Maya', dateOfBirth: TODDLER_DOB }],
      capture,
    });
    const email = fakeEmail();

    const result = await runDigestForFamily(
      FAMILY_ID,
      db,
      { client: fakeClient(), email: email.sender },
      NOW,
    );

    expect(result).toEqual({ status: 'send_skipped', reason: 'flag_off' });
    // The brief is still composed + stored — only the outbound send is gated.
    expect(capture.dailyDigests).toHaveLength(1);
    expect(email.sent).toEqual([]);
    expect(capture.emailSends).toEqual([]);
  });

  it('stores the brief but SKIPS the send when the recipient has opted out (CASL consent)', async () => {
    const capture: Capture = { auditLog: [], dailyDigests: [], agentRuns: [], emailSends: [] };
    const db = fakeDb({
      recipient: { userId: USER_ID, email: 'parent@example.com' },
      children: [{ id: 'c1', name: 'Maya', dateOfBirth: TODDLER_DOB }],
      optedOut: true,
      capture,
    });
    const email = fakeEmail();

    const result = await runDigestForFamily(
      FAMILY_ID,
      db,
      { client: fakeClient(), email: email.sender },
      NOW,
    );

    expect(result).toEqual({ status: 'send_skipped', reason: 'opted_out' });
    expect(capture.dailyDigests).toHaveLength(1);
    expect(email.sent).toEqual([]);
    expect(capture.emailSends).toEqual([]);
  });
});
