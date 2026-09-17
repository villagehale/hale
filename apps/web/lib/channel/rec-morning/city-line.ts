import { asciiCopy, asciiSpaces } from '~/lib/channel/intake/radar-decide';
import { townLabel } from '~/lib/channel/town-label';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import { nextWatchedCycle } from '~/lib/registration/discovery-targets';
import {
  REGISTRATION_WINDOWS,
  type RegistrationWindowSeed,
} from '~/lib/registration/registration-windows-data';
import { TORONTO_REC_PORTAL } from './facts';
import type { RecHelloCity } from './match';

/**
 * A town's rec-morning line, DERIVED from the registration dataset and `now`.
 *
 * Every city hello here used to be a hand-locked sentence with a date inside it. A
 * locked string cannot notice a morning going past, so each one kept offering a
 * registration the parent had already missed: Toronto's went that way on Sept 16
 * (VIL-334) and, a cycle later, so had Halton Hills', Pickering's, Brampton's and
 * Richmond Hill's — and Vaughan's named November dates that appear nowhere in the
 * dataset at all. Twice is a shape, so the dates are gone from the copy: the only
 * dates a parent can be told are the ones a municipality published and a human
 * verified into registration-windows-data.ts.
 *
 * A town with NO row gets no line (null), and the caller says nothing rather than
 * asserting a season Hale has no record of — the same rule the dataset itself keeps,
 * where an unpublished cycle gets no placeholder row.
 */

/** The domains a parent asks a rec morning about, in the order a line names them.
 * `after_school_care` runs on the school-year calendar and is nobody's rec morning. */
const DOMAIN_NOUN = { rec_program: 'rec', swim: 'swim', camp: 'camps' } as const;

export type RecDomain = keyof typeof DOMAIN_NOUN;

const DOMAIN_ORDER = Object.keys(DOMAIN_NOUN) as readonly RecDomain[];

const LEFTOVER_OFFER = 'I can watch leftovers and the waitlist.';

/** One registration EVENT: the cycle a town opens at one instant, however many
 * domains ride on it (Toronto registers swim inside its seasonal cycle; Brampton
 * gives aquatics its own morning). */
interface CycleEvent {
  cycleLabel: string;
  domains: [RecDomain, ...RecDomain[]];
  residentOpenAt: Date | null;
  openAt: Date;
}

/** A seed row for a domain a rec morning is about. */
type RecRow = RegistrationWindowSeed & { programDomain: RecDomain };

const WEEKDAY = new Intl.DateTimeFormat('en-CA', {
  weekday: 'long',
  timeZone: DEFAULT_TIMEZONE,
});
const MONTH_DAY = new Intl.DateTimeFormat('en-CA', {
  month: 'short',
  day: 'numeric',
  timeZone: DEFAULT_TIMEZONE,
});
const CLOCK = new Intl.DateTimeFormat('en-CA', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: DEFAULT_TIMEZONE,
});
const CLOCK_24 = new Intl.DateTimeFormat('en-CA', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: DEFAULT_TIMEZONE,
});

function partOf(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? '';
}

/**
 * `7 a.m.`, `6:30 a.m.`, or nothing at all. A start-of-day instant is the dataset's
 * encoding for a town that published a DATE and no time (Richmond Hill's whole
 * calendar), so naming a clock there would invent the one fact the town withheld.
 */
function clockPhrase(date: Date): string | null {
  if (CLOCK_24.format(date) === '00:00') return null;
  const parts = CLOCK.formatToParts(date);
  const hour = partOf(parts, 'hour');
  const minute = partOf(parts, 'minute');
  const dayPeriod = partOf(parts, 'dayPeriod');
  return minute === '00' ? `${hour} ${dayPeriod}` : `${hour}:${minute} ${dayPeriod}`;
}

/** A morning still to come: the weekday a parent plans against, then the date. */
function upcomingPhrase(date: Date): string {
  const clock = clockPhrase(date);
  const day = `${WEEKDAY.format(date)} ${MONTH_DAY.format(date)}`;
  return asciiSpaces(clock === null ? day : `${day} at ${clock}`);
}

/** A morning that has gone. No weekday and no clock: a parent cannot act on either. */
function pastPhrase(date: Date): string {
  return asciiSpaces(MONTH_DAY.format(date));
}

/** "7 a.m." ends the sentence itself; a second full stop after it reads as a typo. */
function endSentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

function joinNouns(domains: readonly RecDomain[]): string {
  const nouns = domains.map((domain) => DOMAIN_NOUN[domain]);
  if (nouns.length <= 1) return nouns.join('');
  return `${nouns.slice(0, -1).join(', ')} and ${nouns[nouns.length - 1]}`;
}

function isRecDomain(domain: string): domain is RecDomain {
  return domain in DOMAIN_NOUN;
}

function recRows(city: RecHelloCity, windows: readonly RegistrationWindowSeed[]): RecRow[] {
  return windows.filter(
    (seed): seed is RecRow => seed.municipality === city && isRecDomain(seed.programDomain),
  );
}

function groupIntoEvents(rows: readonly RecRow[]): CycleEvent[] {
  const events = new Map<string, CycleEvent>();
  for (const row of rows) {
    const key = `${row.cycleLabel}|${row.residentOpenAt ?? ''}|${row.openAt}`;
    const event = events.get(key);
    if (event) {
      event.domains.push(row.programDomain);
      continue;
    }
    events.set(key, {
      cycleLabel: row.cycleLabel,
      domains: [row.programDomain],
      residentOpenAt: row.residentOpenAt === null ? null : new Date(row.residentOpenAt),
      openAt: new Date(row.openAt),
    });
  }
  for (const event of events.values()) {
    event.domains.sort((a, b) => DOMAIN_ORDER.indexOf(a) - DOMAIN_ORDER.indexOf(b));
  }
  return [...events.values()];
}

