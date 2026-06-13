import { PageCorner } from '~/components/haru/page-corner';
import { Folio } from '~/components/haru/folio';
import { StreakLadder, type AutonomyLevel } from '~/components/haru/streak-ladder';

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
  { action: 'place order', recipient: 'amazon · diapers / formula', level: 4, streak: 12, category: 'supplies' },
  { action: 'place order', recipient: 'pharmacy (rexall)', level: 1, streak: 0, category: 'medical' },
  { action: 'create calendar event', recipient: 'family-shared', level: 3, streak: 9, category: 'logistics' },
  { action: 'share photos', recipient: 'pre-approved family list', level: 4, streak: 18, category: 'family' },
  { action: 'fill government form', recipient: 'ei · esdc', level: 2, streak: 1, category: 'paperwork' },
];

export default function SettingsPage() {
  return (
    <div>
      <PageCorner folio="viii" section="settings · tune the trust ladder" />

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">settings</span>
            <p className="meta mt-2">household preferences · trust · caps</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              tune the <span className="text-apricot-deep">trust ladder.</span>
            </h1>
          </div>
        </div>
      </header>

      {/* ── Account / family ───────────────────────────────────────────── */}
      <section className="rise rise-2 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-y border-rule py-10">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">your family</span>
            <p className="meta mt-2">two parents · one child · one almanac</p>
          </div>
          <div className="lg:col-span-9 grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-8">
            <div>
              <p className="meta">primary parent</p>
              <p className="font-display text-[1.5rem] mt-1">barton</p>
              <p className="meta mt-1">barton@example.com</p>
            </div>
            <div>
              <p className="meta">co-parent</p>
              <p className="font-display text-[1.5rem] mt-1">invite pending</p>
              <p className="meta mt-1">— send by qr or email</p>
              <button type="button" className="btn-ghost mt-3">send invite</button>
            </div>
            <div>
              <p className="meta">child</p>
              <p className="font-display text-[1.5rem] mt-1">maya · 4 months</p>
              <p className="meta mt-1">born 26 jan 2026</p>
            </div>
            <div>
              <p className="meta">parenting style</p>
              <p className="font-display text-[1.5rem] mt-1">gentle</p>
              <p className="meta mt-1">— affects coach voice + recommendations</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Autonomy ladder ────────────────────────────────────────────── */}
      <section className="rise rise-3 mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12">
          <div className="lg:col-span-3 lg:sticky lg:top-12 lg:self-start">
            <span className="eyebrow text-spruce">trust ladder</span>
            <h2 className="mt-5 font-display">
              what i can do <span className="text-apricot-deep">on my own.</span>
            </h2>
            <p className="mt-4 text-slate-green leading-relaxed">
              Every action class has its own ladder. L1 means I always ask. L2
              means I draft and you tap. L3 means I act on the routine cases.
              L4 means full autonomy within your caps and policies.
            </p>
            <p className="mt-4 meta">change any row at any time — i adapt before the next digest.</p>
          </div>

          <div className="lg:col-span-9">
            {AUTONOMY.map((row, idx) => (
              <article
                key={`${row.action}-${row.recipient}`}
                className="py-7 border-t border-rule first:border-t-0"
              >
                <div className="grid grid-cols-1 md:grid-cols-12 gap-y-3 md:gap-x-8">
                  <div className="md:col-span-1">
                    <Folio index={idx + 1} />
                  </div>
                  <div className="md:col-span-5">
                    <span className="eyebrow">{row.category}</span>
                    <h3 className="mt-2 font-display text-[1.4rem] leading-tight">
                      {row.action}
                    </h3>
                    <p className="meta mt-1">to · {row.recipient}</p>
                  </div>
                  <div className="md:col-span-6">
                    <StreakLadder level={row.level} streak={row.streak} />
                    <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
                      <button type="button" className="btn-ghost">downgrade</button>
                      <button type="button" className="btn-ghost">freeze here</button>
                      <button type="button" className="btn-ghost text-apricot-deep">always ask</button>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── Caps + policies ────────────────────────────────────────────── */}
      <section className="rise rise-5 mb-20 pt-10 border-t border-rule">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">spending</span>
            <h2 className="mt-5 font-display">caps & categories</h2>
            <p className="mt-4 text-slate-green leading-relaxed">
              The numerical limits and category-level rules that overrule the
              trust ladder. Edits take effect immediately.
            </p>
          </div>
          <div className="lg:col-span-9 space-y-10">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-rule">
              {[
                { label: 'per action', value: '$50' },
                { label: 'per day', value: '$200' },
                { label: 'per month', value: '$1,000' },
              ].map((cap) => (
                <div key={cap.label} className="bg-linen p-6">
                  <span className="eyebrow">{cap.label}</span>
                  <p className="font-display text-[2.5rem] mt-1 tabular leading-none">
                    {cap.value}
                  </p>
                  <button type="button" className="btn-ghost mt-3">change</button>
                </div>
              ))}
            </div>

            <div>
              <p className="meta mb-3">categories that always require approval, regardless of streak</p>
              <div className="flex flex-wrap gap-x-3 gap-y-2">
                {['medical', 'legal', 'banking', 'travel'].map((c) => (
                  <span key={c} className="pill">{c}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Kill switch ────────────────────────────────────────────────── */}
      <section className="rise rise-7 pt-10 border-t border-rule">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 panel-apricot-tint">
          <div className="lg:col-span-3">
            <span className="eyebrow text-apricot-deep">pause</span>
            <p className="meta mt-2">a single tap</p>
          </div>
          <div className="lg:col-span-9 flex flex-wrap items-center gap-x-8 gap-y-4">
            <p className="text-lg text-spruce leading-snug max-w-md">
              Need me to step back for a while? One tap pauses everything for
              twenty-four hours. I'll still log signals but I won't draft or
              act.
            </p>
            <button type="button" className="btn-primary">pause for 24h →</button>
          </div>
        </div>
      </section>
    </div>
  );
}
