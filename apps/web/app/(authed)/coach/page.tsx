import { PageCorner } from '~/components/mira/page-corner';
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
    <div>
      <PageCorner folio="iv" section="coach · ask anything" />

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">coach</span>
            <p className="meta mt-2">grounded in named frameworks</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              ask me <span className="text-madder">anything.</span>
            </h1>
          </div>
        </div>
      </header>

      {/* ── How it works ───────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-16 fold">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-3 lg:gap-x-8">
          <div className="lg:col-span-3">
            <span className="eyebrow">how this works</span>
          </div>
          <div className="lg:col-span-9 text-slate leading-relaxed text-lg">
            I answer in plain language and cite the framework or source. I will
            not give medical advice; if a question crosses that line, I will
            say so and point you to your pediatrician. Type, talk, or share a
            photo.
          </div>
        </div>
      </section>

      {/* ── History ────────────────────────────────────────────────────── */}
      <section>
        {HISTORY.map((entry, idx) => {
          const delay = `rise-${Math.min(idx + 3, 7)}`;
          if (entry.role === 'you') {
            return (
              <article
                key={entry.id}
                className={`rise ${delay} py-10 border-t border-rule first:border-t-0`}
              >
                <div className="grid grid-cols-1 md:grid-cols-12 gap-y-4 md:gap-x-8">
                  <div className="md:col-span-2">
                    <Folio index={idx + 1} />
                    <p className="eyebrow text-iron mt-2">you · 06:48</p>
                  </div>
                  <div className="md:col-span-10">
                    <p className="font-display text-[1.5rem] lg:text-[1.85rem] leading-snug">
                      &ldquo;{entry.body}&rdquo;
                    </p>
                  </div>
                </div>
              </article>
            );
          }
          return (
            <article
              key={entry.id}
              className={`rise ${delay} py-10 border-t border-rule`}
            >
              <div className="grid grid-cols-1 md:grid-cols-12 gap-y-6 md:gap-x-8">
                <div className="md:col-span-2">
                  <Folio index={idx + 1} />
                  <p className="eyebrow text-madder mt-2">mira · 06:48</p>
                  <p className="meta mt-1">confidence · 0.88</p>
                </div>
                <div className="md:col-span-10 space-y-6">
                  <p className="text-lg text-iron leading-relaxed">{entry.body}</p>
                  {entry.citations ? (
                    <div className="border-l-2 border-madder pl-5">
                      <span className="eyebrow text-iron">grounded in</span>
                      <ul className="mt-2 space-y-1.5">
                        {entry.citations.map((c) => (
                          <li key={c} className="meta italic">— {c}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {entry.followUps ? (
                    <div>
                      <span className="eyebrow">i might also ask</span>
                      <ul className="mt-3 space-y-2">
                        {entry.followUps.map((q) => (
                          <li key={q}>
                            <button type="button" className="travel-underline text-lg text-iron">
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

      {/* ── Input block ────────────────────────────────────────────────── */}
      <section className="rise rise-7 mt-16 lg:mt-20 pt-10 border-t border-rule">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-6 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">ask coach</span>
            <p className="meta mt-2">type, talk, or photograph</p>
          </div>
          <div className="lg:col-span-9 space-y-6">
            <label htmlFor="coach-input" className="sr-only">
              ask coach
            </label>
            <textarea
              id="coach-input"
              name="question"
              rows={3}
              placeholder="what tends to happen at five months? do we need to start solids yet?"
              className="field"
              autoComplete="off"
            />
            <div className="flex flex-wrap items-center justify-between gap-y-4 gap-x-6">
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  className="btn-ghost"
                  aria-label="hold to talk"
                  title="hold-to-talk — type if you prefer"
                >
                  <span className="text-madder" aria-hidden>◉</span> hold to talk
                </button>
                <button type="button" className="btn-ghost" aria-label="attach a photo">
                  <span aria-hidden>+</span> photo
                </button>
              </div>
              <button type="button" className="btn-primary">ask →</button>
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
