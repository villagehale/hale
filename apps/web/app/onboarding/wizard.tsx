'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, X } from 'lucide-react';
import {
  type ChildGender,
  CHILD_GENDERS,
  FAMILY_STAGES,
  type FamilyStage,
  type OnboardingIntent,
  type PlanTier,
  parseIntents,
} from '@hale/types';
import { HomeAddress } from '~/components/hale/home-address';
import { IntentChips } from '~/components/hale/intent-chips';
import { LogoMark } from '~/components/hale/logo-mark';
import { OnboardingPlanPicker } from '~/components/hale/onboarding-plan-picker';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import type { LocationInput } from '~/lib/family/location-input';
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
  A: { folio: '01', section: 'step one of three', title: 'tell me about your kids' },
  B: { folio: '02', section: 'step two of three', title: 'create your account' },
  C: { folio: '03', section: 'step three of three', title: 'finish setting up' },
};

/** A Phase-A name row, keyed by a stable id so add/remove keeps React state aligned. */
interface NameRow {
  id: string;
  name: string;
}

/**
 * A child as the setup phase collects it (post-auth): full name (first + optional
 * last), an optional gender (rule #1: sensitive — asked, never required), and the
 * full DOB, asked once.
 */
interface SetupChild {
  id: string;
  name: string;
  lastName: string;
  dateOfBirth: string;
  gender: ChildGender;
}

