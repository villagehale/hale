import { LongDate } from '~/components/mira/long-date';
import { Folio } from '~/components/mira/folio';
import { ToneLabel, type EntryTone } from '~/components/mira/tone';

interface TrailEntry {
  id: string;
  date: string;
  time: string;
  category: string;
  tone: EntryTone;
  actor: 'mira' | 'you' | 'co-parent';
  summary: string;
  detail: string;
  reversible: boolean;
}

const ENTRIES: TrailEntry[] = [
  {
    id: 't1',
    date: 'today',
    time: '06:18',
    category: 'pediatric',
    tone: 'done',
    actor: 'mira',
    summary: 'confirmed maya\'s vaccine appointment thursday at 10 am',
    detail: 'replied to clinic, added to calendar, attached pre-visit form',
    reversible: true,
  },
  {
    id: 't2',
    date: 'today',
    time: '05:47',
    category: 'supplies',
    tone: 'done',
    actor: 'mira',
    summary: 'reordered diapers (size 2, one case, $42.99)',
    detail: 'auto-approved · within $50 per-action cap · arrival wednesday',
    reversible: true,
  },
  {
    id: 't3',
    date: 'today',
    time: '04:32',
    category: 'family events',
    tone: 'awaiting',
    actor: 'mira',
    summary: 'drafted rsvp to toronto public library baby story-time',
    detail: 'awaiting your approval — held back because new recipient',
    reversible: false,
  },
  {
    id: 't4',
    date: 'yesterday',
    time: '19:14',
    category: 'family events',
    tone: 'done',
    actor: 'you',
    summary: 'approved playgroup rsvp draft',
    detail: 'mira sent at 19:14 · received reply 21:02',
    reversible: false,
  },
  {
    id: 't5',
    date: 'yesterday',
    time: '14:55',
    category: 'pediatric',
    tone: 'done',
    actor: 'co-parent',
    summary: 'reviewed mira\'s draft for daycare emergency contact update',
    detail: 'approved with one minor edit · sent at 14:57',
    reversible: false,
  },
  {
    id: 't6',
    date: 'yesterday',
    time: '09:02',
    category: 'photos',
    tone: 'done',
    actor: 'mira',
    summary: 'shared 3 photos with grandma · maya + bear',
    detail: 'pre-approved share class · weekly cadence',
    reversible: true,
  },
  {
    id: 't7',
    date: 'monday · may 25',
    time: '11:31',
    category: 'paperwork',
    tone: 'done',
    actor: 'mira',
    summary: 'filed parental leave benefit renewal form (ei)',
    detail: 'auto-filled and submitted · confirmation #EI-2026-058291',
    reversible: false,
  },
];

const ACTOR_COLOR: Record<TrailEntry['actor'], string> = {
  mira: 'text-copper',
  you: 'text-ink',
  'co-parent': 'text-sage',
};

export default function TrailPage() {
  return (
    <div className="space-y-16 lg:space-y-24">
      <header className="rise rise-1 grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12 items-end">
        <div className="lg:col-span-2">
          <span className="eyebrow">№ 06 · trail</span>
          <p className="mt-3"><LongDate /></p>
        </div>
        <div className="lg:col-span-10">
          <h1 className="font-display">
            <em className="italic">everything</em> done
            <br />
            on your behalf.
          </h1>
        </div>
      </header>

      <section className="rise rise-2 grid grid-cols-2 md:grid-cols-4 gap-y-6 gap-x-6 border-y border-hairline py-8">
        {[
          { label: 'this week', value: '47', detail: 'actions' },
          { label: 'auto', value: '38', detail: '81% autonomous' },
          { label: 'you decided', value: '9', detail: '19% drafts' },
          { label: 'reverted', value: '00', detail: 'this month' },
        ].map((stat) => (
          <div key={stat.label}>
            <span className="eyebrow">{stat.label}</span>
            <p className="font-display text-4xl mt-2 tabular">{stat.value}</p>
            <p className="meta mt-1">{stat.detail}</p>
          </div>
        ))}
      </section>

      {/* FILTERS */}
      <section className="rise rise-3 flex flex-wrap items-baseline gap-x-5 gap-y-3 border-b border-hairline pb-6">
        <span className="eyebrow text-ink-soft">show</span>
        <button type="button" className="btn-ghost" aria-current="true">all</button>
        <button type="button" className="meta hover:text-ink">mira only</button>
        <button type="button" className="meta hover:text-ink">parent decisions</button>
        <button type="button" className="meta hover:text-ink">reversible</button>
        <button type="button" className="meta hover:text-ink">pediatric</button>
        <button type="button" className="meta hover:text-ink">supplies</button>
        <span className="ml-auto">
          <button type="button" className="btn-ghost">export csv</button>
        </span>
      </section>

      {/* TIMELINE */}
      <section className="space-y-10">
        {ENTRIES.map((entry, idx) => {
          const delay = `rise-${Math.min(idx + 4, 7)}`;
          return (
            <article key={entry.id} className={`rise ${delay}`}>
              <div className="grid grid-cols-1 md:grid-cols-12 gap-y-3 md:gap-x-6 border-b border-hairline pb-8">
                <div className="md:col-span-1">
                  <Folio index={idx + 1} />
                </div>
                <div className="md:col-span-2">
                  <p className="eyebrow">{entry.date}</p>
                  <p className="meta tabular mt-1">{entry.time}</p>
                </div>
                <div className="md:col-span-2">
                  <p className={`eyebrow ${ACTOR_COLOR[entry.actor]}`}>{entry.actor}</p>
                  <p className="meta mt-1">{entry.category}</p>
                </div>
                <div className="md:col-span-7">
                  <ToneLabel tone={entry.tone} />
                  <p className="mt-3 text-lg text-ink-soft leading-snug">{entry.summary}</p>
                  <p className="mt-2 meta italic">— {entry.detail}</p>
                  {entry.reversible ? (
                    <div className="mt-4">
                      <button type="button" className="btn-ghost">undo</button>
                    </div>
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
