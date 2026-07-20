'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Ban, Check, MapPin, Plus, ShieldCheck, Sun, X } from 'lucide-react';
import {
  type ChildGender,
  CHILD_GENDERS,
  type OnboardingIntent,
  parseIntents,
} from '@hale/types';
import { GettingReadyChecklist } from '~/components/hale/getting-ready-checklist';
import { IntentChips } from '~/components/hale/intent-chips';
import { LogoMark } from '~/components/hale/logo-mark';
import { MagicLinkRequestForm } from '~/components/hale/magic-link-request-form';
import { OnboardingConnect } from '~/components/hale/onboarding-connect';
import { OnboardingShell } from '~/components/hale/onboarding-shell';
import { PrivacyNote } from '~/components/hale/privacy-note';
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
import { FIRST_POST_AUTH_STEP, clampStep } from '~/lib/onboarding/steps';

/**
 * The 9-step onboarding wizard (design handoff §4.1). A linear step machine on
 * the warm canvas, split by the auth boundary (privacy hard rule #1):
 *
 *   STEPS 1–6 run PRE-AUTH on the public /onboarding route. They collect only
 *   NON-sensitive intake — a child's FIRST NAME, a coarse area, and the optional
 *   "what matters" intents — which is stashed in sessionStorage so it survives the
 *   auth hop (the /preview precedent). A child's DATE OF BIRTH is sensitive and is
 *   NEVER collected pre-auth or written to browser storage.
 *
 *   STEP 6 is the auth hop itself (Continue with Google / magic-link email; NO
 *   password, NO Apple on web). Both providers land back on /onboarding signed in;
 *   the wizard then resumes at STEP 7.
 *
 *   STEPS 7–9 run POST-AUTH. Step 7 first collects the sensitive detail the design
 *   places at step 3 — each child's birthday — behind the account wall (rule #1),
 *   then runs completeOnboarding (the real mutation: family + children rows,
 *   coarse location, intents, consent, first-village discovery) and plays the
 *   getting-ready checklist. Step 8 connects Google apps (real OAuth). Step 9 is
 *   the ready splash into the app.
 *
 * Step ↔ old-flow mapping (see the PR body): the old Phase A intake → steps 3–5;
 * the old Phase B account → step 6; the old Phase C setup form → step 7's detail
 * gate; the old consent step → the "by continuing you agree" affirmation at the
 * step-7 submit (consent still recorded at provisioning, rule #6). The old plan
 * picker is dropped (free-first launch; no plan step in the design — upgrades live
 * in Settings).
 */

