import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { ingestEvent } from './ingest';

/**
 * End-to-end control-flow test of the inbound pipeline on a FAKE Anthropic client
 * + a FAKE db. The fake client scripts the SDK transport (a forced classify tool,
 * a forced draft tool, then the reviewer's tool-use loop) — it is NOT an LLM
 * quality mock (rule #8: quality is an eval against cached Claude, B12). It
 * exercises the spine: classify → draft → review → drafted_for_approval, and the
 * rule-#3 reviewer-coverage / rule-#4 no-execution / rule-#6 audit guarantees.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-06-21T12:00:00Z');

interface Capture {
  events: Record<string, unknown>[];
  actions: Record<string, unknown>[];
  agentRuns: Record<string, unknown>[];
  audit: Record<string, unknown>[];
  actionUpdates: Record<string, unknown>[];
  eventUpdates: Record<string, unknown>[];
}

/**
 * Fake db. Inserts route by table identity (events/actions/agent_runs/audit_log).
 * Selects answer the chains the pipeline + reviewer tools issue:
 *   - families.createdAt (observe-window check)
 *   - children (child-attribution resolve + reviewer pii names)
 *   - actions (idempotency) → none
 *   - family_memory_facts (recipient/sender/override allowlists) → on/off via flag
 * `familyCreatedAt` controls the L1 observe window; `allowlisted` makes the
 * recipient/sender facts present so the reviewer can approve.
 */
function fakeDb(capture: Capture, opts: { familyCreatedAt: Date; allowlisted: boolean }) {
  // recordEvent inserts the event (onConflictDoNothing().returning()) then a
  // classifier agent_run (.values().returning()); recordDraft inserts a drafter
  // agent_run + the action; recordVerdict inserts a reviewer agent_run; writeAudit
  // inserts audit rows. Routes by table identity.
  const insert = vi.fn().mockImplementation((table: unknown) => {
    if (table === schema.events) {
      return {
        values: (row: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              capture.events.push(row);
              return [{ id: `event-${capture.events.length}` }];
            },
          }),
        }),
      };
    }
    if (table === schema.actions) {
      return {
        values: (row: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              capture.actions.push(row);
              return [{ id: `action-${capture.actions.length}` }];
            },
          }),
        }),
      };
    }
    if (table === schema.agentRuns) {
      // recordEvent/recordVerdict await .values() directly (awaiting a plain
      // object just yields the object — harmless); recordDraft chains
      // .values().returning() for the run id. Capture happens at .values() time.
      return {
        values: (row: Record<string, unknown>) => {
          capture.agentRuns.push(row);
          const id = `run-${capture.agentRuns.length}`;
          return { returning: async () => [{ id }] };
        },
      };
    }
    if (table === schema.auditLog) {
      return { values: async (row: Record<string, unknown>) => void capture.audit.push(row) };
    }
    throw new Error('unexpected insert target');
  });

  const update = vi.fn().mockImplementation((table: unknown) => ({
    set: (vals: Record<string, unknown>) => ({
      where: async () => {
        if (table === schema.actions) capture.actionUpdates.push(vals);
        if (table === schema.events) capture.eventUpdates.push(vals);
      },
    }),
  }));

  // select() returns a builder that resolves to [] for most chains; the family
  // createdAt chain resolves to the configured date; allowlist facts resolve to a
  // present row when `allowlisted`.
  const select = vi.fn().mockImplementation((proj: Record<string, unknown>) => {
    const keys = Object.keys(proj ?? {});
    const rows = (): unknown[] => {
      if (keys.includes('createdAt')) return [{ createdAt: opts.familyCreatedAt }];
      if (keys.includes('name')) return []; // children names for pii → none
      if (keys.includes('value') || keys.includes('validFrom')) {
        // family_memory_facts allowlist/override lookups
        return opts.allowlisted ? [{ value: 'known', validFrom: NOW }] : [];
      }
      return []; // children resolve, actions idempotency, etc.
    };
    // A node that is BOTH awaitable (a Promise of the rows) and chainable to
    // .limit()/.orderBy() — Drizzle terminates a query at different points
    // (.where(), .where().limit(), .where().orderBy().limit()). Extra methods are
    // attached to a real Promise so awaiting it resolves the rows.
    const node = (): Promise<unknown[]> => {
      const r = rows();
      return Object.assign(Promise.resolve(r), {
        limit: () => Promise.resolve(r),
        orderBy: () => node(),
      });
    };
    return { from: () => ({ where: () => node(), limit: () => Promise.resolve(rows()) }) };
  });

  return { insert, update, select } as never;
}

