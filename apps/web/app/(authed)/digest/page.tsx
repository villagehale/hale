import { DigestItem } from '~/components/digest/digest-item';

const TODAY_LONG = 'thursday · may twenty-eighth';

/**
 * Stub data — real implementation pulls from db (actions table for today, joined
 * with events). Renders the editorial digest UI per the design language.
 */
const stubItems = [
  {
    id: '1',
    state: 'done' as const,
    timeLabel: '4:12 pm',
    body: "i confirmed maya's vaccine appointment for thursday. pre-visit form attached.",
    undoable: true,
  },
  {
    id: '2',
    state: 'done' as const,
    timeLabel: '4:14 pm',
    body: 'i reordered diapers (size 2). $42.99, arriving wednesday.',
    undoable: true,
  },
  {
    id: '3',
    state: 'awaiting' as const,
    timeLabel: 'approve or skip',
    body: 'the toronto public library emailed about baby story-time saturday. i drafted an rsvp.',
    undoable: false,
  },
  {
    id: '4',
    state: 'coach' as const,
    timeLabel: 'a quiet note',
    body:
      "maya had her first 6-hour continuous sleep block last night. if you'd like, i can brief you on what typically comes next around four months.",
    undoable: false,
  },
  {
    id: '5',
    state: 'needs-you' as const,
    timeLabel: "i can't act on this",
    body:
      "your pediatrician's office sent a message saying lab results are ready and asking you to call. i don't act on calls — please open it.",
    undoable: false,
  },
];

export default function DigestPage() {
  return (
    <div className="space-y-12">
      <header className="space-y-2">
        <p className="smallcaps text-ink-quiet">{TODAY_LONG}</p>
        <h1 className="font-serif text-4xl leading-tight">today's digest</h1>
      </header>

      <section className="space-y-10">
        {stubItems.map((item) => (
          <DigestItem
            key={item.id}
            state={item.state}
            timeLabel={item.timeLabel}
            body={item.body}
            undoable={item.undoable}
          />
        ))}
      </section>

      <footer className="space-y-2 pt-12 text-sm text-ink-quiet">
        <p>
          mira ran <span className="tabular">14</span> agent passes for you today at a cost
          of <span className="tabular">$0.31</span>. one item still needs you.
        </p>
        <p className="smallcaps">end of digest</p>
      </footer>
    </div>
  );
}
