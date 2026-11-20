import { type IngestedEventPayload, REQUIRED_CHECKS } from '@hale/tools-contracts';
import type { ActionType, ClassifierSuggestion, FamilyStage } from '@hale/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunMetrics } from '../agents/run-metrics.js';

/**
 * VIL-719 · the three-tier ask policy in the orchestrator. Every autonomy gate is cleared
 * by default (old family, a parent with the streak and the opt-in, single parent, newborn,
 * lane on, turn-on delivered), so the ask policy is the only brake left. These are control-
 * flow tests: the reviewer's verdict is a stored fixture, no model is called or stood in for.
 *
 * What they prove: with ASK_POLICY_TIERS_ENABLED exactly `true`, an ask-first action never
 * reaches the executor without the parent's recorded yes (the `action.approved_by_human`
 * row), on the autonomous pass, on a resume, and at the executor door; a tell-after or just-do
 * kind still needs the full gate chain before it runs on its own; off, nothing changes.
 */

const metrics: AgentRunMetrics = {
  agentName: 'classifier',
  modelUsed: 'claude-haiku-4-5',
  promptTokens: 10,
  completionTokens: 5,
  costUsd: 0.0001,
  latencyMs: 1,
};

let actionType: ActionType = 'send_email';
let teenContent = false;
let commitsParent = false;

const runClassifier = vi.fn(async () => ({
  eventType: 'school_email',
  payload: { foo: 'bar' },
  confidence: { score: 0.97, rationale: 'clear' },
  suggestion: { kind: 'autonomous_action', actionType } as ClassifierSuggestion,
  teenContent,
  dedupHash: 'fixed-hash',
  runMetrics: metrics,
}));
vi.mock('../agents/classifier.js', () => ({ runClassifier: () => runClassifier() }));
vi.mock('../agents/dedup.js', () => ({ dedupHashFor: () => 'fixed-hash' }));

const runDrafter = vi.fn(async () => ({
  draft: {
    id: 'action-1',
    eventId: 'evt-1',
    familyId: 'fam-1',
    actionType,
    payload: {},
    draftConfidence: 0.97,
    rationale: 'draft',
    recipientVisibility: 'public' as const,
    draftedAt: '2026-06-12T10:00:00.000Z',
    commitsParentToEnrollmentBookingOrPayment: commitsParent,
  },
  runMetrics: { ...metrics, agentName: 'drafter' as const },
}));

/** Every required check, ok — so the verdict is never why an action is held. */
function coverage(kind: ActionType) {
  return REQUIRED_CHECKS[kind].map((tool) => ({ tool, ok: true, result: {} }));
}

const runReviewer = vi.fn(async () => ({
  verdict: { kind: 'approve' as const, toolResults: coverage(actionType), rationale: 'green' },
  runMetrics: { ...metrics, agentName: 'reviewer' as const },
}));

const runExecutor = vi.fn(async () => ({ ok: true, detail: {} }));
vi.mock('../agents/drafter.js', () => ({ runDrafter: () => runDrafter() }));
vi.mock('../agents/reviewer.js', () => ({ runReviewer: () => runReviewer() }));
vi.mock('../services/executor.js', () => ({ runExecutor: () => runExecutor() }));

let familyCreatedAt = new Date('2020-01-01T00:00:00.000Z');
let standing: { parentUserId: string; streakReached: boolean; optedIn: boolean }[] = [];
let childStages: FamilyStage[] = ['newborn'];
let resumePoint: { eventId: string; status: string; teenContent: boolean } | null = null;
let checkpointed: { actionId: string; actionType: ActionType; payload: Record<string, unknown> } = {
  actionId: 'action-1',
  actionType: 'send_email',
  payload: {},
};
let approver: string | null = null;

const recordActionGate = vi.fn(async () => {});
const recordExecution = vi.fn(async () => {});
const markEventStage = vi.fn(async () => {});
const loadHumanApprover = vi.fn(async () => approver);

