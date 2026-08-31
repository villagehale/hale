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
 * apostrophe class carries U+2019 because iPhones send smart punctuation. */
const NEGATION = /\b(?:don['’]?t|do not|never|stop|unlink|disconnect(?:ed)?|remove|revoke)\b/i;

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
