import { AlertTriangle, Check } from 'lucide-react';
import { ToneStripe } from '~/components/hale/tone';
import type { ActionReview, ActionStep, ReviewCheck } from '~/lib/dashboard/action-review';

/**
 * The provenance half of an approval card: where the draft has got to, and what the
 * reviewer did before it arrived. Presentation only — every value is already-shaped
 * persisted data (action-review.ts), and this component invents nothing.
 *
 * The rail carries only rungs that HAPPENED plus the one the draft is sitting at, so
 * it can never show a step it has no stamp for. There is no progress bar and no
 * animation: the drain is minutely, the states are discrete, and a moving bar would
 * be a picture of work Hale is not necessarily doing.
 */

const CAP_USD = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/**
 * One rung. The tone glyph carries the state by SHAPE (filled disc = happened,
 * hollow ring = still open, diamond = a concern), so the rail never leans on colour
 * alone; the label states it in words beside it.
 */
function Step({ step, first }: { step: ActionStep; first: boolean }) {
  return (
    <li className={first ? 'flex items-start gap-2' : 'flex items-start gap-2 border-l border-rule pl-4'}>
      <span className="mt-0.5">
        <ToneStripe tone={step.tone} />
      </span>
      <span className="min-w-0">
        <span className="eyebrow block">{step.label}</span>
        {step.at !== null ? <span className="meta tabular block text-ink-3">{step.at}</span> : null}
      </span>
    </li>
  );
}

/**
 * A verification the reviewer actually invoked (rule #3). The label already states
 * the finding — "calendar clear" vs "calendar clash" — so the mark and the tint only
 * confirm it. The failing tint is berry, the same ink `.tone-needs-you` already uses
 * for a blocked outcome; the shield glyph (and only the shield) stays privacy's.
 */
function CheckChip({ check }: { check: ReviewCheck }) {
  const Mark = check.ok ? Check : AlertTriangle;
  return (
    <span className={`pill ${check.ok ? 'pill-sage' : 'pill-berry'}`}>
      <Mark size={13} strokeWidth={1.8} aria-hidden="true" />
      {check.label}
      {/* Only the per-action OVERRUN branch of check_spending_cap stores the figure it
        * measured against, so the cap appears exactly where it is real. */}
      {/* `.pill` is a flex row with its own gap, so no leading space here. */}
      {check.capUsd !== null ? <span className="tabular">({CAP_USD.format(check.capUsd)})</span> : null}
    </span>
  );
}

export function ActionProgress({ review }: { review: ActionReview }) {
  return (
    <ol className="mt-4 flex flex-wrap items-start gap-x-4 gap-y-3">
      {review.steps.map((step, index) => (
        <Step key={step.key} step={step} first={index === 0} />
      ))}
    </ol>
  );
}

/**
 * What the reviewer recorded. Rendered only when there is something recorded to show:
 * an unreviewed draft, and a teen-redacted one (whose prose is withheld but whose
 * checks are not — a tool name carries no content), each show only what they have.
 */
export function ReviewNote({ review }: { review: ActionReview }) {
  if (review.note === null && review.checks.length === 0) return null;
  return (
    <div className="mt-4 border-t border-rule pt-4">
      <p className="eyebrow">before this reached you</p>
      {review.note !== null ? (
        <p className="meta mt-2 leading-relaxed text-ink-2" data-hale-pii>
          {review.note}
        </p>
      ) : null}
      {review.checks.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {review.checks.map((check, index) => (
            <CheckChip key={`${check.label}-${index}`} check={check} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
