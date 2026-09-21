/**
 * The loop, drawn on a spine.
 *
 * ONE conversation, five beats, and a 1px vertical rule running the height of
 * it with the elapsed-time stamps set on the rule as small plates. The rule is
 * the page's only structural ornament and it is not decoration: TIME is the
 * product. Finding is the on-ramp; coming back a week later at 6:45 a.m. is the
 * promise, and a still image cannot show elapsed time. The spine is the argument
 * drawn.
 *
 * The bubbles are `.v4-bubble` / `-in` / `-out` unchanged — the same messaging
 * idiom /text and /for-centres already speak, so a reader never crosses from one
 * rendering of a text message into another. What is new is the rail they hang
 * off and the stamp that interrupts it.
 *
 * The stamps are SENTENCE CASE, not the tracked caps `.v4-thread-time` wore as a
 * transcript separator. An elapsed time is prose, not data: "A week later, the
 * night before" is a sentence about when Hale came back, and setting five of
 * those in tracked caps would put the label device this page spent its budget
 * removing back on the page five times over.
 *
 * v4 ran two conversations — a hero exchange and a transcript a screen and a
 * half below it — and a test had to police them for accidentally saying the same
 * sentence twice (a word-set overlap check drawn at 0.65). One conversation
 * designs that whole class of defect out rather than testing for it.
 */

/** One beat of the loop. `elapsed` is the spine node ABOVE the rows — the only
 *  thing on this page that proves Hale comes back. */
export interface LoopBeat {
  elapsed: string;
  rows: { dir: 'in' | 'out'; text: string }[];
}

export function LoopThread({
  beats,
  cap,
  speaker,
}: {
  beats: LoopBeat[];
  cap: string;
  /** Who said it, for the reader the alignment does not reach. */
  speaker: (dir: 'in' | 'out') => string;
}) {
  // Rule #11: a hero that renders with the thread silently absent is the site's
  // version of "did the work, sent nothing". A translator who drops the array,
  // or a beat, gets a build failure — the page never quietly shortens. next-intl
  // already fails the build on a missing KEY; this covers the empty one.
  if (beats.length === 0) throw new Error('LoopThread: heroLoop is empty — the hero has no thread');
  for (const beat of beats) {
    if (beat.rows.length === 0) {
      throw new Error(`LoopThread: the "${beat.elapsed}" beat has no messages under it`);
    }
  }

  return (
    <div className="v5-loop">
      {/* The thread is a demo and the parent's lines are invented, so the page
          says so — to every reader, not only the one the layout does not reach.
          It was sr-only, which left a sighted reader to take three made-up
          turns for a transcript; a plate in the stamps' own small faded type
          costs one line of fold height and buys the disclosure. */}
      <p className="v5-loop-cap">{cap}</p>
      {/* The spine is drawn by the list itself (`.v5-beats::before`). It used to
          be a <span> child of this <ol>, which is not a content model an ol has
          — li, script and template — and a decorative rule needs no element. */}
      <ol className="v5-beats">
        {beats.map((beat) => (
          <li key={beat.elapsed} className="v5-beat">
            <p className="v5-stamp">{beat.elapsed}</p>
            {beat.rows.map((row, i) => (
              <p key={`${i}-${row.dir}`} className={`v4-bubble v4-bubble-${row.dir}`}>
                <span className="sr-only">{speaker(row.dir)} </span>
                {row.text}
              </p>
            ))}
          </li>
        ))}
      </ol>
    </div>
  );
}
