import { PageCorner } from '~/components/hearth/page-corner';
import { Folio } from '~/components/hearth/folio';

interface Source {
  id: string;
  name: string;
  why: string;
  reads: string[];
  acts: string[];
  status: 'connected' | 'available' | 'optional';
}

const TIERS: Array<{
  tier: number;
  folio: string;
  eyebrow: string;
  title: string;
  description: string;
  sources: Source[];
}> = [
  {
    tier: 1,
    folio: 'i',
    eyebrow: 'tier one',
    title: 'the universal sources',
    description:
      'The four things every family already has. Hearth begins with these — connecting one is enough to see value in the first hour.',
    sources: [
      {
        id: 'gmail',
        name: 'gmail',
        why: 'so i can read the pediatric office, daycare, family, and government messages.',
        reads: ['inbox subjects + bodies', 'attachment metadata', 'thread context'],
        acts: ['draft replies (after seven days)', 'send replies (after autonomy unlock)'],
        status: 'connected',
      },
      {
        id: 'gcal',
        name: 'Google Calendar',
        why: 'so i can confirm appointments on the right day without conflicts.',
        reads: ['events', 'attendees', 'free/busy windows'],
        acts: ['create events', 'update or cancel events'],
        status: 'connected',
      },
      {
        id: 'photos',
        name: 'Google Photos',
        why: 'so i can notice milestones and curate weekly shares for grandparents — read only.',
        reads: ['photo metadata + ml tags', 'date + location (if you share it)'],
        acts: ['curate shares to your approved recipients'],
        status: 'available',
      },
      {
        id: 'stripe',
        name: 'stripe',
        why: 'so i can reorder diapers, formula, and supplies on your card.',
        reads: ['payment methods', 'subscription state'],
        acts: ['place orders within your spending caps'],
        status: 'available',
      },
    ],
  },
  {
    tier: 2,
    folio: 'ii',
    eyebrow: 'tier two',
    title: 'the family devices',
    description:
      "The things that make this product different from every parenting app. Real-time signals from the devices already in your home — a baby monitor, a sleep tracker, a watch — matched to where each child is.",
    sources: [
      {
        id: 'apple-health',
        name: 'apple health',
        why: 'for maya, your own sleep, and stress signals during hard weeks.',
        reads: ['baby + parent sleep duration', 'parent hrv (for crisis-quiet mode)'],
        acts: ['surface coaching context', 'auto-quiet during low-sleep weeks'],
        status: 'available',
      },
      {
        id: 'owlet',
        name: 'owlet (monitor)',
        why: 'so i can flag unusual movement and log overnight context.',
        reads: ['heart rate + spo2 events', 'motion windows'],
        acts: ['log episodes', "never send alerts on owlet's behalf"],
        status: 'optional',
      },
      {
        id: 'hatch',
        name: 'hatch (sleep)',
        why: 'to log routine and detect patterns — not to start ferber on you.',
        reads: ['sleep/wake events', 'sound + light routine state'],
        acts: ['log routine consistency', 'suggest tweaks via coach only'],
        status: 'optional',
      },
      {
        id: 'snoo',
        name: 'snoo (bassinet)',
        why: 'logs the night so coach can speak in specifics.',
        reads: ['session state', 'level transitions'],
        acts: ['log only · no remote bassinet control ever'],
        status: 'optional',
      },
    ],
  },
  {
    tier: 3,
    folio: 'iii',
    eyebrow: 'tier three',
    title: 'the optional sources',
    description:
      'The integrations that make Hearth indispensable over time. You can connect any of these at any pace — i save you time per connection, not all at once.',
    sources: [
      {
        id: 'cra',
        name: 'cra (canada revenue agency)',
        why: 'for the child benefit, climate action incentive, and tax credit paperwork.',
        reads: ['notice of assessment summaries (you upload)', 'benefit statements'],
        acts: ['draft forms · never file without your tap'],
        status: 'optional',
      },
      {
        id: 'esdc',
        name: 'esdc (parental leave)',
        why: 'parental leave benefits, top-up applications, status checks.',
        reads: ['benefit status', 'pay-stub summaries (you upload)'],
        acts: ['draft applications + renewals'],
        status: 'optional',
      },
      {
        id: 'pharmacy',
        name: 'shoppers · rexall',
        why: 'medication reminders, refill cadence, vaccine records.',
        reads: ['prescription records', 'refill schedule'],
        acts: ['request refills with your tap'],
        status: 'optional',
      },
      {
        id: 'pediatric-portal',
        name: 'pediatric clinic portal',
        why: 'where your pediatrician offers a portal, Hearth can book + retrieve.',
        reads: ['appointment slots', 'visit summaries'],
        acts: ['book routine appointments (with browser automation)'],
        status: 'optional',
      },
    ],
  },
];

