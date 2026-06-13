import { describe, expect, it, vi } from 'vitest';
import type { ApprovedAction } from '@hearth/types';
import { mintApprovedAction } from '@hearth/types';
import { runExecutor, type ExecutorDeps } from './executor.js';

/**
 * B9 — outbound idempotency. These tests script the claim table + email
 * provider transports, NOT a live DB. The invariant under test: across a
 * succeeded-send-then-commit-failed plus a pg-boss redelivery, the provider
 * fires EXACTLY ONCE — the second pass's claim insert conflicts and the send
 * is skipped.
 */

const familyId = '11111111-1111-4111-8111-111111111111';
const actionId = '22222222-2222-4222-8222-222222222222';

function approvedEmail(): ApprovedAction {
  return mintApprovedAction(
    {
      id: actionId,
      eventId: '33333333-3333-4333-8333-333333333333',
      familyId,
      actionType: 'send_email',
      payload: { to: 'clinic@example.com', subject: 'hi', body: 'hello' },
      draftConfidence: 0.95,
      rationale: 'ok',
      recipientVisibility: 'public',
      draftedAt: '2026-06-12T10:00:00.000Z',
    },
    {
      kind: 'approve',
      rationale: 'all checks green',
      toolResults: [
        { tool: 'check_pii_leak', ok: true, result: {} },
        { tool: 'check_recipient_allowlist', ok: true, result: {} },
        { tool: 'check_action_idempotency', ok: true, result: {} },
      ],
    },
    () => true,
  );
}

/**
 * A claim store backed by an in-memory Set of action ids. `claim` inserts and
 * returns true; a second claim for the same action id returns false (the unique
 * constraint conflict). Mirrors the outbound_sends claim semantics without SQL.
 */
function makeClaimStore() {
  const claimed = new Set<string>();
  const skips: string[] = [];
  const deps: ExecutorDeps = {
    claimOutboundSend: vi.fn(async (id: string) => {
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    }),
    confirmOutboundSend: vi.fn(async () => {}),
    recordSkippedDuplicate: vi.fn(async (_fam: string, id: string) => {
      skips.push(id);
    }),
    sendEmail: vi.fn(async () => ({ messageId: 'unset' })),
  };
  return { deps, skips };
}

describe('runExecutor — B9 outbound idempotency claim', () => {
  it('sends exactly once across succeeded-then-commit-failed + redelivery', async () => {
    const provider = vi.fn(async () => ({ messageId: 'pm-1', submittedAt: '2026-06-12T10:01:00Z' }));
    const { deps } = makeClaimStore();
    deps.sendEmail = provider;

    // Pass 1: claim succeeds, provider sends. Simulate the worker crashing AFTER
    // the provider call but BEFORE the orchestrator's commit by ignoring the result.
    await runExecutor({ familyId, approved: approvedEmail() }, deps);

    // Pass 2: pg-boss redelivers the same job. The claim insert must conflict.
    const result2 = await runExecutor({ familyId, approved: approvedEmail() }, deps);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(result2.detail.kind).toBe('send_skipped_duplicate');
  });

  it('audits action.send_skipped_duplicate on the redelivery', async () => {
    const provider = vi.fn(async () => ({ messageId: 'pm-1' }));
    const { deps, skips } = makeClaimStore();
    deps.sendEmail = provider;

    await runExecutor({ familyId, approved: approvedEmail() }, deps);
    await runExecutor({ familyId, approved: approvedEmail() }, deps);

    expect(deps.recordSkippedDuplicate).toHaveBeenCalledTimes(1);
    expect(skips).toEqual([actionId]);
  });

  it('writes sent_at via confirmOutboundSend only on the real send', async () => {
    const provider = vi.fn(async () => ({ messageId: 'pm-9' }));
    const { deps } = makeClaimStore();
    deps.sendEmail = provider;

    await runExecutor({ familyId, approved: approvedEmail() }, deps);
    await runExecutor({ familyId, approved: approvedEmail() }, deps);

    expect(deps.confirmOutboundSend).toHaveBeenCalledTimes(1);
    expect(deps.confirmOutboundSend).toHaveBeenCalledWith(actionId, 'pm-9');
  });
});
