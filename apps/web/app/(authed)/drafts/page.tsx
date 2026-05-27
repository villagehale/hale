import { ReadingColumn } from '~/components/mira/reading-column';
import { LongDate } from '~/components/mira/long-date';
import { EntryMark } from '~/components/mira/entry-mark';

interface Draft {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  rationale: string;
}

const DRAFTS: Draft[] = [
  {
    id: 'tpl-rsvp',
    recipient: 'toronto public library',
    subject: 'baby story-time, saturday',
    body:
      "thanks for the note — saturday at ten thirty works. maya and i'll be there. is there " +
      "anything you'd like us to bring?",
    rationale:
      "the library sent an event invite. you've replied warmly to two of their previous notes, " +
      "so i matched that tone. saturday morning is clear on the shared calendar.",
  },
  {
    id: 'grandma-photo',
    recipient: 'mom (grandma)',
    subject: 're: how is she sleeping?',
    body:
      "she slept six hours straight last night — first time. she was much happier this " +
      "morning. attaching a photo of her with the new bear you sent.",
    rationale:
      "your mother asked about sleep yesterday. i picked one photo from this morning's set " +
      "that shows maya with the bear she gave at the shower.",
  },
];

export default function DraftsPage() {
  return (
    <ReadingColumn>
      <header className="letter-rise letter-rise-1 mb-6">
        <LongDate />
      </header>

      <h1 className="letter-rise letter-rise-2 mb-20 font-display italic">drafts</h1>

      <p className="letter-rise letter-rise-3 mb-20 text-[1.05rem] text-ink-soft">
        two replies i'd like you to look at before i send. tap approve when they read right.
      </p>

      <div className="space-y-[var(--rhythm-entry)]">
        {DRAFTS.map((draft, index) => {
          const delayClass = `letter-rise-${Math.min(index + 4, 7)}`;
          return (
            <article key={draft.id} className={`letter-rise ${delayClass} space-y-6`}>
              <EntryMark tone="awaiting" detail={`to ${draft.recipient.toLowerCase()}`} />

              <div className="space-y-1">
                <p className="meta text-ink-quiet">subject</p>
                <p className="font-display text-2xl italic">{draft.subject}</p>
              </div>

              <p className="text-[1.05rem] leading-[1.75] text-ink-soft">{draft.body}</p>

              <p className="border-l-2 border-hairline-strong pl-4 text-[0.95rem] italic text-ink-quiet">
                why this draft — {draft.rationale}
              </p>

              <div className="flex items-center gap-6">
                <button type="button" className="btn-ink">
                  approve and send
                </button>
                <button type="button" className="smallcaps text-ink-quiet">
                  edit
                </button>
                <button type="button" className="smallcaps text-ink-quiet">
                  skip
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <footer className="letter-rise letter-rise-7 mt-32 border-t border-hairline pt-10">
        <p className="hand text-ink-quiet">with care,</p>
        <p className="hand text-ink">mira</p>
      </footer>
    </ReadingColumn>
  );
}
