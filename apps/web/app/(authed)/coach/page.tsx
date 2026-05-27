import { LongDate } from '~/components/mira/long-date';
import { Folio } from '~/components/mira/folio';

interface Exchange {
  id: string;
  role: 'you' | 'mira';
  body: string;
  citations?: string[];
  followUps?: string[];
}

const HISTORY: Exchange[] = [
  {
    id: 'q1',
    role: 'you',
    body: 'is it normal for a four-month-old to suddenly hate the pacifier?',
  },
  {
    id: 'a1',
    role: 'mira',
    body:
      "around four months many babies become more aware of their environment and their cues change quickly. some lose interest in the pacifier; some need it more. it usually isn't about the pacifier itself — it's about a temporary shift in self-soothing. if maya is feeding well and sleep is acceptable, this is almost certainly fine.",
    citations: [
      'karp · happiest baby — 4-month "wonder weeks" reorganization',
      'health canada · caring for kids — self-soothing development',
    ],
    followUps: [
      'is feeding still going smoothly?',
      'has anything else changed this week (travel, illness)?',
    ],
  },
];

export default function CoachPage() {
  return (
    <div className="space-y-16 lg:space-y-24">
      <header className="rise rise-1 grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12 items-end">
        <div className="lg:col-span-2">
          <span className="eyebrow">№ 04 · coach</span>
          <p className="mt-3"><LongDate /></p>
        </div>
        <div className="lg:col-span-10">
          <h1 className="font-display">
            ask me <em className="italic text-persimmon">anything.</em>
          </h1>
        </div>
      </header>

      <section className="rise rise-2 grid grid-cols-1 lg:grid-cols-12 gap-y-4 lg:gap-x-12">
        <div className="lg:col-span-3">
          <span className="eyebrow">how this works</span>
        </div>
        <div className="lg:col-span-9 text-ink-soft text-lg leading-relaxed">
          <p>
            i answer in plain language and cite the framework or source. i won't give
            medical advice; if a question crosses that line, i'll say so and point you
            to your pediatrician. type, talk, or share a photo.
          </p>
        </div>
      </section>

      {/* HISTORY */}
      <section className="space-y-10">
        {HISTORY.map((entry, idx) => {
          const delay = `rise-${Math.min(idx + 3, 7)}`;
          if (entry.role === 'you') {
            return (
              <article key={entry.id} className={`rise ${delay}`}>
                <div className="grid grid-cols-1 md:grid-cols-12 gap-y-3 md:gap-x-6">
                  <div className="md:col-span-1">
                    <Folio index={idx + 1} />
                  </div>
                  <div className="md:col-span-3">
                    <span className="eyebrow">you · 06:48</span>
                  </div>
                  <div className="md:col-span-8">
                    <p className="font-display italic text-2xl lg:text-3xl leading-snug">
                      "{entry.body}"
                    </p>
                  </div>
                </div>
              </article>
            );
          }
          return (
            <article key={entry.id} className={`rise ${delay}`}>
              <div className="grid grid-cols-1 md:grid-cols-12 gap-y-6 md:gap-x-6">
                <div className="md:col-span-1">
                  <Folio index={idx + 1} />
                </div>
                <div className="md:col-span-3">
                  <span className="eyebrow text-persimmon">mira · 06:48</span>
                  <p className="meta mt-2">confidence 0.88</p>
                </div>
                <div className="md:col-span-8 space-y-6">
                  <p className="text-lg lg:text-xl text-ink-soft leading-relaxed">
                    {entry.body}
                  </p>
                  {entry.citations ? (
                    <div className="border-l-2 border-persimmon pl-5 py-1">
                      <span className="eyebrow text-ink-soft">grounded in</span>
                      <ul className="mt-2 space-y-1.5">
                        {entry.citations.map((c) => (
                          <li key={c} className="meta italic">— {c}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {entry.followUps ? (
                    <div>
                      <span className="eyebrow text-ink-soft">i might also ask</span>
                      <ul className="mt-2 space-y-1.5">
                        {entry.followUps.map((q) => (
                          <li key={q}>
                            <button type="button" className="travel-underline text-lg italic text-ink-soft">
                              {q}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}
      </section>

      {/* INPUT BLOCK */}
      <section className="rise rise-7 border-t border-hairline pt-10">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">ask coach</span>
          </div>
          <div className="lg:col-span-9 space-y-6">
            <label htmlFor="coach-input" className="sr-only">
              ask coach
            </label>
            <textarea
              id="coach-input"
              rows={3}
              placeholder="what tends to happen at five months? do we need to start solids yet?"
              className="field"
            />
            <div className="flex flex-wrap items-center justify-between gap-y-4 gap-x-6">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="btn-ghost"
                  aria-label="hold to talk"
                  title="hold-to-talk — type if you prefer"
                >
                  ◉ hold to talk
                </button>
                <button type="button" className="btn-ghost">
                  + photo
                </button>
              </div>
              <button type="button" className="btn-block">
                ask
              </button>
            </div>
            <p className="meta">
              your question stays inside mira. coach never sees your inbox or
              calendar — only maya's profile and your parenting-style preference.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
