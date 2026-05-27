import { LongDate } from '~/components/mira/long-date';
import { Folio } from '~/components/mira/folio';

interface Fact {
  id: string;
  type: 'preference' | 'routine' | 'medical' | 'logistic' | 'relationship' | 'voice';
  key: string;
  value: string;
  source: string;
  confidence: number;
  observedTimes: number;
}

const FACTS: Fact[] = [
  {
    id: '1',
    type: 'preference',
    key: 'pediatric appointments',
    value: 'family prefers thursday mornings',
    source: 'inferred from 4 prior bookings',
    confidence: 0.92,
    observedTimes: 4,
  },
  {
    id: '2',
    type: 'routine',
    key: 'bedtime',
    value: 'co-parent A handles tuesday/thursday; co-parent B handles other nights',
    source: 'inferred from calendar + sleep tracker',
    confidence: 0.86,
    observedTimes: 12,
  },
  {
    id: '3',
    type: 'voice',
    key: 'tone with teachers',
    value: 'warm but brief — short sentences, signed with "thanks"',
    source: 'analyzed from 7 prior emails',
    confidence: 0.89,
    observedTimes: 7,
  },
  {
    id: '4',
    type: 'voice',
    key: 'tone with insurers',
    value: 'formal, structured — full signature block',
    source: 'analyzed from 3 prior emails',
    confidence: 0.78,
    observedTimes: 3,
  },
  {
    id: '5',
    type: 'medical',
    key: 'maya · pediatrician',
    value: "dr. anita chen, queen west pediatrics, queen west clinic",
    source: 'stated in setup · confirmed in 2 visit emails',
    confidence: 0.99,
    observedTimes: 3,
  },
  {
    id: '6',
    type: 'logistic',
    key: 'diaper supply cadence',
    value: 'one case (size 2) every 18-22 days',
    source: 'inferred from 6 prior orders',
    confidence: 0.95,
    observedTimes: 6,
  },
  {
    id: '7',
    type: 'relationship',
    key: 'grandparent: mom',
    value: 'photo-share approved · weekly cadence preferred',
    source: 'stated in setup · 8 prior shares approved',
    confidence: 0.97,
    observedTimes: 8,
  },
  {
    id: '8',
    type: 'preference',
    key: 'sleep philosophy',
    value: 'gentle methods preferred — not ferber, not pure attachment',
    source: 'stated during onboarding',
    confidence: 1.0,
    observedTimes: 1,
  },
];

const TYPE_COLOR: Record<Fact['type'], string> = {
  preference: 'text-copper',
  routine: 'text-sage',
  medical: 'text-copper-deep',
  logistic: 'text-clay',
  relationship: 'text-sage',
  voice: 'text-clay',
};

export default function MemoryPage() {
  return (
    <div className="space-y-16 lg:space-y-24">
      <header className="rise rise-1 grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12 items-end">
        <div className="lg:col-span-2">
          <span className="eyebrow">№ 05 · memory</span>
          <p className="mt-3"><LongDate /></p>
        </div>
        <div className="lg:col-span-10">
          <h1 className="font-display">
            what i <em className="text-copper">know</em> about
            <br />
            your household.
          </h1>
        </div>
      </header>

      <section className="rise rise-2 grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12 border-y border-hairline py-8">
        <div className="lg:col-span-3">
          <span className="eyebrow">the promise</span>
        </div>
        <div className="lg:col-span-9 text-lg lg:text-xl text-ink-soft leading-relaxed">
          <p>
            every fact below comes from a specific signal i observed. you can edit
            any of them, mark any of them wrong, or delete any of them — and i
            will retrain my behavior around the change before the next digest.
            this is the only consumer ai product that shows you what it remembers.
          </p>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-12">
        {FACTS.map((fact, idx) => {
          const delay = `rise-${Math.min(idx + 3, 7)}`;
          return (
            <article key={fact.id} className={`rise ${delay} border-t border-hairline pt-6 space-y-4`}>
              <div className="flex items-baseline justify-between gap-3">
                <span className={`eyebrow ${TYPE_COLOR[fact.type]}`}>{fact.type}</span>
                <Folio index={idx + 1} />
              </div>

              <h3 className="font-display text-2xl leading-tight">
                {fact.key}
              </h3>

              <p className="text-ink-soft leading-relaxed">{fact.value}</p>

              <div className="border-l-2 border-hairline-strong pl-4 py-1">
                <span className="eyebrow text-ink-soft">source</span>
                <p className="meta mt-1 italic">{fact.source}</p>
              </div>

              <div className="flex items-center justify-between gap-3 pt-1">
                <div className="flex items-baseline gap-3">
                  <span className="meta tabular">
                    confidence · {(fact.confidence * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <button type="button" className="meta hover:text-ink">edit</button>
                  <button type="button" className="meta hover:text-copper-deep">delete</button>
                </div>
              </div>
            </article>
          );
        })}
      </section>

      <section className="rise rise-7 border-t border-hairline pt-10 grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12">
        <div className="lg:col-span-3">
          <span className="eyebrow">your rights</span>
        </div>
        <div className="lg:col-span-9 text-ink-soft leading-relaxed space-y-3">
          <p>
            request a full export of everything you see on this page in
            machine-readable form. delete everything in one tap. the family graph
            never leaves canadian-region storage. nothing here is shared with any
            third party, ever.
          </p>
          <div className="pt-3 flex flex-wrap gap-x-5 gap-y-3">
            <button type="button" className="btn-ghost">export everything</button>
            <button type="button" className="btn-ghost">delete everything</button>
          </div>
        </div>
      </section>
    </div>
  );
}
