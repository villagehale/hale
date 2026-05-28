import { PageCorner } from '~/components/haru/page-corner';
import { Folio } from '~/components/haru/folio';
import { ToneLabel } from '~/components/haru/tone';
import { StreakLadder, type AutonomyLevel } from '~/components/haru/streak-ladder';

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
    recipient: 'Toronto Public Library',
    category: 'family events',
    level: 2,
    streak: 3,
    subject: 'baby story-time, saturday',
    body:
      "thanks for the note — Saturday at ten thirty works. maya and i will be there. is there anything you would like us to bring?",
    rationale:
      'the library sent an event invite. you have replied warmly to two of their previous notes, so I matched the tone. Saturday morning is clear on the shared calendar.',
  },
  {
    id: 'grandma-photo',
    recipient: 'mom (grandma)',
    category: 'family updates',
    level: 3,
    streak: 7,
    subject: 're: how is she sleeping?',
    body:
      'she slept six hours straight last night — first time. She was happier this morning. Attaching a photo of her with the new bear you sent.',
    rationale:
      'your mother asked about sleep yesterday. I picked one photo from this morning that shows maya with the bear she gave at the shower.',
  },
  {
    id: 'daycare-form',
    recipient: 'Little Owls Daycare',
    category: 'daycare',
    level: 2,
    streak: 1,
    subject: 'updated emergency contact form',
    body:
      'attaching the updated emergency contact form (chris removed, mom added). please confirm receipt — happy to drop off a printed copy if needed.',
    rationale:
      'you updated emergency contacts on the family settings on Friday. the daycare requires written confirmation; this draft uses your usual brief tone with them.',
  },
];

export default function DraftsPage() {
  return (
    <div>
      <PageCorner folio="iii" section="drafts · awaiting your eye" />

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">drafts</span>
            <p className="meta mt-2">three notes for you to read</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              three notes <span className="text-madder">for your eye.</span>
            </h1>
          </div>
        </div>
      </header>

      {/* ── Reading note ───────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-16 fold">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-3 lg:gap-x-8">
          <div className="lg:col-span-3">
            <span className="eyebrow">how to read this page</span>
          </div>
          <div className="lg:col-span-9 text-slate leading-relaxed">
            Each draft has a recipient, a body, and my reasoning. Approve the
            ones that read right. Edit the ones that almost do. Skip the ones
            that don't. Every approval earns this action class one rung up the
            trust ladder.
          </div>
        </div>
      </section>

      {/* ── Drafts ─────────────────────────────────────────────────────── */}
      <section>
        {DRAFTS.map((draft, idx) => {
          const delay = `rise-${Math.min(idx + 3, 7)}`;
          return (
            <article
              key={draft.id}
              className={`rise ${delay} py-12 lg:py-14 border-t border-rule first:border-t-0`}
            >
              <div className="grid grid-cols-1 md:grid-cols-12 gap-y-6 md:gap-x-8">
                <div className="md:col-span-2">
                  <Folio index={idx + 1} />
                  <p className="eyebrow text-iron mt-3">{draft.category}</p>
                </div>

                <div className="md:col-span-7 space-y-6">
                  <div className="space-y-2">
                    <span className="meta">to · {draft.recipient}</span>
                    <h2 className="font-display text-[1.75rem] lg:text-[2.25rem] leading-tight">
                      {draft.subject}
                    </h2>
                  </div>

                  {/* the "letter body" — paper-toned fold */}
                  <div className="fold">
                    <p className="text-lg text-iron leading-relaxed">{draft.body}</p>
                  </div>

                  <div className="border-l-2 border-madder pl-5">
                    <span className="eyebrow text-iron">why this draft</span>
                    <p className="mt-1 text-slate"><em>{draft.rationale}</em></p>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-2">
                    <button type="button" className="btn-primary">approve and send</button>
                    <button type="button" className="btn-ghost">edit</button>
                    <button type="button" className="btn-ghost">skip</button>
                    <button type="button" className="btn-ghost">always handle these</button>
                  </div>
                </div>

                <div className="md:col-span-3 md:border-l md:border-rule md:pl-6 space-y-4">
                  <ToneLabel tone="awaiting" />
                  <div>
                    <span className="eyebrow">trust ladder</span>
                    <div className="mt-2">
                      <StreakLadder level={draft.level} streak={draft.streak} />
                    </div>
                  </div>
                </div>
              </div>
            </article>
          );
        })}
      </section>

      <section className="rise rise-7 mt-16 lg:mt-20 pt-10 border-t border-rule flex flex-wrap items-baseline justify-between gap-y-3 text-faded">
        <p className="meta">end of drafts</p>
        <p className="meta">nothing else awaiting · last drafted 06:18 am</p>
      </section>
    </div>
  );
}
