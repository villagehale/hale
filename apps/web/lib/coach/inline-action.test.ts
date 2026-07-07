import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { approveDraftedAction, type ApproveQueue } from '~/lib/actions/approve';
import { draftInlineAction } from './inline-action';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
// approveDraftedAction validates the enqueued payload's action_id as a UUID, so the
// approve-path DB row must carry a real UUID — and so must the drafted action id the
// reviewer's idempotency check validates, so the fake actions insert returns this UUID.
const ACTION_UUID = '33333333-3333-4333-8333-333333333333';
const TEEN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TODDLER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-06-17T12:00:00Z');

// DOBs derived from the spec stage boundaries: teenager ≥ 156 completed months
// (13y), toddler in [12,48) months. Both chosen against NOW, not the code's output.
const TEEN_DOB = '2010-01-01'; // 16y at NOW → teenager
const TODDLER_DOB = '2024-06-17'; // 24mo at NOW → toddler

interface Capture {
  events: Record<string, unknown>[];
  actions: Record<string, unknown>[];
  audit: Record<string, unknown>[];
  agentRuns: Record<string, unknown>[];
  actionUpdates: Record<string, unknown>[];
  eventUpdates: Record<string, unknown>[];
}

function freshCapture(): Capture {
  return { events: [], actions: [], audit: [], agentRuns: [], actionUpdates: [], eventUpdates: [] };
}

/**
 * Fakes the Drizzle chains draftInlineAction + the inline reviewAction/recordVerdict
 * touch:
 *   select(children).where() → child rows (DOB lookup for teen flag; also the
 *     reviewer's child-name lookup, keyed by projection)
 *   select(actions).where().limit() → [] (reviewer idempotency check: no dupe → ok)
 *   insert(events|actions).values().onConflictDoNothing().returning() → [{id}]
 *   insert(agent_runs).values()[.returning()] → captures the reviewer run
 *   insert(auditLog).values() → void
 *   update(actions|events).set().where() → captures the persisted verdict
 * Routed by table identity. No real DB.
 */
function fakeDb(capture: Capture, children: { id: string; dateOfBirth: string }[] = []) {
  const insert = vi.fn().mockImplementation((table: unknown) => {
    if (table === schema.events) {
      return {
        values: (row: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              capture.events.push(row);
              return [{ id: 'event-1' }];
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
              return [{ id: ACTION_UUID }];
            },
          }),
        }),
      };
    }
    if (table === schema.agentRuns) {
      return {
        values: (row: Record<string, unknown>) => {
          capture.agentRuns.push(row);
          return { returning: async () => [{ id: `run-${capture.agentRuns.length}` }] };
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

  // Child DOB lookup (isTeenChild) resolves at .where(); the reviewer's
  // check_action_idempotency actions lookup terminates at .where().limit() and must
  // resolve to [] (no recent duplicate → ok:true); the reviewer's child-name lookup
  // (projection {name}) resolves to [].
  const select = vi.fn().mockImplementation((proj: Record<string, unknown>) => {
    const keys = Object.keys(proj ?? {});
    const rows = (): unknown[] => {
      if (keys.includes('dateOfBirth')) return children.map((c) => ({ dateOfBirth: c.dateOfBirth }));
      return []; // actions idempotency (no dupe), reviewer child names, etc.
    };
    return {
      from: () => ({
        where: () =>
          Object.assign(Promise.resolve(rows()), { limit: () => Promise.resolve(rows()) }),
      }),
    };
  });

  return { insert, update, select } as never;
}

const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null };

/**
 * Scripts the reviewer's SDK transport (rule #8: this is the loop mechanics, not an
 * LLM-quality mock — reviewAction's real coverage gate runs against the real tool
 * RESULTS). `turns` are the assistant turns the reviewer loop emits: a checks turn
 * then a submit_verdict turn.
 */
function scriptedReviewer(turns: Array<{ content: unknown[] }>): AgentClient {
  let call = 0;
  const create = vi.fn().mockImplementation(async () => {
    const turn = turns[call] ?? { content: [{ type: 'text', text: 'done' }] };
    call += 1;
    return { content: turn.content, usage };
  });
  return { messages: { create } } as unknown as AgentClient;
}

const IDEMPOTENCY_CHECK = {
  content: [
    { type: 'tool_use', id: 't1', name: 'check_action_idempotency', input: { actionHash: 'abc' } },
  ],
};
const SUBMIT = (verdict: string, rationale = 'ok') => ({
  content: [{ type: 'tool_use', id: 'v1', name: 'submit_verdict', input: { verdict, rationale } }],
});

/** A reviewer that invokes the required idempotency check, then approves. For
 * add_to_routine (REQUIRED_CHECKS = [check_action_idempotency]) with no recent
 * duplicate (ok:true), the coverage gate is satisfied so the verdict stays approve. */
function approvingReviewer(): AgentClient {
  return scriptedReviewer([IDEMPOTENCY_CHECK, SUBMIT('approve', 'no recent duplicate')]);
}

function fakeQueue(): ApproveQueue & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue('job-1') };
}

