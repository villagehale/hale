import Link from 'next/link';
import { PageCorner } from '~/components/haru/page-corner';
import { Folio } from '~/components/haru/folio';
import { ToneLabel, type EntryTone } from '~/components/haru/tone';
import { StreakLadder, type AutonomyLevel } from '~/components/haru/streak-ladder';
import { Marquee } from '~/components/haru/marquee';

interface Entry {
  id: string;
  tone: EntryTone;
  detail: string;
  category: string;
  level: AutonomyLevel;
  streak: number;
  body: string;
  primaryAction?: { label: string };
  secondaryAction?: { label: string };
}

const ENTRIES: Entry[] = [
  {
    id: 'pediatric',
    tone: 'done',
    detail: '4:12 am',
    category: 'pediatric',
    level: 3,
    streak: 8,
    body:
      "i confirmed maya's vaccine appointment for thursday at ten. the pre-visit form is filled and attached. the office should send a reminder eight in the morning the day before; i'll watch for it.",
    secondaryAction: { label: 'undo' },
  },
  {
    id: 'diapers',
    tone: 'done',
    detail: '4:14 am',
    category: 'supplies',
    level: 4,
    streak: 12,
    body:
      'i reordered diapers (size two, one case, $42.99) and routed it to your usual address. arriving wednesday. i can skip the next order if you would rather hold off.',
    secondaryAction: { label: 'undo' },
  },
  {
    id: 'library',
    tone: 'awaiting',
    detail: 'before saturday',
    category: 'family events',
    level: 2,
    streak: 3,
    body:
      'the toronto public library wrote about baby story-time on saturday at ten thirty. i drafted a short yes — should i send it and add the event?',
    primaryAction: { label: 'approve and send' },
    secondaryAction: { label: 'skip' },
  },
  {
    id: 'sleep',
    tone: 'coach',
    detail: 'a note for context',
    category: 'coach',
    level: 1,
    streak: 0,
    body:
      'maya had her first six-hour continuous sleep block last night. if you want, i can brief you on what tends to happen around four months — sleep often briefly regresses as cycles reorganize. nothing wrong, just useful to know.',
    primaryAction: { label: 'brief me' },
  },
  {
    id: 'lab',
    tone: 'needs-you',
    detail: 'i cannot act on this',
    category: 'pediatric',
    level: 1,
    streak: 0,
    body:
      "your pediatrician's office sent a message asking you to call about maya's lab results. i don't act on phone calls — open it when you can.",
    primaryAction: { label: 'open email' },
  },
];

export default function DigestPage() {
  return (
    <div>
      <PageCorner folio="i" section="digest · today" />

      {/* ── Headline ────────────────────────────────────────────────────── */}
      <header className="rise rise-1 mb-16 lg:mb-24">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">today's letter</span>
            <p className="meta mt-2">for the family · before breakfast</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              five things <span className="text-madder">on the table</span> this morning.
            </h1>
          </div>
        </div>
      </header>

      {/* ── Tally ───────────────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-16 lg:mb-24">
        <div className="grid grid-cols-2 md:grid-cols-4 border-y border-rule">
          {[
            { label: 'i handled', value: '3', detail: 'on your behalf' },
            { label: 'awaiting you', value: '1', detail: 'tap to decide' },
            { label: 'needs you', value: '1', detail: 'i cannot act' },
            { label: 'today · cost', value: '$0.31', detail: '14 passes' },
          ].map((stat, idx) => (
            <div
              key={stat.label}
              className={`py-7 px-5 ${idx > 0 ? 'md:border-l border-rule' : ''} ${idx > 1 ? 'border-t md:border-t-0' : ''} ${idx % 2 === 1 ? 'border-l' : ''}`}
            >
              <span className="eyebrow">{stat.label}</span>
              <p className="font-display text-[2.5rem] lg:text-[3rem] mt-1 tabular leading-none">
                {stat.value}
              </p>
              <p className="meta mt-3">{stat.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Entries ─────────────────────────────────────────────────────── */}
      <section>
        {ENTRIES.map((entry, idx) => {
          const delay = `rise-${Math.min(idx + 3, 7)}`;
          return (
            <article
              key={entry.id}
              className={`rise ${delay} py-12 lg:py-14 border-t border-rule first:border-t-0`}
            >
              <div className="grid grid-cols-1 md:grid-cols-12 gap-y-6 md:gap-x-8">
                <div className="md:col-span-2">
                  <Folio index={idx + 1} />
                  <p className="mt-3 eyebrow text-iron">{entry.category}</p>
                  <p className="meta mt-1">{entry.detail}</p>
                </div>

                <div className="md:col-span-7">
                  <ToneLabel tone={entry.tone} />
                  <p className="mt-4 text-lg lg:text-[1.15rem] leading-relaxed text-iron">
                    {entry.body}
                  </p>

                  {(entry.primaryAction || entry.secondaryAction) && (
                    <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
                      {entry.primaryAction ? (
                        <button type="button" className="btn-primary">
                          {entry.primaryAction.label}
                        </button>
                      ) : null}
                      {entry.secondaryAction ? (
                        <button type="button" className="btn-ghost">
                          {entry.secondaryAction.label}
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>

                <div className="md:col-span-3 md:border-l md:border-rule md:pl-6">
                  <span className="eyebrow">trust ladder</span>
                  <div className="mt-3">
                    <StreakLadder level={entry.level} streak={entry.streak} />
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </section>

      {/* ── Tomorrow + colophon ─────────────────────────────────────────── */}
      <section className="rise rise-7 mt-16 lg:mt-24 space-y-10">
        <div className="border-t border-rule pt-10 grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">tomorrow</span>
            <p className="meta mt-2">on the horizon</p>
          </div>
          <div className="lg:col-span-9">
            <p className="text-lg text-iron leading-relaxed">
              Two things on the horizon — maya's vaccine visit thursday at ten,
              and the parental-leave benefit renewal due wednesday. I'll handle
              the renewal paperwork tonight and surface anything you need to
              sign by morning.
            </p>
            <div className="mt-6">
              <Link href="/live" className="btn-ghost">watch live →</Link>
            </div>
          </div>
        </div>

        <Marquee
          items={[
            'haru ran 14 agent passes',
            '$0.31 today · $4.20 month-to-date',
            'trial day 3 of 7',
            'no autonomous medical actions ever',
            'pipeda · canadian data residency',
          ]}
        />

        <div className="flex flex-wrap items-baseline justify-between gap-y-3 text-faded">
          <p className="meta">colophon · digest no. 003 · printed at 04:30 am</p>
          <p className="meta">edited by haru · approved by no one yet</p>
        </div>
      </section>
    </div>
  );
}
