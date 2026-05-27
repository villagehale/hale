import { ReadingColumn } from '~/components/mira/reading-column';
import { LongDate } from '~/components/mira/long-date';

export default function CoachPage() {
  return (
    <ReadingColumn>
      <header className="letter-rise letter-rise-1 mb-6">
        <LongDate />
      </header>

      <h1 className="letter-rise letter-rise-2 mb-12 font-display italic">coach</h1>

      <p className="letter-rise letter-rise-3 mb-16 text-[1.05rem] text-ink-soft">
        ask me anything about maya — sleep, feeding, milestones, mood, what's typical at four
        months. i'll answer in plain language and tell you which framework or source the
        advice comes from. i won't give medical advice; if a question crosses that line, i'll
        say so and point you to your pediatrician.
      </p>

      <section className="letter-rise letter-rise-4 mb-20">
        <hr className="hairline-soft mb-8" />
        <p className="meta mb-3 text-ink-quiet">a quiet note from earlier</p>
        <h2 className="mb-5 font-display text-2xl italic">
          the four-month sleep regression
        </h2>
        <p className="text-[1.05rem] leading-[1.75] text-ink-soft">
          maya had her first six-hour continuous sleep block last night. around four months,
          many babies reorganize their cycles and briefly regress. it isn't a step backwards
          — it's their brain catching up. what tends to help: a consistent wind-down, naps
          every ninety minutes to two hours of awake time, and a darker, quieter room than
          you'd think necessary.
        </p>
        <p className="mt-4 text-[0.95rem] italic text-ink-quiet">
          — karp, the happiest baby on the block; health canada, healthy sleep habits.
        </p>
      </section>

      <section className="letter-rise letter-rise-5 mb-16">
        <hr className="hairline-soft mb-8" />
        <label htmlFor="coach-input" className="meta mb-3 block text-ink-quiet">
          ask coach
        </label>
        <textarea
          id="coach-input"
          rows={4}
          placeholder="what's typical around four months? how do we start solids?"
          className="w-full resize-none border-b border-hairline-strong bg-transparent pb-3 font-display text-lg italic placeholder:text-ink-quiet focus:outline-none focus:border-ink"
        />
        <div className="mt-4 flex items-center justify-between">
          <p className="meta text-ink-quiet">your question stays inside mira.</p>
          <button type="button" className="btn-ink">
            ask
          </button>
        </div>
      </section>

      <footer className="letter-rise letter-rise-6 mt-24 border-t border-hairline pt-10">
        <p className="hand text-ink-quiet">with care,</p>
        <p className="hand text-ink">mira</p>
      </footer>
    </ReadingColumn>
  );
}
