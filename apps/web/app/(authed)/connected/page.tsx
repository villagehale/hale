import { LongDate } from '~/components/mira/long-date';
import { Folio } from '~/components/mira/folio';

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
  eyebrow: string;
  title: string;
  description: string;
  sources: Source[];
}> = [
  {
    tier: 1,
    eyebrow: 'tier one',
    title: 'the universal sources',
    description:
      'the four things every family already has. mira begins with these — connecting one is enough to see value in the first hour.',
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
        name: 'google calendar',
        why: 'so i can confirm appointments on the right day without conflicts.',
        reads: ['events', 'attendees', 'free/busy windows'],
        acts: ['create events', 'update or cancel events'],
        status: 'connected',
      },
      {
        id: 'photos',
        name: 'google photos',
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
    eyebrow: 'tier two',
    title: 'the newborn devices',
    description:
      "the things that make this product different from every parenting app. real-time signals from your baby's monitor, your sleep tracker, your watch.",
    sources: [
      {
        id: 'apple-health',
        name: 'apple health',
        why: 'for maya, your own sleep, and stress signals during hard weeks.',
        reads: ['baby + parent sleep duration', 'parent HRV (for crisis-quiet mode)'],
        acts: ['surface coaching context', 'auto-quiet during low-sleep weeks'],
        status: 'available',
      },
      {
        id: 'owlet',
        name: 'owlet (monitor)',
        why: 'so i can flag unusual movement and log overnight context.',
        reads: ['heart rate + spo2 events', 'motion windows'],
        acts: ['log episodes', 'never send alerts on owlet\'s behalf'],
        status: 'optional',
      },
      {
        id: 'hatch',
        name: 'hatch (sleep)',
        why: "to log routine and detect patterns — not to start ferber on you.",
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
    eyebrow: 'tier three',
    title: 'the optional sources',
    description:
      'the integrations that make mira indispensable over time. you can connect any of these at any pace — i save you time per connection, not all at once.',
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
        reads: ['benefit status', 'pay stub summaries (you upload)'],
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
        why: 'where your pediatrician offers a portal, mira can book + retrieve.',
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

const STATUS_TONE: Record<Source['status'], string> = {
  connected: 'text-forest',
  available: 'text-persimmon',
  optional: 'text-ink-mute',
};

export default function ConnectedPage() {
  return (
    <div className="space-y-20 lg:space-y-28">
      <header className="rise rise-1 grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12 items-end">
        <div className="lg:col-span-2">
          <span className="eyebrow">№ 07 · connected</span>
          <p className="mt-3"><LongDate /></p>
        </div>
        <div className="lg:col-span-10">
          <h1 className="font-display">
            three tiers <em className="italic text-persimmon">of trust.</em>
          </h1>
        </div>
      </header>

      <section className="rise rise-2 grid grid-cols-1 lg:grid-cols-12 gap-y-4 lg:gap-x-12 text-lg lg:text-xl text-ink-soft leading-relaxed">
        <div className="lg:col-span-3">
          <span className="eyebrow">read this first</span>
        </div>
        <div className="lg:col-span-9">
          <p>
            for every source you connect, i show you exactly what i read and exactly
            what i do with it. nothing is shared with a third party except where you
            connect one. you can disconnect any source at any time and i will forget
            anything that source contributed within twenty-four hours.
          </p>
        </div>
      </section>

      {TIERS.map((tier, tIdx) => (
        <section key={tier.tier} className={`rise ${tIdx === 0 ? 'rise-3' : tIdx === 1 ? 'rise-5' : 'rise-7'}`}>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-12 lg:gap-x-12">
            <div className="lg:col-span-3 lg:sticky lg:top-12 lg:self-start">
              <span className="eyebrow">{tier.eyebrow}</span>
              <h2 className="mt-5 font-display italic">
                {tier.title}
              </h2>
              <p className="mt-4 text-ink-soft leading-relaxed">{tier.description}</p>
            </div>

            <div className="lg:col-span-9 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-12">
              {tier.sources.map((src, idx) => (
                <article key={src.id} className="border-t border-hairline pt-6 space-y-5">
                  <div className="flex items-baseline justify-between gap-3">
                    <Folio index={idx + 1} />
                    <span className={`eyebrow ${STATUS_TONE[src.status]}`}>
                      {src.status === 'connected' ? '● connected' : '○ not yet'}
                    </span>
                  </div>

                  <h3 className="font-display italic text-3xl leading-tight">
                    {src.name}
                  </h3>

                  <p className="text-ink-soft leading-relaxed">{src.why}</p>

                  <div className="space-y-3 border-l-2 border-hairline-strong pl-4 py-1">
                    <div>
                      <span className="eyebrow text-ink-soft">i read</span>
                      <ul className="mt-1 space-y-0.5">
                        {src.reads.map((r) => (
                          <li key={r} className="meta">— {r}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <span className="eyebrow text-ink-soft">i act on</span>
                      <ul className="mt-1 space-y-0.5">
                        {src.acts.map((a) => (
                          <li key={a} className="meta">— {a}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="pt-1">
                    {src.status === 'connected' ? (
                      <button type="button" className="btn-ghost">manage</button>
                    ) : (
                      <button type="button" className="btn-block">
                        {STATUS_LABEL[src.status]}
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
