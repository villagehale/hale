import { describe, expect, it } from 'vitest';
import { mintApprovedAction, type ApprovedAction, type DraftedAction, type ReviewerVerdict } from './action.js';

const draft: DraftedAction = {
  id: '22222222-2222-4222-8222-222222222222',
  eventId: '33333333-3333-4333-8333-333333333333',
  familyId: '11111111-1111-4111-8111-111111111111',
  actionType: 'send_email',
  payload: { to: 'a@b.com', subject: 'hi', body: 'x' },
  draftConfidence: 0.9,
  rationale: 'drafted',
  recipientVisibility: 'public',
  draftedAt: '2026-06-12T10:00:00.000Z',
};

const approveVerdict: ReviewerVerdict = {
  kind: 'approve',
  rationale: 'all checks green',
  toolResults: [{ tool: 'check_pii_leak', ok: true, result: {} }],
};

// Coverage predicate stand-in: the real worker injects coverageSatisfied.
const alwaysCovered = () => true;
const neverCovered = () => false;

describe('ApprovedAction brand', () => {
  it('cannot be constructed by spreading a plain object literal', () => {
    // @ts-expect-error — a hand-spread literal lacks the unique-symbol brand,
    // so it is NOT assignable to ApprovedAction. This is the structural guard.
    const fake: ApprovedAction = {
      ...draft,
      verdict: approveVerdict as Extract<ReviewerVerdict, { kind: 'approve' }>,
      approvedAt: '2026-06-12T10:00:00.000Z',
    };
    void fake;
  });

  it('mints a branded value the Executor signature accepts', () => {
    const approved = mintApprovedAction(draft, approveVerdict, alwaysCovered);
    expect(approved.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(approved.verdict.kind).toBe('approve');
  });
});

describe('mintApprovedAction enforcement', () => {
  it('throws when the verdict is not approve', () => {
    const flagged: ReviewerVerdict = { kind: 'flag_for_human', rationale: 'unsure', toolResults: [] };
    expect(() => mintApprovedAction(draft, flagged, alwaysCovered)).toThrow(/not 'approve'/);
  });

  it('throws COVERAGE_NOT_SATISFIED when required checks are uncovered', () => {
    expect(() => mintApprovedAction(draft, approveVerdict, neverCovered)).toThrow(
      /COVERAGE_NOT_SATISFIED/,
    );
  });

  it('passes the verdict tool results (name + ok) to the coverage predicate', () => {
    let seen: { tool: string; ok: boolean }[] = [];
    mintApprovedAction(draft, approveVerdict, (_type, results) => {
      seen = results;
      return true;
    });
    expect(seen).toEqual([{ tool: 'check_pii_leak', ok: true }]);
  });
});
