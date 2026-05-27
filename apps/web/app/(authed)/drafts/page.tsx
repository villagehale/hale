import { LongDate } from '~/components/mira/long-date';
import { Folio } from '~/components/mira/folio';
import { ToneLabel } from '~/components/mira/tone';
import { StreakLadder, type AutonomyLevel } from '~/components/mira/streak-ladder';

interface Draft {
  id: string;
  recipient: string;
  category: string;
  level: AutonomyLevel;
  streak: number;
  subject: string;
  body: string;
  rationale: string;
}

const DRAFTS: Draft[] = [
  {
    id: 'tpl-rsvp',
    recipient: 'toronto public library',
    category: 'family events',
    level: 2,
    streak: 3,
    subject: 'baby story-time, saturday',
    body:
      "thanks for the note — saturday at ten thirty works. maya and i will be there. is there anything you would like us to bring?",
    rationale:
      'the library sent an event invite. you have replied warmly to two of their previous notes, so i matched the tone. saturday morning is clear on the shared calendar.',
  },
  {
    id: 'grandma-photo',
    recipient: 'mom (grandma)',
    category: 'family updates',
    level: 3,
    streak: 7,
    subject: 're: how is she sleeping?',
    body:
      'she slept six hours straight last night — first time. she was happier this morning. attaching a photo of her with the new bear you sent.',
    rationale:
      'your mother asked about sleep yesterday. i picked one photo from this morning that shows maya with the bear she gave at the shower.',
  },
  {
    id: 'daycare-form',
    recipient: 'little owls daycare',
    category: 'daycare',
    level: 2,
    streak: 1,
    subject: 'updated emergency contact form',
    body:
      'attaching the updated emergency contact form (chris removed, mom added). please confirm receipt — happy to drop off a printed copy if needed.',
    rationale:
      'you updated emergency contacts on the family settings on friday. the daycare requires written confirmation; this draft uses your usual brief tone with them.',
  },
];

export default function DraftsPage() {
  return (
    <div className="space-y-16 lg:space-y-24">
      <header className="rise rise-1 grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12 items-end">
        <div className="lg:col-span-2">
          <span className="eyebrow">№ 03 · drafts</span>
          <p className="mt-3"><LongDate /></p>
        </div>
        <div className="lg:col-span-10">
          <h1 className="font-display">
            three things <em className="text-copper">for your eye.</em>
          </h1>
        </div>
      </header>

      <section className="space-y-16 lg:space-y-20">
        {DRAFTS.map((draft, idx) => {
          const delay = `rise-${Math.min(idx + 2, 7)}`;
          return (
            <article key={draft.id} className={`rise ${delay} border-t border-hairline pt-10`}>
              <div className="grid grid-cols-1 md:grid-cols-12 gap-y-6 md:gap-x-6">
                <div className="md:col-span-1">
                  <Folio index={idx + 1} />
                </div>

                <div className="md:col-span-8 space-y-6">
                  <div className="space-y-2">
                    <span className="eyebrow">to · {draft.recipient}</span>
                    <h2 className="font-display text-3xl lg:text-4xl">
                      {draft.subject}
                    </h2>
                  </div>

                  <p className="text-lg lg:text-xl text-ink-soft leading-relaxed">
                    {draft.body}
                  </p>

                  <div className="border-l-2 border-copper pl-5 py-1 text-ink-mute">
                    <span className="eyebrow text-ink-soft">why this draft</span>
                    <p className="mt-1 italic">{draft.rationale}</p>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pt-2">
                    <button type="button" className="btn-primary">approve and send</button>
                    <button type="button" className="btn-ghost">edit</button>
                    <button type="button" className="meta hover:text-ink">skip</button>
                    <button type="button" className="meta hover:text-ink">always handle these</button>
                  </div>
                </div>

                <div className="md:col-span-3 md:border-l md:border-hairline md:pl-6">
                  <ToneLabel tone="awaiting" />
                  <div className="mt-4 space-y-3">
                    <span className="eyebrow">{draft.category}</span>
                    <StreakLadder level={draft.level} streak={draft.streak} />
                  </div>
                  <p className="meta mt-4">
                    {draft.streak} of 5 approvals · {5 - draft.streak} to autonomy
                  </p>
                </div>
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
