import { LongDate } from '~/components/mira/long-date';
import { Folio } from '~/components/mira/folio';
import { StreakLadder, type AutonomyLevel } from '~/components/mira/streak-ladder';

interface AutonomyRow {
  action: string;
  recipient: string;
  level: AutonomyLevel;
  streak: number;
  category: string;
}

const AUTONOMY: AutonomyRow[] = [
  { action: 'reply to email', recipient: 'pediatric office', level: 1, streak: 0, category: 'medical' },
  { action: 'reply to email', recipient: 'daycare', level: 3, streak: 7, category: 'daycare' },
  { action: 'reply to email', recipient: 'grandparents', level: 3, streak: 12, category: 'family' },
  { action: 'reply to email', recipient: 'teachers + caregivers', level: 2, streak: 3, category: 'family' },
  { action: 'place order', recipient: 'amazon · diapers/formula', level: 4, streak: 12, category: 'supplies' },
  { action: 'place order', recipient: 'pharmacy (rexall)', level: 1, streak: 0, category: 'medical' },
  { action: 'create calendar event', recipient: 'family-shared', level: 3, streak: 9, category: 'logistics' },
  { action: 'share photos', recipient: 'pre-approved family list', level: 4, streak: 18, category: 'family' },
  { action: 'fill government form', recipient: 'ei · esdc', level: 2, streak: 1, category: 'paperwork' },
];

export default function SettingsPage() {
  return (
    <div className="space-y-16 lg:space-y-24">
      <header className="rise rise-1 grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12 items-end">
        <div className="lg:col-span-2">
          <span className="eyebrow">№ 08 · settings</span>
          <p className="mt-3"><LongDate /></p>
        </div>
        <div className="lg:col-span-10">
          <h1 className="font-display">
            tune the <em className="text-copper">trust ladder.</em>
          </h1>
        </div>
      </header>

      {/* ACCOUNT */}
      <section className="rise rise-2 grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-y border-hairline py-10">
        <div className="lg:col-span-3">
          <span className="eyebrow">your family</span>
        </div>
        <div className="lg:col-span-9 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
          <div>
            <p className="meta text-ink-soft">primary parent</p>
            <p className="font-display text-2xl mt-1">barton</p>
            <p className="meta mt-1">barton@example.com</p>
          </div>
          <div>
            <p className="meta text-ink-soft">co-parent</p>
            <p className="font-display text-2xl mt-1">invite pending</p>
            <p className="meta mt-1">— send by qr or email</p>
            <button type="button" className="btn-ghost mt-3">send invite</button>
          </div>
          <div>
            <p className="meta text-ink-soft">child</p>
            <p className="font-display text-2xl mt-1">maya · 4 months</p>
            <p className="meta mt-1">born 26 jan 2026</p>
          </div>
          <div>
            <p className="meta text-ink-soft">parenting style</p>
            <p className="font-display text-2xl mt-1">gentle</p>
            <p className="meta mt-1">— affects coach voice + recommendations</p>
          </div>
        </div>
      </section>

      {/* AUTONOMY LADDER */}
      <section className="rise rise-3">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12">
          <div className="lg:col-span-3 lg:sticky lg:top-12 lg:self-start">
            <span className="eyebrow">trust ladder</span>
            <h2 className="mt-5 font-display">
              what i can do <em className="not-italic">on my own.</em>
            </h2>
            <p className="mt-4 text-ink-soft leading-relaxed">
              every action class has its own ladder. l1 means i always ask. l2 means
              i draft and you tap. l3 means i act on the routine cases. l4 means full
              autonomy within your caps and policies.
            </p>
            <p className="mt-4 meta">change any row at any time — i adapt before the next digest.</p>
          </div>

          <div className="lg:col-span-9 space-y-10">
            {AUTONOMY.map((row, idx) => (
              <article key={`${row.action}-${row.recipient}`} className="border-b border-hairline pb-8">
                <div className="grid grid-cols-1 md:grid-cols-12 gap-y-3 md:gap-x-6">
                  <div className="md:col-span-1">
                    <Folio index={idx + 1} />
                  </div>
                  <div className="md:col-span-5">
                    <span className="eyebrow">{row.category}</span>
                    <h3 className="mt-2 font-display text-2xl leading-tight">
                      {row.action}
                    </h3>
                    <p className="meta mt-1">to · {row.recipient}</p>
                  </div>
                  <div className="md:col-span-6">
                    <StreakLadder level={row.level} streak={row.streak} />
                    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                      <button type="button" className="meta hover:text-ink">downgrade</button>
                      <button type="button" className="meta hover:text-ink">freeze here</button>
                      <button type="button" className="meta hover:text-copper-deep">always ask</button>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* CAPS + POLICIES */}
      <section className="rise rise-5 grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-t border-hairline pt-10">
        <div className="lg:col-span-3">
          <span className="eyebrow">spending</span>
          <h2 className="mt-5 font-display">caps + categories</h2>
        </div>
        <div className="lg:col-span-9 grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-6">
          {[
            { label: 'per action', value: '$50' },
            { label: 'per day', value: '$200' },
            { label: 'per month', value: '$1,000' },
          ].map((cap) => (
            <div key={cap.label} className="border-t border-hairline pt-4">
              <span className="eyebrow">{cap.label}</span>
              <p className="font-display text-4xl mt-2 tabular">{cap.value}</p>
              <button type="button" className="btn-ghost mt-3">change</button>
            </div>
          ))}
        </div>
        <div className="lg:col-span-3 lg:col-start-4">
          <p className="meta">categories that always require approval, regardless of streak</p>
        </div>
        <div className="lg:col-span-9 flex flex-wrap gap-x-3 gap-y-2">
          {['medical', 'legal', 'banking', 'travel'].map((c) => (
            <span key={c} className="eyebrow border border-hairline-strong px-3 py-1.5">
              {c}
            </span>
          ))}
        </div>
      </section>

      {/* KILL SWITCH */}
      <section className="rise rise-7 grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-t border-hairline pt-10">
        <div className="lg:col-span-3">
          <span className="eyebrow text-copper-deep">pause</span>
        </div>
        <div className="lg:col-span-9 flex flex-wrap items-baseline gap-x-6 gap-y-4">
          <p className="text-lg text-ink-soft leading-snug max-w-md">
            need me to step back for a while? one tap pauses everything for 24 hours.
            i'll still log signals but i won't draft or act.
          </p>
          <button type="button" className="btn-primary">pause everything · 24h</button>
        </div>
      </section>
    </div>
  );
}
