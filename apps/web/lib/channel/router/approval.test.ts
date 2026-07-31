import type { Database } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { MAX_LISTED_APPROVALS, matchFastPath } from './fast-path';
import { type ApprovalSpine, type PendingAction, resolveApproval } from './approval';

/**
 * The approval fast-path, resolved against a scripted spine. The spine is faked (it is
 * the DB seam); the RESOLUTION — which action a word names, and when it refuses to
 * name one — is the thing under test, because that is what decides whether a real
 * calendar write happens.
 */

const FAMILY = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-07-30T12:00:00.000Z');
const DB = {} as Database;

interface SpyCall {
  op: 'approve' | 'decline' | 'undo';
  actionId: string;
  actor: string;
}

function spine(
  options: {
    pending?: PendingAction[];
    undoable?: PendingAction | null;
    refuse?: boolean;
  } = {},
): { spine: ApprovalSpine; calls: SpyCall[] } {
  const calls: SpyCall[] = [];
  const ok = !options.refuse;
  return {
    calls,
    spine: {
      listPending: async () => options.pending ?? [],
      latestUndoable: async () => options.undoable ?? null,
      approve: async (_db, a) => {
        calls.push({ op: 'approve', actionId: a.actionId, actor: a.approvedBy });
        return ok;
      },
      decline: async (_db, a) => {
        calls.push({ op: 'decline', actionId: a.actionId, actor: a.declinedBy });
        return ok;
      },
      undo: async (_db, a) => {
        calls.push({ op: 'undo', actionId: a.actionId, actor: a.revertedBy });
        return ok;
      },
    },
  };
}

const action = (id: string, actionType = 'calendar_add'): PendingAction => ({
  actionId: id,
  actionType,
});

function run(
  body: string,
  options: Parameters<typeof spine>[0] = {},
): Promise<{ outcome: Awaited<ReturnType<typeof resolveApproval>>; calls: SpyCall[] }> {
  const command = matchFastPath(body);
  if (!command) throw new Error(`test bug: ${JSON.stringify(body)} is not a fast-path command`);
  const built = spine(options);
  return resolveApproval(
    DB,
    { familyId: FAMILY, parentUserId: PARENT, command, now: NOW },
    built.spine,
  ).then((outcome) => ({ outcome, calls: built.calls }));
}

describe('resolveApproval — one pending action', () => {
  it('approves it on a bare yes, stamped with the texting parent', async () => {
    const { outcome, calls } = await run('yes', { pending: [action('a-1')] });

    expect(outcome.status).toBe('approved');
    expect(calls).toEqual([{ op: 'approve', actionId: 'a-1', actor: PARENT }]);
  });

  it('declines it on a bare no', async () => {
    const { outcome, calls } = await run('no', { pending: [action('a-1')] });

    expect(outcome.status).toBe('declined');
    expect(calls).toEqual([{ op: 'decline', actionId: 'a-1', actor: PARENT }]);
  });

  it('names what it did in the reply — a receipt, not an acknowledgement', async () => {
    const { outcome } = await run('yes', { pending: [action('a-1', 'calendar_add')] });

    expect(outcome.reply).toMatch(/add to your calendar/i);
  });

  it('reports honestly when the spine refuses — nothing silently swallowed', async () => {
    const { outcome } = await run('yes', { pending: [action('a-1')], refuse: true });

    expect(outcome.status).toBe('conflict');
    expect(outcome.reply).toMatch(/nothing was changed/i);
  });
});

