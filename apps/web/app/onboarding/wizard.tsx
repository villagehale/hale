'use client';

import { useEffect, useRef, useState } from 'react';
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
import { ConsentStep } from '~/components/hale/consent-step';
import { GettingReady } from '~/components/hale/getting-ready';
import { HomeAddress } from '~/components/hale/home-address';
import { IntentChips } from '~/components/hale/intent-chips';
import { OnboardingPlanPicker } from '~/components/hale/onboarding-plan-picker';
import { OnboardingShell } from '~/components/hale/onboarding-shell';
import { PrivacyNote } from '~/components/hale/privacy-note';
import { TosAgreement } from '~/components/hale/tos-agreement';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import type { LocationInput } from '~/lib/family/location-input';
import { validateChild } from '~/lib/onboarding/children';
import { completeOnboarding } from '~/lib/onboarding/complete-onboarding';
import { describeCompleteOnboardingError } from '~/lib/onboarding/complete-onboarding-copy';
import {
  type IntakeDraft,
  clearIntakeDraft,
  readIntakeDraft,
  writeIntakeDraft,
} from '~/lib/onboarding/intake-storage';
import { startGoogleSignIn } from '~/lib/onboarding/sign-in-action';

type Phase = 'A' | 'B' | 'C';

/**
 * Phase C runs in three in-place views: the setup form, the "you're in control"
 * consent moment (the finish gate — consent before provisioning), and the
 * "getting things ready" interstitial shown while the first village fills in.
 */
type SetupView = 'form' | 'control' | 'ready';

