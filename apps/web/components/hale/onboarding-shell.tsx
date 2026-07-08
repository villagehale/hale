import type { ReactNode } from 'react';
import Link from 'next/link';
import { LogoMark } from '~/components/hale/logo-mark';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import {
  ONBOARDING_STEPS,
  type OnboardingPhase,
  type OnboardingView,
  activeStepLabel,
  reachedStepCount,
} from '~/lib/onboarding/steps';

/**
 * The onboarding frame — the sign-in AuthShell's two-panel split, extended for the
 * wizard: a Spruce (Prussian) brand rail on the left carrying the turtle, the
 * warm promise, and the four-step journey indicator (your kids → your area → what
 * matters → in control); the current wizard step on the linen canvas at right.
 * Below lg the rail folds to a slim top band (like AuthShell folds its panel away)
 * so a phone reads a single column with no horizontal overflow. Spruce tokens
 * (bg-spruce / text-on-spruce) invert correctly in dark mode.
 */
export function OnboardingShell({
  phase,
  view = 'form',
  children,
}: {
  phase: OnboardingPhase;
  /** The C phase's in-place view, so the rail can advance from the setup form to
   * the consent moment. Defaults to 'form' (the only view A/B ever render in). */
  view?: OnboardingView;
  children: ReactNode;
}) {
  const reached = reachedStepCount(phase, view);
  const currentLabel = activeStepLabel(phase, view);

  return (
    <main className="min-h-[100dvh] bg-linen lg:grid lg:grid-cols-[minmax(0,26rem)_1fr]">
      {/* Slim top band on <lg: the brand + theme toggle, mirroring AuthShell's
          folded header. The full rail below is lg-only. */}
      <header className="border-b border-rule px-6 pt-6 pb-4 lg:hidden">
        <div className="flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <LogoMark size={32} />
            <span className="font-display text-2xl font-semibold leading-none">Hale</span>
          </Link>
          <ThemeToggle />
        </div>
        <p className="meta mt-3" aria-live="polite">
          step {reached} of {ONBOARDING_STEPS.length} — {currentLabel}
        </p>
      </header>

      <aside className="bg-spruce text-on-spruce hidden lg:flex flex-col justify-between px-12 py-14 xl:px-14">
        <Link href="/" className="flex items-center gap-3">
          <LogoMark size={36} />
          <span className="font-display text-2xl font-semibold text-on-spruce">Hale</span>
        </Link>

        <div className="max-w-sm">
          <p className="font-display text-[clamp(2rem,2.6vw,2.75rem)] font-semibold leading-[1.1] tracking-[-0.02em] text-on-spruce text-balance">
            Every family deserves a <span className="text-apricot-deep">village</span>.
          </p>
          <p className="mt-5 text-lg leading-relaxed text-on-spruce-soft">
            A few quiet questions, and Hale starts finding the people and places near
            you — for every stage of childhood.
          </p>
        </div>

        <ol className="space-y-4">
          {ONBOARDING_STEPS.map((step, index) => {
            const isReached = index < reached;
            const isCurrent = index === reached - 1;
            return (
              <li key={step.id} className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="block h-1.5 w-1.5 rounded-full"
                  style={{
                    background: isReached
                      ? 'var(--color-apricot-deep)'
                      : 'var(--color-on-spruce-faint)',
                  }}
                />
                <span
                  className={
                    isCurrent
                      ? 'text-on-spruce'
                      : isReached
                        ? 'text-on-spruce-soft'
                        : 'text-on-spruce-faint'
                  }
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  {step.label}
                </span>
              </li>
            );
          })}
        </ol>
      </aside>

      <section className="relative flex min-h-[100dvh] flex-col px-6 py-12 lg:min-h-0 lg:px-14 lg:py-16 xl:px-20">
        <div className="hidden lg:flex absolute top-8 right-10 z-10">
          <ThemeToggle />
        </div>
        <div className="w-full max-w-2xl mx-auto lg:mx-0">{children}</div>
      </section>
    </main>
  );
}
