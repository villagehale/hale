import { type Database, schema } from '@hale/db';
import { f14EnabledFor } from '~/lib/channel/f14';
import { namesAPerson } from '~/lib/channel/activity/deidentify';
import type { GmailAlertEnvelope } from '~/lib/integrations/email-alert';
import { isAwayDestination } from './away';
import type { TravelExtractInput, TravelExtraction } from './extract';
import { travelBriefEnabledFor } from './flag';

/**
 * A BOOKING EMAIL BECOMES A TRIP ROW, OR IT BECOMES A COUNTER.
 *
 * Two stages and only the second costs anything. {@link looksLikeBooking} is a
 * deterministic two-token filter over the envelope the connector sweep already holds, so
 * the inbox is free; the extraction runs on what survives it, at most
 * {@link MAX_TRAVEL_EXTRACTS_PER_SWEEP} per connection per sweep.
 *
 * IT IS NOT A SENTINEL CLASS, deliberately. The sentinel's triage is a JUDGEMENT stage —
 * "would this email, if fully read, plausibly describe a change to a specific dated
 * occasion in a child's week" — and its negative list already answers false for shipping
 * and order notifications, which is what an airline receipt reads as. Teaching it a second
 * question would re-key every cached sentinel sample (the eval harness keys on the skill
 * text, and `eval:sentinel` is a --cached-only CI gate) to answer a question that is not a
 * judgement in the first place: a booking subject line carries a booking noun.
 */

/**
 * Every way one envelope can end (rule #11). A flat union so the connector-sync summary
 * counts it by name without a mapping step.
 *
 * `no_child_evidence` is the one Decision #1 turns on, and it is counted HERE — once per
 * email — rather than on the send sweep, where a due trip is re-selected hourly and any
 * count is either re-counted for the life of the row or filtered into zero. It is also
 * the only outcome with a durable record of its own (`travel_booking_passed_over`),
 * because a count in a cron response does not survive the week.
 *
 * `home_region_unknown` is deliberately ABSENT: the home region is a constant, so nothing
 * could produce it, and an outcome nothing can produce is a line that reads as a covered
 * case.
 */
export const TRAVEL_DETECT_OUTCOMES = [
  'trip_written',
  /** The (integration_id, message_id) unique index conflicted. */
  'already_seen',
  /** No booking noun in the subject, or no travel co-token beside it — free, and the
   * common case for every mailbox. */
  'not_booking_shaped',
  /** This run seeded the connection's cursor, so its envelopes are the mailbox's existing
   * 25: history nobody asked Hale to read. */
  'seeding_run',
  /** F14, or the travel flag and its allowlist. Counted before anything is read. */
  'dark',
  'no_parent_user',
  'over_sweep_cap',
  /** The extraction found no city — a restaurant reservation, a haircut, a parcel. */
  'no_destination',
  /** The city or region failed {@link destinationShape}, or named a household member.
   * Refused at the PARSE boundary, so nothing is written and nothing is searched. */
  'destination_unusable',
  /** Includes the one-way flight: `end_date` null. On a family trip the hotel is the row
   * that survives, and the flight folds into it at overlap collapse. */
  'no_dates',
  'not_away',
  /** Longer than {@link MAX_TRIP_NIGHTS}, or ending before it starts. A year-long lease
   * confirmation is not a trip. */
  'implausible_window',
  /** Below {@link CONFIDENCE_FLOOR} — including a confidence the model omitted, which
   * defaults to 0 rather than throwing. */
  'low_confidence',
  'in_the_past',
  /** R3: the booking's own text gives no sign the children are on it. NO ROW. */
  'no_child_evidence',
  /** Gmail said no. Not the same fact as a model that said nothing. */
  'body_fetch_failed',
  'extract_failed',
  /** The sweep's boundary names a throw, the `alert_failed` shape. */
  'detect_failed',
] as const;

export type TravelDetectOutcome = (typeof TRAVEL_DETECT_OUTCOMES)[number];
export type TravelDetectCounts = Record<TravelDetectOutcome, number>;

export function emptyTravelDetectCounts(): TravelDetectCounts {
  return Object.fromEntries(TRAVEL_DETECT_OUTCOMES.map((o) => [o, 0])) as TravelDetectCounts;
}

/**
 * At most this many envelopes per connection per sweep reach the model, newest first.
 *
 * The `EMAIL_ALERT_MAX_PER_SWEEP = 10` shape, and LOWER because the pre-filter has already
 * cut the field: ten booking-shaped confirmations in one fifteen-minute window is not a
 * family, it is a mailbox worth stopping at three.
 */
