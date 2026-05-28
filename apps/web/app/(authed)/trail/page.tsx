import { PageCorner } from '~/components/haru/page-corner';
import { Folio } from '~/components/haru/folio';
import { ToneLabel, type EntryTone } from '~/components/haru/tone';

interface TrailEntry {
  id: string;
  date: string;
  time: string;
  category: string;
  tone: EntryTone;
  actor: 'haru' | 'you' | 'co-parent';
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
    actor: 'haru',
    summary: "confirmed Maya's vaccine appointment Thursday at 10 am",
    detail: 'replied to clinic, added to calendar, attached pre-visit form',
    reversible: true,
  },
  {
    id: 't2',
    date: 'today',
    time: '05:47',
    category: 'supplies',
    tone: 'done',
    actor: 'haru',
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
    actor: 'haru',
    summary: 'drafted rsvp to Toronto Public Library baby story-time',
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
    detail: 'haru sent at 19:14 · received reply 21:02',
    reversible: false,
  },
  {
    id: 't5',
    date: 'yesterday',
    time: '14:55',
    category: 'pediatric',
    tone: 'done',
    actor: 'co-parent',
    summary: "reviewed haru's draft for daycare emergency contact update",
    detail: 'approved with one minor edit · sent at 14:57',
    reversible: false,
  },
  {
    id: 't6',
    date: 'yesterday',
    time: '09:02',
    category: 'photos',
    tone: 'done',
    actor: 'haru',
    summary: 'shared 3 photos with grandma · maya + bear',
    detail: 'pre-approved share class · weekly cadence',
    reversible: true,
  },
  {
    id: 't7',
    date: 'mon · may 25',
    time: '11:31',
    category: 'paperwork',
    tone: 'done',
    actor: 'haru',
    summary: 'filed parental-leave benefit renewal form (ei)',
    detail: 'auto-filled and submitted · confirmation #EI-2026-058291',
    reversible: false,
  },
];

const ACTOR_LABEL: Record<TrailEntry['actor'], string> = {
  haru: 'haru',
  you: 'you',
  'co-parent': 'co-parent',
};

const ACTOR_TONE: Record<TrailEntry['actor'], string> = {
  haru: 'text-madder',
  you: 'text-iron',
  'co-parent': 'text-indigo',
};

export default function TrailPage() {
  return (
    <div>
      <PageCorner folio="vi" section="trail · the audit log" />

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">audit trail</span>
            <p className="meta mt-2">everything done, by whom, when</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              <span className="text-madder">everything</span> done
              <br />
              on your behalf.
            </h1>
          </div>
        </div>
      </header>

      {/* ── Tally ──────────────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-12 lg:mb-16">
        <div className="grid grid-cols-2 md:grid-cols-4 border-y border-rule">
          {[
            { label: 'this week', value: '47', detail: 'actions' },
            { label: 'auto', value: '38', detail: '81% autonomous' },
            { label: 'you decided', value: '9', detail: '19% drafts' },
            { label: 'reverted', value: '0', detail: 'this month' },
          ].map((stat, idx) => (
            <div
              key={stat.label}
              className={`py-7 px-5 ${idx > 0 ? 'md:border-l border-rule' : ''} ${idx > 1 ? 'border-t md:border-t-0' : ''} ${idx % 2 === 1 ? 'border-l' : ''}`}
            >
              <span className="eyebrow">{stat.label}</span>
              <p className="font-display text-[2.5rem] mt-1 tabular leading-none">
                {stat.value}
              </p>
              <p className="meta mt-3">{stat.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Filters ────────────────────────────────────────────────────── */}
      <section className="rise rise-3 flex flex-wrap items-baseline gap-x-5 gap-y-3 border-b border-rule pb-5 mb-2">
        <span className="eyebrow">show</span>
        <button type="button" className="btn-ghost" aria-current="true">all</button>
        <button type="button" className="btn-ghost">haru only</button>
        <button type="button" className="btn-ghost">parent decisions</button>
        <button type="button" className="btn-ghost">reversible</button>
        <button type="button" className="btn-ghost">pediatric</button>
        <button type="button" className="btn-ghost">supplies</button>
        <span className="ml-auto">
          <button type="button" className="btn-ghost">export csv</button>
        </span>
      </section>

      {/* ── Timeline ───────────────────────────────────────────────────── */}
      <section>
        {ENTRIES.map((entry, idx) => {
          const delay = `rise-${Math.min(idx + 4, 7)}`;
          return (
            <article
              key={entry.id}
              className={`rise ${delay} py-8 lg:py-10 border-t border-rule first:border-t-0`}
            >
              <div className="grid grid-cols-1 md:grid-cols-12 gap-y-3 md:gap-x-8">
                <div className="md:col-span-2">
                  <Folio index={idx + 1} />
                  <p className="eyebrow mt-2 text-iron">{entry.date}</p>
                  <p className="meta tabular mt-1">{entry.time}</p>
                </div>
                <div className="md:col-span-2">
                  <span className={`eyebrow ${ACTOR_TONE[entry.actor]}`}>
                    {ACTOR_LABEL[entry.actor]}
                  </span>
                  <p className="meta mt-1">{entry.category}</p>
                </div>
                <div className="md:col-span-8">
                  <ToneLabel tone={entry.tone} />
                  <p className="mt-3 text-lg text-iron leading-relaxed">{entry.summary}</p>
                  <p className="mt-2 meta italic">— {entry.detail}</p>
                  {entry.reversible ? (
                    <div className="mt-4">
                      <button type="button" className="btn-ghost">undo this</button>
                    </div>
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}
      </section>

      <section className="rise rise-7 mt-16 lg:mt-20 pt-10 border-t border-rule flex flex-wrap items-baseline justify-between gap-y-3 text-faded">
        <p className="meta">end of trail · this week</p>
        <p className="meta">earlier entries available on request</p>
      </section>
    </div>
  );
}
