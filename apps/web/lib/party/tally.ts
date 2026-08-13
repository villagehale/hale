/**
 * VIL-245 · M10 — the host's headcount.
 *
 * HOST-ONLY BY CONSTRUCTION. This module is pure and takes rows the caller already
 * scoped to one family's own invite; there is no guest-facing path that reaches it and
 * no public loader that returns its input. A guest sees the event card and their own
 * confirmation, never who else answered — the guest list is other people's data, and
 * publishing it is the failure this feature would be remembered for.
 *
 * HEADS, NOT REPLIES. "Who's coming?" is a question about how many people will be in
 * the room. One reply can be a family of four, so `yesHeads` is what the host is told
 * first; `yesGuests` is kept alongside it because "6 people across 2 families" is the
 * sentence a host actually plans with.
 *
 * `maybe` stays its own bucket. Rolling it into `no` would understate the room and
 * rolling it into `yes` would overstate it, and the host is the one who knows which of
 * their maybes usually show up.
 */

export type RsvpResponse = 'yes' | 'no' | 'maybe';

export interface TallyRow {
  displayName: string;
  response: RsvpResponse;
  headcount: number;
}

export interface RsvpTally {
  yesGuests: number;
  yesHeads: number;
  maybeGuests: number;
  maybeHeads: number;
  noGuests: number;
  /** Everyone coming or maybe-coming, in the order they answered. Never the declines —
   * a host asking "who's coming" is not asking to be handed a list of refusals. */
  names: string[];
}

export function tallyRsvps(rows: readonly TallyRow[]): RsvpTally {
  const tally: RsvpTally = {
    yesGuests: 0,
    yesHeads: 0,
    maybeGuests: 0,
    maybeHeads: 0,
    noGuests: 0,
    names: [],
  };
  for (const row of rows) {
    if (row.response === 'yes') {
      tally.yesGuests += 1;
      tally.yesHeads += row.headcount;
      tally.names.push(row.displayName);
    } else if (row.response === 'maybe') {
      tally.maybeGuests += 1;
      tally.maybeHeads += row.headcount;
      tally.names.push(row.displayName);
    } else {
      tally.noGuests += 1;
    }
  }
  return tally;
}

/** How many names fit in a text before it stops being a summary and becomes a list. */
const MAX_NAMES_IN_REPLY = 8;

/**
 * The tally as one SMS line. Deterministic copy — no model composes this, because a
 * paraphrased headcount is a wrong headcount.
 */
export function renderTally(tally: RsvpTally): string {
  if (tally.yesGuests === 0 && tally.maybeGuests === 0 && tally.noGuests === 0) {
    return 'No RSVPs yet.';
  }

  const replies = tally.yesGuests === 1 ? 'reply' : 'replies';
  const parts = [`${tally.yesHeads} coming (${tally.yesGuests} ${replies})`];
  if (tally.maybeGuests > 0) {
    parts.push(`${tally.maybeHeads} maybe`);
  }
  if (tally.noGuests > 0) {
    parts.push(`${tally.noGuests} can't make it`);
  }

  const shown = tally.names.slice(0, MAX_NAMES_IN_REPLY);
  const overflow = tally.names.length - shown.length;
  const roster =
    shown.length === 0
      ? ''
      : ` - ${shown.join(', ')}${overflow > 0 ? ` +${overflow} more` : ''}`;

  return `${parts.join(', ')}.${roster}`;
}
