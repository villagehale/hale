import { ReadingColumn } from '~/components/mira/reading-column';
import { LongDate } from '~/components/mira/long-date';

interface Integration {
  id: string;
  name: string;
  why: string;
  status: 'connected' | 'available' | 'optional';
}

const INTEGRATIONS: Integration[] = [
  {
    id: 'gmail',
    name: 'gmail',
    why: 'so i can read the pediatric office, daycare, and family notes.',
    status: 'available',
  },
  {
    id: 'gcal',
    name: 'google calendar',
    why: 'so i can confirm and schedule on the right day, without conflicts.',
    status: 'available',
  },
  {
    id: 'photos',
    name: 'google photos',
    why: 'so i can notice milestones and pick photos for grandparents — read-only.',
    status: 'optional',
  },
  {
    id: 'outlook',
    name: 'outlook',
    why: "if you'd rather use microsoft. same scope as gmail.",
    status: 'optional',
  },
  {
    id: 'stripe',
    name: 'stripe',
    why: 'so i can reorder diapers, formula, and supplies on your card.',
    status: 'optional',
  },
];

const STATUS_LABEL: Record<Integration['status'], string> = {
  connected: 'connected',
  available: 'connect',
  optional: 'add later',
};

export default function ConnectPage() {
  return (
    <ReadingColumn>
      <header className="letter-rise letter-rise-1 mb-6">
        <LongDate />
      </header>

      <h1 className="letter-rise letter-rise-2 mb-12 font-display italic">
        let's connect
        <br />
        what i'll watch.
      </h1>

      <p className="letter-rise letter-rise-3 mb-20 text-[1.05rem] leading-[1.75] text-ink-soft">
        connect one at a time, as you're ready. for the first seven days i will only observe
        — i won't draft or send anything. you can disconnect any of these whenever you'd like.
      </p>

      <div className="space-y-12">
        {INTEGRATIONS.map((integration, index) => {
          const delayClass = `letter-rise-${Math.min(index + 4, 7)}`;
          return (
            <article key={integration.id} className={`letter-rise ${delayClass} space-y-3`}>
              <div className="flex items-baseline justify-between gap-6 border-b border-hairline-strong pb-3">
                <h2 className="font-display text-2xl italic">{integration.name}</h2>
                <button
                  type="button"
                  className={
                    integration.status === 'connected'
                      ? 'smallcaps text-moss'
                      : integration.status === 'available'
                        ? 'btn-ghost travel-underline'
                        : 'smallcaps text-ink-quiet'
                  }
                  disabled={integration.status === 'connected'}
                >
                  {STATUS_LABEL[integration.status]}
                </button>
              </div>
              <p className="text-[1rem] leading-[1.7] text-ink-soft">{integration.why}</p>
            </article>
          );
        })}
      </div>

      <footer className="letter-rise letter-rise-7 mt-24 border-t border-hairline pt-10">
        <p className="meta text-ink-quiet">
          mira stores everything in toronto. pipeda + quebec law 25 + casl by default.
        </p>
        <p className="hand mt-8 text-ink-quiet">with care,</p>
        <p className="hand text-ink">mira</p>
      </footer>
    </ReadingColumn>
  );
}
