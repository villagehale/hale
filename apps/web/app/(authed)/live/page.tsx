import { LongDate } from '~/components/mira/long-date';
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
    summary: 'maya\'s clinic confirmed thursday at 10 am, sent visit prep form.',
    decision: 'auto-replied · pre-visit form filled and attached',
  },
  {
    id: '2',
    at: '06:12',
    source: 'apple health',
    tone: 'coach',
    summary: 'maya slept 6h 14m continuous — longest stretch logged.',
    decision: 'logged · queued a coach note for tonight\'s digest',
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
    decision: 'surfaced for human — i don\'t act on calls',
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
    <div className="space-y-16 lg:space-y-24">
      <header className="rise rise-1 grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12 items-end">
        <div className="lg:col-span-2">
          <span className="eyebrow">№ 02 · live</span>
          <p className="mt-3"><LongDate /></p>
        </div>
        <div className="lg:col-span-10">
          <h1 className="font-display">
            <em className="italic">watching,</em> right now.
          </h1>
        </div>
      </header>

      <section className="rise rise-2">
        <div className="flex items-baseline justify-between gap-6 border-y border-hairline py-6">
          <div className="flex items-center gap-3">
            <span
              className="block h-2 w-2 rounded-full bg-forest animate-pulse"
              aria-hidden
            />
            <span className="eyebrow text-ink">listening</span>
            <span className="meta">8 sources connected</span>
          </div>
          <div className="meta tabular hidden md:block">last signal · 06:18 am</div>
        </div>
      </section>

      <section className="space-y-10">
        {STREAM.map((e, idx) => {
          const delay = `rise-${Math.min(idx + 3, 7)}`;
          return (
            <article key={e.id} className={`rise ${delay}`}>
              <div className="grid grid-cols-1 md:grid-cols-12 gap-y-3 md:gap-x-6 border-b border-hairline pb-8">
                <div className="md:col-span-1">
                  <Folio index={idx + 1} />
                </div>
                <div className="md:col-span-2">
                  <span className="meta tabular">{e.at}</span>
                </div>
                <div className="md:col-span-3">
                  <span className="eyebrow">{e.source}</span>
                </div>
                <div className="md:col-span-6">
                  <ToneLabel tone={e.tone} />
                  <p className="mt-3 text-lg text-ink-soft leading-snug">{e.summary}</p>
                  <p className="mt-3 meta italic">— {e.decision}</p>
                </div>
              </div>
            </article>
          );
        })}
      </section>

      <section className="rise rise-7 grid grid-cols-1 lg:grid-cols-12 gap-y-4 lg:gap-x-12 border-t border-hairline pt-8 text-ink-mute">
        <div className="lg:col-span-3">
          <span className="eyebrow">privacy</span>
        </div>
        <div className="lg:col-span-9">
          <p className="text-base leading-relaxed">
            every signal above stays in mira's canadian database. nothing has been
            sent to a third party except where you connected one. your child's name,
            date of birth, and medical details are encrypted at rest with keys you
            can rotate. you can export or delete everything you see here in one tap
            from <span className="font-display italic">trail</span>.
          </p>
        </div>
      </section>
    </div>
  );
}