let rowSeq = 0;
function nextRowId(): string {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function OnboardingWizard({
  authReady,
  signedIn,
  startAtSetup,
  sessionName,
}: {
  authReady: boolean;
  signedIn: boolean;
  startAtSetup: boolean;
  /** The Google profile name — prefilled into the parent-name confirm field. */
  sessionName: string | null;
}) {
  const router = useRouter();
  const capture = useAnalytics();

  // Returning from the OAuth round-trip with ?step=setup AND a real session lands
  // straight in Phase C; otherwise intake starts at Phase A.
  const initialPhase: Phase = startAtSetup && signedIn ? 'C' : 'A';
  const [phase, setPhase] = useState<Phase>(initialPhase);

  // Phase A — non-sensitive: first names only (no dates of birth), a coarse city,
  // and the optional intents (what the parent is hoping for). These survive the
  // OAuth redirect via sessionStorage.
  const [nameRows, setNameRows] = useState<NameRow[]>([{ id: nextRowId(), name: '' }]);
  const [city, setCity] = useState('');
  const [intents, setIntents] = useState<OnboardingIntent[]>([]);
  const [planTier, setPlanTier] = useState<PlanTier>('free');
  const [tosAccepted, setTosAccepted] = useState(false);

  // Phase C inputs — the first point sensitive data is collected (rule #1): the
  // parent's confirmed name, each child's full DOB (asked once), and the full
  // structured location.
  const [parentName, setParentName] = useState('');
  const [setupChildren, setSetupChildren] = useState<SetupChild[]>([
    { id: nextRowId(), name: '', lastName: '', dateOfBirth: '', gender: 'unspecified' },
  ]);
  const [location, setLocation] = useState<LocationInput>({ country: 'Canada' });
  const [inviteCoParent, setInviteCoParent] = useState(false);
  // A coarse stage hint carried from the pre-auth preview (an age RANGE, never a
  // DOB). Surfaced as an honest note in Phase C; the real DOB is still required
  // and consented here (rule #1).
  const [stageHint, setStageHint] = useState<FamilyStage | null>(null);

  // On mount, hydrate from the sessionStorage draft so Phase A survives the OAuth
  // redirect and seeds Phase C's child names + city. The parent name prefills from
  // the live Google session, never from the (non-sensitive) draft.
  useEffect(() => {
    if (sessionName) {
      setParentName(sessionName);
    }
    const draft = readIntakeDraft();
    if (!draft) {
      return;
    }
    const names = draft.childNames.length > 0 ? draft.childNames : [''];
    setNameRows(names.map((name) => ({ id: nextRowId(), name })));
    setCity(draft.city);
    setLocation((prev) => ({ ...prev, city: draft.city || prev.city }));
    setIntents(parseIntents(draft.intents ?? []));
    setPlanTier(isPlanTier(draft.planTier) ? draft.planTier : 'free');
    setTosAccepted(draft.tosAccepted);
    setStageHint(isFamilyStage(draft.stage) ? draft.stage : null);
    const seeded = names
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .map((name) => ({
        id: nextRowId(),
        name,
        lastName: '',
        dateOfBirth: '',
        gender: 'unspecified' as const,
      }));
    if (seeded.length > 0) {
      setSetupChildren(seeded);
    }
  }, [sessionName]);

  const meta = PHASE_META[phase];
  const phaseIndex = phase === 'A' ? 1 : phase === 'B' ? 2 : 3;

  const namedChildren = nameRows.map((r) => r.name.trim()).filter((n) => n.length > 0);
  const phaseAComplete = namedChildren.length > 0;

  function persistDraft(patch: Partial<IntakeDraft>) {
    const next: IntakeDraft = {
      childNames: nameRows.map((r) => r.name),
      city,
      intents,
      planTier,
      tosAccepted,
      stage: stageHint ?? undefined,
      ...patch,
    };
    writeIntakeDraft(next);
  }

  function goToPhaseB() {
    persistDraft({});
    setPhase('B');
  }

  const [setupState, setSetupState] = useState<
    { kind: 'idle' } | { kind: 'saving' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const childValidations = setupChildren.map((child) =>
    child.dateOfBirth ? validateChild({ name: child.name || 'x', dateOfBirth: child.dateOfBirth }) : null,
  );

  const everyChildValid = setupChildren.every(
    (child, i) =>
      child.name.trim().length > 0 &&
      /^\d{4}-\d{2}-\d{2}$/.test(child.dateOfBirth) &&
      childValidations[i]?.ok === true,
  );

  const canFinish = setupChildren.length > 0 && everyChildValid && tosAccepted;

  function updateSetupChild(id: string, patch: Partial<SetupChild>) {
    setSetupChildren((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function toggleIntent(value: OnboardingIntent) {
    const next = intents.includes(value)
      ? intents.filter((v) => v !== value)
      : [...intents, value];
    setIntents(next);
    persistDraft({ intents: next });
  }

  async function handleFinish() {
    setSetupState({ kind: 'saving' });
    const result = await completeOnboarding({
      children: setupChildren.map((c) => ({
        name: c.name.trim(),
        lastName: c.lastName.trim(),
        dateOfBirth: c.dateOfBirth,
        gender: c.gender,
      })),
      planTier,
      tosAccepted,
      parentName: parentName.trim(),
      location,
      intents,
    });
    if (result.status === 'completed') {
      capture('onboarding_completed', { kidCount: setupChildren.length, planTier });
      clearIntakeDraft();
      router.push(inviteCoParent ? '/family' : '/home');
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
    <div className="min-h-[100dvh] bg-linen">
      <header className="shell flex items-center justify-between pt-6 pb-4 border-b border-rule">
        <Link href="/" className="flex items-center gap-3">
          <LogoMark size={32} />
          <span className="font-display text-2xl font-semibold leading-none">Hale</span>
        </Link>

        <div className="flex items-center gap-3">
          <span className="eyebrow hidden sm:inline">enrolment</span>
          <div className="hidden sm:flex items-center gap-1.5" aria-hidden>
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
                  tailors to your family. Nothing here is saved yet — I never ask for
                  a birthday or anything sensitive at this step.
                </p>

                <div className="space-y-6">
                  <fieldset className="space-y-3">
                    <legend className="eyebrow">your kids&rsquo; first names</legend>
                    {nameRows.map((row, index) => (
                      <div key={row.id} className="flex items-center gap-3">
                        <input
                          type="text"
                          className="field"
                          value={row.name}
                          onChange={(e) => {
                            const next = nameRows.map((r) =>
                              r.id === row.id ? { ...r, name: e.currentTarget.value } : r,
                            );
                            setNameRows(next);
                            persistDraft({ childNames: next.map((r) => r.name) });
                          }}
                          placeholder="maya"
                          aria-label={`child ${index + 1} first name`}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        {nameRows.length > 1 ? (
                          <button
                            type="button"
                            className="link meta inline-flex items-center gap-1.5 shrink-0"
                            onClick={() => {
                              const next = nameRows.filter((r) => r.id !== row.id);
                              setNameRows(next);
                              persistDraft({ childNames: next.map((r) => r.name) });
                            }}
                          >
                            <X size={14} strokeWidth={2} aria-hidden="true" />
                            <span className="sr-only">remove child {index + 1}</span>
                            remove
                          </button>
                        ) : null}
                      </div>
                    ))}
                    <button
                      type="button"
                      className="link meta inline-flex items-center gap-1.5"
                      onClick={() => {
                        const next = [...nameRows, { id: nextRowId(), name: '' }];
                        setNameRows(next);
                        persistDraft({ childNames: next.map((r) => r.name) });
                      }}
                    >
                      <Plus size={14} strokeWidth={2} aria-hidden="true" />
                      add another child
                    </button>
                  </fieldset>

                  <div>
                    <label htmlFor="intake-city" className="eyebrow">
                      your city
                    </label>
                    <input
                      id="intake-city"
                      type="text"
                      className="field mt-2"
                      value={city}
                      onChange={(e) => {
                        setCity(e.currentTarget.value);
                        persistDraft({ city: e.currentTarget.value });
                      }}
                      placeholder="Toronto"
                      autoComplete="off"
                    />
                    <p className="meta mt-2">
                      just the city for now — it helps me find local things. the rest of
                      your location comes later, after you sign in.
                    </p>
                  </div>

                  <div>
                    <IntentChips
                      legend="what are you hoping Hale can help with?"
                      selected={intents}
                      onToggle={toggleIntent}
                    />
                    <p className="meta mt-2">optional — pick any that fit, or skip for now.</p>
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
              <AccountStep
                authReady={authReady}
                signedIn={signedIn}
                sessionName={sessionName}
                tosAccepted={tosAccepted}
                onToggleTos={(checked) => {
                  setTosAccepted(checked);
                  persistDraft({ tosAccepted: checked });
                }}
                onBack={() => setPhase('A')}
                onContinue={() => {
                  persistDraft({});
                  setPhase('C');
                }}
                onGoogle={() => {
                  capture('sign_up');
                  capture('signup_completed', { method: 'google' });
                  persistDraft({});
                }}
              />
            ) : null}

            {phase === 'C' ? (
              <section className="rise rise-1 space-y-10 max-w-2xl">
                <p className="text-lg text-slate-green leading-relaxed">
                  You&rsquo;re signed in
                  {parentName ? (
                    <>
                      , <span className="text-spruce">{parentName.split(/\s+/)[0]}</span>
                    </>
                  ) : null}
                  . Now each child&rsquo;s details and your home address, so I can tailor
                  precisely and find things nearby — this is the first thing that gets
                  saved, encrypted, to your family. I keep only the coarse area for
                  discovery; the full address stays private for booking.
                </p>

                <div className="space-y-6">
                  <div>
                    <label htmlFor="setup-parent-name" className="eyebrow">
                      your name
                    </label>
                    <input
                      id="setup-parent-name"
                      type="text"
                      className="field mt-2"
                      value={parentName}
                      onChange={(e) => setParentName(e.currentTarget.value)}
                      placeholder="your name"
                      autoComplete="name"
                    />
                    <p className="meta mt-2">how you&rsquo;ll appear to your family — edit anytime.</p>
                  </div>
                </div>

                <fieldset className="space-y-6">
                  <legend className="eyebrow text-spruce">your kids</legend>
                  {stageHint ? (
                    <p className="meta">
                      from your preview, you&rsquo;re looking for {STAGE_WORD[stageHint]} — add
                      their birthday below so I can tailor precisely.
                    </p>
                  ) : null}
                  {setupChildren.map((child, index) => {
                    const validation = childValidations[index];
                    const dobError =
                      validation && !validation.ok ? describeError(validation.error) : null;
                    return (
                      <div key={child.id} className="space-y-4 border-l border-rule-strong pl-5">
                        <div className="flex items-baseline justify-between">
                          <span className="meta">child {index + 1}</span>
                          {setupChildren.length > 1 ? (
                            <button
                              type="button"
                              className="link meta inline-flex items-center gap-1.5"
                              onClick={() =>
                                setSetupChildren((prev) => prev.filter((c) => c.id !== child.id))
                              }
                            >
                              <X size={14} strokeWidth={2} aria-hidden="true" />
                              remove
                            </button>
                          ) : null}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                          <div>
                            <label htmlFor={`setup-name-${child.id}`} className="eyebrow">
                              first name
                            </label>
                            <input
                              id={`setup-name-${child.id}`}
                              type="text"
                              className="field mt-2"
                              value={child.name}
                              onChange={(e) =>
                                updateSetupChild(child.id, { name: e.currentTarget.value })
                              }
                              placeholder="maya"
                              autoComplete="off"
                              spellCheck={false}
                            />
                          </div>
                          <div>
                            <label htmlFor={`setup-lastname-${child.id}`} className="eyebrow">
                              last name <span className="text-faded-sage">(optional)</span>
                            </label>
                            <input
                              id={`setup-lastname-${child.id}`}
                              type="text"
                              className="field mt-2"
                              value={child.lastName}
                              onChange={(e) =>
                                updateSetupChild(child.id, { lastName: e.currentTarget.value })
                              }
                              placeholder="ramos"
                              autoComplete="off"
                              spellCheck={false}
                            />
                          </div>
                          <div>
                            <label htmlFor={`setup-dob-${child.id}`} className="eyebrow">
                              date of birth
                            </label>
                            <input
                              id={`setup-dob-${child.id}`}
                              type="date"
                              className="field mt-2"
                              value={child.dateOfBirth}
                              max={today()}
                              onChange={(e) =>
                                updateSetupChild(child.id, { dateOfBirth: e.currentTarget.value })
                              }
                              autoComplete="bday"
                            />
                          </div>
                          <div>
                            <label htmlFor={`setup-gender-${child.id}`} className="eyebrow">
                              gender <span className="text-faded-sage">(optional)</span>
                            </label>
                            <select
                              id={`setup-gender-${child.id}`}
                              className="field mt-2"
                              value={child.gender}
                              onChange={(e) =>
                                updateSetupChild(child.id, {
                                  gender: e.currentTarget.value as ChildGender,
                                })
                              }
                            >
                              {CHILD_GENDERS.map((g) => (
                                <option key={g.value} value={g.value}>
                                  {g.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                        {dobError ? (
                          <p className="meta text-apricot-deep" role="alert">
                            {dobError}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className="link meta inline-flex items-center gap-1.5"
                    onClick={() =>
                      setSetupChildren((prev) => [
                        ...prev,
                        {
                          id: nextRowId(),
                          name: '',
                          lastName: '',
                          dateOfBirth: '',
                          gender: 'unspecified',
                        },
                      ])
                    }
                  >
                    <Plus size={14} strokeWidth={2} aria-hidden="true" />
                    add another child
                  </button>
                </fieldset>

                <fieldset className="space-y-5">
                  <legend className="eyebrow text-spruce">your home address</legend>
                  <HomeAddress value={location} onChange={setLocation} />
                </fieldset>

                <OnboardingPlanPicker
                  selected={planTier}
                  onSelect={(tier) => {
                    setPlanTier(tier);
                    persistDraft({ planTier: tier });
                  }}
                />

                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={inviteCoParent}
                    onChange={(e) => setInviteCoParent(e.currentTarget.checked)}
                    className="mt-1 h-4 w-4 cursor-pointer accent-spruce"
                  />
                  <span className="text-slate-green leading-relaxed">
                    I&rsquo;d like to invite my co-parent — take me to my family page to
                    send the link after I finish.
                  </span>
                </label>

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
                    {setupState.kind === 'saving'
                      ? 'finishing…'
                      : inviteCoParent
                        ? 'finish · invite co-parent →'
                        : 'finish · open my home →'}
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

/**
 * Phase B — the account step. Session-aware because the funnel now signs users in
 * BEFORE onboarding (preview → /sign-in → /onboarding): an already-authenticated
 * parent (email/password OR Google) just agrees to the terms and continues; only
 * a signed-out visitor sees the Google account-creation form (or the dev-preview
 * note when auth isn't configured).
 */
export function AccountStep({
  authReady,
  signedIn,
  sessionName,
  tosAccepted,
  onToggleTos,
  onBack,
  onContinue,
  onGoogle,
}: {
  authReady: boolean;
  signedIn: boolean;
  sessionName: string | null;
  tosAccepted: boolean;
  onToggleTos: (checked: boolean) => void;
  onBack: () => void;
  onContinue: () => void;
  onGoogle: () => void;
}) {
  return (
    <section className="rise rise-1 space-y-10 max-w-2xl">
      <p className="text-lg text-slate-green leading-relaxed">
        {signedIn ? (
          <>
            You&rsquo;re signed in
            {sessionName ? (
              <>
                {' '}
                as <span className="text-spruce">{sessionName}</span>
              </>
            ) : null}{' '}
            — just agree to the terms to continue. You&rsquo;ll pick a plan next, and
            nothing is charged today.
          </>
        ) : (
          <>
            Create your account with Google to save your setup — I&rsquo;ll use your
            Google name and email, so there&rsquo;s nothing to re-type. You&rsquo;ll pick a
            plan on the last step, and nothing is charged today.
          </>
        )}
      </p>

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={tosAccepted}
          onChange={(e) => onToggleTos(e.currentTarget.checked)}
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

      {signedIn ? (
        <div className="flex flex-wrap items-center gap-5 pt-2">
          <button type="button" className="btn-ghost" onClick={onBack}>
            ← back
          </button>
          <button
            type="button"
            className="btn-primary ml-auto"
            disabled={!tosAccepted}
            onClick={onContinue}
          >
            continue →
          </button>
        </div>
      ) : authReady ? (
        <form action={startGoogleSignIn}>
          <div className="flex flex-wrap items-center gap-5 pt-2">
            <button type="button" className="btn-ghost" onClick={onBack}>
              ← back
            </button>
            <button
              type="submit"
              className="btn-primary ml-auto"
              disabled={!tosAccepted}
              onClick={onGoogle}
            >
              continue with Google →
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-5 pt-2">
            <button type="button" className="btn-ghost" onClick={onBack}>
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
  );
}

function isPlanTier(value: string): value is PlanTier {
  return value === 'free' || value === 'plus' || value === 'family';
}

function isFamilyStage(value: string | undefined): value is FamilyStage {
  return value !== undefined && (FAMILY_STAGES as readonly string[]).includes(value);
}

/** The plain stage word for the preview hint note (no age range — the real DOB
 * is collected below, so the note never asserts an age). */
const STAGE_WORD: Record<FamilyStage, string> = {
  newborn: 'a newborn',
  toddler: 'a toddler',
  child: 'a child',
  teenager: 'a teenager',
};

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
