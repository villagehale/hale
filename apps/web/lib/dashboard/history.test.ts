import { describe, expect, it } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER } from './mappers';
import { type HistoryActionRow, historyStatus, toHistoryView } from './history';

/**
 * The Approvals HISTORY mapper. Load-bearing assertions:
 *  - status derivation never conflates a DECLINED row with an EXECUTED one (or vice
 *    versa) — the status comes from the terminal state + revert reason, not order.
 *  - a teen-content row NEVER carries its raw payload into the view (rule #1): the
 *    preview is the placeholder and the payload is null, so raw text can't leak.
 */

const TZ = 'America/Toronto';
const RESOLVED_AT = new Date('2026-06-20T14:00:00Z');

function row(over: Partial<HistoryActionRow>): HistoryActionRow {
  return {
    id: 'act-1',
    actionType: 'send_email',
    payload: { to: 'clinic@ex.test', subject: 'Confirm Tuesday 3pm' },
    reviewerVerdict: 'approved',
    draftedAt: RESOLVED_AT,
    teenContent: false,
    childId: null,
    childLabel: null,
    userVisibleState: 'autonomous',
    executedAt: RESOLVED_AT,
    revertedReason: null,
    resolvedAt: RESOLVED_AT,
    ...over,
  };
}

describe('historyStatus — resolved status derivation', () => {
  it('an executed autonomous action reads "executed"', () => {
    expect(historyStatus(row({ userVisibleState: 'autonomous' }))).toBe('executed');
  });

  it('a human-declined revert reads "declined", NOT executed or reverted', () => {
    const status = historyStatus(
      row({ userVisibleState: 'reverted', executedAt: null, revertedReason: 'declined_by_human' }),
    );
    expect(status).toBe('declined');
    expect(status).not.toBe('executed');
    expect(status).not.toBe('reverted');
  });

  it('a non-decline revert reads "reverted" (distinct from a decline)', () => {
    expect(
      historyStatus(
        row({ userVisibleState: 'reverted', executedAt: null, revertedReason: 'user_undo' }),
      ),
    ).toBe('reverted');
  });

  it('a needs-human hold (never executed) reads "held"', () => {
    expect(historyStatus(row({ userVisibleState: 'needs_human', executedAt: null }))).toBe('held');
  });

  it('a needs-human row that DID execute reads "failed", NOT "held"', () => {
    // recordExecution stamps needs_human + executedAt when input.ok is false — a
    // parent-approved action that failed mid-execution. It must disclose the failure,
    // not read as a calm "held for you".
    const status = historyStatus(
      row({ userVisibleState: 'needs_human', executedAt: RESOLVED_AT }),
    );
    expect(status).toBe('failed');
    expect(status).not.toBe('held');
  });
});

describe('toHistoryView — rule #1 teen redaction', () => {
  it('never leaks raw payload text for a teen-content row', () => {
    const secret = 'Maya said she is anxious about the dance';
    const view = toHistoryView(
      row({
        teenContent: true,
        actionType: 'reply_to_email',
        payload: { to: secret, subject: secret, body: secret },
      }),
      TZ,
    );

    // The intent label is the placeholder, not the raw text; payload is withheld.
    expect(view.preview).toBe(TEEN_REDACTED_PLACEHOLDER);
    expect(view.payload).toBeNull();
    // Hard guarantee: the raw teen text appears NOWHERE in the serialized view.
    expect(JSON.stringify(view)).not.toContain(secret);
  });

  it('carries the live card’s teen-safe intent label for a non-teen row', () => {
    const view = toHistoryView(row({ actionType: 'send_email' }), TZ);
    // The SAME derivePreview the live Approvals card renders (Email <to> — <subject>).
    expect(view.preview).toBe('Email clinic@ex.test — Confirm Tuesday 3pm');
    expect(view.status).toBe('executed');
    expect(view.resolvedAt.length).toBeGreaterThan(0);
  });
});

/**
 * VIL-260 · WS3b — the history row says whether it can still be taken back.
 *
 * UNDO existed as a primitive and as an SMS command, but no surface ever offered it,
 * so a parent who approved a calendar placement in the app had to text to reverse it.
 * The flag is derived from the SAME gate the server enforces (undo-window.ts), so the
 * control can never be shown on a row the reversal would refuse — or hidden on one it
 * would accept.
 */
describe('toHistoryView — undoable', () => {
  const EXECUTED_AT = new Date('2026-06-20T14:00:00Z');
  const ONE_HOUR_LATER = new Date('2026-06-20T15:00:00Z');
  const TWO_DAYS_LATER = new Date('2026-06-22T14:00:00Z');

  function placement(over: Partial<HistoryActionRow> = {}): HistoryActionRow {
    return row({
      actionType: 'calendar_add',
      userVisibleState: 'autonomous',
      executedAt: EXECUTED_AT,
      payload: { title: 'Swim lesson', startsAt: '2026-07-01T14:00:00.000Z' },
      ...over,
    });
  }

  it('offers undo on a calendar placement executed inside the window', () => {
    expect(toHistoryView(placement(), TZ, ONE_HOUR_LATER).undoable).toBe(true);
  });

  it('withdraws it once the 24h window has passed', () => {
    expect(toHistoryView(placement(), TZ, TWO_DAYS_LATER).undoable).toBe(false);
  });

  it('never offers it on a type the reversal refuses', () => {
    // A move/cancel undo would need the pre-mutation state, which is not persisted.
    expect(toHistoryView(placement({ actionType: 'calendar_move' }), TZ, ONE_HOUR_LATER).undoable)
      .toBe(false);
    expect(toHistoryView(row({ actionType: 'send_email' }), TZ, ONE_HOUR_LATER).undoable).toBe(
      false,
    );
  });

  it('never offers it on a row that never executed, or on one already reverted', () => {
    expect(
      toHistoryView(
        placement({ userVisibleState: 'needs_human', executedAt: null }),
        TZ,
        ONE_HOUR_LATER,
      ).undoable,
    ).toBe(false);
    expect(
      toHistoryView(
        placement({ userVisibleState: 'reverted', revertedReason: 'undone_by_human' }),
        TZ,
        ONE_HOUR_LATER,
      ).undoable,
    ).toBe(false);
  });

  it('never offers it on a teen-redacted row — no acting on invisible content', () => {
    expect(toHistoryView(placement({ teenContent: true }), TZ, ONE_HOUR_LATER).undoable).toBe(
      false,
    );
  });
});
