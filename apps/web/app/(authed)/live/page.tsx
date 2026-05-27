import { PageCorner } from '~/components/mira/page-corner';
import { Folio } from '~/components/mira/folio';
import { ToneLabel, type EntryTone } from '~/components/mira/tone';

interface LiveEvent {
  id: string;
  at: string;
  source: string;
  tone: EntryTone;
  summary: string;
  decision: string;
}

const STREAM: LiveEvent[] = [
  {
    id: '1',
    at: '06:18',
    source: 'gmail · pediatric',
    tone: 'done',
    summary: "maya's clinic confirmed thursday at 10 am, sent visit prep form.",
    decision: 'auto-replied · pre-visit form filled and attached',
  },
  {
    id: '2',
    at: '06:12',
    source: 'apple health',
    tone: 'coach',
    summary: 'maya slept 6h 14m continuous — longest stretch logged.',
    decision: "logged · queued a coach note for tonight's digest",
  },
  {
    id: '3',
    at: '05:47',
    source: 'stripe · subscription',
    tone: 'done',
    summary: 'diaper subscription renewed (size 2, one case, $42.99).',
    decision: 'auto-approved · within $50 per-action cap',
  },
  {
    id: '4',
    at: '04:32',
    source: 'gmail · tpl',
    tone: 'awaiting',
    summary: 'toronto public library invited maya to baby story-time saturday 10:30.',
    decision: 'draft ready · awaiting your tap (asked because new recipient)',
  },
  {
    id: '5',
    at: '02:11',
    source: 'gmail · pediatric',
    tone: 'needs-you',
    summary: 'pediatric office sent "please call us about lab results".',
    decision: "surfaced for human — i don't act on calls",
  },
  {
    id: '6',
    at: '00:04',
    source: 'apple photos',
    tone: 'coach',
    summary: '12 new photos from yesterday — 3 are likely milestones (independent fork use).',
    decision: 'tagged · ready for grandparent share when you approve',
  },
];

export default function LivePage() {
  return (
    <div>
      <PageCorner folio="ii" section="live · listening" />

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">live signals</span>
            <p className="meta mt-2">arriving in chronological order</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              what i am <span className="text-madder">noticing</span>,
              <br />
              right now.
            </h1>
          </div>
        </div>
      </header>

      {/* ── Heartbeat ───────────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-12 lg:mb-16">
        <div className="flex flex-wrap items-baseline justify-between gap-y-3 border-y border-rule py-5">
          <div className="flex items-center gap-3">
            <span
              className="block h-2 w-2 rounded-full bg-moss animate-pulse"
              aria-hidden
              style={{ background: 'var(--color-moss)' }}
            />
            <span className="eyebrow text-iron">listening</span>
            <span className="meta">8 sources connected</span>
          </div>
          <span className="meta tabular">last signal · 06:18 am</span>
        </div>
      </section>

      {/* ── Stream ──────────────────────────────────────────────────────── */}
      <section>
        {STREAM.map((e, idx) => {
          const delay = `rise-${Math.min(idx + 3, 7)}`;
          return (
            <article
              key={e.id}
              className={`rise ${delay} py-8 lg:py-10 border-t border-rule first:border-t-0`}
            >
              <div className="grid grid-cols-1 md:grid-cols-12 gap-y-3 md:gap-x-8">
                <div className="md:col-span-2">
                  <Folio index={idx + 1} />
                  <p className="meta tabular mt-2">{e.at}</p>
                </div>
                <div className="md:col-span-3">
                  <span className="eyebrow">source</span>
                  <p className="meta text-iron mt-1">{e.source}</p>
                </div>
                <div className="md:col-span-7">
                  <ToneLabel tone={e.tone} />
                  <p className="mt-3 text-lg text-iron leading-relaxed">{e.summary}</p>
                  <p className="mt-3 meta italic">— {e.decision}</p>
                </div>
              </div>
            </article>
          );
        })}
      </section>

      {/* ── Privacy note ───────────────────────────────────────────────── */}
      <section className="rise rise-7 mt-16 lg:mt-24 pt-10 border-t border-rule">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-4 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">privacy</span>
            <p className="meta mt-2">a standing promise</p>
          </div>
          <div className="lg:col-span-9 text-slate text-lg leading-relaxed">
            Every signal above stays in mira's Canadian database. Nothing has
            been sent to a third party except where you connected one. Your
            child's name, date of birth, and medical details are encrypted at
            rest with keys you can rotate. You can export or delete everything
            you see here in one tap from the <span className="font-display italic">trail</span>.
          </div>
        </div>
      </section>
    </div>
  );
}
