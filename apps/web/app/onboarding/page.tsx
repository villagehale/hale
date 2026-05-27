'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Folio } from '~/components/mira/folio';

type Step = 1 | 2 | 3 | 4 | 5;

const STEP_META: Record<Step, { eyebrow: string; folio: string; title: string }> = {
  1: { eyebrow: 'step one · five', folio: '01', title: 'welcome' },
  2: { eyebrow: 'step two · five', folio: '02', title: 'tell me about your baby' },
  3: { eyebrow: 'step three · five', folio: '03', title: 'trial mode' },
  4: { eyebrow: 'step four · five', folio: '04', title: 'connect one source' },
  5: { eyebrow: 'step five · five', folio: '05', title: 'invite your co-parent' },
};

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>(1);
  const [babyName, setBabyName] = useState('');
  const [babyDob, setBabyDob] = useState('');
  const [parentingStyle, setParentingStyle] = useState<string>('gentle');

  const meta = STEP_META[step];

  return (
    <div className="min-h-screen">
      {/* HEADER */}
      <header className="shell pt-8 pb-6 border-b border-hairline">
        <div className="flex items-baseline justify-between gap-6">
          <Link href="/" className="font-display text-2xl leading-none">
            mira
          </Link>
          <div className="flex items-center gap-2">
            {[1, 2, 3, 4, 5].map((s) => (
              <span
                key={s}
                className={`block h-1 w-8 ${s <= step ? 'bg-copper' : 'bg-hairline-strong'}`}
                aria-hidden
              />
            ))}
          </div>
        </div>
      </header>

      <main className="shell pt-16 lg:pt-24 pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-10 lg:gap-x-12">
          <div className="lg:col-span-3">
            <Folio index={Number(meta.folio)} />
            <span className="eyebrow block mt-4">{meta.eyebrow}</span>
            <h1 className="mt-6 font-display">
              {meta.title}
            </h1>
          </div>

          <div className="lg:col-span-9 lg:col-start-4">
            {step === 1 ? (
              <section className="rise rise-1 space-y-8 max-w-2xl">
                <p className="text-xl lg:text-2xl leading-snug text-ink-soft">
                  mira is a household platform for the first year of your child's
                  life — and the next eighteen. i watch your inbox, your calendar,
                  your photos, and the small devices that already log your kid's
                  life, and i do the easy ninety percent of household admin so you
                  can hold your baby.
                </p>
                <p className="text-lg text-ink-soft leading-relaxed">
                  setup takes about four minutes. i won't do anything autonomously
                  for the first seven days, no matter what you tell me here. that's
                  what step three is about.
                </p>
                <div className="flex flex-wrap items-center gap-5 pt-4">
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => setStep(2)}
                  >
                    sign in with passkey
                  </button>
                  <button type="button" className="btn-ghost">use an email link instead</button>
                </div>
                <p className="meta">canadian data residency · pipeda + law 25 by default</p>
              </section>
            ) : null}

            {step === 2 ? (
              <section className="rise rise-1 space-y-10 max-w-2xl">
                <p className="text-lg text-ink-soft leading-relaxed">
                  i need a few small things. you can type, or tap{' '}
                  <button type="button" className="travel-underline">hold to talk</button>{' '}
                  if you're holding the baby.
                </p>

                <div className="space-y-8">
                  <div>
                    <label htmlFor="baby-name" className="eyebrow">your child's name</label>
                    <input
                      id="baby-name"
                      type="text"
                      className="field mt-2"
                      value={babyName}
                      onChange={(e) => setBabyName(e.currentTarget.value)}
                      placeholder="maya"
                    />
                  </div>

                  <div>
                    <label htmlFor="baby-dob" className="eyebrow">date of birth</label>
                    <input
                      id="baby-dob"
                      type="date"
                      className="field mt-2"
                      value={babyDob}
                      onChange={(e) => setBabyDob(e.currentTarget.value)}
                    />
                  </div>

                  <div>
                    <span className="eyebrow">how do you want to parent?</span>
                    <p className="meta mt-1">affects coach voice + which frameworks i lean on. you can change this any time.</p>
                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {[
                        { id: 'gentle', label: 'gentle', note: 'lansbury · markham' },
                        { id: 'attachment', label: 'attachment', note: 'sears · siegel' },
                        { id: 'structured', label: 'structured', note: 'karp · ferber' },
                        { id: 'undecided', label: 'still figuring it out', note: "i'll be neutral" },
                      ].map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setParentingStyle(opt.id)}
                          className={`text-left border p-4 transition-colors ${
                            parentingStyle === opt.id
                              ? 'border-ink bg-cream-deep'
                              : 'border-hairline-strong hover:border-ink'
                          }`}
                        >
                          <span className="font-display text-xl">{opt.label}</span>
                          <span className="meta block mt-1">{opt.note}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-5 pt-4">
                  <button type="button" className="btn-ghost" onClick={() => setStep(1)}>← back</button>
                  <button type="button" className="btn-primary ml-auto" onClick={() => setStep(3)}>
                    continue
                  </button>
                </div>
              </section>
            ) : null}

            {step === 3 ? (
              <section className="rise rise-1 space-y-8 max-w-2xl">
                <p className="text-xl lg:text-2xl leading-snug text-ink-soft">
                  for the first seven days, mira draws every action — but never
                  commits it. you see exactly what would have happened. nothing
                  sends. nothing books. nothing orders.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4 border-y border-hairline py-8">
                  {[
                    { eyebrow: 'days 1-7', body: 'i draft. nothing sends.' },
                    { eyebrow: 'days 8-30', body: 'you tap approve on each.' },
                    { eyebrow: 'day 31+', body: 'i act on routine, ask on the rest.' },
                  ].map((phase) => (
                    <div key={phase.eyebrow}>
                      <span className="eyebrow">{phase.eyebrow}</span>
                      <p className="font-display text-2xl mt-2 leading-snug">
                        {phase.body}
                      </p>
                    </div>
                  ))}
                </div>

                <p className="text-lg text-ink-soft leading-relaxed">
                  you can extend or restart trial mode at any time. you can revoke
                  autonomy for any action class with one tap. these aren't terms
                  buried in a tos — they're the architecture.
                </p>

                <div className="flex flex-wrap items-center gap-5 pt-4">
                  <button type="button" className="btn-ghost" onClick={() => setStep(2)}>← back</button>
                  <button type="button" className="btn-primary ml-auto" onClick={() => setStep(4)}>
                    i understand · continue
                  </button>
                </div>
              </section>
            ) : null}

            {step === 4 ? (
              <section className="rise rise-1 space-y-8 max-w-2xl">
                <p className="text-lg text-ink-soft leading-relaxed">
                  connect one source first. gmail is the highest-leverage entry —
                  the pediatric office, daycare, government, and family all reach
                  you there. you can connect calendar and photos next from the{' '}
                  <span className="font-display">connected</span> page.
                </p>

                <div className="space-y-4">
                  {[
                    { id: 'gmail', label: 'gmail', note: 'recommended · highest leverage' },
                    { id: 'outlook', label: 'outlook', note: "if you'd rather use microsoft" },
                    { id: 'icloud', label: 'apple mail', note: 'in beta · slower sync' },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className="w-full text-left border border-hairline-strong p-5 flex items-baseline justify-between hover:border-ink transition-colors"
                    >
                      <div>
                        <span className="font-display text-2xl">{opt.label}</span>
                        <span className="meta block mt-1">{opt.note}</span>
                      </div>
                      <span className="eyebrow text-copper">connect →</span>
                    </button>
                  ))}
                </div>

                <p className="meta">
                  you approve every scope. i can't read attachments from senders not in
                  your allowlist. you can revoke access in two taps.
                </p>

                <div className="flex flex-wrap items-center gap-5 pt-4">
                  <button type="button" className="btn-ghost" onClick={() => setStep(3)}>← back</button>
                  <button type="button" className="btn-ghost ml-auto" onClick={() => setStep(5)}>
                    skip for now
                  </button>
                  <button type="button" className="btn-primary" onClick={() => setStep(5)}>
                    continue
                  </button>
                </div>
              </section>
            ) : null}

            {step === 5 ? (
              <section className="rise rise-1 space-y-10 max-w-2xl">
                <p className="text-lg text-ink-soft leading-relaxed">
                  mira works best as a family unit. invite your co-parent and we'll
                  share the digest, drafts, and trail across both of you. either of
                  you can approve actions. neither of you can be locked out.
                </p>

                <div className="border border-hairline-strong p-6 bg-cream-deep">
                  <span className="eyebrow">share this link</span>
                  <p className="font-display text-xl break-all mt-2">
                    mira.family/invite/87c2-d9f5-12a8
                  </p>
                  <div className="flex flex-wrap items-center gap-3 mt-4">
                    <button type="button" className="btn-ghost">copy link</button>
                    <button type="button" className="btn-ghost">show qr</button>
                    <button type="button" className="btn-ghost">send by email</button>
                  </div>
                </div>

                <p className="meta">
                  no co-parent? skip this — actions affecting another person's data
                  will simply require your explicit tap. you can invite later.
                </p>

                <div className="flex flex-wrap items-center gap-5 pt-4">
                  <button type="button" className="btn-ghost" onClick={() => setStep(4)}>← back</button>
                  <Link href="/digest" className="btn-primary ml-auto">
                    finish · go to my digest
                  </Link>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
