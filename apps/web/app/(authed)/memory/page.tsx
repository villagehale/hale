'use client';

import { useState } from 'react';
import { PageCorner } from '~/components/haru/page-corner';
import { Folio } from '~/components/haru/folio';

function DestructiveButton({
  label,
  confirmLabel,
  className,
}: {
  label: string;
  confirmLabel: string;
  className: string;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={() => setArmed((v) => !v)}
      onBlur={() => setArmed(false)}
      aria-pressed={armed}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

interface Fact {
  id: string;
  type: 'preference' | 'routine' | 'medical' | 'logistic' | 'relationship' | 'voice';
  key: string;
  value: string;
  source: string;
  confidence: number;
  observedTimes: number;
}

const FACTS: Fact[] = [
  {
    id: '1',
    type: 'preference',
    key: 'pediatric appointments',
    value: 'family prefers Thursday mornings',
    source: 'inferred from 4 prior bookings',
    confidence: 0.92,
    observedTimes: 4,
  },
  {
    id: '2',
    type: 'routine',
    key: 'bedtime',
    value: 'co-parent A handles tuesday/thursday; co-parent B handles other nights',
    source: 'inferred from calendar + sleep tracker',
    confidence: 0.86,
    observedTimes: 12,
  },
  {
    id: '3',
    type: 'voice',
    key: 'tone with teachers',
    value: 'warm but brief — short sentences, signed with "thanks"',
    source: 'analyzed from 7 prior emails',
    confidence: 0.89,
    observedTimes: 7,
  },
  {
    id: '4',
    type: 'voice',
    key: 'tone with insurers',
    value: 'formal, structured — full signature block',
    source: 'analyzed from 3 prior emails',
    confidence: 0.78,
    observedTimes: 3,
  },
  {
    id: '5',
    type: 'medical',
    key: 'maya · pediatrician',
    value: 'dr. anita chen, Queen West Pediatrics, Queen West Clinic',
    source: 'stated in setup · confirmed in 2 visit emails',
    confidence: 0.99,
    observedTimes: 3,
  },
  {
    id: '6',
    type: 'logistic',
    key: 'diaper supply cadence',
    value: 'one case (size 2) every 18-22 days',
    source: 'inferred from 6 prior orders',
    confidence: 0.95,
    observedTimes: 6,
  },
  {
    id: '7',
    type: 'relationship',
    key: 'grandparent: mom',
    value: 'photo-share approved · weekly cadence preferred',
    source: 'stated in setup · 8 prior shares approved',
    confidence: 0.97,
    observedTimes: 8,
  },
  {
    id: '8',
    type: 'preference',
    key: 'sleep philosophy',
    value: 'gentle methods preferred — not ferber, not pure attachment',
    source: 'stated during onboarding',
    confidence: 1.0,
    observedTimes: 1,
  },
];

const TYPE_PILL: Record<Fact['type'], string> = {
  preference: 'pill-madder',
  routine: 'pill-moss',
  medical: 'pill-madder',
  logistic: 'pill',
  relationship: 'pill-moss',
  voice: 'pill-indigo',
};

const TYPE_GROUPS: Array<{
  type: Fact['type'];
  label: string;
  description: string;
}> = [
  { type: 'preference', label: 'preferences', description: 'how this family chooses, when given a choice.' },
  { type: 'routine', label: 'routines', description: 'who does what, when. the weekly rhythm.' },
  { type: 'voice', label: 'voice', description: 'how each parent writes to each recipient.' },
  { type: 'medical', label: 'medical', description: 'the people, places, and prescriptions i must know.' },
  { type: 'logistic', label: 'logistics', description: 'supply cadences, schedules, and the small rhythms of daily care.' },
  { type: 'relationship', label: 'relationships', description: 'who is in this family\'s circle and what they expect.' },
];

function ConfidenceBar({ value }: { value: number }) {
  const percent = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`confidence ${percent}%`}
        tabIndex={0}
        className="h-1 w-24 rounded-full"
        style={{ background: 'var(--color-rule)' }}
      >
        <div
          aria-hidden
          className="h-full rounded-full"
          style={{ width: `${percent}%`, background: 'var(--color-iron)' }}
        />
      </div>
      <span className="meta tabular" aria-hidden>
        {percent}%
      </span>
    </div>
  );
}