const STATUS_LABEL: Record<Source['status'], string> = {
  connected: 'connected',
  available: 'connect',
  optional: 'connect later',
};

export default function ConnectedPage() {
  return (
    <div>
      <PageCorner folio="vii" section="connected · three tiers" />

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">integrations</span>
            <p className="meta mt-2">every read and every action, named</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              three tiers <span className="text-apricot-deep">of trust.</span>
            </h1>
          </div>
        </div>
      </header>

      {/* ── Read this first ────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-20 panel">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-4 lg:gap-x-8">
          <div className="lg:col-span-3">
            <span className="eyebrow text-spruce">read this first</span>
          </div>
          <div className="lg:col-span-9 text-spruce text-lg leading-relaxed">
            For every source you connect, I show you exactly what I read and
            exactly what I do with it. Nothing is shared with a third party
            except where you connect one. You can disconnect any source at any
            time and I will forget anything that source contributed within
            twenty-four hours.
          </div>
        </div>
      </section>

      {/* ── Tiers ──────────────────────────────────────────────────────── */}
      {TIERS.map((tier, tIdx) => (
        <section
          key={tier.tier}
          className={`rise ${tIdx === 0 ? 'rise-3' : tIdx === 1 ? 'rise-5' : 'rise-7'} mb-20`}
        >
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-10 lg:gap-x-12">
            <div className="lg:col-span-3 lg:sticky lg:top-12 lg:self-start">
              <div className="flex items-baseline gap-3">
                <span className="folio">{tier.folio}</span>
                <span className="eyebrow text-spruce">{tier.eyebrow}</span>
              </div>
              <h2 className="mt-5 font-display">{tier.title}</h2>
              <p className="mt-4 text-slate-green leading-relaxed">{tier.description}</p>
            </div>

            <div className="lg:col-span-9 grid grid-cols-1 md:grid-cols-2 gap-px bg-rule">
              {tier.sources.map((src, idx) => {
                const connected = src.status === 'connected';
                return (
                  <article
                    key={src.id}
                    className="bg-linen p-6 lg:p-7 space-y-5"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <Folio index={idx + 1} />
                      <span
                        className={connected ? 'pill pill-sage' : 'pill'}
                      >
                        {connected ? '● connected' : '○ not yet'}
                      </span>
                    </div>

                    <h3 className="font-display text-[1.75rem] leading-tight">
                      {src.name}
                    </h3>

                    <p className="text-slate-green leading-relaxed">{src.why}</p>

                    <div className="space-y-3 border-l-2 border-rule-strong pl-4">
                      <div>
                        <span className="eyebrow text-spruce">i read</span>
                        <ul className="mt-1 space-y-0.5">
                          {src.reads.map((r) => (
                            <li key={r} className="meta">— {r}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <span className="eyebrow text-spruce">i act on</span>
                        <ul className="mt-1 space-y-0.5">
                          {src.acts.map((a) => (
                            <li key={a} className="meta">— {a}</li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    <div className="pt-2">
                      {connected ? (
                        <button type="button" className="btn-ghost">manage →</button>
                      ) : (
                        <button type="button" className="btn-secondary">
                          {STATUS_LABEL[src.status]} →
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      ))}

      <section className="rise rise-7 mt-20 pt-10 border-t border-rule flex flex-wrap items-baseline justify-between gap-y-3 text-faded-sage">
        <p className="meta">12 sources catalogued · 2 currently connected</p>
        <p className="meta">request a new source · email hello@hearth.family</p>
      </section>
    </div>
  );
}