vi.mock('../services/memory-writer.js', () => ({
  loadResumePoint: vi.fn(async () => resumePoint),
  recordEvent: vi.fn(async () => ({ eventId: 'evt-1', duplicate: false })),
  recordAction: vi.fn(async () => ({ actionId: 'action-1', drafterRunId: 'run-1' })),
  recordReviewerVerdict: vi.fn(async () => {}),
  recordReviewerRejection: vi.fn(async () => {}),
  recordActionGate: (...args: unknown[]) => recordActionGate(...(args as [])),
  recordExecution: (...args: unknown[]) => recordExecution(...(args as [])),
  recordDrop: vi.fn(async () => {}),
  markEventStage: (...args: unknown[]) => markEventStage(...(args as [])),
  loadActionForEvent: vi.fn(async () => checkpointed),
  // Read by defaultExecuteApprovedDeps; the human-path cases inject their own.
  loadActionForApproval: vi.fn(async () => null),
  recordHumanApproval: vi.fn(async () => ({ claimed: false, eventStatus: null })),
  loadHumanApprover: () => loadHumanApprover(),
  loadApprovedVerdictForAction: vi.fn(async () => ({
    kind: 'approve' as const,
    toolResults: coverage(checkpointed.actionType),
    rationale: 'green',
  })),
  loadFamilyCreatedAt: vi.fn(async () => familyCreatedAt),
  loadAutonomyStanding: vi.fn(async () => standing),
  autonomyTurnOnDelivered: vi.fn(async () => true),
  loadCrossParentConsent: vi.fn(async () => ({
    hasCoParent: false,
    coParentConsentGranted: false,
  })),
  getMemorySlice: vi.fn(async () => ({ facts: [], episodes: [] })),
  loadFamilyContext: vi.fn(async () => ({
    stages: childStages,
    children: [],
    contextSlice: { childrenAgesMonths: [], province: 'ON', timezone: 'America/Toronto' },
  })),
}));

const { defaultExecuteApprovedDeps, executeApprovedAction, runOrchestrator } = await import(
  './index.js'
);

const job: IngestedEventPayload = {
  family_id: 'fam-1',
  source: 'gmail',
  payload: { messageId: 'm1' },
  received_at: '2026-06-12T10:00:00.000Z',
};

function policyOn(): void {
  vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
}

function policyOff(value = 'false'): void {
  vi.stubEnv('ASK_POLICY_TIERS_ENABLED', value);
}

function gateReasons(): unknown[] {
  return recordActionGate.mock.calls.map((call) => (call as unknown[])[0]);
}

