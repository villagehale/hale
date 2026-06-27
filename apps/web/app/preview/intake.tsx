'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Compass, Heart } from 'lucide-react';
import { type FamilyStage, type OnboardingIntent, FAMILY_STAGES } from '@hale/types';
import { IntentChips } from '~/components/hale/intent-chips';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import { writeIntakeDraft } from '~/lib/onboarding/intake-storage';

/**
 * The PRE-AUTH "see what Hale finds for you" intake + sample (rule #1).
 *
 * It collects ONLY coarse, anonymous inputs — a stage picked as a friendly age
 * RANGE (never a date of birth), a coarse area (a city or postal prefix, never a
 * precise address), and optional interest chips. None of it is child-identifying.
 * It posts those three coarse fields to /api/preview, which runs the real
 * discovery model and persists NOTHING, and renders the returned sample.
 *
 * On "save + set up", it writes the coarse intake to the SAME sessionStorage
 * draft onboarding already hydrates from (intake-storage.ts), then hands off to
 * /sign-in?callbackUrl=/onboarding — so the area + intents (+ the stage hint)
 * pre-fill onboarding, but the sensitive fields (exact DOB, full address) are
 * still entered and consented post-auth, behind the signup wall.
 */

/** The four real stages, labelled as friendly age ranges for an anonymous
 * visitor. The picker maps 1:1 to FamilyStage — the exact value discovery
 * expects — so no DOB → stage conversion is ever needed (rule #1). */
const STAGE_LABELS: Record<FamilyStage, { label: string; age: string }> = {
  newborn: { label: 'Newborn', age: 'under 1' },
  toddler: { label: 'Toddler', age: '1 – 3' },
  child: { label: 'Child', age: '4 – 12' },
  teenager: { label: 'Teenager', age: '13 +' },
};

interface PreviewActivity {
  title: string;
  summary: string;
  coverageNote: string;
  sourceUrl: string | null;
}

type Result =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; activities: PreviewActivity[] }
  | { kind: 'teen' }
  | { kind: 'error' };

