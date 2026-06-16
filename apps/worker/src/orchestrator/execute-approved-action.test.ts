import { describe, expect, it, vi } from 'vitest';
import type { ActionType } from '@hale/types';
import { executeApprovedAction, type ExecuteApprovedDeps } from './index.js';

/**
 * Definition-of-done box 3, worker half: human-approve → execute. These are
 * CONTROL-FLOW tests (injected db/executor/queue stubs), not LLM-semantics
 * tests — the only LLM in this path (the reviewer) already ran and its verdict
 * is persisted; nothing here re-invokes a model. RED-before-green: written
 * against the contract before the implementation existed.
 *
 * The boundary under test (hard rule #5): a human's approval overrides the
 * AUTONOMY gates but NOT cross-parent consent.
 */

const FAMILY = '11111111-1111-4111-8111-111111111111';
const ACTION = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const APPROVER = 'parent-a';

const SEND_EMAIL_VERDICT = {
  kind: 'approve' as const,
  rationale: 'all green',
  toolResults: [
    { tool: 'check_pii_leak', ok: true, result: {} },
    { tool: 'check_recipient_allowlist', ok: true, result: {} },
    { tool: 'check_action_idempotency', ok: true, result: {} },
  ],
};

const SHARE_PHOTOS_VERDICT = {
  kind: 'approve' as const,
  rationale: 'all green',
  toolResults: [
    { tool: 'check_pii_leak', ok: true, result: {} },
    { tool: 'check_recipient_allowlist', ok: true, result: {} },
    { tool: 'check_action_idempotency', ok: true, result: {} },
  ],
};

interface LoadedAction {
  eventId: string;
  actionType: ActionType;
  payload: Record<string, unknown>;
  userVisibleState: string;
  verdict: typeof SEND_EMAIL_VERDICT | null;
}

function makeDeps(
  overrides: {
    action?: LoadedAction | null;
    consent?: { hasCoParent: boolean; coParentConsentGranted: boolean };
  } = {},
): ExecuteApprovedDeps & {
  loadAction: ReturnType<typeof vi.fn>;
  recordApproval: ReturnType<typeof vi.fn>;
  recordGate: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
} {
  const action =
    overrides.action === undefined
      ? ({
          eventId: EVENT,
          actionType: 'send_email',
          payload: { to: 'clinic@x.ca', subject: 'hi', body: 'hello' },
          userVisibleState: 'drafted_for_approval',
          verdict: SEND_EMAIL_VERDICT,
        } satisfies LoadedAction)
      : overrides.action;

  return {
    loadAction: vi.fn(async () => action),
    loadConsent: vi.fn(
      async () => overrides.consent ?? { hasCoParent: false, coParentConsentGranted: false },
    ),
    recordApproval: vi.fn(async () => {}),
    recordGate: vi.fn(async () => {}),
    execute: vi.fn(async () => {}),
    log: { info: vi.fn(), warn: vi.fn() },
  } as never;
}

describe('executeApprovedAction', () => {
  it('drives a valid human-approved action into execution and records who approved', async () => {
    const deps = makeDeps();
    await executeApprovedAction({ actionId: ACTION, familyId: FAMILY, approvedBy: APPROVER }, deps);

    expect(deps.execute).toHaveBeenCalledTimes(1);
    const [famArg, evtArg, actionArg, approvedArg] = deps.execute.mock.calls[0] ?? [];
    expect(famArg).toBe(FAMILY);
    expect(evtArg).toBe(EVENT);
    expect(actionArg).toBe(ACTION);
    // The branded ApprovedAction the executor receives carries the stored verdict.
    expect(approvedArg.verdict.kind).toBe('approve');
    expect(approvedArg.actionType).toBe('send_email');

    expect(deps.recordApproval).toHaveBeenCalledTimes(1);
    expect(deps.recordApproval).toHaveBeenCalledWith({
      familyId: FAMILY,
      eventId: EVENT,
      actionId: ACTION,
      approvedBy: APPROVER,
    });
    expect(deps.recordGate).not.toHaveBeenCalled();
  });

  it('drops (no execution) when the action is not in drafted_for_approval', async () => {
    const deps = makeDeps({
      action: {
        eventId: EVENT,
        actionType: 'send_email',
        payload: { to: 'x', subject: 's', body: 'b' },
        userVisibleState: 'autonomous',
        verdict: SEND_EMAIL_VERDICT,
      },
    });
    await executeApprovedAction({ actionId: ACTION, familyId: FAMILY, approvedBy: APPROVER }, deps);

    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.recordApproval).not.toHaveBeenCalled();
  });

  it('drops (no execution) when the action has no stored approve verdict', async () => {
    const deps = makeDeps({
      action: {
        eventId: EVENT,
        actionType: 'send_email',
        payload: { to: 'x', subject: 's', body: 'b' },
        userVisibleState: 'drafted_for_approval',
        verdict: null,
      },
    });
    await executeApprovedAction({ actionId: ACTION, familyId: FAMILY, approvedBy: APPROVER }, deps);

    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.recordApproval).not.toHaveBeenCalled();
  });

  it('drops (no execution) when the action does not exist', async () => {
    const deps = makeDeps({ action: null });
    await executeApprovedAction({ actionId: ACTION, familyId: FAMILY, approvedBy: APPROVER }, deps);

    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.recordApproval).not.toHaveBeenCalled();
  });

  it('REFUSES a cross-parent action when a co-parent exists without consent — one parent cannot waive two-parent consent', async () => {
    const deps = makeDeps({
      action: {
        eventId: EVENT,
        actionType: 'share_photos_with_family',
        payload: { to: 'grandma@x.ca', subject: 's', body: 'b' },
        userVisibleState: 'drafted_for_approval',
        verdict: SHARE_PHOTOS_VERDICT,
      },
      consent: { hasCoParent: true, coParentConsentGranted: false },
    });
    await executeApprovedAction({ actionId: ACTION, familyId: FAMILY, approvedBy: APPROVER }, deps);

    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.recordApproval).not.toHaveBeenCalled();
    expect(deps.recordGate).toHaveBeenCalledTimes(1);
    expect(deps.recordGate).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: FAMILY,
        actionId: ACTION,
        actionType: 'share_photos_with_family',
        reason: 'cross_parent_consent',
      }),
    );
  });

  it('executes a cross-parent action when the co-parent has granted consent', async () => {
    const deps = makeDeps({
      action: {
        eventId: EVENT,
        actionType: 'share_photos_with_family',
        payload: { to: 'grandma@x.ca', subject: 's', body: 'b' },
        userVisibleState: 'drafted_for_approval',
        verdict: SHARE_PHOTOS_VERDICT,
      },
      consent: { hasCoParent: true, coParentConsentGranted: true },
    });
    await executeApprovedAction({ actionId: ACTION, familyId: FAMILY, approvedBy: APPROVER }, deps);

    expect(deps.recordGate).not.toHaveBeenCalled();
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });
});
