import { ReadingColumn } from '~/components/mira/reading-column';
import { LongDate } from '~/components/mira/long-date';
import { EntryMark } from '~/components/mira/entry-mark';

/**
 * Today's digest. The product's centrepiece. Renders as a letter, not a feed.
 *
 * In production this page reads `actions` table (today, for this family) +
 * Coach insights, ordered chronologically. For now the digest renders a
 * representative day's content so the visual language can be reviewed.
 */

interface DigestEntry {
  id: string;
  tone: 'done' | 'awaiting' | 'coach' | 'needs-you';
  detail: string;
  body: string;
  showUndo?: boolean;
  approve?: boolean;
}

const TODAY_ENTRIES: DigestEntry[] = [
  {
    id: 'pediatric-confirm',
    tone: 'done',
    detail: 'four twelve in the afternoon',
    body:
      "i confirmed maya's vaccine appointment for thursday at ten. the pre-visit form is attached. " +
      "the office should send you a reminder at eight the day before — i'll watch for it.",
    showUndo: true,
  },
  {
    id: 'diapers-reorder',
    tone: 'done',
    detail: 'four fourteen in the afternoon',
    body:
      'i reordered diapers — size two, one case, $42.99 — and routed it to your usual address. ' +
      "they should arrive wednesday. i'll skip the next order if you'd rather hold off.",
    showUndo: true,
  },
  {
    id: 'library-rsvp',
    tone: 'awaiting',
    detail: 'please decide before saturday morning',
    body:
      'the toronto public library wrote about baby story-time on saturday at ten thirty. ' +
      "i drafted a short yes. it's not on your calendar yet — should i send and add it?",
    approve: true,
  },
  {
    id: 'sleep-note',
    tone: 'coach',
    detail: 'something worth a moment',
    body:
      'maya had her first six-hour continuous sleep block last night. ' +
      "if you'd like, i can give you a short brief on what tends to happen around four months — " +
      "sleep often briefly regresses as their cycles reorganize. nothing wrong, just useful to know.",
  },
  {
    id: 'lab-results',
    tone: 'needs-you',
    detail: 'i can’t act on this',
    body:
      "your pediatrician's office sent a message saying maya's lab results are ready and asking " +
      "you to call. i don't act on phone calls — please open it when you can.",
  },
];

export default function DigestPage() {
  return (
    <ReadingColumn>
      <header className="letter-rise letter-rise-1 mb-6">
        <LongDate />
      </header>

      <h1 className="letter-rise letter-rise-2 mb-20 font-display italic">today's digest</h1>

      <div className="space-y-[var(--rhythm-entry)]">
        {TODAY_ENTRIES.map((entry, index) => {
          const delayClass = `letter-rise-${Math.min(index + 3, 7)}`;
          return (
            <article key={entry.id} className={`letter-rise ${delayClass} space-y-6`}>
              <EntryMark tone={entry.tone} detail={entry.detail} />

              <p className="text-[1.08rem] leading-[1.75] text-ink-soft">{entry.body}</p>

              {(entry.showUndo || entry.approve) && (
                <div className="flex items-center gap-6 pt-1">
                  {entry.approve ? (
                    <>
                      <button type="button" className="smallcaps travel-underline">
                        approve and send
                      </button>
                      <button type="button" className="smallcaps text-ink-quiet">
                        skip
                      </button>
                      <button type="button" className="smallcaps text-ink-quiet">
                        always handle these
                      </button>
                    </>
                  ) : null}
                  {entry.showUndo ? (
                    <button type="button" className="smallcaps text-ink-quiet">
                      undo
                    </button>
                  ) : null}
                </div>
              )}
            </article>
          );
        })}
      </div>

      <footer className="letter-rise letter-rise-7 mt-32 border-t border-hairline pt-10">
        <p className="meta">
          mira ran <span className="tabular">fourteen</span> agent passes for you today at a
          cost of <span className="tabular">$0.31</span>. one item still needs you.
        </p>
        <p className="hand mt-8 text-ink-quiet">with care,</p>
        <p className="hand text-ink">mira</p>
      </footer>
    </ReadingColumn>
  );
}
