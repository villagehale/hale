'use client';

import { useState } from 'react';
import Link from 'next/link';

type Step = 1 | 2 | 3 | 4 | 5;

const STEP_META: Record<Step, { folio: string; section: string; title: string }> = {
  1: { folio: 'i', section: 'step one of five', title: 'welcome' },
  2: { folio: 'ii', section: 'step two of five', title: 'tell me about your baby' },
  3: { folio: 'iii', section: 'step three of five', title: 'how trial mode works' },
  4: { folio: 'iv', section: 'step four of five', title: 'connect one source' },
  5: { folio: 'v', section: 'step five of five', title: 'invite your co-parent' },
};

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>(1);
  const [babyName, setBabyName] = useState('');
  const [babyDob, setBabyDob] = useState('');
  const [parentingStyle, setParentingStyle] = useState<string>('gentle');

  const meta = STEP_META[step];

  return (
    <div className="min-h-screen bg-bone">
      {/* Running head — book top edge */}
      <header className="shell flex items-baseline justify-between pt-6 pb-4 border-b border-rule">
        <Link href="/" className="font-display text-xl">haru</Link>

        <div className="flex items-baseline gap-3">
          <span className="eyebrow">enrolment</span>
          <div className="flex items-center gap-1.5" aria-hidden>
            {[1, 2, 3, 4, 5].map((s) => (
              <span
                key={s}
                className="block h-px w-6"
                style={{
                  background: s <= step ? 'var(--color-iron)' : 'var(--color-rule-strong)',
                }}
              />
            ))}
          </div>
          <span className="meta tabular" aria-live="polite" aria-atomic="true">
            step {step} of 5
          </span>
        </div>
      </header>

      <main className="shell pt-16 lg:pt-24 pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-10 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="folio">{meta.folio}</span>
            <p className="meta mt-2">{meta.section}</p>
            <h1 className="mt-6 font-display">{meta.title}</h1>
          </div>

          <div className="lg:col-span-9 lg:col-start-4">
            {step === 1 ? (
              <section className="rise rise-1 space-y-8 max-w-2xl">
                <p className="text-xl lg:text-[1.4rem] leading-snug text-slate">
                  haru is a household almanac for the first year of your child's
                  life — and the next eighteen. I watch your inbox, your calendar,
                  your photos, and the small devices that already log your kid's
                  life, and I do the easy ninety percent of household admin so you
                  can hold your baby.
                </p>
                <p className="text-lg text-slate leading-relaxed">
                  Set-up takes about four minutes. I will not do anything autonomously
                  for the first seven days, no matter what you tell me here. That
                  is what step three is about.
                </p>

                <div className="fold-tint">
                  <span className="eyebrow text-madder-deep">a guarantee</span>
                  <p className="mt-2 text-slate">
                    Your child's name, date of birth, and medical details are
                    encrypted at rest with keys you can rotate. Canadian residency
                    is non-negotiable.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-5 pt-2">
                  <button type="button" className="btn-primary" onClick={() => setStep(2)}>
                    sign in with passkey →
                  </button>
                  <button type="button" className="btn-ghost">use an email link instead</button>
                </div>
                <p className="meta">pipeda · law 25 · casl compliant by default</p>
              </section>
            ) : null}

            {step === 2 ? (
              <section className="rise rise-1 space-y-10 max-w-2xl">
                <p className="text-lg text-slate leading-relaxed">
                  I need a few small things. You can type, or tap{' '}
                  <button type="button" className="travel-underline">hold to talk</button>{' '}
                  if you are holding the baby.
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
                      autoComplete="off"
                      spellCheck={false}
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
                      autoComplete="bday"
                    />
                  </div>

                  <fieldset>
                    <legend className="eyebrow">how do you want to parent?</legend>
                    <p className="meta mt-1">affects coach voice + which frameworks i lean on. you can change this any time.</p>
                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {[
                        { id: 'gentle', label: 'gentle', note: 'lansbury · markham' },
                        { id: 'attachment', label: 'attachment', note: 'sears · siegel' },
                        { id: 'structured', label: 'structured', note: 'karp · ferber' },
                        { id: 'undecided', label: 'still figuring it out', note: "i'll be neutral" },
                      ].map((opt) => {
                        const selected = parentingStyle === opt.id;
                        return (
                          <label
                            key={opt.id}
                            className={`cursor-pointer text-left p-4 rounded-[var(--r-md)] transition-colors block ${
                              selected
                                ? 'bg-vellum border border-iron'
                                : 'border border-rule-strong hover:border-iron'
                            }`}
                          >
                            <input
                              type="radio"
                              name="parenting-style"
                              value={opt.id}
                              checked={selected}
                              onChange={() => setParentingStyle(opt.id)}
                              className="sr-only"
                            />
                            <span className="font-display text-xl block">{opt.label}</span>
                            <span className="meta block mt-1">{opt.note}</span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                </div>

                <div className="flex flex-wrap items-center gap-5 pt-2">
                  <button type="button" className="btn-ghost" onClick={() => setStep(1)}>← back</button>
                  <button type="button" className="btn-primary ml-auto" onClick={() => setStep(3)}>
                    continue →
                  </button>
                </div>
              </section>
            ) : null}

            {step === 3 ? (
              <section className="rise rise-1 space-y-10 max-w-2xl">
                <p className="text-xl lg:text-[1.4rem] leading-snug text-slate">
                  For the first seven days, haru drafts every action — but never
                  commits it. You see exactly what would have happened. Nothing
                  sends. Nothing books. Nothing orders.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-6 border-y border-rule py-8">
                  {[
                    { eyebrow: 'days 1–7', body: 'i draft. nothing sends.' },
                    { eyebrow: 'days 8–30', body: 'you tap approve on each.' },
                    { eyebrow: 'day 31 onward', body: 'i act on routine. ask on the rest.' },
                  ].map((phase, idx) => (
                    <div key={phase.eyebrow} className="space-y-2">
                      <div className="flex items-baseline gap-2">
                        <span className="folio">{['i', 'ii', 'iii'][idx]}</span>
                        <span className="eyebrow">{phase.eyebrow}</span>
                      </div>
                      <p className="font-display text-xl leading-snug">{phase.body}</p>
                    </div>
                  ))}
                </div>

                <p className="text-lg text-slate leading-relaxed">
                  You can extend or restart trial mode at any time. You can revoke
                  autonomy for any action class with one tap. These aren't terms
                  buried in a tos — they are the architecture of the product.
                </p>

                <div className="flex flex-wrap items-center gap-5 pt-2">
                  <button type="button" className="btn-ghost" onClick={() => setStep(2)}>← back</button>
                  <button type="button" className="btn-primary ml-auto" onClick={() => setStep(4)}>
                    i understand · continue →
                  </button>
                </div>
              </section>
            ) : null}

            {step === 4 ? (
              <section className="rise rise-1 space-y-8 max-w-2xl">
                <p className="text-lg text-slate leading-relaxed">
                  Connect one source first. Gmail is the highest-leverage entry —
                  the pediatric office, daycare, government, and family all reach
                  you there. You can connect calendar and photos next from the{' '}
                  <span className="font-display italic">connected</span> page.
                </p>

                <div className="space-y-3">
                  {[
                    { id: 'gmail', label: 'gmail', note: 'recommended · highest leverage' },
                    { id: 'outlook', label: 'outlook', note: "if you'd rather use microsoft" },
                    { id: 'icloud', label: 'apple mail', note: 'beta · slower sync' },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className="w-full text-left p-5 rounded-[var(--r-md)] flex items-baseline justify-between border border-rule-strong hover:border-iron hover:bg-bone-soft transition-colors"
                    >
                      <div>
                        <span className="font-display text-[1.6rem] block leading-none">{opt.label}</span>
                        <span className="meta block mt-2">{opt.note}</span>
                      </div>
                      <span className="eyebrow text-madder">connect →</span>
                    </button>
                  ))}
                </div>

                <p className="meta">
                  you approve every scope. i can't read attachments from senders
                  not in your allowlist. you can revoke access in two taps.
                </p>

                <div className="flex flex-wrap items-center gap-5 pt-2">
                  <button type="button" className="btn-ghost" onClick={() => setStep(3)}>← back</button>
                  <button type="button" className="btn-ghost ml-auto" onClick={() => setStep(5)}>
                    skip for now
                  </button>
                  <button type="button" className="btn-primary" onClick={() => setStep(5)}>
                    continue →
                  </button>
                </div>
              </section>
            ) : null}

            {step === 5 ? (
              <section className="rise rise-1 space-y-10 max-w-2xl">
                <p className="text-lg text-slate leading-relaxed">
                  haru works best as a family unit. invite your co-parent and we
                  will share the digest, drafts, and trail across both of you.
                  Either of you can approve actions. Neither of you can be locked
                  out.
                </p>

                <div className="fold">
                  <span className="eyebrow">share this link</span>
                  <p className="font-display text-xl break-all mt-2">
                    haru.family/invite/87c2-d9f5-12a8
                  </p>
                  <div className="flex flex-wrap items-center gap-5 mt-5">
                    <button type="button" className="btn-ghost">copy link</button>
                    <button type="button" className="btn-ghost">show qr</button>
                    <button type="button" className="btn-ghost">send by email</button>
                  </div>
                </div>

                <p className="meta">
                  no co-parent? skip this — actions affecting another person's
                  data will simply require your explicit tap. you can invite
                  later from settings.
                </p>

                <div className="flex flex-wrap items-center gap-5 pt-2">
                  <button type="button" className="btn-ghost" onClick={() => setStep(4)}>← back</button>
                  <Link href="/digest" className="btn-primary ml-auto">
                    finish · open my digest →
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