beforeEach(() => {
  vi.stubEnv('AUTONOMOUS_EXECUTE_ENABLED', 'true');
  recordActionGate.mockClear();
  recordExecution.mockClear();
  markEventStage.mockClear();
  runExecutor.mockClear();
  loadHumanApprover.mockClear();
  actionType = 'send_email';
  teenContent = false;
  commitsParent = false;
  familyCreatedAt = new Date('2020-01-01T00:00:00.000Z');
  standing = [{ parentUserId: 'parent-1', streakReached: true, optedIn: true }];
  childStages = ['newborn'];
  resumePoint = null;
  checkpointed = { actionId: 'action-1', actionType: 'send_email', payload: {} };
  approver = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the autonomous pass, policy on', () => {
  it.each(['send_email', 'reply_to_email', 'share_photos_with_family'] as const)(
    '%s, with every autonomy gate cleared, waits for the parent and never runs',
    async (kind) => {
      policyOn();
      actionType = kind;
      await runOrchestrator(job);
      expect(runExecutor).not.toHaveBeenCalled();
      expect(recordExecution).not.toHaveBeenCalled();
      expect(markEventStage).toHaveBeenCalledWith('fam-1', 'evt-1', 'reviewed');
      expect(recordActionGate).toHaveBeenCalledTimes(1);
      expect(recordActionGate).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'action-1',
          actionType: kind,
          reason: 'ask_first',
          detail: expect.objectContaining({
            askTier: 'ask_first',
            classes: expect.arrayContaining(['contact_third_party']),
          }),
        }),
      );
    },
  );

  it('a tell-after kind that has earned autonomy runs on its own and records its tier', async () => {
    policyOn();
    actionType = 'calendar_add';
    await runOrchestrator(job);
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(recordActionGate).not.toHaveBeenCalled();
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: { source: 'autonomous', reason: 'green', askTier: 'tell_after' },
      }),
    );
  });

  it('a just-do kind that has earned autonomy runs and records just_do', async () => {
    policyOn();
    actionType = 'add_to_digest_only';
    await runOrchestrator(job);
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: { source: 'autonomous', reason: 'green', askTier: 'just_do' },
      }),
    );
  });

  it('nothing moves to just do without consent history: inside the 7-day window it is held', async () => {
    policyOn();
    actionType = 'add_to_digest_only';
    familyCreatedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await runOrchestrator(job);
    expect(runExecutor).not.toHaveBeenCalled();
    expect(gateReasons()).toEqual([expect.objectContaining({ reason: 'observation_window' })]);
  });

  it('nothing moves to just do without consent history: without the streak it is held', async () => {
    policyOn();
    actionType = 'add_to_digest_only';
    standing = [{ parentUserId: 'parent-1', streakReached: false, optedIn: false }];
    await runOrchestrator(job);
    expect(runExecutor).not.toHaveBeenCalled();
    expect(gateReasons()).toEqual([expect.objectContaining({ reason: 'streak' })]);
  });

  it('nothing moves to tell after without the opt-in: a calendar kind is held', async () => {
    policyOn();
    actionType = 'calendar_add';
    standing = [{ parentUserId: 'parent-1', streakReached: true, optedIn: false }];
    await runOrchestrator(job);
    expect(runExecutor).not.toHaveBeenCalled();
    expect(gateReasons()).toEqual([expect.objectContaining({ reason: 'autonomy_not_opted_in' })]);
  });

  it("the drafter's commitment reading raises a calendar change to ask first, and says so", async () => {
    policyOn();
    actionType = 'calendar_add';
    commitsParent = true;
    await runOrchestrator(job);
    expect(runExecutor).not.toHaveBeenCalled();
    expect(gateReasons()).toEqual([
      expect.objectContaining({
        reason: 'ask_first',
        detail: {
          askTier: 'ask_first',
          classes: ['family_calendar', 'register_or_book'],
          commitsFamily: true,
        },
      }),
    ]);
  });

  it("a teenager's private content keeps the teen cap's own reason", async () => {
    policyOn();
    teenContent = true;
    childStages = ['teenager'];
    await runOrchestrator(job);
    expect(runExecutor).not.toHaveBeenCalled();
    expect(gateReasons()).toEqual([expect.objectContaining({ reason: 'teen_redaction' })]);
  });

  it('a never-autonomous kind keeps its own reason', async () => {
    policyOn();
    actionType = 'book_clinic_portal';
    await runOrchestrator(job);
    expect(runExecutor).not.toHaveBeenCalled();
    expect(gateReasons()).toEqual([expect.objectContaining({ reason: 'autonomy_denied_kind' })]);
  });
});

describe('the autonomous pass, policy off', () => {
  it('send_email with every gate cleared runs on its own as before, with no tier on the row', async () => {
    policyOff();
    await runOrchestrator(job);
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(recordActionGate).not.toHaveBeenCalled();
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({ decision: { source: 'autonomous', reason: 'green' } }),
    );
  });

  it.each(['true\n', 'TRUE', ' true', '1', ''])('the value %j is not on', async (value) => {
    policyOff(value);
    await runOrchestrator(job);
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(recordActionGate).not.toHaveBeenCalled();
  });
});

