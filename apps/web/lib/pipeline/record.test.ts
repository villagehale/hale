import { HAIKU_MODEL, SONNET_MODEL } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import type { DraftedAction, ReviewerVerdict } from '@hale/types';
import { describe, expect, it, vi } from 'vitest';
import { recordDraft, recordEvent, recordVerdict } from './record';

/**
 * What the pipeline BILLS. Expected dollars are derived from published Anthropic
 * rates, never copied from what the code emits:
 *   Haiku 4.5 $1 in / $5 out · Sonnet 4.6 $3 in / $15 out
 *   cache read = 0.1x input · cache write (5m) = 1.25x input
 * agent_runs.cost_usd is numeric(12,6), so the captured value is the fixed-point
 * string recordAgentRun writes.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const ACTION_ID = '44444444-4444-4444-8444-444444444444';
const RUN_ID = 'run-0001';

function fakeDb(agentRuns: Record<string, unknown>[]): Database {
  const insert = vi.fn((table: unknown) => {
    if (table === schema.agentRuns) {
      return {
        values: (row: Record<string, unknown>) => {
          agentRuns.push(row);
          return { returning: async () => [{ id: RUN_ID }] };
        },
      };
    }
    if (table === schema.events) {
      return {
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [{ id: EVENT_ID }] }),
        }),
      };
    }
    if (table === schema.actions) {
      return {
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [{ id: ACTION_ID }] }),
        }),
      };
    }
    if (table === schema.auditLog) {
      return { values: async () => undefined };
    }
    throw new Error('unexpected insert target');
  });
  const update = vi.fn(() => ({ set: () => ({ where: async () => undefined }) }));
  return { insert, update } as unknown as Database;
}

const draft: DraftedAction = {
  id: ACTION_ID,
  eventId: EVENT_ID,
  familyId: FAMILY_ID,
  actionType: 'send_email',
  payload: {},
  draftConfidence: 0.9,
  rationale: 'because',
  recipientVisibility: 'internal_only',
  draftedAt: '2026-08-18T12:00:00Z',
};

const verdict: ReviewerVerdict = { kind: 'approve', toolResults: [], rationale: 'ok' };

describe('pipeline cost accounting', () => {
  it('prices the classifier run at the published Haiku rate', async () => {
    // 1M full-rate prompt + 1M output on Haiku 4.5 = $1 + $5 = $6.
    const runs: Record<string, unknown>[] = [];
    await recordEvent(fakeDb(runs), {
      familyId: FAMILY_ID,
      source: 'email',
      eventType: 'appointment',
      payload: {},
      classifierConfidence: 0.9,
      dedupHash: 'hash-1',
      suggestion: { kind: 'autonomous_action', actionType: 'send_email' },
      teenContent: false,
      childId: null,
      usage: {
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      model: HAIKU_MODEL,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.costUsd).toBe('6.000000');
  });

  it('bills the drafter run for its cache tiers instead of dropping them', async () => {
    // Sonnet 4.6, one call split across every tier: 100k fresh input ($0.30),
    // 200k cache writes at 1.25x ($0.75), 700k cache reads at 0.1x ($0.21),
    // 50k output ($0.75) = $2.01. promptTokens is the merged full-rate total
    // (fresh + writes) the agent_runs row records.
    const runs: Record<string, unknown>[] = [];
    await recordDraft(fakeDb(runs), {
      familyId: FAMILY_ID,
      eventId: EVENT_ID,
      draft,
      usage: {
        promptTokens: 300_000,
        completionTokens: 50_000,
        cacheCreationTokens: 200_000,
        cacheReadTokens: 700_000,
      },
      model: SONNET_MODEL,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.costUsd).toBe('2.010000');
  });

  it('records the cost the reviewer loop measured, never a re-derivation', async () => {
    // The reviewer's own metrics already price its tiers: 100k full-rate + 900k
    // cache-read prompt tokens on Sonnet = $0.30 + $0.27 = $0.57. Re-deriving from
    // the collapsed 1M promptTokens the row records would bill $3.00.
    const runs: Record<string, unknown>[] = [];
    await recordVerdict(fakeDb(runs), {
      familyId: FAMILY_ID,
      eventId: EVENT_ID,
      actionId: ACTION_ID,
      actionType: 'send_email',
      verdict,
      usage: { promptTokens: 1_000_000, completionTokens: 0 },
      costUsd: 0.57,
      model: SONNET_MODEL,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.costUsd).toBe('0.570000');
  });
});