export function PreviewIntake() {
  const [stage, setStage] = useState<FamilyStage | null>(null);
  const [area, setArea] = useState('');
  const [intents, setIntents] = useState<OnboardingIntent[]>([]);
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  const capture = useAnalytics();

  const canSearch = stage !== null && area.trim().length > 0;

  function toggleIntent(value: OnboardingIntent) {
    setIntents((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }

  async function handleSearch() {
    if (!stage || area.trim().length === 0) {
      return;
    }
    // Coarse funnel signal only — the stage enum, whether an area was given, and a
    // count of intents. Never the area string or any chosen-interest labels (rule #1).
    capture('preview_submitted', {
      stage,
      hasArea: area.trim().length > 0,
      intentCount: intents.length,
    });
    // Teens are out of the discovery scope by construction (rule #1) — show the
    // honest message rather than ask the model to fabricate teen activities.
    if (stage === 'teenager') {
      setResult({ kind: 'teen' });
      return;
    }
    setResult({ kind: 'loading' });
    try {
      const res = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage, areaCoarse: area.trim(), interests: intents }),
      });
      if (!res.ok) {
        setResult({ kind: 'error' });
        return;
      }
      const data = (await res.json()) as { activities: PreviewActivity[] };
      setResult({ kind: 'ready', activities: data.activities });
    } catch {
      setResult({ kind: 'error' });
    }
  }

  /** Carry ONLY the coarse intake into onboarding's draft (rule #1): the coarse
   * area, the chosen intents, and the stage hint. No DOB, no name, no precise
   * address — those are entered and consented post-auth in Phase C. */
  function saveAndSetUp() {
    writeIntakeDraft({
      childNames: [],
      city: area.trim(),
      intents,
      planTier: 'free',
      tosAccepted: false,
      stage: stage ?? undefined,
    });
  }

  return (
    <div className="space-y-12">
      <section className="rise rise-1 space-y-8 max-w-2xl">
        <div className="space-y-3">
          <span className="eyebrow">a quick, anonymous peek</span>
          <h1 className="font-display">See what Hale finds for you.</h1>
          <p className="text-lg text-slate-green leading-relaxed">
            No account, no sign-up — just a couple of coarse details and I&rsquo;ll show you
            the kind of genuinely good local things families near you actually do.
            I never ask for a name or a birthday here.
          </p>
        </div>

        <div className="space-y-6">
          <fieldset>
            <legend className="eyebrow">how old is your kid?</legend>
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
              {FAMILY_STAGES.map((value) => {
                const meta = STAGE_LABELS[value];
                const isSelected = stage === value;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => setStage(value)}
                    className={`choice-card rounded-[var(--r-md)] px-4 py-3 text-left transition-colors ${
                      isSelected
                        ? 'bg-oat border border-spruce text-spruce'
                        : 'border border-rule-strong text-slate-green hover:border-spruce'
                    }`}
                  >
                    <span className="font-display text-lg block leading-none">{meta.label}</span>
                    <span className="meta block mt-1">{meta.age}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div>
            <label htmlFor="preview-area" className="eyebrow">
              your area
            </label>
            <input
              id="preview-area"
              type="text"
              className="field mt-2"
              value={area}
              onChange={(e) => setArea(e.currentTarget.value)}
              placeholder="Toronto, or a postal prefix like M5V"
              autoComplete="off"
            />
            <p className="meta mt-2">
              just a coarse area — a city or postal prefix. never a precise address.
            </p>
          </div>

          <div>
            <IntentChips
              legend="anything you're hoping for? (optional)"
              selected={intents}
              onToggle={toggleIntent}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 pt-2">
          <button
            type="button"
            className="btn-primary"
            onClick={handleSearch}
            disabled={!canSearch || result.kind === 'loading'}
          >
            <Compass size={18} strokeWidth={2} aria-hidden="true" />
            {result.kind === 'loading' ? 'finding…' : 'show me'}
          </button>
          <Link href="/" className="btn-ghost">
            ← back
          </Link>
        </div>
        <p className="meta">pipeda · law 25 · nothing saved until you create an account</p>
      </section>

      {result.kind === 'ready' ? (
        <PreviewResult activities={result.activities} area={area.trim()} onSetUp={saveAndSetUp} />
      ) : null}

      {result.kind === 'teen' ? (
        <section className="rise rise-2 max-w-2xl panel-oat px-6 py-6 space-y-4">
          <p className="text-lg text-spruce leading-relaxed">
            Hale supports teens too — with a privacy-first approach. We don&rsquo;t surface a
            teen&rsquo;s activities to you the way we do for younger kids; instead Hale helps with
            the logistics and holds their privacy (you see the kind of thing, never their
            messages). Sign in to set up your family and I&rsquo;ll tailor it for them.
          </p>
          <Link
            href="/sign-in?callbackUrl=/onboarding"
            className="btn-primary self-start"
            onClick={saveAndSetUp}
          >
            Set up your family
            <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
          </Link>
        </section>
      ) : null}

      {result.kind === 'error' ? (
        <p className="rise rise-2 meta text-apricot-deep max-w-2xl" role="alert">
          something went wrong finding things just now — try again in a moment.
        </p>
      ) : null}
    </div>
  );
}

function PreviewResult({
  activities,
  area,
  onSetUp,
}: {
  activities: PreviewActivity[];
  area: string;
  onSetUp: () => void;
}) {
  if (activities.length === 0) {
    return (
      <section className="rise rise-2 max-w-2xl panel-oat px-6 py-6 space-y-4">
        <p className="text-lg text-spruce leading-relaxed">
          I couldn&rsquo;t find enough to stand behind for that area just yet — Hale gets
          sharper the more your village grows. Set up your family and I&rsquo;ll keep looking.
        </p>
        <Link
          href="/sign-in?callbackUrl=/onboarding"
          className="btn-primary self-start"
          onClick={onSetUp}
        >
          Set up your family
          <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
        </Link>
      </section>
    );
  }

  return (
    <section className="rise rise-2 space-y-8">
      <div className="max-w-2xl space-y-2">
        <span className="eyebrow">a sample of what&rsquo;s near {area}</span>
        <h2 className="font-display">Here&rsquo;s a taste of your village.</h2>
        <p className="text-slate-green leading-relaxed">
          A sample only — the real thing is ranked for your family and vouched for by
          parents near you. Sign in to save this and set up your family.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {activities.map((activity) => (
          <article key={activity.title} className="card flex flex-col gap-3">
            <h3 className="font-display text-xl" style={{ lineHeight: 1.2 }}>
              {activity.title}
            </h3>
            <p className="text-slate-green leading-relaxed">{activity.summary}</p>
            {activity.coverageNote ? <p className="meta">{activity.coverageNote}</p> : null}
            {activity.sourceUrl ? (
              <a
                href={activity.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="link meta mt-auto self-start"
              >
                learn more →
              </a>
            ) : null}
          </article>
        ))}
      </div>

      <div className="panel-apricot-tint px-6 py-6 flex flex-col sm:flex-row sm:items-center gap-5 sm:gap-8">
        <span
          className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full"
          style={{ background: 'var(--color-apricot)' }}
          aria-hidden
        >
          <Heart size={22} strokeWidth={2} style={{ color: 'var(--color-spruce)' }} />
        </span>
        <div className="space-y-3">
          <p className="text-lg text-spruce leading-relaxed">
            Sign in with Google or email to save this and set up your family — I&rsquo;ll carry
            your area and what you&rsquo;re after over, so there&rsquo;s less to re-type.
          </p>
          <Link
            href="/sign-in?callbackUrl=/onboarding"
            className="btn-primary self-start"
            onClick={onSetUp}
          >
            Save this + set up your family
            <ArrowRight size={18} strokeWidth={2} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