const PHASE_META: Record<Phase, { folio: string; section: string; title: string }> = {
  A: { folio: '01', section: 'first, the basics', title: "who's your little person?" },
  B: { folio: '02', section: 'save your setup', title: 'create your account' },
  C: { folio: '03', section: 'a little more', title: 'finish setting up' },
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
  // Phase C's in-place view: the setup form → the consent moment → the "getting
  // things ready" interstitial. Advancing to 'ready' only happens after
  // completeOnboarding succeeds (the family + first-village discovery are underway).
  const [setupView, setSetupView] = useState<SetupView>('form');
  // The per-phase heading is the focus anchor on a phase change: advancing from
  // "continue →" unmounts that button, so a keyboard/SR user would otherwise be
  // stranded on a detached element. Moving focus to the new phase's heading lands
  // them at the top of the freshly-rendered step. Skipped on first mount.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const didMountPhase = useRef(false);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: the phase/view change is the intended trigger, not a value read in the body
  useEffect(() => {
    if (!didMountPhase.current) {
      didMountPhase.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [phase, setupView]);

  // The consent view ("you're in control") re-titles the hero for the finish gate;
  // otherwise the phase's own heading.
  const meta =
    phase === 'C' && setupView === 'control'
      ? { folio: '03', section: 'the last thing', title: "you're in control" }
      : PHASE_META[phase];

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

  // The setup form's gate to reach the consent moment: every child named + a valid
  // DOB. Consent (tosAccepted) is the next step, so it is NOT part of this gate —
  // completeOnboarding still requires it, and the consent step supplies it.
  const canContinueSetup = setupChildren.length > 0 && everyChildValid;

  // A plain reason for a disabled continue, so the button is never a silent
  // dead-end.
  const setupBlockedReason = !everyChildValid
    ? "add each child's name and date of birth to continue."
    : '';

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

  // `accepted` carries the consent given on THIS click: the consent step calls
  // setTosAccepted(true) and handleFinish(true) together, but the state update is
  // async, so the submission must read the just-agreed value, not the stale flag.
  async function handleFinish(accepted: boolean = tosAccepted) {
    setSetupState({ kind: 'saving' });
    const result = await completeOnboarding({
      children: setupChildren.map((c) => ({
        name: c.name.trim(),
        lastName: c.lastName.trim(),
        dateOfBirth: c.dateOfBirth,
        gender: c.gender,
      })),
      planTier,
      tosAccepted: accepted,
      parentName: parentName.trim(),
      location,
      intents,
    });
    if (result.status === 'completed') {
      capture('onboarding_completed', { kidCount: setupChildren.length, planTier });
      clearIntakeDraft();
      // Co-parent inviters go straight to the family members page to send the link;
      // everyone else lands on the "getting things ready" moment while the first
      // village fills in, then continues to /home.
      if (inviteCoParent) {
        router.push('/family/members');
        return;
      }
      setSetupState({ kind: 'idle' });
      setSetupView('ready');
      return;
    }
    // Any non-completion returns to the setup form, where the error banner and the
    // finish controls live — the consent view carries neither.
    setSetupView('form');
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
    if (result.status === 'region_unavailable') {
      setSetupState({
        kind: 'error',
        message:
          "Hale isn't available in your region yet — we're expanding beyond Canada soon, and nothing was saved.",
      });
      return;
    }
    if (result.status === 'email_in_use') {
      setSetupState({
        kind: 'error',
        message:
          'This email already has a Hale account. Sign in the way you did before — nothing was saved.',
      });
      return;
    }
    setSetupState({
      kind: 'error',
      message: describeCompleteOnboardingError(result.error),
    });
  }

  // The "getting things ready" moment takes over the whole panel (no hero heading)
  // once the family is provisioned and the first-village discovery is underway.
  if (phase === 'C' && setupView === 'ready') {
    return (
      <OnboardingShell phase={phase} view={setupView}>
        <GettingReady
          area={location.city ?? city}
          onContinue={() => router.push('/home')}
        />
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell phase={phase} view={phase === 'C' ? setupView : 'form'}>
      <div className="space-y-8">
        <div className="onboarding-hero">
          <span className="folio">{meta.folio}</span>
          <p className="meta mt-2">{meta.section}</p>
          <h1 ref={headingRef} tabIndex={-1} className="mt-4 font-display outline-none">
            {meta.title}
          </h1>
        </div>

        <div>
          {phase === 'A' ? (
              <section className="rise rise-1 space-y-10 max-w-2xl">
                <p className="text-lg text-slate-green leading-relaxed">
                  Start with the basics — just enough for me to show you how Hale
                  tailors to your family. Nothing here is saved yet — I never ask for
                  a birthday or anything sensitive at this step.
                </p>

                <div className="space-y-6">
                  <fieldset className="space-y-3">
                    <legend className="eyebrow">their first name</legend>
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
                      anyone else?
                    </button>
                  </fieldset>

                  <div>
                    <label htmlFor="intake-city" className="eyebrow">
                      where should I look for your village?
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
                      legend="what's keeping you busy lately?"
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
                <PrivacyNote />
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

            {phase === 'C' && setupView === 'control' ? (
              <ConsentStep
                saving={setupState.kind === 'saving'}
                onBack={() => setSetupView('form')}
                onAgree={() => {
                  if (!tosAccepted) {
                    setTosAccepted(true);
                    persistDraft({ tosAccepted: true });
                  }
                  void handleFinish(true);
                }}
              />
            ) : null}

            {phase === 'C' && setupView === 'form' ? (
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
                  saved, encrypted, to your family. Hale uses only your neighbourhood for
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

                {/* Consent (the Terms/Privacy agreement) is no longer a checkbox
                    here — it is the "you're in control" step this button leads to,
                    so the agreement is given once, right before provisioning. */}

                {setupState.kind === 'error' ? (
                  <p className="meta text-apricot-deep" role="alert">
                    {setupState.message}
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-5 pt-2">
                  {canContinueSetup ? null : (
                    <p className="meta">{setupBlockedReason}</p>
                  )}
                  <button
                    type="button"
                    className="btn-primary ml-auto"
                    onClick={() => setSetupView('control')}
                    disabled={!canContinueSetup || setupState.kind === 'saving'}
                  >
                    continue →
                  </button>
                </div>
              </section>
            ) : null}
        </div>
      </div>
    </OnboardingShell>
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
            ) : null}
            . You&rsquo;ll pick a plan next, and nothing is charged today.
          </>
        ) : (
          <>
            Create your account with Google to save your setup — I&rsquo;ll use your
            Google name and email, so there&rsquo;s nothing to re-type. You&rsquo;ll pick a
            plan on the last step, and nothing is charged today.
          </>
        )}
      </p>

      {/* No account is created in the signed-in branch — the parent already has
          one — so the Terms/Privacy agreement is given once, at the "you're in
          control" consent step right before provisioning (not here AND there).
          The Google create-account branch keeps the checkbox below as its own
          account-creation gate. */}
      {signedIn ? (
        <div className="flex flex-wrap items-center gap-5 pt-2">
          <button type="button" className="btn-ghost" onClick={onBack}>
            ← back
          </button>
          <button
            type="button"
            className="btn-primary ml-auto"
            onClick={onContinue}
          >
            continue →
          </button>
        </div>
      ) : authReady ? (
        <form action={startGoogleSignIn}>
          <TosAgreement checked={tosAccepted} onChange={onToggleTos} />
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
