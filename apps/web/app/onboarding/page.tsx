'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { saveOnboardingChildren } from '~/lib/onboarding/persist';
import {
  type ChildInput,
  type ValidateChildResult,
  type ValidatedChild,
  unionStages,
  validateChild,
} from '~/lib/onboarding/children';

type Step = 1 | 2 | 3 | 4 | 5;

const STEP_META: Record<Step, { folio: string; section: string; title: string }> = {
  1: { folio: '01', section: 'step one of five', title: 'welcome' },
  2: { folio: '02', section: 'step two of five', title: 'tell me about your children' },
  3: { folio: '03', section: 'step three of five', title: 'how trial mode works' },
  4: { folio: '04', section: 'step four of five', title: 'connect one source' },
  5: { folio: '05', section: 'step five of five', title: 'invite your co-parent' },
};

interface ChildRow extends ChildInput {
  key: number;
}

const STAGE_BLURB: Record<string, string> = {
  newborn: 'the newborn months — feeds, sleep, the pediatric office',
  toddler: 'the toddler years — daycare, milestones, the small logistics',
  child: 'the school years — classroom, activities, forms',
  teenager: 'the teenage years — independence, scheduling, lighter touch',
};

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>(1);
  const [children, setChildren] = useState<ChildRow[]>([{ key: 0, name: '', dateOfBirth: '' }]);
  const [parentingStyle, setParentingStyle] = useState<string>('gentle');
  const [saveState, setSaveState] = useState<
    { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'preview' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const meta = STEP_META[step];

  // Live derivation as birthdates are typed — never stored, always a function
  // of date_of_birth. A complete-and-valid child contributes its stage to the
  // preview; partial rows are simply ignored until they're valid.
  const validChildren = useMemo<ValidatedChild[]>(
    () =>
      children
        .map((c) => validateChild(c))
        .filter((r): r is Extract<ValidateChildResult, { ok: true }> => r.ok)
        .map((r) => r.child),
    [children],
  );
  const previewStages = useMemo(() => unionStages(validChildren), [validChildren]);

  function updateChild(key: number, patch: Partial<ChildInput>) {
    setChildren((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addChild() {
    setChildren((rows) => [...rows, { key: (rows.at(-1)?.key ?? 0) + 1, name: '', dateOfBirth: '' }]);
  }

  function removeChild(key: number) {
    setChildren((rows) => (rows.length === 1 ? rows : rows.filter((r) => r.key !== key)));
  }

  async function handleContinue() {
    setSaveState({ kind: 'saving' });
    const result = await saveOnboardingChildren(children.map(({ name, dateOfBirth }) => ({ name, dateOfBirth })));
    if (result.status === 'saved') {
      setSaveState({ kind: 'saved' });
    } else if (result.status === 'preview') {
      setSaveState({ kind: 'preview' });
    } else {
      setSaveState({ kind: 'error', message: `child ${result.index + 1}: ${result.error.replace(/_/g, ' ')}` });
      return;
    }
    setStep(3);
  }

  const canContinue = validChildren.length > 0 && validChildren.length === children.filter((c) => c.name.trim() || c.dateOfBirth).length;

  return (
    <div className="min-h-screen bg-linen">
      {/* Running head — book top edge */}
      <header className="shell flex items-baseline justify-between pt-6 pb-4 border-b border-rule">
        <Link href="/" className="font-display text-xl">Hale</Link>

        <div className="flex items-baseline gap-3">
          <span className="eyebrow">enrolment</span>
          <div className="flex items-center gap-1.5" aria-hidden>
            {[1, 2, 3, 4, 5].map((s) => (
              <span
                key={s}
                className="block h-px w-6"
                style={{
                  background: s <= step ? 'var(--color-spruce)' : 'var(--color-rule-strong)',
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
                <p className="text-xl lg:text-[1.4rem] leading-snug text-slate-green">
                  Hale is the village your family lost — across every stage of
                  childhood, from the newborn weeks through the teenage years. I
                  find the genuinely good local things to do, matched to where
                  each child actually is, and then make them happen — the
                  registering, the calendar, the reminders, the gear. I carry
                  the small things so you can be present.
                </p>
                <p className="text-lg text-slate-green leading-relaxed">
                  Set-up takes about four minutes. I will not do anything autonomously
                  for the first seven days, no matter what you tell me here. That
                  is what step three is about.
                </p>

                <div className="panel-apricot-tint">
                  <span className="eyebrow text-apricot-deep">a guarantee</span>
                  <p className="mt-2 text-slate-green">
                    Your children's names, dates of birth, and medical details are
                    encrypted at rest with keys you can rotate. Your family's data
                    stays in Canada — that part is non-negotiable.
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
                <p className="text-lg text-slate-green leading-relaxed">
                  Add each of your children — a name (or nickname) and a date of
                  birth. I tailor everything to where each child actually is, so a
                  newborn and a teenager in the same family both get the right care.
                </p>

                <div className="space-y-6">
                  {children.map((child, idx) => {
                    const validated = validateChild(child);
                    const stage = validated.ok ? validated.child.stage : null;
                    return (
                      <div
                        key={child.key}
                        className="p-5 rounded-[var(--r-md)] border border-rule-strong space-y-5"
                      >
                        <div className="flex items-baseline justify-between">
                          <span className="eyebrow">child {idx + 1}</span>
                          {children.length > 1 ? (
                            <button
                              type="button"
                              className="link meta"
                              onClick={() => removeChild(child.key)}
                            >
                              remove
                            </button>
                          ) : null}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                          <div>
                            <label htmlFor={`child-name-${child.key}`} className="eyebrow">
                              name or nickname
                            </label>
                            <input
                              id={`child-name-${child.key}`}
                              type="text"
                              className="field mt-2"
                              value={child.name}
                              onChange={(e) => updateChild(child.key, { name: e.currentTarget.value })}
                              placeholder="maya"
                              autoComplete="off"
                              spellCheck={false}
                            />
                          </div>

                          <div>
                            <label htmlFor={`child-dob-${child.key}`} className="eyebrow">
                              date of birth
                            </label>
                            <input
                              id={`child-dob-${child.key}`}
                              type="date"
                              className="field mt-2"
                              value={child.dateOfBirth}
                              max={new Date().toISOString().slice(0, 10)}
                              onChange={(e) => updateChild(child.key, { dateOfBirth: e.currentTarget.value })}
                              autoComplete="bday"
                            />
                          </div>
                        </div>

                        {child.dateOfBirth ? (
                          <p className="meta" aria-live="polite">
                            {stage ? (
                              <>
                                <span className="text-spruce">{stage}</span> · {STAGE_BLURB[stage]}
                              </>
                            ) : (
                              <span className="text-apricot-deep">
                                {validated.ok ? '' : describeError(validated.error)}
                              </span>
                            )}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}

                  <button type="button" className="btn-ghost" onClick={addChild}>
                    + add another child
                  </button>
                </div>

                {previewStages.length > 0 ? (
                  <div className="panel-oat">
                    <span className="eyebrow text-spruce">i'll tailor to</span>
                    <p className="font-display text-xl mt-2">
                      {previewStages.join(' + ')}
                    </p>
                    <p className="meta mt-1">
                      derived live from each birthday — it shifts on its own as they grow.
                    </p>
                  </div>
                ) : null}

                <fieldset>
                  <legend className="eyebrow">how do you want to parent?</legend>
                  <p className="meta mt-1">affects coach voice + which frameworks i lean on. you can change this any time.</p>
                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {[
                      { id: 'gentle', label: 'gentle', note: 'lansbury · markham' },
                      { id: 'attachment', label: 'attachment', note: 'sears · siegel' },
                      { id: 'structured', label: 'structured', note: 'karp · ferber' },
                      { id: 'undecided', label: 'still figuring it out', note: "I'll be neutral" },
                    ].map((opt) => {
                      const selected = parentingStyle === opt.id;
                      return (
                        <label
                          key={opt.id}
                          className={`cursor-pointer text-left p-4 rounded-[var(--r-md)] transition-colors block ${
                            selected
                              ? 'bg-oat border border-spruce'
                              : 'border border-rule-strong hover:border-spruce'
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

                {saveState.kind === 'error' ? (
                  <p className="meta text-apricot-deep" role="alert">{saveState.message}</p>
                ) : null}

                <div className="flex flex-wrap items-center gap-5 pt-2">
                  <button type="button" className="btn-ghost" onClick={() => setStep(1)}>← back</button>
                  <button
                    type="button"
                    className="btn-primary ml-auto"
                    onClick={handleContinue}
                    disabled={!canContinue || saveState.kind === 'saving'}
                  >
                    {saveState.kind === 'saving' ? 'saving…' : 'continue →'}
                  </button>
                </div>
              </section>
            ) : null}

            {step === 3 ? (
              <section className="rise rise-1 space-y-10 max-w-2xl">
                {saveState.kind === 'preview' ? (
                  <output className="panel-apricot-tint block">
                    <span className="eyebrow text-apricot-deep">preview only</span>
                    <p className="mt-2 text-slate-green">
                      You're in a development preview — sign-in isn't configured yet,
                      so nothing you entered was saved. The stages above are derived
                      live from the birthdates so you can see how Hale would tailor.
                    </p>
                  </output>
                ) : null}

                <p className="text-xl lg:text-[1.4rem] leading-snug text-slate-green">
                  For the first seven days, Hale drafts every action — but never
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

                <p className="text-lg text-slate-green leading-relaxed">
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
                <p className="text-lg text-slate-green leading-relaxed">
                  Connect one source first. Gmail is the highest-leverage entry —
                  the pediatric office, daycare, school, government, and family all
                  reach you there. You can connect calendar and photos next from the{' '}
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
                      className="w-full text-left p-5 rounded-[var(--r-md)] flex items-baseline justify-between border border-rule-strong hover:border-spruce hover:bg-linen transition-colors"
                    >
                      <div>
                        <span className="font-display text-[1.6rem] block leading-none">{opt.label}</span>
                        <span className="meta block mt-2">{opt.note}</span>
                      </div>
                      <span className="eyebrow text-apricot-deep">connect →</span>
                    </button>
                  ))}
                </div>

                <p className="meta">
                  you approve every scope. I can't read attachments from senders
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
                <p className="text-lg text-slate-green leading-relaxed">
                  Hale works best as a family unit. invite your co-parent and we
                  will share the digest, drafts, and trail across both of you.
                  Either of you can approve actions. Neither of you can be locked
                  out.
                </p>

                <div className="panel">
                  <span className="eyebrow">share this link</span>
                  <p className="font-display text-xl break-all mt-2">
                    hale.family/invite/87c2-d9f5-12a8
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

function describeError(error: string): string {
  switch (error) {
    case 'dob_future':
      return "that's in the future — check the year";
    case 'dob_too_old':
      return 'Hale is for children under eighteen';
    case 'dob_invalid':
      return "that date doesn't look right";
    default:
      return '';
  }
}