/** Fakes the single select().from().where().limit(1) approveDraftedAction runs. */
function approveDb(row: {
  id: string;
  familyId: string;
  userVisibleState: string;
  reviewerVerdict: string | null;
}) {
  const limit = vi.fn().mockResolvedValue([row]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as never;
}

describe('draftInlineAction', () => {
  it('creates an action_draft (NOT an execution) held for approval, with an audit row (rules #4, #6)', async () => {
    const capture = freshCapture();
    const db = fakeDb(capture);

    const result = await draftInlineAction(
      {
        familyId: FAMILY_ID,
        actor: ACTOR,
        intentKind: 'find_activities',
        childId: null,
        sourceAnswer: 'want me to find activities near you?',
      },
      db,
      approvingReviewer(),
      NOW,
    );

    expect(result.actionId).toBe(ACTION_UUID);

    // Rule #4: the action is held at drafted_for_approval — never executed inline.
    expect(capture.actions).toHaveLength(1);
    const action = capture.actions[0] as Record<string, unknown>;
    expect(action.familyId).toBe(FAMILY_ID);
    expect(action.actionType).toBe('add_to_digest_only');
    expect(action.userVisibleState).toBe('drafted_for_approval');
    expect(action.executedAt).toBeUndefined();

    // The synthetic event records WHO asked (the acting parent) and stays scoped.
    expect(capture.events).toHaveLength(1);
    const event = capture.events[0] as Record<string, unknown>;
    expect(event.familyId).toBe(FAMILY_ID);
    expect(event.source).toBe('ask_hale');

    // Rule #6: the draft audit row, attributed to the acting parent.
    const draftAudit = capture.audit.find((a) => a.actionTaken === 'ask_hale.action_drafted');
    expect(draftAudit).toBeDefined();
    expect(draftAudit?.familyId).toBe(FAMILY_ID);
    expect(draftAudit?.actor).toBe(ACTOR);
    expect(draftAudit?.targetId).toBe(ACTION_UUID);
  });

  it('rejects an unknown intent kind rather than drafting an arbitrary action type', async () => {
    const capture = freshCapture();
    const db = fakeDb(capture);

    await expect(
      draftInlineAction(
        { familyId: FAMILY_ID, actor: ACTOR, intentKind: 'wire_money', childId: null, sourceAnswer: 'x' },
        db,
        approvingReviewer(),
        NOW,
      ),
    ).rejects.toThrow(/unknown intent/i);

    expect(capture.actions).toEqual([]);
    expect(capture.audit).toEqual([]);
  });

  it('flags the synthetic event teen_content when the focused child is 13+ (rule #1)', async () => {
    const capture = freshCapture();
    const db = fakeDb(capture, [{ id: TEEN_ID, dateOfBirth: TEEN_DOB }]);

    await draftInlineAction(
      { familyId: FAMILY_ID, actor: ACTOR, intentKind: 'find_activities', childId: TEEN_ID, sourceAnswer: 'x' },
      db,
      approvingReviewer(),
      NOW,
    );

    expect(capture.events).toHaveLength(1);
    expect((capture.events[0] as Record<string, unknown>).teenContent).toBe(true);
  });

  it('leaves teen_content false for a non-teen focused child', async () => {
    const capture = freshCapture();
    const db = fakeDb(capture, [{ id: TODDLER_ID, dateOfBirth: TODDLER_DOB }]);

    await draftInlineAction(
      { familyId: FAMILY_ID, actor: ACTOR, intentKind: 'find_activities', childId: TODDLER_ID, sourceAnswer: 'x' },
      db,
      approvingReviewer(),
      NOW,
    );

    expect(capture.events).toHaveLength(1);
    expect((capture.events[0] as Record<string, unknown>).teenContent).toBe(false);
  });

  it('leaves teen_content false for a family-wide draft (null child)', async () => {
    const capture = freshCapture();
    const db = fakeDb(capture);

    await draftInlineAction(
      { familyId: FAMILY_ID, actor: ACTOR, intentKind: 'find_activities', childId: null, sourceAnswer: 'x' },
      db,
      approvingReviewer(),
      NOW,
    );

    expect(capture.events).toHaveLength(1);
    expect((capture.events[0] as Record<string, unknown>).teenContent).toBe(false);
  });
});

/**
 * The Slice-0 spine: a chat-drafted action must be reviewer-approvable, closing the
 * gap where draftInlineAction never set reviewerVerdict so approveDraftedAction 409'd.
 *
 * RED (pre-fix): the draft carried NO reviewerVerdict, so approve saw a null/pending
 * verdict and returned 409 action_not_reviewer_approved — structurally un-approvable.
 * GREEN (post-fix): reviewAction runs inline and recordVerdict persists it; when the
 * required coverage (add_to_routine → check_action_idempotency) is satisfiable inline
 * the verdict is 'approved', so approve returns 202.
 */
describe('draftInlineAction → approve spine (Slice 0, add_to_routine)', () => {
  it('persists an approved reviewer verdict so a parent approve returns 202 (rules #3, #6)', async () => {
    const capture = freshCapture();
    const db = fakeDb(capture);

    const { actionId } = await draftInlineAction(
      {
        familyId: FAMILY_ID,
        actor: ACTOR,
        intentKind: 'add_to_plan', // → add_to_routine
        childId: null,
        sourceAnswer: 'want me to add this to your week plan?',
      },
      db,
      approvingReviewer(),
      NOW,
    );

    // The drafted action type is the one under test.
    expect((capture.actions[0] as Record<string, unknown>).actionType).toBe('add_to_routine');

    // GREEN: recordVerdict persisted an APPROVED verdict onto the action (this is the
    // field approveDraftedAction gates on — rule #3). Pre-fix, no verdict update ran.
    const verdictUpdate = capture.actionUpdates.find((u) => 'reviewerVerdict' in u);
    expect(verdictUpdate?.reviewerVerdict).toBe('approved');

    // Rule #6: the reviewer transition is on the immutable audit trail.
    expect(capture.audit.map((a) => a.actionTaken)).toContain('action.reviewed.approve');

    // Now the parent's approve click succeeds against the persisted verdict.
    const queue = fakeQueue();
    const result = await approveDraftedAction(
      approveDb({
        id: ACTION_UUID,
        familyId: FAMILY_ID,
        userVisibleState: 'drafted_for_approval',
        reviewerVerdict: verdictUpdate?.reviewerVerdict as string,
      }),
      queue,
      { actionId, familyId: FAMILY_ID, approvedBy: ACTOR },
    );

    expect(result.status).toBe(202);
    expect(queue.send).toHaveBeenCalledTimes(1);
  });

  it('RED baseline: a draft with NO reviewer verdict (the pre-fix state) is 409 un-approvable', async () => {
    // Proves the gap the fix closes: the SAME approve path, given a draft whose
    // reviewerVerdict was never set (null/pending — draftInlineAction pre-fix), 409s.
    const queue = fakeQueue();
    const result = await approveDraftedAction(
      approveDb({
        id: 'action-1',
        familyId: FAMILY_ID,
        userVisibleState: 'drafted_for_approval',
        reviewerVerdict: null,
      }),
      queue,
      { actionId: 'action-1', familyId: FAMILY_ID, approvedBy: ACTOR },
    );

    expect(result.status).toBe(409);
    if (result.status === 409) expect(result.error).toBe('action_not_reviewer_approved');
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('a reviewer that approves WITHOUT invoking the required check is downgraded to flag_for_human, and approve stays 409 (rule #3)', async () => {
    const capture = freshCapture();
    const db = fakeDb(capture);
    // Model jumps to approve with zero verification tool calls — coverage unsatisfied.
    const client = scriptedReviewer([SUBMIT('approve', 'looks fine to me')]);

    const { actionId } = await draftInlineAction(
      { familyId: FAMILY_ID, actor: ACTOR, intentKind: 'add_to_plan', childId: null, sourceAnswer: 'x' },
      db,
      client,
      NOW,
    );

    // The persisted verdict is the DOWNGRADED one — not 'approved' (rule #3).
    const verdictUpdate = capture.actionUpdates.find((u) => 'reviewerVerdict' in u);
    expect(verdictUpdate?.reviewerVerdict).toBe('flagged');
    expect(capture.audit.map((a) => a.actionTaken)).toContain('action.reviewed.flag_for_human');

    // And approve refuses it — a draft the reviewer did not approve is not executable.
    const queue = fakeQueue();
    const result = await approveDraftedAction(
      approveDb({
        id: actionId,
        familyId: FAMILY_ID,
        userVisibleState: 'drafted_for_approval',
        reviewerVerdict: verdictUpdate?.reviewerVerdict as string,
      }),
      queue,
      { actionId, familyId: FAMILY_ID, approvedBy: ACTOR },
    );
    expect(result.status).toBe(409);
    expect(queue.send).not.toHaveBeenCalled();
  });
});