export const MAX_TRAVEL_EXTRACTS_PER_SWEEP = 3;

/** Longer than three weeks is not a trip — it is a lease, a term abroad, or a misread
 * date. */
export const MAX_TRIP_NIGHTS = 21;

/** Below this, nothing is written. Applied at write time, which is why no confidence is
 * stored: a persisted number nothing reads is a column with no reader. */
export const CONFIDENCE_FLOOR = 0.6;

/**
 * A booking noun in the SUBJECT. Not "a keyword anywhere": a subject line is the one field
 * a confirmation email spends on saying what it is.
 */
const BOOKING_NOUNS: readonly RegExp[] = [
  /\bitinerary\b/i,
  /\breservation\b/i,
  /\bbooking\s+confirm\w*\b/i,
  /\be-?ticket\b/i,
  /\byour\s+trip\s+to\b/i,
  /\byour\s+stay\s+at\b/i,
  /\bcheck-?in\s+(?:is\s+)?(?:now\s+)?open\b/i,
  /\bflight\s+confirmation\b/i,
];

/**
 * A travel co-token, in the subject OR the snippet, from a list that shares no member
 * with the one above.
 *
 * `room` IS NOT HERE, and its absence is the point rather than an oversight. It is the one
 * candidate that is ordinary household vocabulary — a daycare's "check-in is now open …
 * daily sign-in sheet for the room" carries a booking noun and would pass on it — and a
 * hotel confirmation that says nothing but "room" is one this filter is content to miss.
 * That is the same argument that makes the second token necessary at all, applied to the
 * second list.
 *
 * `flight` overlaps the `flight confirmation` NOUN as a substring, which means that one
 * subject satisfies both halves on its own. Stated rather than engineered around: "flight
 * confirmation" is unambiguously travel, and no household email carries it.
 */
const TRAVEL_CO_TOKENS: readonly RegExp[] = [
  /\bflights?\b/i,
  /\bairlines?\b/i,
  /\bairport\b/i,
  /\bdepart\w*\b/i,
  /\bboarding\b/i,
  /\bhotels?\b/i,
  /\bresort\b/i,
  /\bnights?\b/i,
  /\bguests?\b/i,
  /\bcheck-?out\b/i,
  /\bairbnb\b/i,
  /\bvrbo\b/i,
  /\brental\s+car\b/i,
  /\btrains?\b/i,
  /\bcruise\b/i,
  /\bterminal\b/i,
  /\bgate\b/i,
];

/**
 * TWO TOKENS FROM TWO LISTS, AND NOTHING ELSE.
 *
 * Not a sender allowlist: a list of airline domains is wrong the week a family books on a
 * carrier nobody added. Not a keyword matcher over ordinary household words: that is how a
 * destructive false positive shipped twice. A noun phrase a confirmation email actually
 * uses is neither — but ONE such noun is not enough.
 *
 * WHY TWO. A false positive here is not "one wasted Sonnet call". It is a NON-TRAVEL EMAIL
 * BODY PLUS THE HOUSEHOLD'S CHILDREN'S FIRST NAMES crossing the border to a US model,
 * under a purpose the /privacy sentence describes as booking emails. And the single nouns
 * are wide in exactly the household's own vocabulary: `reservation` matches a library hold
 * and a restaurant, `booking confirm*` matches a swim-lesson or daycare-tour booking,
 * `check-in is now open` matches a daycare's own notices. The sentinel pays the same
 * disclosure but only after a model judgement built to be narrow; here the judgement is a
 * regex, so the regex has to be narrow instead.
 *
 * A false negative is silence, which is this whole feature's chosen direction.
 */
export function looksLikeBooking(envelope: { subject: string; snippet: string }): boolean {
  const subject = envelope.subject ?? '';
  if (!BOOKING_NOUNS.some((noun) => noun.test(subject))) return false;
  const haystack = `${subject}\n${envelope.snippet ?? ''}`;
  return TRAVEL_CO_TOKENS.some((token) => token.test(haystack));
}

