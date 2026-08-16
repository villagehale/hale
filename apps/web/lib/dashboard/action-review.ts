import type { EntryTone } from '~/components/hale/tone';
import { formatDateTime } from '~/lib/format/datetime';
import { reviewerCheckLabel } from '~/lib/format/labels';
import type { TrailActor } from './mappers';

/**
 * The transparency layer of a pending draft: WHY the reviewer let it through, and
 * WHERE the draft has got to. Pure — the queries hand in rows, this shapes them.
 *
 * Everything here is built from data the pipeline already writes. Nothing is
 * derived, scored, or estimated:
 *   - the checks come from `actions.reviewer_tool_results` (rule #3's tool_results,
 *     persisted as `{tool, ok, result}` by both the worker and the web reviewer);
 *   - the note is the reviewer's own `rationale`, which lives ONLY in the audit row
 *     that recorded the verdict — there is no reviewer-reasoning column;
 *   - the steps carry stored timestamps (`drafted_at`, `reviewer_verdict_at`, and
 *     the `action.approved_by_human` audit row's `occurred_at`).
 *
 * There is deliberately NO confidence figure. The drafter's confidence is not
 * persisted on the action row, so a meter here would be invented (the landing-page
 * doctrine: if there is no real number behind it, it does not ship).
 */

/** One verification, exactly as `actions.reviewer_tool_results` stores it. */
export interface ReviewerToolResult {
  tool: string;
  ok: boolean;
  result: unknown;
}

/** One verification, in a parent's words. */
export interface ReviewCheck {
  /** Curated finding for (tool, outcome) — never the raw tool token. */
  label: string;
  ok: boolean;
  /**
   * The per-action spending cap the reviewer measured against, in USD. Present on
   * exactly one branch: `check_spending_cap` returns `limitUsd` only when the amount
   * OVERRAN the per-action cap (apps/worker/src/tools/registry.ts). A pass stores
   * the figure inside a prose rationale string, so this is null there rather than a
   * number scraped out of a sentence.
   */
  capUsd: number | null;
}

/**
 * One rung of the draft's lifecycle. Only rungs that HAPPENED are built, plus the
 * single open one the draft is sitting at — so the rail can never show a speculative
 * future step it has no data for.
 */
export interface ActionStep {
  key: 'drafted' | 'reviewed' | 'approved' | 'open';
  /** Terse label; the prose framing stays on the card's summary line. */
  label: string;
  /** Family-zone stamp, or null for the open rung (it has not happened yet). */
  at: string | null;
  tone: EntryTone;
}

export interface ActionReview {
  /** The reviewer's recorded sentence, or null when unreviewed or teen-redacted. */
  note: string | null;
  checks: ReviewCheck[];
  steps: ActionStep[];
}

/** The human approval as the audit trail recorded it: when, and by which parent. */
export interface HumanApproval {
  at: Date;
  actor: TrailActor;
}

export interface ReviewFacts {
  reviewerVerdict: string;
  reviewerVerdictAt: Date | null;
  reviewerToolResults: ReviewerToolResult[];
  draftedAt: Date;
  /** The reviewer's rationale from its audit row, or null when it never ran. */
  reviewerNote: string | null;
  /** Set once `action.approved_by_human` exists for this draft — the parent has said
   * yes and the queue drain has not yet finished carrying it out. */
  approval: HumanApproval | null;
  /** Rule #1: a redacted draft withholds the reviewer's PROSE (it can quote the
   * teen), but keeps the checks and the stamps, which carry no content. */
  teenRedacted: boolean;
}

/** `check_spending_cap`'s stored per-action cap, when this result is that branch. */
function capUsdOf(entry: ReviewerToolResult): number | null {
  if (entry.tool !== 'check_spending_cap') return null;
  const { result } = entry;
  if (typeof result !== 'object' || result === null) return null;
  const limit = (result as { limitUsd?: unknown }).limitUsd;
  return typeof limit === 'number' && Number.isFinite(limit) ? limit : null;
}

export function toReviewChecks(stored: ReviewerToolResult[]): ReviewCheck[] {
  return stored.map((entry) => ({
    label: reviewerCheckLabel(entry.tool, entry.ok),
    ok: entry.ok,
    capUsd: capUsdOf(entry),
  }));
}

/** The verdict rung's terse label + tone. A verdict the registry doesn't know
 * degrades to the neutral 'reviewed' rather than echoing the stored token. */
const VERDICT_STEP: Record<string, { label: string; tone: EntryTone }> = {
  approved: { label: 'verified', tone: 'done' },
  flagged: { label: 'flagged', tone: 'awaiting' },
  rejected: { label: 'concern raised', tone: 'needs-you' },
  superseded: { label: 'replaced', tone: 'coach' },
};

const VERDICT_STEP_FALLBACK = { label: 'reviewed', tone: 'coach' as const };

/**
 * The rail. Reads forward: what has happened, then the one thing it is waiting on.
 *
 * The open rung is the honest part. A draft sits in `drafted_for_approval` from the
 * moment it is minted until the executor finishes with it — approving does NOT move
 * the column (approve.ts only enqueues) — so "waiting on your yes" and "you said yes,
 * it is running" are the same row to `user_visible_state`. The `action.approved_by_human`
 * audit row is what tells them apart, and it is the only thing that does; without it
 * this rail says "waiting on you", never a guess.
 */
export function toActionSteps(
  facts: ReviewFacts,
  timeZone: string,
  now: Date = new Date(),
): ActionStep[] {
  const steps: ActionStep[] = [
    {
      key: 'drafted',
      label: 'drafted',
      at: formatDateTime(facts.draftedAt, timeZone, now),
      tone: 'done',
    },
  ];

  if (facts.reviewerVerdictAt !== null) {
    const rung = VERDICT_STEP[facts.reviewerVerdict] ?? VERDICT_STEP_FALLBACK;
    steps.push({
      key: 'reviewed',
      label: rung.label,
      at: formatDateTime(facts.reviewerVerdictAt, timeZone, now),
      tone: rung.tone,
    });
  } else {
    // No verdict stamp means the reviewer has not run. That IS the open rung — there
    // is nothing to say about a parent decision that cannot be offered yet.
    steps.push({ key: 'open', label: 'waiting on Hale’s review', at: null, tone: 'awaiting' });
    return steps;
  }

  if (facts.approval !== null) {
    steps.push({
      key: 'approved',
      label: facts.approval.actor === 'co-parent' ? 'your co-parent said yes' : 'you said yes',
      at: formatDateTime(facts.approval.at, timeZone, now),
      tone: 'done',
    });
    steps.push({ key: 'open', label: 'Hale is carrying it out', at: null, tone: 'awaiting' });
    return steps;
  }

  steps.push({
    key: 'open',
    // Only a reviewer-APPROVED draft is offered an approve button (the route 409s on
    // any other verdict), so a flagged/rejected row is waiting on a decision, not on
    // a yes it will never be able to give.
    label: facts.reviewerVerdict === 'approved' ? 'waiting on your yes' : 'waiting on you',
    at: null,
    tone: 'awaiting',
  });
  return steps;
}

export function toActionReview(
  facts: ReviewFacts,
  timeZone: string,
  now: Date = new Date(),
): ActionReview {
  return {
    note: facts.teenRedacted ? null : facts.reviewerNote,
    checks: toReviewChecks(facts.reviewerToolResults),
    steps: toActionSteps(facts, timeZone, now),
  };
}
