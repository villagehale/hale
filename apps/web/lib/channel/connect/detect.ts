import type { ConnectorProvider } from '~/lib/integrations/google-oauth';

/**
 * The connect door's two cheap shape matchers — the fresh-link follow-up and the
 * explicit DISCONNECT instruction — plus the reader of which account a prior Hale offer
 * carried.
 *
 * The CONNECT ask itself ("connect my Google Calendar", "can you read my gmail") is no
 * longer a regex: it is read by the model through connect/request-intent.ts, with a
 * verbatim guard and a confidence floor, so a parent never has to hit a keyword. What
 * stays here is only what a regex is the RIGHT tool for: a short follow-up shape that
 * needs a prior offer to mean anything, and a hard-to-reverse instruction whose
 * false-positive cost (a deleted grant) argues for the most conservative reader there is.
 */

/** The asks that are the OPPOSITE of a connect ask, or a report about one. The
 * apostrophe class carries U+2019 because iPhones send smart punctuation. */
const NEGATION =
  /\b(?:don['’]?t|do not|never|stop|unlink|unhook|disconnect(?:ed)?|remove|revoke|d[ée]connecte|d[ée]lie|arr[êe]te)\b/i;

/**
 * A leading auxiliary is a STATUS or CAPABILITY question — "is my calendar
 * connected", "do you sync calendars" — which the coach can answer with a question
 * back; a mint cannot.
 */
const STATUS_QUESTION = /^\s*(?:did|do|does|have|has|is|are|was|were|what|when|where|who|why)\b/i;

const CALENDAR_NOUN =
  '(?:google\\s+calendar|google\\s+agenda|gcal|calendars?|calendriers?|agendas?)';
/** Never bare "drive" — that is somebody's commute. */
const DRIVE_NOUN = '(?:google\\s+drive)';

/**
 * A short follow-up that asks for another link without naming the provider.
 *
 * "give me a fresh one", "new link", and "it expired" are the live misses: they
 * carry no account, so even the model reader answers `other` for them. This matcher
 * does not name a provider. The handler mints only when the previous Hale message
 * was already a Gmail or calendar connect link, and it runs BEFORE the model read so
 * a follow-up costs no classify call.
 */
const FRESH_LINK_FOLLOW_UP: readonly RegExp[] = [
  /\b(?:give|send|get)\s+me\s+(?:a\s+)?(?:fresh|new|another)\s+(?:one|link)\b/i,
  /\b(?:fresh|new|another)\s+link\b/i,
  /\bfresh one\b/i,
  /\b(?:it|that|this|the link|this link|that link)\s+(?:has\s+)?expired\b/i,
  /\blink\s+(?:has\s+)?expired\b/i,
  /\b(?:donne[rz]?(?:-moi)?|envoyez?(?:-moi)?)\s+(?:un\s+)?(?:nouveau|autre)\s+lien\b/i,
  /\b(?:nouveau|autre)\s+lien\b/i,
  /\b(?:il|elle|ça|ca|le lien|ce lien)\s+a\s+expir/i,
  /\blien\s+expir/i,
];

export function matchFreshConnectorFollowUp(body: string): boolean {
  const text = body.trim();
  if (text.length === 0 || text.length > 120) return false;
  if (NEGATION.test(text) || STATUS_QUESTION.test(text)) return false;
  return FRESH_LINK_FOLLOW_UP.some((pattern) => pattern.test(text));
}

/** Which connector a Hale message already offered, read off the link it carried. */
export type ConnectOfferTarget = 'gcal' | 'gmail' | 'both';

/**
 * Read off the LINK, never the prose: the line over it is the model's and has no fixed
 * phrase to match. The `to=` parameter is what connect/offer.ts mints into every URL.
 */
export function connectOfferTarget(body: string): ConnectOfferTarget | null {
  const gmail = /[?&]to=gmail\b/i.test(body);
  const gcal = /[?&]to=gcal\b/i.test(body);
  if (gmail && gcal) return 'both';
  if (gmail) return 'gmail';
  if (gcal) return 'gcal';
  return null;
}

/**
 * ── THE OTHER HALF: ending a connection ─────────────────────────────────────────
 *
 * The asymmetry with the connect read is deliberate and lives here so it is visible
 * rather than accidental. A false CONNECT claim mints a link nobody asked for, which is
 * why that read can be the model's; a false DISCONNECT claim deletes a token, stops the
 * sweep and writes an immutable audit row, which is why this one stays a shape matcher
 * that pays for its noun vocabulary everywhere else:
 *
 *  - `remove` is NOT a disconnect verb. It is a content verb — remove the hold, the
 *    invite, the event — and it was the single biggest source of false positives.
 *  - the LEAD is possessive-only, so "the calendar" and "his calendar" are not this
 *    parent's grant (DISCONNECT_LEAD).
 *  - the noun must not be followed by a CONTENT tail — "the calendar invite", "my
 *    calendar access for the nanny", "my email from my phone" (CONTENT_TAIL).
 *  - a negation kills the claim outright ("dont disconnect my calendar").
 *  - a leading auxiliary kills it too ("could you unlink the calendar invite", "can
 *    you disconnect it"): those are questions the coach answers, and the connect
 *    card tells the parent the plain words that do work.
 *
 * Every verb below is inside the fresh-link matcher's NEGATION class, so a disconnect
 * can never be mistaken for a "new link" follow-up; the model-side connect reader is
 * told (request-intent.md) that a disconnect is `other`, and detect.test.ts keeps the
 * regex half of that promise over the whole table.
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