/**
 * A PLACE NAME, OR NOTHING — letters, marks, spaces and `.` `'` `-` only. No digits, no
 * `@`, no `#`, no comma, no slash.
 *
 * The comma in "New York, NY" is CODE's, composed at query time from two columns, never
 * the model's.
 *
 * WHY AT THE PARSE BOUNDARY AND NOT AT THE QUERY. `destination_city` and
 * `destination_region` are the only two fields in this feature a model fills that are then
 * PERSISTED, EXPORTED and SENT ACROSS A BORDER, and "no column, so unwritable" — the
 * argument that covers the rest of the table — is exactly the argument that does not cover
 * them. `gateFreeText` is not the answer either: it runs on the way to the search, long
 * after the row is written and available to the rights export, and its scrub is a pattern
 * list, so `ABC123`, `#4471`, `Room 412` and `1535 Broadway` cross it intact. A 7-digit PNR
 * is scrubbed out of the QUERY and still sitting in `destination_city` in the export — and
 * the query it leaves behind is "things to do in [redacted]", a silently useless search.
 */
const DESTINATION_SHAPE = /^\p{L}[\p{L}\p{M}\s'’.-]{1,59}$/u;

/**
 * True when this string is a usable place name for this household — the shape, and not a
 * member of the family.
 *
 * The name check runs HERE, at the write, rather than at the query gate: a child called
 * Sydney whose family goes to Sydney must be refused before the city is stored and
 * exported, not after.
 */
export function destinationShape(value: string, householdNames: readonly string[]): boolean {
  return DESTINATION_SHAPE.test(value) && !namesAPerson(value, householdNames);
}

/** Nights between two YYYY-MM-DD calendar days. Plain date arithmetic on purpose: these
 * are wall-clock days at the destination, not instants. */
function nightsBetween(startsOn: string, endsOn: string): number {
  const start = Date.parse(`${startsOn}T00:00:00Z`);
  const end = Date.parse(`${endsOn}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today, as the PARENT's calendar day. Not UTC: a boundary computed on the wrong clock is
 * one that is wrong for seven hours a day. */
export function localCalendarDay(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * WHAT THE DETECT PASS NEEDS. Every one is non-nullable (rule #11): "nothing is wired" is
 * a decision a caller makes out loud by passing a port that says so, and a pass that could
 * be built with the extractor absent is a pass that can silently do nothing.
 */
export interface TravelDetectPorts {
  /** The on-demand Gmail body read — {@link fetchGmailMessageBody}, already bound to this
   * run's access token. The body is held in one stack frame and never returned. */
  fetchBody(messageId: string): Promise<string>;
  extract(input: TravelExtractInput): Promise<TravelExtraction>;
  /** The children's FIRST NAMES, the only family context the extraction is handed. */
  childFirstNames(): Promise<readonly string[]>;
  /** Every name in the household — children's and parents' — for the parse-boundary
   * refusal. Wider than the list above on purpose: a city column is a public-ish field and
   * there is no member of a household whose name belongs in it. */
  householdNames(): Promise<readonly string[]>;
  /** The parent's wall clock, so "in the past" is answered on their calendar. */
  timeZone(parentUserId: string): Promise<string>;
}

export interface TravelDetectInput {
  familyId: string;
  /** Null when `integrations.user_id` is null — a connecting user with nobody to text,
   * which is an outcome and not a skip. */
  parentUserId: string | null;
  integrationId: string;
  seeding: boolean;
  envelopes: readonly GmailAlertEnvelope[];
  now: Date;
}

/**
 * One sweep's worth of Gmail envelopes for one connection → one outcome per envelope.
 *
 * Newest first and bounded, the email alert's own shape.
 */
export async function detectTravelBookingsForSweep(
  database: Database,
  input: TravelDetectInput,
  ports: TravelDetectPorts,
): Promise<readonly TravelDetectOutcome[]> {
  const { familyId, parentUserId, envelopes } = input;

  // BOTH FLAGS, BEFORE ANYTHING IS READ. A dark family's mailbox is not opened at all:
  // there is no body fetch, no model call and no row, which is what makes `dark` a claim
  // about collection rather than about sending.
  if (!f14EnabledFor(familyId) || !travelBriefEnabledFor(familyId)) {
    return envelopes.map(() => 'dark' as const);
  }
  if (parentUserId === null) return envelopes.map(() => 'no_parent_user' as const);
  if (input.seeding) return envelopes.map(() => 'seeding_run' as const);

  const outcomes: TravelDetectOutcome[] = [];
  const dated: Array<GmailAlertEnvelope & { receivedAt: string }> = [];
  for (const envelope of envelopes) {
    if (!looksLikeBooking(envelope)) {
      outcomes.push('not_booking_shaped');
      continue;
    }
    // An envelope with no `internalDate` cannot anchor a relative date, and the filter has
    // already said this one is booking-shaped — so it is the sweep cap's problem, not a
    // separate outcome: it sorts last and falls off the end.
    dated.push({ ...envelope, receivedAt: envelope.receivedAt ?? '' });
  }
  dated.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  for (let i = MAX_TRAVEL_EXTRACTS_PER_SWEEP; i < dated.length; i += 1) {
    outcomes.push('over_sweep_cap');
  }
  const considered = dated.slice(0, MAX_TRAVEL_EXTRACTS_PER_SWEEP);
  if (considered.length === 0) return outcomes;

  const [childFirstNames, householdNames, timeZone] = await Promise.all([
    ports.childFirstNames(),
    ports.householdNames(),
    ports.timeZone(parentUserId),
  ]);
  const today = localCalendarDay(input.now, timeZone);

  for (const envelope of considered) {
    outcomes.push(
      await detectOne(database, {
        familyId,
        parentUserId,
        integrationId: input.integrationId,
        envelope,
        childFirstNames,
        householdNames,
        today,
        ports,
      }),
    );
  }
  return outcomes;
}

async function detectOne(
  database: Database,
  args: {
    familyId: string;
    parentUserId: string;
    integrationId: string;
    envelope: GmailAlertEnvelope & { receivedAt: string };
    childFirstNames: readonly string[];
    householdNames: readonly string[];
    today: string;
    ports: TravelDetectPorts;
  },
): Promise<TravelDetectOutcome> {
  const { familyId, parentUserId, integrationId, envelope, ports } = args;

  let body: string;
  try {
    body = await ports.fetchBody(envelope.messageId);
  } catch (err) {
    // The class only: a rejection from a body fetch can carry a subject line (rule #1).
    console.error(
      { familyId, err: err instanceof Error ? err.constructor.name : 'unknown' },
      'travel detect: the body fetch was refused',
    );
    return 'body_fetch_failed';
  }

  let extraction: TravelExtraction;
  try {
    extraction = await ports.extract({
      subject: envelope.subject,
      from: envelope.from,
      body,
      receivedAt: envelope.receivedAt,
      childFirstNames: args.childFirstNames,
    });
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.constructor.name : 'unknown' },
      'travel detect: the extraction failed',
    );
    return 'extract_failed';
  }

  if (extraction.confidence < CONFIDENCE_FLOOR) return 'low_confidence';

  const city = extraction.destinationCity?.trim() ?? '';
  if (city === '') return 'no_destination';
  if (!destinationShape(city, args.householdNames)) return 'destination_unusable';

  const region = extraction.destinationRegion?.trim() ?? '';
  if (region !== '' && !destinationShape(region, args.householdNames)) {
    return 'destination_unusable';
  }

  const startsOn = extraction.startDate ?? '';
  const endsOn = extraction.endDate ?? '';
  if (!ISO_DATE.test(startsOn) || !ISO_DATE.test(endsOn)) return 'no_dates';

  const nights = nightsBetween(startsOn, endsOn);
  if (nights < 0 || nights > MAX_TRIP_NIGHTS) return 'implausible_window';
  if (startsOn < args.today) return 'in_the_past';
  if (!isAwayDestination(city)) return 'not_away';

  if (extraction.childEvidence === 'none') {
    // THE MISS RATE, MADE DURABLE. An enum and nothing else — no city, no dates, no
    // subject — on the `proactive_nudge_skipped` precedent: a deliberate silence is a real
    // outcome a parent should be able to see, and `audit_log` is the only surface in this
    // product that keeps a month. The detect counter beside it is read week to week; this
    // row is what answers "what was the ratio last month".
    await database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'travel_booking_passed_over',
      targetTable: null,
      targetId: null,
      after: { childEvidence: 'none' },
    });
    return 'no_child_evidence';
  }

  // CLAIMED BY THE UNIQUE INDEX, not by a read a concurrent sweep can race: one email is
  // one trip, forever.
  const [written] = await database
    .insert(schema.familyTrips)
    .values({
      familyId,
      parentUserId,
      integrationId,
      messageId: envelope.messageId,
      destinationCity: city,
      destinationRegion: region === '' ? null : region,
      startsOn,
      endsOn,
      childEvidence: extraction.childEvidence,
    })
    .onConflictDoNothing()
    .returning({ id: schema.familyTrips.id });
  if (!written) return 'already_seen';

  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'travel_trip_noticed',
    targetTable: 'family_trips',
    targetId: written.id,
    // ENUMS AND COUNTS ONLY — never the city, never the dates. An audit row a support
    // agent can read is a copy of the booking in a table that is never redacted (rule #1).
    // The city and the dates live on the trip row, which the rights export serves to the
    // parent whose mailbox it came from.
    after: { childEvidence: extraction.childEvidence, nights },
  });
  return 'trip_written';
}