const FORCED_CLASSIFY = {
  type: 'tool_use',
  id: 'c1',
  name: 'classification',
  input: {
    event_type: 'pediatric_appointment_request',
    confidence: 0.95,
    rationale: 'clinic asks parent to confirm a time',
    payload: { from: 'clinic@example.com', ask: 'please confirm thursday 10am' },
    suggested_action: { kind: 'autonomous_action', actionType: 'reply_to_email' },
    teen_content: false,
    concerns_child_id: null,
  },
};

const FORCED_DRAFT = {
  type: 'tool_use',
  id: 'd1',
  name: 'draft_action',
  input: {
    payload: { to: 'clinic@example.com', subject: 'confirming', body: 'thursday 10 works, thanks' },
    confidence: 0.9,
    rationale: 'confirms the proposed slot in the parent voice',
    recipient_visibility: 'public',
  },
};

/** reply_to_email requires pii + recipient + sender + idempotency. */
const REVIEWER_CHECKS = [
  {
    type: 'tool_use',
    id: 't1',
    name: 'check_pii_leak',
    input: { content: 'thursday 10 works', allowedRecipients: ['clinic@example.com'] },
  },
  {
    type: 'tool_use',
    id: 't2',
    name: 'check_recipient_allowlist',
    input: { recipient: 'clinic@example.com', recipientCategory: 'general' },
  },
  {
    type: 'tool_use',
    id: 't3',
    name: 'check_sender_allowlist',
    input: { sender: 'clinic@example.com' },
  },
  {
    type: 'tool_use',
    id: 't4',
    name: 'check_action_idempotency',
    input: { actionHash: 'abc' },
  },
];

const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null };

/**
 * Scripts the shared client across all three stages. `reviewerScript` is the list
 * of assistant turns the reviewer loop should emit (after classify + draft).
 */
function scriptedClient(reviewerScript: Array<{ content: unknown[] }>): AgentClient {
  let call = 0;
  const turns = [
    { content: [FORCED_CLASSIFY], usage },
    { content: [FORCED_DRAFT], usage },
    ...reviewerScript.map((t) => ({ content: t.content, usage })),
  ];
  const create = vi.fn().mockImplementation(async () => {
    const turn = turns[call] ?? { content: [{ type: 'text', text: 'done' }], usage };
    call += 1;
    return turn;
  });
  return { messages: { create } } as unknown as AgentClient;
}

const SUBMIT = (verdict: string, rationale = 'ok') => ({
  content: [{ type: 'tool_use', id: 'v1', name: 'submit_verdict', input: { verdict, rationale } }],
});

const baseInput = {
  familyId: FAMILY_ID,
  source: 'email',
  subject: 'appointment',
  body: 'please confirm thursday 10am',
};

