'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { PlanTier } from '@hale/types';
import { LogoMark } from '~/components/hale/logo-mark';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import { validateChild } from '~/lib/onboarding/children';
import { completeOnboarding } from '~/lib/onboarding/complete-onboarding';
import {
  type IntakeDraft,
  clearIntakeDraft,
  readIntakeDraft,
  writeIntakeDraft,
} from '~/lib/onboarding/intake-storage';
import { startGoogleSignIn } from '~/lib/onboarding/sign-in-action';

type Phase = 'A' | 'B' | 'C';

const PHASE_META: Record<Phase, { folio: string; section: string; title: string }> = {
  A: { folio: '01', section: 'step one of three', title: 'tell me about your child' },
  B: { folio: '02', section: 'step two of three', title: 'create your account' },
  C: { folio: '03', section: 'step three of three', title: 'finish setting up' },
};

const PLAN_OPTIONS: { tier: PlanTier; label: string; note: string }[] = [
  { tier: 'free', label: 'free', note: 'observe + draft · no autonomous action' },
  { tier: 'plus', label: 'plus', note: 'hale acts on your approval · $24/mo' },
  { tier: 'family', label: 'family', note: 'autonomy + commerce + portals · $49/mo' },
];

export function OnboardingWizard({
  authReady,
  signedIn,
  startAtSetup,
}: {
  authReady: boolean;
  signedIn: boolean;
  startAtSetup: boolean;
}) {
  const router = useRouter();

  // Returning from the OAuth round-trip with ?step=setup AND a real session lands
  // straight in Phase C; otherwise intake starts at Phase A.
  const initialPhase: Phase = startAtSetup && signedIn ? 'C' : 'A';
  const [phase, setPhase] = useState<Phase>(initialPhase);

  const [childName, setChildName] = useState('');
  const [approxMonth, setApproxMonth] = useState('');
  const [goal, setGoal] = useState('');
  const [planTier, setPlanTier] = useState<PlanTier>('free');
  const [tosAccepted, setTosAccepted] = useState(false);

  // Phase C inputs — the first point sensitive data is collected (rule #1).
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [areaCoarse, setAreaCoarse] = useState('');

  // On mount, hydrate from the sessionStorage draft so Phase A survives the OAuth
  // redirect and prefills Phase C's child name.
  useEffect(() => {
    const draft = readIntakeDraft();
    if (!draft) {
      return;
    }
    setChildName(draft.childName);
    setApproxMonth(draft.approxMonth);
    setGoal(draft.goal);
    setPlanTier(isPlanTier(draft.planTier) ? draft.planTier : 'free');
    setTosAccepted(draft.tosAccepted);
  }, []);

  const meta = PHASE_META[phase];
  const phaseIndex = phase === 'A' ? 1 : phase === 'B' ? 2 : 3;

  const phaseAComplete = childName.trim().length > 0 && /^\d{4}-\d{2}$/.test(approxMonth);

  function persistDraft(patch: Partial<IntakeDraft>) {
    const next: IntakeDraft = {
      childName,
      approxMonth,
      goal,
      planTier,
      tosAccepted,
      ...patch,
    };
    writeIntakeDraft(next);
  }

  function goToPhaseB() {
    persistDraft({});
    setPhase('B');
  }

  const dobValidation = useMemo(() => (dateOfBirth ? validateChild({ name: childName || 'x', dateOfBirth }) : null), [dateOfBirth, childName]);
  const dobError = dobValidation && !dobValidation.ok ? describeError(dobValidation.error) : null;

  const [setupState, setSetupState] = useState<
    { kind: 'idle' } | { kind: 'saving' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const canFinish =
    childName.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth) &&
    !dobError &&
    tosAccepted;

  async function handleFinish() {
    setSetupState({ kind: 'saving' });
    const result = await completeOnboarding({
      child: { name: childName.trim(), dateOfBirth },
      planTier,
      tosAccepted,
      areaCoarse,
    });
    if (result.status === 'completed') {
      clearIntakeDraft();
      router.push('/home');
      return;
    }
    if (result.status === 'preview') {
      // Dev preview (auth/db unconfigured): nothing was written. Don't pretend a
      // family exists — say so and keep the user where they are.
      setSetupState({
        kind: 'error',
        message:
          "development preview — sign-in isn't configured here, so nothing was saved.",
      });
      return;
    }
    setSetupState({
      kind: 'error',
      message: `couldn't finish: ${result.error.replace(/_/g, ' ')}`,
    });
  }

  return (
    <div className="min-h-screen bg-linen">
      <header className="shell flex items-center justify-between pt-6 pb-4 border-b border-rule">
        <Link href="/" className="flex items-center gap-3">
          <LogoMark size={32} />
          <span className="font-display text-2xl font-semibold leading-none">Hale</span>
        </Link>

        <div className="flex items-center gap-3">
          <span className="eyebrow">enrolment</span>
          <div className="flex items-center gap-1.5" aria-hidden>
            {[1, 2, 3].map((s) => (
              <span
                key={s}
                className="block h-px w-6"
                style={{
                  background: s <= phaseIndex ? 'var(--color-spruce)' : 'var(--color-rule-strong)',
                }}
              />
            ))}
          </div>
          <span className="meta tabular" aria-live="polite" aria-atomic="true">
            step {phaseIndex} of 3
          </span>
          <ThemeToggle />
        </div>
      </header>

      <main className="shell pt-16 lg:pt-24 pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-10 lg:gap-x-12">
          <div className="onboarding-hero lg:col-span-3">
            <span className="folio">{meta.folio}</span>
            <p className="meta mt-2">{meta.section}</p>
            <h1 className="mt-6 font-display">{meta.title}</h1>
          </div>

          <div className="lg:col-span-9 lg:col-start-4">
            {phase === 'A' ? (
              <section className="rise rise-1 space-y-10 max-w-2xl">
                <p className="text-lg text-slate-green leading-relaxed">
                  Start with the basics — just enough for me to show you how Hale
                  tailors to your child. Nothing here is saved until you create your
                  account, and I never ask for a full birthday or anything sensitive
                  yet.
                </p>

                <div className="space-y-6">
                  <div>
                    <label htmlFor="intake-name" className="eyebrow">
                      your child&rsquo;s first name
                    </label>
                    <input
                      id="intake-name"
                      type="text"
                      className="field mt-2"
                      value={childName}
                      onChange={(e) => setChildName(e.currentTarget.value)}
                      placeholder="maya"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>

                  <div>
                    <label htmlFor="intake-month" className="eyebrow">
                      roughly when were they born?
                    </label>
                    <input
                      id="intake-month"
                      type="month"
                      className="field mt-2"
                      value={approxMonth}
                      max={new Date().toISOString().slice(0, 7)}
                      onChange={(e) => setApproxMonth(e.currentTarget.value)}
                    />
                    <p className="meta mt-2">just the month for now — the exact date comes later, after you sign in.</p>
                  </div>

                  <div>
                    <label htmlFor="intake-goal" className="eyebrow">
                      what are you hoping Hale can help with?
                    </label>
                    <textarea
                      id="intake-goal"
                      className="field mt-2"
                      value={goal}
                      onChange={(e) => setGoal(e.currentTarget.value)}
                      placeholder="finding good local classes, keeping the calendar straight…"
                      rows={3}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-5 pt-2">
                  <Link href="/" className="btn-ghost">
                    ← back
                  </Link>
                  <button
                    type="button"
                    className="btn-primary ml-auto"
                    onClick={goToPhaseB}
                    disabled={!phaseAComplete}
                  >
                    continue →
                  </button>
                </div>
                <p className="meta">pipeda · law 25 · casl compliant by default</p>
              </section>
            ) : null}

            {phase === 'B' ? (
              <section className="rise rise-1 space-y-10 max-w-2xl">
                <p className="text-lg text-slate-green leading-relaxed">
                  Create your account to save your setup. Pick a plan — you can change
                  it any time and nothing is charged today.
                </p>

                <fieldset>
                  <legend className="eyebrow">choose a plan</legend>
                  <div className="mt-4 space-y-3">
                    {PLAN_OPTIONS.map((opt) => {
                      const selected = planTier === opt.tier;
                      return (
                        <label
                          key={opt.tier}
                          className={`cursor-pointer text-left p-4 rounded-[var(--r-md)] transition-colors flex items-baseline justify-between ${
                            selected ? 'bg-oat border border-spruce' : 'border border-rule-strong hover:border-spruce'
                          }`}
                        >
                          <span>
                            <span className="font-display text-xl block">{opt.label}</span>
                            <span className="meta block mt-1">{opt.note}</span>
                          </span>
                          <input
                            type="radio"
                            name="plan-tier"
                            value={opt.tier}
                            checked={selected}
                            onChange={() => {
                              setPlanTier(opt.tier);
                              persistDraft({ planTier: opt.tier });
                            }}
                            className="sr-only"
                          />
                          {selected ? <span className="eyebrow text-spruce">selected</span> : null}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={tosAccepted}
                    onChange={(e) => {
                      setTosAccepted(e.currentTarget.checked);
                      persistDraft({ tosAccepted: e.currentTarget.checked });
                    }}
                    className="mt-1 h-4 w-4 cursor-pointer accent-spruce"
                  />
                  <span className="text-slate-green leading-relaxed">
                    I agree to the{' '}
                    <Link href="/terms" className="link" target="_blank" rel="noopener noreferrer">
                      Terms of Service
                    </Link>{' '}
                    &amp;{' '}
                    <Link href="/privacy" className="link" target="_blank" rel="noopener noreferrer">
                      Privacy Policy
                    </Link>
                    .
                  </span>
                </label>

                {authReady ? (
                  <form action={startGoogleSignIn}>
                    <div className="flex flex-wrap items-center gap-5 pt-2">
                      <button type="button" className="btn-ghost" onClick={() => setPhase('A')}>
                        ← back
                      </button>
                      <button
                        type="submit"
                        className="btn-primary ml-auto"
                        disabled={!tosAccepted}
                        onClick={() => persistDraft({})}
                      >
                        continue with Google →
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-5 pt-2">
                      <button type="button" className="btn-ghost" onClick={() => setPhase('A')}>
                        ← back
                      </button>
                    </div>
                    <p className="meta">
                      development preview — Google sign-in isn&rsquo;t configured here, so an account
                      can&rsquo;t be created and nothing you enter is saved.
                    </p>
                  </>
                )}
              </section>
            ) : null}

            {phase === 'C' ? (
              <section className="rise rise-1 space-y-10 max-w-2xl">
                <p className="text-lg text-slate-green leading-relaxed">
                  You&rsquo;re signed in. Now the exact date of birth so I can tailor
                  precisely{childName ? <> for <span className="text-spruce">{childName}</span></> : null} —
                  this is the first thing that gets saved, encrypted, to your family.
                </p>

                <div className="space-y-6">
                  <div>
                    <label htmlFor="setup-name" className="eyebrow">
                      child&rsquo;s first name
                    </label>
                    <input
                      id="setup-name"
                      type="text"
                      className="field mt-2"
                      value={childName}
                      onChange={(e) => setChildName(e.currentTarget.value)}
                      placeholder="maya"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>

                  <div>
                    <label htmlFor="setup-dob" className="eyebrow">
                      date of birth
                    </label>
                    <input
                      id="setup-dob"
                      type="date"
                      className="field mt-2"
                      value={dateOfBirth}
                      max={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => setDateOfBirth(e.currentTarget.value)}
                      autoComplete="bday"
                    />
                    {dobError ? (
                      <p className="meta text-apricot-deep mt-2" role="alert">
                        {dobError}
                      </p>
                    ) : null}
                  </div>

                  <div>
                    <label htmlFor="setup-area" className="eyebrow">
                      your area <span className="lowercase">(optional)</span>
                    </label>
                    <input
                      id="setup-area"
                      type="text"
                      className="field mt-2"
                      value={areaCoarse}
                      onChange={(e) => setAreaCoarse(e.currentTarget.value)}
                      placeholder="postal area or neighbourhood — e.g. M5V"
                      autoComplete="off"
                    />
                    <p className="meta mt-2">coarse only — for finding local things. never a precise address.</p>
                  </div>
                </div>

                {setupState.kind === 'error' ? (
                  <p className="meta text-apricot-deep" role="alert">
                    {setupState.message}
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-5 pt-2">
                  <button
                    type="button"
                    className="btn-primary ml-auto"
                    onClick={handleFinish}
                    disabled={!canFinish || setupState.kind === 'saving'}
                  >
                    {setupState.kind === 'saving' ? 'finishing…' : 'finish · open my home →'}
                  </button>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}

function isPlanTier(value: string): value is PlanTier {
  return value === 'free' || value === 'plus' || value === 'family';
}

function describeError(error: string): string {
  switch (error) {
    case 'dob_future':
      return "that's in the future — check the year";
    case 'dob_too_old':
      return 'Hale is for children under eighteen';
    case 'dob_invalid':
      return "that date doesn't look right";
    case 'dob_required':
      return 'add a date of birth';
    default:
      return '';
  }
}
