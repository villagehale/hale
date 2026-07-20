'use client';

import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import { ONBOARDING_STEP_COUNT, stepLabel } from '~/lib/onboarding/steps';

/**
 * The onboarding frame (design handoff §4.1): a centered conversational flow on the
 * warm canvas — NOT the split brand panel the auth pages use. A top chrome row
 * carries a Back arrow (from step 2), a segmented progress bar (one segment per
 * step, filled to the current step), and a Skip link where the step is optional.
 * The content sits in a centered column beneath it. Warm-canvas + role tokens
 * invert correctly in dark mode; the ThemeToggle stays reachable in the corner.
 */
export function OnboardingShell({
  step,
  onBack,
  onSkip,
  children,
}: {
  /** 1-indexed current step (1..9). */
  step: number;
  /** Shown as the Back arrow when provided; omit to hide (step 1 / post-auth). */
  onBack?: () => void;
  /** Shown as the Skip link when provided; omit where the step isn't skippable. */
  onSkip?: () => void;
  children: ReactNode;
}) {
  const total = ONBOARDING_STEP_COUNT;
  return (
    <main className="ob-shell">
      <div className="ob-theme">
        <ThemeToggle />
      </div>
      <div className="ob-chrome">
        {onBack ? (
          <button type="button" className="ob-back" onClick={onBack}>
            <ArrowLeft size={18} strokeWidth={2} aria-hidden="true" />
            <span className="sr-only">Back</span>
          </button>
        ) : (
          <span className="ob-back-spacer" aria-hidden="true" />
        )}

        {/* The segmented bar is decorative; the step is announced via the sr-only
            live region beside it. (A non-focusable progressbar role trips a11y
            lint and adds a needless tab stop, so the live region carries the
            semantics instead.) */}
        <div className="ob-progress" aria-hidden="true">
          {Array.from({ length: total }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static progress segments
              key={i}
              className={i < step ? 'ob-seg ob-seg-on' : 'ob-seg'}
            />
          ))}
        </div>
        <span className="sr-only" aria-live="polite">
          Step {step} of {total} — {stepLabel(step)}
        </span>

        {onSkip ? (
          <button type="button" className="ob-skip" onClick={onSkip}>
            Skip
          </button>
        ) : (
          <span className="ob-skip-spacer" aria-hidden="true" />
        )}
      </div>

      <div className="ob-column">{children}</div>
    </main>
  );
}
