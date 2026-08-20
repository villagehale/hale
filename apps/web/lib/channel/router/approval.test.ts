import type { Database } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { MAX_LISTED_APPROVALS, matchFastPath } from './fast-path';
import {
  type ApprovalSpine,
  type PendingAction,
  type SpineOutcome,
  type SpineRefusal,
  resolveApproval,
} from './approval';

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
    /** Which STATE the spine refuses on, when it refuses at all. */
    refuse?: SpineRefusal;
  } = {},
): { spine: ApprovalSpine; calls: SpyCall[] } {
  const calls: SpyCall[] = [];
  const outcome: SpineOutcome = options.refuse
    ? { ok: false, reason: options.refuse }
    : { ok: true };
  return {
    calls,
    spine: {
      listPending: async () => options.pending ?? [],
      latestUndoable: async () => options.undoable ?? null,
      approve: async (_db, a) => {
        calls.push({ op: 'approve', actionId: a.actionId, actor: a.approvedBy });
        return outcome;
      },
      decline: async (_db, a) => {
        calls.push({ op: 'decline', actionId: a.actionId, actor: a.declinedBy });
        return outcome;
      },
      undo: async (_db, a) => {
        calls.push({ op: 'undo', actionId: a.actionId, actor: a.revertedBy });
        return outcome;
      },
    },
  };
}

const action = (
  id: string,
  actionType = 'calendar_add',
  reviewerApproved = true,
): PendingAction => ({
  actionId: id,
  actionType,
  reviewerApproved,
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

  it('reports honestly when the spine refuses on a state it cannot explain', async () => {
    const { outcome } = await run('yes', { pending: [action('a-1')], refuse: 'unavailable' });

    expect(outcome.status).toBe('conflict');
    expect(outcome.reply).toMatch(/nothing was changed/i);
  });

  /**
   * The four spine refusals are permanent, correct answers about STATE — not breakages.
   * Answering them with the failure template said three false things at once: that Hale
   * broke, that nothing changed (the co-parent's approval DID), and that a retry would
   * work (it fails identically, for 24h in the undo case).
   */
  it('says the row was already answered rather than blaming itself', async () => {
    const { outcome } = await run('yes', {
      pending: [action('a-1')],
      refuse: 'already_resolved',
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.reply).toMatch(/already handled/i);
    expect(outcome.reply).not.toMatch(/went wrong|try me again/i);
  });

  /**
   * The pre-review state, in PARENT language. The line used to say the draft "hasn't
   * cleared my own checks", which is Hale narrating its own reviewer to someone who
   * asked for a thing to happen — and it promises nothing about what happens next.
   *
   * What it must say: Hale is still on it, they have nothing to do. What it must not
   * say: a verdict, a check, a review, or a clock Hale does not own.
   */
  it('says the pre-review state in the parent\'s terms, with no reviewer jargon', async () => {
    const { outcome } = await run('yes', {
      pending: [action('a-1')],
      refuse: 'not_reviewer_approved',
    });

    expect(outcome.reply).toMatch(/double-checking/i);
    expect(outcome.reply).toMatch(/nothing for you to do/i);
    expect(outcome.reply).not.toMatch(/review|verdict|checks|flagged|approved by/i);
    expect(outcome.reply).not.toMatch(/went wrong|try me again/i);
    // No timeframe: a flagged draft waits on a person, and "in a minute" would be a
    // promise made out of a clock Hale does not hold.
    expect(outcome.reply).not.toMatch(/minute|shortly|soon/i);
  });

  it('declining a resolved row gets the same state receipt, not an apology', async () => {
    const { outcome } = await run('no', {
      pending: [action('a-1')],
      refuse: 'already_resolved',
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.reply).toMatch(/already handled/i);
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

  it('names the choices in one sentence, and never as a numbered menu', async () => {
    // The menu ("1. ... 2. ... - reply YES 1 or NO 1.") was the last one Hale sent, and
    // it went with the keyword instructions (2026-08-13). What replaced it has to still
    // let a parent pick, which is what the naming below is for.
    const { outcome } = await run('yes', { pending: three });

    expect(outcome.reply).toContain('add to your calendar');
    expect(outcome.reply).toContain('reschedule on your calendar');
    expect(outcome.reply).not.toMatch(/\b1\.|\bYES 1\b/);
    expect(outcome.reply).toMatch(/^Which one - /);
  });

  it('still resolves the ordinal a parent chooses to type - no read was removed', async () => {
    // Nothing prints "YES 2" any more. It keeps working, because a parent who learned it
    // must not discover it has been taken away.
    const { calls } = await run('yes 2', { pending: three });
    expect(calls).toEqual([{ op: 'approve', actionId: 'a-2', actor: PARENT }]);
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

  it('never lists more than the grammar can name, and discloses the rest', async () => {
    const many = Array.from({ length: 8 }, (_, i) => action(`a-${i + 1}`));
    const { outcome } = await run('yes', { pending: many });

    expect(outcome.status).toBe('ambiguous');
    // Every one of the eight shares a label, so naming alone cannot tell them apart.
    // Position does — as a description, never as an instruction.
    expect(outcome.reply).toContain('(the first)');
    expect(outcome.reply).toContain(`(the ${['first', 'second', 'third'][MAX_LISTED_APPROVALS - 1]})`);
    expect(outcome.reply).not.toContain('(the fourth)');
    // The overflow is disclosed, never hidden — and it points at the next turn of this
    // thread rather than at the app (skill audit P0 #4).
    expect(outcome.reply).toMatch(/5 more behind those/i);
  });

  it('leaves distinct labels completely alone - no position where none is needed', async () => {
    const { outcome } = await run('yes', {
      pending: [action('a-1'), { actionId: 'a-2', actionType: 'reschedule_event', reviewerApproved: true }],
    });
    expect(outcome.reply).not.toContain('(the first)');
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

  it('says the undo window closed rather than promising another minute', async () => {
    const { outcome } = await run('undo', {
      undoable: action('a-9'),
      refuse: 'undo_window_expired',
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.reply).toMatch(/undo window/i);
    // The window does not reopen: "try me again in a minute" is false for 24 hours.
    expect(outcome.reply).not.toMatch(/try me again/i);
  });

  it('says an action is not one it can take back, rather than that it broke', async () => {
    const { outcome } = await run('undo', {
      undoable: action('a-9', 'send_email'),
      refuse: 'not_reversible',
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.reply).toMatch(/take back/i);
    expect(outcome.reply).not.toMatch(/went wrong|try me again/i);
  });

  it('ignores the pending queue entirely — undo names an EXECUTED action', async () => {
    const { calls } = await run('undo', {
      pending: [action('pending-1')],
      undoable: action('executed-1'),
    });

    expect(calls).toEqual([{ op: 'undo', actionId: 'executed-1', actor: PARENT }]);
  });
});
