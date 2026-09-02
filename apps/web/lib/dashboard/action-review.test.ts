import { describe, expect, it } from 'vitest';
import {
  type ReviewFacts,
  type ReviewerToolResult,
  toActionReview,
  toActionSteps,
  toReviewChecks,
} from './action-review';

const TZ = 'America/Toronto';
/** Pinned so the stamps stay same-year (formatDateTime adds a year otherwise). */
const NOW = new Date('2026-08-02T20:00:00.000Z');
const DRAFTED = new Date('2026-08-02T12:04:00.000Z'); // 08:04 Toronto
const REVIEWED = new Date('2026-08-02T12:05:00.000Z'); // 08:05 Toronto
const APPROVED = new Date('2026-08-02T13:31:00.000Z'); // 09:31 Toronto

function facts(overrides: Partial<ReviewFacts> = {}): ReviewFacts {
  return {
    reviewerVerdict: 'approved',
    reviewerVerdictAt: REVIEWED,
    reviewerToolResults: [],
    draftedAt: DRAFTED,
    reviewerNote: 'The clinic is already on your recipient list.',
    approval: null,
    teenRedacted: false,
    ...overrides,
  };
}

/** The three shapes apps/worker/src/tools/registry.ts actually stores. */
const CAP_PASS: ReviewerToolResult = {
  tool: 'check_spending_cap',
  ok: true,
  result: { withinLimits: true, rationale: 'amount 12 within per-action cap of 50' },
};
const CAP_OVERRUN: ReviewerToolResult = {
  tool: 'check_spending_cap',
  ok: false,
  result: {
    withinLimits: false,
    exceededCap: 'per_action',
    limitUsd: 50,
    rationale: 'amount 120 exceeds per-action cap of 50',
  },
};
const CAP_CATEGORY: ReviewerToolResult = {
  tool: 'check_spending_cap',
  ok: false,
  result: {
    withinLimits: false,
    exceededCap: 'category_requires_approval',
    rationale: 'category "medical" requires explicit approval per family policy',
  },
};

describe('toReviewChecks — the reviewer’s invoked verifications (rule #3)', () => {
  it('states the FINDING per tool, so the mark only confirms what the words say', () => {
    const checks = toReviewChecks([
      { tool: 'check_calendar_conflict', ok: true, result: {} },
      { tool: 'check_calendar_conflict', ok: false, result: {} },
      { tool: 'check_pii_leak', ok: true, result: {} },
    ]);
    expect(checks.map((c) => c.label)).toEqual([
      'calendar clear',
      'calendar clash',
      'no private details',
    ]);
  });

  it('never renders a raw tool token — an unknown tool degrades to neutral copy', () => {
    const [passed, failed] = toReviewChecks([
      { tool: 'check_something_new', ok: true, result: {} },
      { tool: 'check_something_new', ok: false, result: {} },
    ]);
    expect(passed?.label).toBe('another check passed');
    expect(failed?.label).toBe('another check flagged');
    // A check the reviewer ran is never DROPPED either: rule #3 makes the coverage
    // itself the disclosure, so hiding one would under-report Hale's own work.
    expect(toReviewChecks([{ tool: 'check_something_new', ok: true, result: {} }])).toHaveLength(1);
  });

  it('surfaces the spending cap only on the branch that stores a number', () => {
    expect(toReviewChecks([CAP_OVERRUN])[0]).toEqual({
      label: 'over your cap',
      ok: false,
      capUsd: 50,
    });
    // A PASS stores the figure inside a prose rationale, and the category branch
    // stores none at all — neither is scraped into a number the UI would present
    // as measured.
    expect(toReviewChecks([CAP_PASS])[0]?.capUsd).toBeNull();
    expect(toReviewChecks([CAP_CATEGORY])[0]?.capUsd).toBeNull();
  });

  it('reads no cap off another tool that happens to carry a limitUsd', () => {
    const impostor: ReviewerToolResult = {
      tool: 'check_user_override',
      ok: true,
      result: { limitUsd: 999 },
    };
    expect(toReviewChecks([impostor])[0]?.capUsd).toBeNull();
  });
});

