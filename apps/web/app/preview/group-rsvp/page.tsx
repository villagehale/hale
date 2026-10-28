import { notFound } from 'next/navigation';
import { portalDemoEnabled } from '~/lib/flags/portal-demo';

/**
 * VIL-102 — Preview-only conversation from fake families. Production 404s.
 * No real SMS. Hale lines are the voice-seam output of the 3-family play.
 */

export const dynamic = 'force-dynamic';

const BEFORE = [
  {
    from: 'Priya',
    text: "Hale can you keep track of who's coming to Maya's party Saturday at 2 at the park?",
  },
  { from: 'Jordan', text: 'anyone bringing chips?' },
  { from: 'Jordan', text: "we'll be there" },
  { from: 'Sam', text: "can't make it, sorry" },
] as const;

const AFTER = [
  {
    from: 'Priya',
    text: "Hale can you keep track of who's coming to Maya's party Saturday at 2 at the park?",
  },
  { from: 'Hale', text: "I'll keep the count for Maya's party. 0 yes, 0 no, 2 pending." },
  { from: 'Jordan', text: 'anyone bringing chips?' },
  { from: 'Jordan', text: "we'll be there" },
  {
    from: 'Hale',
    text: "1 yes, 0 no, 1 pending for Maya's party. Jordan, want it on your calendar?",
  },
  { from: 'Jordan', text: 'yes please put it on our calendar' },
  { from: 'Hale', text: "Jordan is on the calendar for Maya's party. 1 yes, 0 no, 1 pending." },
  { from: 'Sam', text: "can't make it, sorry" },
  { from: 'Hale', text: "1 yes, 1 no, 1 pending for Maya's party." },
  { from: 'Priya', text: 'should we do balloons too?' },
  { from: 'Priya', text: '(like tapback)' },
  {
    from: 'Hale',
    text: "2 yes, 1 no, 0 pending for Maya's party. Priya, want it on your calendar?",
  },
] as const;

function Thread({
  title,
  lines,
}: {
  title: string;
  lines: readonly { from: string; text: string }[];
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-stone-600">{title}</h2>
      <ol className="space-y-2 rounded-2xl bg-stone-100 p-4">
        {lines.map((line) => (
          <li
            key={`${line.from}:${line.text}`}
            className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
              line.from === 'Hale'
                ? 'ml-auto bg-sky-600 text-white'
                : 'bg-white text-stone-900 shadow-sm'
            }`}
          >
            <p className="text-[11px] font-medium opacity-70">{line.from}</p>
            <p>{line.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function PreviewGroupRsvpPage() {
  if (!portalDemoEnabled()) notFound();
  return (
    <main className="mx-auto max-w-xl space-y-8 px-4 py-10">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-stone-500">Preview · fake families</p>
        <h1 className="text-2xl font-semibold text-stone-900">
          Room 4 parents · Maya&apos;s party
        </h1>
        <p className="text-sm text-stone-600">
          Priya, Jordan, and Sam (not a Hale customer) in one group. No real SMS. After is the
          labeled transcript of the Preview voice seam (`playGroupRsvpPreview` + fake composer) —
          production never posts these sentences.
        </p>
      </header>
      <Thread title="Before — Hale never kept a count in the chat" lines={BEFORE} />
      <Thread
        title="After — tally, tapback, calendar after a yes, quiet during banter"
        lines={AFTER}
      />
    </main>
  );
}