export default function MemoryPage() {
  return (
    <div>
      <PageCorner folio="v" section="memory · the family graph" />

      <header className="rise rise-1 mb-12 lg:mb-16">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">memory garden</span>
            <p className="meta mt-2">every fact, named and sourced</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              what i <span className="text-madder">remember</span>
              <br />
              about your household.
            </h1>
          </div>
        </div>
      </header>

      {/* ── The promise ────────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-16 lg:mb-20 fold">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-4 lg:gap-x-8">
          <div className="lg:col-span-3">
            <span className="eyebrow text-iron">the promise</span>
          </div>
          <div className="lg:col-span-9 text-iron text-lg leading-relaxed">
            <p>
              Every fact below comes from a specific signal I observed. You can
              edit any of them, mark any of them wrong, or delete any of them —
              and I will retrain my behavior around the change before the next
              digest. <em>This is the only consumer ai product that shows you what it remembers.</em>
            </p>
            <div className="mt-5 flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <span className="meta">{FACTS.length} facts in memory</span>
              <span className="meta">last updated · 06:18 am</span>
              <span className="meta">canadian residency · per-key encryption</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Faceted index ──────────────────────────────────────────────── */}
      <section className="rise rise-3 mb-12 border-y border-rule py-6">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-3">
          <span className="eyebrow">browse</span>
          <button type="button" className="btn-ghost" aria-current="true">all · {FACTS.length}</button>
          {TYPE_GROUPS.map((g) => {
            const count = FACTS.filter((f) => f.type === g.type).length;
            return (
              <button key={g.type} type="button" className="btn-ghost">
                {g.label} · {count}
              </button>
            );
          })}
          <span className="ml-auto">
            <button type="button" className="btn-ghost">+ add a fact</button>
          </span>
        </div>
      </section>

      {/* ── Cards grid (no shadow — just paper-toned panels) ───────────── */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-rule">
        {FACTS.map((fact, idx) => {
          const delay = `rise-${Math.min(idx + 3, 7)}`;
          return (
            <article
              key={fact.id}
              className={`rise ${delay} bg-bone-soft p-6 lg:p-7 space-y-4 flex flex-col`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className={`pill ${TYPE_PILL[fact.type]}`}>{fact.type}</span>
                <Folio index={idx + 1} />
              </div>

              <h3 className="font-display text-[1.5rem] leading-tight">
                {fact.key}
              </h3>

              <p className="text-iron leading-relaxed flex-grow">{fact.value}</p>

              <div className="border-l-2 border-rule-strong pl-4">
                <span className="eyebrow text-iron">source</span>
                <p className="mt-1 meta italic">{fact.source}</p>
              </div>

              <div className="flex items-end justify-between gap-3 pt-2 border-t border-rule">
                <div>
                  <p className="meta">confidence</p>
                  <div className="mt-1.5">
                    <ConfidenceBar value={fact.confidence} />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button type="button" className="btn-ghost text-sm">edit</button>
                  <DestructiveButton
                    label="forget"
                    confirmLabel="tap again to forget"
                    className="btn-ghost text-sm"
                  />
                </div>
              </div>
            </article>
          );
        })}
      </section>

      {/* ── Your rights ────────────────────────────────────────────────── */}
      <section className="rise rise-7 mt-16 lg:mt-20 pt-10 border-t border-rule">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">your rights</span>
            <p className="meta mt-2">non-negotiable</p>
          </div>
          <div className="lg:col-span-9 text-slate leading-relaxed space-y-5">
            <p>
              Request a full export of everything you see on this page in
              machine-readable form. Delete everything in one tap. The family
              graph never leaves Canadian-region storage. Nothing here is shared
              with any third party, ever.
            </p>
            <div className="pt-2 flex flex-wrap items-center gap-x-6 gap-y-3">
              <button type="button" className="btn-secondary">export everything</button>
              <DestructiveButton
                label="delete everything"
                confirmLabel="tap again to delete everything"
                className="btn-ghost"
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
