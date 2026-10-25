/**
 * VIL-273 — the off-domain lines that still go out without a model, in one file.
 *
 * Could-not-answer, child health, a parent's crisis, and a physical emergency are not
 * among them. Those replies are written by moment-reply.md, in the parent's language
 * (moment-reply.ts). Crisis and emergency stop the ordinary answer first; the model
 * then points to emergency or local help and does not recite a number.
 *
 * What survives here is the provider door (a table keyed by service). Crisis and
 * emergency are judged by the model lane, not by a word list.
 *
 * NOTHING HERE POINTS AT THE APP. Not as a fallback, not for an overflow. A parent who
 * texted is owed a text back, and "finish this in the app" is the shape of dead end the
 * F14 voice rules and the v3 doctrine both refuse.
 *
 * GSM-7 (VIL-265): plain hyphens, straight apostrophes, no em dashes, no emoji. Every
 * string here is scanned by lib/channel/sms-copy-encoding.test.ts.
 *
 * The provider lines have a French twin, picked by `replyLanguage` from the message
 * that just arrived (lib/channel/language.ts). The French is written INSIDE the GSM-7
 * alphabet — é è à ù are in it, â ê î ô û ç are not. See the same note at the top of
 * intake/copy.ts.
 */
import type { ReplyLanguage } from '~/lib/channel/language';
import { speak } from '~/lib/channel/spoken-line';

/**
 * Whether a model-written body is reaching for a health-line number (skill audit P0 #3).
 *
 * Whole tokens only, so an ordinary week does not trip it — `9:11` is a swim time and
 * `647-555-0811` is a phone number, and neither contains the token. An improvised
 * referral that names no number ("that one's for your doctor") is invisible here.
 */
export function reachesForTheHealthLine(body: string): boolean {
  return /\b(?:811|911)\b/.test(body);
}

/**
 * Getting a doctor, as opposed to asking one a question.
 *
 * Two sentences, the real Ontario workflow, and no invented specifics: no clinic names
 * (Hale does not hold a verified directory, and a wrong name sends a family across the
 * city for nothing), no URLs (a mistyped link in a text is unrecoverable), no wait-time
 * estimates.
 *
 * It used to close with "and walk-in pediatric clinics take same-day visits", which was
 * exactly the availability claim the paragraph above forbids — unsourced, ungated on
 * anything, and false on the afternoon a parent drives to a full clinic on it. Dropped
 * (skill audit 2026-08-12). What is left is the two things Hale can actually stand
 * behind: the program's name and the number that registers you for it.
 *
 * REGIONAL ASSUMPTION, stated so it is reviewable: Health Care Connect is an Ontario
 * program. Hale's compliance baseline is Canada, and every family on the live gate is in
 * the GTA, so this line is correct for all of them today and wrong the day the first
 * family signs up outside Ontario. It is not gated on province because families have no
 * province field to gate on; adding one is the follow-up, not a silent guess here.
 */
const EYE_DIRECTORY = 'FindAnEyeDoctor.ca';

export const EYE_CARE_TOKENS = [
  'optometrist',
  'eye exam',
  'eye doctor',
  'eye test',
  'eyes checked',
  'eyes tested',
  'vision test',
] as const;

const EYE_CARE_PATTERN = new RegExp(`\\b(?:${EYE_CARE_TOKENS.join('|')})`, 'i');

/** Whether a provider-access ask is for eye care specifically — the branch between the
 * registry answer and the direct-access one. Deterministic, and no model sees it. */
export function asksAboutEyeCare(body: string): boolean {
  return EYE_CARE_PATTERN.test(body);
}

/**
 * The practitioners Health Care Connect actually places, and only those.
 *
 * The program matches an Ontario resident to a family doctor, a nurse practitioner or a
 * primary care team (ontario.ca "Find a family doctor or nurse practitioner"). A
 * paediatrician is included because that is how the registry's own intake describes a
 * child's primary care provider, and because it is the ask this line was written for.
 *
 * NOTHING ELSE GOES ON THIS LIST. Every addition is a promise that calling 811 gets a
 * parent that kind of practitioner, and the whole point of the table below is that the
 * promise is false for most of them.
 */
const PRIMARY_CARE_TOKENS = [
  'family doctor',
  'family physician',
  'gp',
  'general practitioner',
  'pediatrician',
  'paediatrician',
  'nurse practitioner',
  'family practice',
  'medecin de famille',
  'médecin de famille',
  'pediatre',
  'pédiatre',
  'infirmiere praticienne',
  'infirmière praticienne',
] as const;

const PRIMARY_CARE_PATTERN = new RegExp(`\\b(?:${PRIMARY_CARE_TOKENS.join('|')})`, 'i');

/** The fixed answer for one provider-access text: the verified path for a service Hale
 * has one for, and an honest "I don't know" for every service it does not. */
export function referralReply(
  body: string,
  language: ReplyLanguage | null,
): Promise<string | null> {
  const eye = asksAboutEyeCare(body);
  const primary = !eye && PRIMARY_CARE_PATTERN.test(body);
  const verbatim = eye ? [EYE_DIRECTORY] : primary ? ['811'] : [];
  return speak({
    purpose: 'provider_access',
    language,
    facts: { body },
    verbatim,
  });
}
