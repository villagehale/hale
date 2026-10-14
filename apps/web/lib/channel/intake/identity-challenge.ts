import { replyLanguage } from '~/lib/channel/language';
import type { SaidLineWriter } from '~/lib/channel/voice/said-line';
import { type OptOutReading, isIdentityReading } from './opt-out-reader';

/**
 * VIL-333 — an identity or distrust challenge ("who is this", "is this a scam", a
 * demand for Hale's name or address), in any language.
 *
 * #868: the turn reader (opt-out-read) decides whether this is one — no pattern
 * list, so a Chinese or Arabic "who are you?" is read the same as an English one.
 * The disclosure is written by the model from {@link IDENTITY_FACTS}; the site and
 * contact address are checked verbatim, and the turn ends there.
 */

/** Ledger stamp for the router send. The body itself stays off the row (rule #1). */
export const IDENTITY_CHALLENGE_TEMPLATE_KEY = 'identity_challenge';

/**
 * Who is behind this number, as facts code hands the friend voice. The model
 * says them in its own words when a parent asks; the judge checks the company
 * is named whenever the inbound was a challenge.
 */
export const HALE_IDENTITY = {
  company: 'Village Hale Technologies Inc.',
  site: 'villagehale.com',
  person: 'Barton Dong',
  contact: 'aloha@villagehale.com',
} as const;

/** The only way to spell the company that counts as naming it. */
export const NAMES_HALE_COMPANY = /village\s?hale/i;

/** Who is accountable for Hale. Facts, not a sentence: the model says them in its own words. */
export const IDENTITY_FACTS = {
  assistant: 'Hale',
  company: 'Village Hale Technologies Inc.',
  website: 'villagehale.com',
  accountablePerson: 'Barton Dong',
  contactEmail: 'aloha@villagehale.com',
} as const;

export type IdentityChallengeReply =
  | { challenge: false }
  /** `body` null: the write failed and nothing goes out (logged by the writer). */
  | { challenge: true; body: string | null };

/**
 * The disclosure for this inbound, written by the model from {@link IDENTITY_FACTS}
 * (#868: no fixed line). The site and the contact address must appear verbatim; the
 * words around them are the model's. Not a challenge → `{ challenge: false }`.
 */
export async function identityChallengeReply(
  body: string,
  writer: SaidLineWriter | null | undefined,
  reading: OptOutReading | null,
): Promise<IdentityChallengeReply> {
  // #868: the turn reader decides, in any language. No pattern list.
  if (!isIdentityReading(reading)) return { challenge: false };
  if (!writer) {
    console.error('identity challenge: no line writer - nothing sent');
    return { challenge: true, body: null };
  }
  const written = await writer.write({
    purpose: 'identity',
    language: replyLanguage(body),
    parentWords: body,
    facts: { ...IDENTITY_FACTS },
    mustInclude: [IDENTITY_FACTS.website, IDENTITY_FACTS.contactEmail],
  });
  return { challenge: true, body: written };
}