/** Rec, then swim, then camps — a tie-break, so two cycles opening at the same instant
 * pick the same one of themselves run to run. */
function domainRank(event: CycleEvent): number {
  return DOMAIN_ORDER.indexOf(event.domains[0]);
}

/** The first date of this event a parent can still act on. */
function nextDateOf(event: CycleEvent, now: Date): Date {
  return event.residentOpenAt !== null && event.residentOpenAt.getTime() > now.getTime()
    ? event.residentOpenAt
    : event.openAt;
}

function openedAtOf(event: CycleEvent): Date {
  return event.residentOpenAt ?? event.openAt;
}

/** The label says which cycle this is on its own, unless the town hangs two cycles off
 * the same one — Vaughan runs a "Fall Session 2026" for rec and another for swim. */
function labelNeedsNouns(event: CycleEvent, townEvents: readonly CycleEvent[]): boolean {
  return townEvents.filter((other) => other.cycleLabel === event.cycleLabel).length > 1;
}

function upcomingLine(
  city: RecHelloCity,
  event: CycleEvent,
  now: Date,
  townEvents: readonly CycleEvent[],
): string {
  const resident = event.residentOpenAt;
  const residentGone = resident !== null && resident.getTime() <= now.getTime();
  const halves =
    resident === null
      ? upcomingPhrase(event.openAt)
      : residentGone
        ? `residents opened ${pastPhrase(resident)}, non-residents ${upcomingPhrase(event.openAt)}`
        : `residents ${upcomingPhrase(resident)}, non-residents ${upcomingPhrase(event.openAt)}`;
  const nouns = labelNeedsNouns(event, townEvents) ? `${joinNouns(event.domains)} ` : '';
  const line = endSentence(
    `${townLabel(city)} ${asciiCopy(event.cycleLabel)} ${nouns}registration: ${halves}`,
  );
  // The resident head start has gone: the date still to come is not this parent's, and
  // leftovers and the waitlist are the only thing left that Hale can do for them.
  return residentGone ? `${line} ${LEFTOVER_OFFER}` : line;
}

/** The cycle a town opened most recently, with the general rec cycle winning a tie
 * against a swim or camp one so the same representative is picked run to run. */
function laterCycle(a: CycleEvent, b: CycleEvent): CycleEvent {
  const order =
    b.openAt.getTime() - a.openAt.getTime() ||
    domainRank(a) - domainRank(b) ||
    a.cycleLabel.localeCompare(b.cycleLabel);
  return order <= 0 ? a : b;
}

/**
 * The season has gone and the next one is not posted — two facts and no promise
 * beyond the one Hale can keep. The date named is when the cycle OPENED, not the
 * last of its halves to go by: the claim is about the town's calendar, so a resident
 * head start is the morning the town's registration started.
 */
function betweenCyclesLine(
  city: RecHelloCity,
  events: readonly CycleEvent[],
  rows: readonly RecRow[],
): string {
  const latest = events.reduce(laterCycle);
  const openedAt = events
    .filter((event) => event.cycleLabel === latest.cycleLabel)
    .map(openedAtOf)
    .reduce((earliest, date) => (date.getTime() < earliest.getTime() ? date : earliest));

  const domain = latest.domains[0];
  const known = new Set(
    rows.filter((row) => row.programDomain === domain).map((row) => row.cycleLabel),
  );
  const next = nextWatchedCycle(city, domain, known);
  const nextLabel = next === null ? 'the next' : asciiCopy(next);
  return `${townLabel(city)} ${asciiCopy(latest.cycleLabel)} registration already opened ${pastPhrase(openedAt)} - ${nextLabel} dates are not posted yet. ${LEFTOVER_OFFER}`;
}

/**
 * This town's rec-morning answer as of `now`, or null when the dataset holds no
 * window for it (Milton, today) and there is nothing true to say.
 *
 * `domain` is the program the parent named, where they named one: Brampton runs
 * aquatics sixteen days behind general rec, so a rec ask and a swim ask are two
 * different mornings. A domain the town has no row in answers about the whole town
 * rather than falling silent — the dataset has nothing for that program, not nothing
 * for that town, and those are different claims.
 */
export function cityRecLine(
  city: RecHelloCity,
  now: Date,
  domain: RecDomain | null = null,
  windows: readonly RegistrationWindowSeed[] = REGISTRATION_WINDOWS,
): string | null {
  const townRows = recRows(city, windows);
  if (townRows.length === 0) return null;

  const asked = townRows.filter((row) => domain === null || row.programDomain === domain);
  const rows = asked.length === 0 ? townRows : asked;

  const events = groupIntoEvents(rows);
  const [soonest] = events
    .filter((event) => event.openAt.getTime() > now.getTime())
    .sort(
      (a, b) =>
        nextDateOf(a, now).getTime() - nextDateOf(b, now).getTime() ||
        domainRank(a) - domainRank(b) ||
        a.cycleLabel.localeCompare(b.cycleLabel),
    );

  const line = soonest
    ? upcomingLine(city, soonest, now, groupIntoEvents(townRows))
    : betweenCyclesLine(city, events, rows);

  // Toronto is the one city whose login Hale names: the portal outlives every cycle,
  // and it is what a parent chasing leftovers needs either way.
  return city === 'toronto' ? `${line} Sign in at ${TORONTO_REC_PORTAL}.` : line;
}