describe('ingestEvent — classify → draft → review → drafted_for_approval', () => {
  it('produces a pending-approval draft and writes audit rows at every stage (rules #4, #6)', async () => {
    const capture: Capture = {
      events: [],
      actions: [],
      agentRuns: [],
      audit: [],
      actionUpdates: [],
      eventUpdates: [],
    };
    const db = fakeDb(capture, { familyCreatedAt: new Date('2026-01-01T00:00:00Z'), allowlisted: true });
    // Reviewer invokes all required checks, then approves.
    const client = scriptedClient([{ content: REVIEWER_CHECKS }, SUBMIT('approve', 'all green')]);

    const outcome = await ingestEvent(baseInput, db, client, NOW);

    // Rule #4: the pipeline NEVER executes — its terminal state is a pending draft.
    expect(outcome.status).toBe('drafted_for_approval');

    // The action was stored at drafted_for_approval (the rule-#4 hold).
    expect(capture.actions).toHaveLength(1);
    expect(capture.actions[0]).toMatchObject({
      familyId: FAMILY_ID,
      actionType: 'reply_to_email',
      userVisibleState: 'drafted_for_approval',
    });

    // Even an approve verdict leaves the action drafted_for_approval — it is NOT
    // promoted to autonomous/executed. No update set userVisibleState away from it.
    for (const upd of capture.actionUpdates) {
      expect(upd.userVisibleState).toBeUndefined();
    }

    // Rule #6: an immutable audit row at each transition.
    const actions = capture.audit.map((a) => a.actionTaken);
    expect(actions).toContain('event.classified');
    expect(actions).toContain('action.drafted');
    expect(actions).toContain('action.reviewed.approve');

    // Three agent_runs (classifier, drafter, reviewer), all family-scoped.
    expect(capture.agentRuns.map((r) => r.agentName).sort()).toEqual([
      'classifier',
      'drafter',
      'reviewer',
    ]);
    for (const run of capture.agentRuns) expect(run.familyId).toBe(FAMILY_ID);
  });

  it('downgrades an approve with NO verification tool calls to flag_for_human (rule #3)', async () => {
    const capture: Capture = {
      events: [],
      actions: [],
      agentRuns: [],
      audit: [],
      actionUpdates: [],
      eventUpdates: [],
    };
    const db = fakeDb(capture, { familyCreatedAt: new Date('2026-01-01T00:00:00Z'), allowlisted: true });
    // Model jumps straight to approve WITHOUT invoking any check.
    const client = scriptedClient([SUBMIT('approve', 'looks fine to me')]);

    const outcome = await ingestEvent(baseInput, db, client, NOW);

    expect(outcome.status).toBe('drafted_for_approval');
    if (outcome.status === 'drafted_for_approval') {
      // The reviewer could NOT approve on prose alone — coverage gate downgraded it.
      expect(outcome.verdict).toBe('flag_for_human');
    }
    // The persisted verdict is the downgraded one, not 'approved'.
    const verdictUpdate = capture.actionUpdates.find((u) => 'reviewerVerdict' in u);
    expect(verdictUpdate?.reviewerVerdict).toBe('flagged');
    expect(capture.audit.map((a) => a.actionTaken)).toContain('action.reviewed.flag_for_human');
  });

  it('does NOT execute and records the observe-window gate for an L1 family (< 7 days old)', async () => {
    const capture: Capture = {
      events: [],
      actions: [],
      agentRuns: [],
      audit: [],
      actionUpdates: [],
      eventUpdates: [],
    };
    // Family created 2 days ago → inside the 7-day L1 observe window.
    const twoDaysAgo = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    const db = fakeDb(capture, { familyCreatedAt: twoDaysAgo, allowlisted: true });
    const client = scriptedClient([{ content: REVIEWER_CHECKS }, SUBMIT('approve', 'all green')]);

    const outcome = await ingestEvent(baseInput, db, client, NOW);

    // Still only a draft — never executed (rule #4). And the observe-window gate is
    // on the audit trail so the reason autonomy stayed dark is observable.
    expect(outcome.status).toBe('drafted_for_approval');
    expect(capture.audit.map((a) => a.actionTaken)).toContain('action.gated.observation_window');
    // The action is never advanced past drafted_for_approval.
    for (const upd of capture.actionUpdates) {
      expect(upd.userVisibleState).toBeUndefined();
    }
  });

  it('surfaces a one-way notice as an event without drafting (no action, no draft run)', async () => {
    const capture: Capture = {
      events: [],
      actions: [],
      agentRuns: [],
      audit: [],
      actionUpdates: [],
      eventUpdates: [],
    };
    const db = fakeDb(capture, { familyCreatedAt: new Date('2026-01-01T00:00:00Z'), allowlisted: true });
    // A classifier turn that routes surface_only — overrides the default forced classify.
    let call = 0;
    const create = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return {
          content: [
            {
              type: 'tool_use',
              id: 'c1',
              name: 'classification',
              input: {
                event_type: 'delivery_update',
                confidence: 0.95,
                rationale: 'one-way delivery notice',
                payload: {},
                suggested_action: { kind: 'surface_only' },
                teen_content: false,
                concerns_child_id: null,
              },
            },
          ],
          usage,
        };
      }
      return { content: [{ type: 'text', text: 'done' }], usage };
    });
    const client = { messages: { create } } as unknown as AgentClient;

    const outcome = await ingestEvent(baseInput, db, client, NOW);

    expect(outcome.status).toBe('surfaced_only');
    expect(capture.actions).toHaveLength(0);
    expect(capture.agentRuns.map((r) => r.agentName)).toEqual(['classifier']);
  });
});