describe('a resume from the approved_pending_execute checkpoint', () => {
  beforeEach(() => {
    resumePoint = { eventId: 'evt-1', status: 'approved_pending_execute', teenContent: false };
  });

  it('policy on: an autonomous checkpoint of an ask-first kind goes back to the parent', async () => {
    policyOn();
    await runOrchestrator(job);
    expect(runExecutor).not.toHaveBeenCalled();
    expect(markEventStage).toHaveBeenCalledWith('fam-1', 'evt-1', 'reviewed');
    expect(gateReasons()).toEqual([
      expect.objectContaining({
        reason: 'ask_first',
        detail: expect.objectContaining({ askTier: 'ask_first', resumed: true }),
      }),
    ]);
  });

  it("policy on: a checkpoint the parent's recorded yes claimed runs", async () => {
    policyOn();
    approver = 'parent-1';
    await runOrchestrator(job);
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(recordActionGate).not.toHaveBeenCalled();
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: { source: 'human', reason: 'green', askTier: 'ask_first' },
      }),
    );
  });

  it('policy on: a tell-after checkpoint resumes into the executor', async () => {
    policyOn();
    checkpointed = { actionId: 'action-1', actionType: 'calendar_move', payload: {} };
    await runOrchestrator(job);
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(recordActionGate).not.toHaveBeenCalled();
  });

  it('policy off: an autonomous send_email checkpoint resumes into the executor as before', async () => {
    policyOff();
    await runOrchestrator(job);
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(recordActionGate).not.toHaveBeenCalled();
  });
});

describe('the executor door (executeAndRecord), through the human approval path', () => {
  const VERDICT = {
    kind: 'approve' as const,
    toolResults: coverage('send_email'),
    rationale: 'ok',
  };

  function humanDeps(claim: { claimed: true } | { claimed: false; eventStatus: string }) {
    return {
      ...defaultExecuteApprovedDeps(),
      loadAction: vi.fn(async () => ({
        eventId: 'evt-1',
        actionType: 'send_email' as const,
        payload: { to: 'school@example.com', subject: 'pickup', body: 'hi' },
        userVisibleState: 'drafted_for_approval',
        verdict: VERDICT,
      })),
      loadConsent: vi.fn(async () => ({ hasCoParent: false, coParentConsentGranted: false })),
      recordApproval: vi.fn(async () =>
        claim.claimed
          ? { claimed: true as const, autonomy: { outcome: 'ask_first' as const } }
          : claim,
      ),
      checkWindow: vi.fn(async () => ({ withinWindow: true, detail: {} })),
      log: { info: vi.fn(), warn: vi.fn() },
    } as never;
  }

  const INPUT = {
    actionId: 'action-1',
    familyId: 'fam-1',
    approvedBy: 'parent-1',
    policyVersion: 'test-policy',
  };

  it('policy on: a tap that landed on an autonomous checkpoint recorded no yes, so the door holds it', async () => {
    policyOn();
    approver = null;
    await executeApprovedAction(
      INPUT,
      humanDeps({ claimed: false, eventStatus: 'approved_pending_execute' }),
    );
    expect(runExecutor).not.toHaveBeenCalled();
    expect(recordExecution).not.toHaveBeenCalled();
    expect(markEventStage).toHaveBeenCalledWith('fam-1', 'evt-1', 'reviewed');
    expect(gateReasons()).toEqual([
      expect.objectContaining({
        reason: 'ask_first',
        detail: expect.objectContaining({ askTier: 'ask_first', backstop: true }),
      }),
    ]);
  });

  it("policy on: the parent's recorded yes runs the ask-first action", async () => {
    policyOn();
    approver = 'parent-1';
    await executeApprovedAction(INPUT, humanDeps({ claimed: true }));
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(recordActionGate).not.toHaveBeenCalled();
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: { source: 'human', reason: 'ok', askTier: 'ask_first' },
      }),
    );
  });

  it('policy off: the door does not read the approval row and runs as before', async () => {
    policyOff();
    approver = null;
    await executeApprovedAction(
      INPUT,
      humanDeps({ claimed: false, eventStatus: 'approved_pending_execute' }),
    );
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(loadHumanApprover).not.toHaveBeenCalled();
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({ decision: { source: 'human', reason: 'ok' } }),
    );
  });
});