/** A child as onboarding collects it: first name (pre-auth) + the sensitive fields
 * (DOB, optional last name / gender) collected only at step 7, post-auth (rule #1). */
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
  return `child-${rowSeq}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyChild(name = ''): SetupChild {
  return { id: nextRowId(), name, lastName: '', dateOfBirth: '', gender: 'unspecified' };
}

export function OnboardingWizard({
  authReady,
  google,
  magicLink,
  signedIn,
  sessionName,
}: {
  /** auth configured at all (else the auth step shows an honest dev-preview note). */
  authReady: boolean;
  /** Google provider available — gates the "Continue with Google" button. */
  google: boolean;
  /** Magic-link (passwordless email) available — gates the email field. */
  magicLink: boolean;
  /** True once the parent has returned from the auth hop — resumes at step 7. */
  signedIn: boolean;
  /** The Google profile name, confirmed as the parent's display name at provisioning. */
  sessionName: string | null;
}) {
  const router = useRouter();
  const capture = useAnalytics();

  // A signed-in visitor with no family has passed the auth hop (or resumed a
  // half-finished setup): jump straight to the first post-auth step.
  const [step, setStep] = useState<number>(signedIn ? FIRST_POST_AUTH_STEP : 1);

  const [children, setChildren] = useState<SetupChild[]>([emptyChild()]);
  const [area, setArea] = useState('');
  const [intents, setIntents] = useState<OnboardingIntent[]>([]);

  // Step 7's two views: the private-detail form, then the animated getting-ready
  // checklist once completeOnboarding has succeeded.
  const [readyView, setReadyView] = useState<'form' | 'ready'>('form');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const didMount = useRef(false);

  // Hydrate the pre-auth draft on mount so step 7 (post-auth) pre-fills the child
  // names + area the parent gave before signing in. The draft is tab-scoped, so a
  // magic link opened on another device simply arrives empty — the step-7 form is
  // self-sufficient (name + birthday + area), so nothing is lost, only re-typed.
  useEffect(() => {
    const draft = readIntakeDraft();
    if (!draft) {
      return;
    }
    const names = draft.childNames.map((n) => n.trim()).filter((n) => n.length > 0);
    if (names.length > 0) {
      setChildren(names.map((n) => emptyChild(n)));
    }
    setArea(draft.city);
    setIntents(parseIntents(draft.intents ?? []));
  }, []);

  // Move focus to the new step's heading on every step change (the advancing
  // button unmounts), so a keyboard / SR user lands at the top of the fresh step.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the step change is the intended trigger
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [step, readyView]);

  function persistDraft(patch: Partial<IntakeDraft>): void {
    const next: IntakeDraft = {
      childNames: children.map((c) => c.name),
      city: area,
      intents,
      planTier: 'free',
      tosAccepted: false,
      ...patch,
    };
    writeIntakeDraft(next);
  }

  function go(next: number): void {
    setStep(clampStep(next));
  }

  const namedChildren = children.filter((c) => c.name.trim().length > 0);
  const firstName = namedChildren[0]?.name.trim() ?? 'your little one';

  function toggleIntent(value: OnboardingIntent): void {
    const next = intents.includes(value)
      ? intents.filter((v) => v !== value)
      : [...intents, value];
    setIntents(next);
    persistDraft({ intents: next });
  }

  function updateChild(id: string, patch: Partial<SetupChild>): void {
    setChildren((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  // Persist the intake + record consent-on-continue, then hand off to the auth
  // provider. The "by continuing you agree" line at step 6 makes this the consent
  // moment; the tos flag is re-affirmed at the step-7 submit that provisions, so a
  // cross-device magic link (empty draft) is still covered.
  function persistBeforeAuth(): void {
    persistDraft({ tosAccepted: true });
  }

  // Step-7 detail validation: every child needs a name and a valid DOB before we
  // can provision. Consent is affirmed by the submit itself (see below).
  const childValidations = children.map((c) =>
    c.dateOfBirth ? validateChild({ name: c.name || 'x', dateOfBirth: c.dateOfBirth }) : null,
  );
  const everyChildValid = children.every(
    (c, i) =>
      c.name.trim().length > 0 &&
      /^\d{4}-\d{2}-\d{2}$/.test(c.dateOfBirth) &&
      childValidations[i]?.ok === true,
  );
  const canProvision = children.length > 0 && everyChildValid && !saving;

  async function provision(): Promise<void> {
    setSaving(true);
    setError(null);
    const result = await completeOnboarding({
      children: children.map((c) => ({
        name: c.name.trim(),
        lastName: c.lastName.trim(),
        dateOfBirth: c.dateOfBirth,
        gender: c.gender,
      })),
      planTier: 'free',
      // The submit under "by continuing you agree to our Terms and Privacy Policy"
      // IS the consent; completeOnboarding records it (audit + consent rows, rule #6).
      tosAccepted: true,
      parentName: sessionName ?? undefined,
      location: buildLocation(area),
      intents,
    });
    setSaving(false);

    if (result.status === 'completed') {
      capture('onboarding_completed', { kidCount: children.length, planTier: 'free' });
      clearIntakeDraft();
      setReadyView('ready');
      return;
    }
    if (result.status === 'preview') {
      setError("development preview — sign-in isn't configured here, so nothing was saved.");
      return;
    }
    if (result.status === 'region_unavailable') {
      setError(
        "Hale isn't available in your region yet — we're expanding beyond Canada soon, and nothing was saved.",
      );
      return;
    }
    if (result.status === 'email_in_use') {
      setError(
        'This email already has a Hale account. Sign in the way you did before — nothing was saved.',
      );
      return;
    }
    setError(describeCompleteOnboardingError(result.error));
  }

  const canBack = step >= 2 && step <= 6;
  const canSkip = step >= 1 && step <= 5;

  return (
    <OnboardingShell
      step={step}
      onBack={canBack ? () => go(step - 1) : undefined}
      onSkip={canSkip ? () => go(6) : undefined}
    >
      {step === 1 ? <StepWelcome headingRef={headingRef} onNext={() => go(2)} /> : null}

      {step === 2 ? <StepTomorrow headingRef={headingRef} onNext={() => go(3)} /> : null}

      {step === 3 ? (
        <StepChildren
          headingRef={headingRef}
          kids={children}
          onName={(id, name) => {
            updateChild(id, { name });
            persistDraft({ childNames: children.map((c) => (c.id === id ? name : c.name)) });
          }}
          onAdd={() => {
            const next = [...children, emptyChild()];
            setChildren(next);
            persistDraft({ childNames: next.map((c) => c.name) });
          }}
          onRemove={(id) => {
            const next = children.filter((c) => c.id !== id);
            setChildren(next);
            persistDraft({ childNames: next.map((c) => c.name) });
          }}
          onNext={() => {
            persistDraft({});
            go(4);
          }}
        />
      ) : null}

      {step === 4 ? (
        <StepLocation
          headingRef={headingRef}
          area={area}
          onArea={(value) => {
            setArea(value);
            persistDraft({ city: value });
          }}
          onNext={() => {
            persistDraft({});
            go(5);
          }}
        />
      ) : null}

      {step === 5 ? (
        <StepMatters
          headingRef={headingRef}
          childName={firstName}
          intents={intents}
          onToggle={toggleIntent}
          onNext={() => {
            persistDraft({});
            go(6);
          }}
        />
      ) : null}

      {step === 6 ? (
        <StepAuth
          headingRef={headingRef}
          authReady={authReady}
          google={google}
          magicLink={magicLink}
          onGoogle={() => {
            capture('sign_up');
            capture('signup_completed', { method: 'google' });
            persistBeforeAuth();
          }}
          onMagicLink={() => {
            capture('sign_up');
            capture('signup_completed', { method: 'magic_link' });
            persistBeforeAuth();
          }}
        />
      ) : null}

      {step === 7 && readyView === 'form' ? (
        <StepDetails
          headingRef={headingRef}
          kids={children}
          childValidations={childValidations}
          area={area}
          onArea={setArea}
          onChild={updateChild}
          onAdd={() => setChildren((prev) => [...prev, emptyChild()])}
          onRemove={(id) => setChildren((prev) => prev.filter((c) => c.id !== id))}
          canProvision={canProvision}
          saving={saving}
          error={error}
          onSubmit={() => void provision()}
        />
      ) : null}

      {step === 7 && readyView === 'ready' ? (
        <GettingReadyChecklist onDone={() => go(8)} />
      ) : null}

      {step === 8 ? (
        <StepConnect headingRef={headingRef} onNext={() => go(9)} />
      ) : null}

      {step === 9 ? (
        <StepDone
          headingRef={headingRef}
          childName={firstName}
          onEnter={() => router.push('/home')}
        />
      ) : null}
    </OnboardingShell>
  );
}

/** Coarse location for provisioning (rule #1): the country + the area the parent gave.
 * The onboarding form collects only a free-text area (no country field), so there is
 * no user-supplied country to read — country is the CONSTRAINT constant `Canada`, the
 * only compliance-cleared onboarding region (hard rule #1), enforced upstream by
 * `isOnboardingRegionSupported` (which rejects an explicit non-Canadian country from
 * the Google-Places path). Broadening is a deliberate per-market program, never
 * inferred from the area string. normalizeLocation derives the coarse discovery key;
 * no precise address is stored. */
function buildLocation(area: string): LocationInput {
  const city = area.trim();
  return { country: 'Canada', city: city.length > 0 ? city : undefined };
}

type HeadingRef = React.RefObject<HTMLHeadingElement | null>;

function Bubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="ob-bubble">
      <LogoMark size={30} className="ob-bubble-avatar" />
      <p>{children}</p>
    </div>
  );
}

function StepWelcome({ headingRef, onNext }: { headingRef: HeadingRef; onNext: () => void }) {
  return (
    <section className="ob-step flex flex-col items-center text-center gap-6">
      <LogoMark size={96} className="shadow-[0_14px_32px_rgba(27,33,96,0.25)]" />
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="font-display text-[2.4rem] font-medium leading-tight outline-none"
      >
        Hi 👋 — I&rsquo;m Hale.
      </h1>
      <p className="text-lg text-slate-green leading-relaxed max-w-md">
        I&rsquo;ll quietly help your family, every day. Let&rsquo;s get to know each other.
      </p>
      <button type="button" className="btn-primary mt-2" onClick={onNext}>
        Let&rsquo;s begin
        <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
      </button>
    </section>
  );
}

const TOMORROW: readonly { title: string; note: string }[] = [
  { title: 'Vaccine reminder', note: 'Due in 2 days' },
  { title: 'Storytime nearby', note: '10 min from you' },
  { title: 'Draft daycare email', note: 'Ready to review' },
  { title: 'Weekly family plan', note: 'All in one place' },
];

const FEATURES: readonly { title: string; note: string }[] = [
  { title: 'Health & vaccines', note: 'On the Canadian schedule' },
  { title: 'Milestones', note: 'Tracked gently, together' },
  { title: 'Routines & memories', note: 'Logged in seconds' },
];

function StepTomorrow({ headingRef, onNext }: { headingRef: HeadingRef; onNext: () => void }) {
  return (
    <section className="ob-step space-y-7">
      <Bubble>
        Parenting was never meant to be done alone. Here&rsquo;s the kind of thing I&rsquo;ll
        quietly have ready for you tomorrow.
      </Bubble>

      <div className="card">
        <p className="eyebrow">Tomorrow</p>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {TOMORROW.map((item) => (
            <div key={item.title} className="rounded-[var(--r-sm)] bg-tile p-4">
              <p className="font-semibold text-spruce">{item.title}</p>
              <p className="meta mt-0.5">{item.note}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-[var(--r-sm)] border border-rule p-4">
            <p className="font-semibold text-spruce text-sm">{f.title}</p>
            <p className="meta mt-1">{f.note}</p>
          </div>
        ))}
      </div>

      <h1 ref={headingRef} tabIndex={-1} className="sr-only outline-none">
        Here&rsquo;s tomorrow
      </h1>
      <div className="flex justify-end pt-1">
        <button type="button" className="btn-primary" onClick={onNext}>
          Continue
          <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function StepChildren({
  headingRef,
  kids,
  onName,
  onAdd,
  onRemove,
  onNext,
}: {
  headingRef: HeadingRef;
  kids: SetupChild[];
  onName: (id: string, name: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onNext: () => void;
}) {
  const canContinue = kids.some((c) => c.name.trim().length > 0);
  return (
    <section className="ob-step space-y-7">
      <Bubble>Who&rsquo;s your first little person?</Bubble>
      <p className="meta">You can add more later. I&rsquo;ll ask their birthday privately after you sign in.</p>

      <div className="card space-y-4">
        <fieldset className="space-y-3">
          <legend className="eyebrow">First name</legend>
          {kids.map((child, index) => (
            <div key={child.id} className="flex items-center gap-3">
              <input
                type="text"
                className="field"
                value={child.name}
                onChange={(e) => onName(child.id, e.currentTarget.value)}
                placeholder="e.g. Sebastian"
                aria-label={`child ${index + 1} first name`}
                autoComplete="off"
                spellCheck={false}
              />
              {kids.length > 1 ? (
                <button
                  type="button"
                  className="link meta inline-flex items-center gap-1.5 shrink-0"
                  onClick={() => onRemove(child.id)}
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
            onClick={onAdd}
          >
            <Plus size={14} strokeWidth={2} aria-hidden="true" />
            Add child
          </button>
        </fieldset>
      </div>

      <h1 ref={headingRef} tabIndex={-1} className="sr-only outline-none">
        Your children
      </h1>
      <div className="flex justify-end pt-1">
        <button type="button" className="btn-primary" onClick={onNext} disabled={!canContinue}>
          {canContinue ? "That's everyone — continue" : 'Continue'}
          <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function StepLocation({
  headingRef,
  area,
  onArea,
  onNext,
}: {
  headingRef: HeadingRef;
  area: string;
  onArea: (value: string) => void;
  onNext: () => void;
}) {
  return (
    <section className="ob-step space-y-7">
      <Bubble>Where should I look for your village?</Bubble>

      <div className="card space-y-4">
        <div className="relative overflow-hidden rounded-[var(--r-sm)] bg-tile" style={{ height: 230 }}>
          <Image
            src="/village-illustration.png"
            alt=""
            aria-hidden="true"
            fill
            sizes="620px"
            className="object-contain p-4"
          />
        </div>
        <div>
          <label htmlFor="ob-area" className="eyebrow">
            Search city or area
          </label>
          <input
            id="ob-area"
            type="text"
            className="field mt-2"
            value={area}
            onChange={(e) => onArea(e.currentTarget.value)}
            placeholder="Toronto, or a postal prefix like M5V"
            autoComplete="off"
          />
          <p className="meta mt-2">
            <MapPin size={13} strokeWidth={2} aria-hidden="true" className="inline -translate-y-px" />{' '}
            We never store your exact address.
          </p>
        </div>
      </div>

      <h1 ref={headingRef} tabIndex={-1} className="sr-only outline-none">
        Your village area
      </h1>
      <div className="flex justify-end pt-1">
        <button type="button" className="btn-primary" onClick={onNext}>
          Continue
          <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function StepMatters({
  headingRef,
  childName,
  intents,
  onToggle,
  onNext,
}: {
  headingRef: HeadingRef;
  childName: string;
  intents: OnboardingIntent[];
  onToggle: (value: OnboardingIntent) => void;
  onNext: () => void;
}) {
  return (
    <section className="ob-step space-y-7">
      <Bubble>What&rsquo;s on your plate with {childName} lately?</Bubble>
      <p className="meta">Pick any that fit — Hale will tune its help.</p>

      <IntentChips legend="What matters right now" selected={intents} onToggle={onToggle} />

      <h1 ref={headingRef} tabIndex={-1} className="sr-only outline-none">
        What matters
      </h1>
      <div className="flex justify-end pt-1">
        <button type="button" className="btn-primary" onClick={onNext}>
          Continue
          <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

const TRUST: readonly { icon: typeof ShieldCheck; label: string }[] = [
  { icon: ShieldCheck, label: 'Every action requires approval' },
  { icon: Ban, label: 'Your data is never sold' },
  { icon: X, label: 'Disconnect anytime' },
];

function StepAuth({
  headingRef,
  authReady,
  google,
  magicLink,
  onGoogle,
  onMagicLink,
}: {
  headingRef: HeadingRef;
  authReady: boolean;
  google: boolean;
  magicLink: boolean;
  onGoogle: () => void;
  onMagicLink: () => void;
}) {
  return (
    <section className="ob-step flex flex-col items-center text-center gap-6">
      <span
        className="inline-flex h-14 w-14 items-center justify-center rounded-full"
        style={{ background: 'var(--color-amber-tint)' }}
        aria-hidden="true"
      >
        <Sun size={26} strokeWidth={2} style={{ color: 'var(--color-amber)' }} />
      </span>
      <div className="space-y-1">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-[1.9rem] font-medium leading-tight outline-none"
        >
          I&rsquo;ve prepared your village.
        </h1>
        <p className="text-lg text-slate-green">Let&rsquo;s save it.</p>
      </div>

      <div className="w-full max-w-sm space-y-4 text-left">
        {!authReady ? (
          <p className="meta text-center">
            development preview — sign-in isn&rsquo;t configured here, so an account can&rsquo;t be
            created and nothing you enter is saved.
          </p>
        ) : (
          <>
            {google ? (
              <form action={startGoogleSignIn}>
                <button type="submit" className="btn-primary w-full justify-center" onClick={onGoogle}>
                  Continue with Google
                </button>
              </form>
            ) : null}

            {google && magicLink ? (
              <div className="flex items-center gap-3">
                <span className="h-px flex-1 bg-rule" />
                <span className="meta">or</span>
                <span className="h-px flex-1 bg-rule" />
              </div>
            ) : null}

            {magicLink ? <MagicLinkRequestForm onSent={onMagicLink} /> : null}
          </>
        )}
      </div>

      <ul className="w-full max-w-sm space-y-2.5 text-left">
        {TRUST.map(({ icon: Icon, label }) => (
          <li key={label} className="flex items-center gap-2.5 text-sm text-slate-green">
            <Icon size={16} strokeWidth={2} aria-hidden="true" className="shrink-0 text-sage" />
            {label}
          </li>
        ))}
      </ul>

      <p className="meta max-w-sm">
        By continuing, you agree to our{' '}
        <Link href="/terms" className="link">
          Terms
        </Link>{' '}
        and{' '}
        <Link href="/privacy" className="link">
          Privacy Policy
        </Link>
        .
      </p>
    </section>
  );
}

function StepDetails({
  headingRef,
  kids,
  childValidations,
  area,
  onArea,
  onChild,
  onAdd,
  onRemove,
  canProvision,
  saving,
  error,
  onSubmit,
}: {
  headingRef: HeadingRef;
  kids: SetupChild[];
  childValidations: (ReturnType<typeof validateChild> | null)[];
  area: string;
  onArea: (value: string) => void;
  onChild: (id: string, patch: Partial<SetupChild>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  canProvision: boolean;
  saving: boolean;
  error: string | null;
  onSubmit: () => void;
}) {
  return (
    <section className="ob-step space-y-7">
      <Bubble>
        You&rsquo;re signed in. A couple of private details — kept encrypted for your family — and
        I&rsquo;ll get everything ready.
      </Bubble>

      <h1 ref={headingRef} tabIndex={-1} className="sr-only outline-none">
        A few private details
      </h1>

      <fieldset className="space-y-6">
        <legend className="eyebrow text-spruce">Your kids</legend>
        {kids.map((child, index) => {
          const validation = childValidations[index];
          const dobError = validation && !validation.ok ? describeDobError(validation.error) : null;
          return (
            <div key={child.id} className="card space-y-4">
              <div className="flex items-baseline justify-between">
                <span className="meta">child {index + 1}</span>
                {kids.length > 1 ? (
                  <button
                    type="button"
                    className="link meta inline-flex items-center gap-1.5"
                    onClick={() => onRemove(child.id)}
                  >
                    <X size={14} strokeWidth={2} aria-hidden="true" />
                    remove
                  </button>
                ) : null}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor={`d-name-${child.id}`} className="eyebrow">
                    first name
                  </label>
                  <input
                    id={`d-name-${child.id}`}
                    type="text"
                    className="field mt-2"
                    value={child.name}
                    onChange={(e) => onChild(child.id, { name: e.currentTarget.value })}
                    placeholder="Sebastian"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <label htmlFor={`d-dob-${child.id}`} className="eyebrow">
                    birthday
                  </label>
                  <input
                    id={`d-dob-${child.id}`}
                    type="date"
                    className="field mt-2"
                    value={child.dateOfBirth}
                    max={today()}
                    onChange={(e) => onChild(child.id, { dateOfBirth: e.currentTarget.value })}
                    autoComplete="bday"
                  />
                </div>
                <div>
                  <label htmlFor={`d-last-${child.id}`} className="eyebrow">
                    last name <span className="text-faded-sage">(optional)</span>
                  </label>
                  <input
                    id={`d-last-${child.id}`}
                    type="text"
                    className="field mt-2"
                    value={child.lastName}
                    onChange={(e) => onChild(child.id, { lastName: e.currentTarget.value })}
                    placeholder="Ramos"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <label htmlFor={`d-gender-${child.id}`} className="eyebrow">
                    gender <span className="text-faded-sage">(optional)</span>
                  </label>
                  <select
                    id={`d-gender-${child.id}`}
                    className="field mt-2"
                    value={child.gender}
                    onChange={(e) =>
                      onChild(child.id, { gender: e.currentTarget.value as ChildGender })
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
                <p className="field-error" role="alert">
                  {dobError}
                </p>
              ) : null}
            </div>
          );
        })}
        <button
          type="button"
          className="link meta inline-flex items-center gap-1.5"
          onClick={onAdd}
        >
          <Plus size={14} strokeWidth={2} aria-hidden="true" />
          add another child
        </button>
      </fieldset>

      <div>
        <label htmlFor="d-area" className="eyebrow text-spruce">
          your area
        </label>
        <input
          id="d-area"
          type="text"
          className="field mt-2"
          value={area}
          onChange={(e) => onArea(e.currentTarget.value)}
          placeholder="Toronto"
          autoComplete="off"
        />
        <p className="meta mt-2">Just your neighbourhood — we never store your exact address.</p>
      </div>

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}

      <p className="meta">
        By continuing, you agree to our{' '}
        <Link href="/terms" className="link">
          Terms
        </Link>{' '}
        and{' '}
        <Link href="/privacy" className="link">
          Privacy Policy
        </Link>
        .
      </p>

      <div className="flex items-center justify-end gap-4 pt-1">
        {canProvision ? null : (
          <p className="meta">add each child&rsquo;s name and birthday to continue.</p>
        )}
        <button
          type="button"
          className="btn-primary"
          onClick={onSubmit}
          disabled={!canProvision}
        >
          {saving ? 'Getting ready…' : 'Get everything ready'}
          <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      <PrivacyNote />
    </section>
  );
}

function StepConnect({ headingRef, onNext }: { headingRef: HeadingRef; onNext: () => void }) {
  return (
    <section className="ob-step space-y-7">
      <div className="space-y-1">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-[1.75rem] font-medium leading-tight outline-none"
        >
          Connect to unlock even more.
        </h1>
        <p className="text-slate-green">You can always add these later.</p>
      </div>

      <OnboardingConnect />

      <div className="flex flex-col items-center gap-3 pt-1">
        <button type="button" className="btn-primary w-full max-w-xs justify-center" onClick={onNext}>
          Continue
          <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
        </button>
        <button type="button" className="btn-ghost" onClick={onNext}>
          Maybe later
        </button>
      </div>
    </section>
  );
}

const ASSURANCES: readonly { icon: typeof ShieldCheck; label: string }[] = [
  { icon: ShieldCheck, label: 'Hale only acts with your approval' },
  { icon: Check, label: 'Your data stays private & secure' },
  { icon: X, label: 'Disconnect anytime' },
];

function StepDone({
  headingRef,
  childName,
  onEnter,
}: {
  headingRef: HeadingRef;
  childName: string;
  onEnter: () => void;
}) {
  return (
    <section className="ob-step flex flex-col items-center text-center gap-6">
      <LogoMark size={70} className="shadow-[0_14px_32px_rgba(27,33,96,0.25)]" />
      <div className="space-y-2">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-[2rem] font-medium leading-tight outline-none"
        >
          Your village is ready.
        </h1>
        <p className="text-lg text-slate-green leading-relaxed max-w-md">
          Hale is set up for {childName} — quietly helpful, always in your corner.
        </p>
      </div>

      <ul className="w-full max-w-sm space-y-2.5 text-left card">
        {ASSURANCES.map(({ icon: Icon, label }) => (
          <li key={label} className="flex items-center gap-2.5 text-sm text-slate-green">
            <Icon size={16} strokeWidth={2} aria-hidden="true" className="shrink-0 text-sage" />
            {label}
          </li>
        ))}
      </ul>

      <button type="button" className="btn-primary" onClick={onEnter}>
        Open your village
        <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
      </button>
      <PrivacyNote />
    </section>
  );
}

function describeDobError(error: string): string {
  switch (error) {
    case 'dob_future':
      return "that's in the future — check the year";
    case 'dob_too_old':
      return 'Hale is for children under eighteen';
    case 'dob_invalid':
      return "that date doesn't look right";
    case 'dob_required':
      return 'add a birthday';
    default:
      return '';
  }
}
