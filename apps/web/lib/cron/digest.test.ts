import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import type { DigestEmailSender } from './email';
import { runDigestForFamily } from './digest';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-06-17T13:00:00Z'); // 9am Toronto (EDT)

/** A child young enough that companionForChild yields a soon-due health item +
 * an in-window milestone (so get_companion_brief returns a highlight). */
const TODDLER_DOB = '2024-06-01';

interface Capture {
  auditLog: unknown[];
  dailyDigests: unknown[];
  agentRuns: Record<string, unknown>[];
}

/**
 * Fakes the exact Drizzle chains runDigestForFamily + its tools run. Routed by
 * call order for selects and by table identity for inserts. No real DB.
 *
 * Select order:
 *  0. recipientEmail:        from(familyMembers).innerJoin(users).where().limit() → [{email}]
 *  1. get_companion_brief:   from(children).where() → child rows
 *  2. get_week_village #1:   from(children).where() → child rows (teen set)
 *  3. get_week_village #2:   from(villageCandidates).where().orderBy().limit() → []
 *
 * The model in this test calls both tools once each, then answers, so the select
 * order is deterministic.
 */
function fakeDb(args: { email: string | null; children: Array<{ id: string; name: string; dateOfBirth: string }>; capture: Capture }) {
  let selectCall = 0;

  const select = vi.fn().mockImplementation(() => {
    const call = selectCall++;
    if (call === 0) {
      return {
        from: () => ({
          innerJoin: () => ({
            where: () => ({ limit: async () => (args.email ? [{ email: args.email }] : []) }),
          }),
        }),
      };
    }
    if (call === 1 || call === 2) {
      return { from: () => ({ where: async () => args.children }) };
    }
    // village candidates: from().where().orderBy().limit()
    return {
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
      }),
    };
  });

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

function fakeEmail(): { sender: DigestEmailSender; sent: Array<{ to: string; subject: string; body: string }> } {
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  return {
    sent,
    sender: {
      async sendDigest(to, subject, body) {
        sent.push({ to, subject, body });
        return true;
      },
    },
  };
}

describe('runDigestForFamily', () => {
  it('composes the brief on the harness, stores it in daily_digests, audits each tool, and emails it', async () => {
    const capture: Capture = { auditLog: [], dailyDigests: [], agentRuns: [] };
    const db = fakeDb({
      email: 'parent@example.com',
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

    // The same brief is emailed from the family's primary parent address.
    expect(email.sent).toEqual([
      { to: 'parent@example.com', subject: 'your hale daily brief', body: digestRow.perChildBreakdown.briefText },
    ]);

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
    const capture: Capture = { auditLog: [], dailyDigests: [], agentRuns: [] };
    const db = fakeDb({
      email: 'parent@example.com',
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
    const capture: Capture = { auditLog: [], dailyDigests: [], agentRuns: [] };
    const db = fakeDb({ email: null, children: [], capture });
    const email = fakeEmail();
    const client = fakeClient();

    const result = await runDigestForFamily(FAMILY_ID, db, { client, email: email.sender }, NOW);

    expect(result).toEqual({ status: 'no_recipient' });
    expect(capture.dailyDigests).toEqual([]);
    expect(email.sent).toEqual([]);
  });
});
