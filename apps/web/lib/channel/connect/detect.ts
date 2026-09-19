import type { ConnectorProvider } from '~/lib/integrations/google-oauth';

/**
 * The connector-request detector — the deterministic branch that reads "connect my
 * Google Calendar" before the coach ever runs, so the answer can be a real link
 * instead of a composed refusal (the registration-context failure class: the refusal
 * shape is trained, and the trigger is the absence of a tool that knows better).
 *
 * CONSERVATIVE BY CONSTRUCTION. A miss costs one coach turn, and the coach's skill
 * now names this branch; a false claim mints a sign-in link nobody asked for. So a
 * claim requires an explicit connect-verb followed closely by a provider noun — never
 * a bare noun, never a question about the calendar's CONTENTS — and any negation,
 * revocation, or leading status-auxiliary sends the turn to the coach instead.
 */

/** The asks that are the OPPOSITE of a connect ask, or a report about one. The
 * apostrophe class carries U+2019 because iPhones send smart punctuation.
 *
 * Every verb the DISCONNECT matcher below reads is in here, which is what makes the
 * two halves disjoint by construction rather than by careful reading: no body can be
 * claimed by both, so their order in the handler chain cannot matter. */
const NEGATION =
  /\b(?:don['’]?t|do not|never|stop|unlink|unhook|disconnect(?:ed)?|remove|revoke|d[ée]connecte|d[ée]lie|arr[êe]te)\b/i;

/**
 * A leading auxiliary is a STATUS or CAPABILITY question — "is my calendar
 * connected", "do you sync calendars" — which the coach can answer with a question
 * back; a mint cannot.
 */
const STATUS_QUESTION = /^\s*(?:did|do|does|have|has|is|are|was|were|what|when|where|who|why)\b/i;

/** The words between the verb and the noun a real ask actually uses. Anything else —
 * "let's connect after I check the calendar" — is conversation, not a request. */
const LEAD = String.raw`(?:\s+(?:up|to))?(?:\s+(?:my|our|the|his|her|their|mon|ma|mes|notre|nos|votre|vos|le|la|les))?\s+`;

const CONNECT_VERB =
  '(?:connect(?:ing)?|link(?:ing)?|sync(?:ing)?|synchroni[sz]e|hook(?:ing)?\\s+up|connecte[rz]?|branche[rz]?|synchronise[rz]?|synchroniser)';
/** Reading applies to MAIL and FILES only: "read my calendar" is a contents ask. */
const READ_VERB = '(?:read(?:ing)?|access|lis(?:ez)?|lire)';

const CALENDAR_NOUN =
  '(?:google\\s+calendar|google\\s+agenda|gcal|calendars?|calendriers?|agendas?)';
const GMAIL_NOUN = '(?:gmail)';
/** Never bare "drive" — that is somebody's commute. */
const DRIVE_NOUN = '(?:google\\s+drive)';

const PATTERNS: ReadonlyArray<{ provider: ConnectorProvider; pattern: RegExp }> = [
  { provider: 'gcal', pattern: new RegExp(`\\b${CONNECT_VERB}${LEAD}${CALENDAR_NOUN}\\b`, 'i') },
  {
    provider: 'gmail',
    pattern: new RegExp(`\\b(?:${CONNECT_VERB}|${READ_VERB})${LEAD}${GMAIL_NOUN}\\b`, 'i'),
  },
  {
    provider: 'gdrive',
    pattern: new RegExp(`\\b(?:${CONNECT_VERB}|${READ_VERB})${LEAD}${DRIVE_NOUN}\\b`, 'i'),
  },
];

/** The provider a message plainly asks to connect, or null — and null is the safe
 * answer: an unmatched ask falls through to the coach, which knows this branch exists. */
export function matchConnectorRequest(body: string): ConnectorProvider | null {
  if (NEGATION.test(body) || STATUS_QUESTION.test(body)) return null;
  for (const { provider, pattern } of PATTERNS) {
    if (pattern.test(body)) return provider;
  }
  return null;
}

/**
 * ── THE OTHER HALF: ending a connection ─────────────────────────────────────────
 *
 * The asymmetry with the connect half above is deliberate and lives here so it is
 * visible rather than accidental. A false CONNECT claim mints a link nobody asked for;
 * a false DISCONNECT claim deletes a token, stops the sweep and writes an immutable
 * audit row. So this half keeps the connect half's whole vocabulary of nouns (a parent
 * ending something says "my calendar", and Hale's own connected receipt tells them to
 * say exactly that — connect/text-connect.ts) and pays for it everywhere else:
 *
 *  - `remove` is NOT a disconnect verb. It is a content verb — remove the hold, the
 *    invite, the event — and it was the single biggest source of false positives.
 *  - the LEAD is possessive-only, so "the calendar" and "his calendar" are not this
 *    parent's grant (DISCONNECT_LEAD).
 *  - the noun must not be followed by a CONTENT tail — "the calendar invite", "my
 *    calendar access for the nanny", "my email from my phone" (CONTENT_TAIL).
 *  - a negation kills the claim outright ("dont disconnect my calendar").
 *  - a leading auxiliary kills it too ("could you unlink the calendar invite", "can
 *    you disconnect it"): those are questions the coach answers, and the receipt tells
 *    the parent the plain words that do work.
 *
 * Disjoint from the connect half BY CONSTRUCTION: every verb below is inside the
 * connect matcher's NEGATION class, so no body can claim both. detect.test.ts asserts
 * that over the whole table rather than trusting the reading.
 */
const DISCONNECT_VERB =
  '(?:disconnect(?:ing)?|unlink(?:ing)?|unhook(?:ing)?|revoke|stop\\s+(?:syncing|reading|watching)|d[ée]connecte[rz]?|d[ée]lie[rz]?|arr[êe]te[rz]?\\s+de\\s+(?:synchroniser|lire|surveiller))';

/** Mail, as a parent names it when ending it. "Gmail" is the product; "my email" is
 * what most of them actually type, and after an explicit disconnect verb it cannot be
 * anything else. */
const MAIL_NOUN = '(?:gmail|e-?mails?|courriels?)';

/**
 * POSSESSIVE ONLY, and this is the line the connect half deliberately does not draw.
 *
 * A parent ending their OWN grant says "my calendar" / "mon agenda", or names the
 * product with nothing in front ("disconnect gmail"). "THE calendar" is a thing in the
 * world — the one on the fridge, the one an invite belongs to; "HIS calendar" is the
 * co-parent's, and the revoke predicate is keyed on the texter, so acting on it would
 * end the wrong grant while answering as if it had ended the named one. Minting a link
 * for "connect the calendar" costs a text; deleting a token for "unhooking the calendar
 * from the fridge lol" costs the grant, so only this half pays for the article.
 */
const DISCONNECT_LEAD = String.raw`(?:\s+(?:my|our|mon|ma|mes|notre|nos))?\s+`;

/**
 * What a CONTENT ask says right after the noun — the other half of the same subtraction.
 *
 * The verb list cannot decline these, because the verb really is "disconnect" or
 * "unlink": "unlink the calendar invite", "revoke my calendar access for the nanny"
 * (a caregiver's scope, not Google's grant), "disconnecting my email from my phone this
 * weekend" (a weekend plan). A grant has no invite, no event, no hold and no "from", so
 * a custody instruction never carries one of these — while every sentence above purged
 * a token before this lookahead existed. French mirrors are in the same list because the
 * matcher answers French and the defect there is the same one.
 */
const CONTENT_TAIL = String.raw`(?!\s+(?:invite|invitation|event|[ée]v[ée]nement|hold|reminder|rappel|access|acc[èe]s|from|for|and|de|du|des|pour|et)\b)`;

/** "dont disconnect my calendar" and "never unlink our calendar please" are the
 * opposite instruction. The apostrophe class carries U+2019 (iPhone smart quotes). */
const DISCONNECT_NEGATION = /\b(?:don['’]?t|do not|never|ne\s+pas|jamais)\b/i;

/** A leading auxiliary is a question or a request for help, not the instruction: the
 * coach owns it, and Hale's copy hands the parent the plain words. */
const POLITE_ASK = /^\s*(?:can|could|would|please|peux|pouvez)\b/i;

const DISCONNECT_PATTERNS: ReadonlyArray<{ provider: ConnectorProvider; pattern: RegExp }> = [
  {
    provider: 'gcal',
    pattern: new RegExp(
      `\\b${DISCONNECT_VERB}${DISCONNECT_LEAD}${CALENDAR_NOUN}\\b${CONTENT_TAIL}`,
      'i',
    ),
  },
  {
    provider: 'gmail',
    pattern: new RegExp(
      `\\b${DISCONNECT_VERB}${DISCONNECT_LEAD}${MAIL_NOUN}\\b${CONTENT_TAIL}`,
      'i',
    ),
  },
  {
    provider: 'gdrive',
    pattern: new RegExp(
      `\\b${DISCONNECT_VERB}${DISCONNECT_LEAD}${DRIVE_NOUN}\\b${CONTENT_TAIL}`,
      'i',
    ),
  },
];

/** The provider a message plainly instructs Hale to disconnect, or null — and null is
 * again the safe answer, because null costs a coach turn and a wrong claim costs a
 * grant. */
export function matchConnectorDisconnectRequest(body: string): ConnectorProvider | null {
  if (DISCONNECT_NEGATION.test(body) || STATUS_QUESTION.test(body) || POLITE_ASK.test(body)) {
    return null;
  }
  for (const { provider, pattern } of DISCONNECT_PATTERNS) {
    if (pattern.test(body)) return provider;
  }
  return null;
}
