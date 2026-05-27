import Link from 'next/link';
import { LongDate } from '~/components/mira/long-date';
import { Folio } from '~/components/mira/folio';
import { ToneLabel, type EntryTone } from '~/components/mira/tone';
import { StreakLadder, type AutonomyLevel } from '~/components/mira/streak-ladder';
import { Marquee } from '~/components/mira/marquee';

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
    detail: '04:12',
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
    detail: '04:14',
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
    category: 'coaching',
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
    <div className="space-y-16 lg:space-y-24">
      {/* HERO */}
      <header className="rise rise-1 grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12 items-end">
        <div className="lg:col-span-2">
          <span className="eyebrow">№ 01 · today</span>
          <p className="mt-3"><LongDate /></p>
        </div>
        <div className="lg:col-span-10">
          <h1 className="font-display">
            today's <em className="text-copper not-italic">digest</em>
          </h1>
        </div>
      </header>

      {/* SUMMARY STRIP */}
      <section className="rise rise-2 grid grid-cols-2 md:grid-cols-4 gap-y-6 gap-x-6 border-y border-hairline py-8">
        {[
          { label: 'handled', value: '03', detail: 'on your behalf' },
          { label: 'awaiting', value: '01', detail: 'tap to decide' },
          { label: 'needs you', value: '01', detail: 'i cannot act' },
          { label: "today's cost", value: '$0.31', detail: '14 agent passes' },
        ].map((stat) => (
          <div key={stat.label}>
            <span className="eyebrow">{stat.label}</span>
            <p className="font-display text-4xl mt-2 tabular">{stat.value}</p>
            <p className="meta mt-1">{stat.detail}</p>
          </div>
        ))}
      </section>

      {/* ENTRIES */}
      <section className="space-y-12 lg:space-y-16">
        {ENTRIES.map((entry, idx) => {
          const delay = `rise-${Math.min(idx + 3, 7)}`;
          return (
            <article key={entry.id} className={`rise ${delay}`}>
              <div className="grid grid-cols-1 md:grid-cols-12 gap-y-4 md:gap-x-6">
                <div className="md:col-span-1">
                  <Folio index={idx + 1} />
                </div>

                <div className="md:col-span-8">
                  <ToneLabel tone={entry.tone} detail={entry.detail} />

                  <p className="mt-5 text-lg lg:text-xl leading-snug text-ink-soft">
                    {entry.body}
                  </p>

                  {(entry.primaryAction || entry.secondaryAction) && (
                    <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
                      {entry.primaryAction ? (
                        <button type="button" className="btn-ghost">
                          {entry.primaryAction.label}
                        </button>
                      ) : null}
                      {entry.secondaryAction ? (
                        <button type="button" className="meta hover:text-ink">
                          {entry.secondaryAction.label}
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>

                <div className="md:col-span-3 md:border-l md:border-hairline md:pl-6">
                  <span className="eyebrow">{entry.category}</span>
                  <div className="mt-3">
                    <StreakLadder level={entry.level} streak={entry.streak} />
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </section>

      {/* CLOSING + TICKER */}
      <section className="rise rise-7 space-y-10">
        <div className="border-t border-hairline pt-8 grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">tomorrow</span>
          </div>
          <div className="lg:col-span-9">
            <p className="text-lg text-ink-soft leading-snug">
              two things on the horizon — maya's vaccine visit thursday at ten, and the
              parental-leave benefit renewal due wednesday. i'll handle the renewal
              paperwork tonight and surface anything you need to sign by morning.
            </p>
            <div className="mt-6">
              <Link href="/live" className="btn-ghost">watch live →</Link>
            </div>
          </div>
        </div>

        <Marquee
          items={[
            'mira ran 14 agent passes',
            '$0.31 today · $4.20 month-to-date',
            'trial day 3 of 7',
            'no autonomous medical actions ever',
            'pipeda compliant · canadian data residency',
          ]}
        />
      </section>
    </div>
  );
}