describe('ingestEvent — hard monthly LLM-cost ceiling short-circuits before any billable stage', () => {
  const freshCapture = (): Capture => ({
    events: [],
    actions: [],
    agentRuns: [],
    audit: [],
    actionUpdates: [],
    eventUpdates: [],
  });

  it('over the ceiling → NO LLM call, drops with reason spend_ceiling, writes the family-scoped audit', async () => {
    const capture = freshCapture();
    const db = fakeDb(capture, { familyCreatedAt: new Date('2026-01-01T00:00:00Z'), allowlisted: true });
    const create = vi.fn();
    const client = { messages: { create } } as unknown as AgentClient;
    // free, 1 child → $2 allowance → $6 hard ceiling. $20 is well over.
    const readCeiling = vi.fn(async () => ({ spentUsd: 20.0, planTier: 'free' as const, childCount: 1 }));

    const outcome = await ingestEvent(baseInput, db, client, NOW, readCeiling);

    // The whole point: the model is NEVER reached.
    expect(create).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: 'dropped', eventId: null, reason: 'spend_ceiling' });
    // No event / action / agent_run was created — pure short-circuit.
    expect(capture.events).toHaveLength(0);
    expect(capture.actions).toHaveLength(0);
    expect(capture.agentRuns).toHaveLength(0);
    // Rule #6: the drop is on the immutable audit trail, family-scoped, with the numbers.
    const ceilingAudit = capture.audit.find((a) => a.actionTaken === 'event.dropped.spend_ceiling');
    expect(ceilingAudit).toMatchObject({
      familyId: FAMILY_ID,
      targetTable: 'families',
      targetId: FAMILY_ID,
      after: { planTier: 'free', childCount: 1, monthToDateCostUsd: 20.0, ceilingUsd: 6.0 },
    });
  });

  it('under the ceiling → pipeline proceeds exactly as before (classifier runs, draft produced)', async () => {
    const capture = freshCapture();
    const db = fakeDb(capture, { familyCreatedAt: new Date('2026-01-01T00:00:00Z'), allowlisted: true });
    const client = scriptedClient([{ content: REVIEWER_CHECKS }, SUBMIT('approve', 'all green')]);
    // free, 1 child → $6 ceiling. $4 is over the soft $2 allowance but under the hard ceiling.
    const readCeiling = vi.fn(async () => ({ spentUsd: 4.0, planTier: 'free' as const, childCount: 1 }));

    const outcome = await ingestEvent(baseInput, db, client, NOW, readCeiling);

    expect(outcome.status).toBe('drafted_for_approval');
    expect(capture.agentRuns.map((r) => r.agentName).sort()).toEqual([
      'classifier',
      'drafter',
      'reviewer',
    ]);
    expect(capture.audit.map((a) => a.actionTaken)).not.toContain('event.dropped.spend_ceiling');
  });
});