describe('resolveApproval — nothing pending', () => {
  /**
   * The property that keeps this handler from starving the ones behind it: a bare
   * "yes" with no drafted action is not an approval at all, so the fast-path lets it
   * go rather than claiming every affirmative a parent ever sends.
   */
  it('DECLINES a bare yes so the message falls through to the next handler', async () => {
    const { outcome, calls } = await run('yes', { pending: [] });

    expect(outcome.status).toBe('declined_to_claim');
    expect(calls).toEqual([]);
  });

  it('DECLINES a bare no the same way', async () => {
    const { outcome } = await run('no', { pending: [] });
    expect(outcome.status).toBe('declined_to_claim');
  });

  /** An ordinal cannot be conversation — it can only be an answer to a numbered list —
   * so it is answered rather than passed on. */
  it('claims an ORDINAL and says plainly that nothing is waiting', async () => {
    const { outcome, calls } = await run('yes 2', { pending: [] });

    expect(outcome.status).toBe('nothing_pending');
    expect(outcome.reply).toMatch(/nothing'?s? waiting/i);
    expect(calls).toEqual([]);
  });
});

describe('resolveApproval — more than one pending action', () => {
  const three = [action('a-1', 'calendar_add'), action('a-2', 'calendar_move'), action('a-3', 'book_checkup')];

  /** The safety property: an ambiguous affirmative NEVER executes. */
  it('executes nothing on a bare yes and asks which one', async () => {
    const { outcome, calls } = await run('yes', { pending: three });

    expect(outcome.status).toBe('ambiguous');
    expect(calls).toEqual([]);
  });

  it('numbers the choices in the order an ordinal resolves against', async () => {
    const { outcome } = await run('yes', { pending: three });

    expect(outcome.reply).toContain('1. Add to your calendar');
    expect(outcome.reply).toContain('2. Reschedule on your calendar');
    expect(outcome.reply).toContain('YES 1');
  });

  it('resolves the ordinal to the action at that position', async () => {
    const { calls } = await run('yes 2', { pending: three });
    expect(calls).toEqual([{ op: 'approve', actionId: 'a-2', actor: PARENT }]);
  });

  it('declines the ordinal position on NO 3', async () => {
    const { calls } = await run('no 3', { pending: three });
    expect(calls).toEqual([{ op: 'decline', actionId: 'a-3', actor: PARENT }]);
  });

  it('refuses an ordinal past the end of the list rather than wrapping', async () => {
    const { outcome, calls } = await run('yes 3', { pending: [action('a-1'), action('a-2')] });

    expect(outcome.status).toBe('out_of_range');
    expect(calls).toEqual([]);
  });

  it('never lists more than the grammar can name', async () => {
    const many = Array.from({ length: 8 }, (_, i) => action(`a-${i + 1}`));
    const { outcome } = await run('yes', { pending: many });

    expect(outcome.status).toBe('ambiguous');
    for (let n = 1; n <= MAX_LISTED_APPROVALS; n += 1) {
      expect(outcome.reply).toContain(`${n}.`);
    }
    expect(outcome.reply).not.toContain(`${MAX_LISTED_APPROVALS + 1}.`);
    // The overflow is disclosed, never hidden.
    expect(outcome.reply).toMatch(/more in the app/i);
  });
});

describe('resolveApproval — undo', () => {
  it('reverses the most recent reversible action', async () => {
    const { outcome, calls } = await run('undo', { undoable: action('a-9') });

    expect(outcome.status).toBe('undone');
    expect(calls).toEqual([{ op: 'undo', actionId: 'a-9', actor: PARENT }]);
  });

  /** Undo is unmistakable, so it is always answered — never handed to the agent to
   * paraphrase, and never met with silence. */
  it('claims the message and says so when there is nothing to undo', async () => {
    const { outcome, calls } = await run('undo', { undoable: null });

    expect(outcome.status).toBe('nothing_to_undo');
    expect(outcome.reply).toMatch(/nothing/i);
    expect(calls).toEqual([]);
  });

  it('reports honestly when the reversal is refused', async () => {
    const { outcome } = await run('undo', { undoable: action('a-9'), refuse: true });

    expect(outcome.status).toBe('conflict');
    expect(outcome.reply).toMatch(/nothing was changed/i);
  });

  it('ignores the pending queue entirely — undo names an EXECUTED action', async () => {
    const { calls } = await run('undo', {
      pending: [action('pending-1')],
      undoable: action('executed-1'),
    });

    expect(calls).toEqual([{ op: 'undo', actionId: 'executed-1', actor: PARENT }]);
  });
});
