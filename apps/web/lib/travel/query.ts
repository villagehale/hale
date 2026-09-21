/**
 * WHAT HALE ASKS THE WEB ABOUT A DESTINATION — the subject, the window and the place, all
 * three composed by CODE.
 *
 * This module is small and it is the whole quality lever, because `activity-finder.md` is
 * deliberately NOT being edited. That skill tells the model `town` is "the family's
 * municipality", to find "programs that are actually running, in that town, for that age
 * band, in that window", to prefer "a municipal recreation site, a community centre, a
 * gymnastics club's own page, a library branch, an EarlyON provider", and that
 * "registration for a fall session usually opens weeks before it starts". Handed
 * town="New York, NY" and a four-day window with no travel framing, the honest model
 * answer is a fall swim session with a registration date — a correct answer to the wrong
 * question, texted to a family on holiday.
 */

/**
 * THE SUBJECT. A VISIT, not a term.
 *
 * 113 characters, under `MAX_QUERY_FIELD_CHARS = 120`. No digits and no age word, so it
 * survives `scrubResidualPii` unchanged — the age band travels on `stage` and nowhere
 * else, because "things to do with a 3 year old" scrubs to "things to do with a
 * [redacted]".
 *
 * EVERY WORD OF IT IS MEASURED, and two of them were wrong the first time. The three
 * travel fixtures in `apps/worker/evals/activity-finder-fixtures.mjs` are the only
 * evidence this string works, because `activity-finder.md` is deliberately not edited;
 * they were minted live against the real skill, and the first draft —
 * "...on a short visit: museums, zoos, aquariums, playgrounds, indoor drop-ins" — came
 * back from the Ottawa Labour-Day fixture with an EarlyON drop-in playgroup among its
 * three picks. That is a real, well-sourced find and it is useless to the family: EarlyON
 * is a resident service whose value is a recurring weekly slot, and "indoor drop-ins" is
 * the phrase that invited it. So the frame is now said three times over — VISITING, FOR A
 * FEW DAYS, TURN UP TO — and the category list names only places that are open to whoever
 * walks in. Change a word here and those three fixtures re-key and must be re-minted live:
 * that is the point of them.
 */
export const TRAVEL_SUBJECT =
  'things a family visiting for a few days can turn up to with young children: museums, zoos, aquariums, playgrounds';

/**
 * THE WINDOW — "September 12 to 15", and the shape is load-bearing.
 *
 * THE LANDMINE. `scrubResidualPii` replaces ISO dates (`(19|20)\d\d[-/]\d{1,2}[-/]\d{1,2}`),
 * `M/D/YYYY`, `Month D, YYYY` and a bare `\d{1,2} years?`. So a window written as
 * "2026-09-12 to 2026-09-15" crosses the border as "[redacted] to [redacted]" and the
 * search silently loses its dates — no error anywhere, just a worse answer forever. A
 * window with NO YEAR and not in ISO form survives every pattern: the `Month D, YYYY` rule
 * requires a trailing year, and `September 12 to 15` carries none.
 *
 * There is a test pair for exactly this, and it is the one that fails open if it is not
 * written: it asserts the composed window crosses `gateFreeText` byte for byte, WITH the
 * ISO form beside it coming back redacted as the positive control.
 *
 * The month name comes from the same `en-CA` formatter the rest of the product uses, over
 * the destination's own calendar days — these are wall-clock dates at the destination, so
 * they are formatted in UTC rather than in anyone's zone, which is what `starts_on` and
 * `ends_on` mean.
 */
export function travelWindow(startsOn: string, endsOn: string): string {
  const start = new Date(`${startsOn}T12:00:00Z`);
  const end = new Date(`${endsOn}T12:00:00Z`);
  const month = (at: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', month: 'long' }).format(at);
  const day = (at: Date) => at.getUTCDate();

  if (month(start) === month(end)) {
    // "September 12 to 15" — the same month said once.
    return day(start) === day(end)
      ? `${month(start)} ${day(start)}`
      : `${month(start)} ${day(start)} to ${day(end)}`;
  }
  // "August 30 to September 2" — a trip across a month boundary. Still no year.
  return `${month(start)} ${day(start)} to ${month(end)} ${day(end)}`;
}

/**
 * THE PLACE. "New York, NY" — and THE COMMA IS CODE'S, composed here from two columns,
 * never written by the model. `destinationShape` refuses a comma in either column at the
 * parse boundary precisely so that this is the only place one can appear.
 */
export function travelDestination(city: string, region: string | null): string {
  return region === null || region.trim() === '' ? city : `${city}, ${region}`;
}