describe('toActionSteps — the rail shows what happened, plus the one open rung', () => {
  it('stops at the reviewer when no verdict has been recorded', () => {
    const steps = toActionSteps(facts({ reviewerVerdict: 'pending', reviewerVerdictAt: null }), TZ, NOW);
    expect(steps.map((s) => [s.key, s.label, s.at])).toEqual([
      ['drafted', 'drafted', 'Aug 2, 08:04'],
      ['open', 'waiting on Hale’s review', null],
    ]);
  });

  it('reads drafted → verified → waiting on your yes for an approved draft', () => {
    const steps = toActionSteps(facts(), TZ, NOW);
    expect(steps.map((s) => s.label)).toEqual(['drafted', 'verified', 'waiting on your yes']);
    expect(steps.map((s) => s.tone)).toEqual(['done', 'done', 'awaiting']);
    expect(steps[1]?.at).toBe('Aug 2, 08:05');
  });

  it('never promises a yes on a draft the approve route would refuse', () => {
    // Only a reviewer-APPROVED draft gets an approve button (approve.ts 409s on any
    // other verdict), so a flagged/rejected rung must not say "your yes".
    for (const verdict of ['flagged', 'rejected']) {
      const steps = toActionSteps(facts({ reviewerVerdict: verdict }), TZ, NOW);
      expect(steps[2]?.label).toBe('waiting on you');
    }
    expect(toActionSteps(facts({ reviewerVerdict: 'flagged' }), TZ, NOW)[1]).toMatchObject({
      label: 'flagged',
      tone: 'awaiting',
    });
    expect(toActionSteps(facts({ reviewerVerdict: 'rejected' }), TZ, NOW)[1]).toMatchObject({
      label: 'concern raised',
      tone: 'needs-you',
    });
  });

  it('degrades an unrecognised verdict to a neutral rung, never the stored token', () => {
    const rung = toActionSteps(facts({ reviewerVerdict: 'quarantined' }), TZ, NOW)[1];
    expect(rung?.label).toBe('reviewed');
    expect(rung?.label).not.toContain('quarantined');
  });

  it('names the in-flight state only when the approval audit row proves it', () => {
    // The action row is 'drafted_for_approval' in BOTH cases — approving enqueues and
    // does not move the column — so the audit row is the only thing that tells them
    // apart, and without it the rail must not guess.
    expect(toActionSteps(facts(), TZ, NOW).map((s) => s.label)).not.toContain('Hale is carrying it out');

    const running = toActionSteps(facts({ approval: { at: APPROVED, actor: 'you' } }), TZ, NOW);
    expect(running.map((s) => [s.label, s.at])).toEqual([
      ['drafted', 'Aug 2, 08:04'],
      ['verified', 'Aug 2, 08:05'],
      ['you said yes', 'Aug 2, 09:31'],
      ['Hale is carrying it out', null],
    ]);
  });

  it('credits the co-parent when it was the co-parent who approved', () => {
    const steps = toActionSteps(facts({ approval: { at: APPROVED, actor: 'co-parent' } }), TZ, NOW);
    expect(steps[2]?.label).toBe('your co-parent said yes');
  });

  it('renders every stamp in the family’s zone, not the server’s', () => {
    const vancouver = toActionSteps(facts(), 'America/Vancouver', NOW);
    expect(vancouver[0]?.at).toBe('Aug 2, 05:04');
  });
});

describe('toActionReview — rule #1 withholds the prose, not the provenance', () => {
  const withChecks = facts({
    reviewerToolResults: [{ tool: 'check_pii_leak', ok: true, result: {} }],
  });

  it('keeps the reviewer’s sentence on an ordinary draft', () => {
    expect(toActionReview(withChecks, TZ, NOW).note).toBe(
      'The clinic is already on your recipient list.',
    );
  });

  it('withholds the sentence for a teen-redacted draft — it is model prose that can quote them', () => {
    const redacted = toActionReview({ ...withChecks, teenRedacted: true }, TZ, NOW);
    expect(redacted.note).toBeNull();
    // The checks and the rail survive: a tool name and a timestamp say what Hale did,
    // never what it read, so a redacted draft still shows it was verified.
    expect(redacted.checks).toEqual([{ label: 'no private details', ok: true, capUsd: null }]);
    expect(redacted.steps).toHaveLength(3);
  });
});
