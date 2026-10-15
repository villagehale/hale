/**
 * VIL-273 — the off-domain lines that still go out without a model, in one file.
 *
 * Could-not-answer, child health, a parent's crisis, and a physical emergency are not
 * among them. Those replies are written by moment-reply.md, in the parent's language
 * (moment-reply.ts). Crisis and emergency stop the ordinary answer first; the model
 * then points to emergency or local help and does not recite a number.
 *
 * What survives here is the provider door (a table keyed by service) and the two
 * substring detectors that decide WHEN the ordinary answer stops. The detectors are
 * not the reply.
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

/**
 * The tokens that stop the ordinary answer for a physical emergency — the outage
 * smoke alarm's trigger (router/smoke-alarm.ts) and the lane's, before any search.
 *
 * THE BAR, and nothing else gets on this list: a token belongs only if stopping the
 * ordinary answer for someone who was NOT in an emergency is obviously acceptable,
 * and missing a real one is obviously not. "Fever", "rash" and "hit her head" all
 * fail it — a parent asking about a rash is owed a composed answer, not an emergency
 * stop. The six below pass it: there is no ordinary Tuesday sentence they turn up in.
 *
 * No fuzzy matching, no scoring, no model. The alarm exists for the minutes when the
 * model is unreachable, so anything cleverer than a substring would be a dependency on
 * the thing that just failed. While the model is up, the same tokens stop the ordinary
 * answer and a model writes the reply (moment-reply.ts). While it is down, nothing
 * preset goes out: the outcome is named and the turn waits.
 *
 * WHAT IT DOES NOT CATCH, stated so nobody mistakes it for triage: the list is literal.
 * "isn't breathing" and "stopped breathing" both miss where "not breathing" hits, and a
 * parent who describes an emergency in any other words misses entirely. This is a smoke
 * alarm, not a screen — the screened safety lane (lane.ts) is what covers the phrasing
 * space, and it is available every minute the model is.
 */
export const EMERGENCY_TOKENS = [
  'not breathing',
  'unconscious',
  'unresponsive',
  'choking',
  'seizure',
  '911',
] as const;

/**
 * One rule for all six: a token must begin at a word edge, and must not run into a digit.
 *
 * The leading `(?<![\w$])` is what keeps "preseizure" and "$911" out — a token buried in
 * a longer word is not that word, and a dollar sign in front of three digits is a price.
 * The trailing `(?!\d)` is deliberately looser than a word boundary: `\b` would refuse
 * "seizures", and losing a real emergency to a plural is precisely the miss the bar
 * above forbids. It still refuses "9110" and "0911", which are the cases that matter.
 */
const EMERGENCY_PATTERN = new RegExp(`(?<![\\w$])(?:${EMERGENCY_TOKENS.join('|')})(?!\\d)`, 'i');

/** Whether an inbound text names an emergency unambiguously enough to stop the ordinary
 * answer. Calibrated toward the false positive on purpose — see the bar above. */
export function namesAnEmergency(body: string): boolean {
  return EMERGENCY_PATTERN.test(body);
}

/**
 * VIL-327 — caregiver mental crisis. Stops the ordinary answer. A therapist-find or
 * cheer-up must not match.
 */
const MENTAL_CRISIS_PATTERN =
  /\b(?:suicide|suicidal|kill(?:ing)? myself|end my life|self[-\s]?harm|want to die|wanna die|not want to be alive)\b|(?<![\w$])988(?!\d)/i;

export function namesAMentalCrisis(body: string): boolean {
  return MENTAL_CRISIS_PATTERN.test(body);
}

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
export const PROVIDER_ACCESS_REPLY =
  "Finding you a doctor isn't something I can do - but Health Care Connect is Ontario's list for a family doctor or pediatrician, and you register by calling 811. That same number answers health questions any time.";

/**
 * The registry answer in French. Same two sentences, same refusals — no clinic names, no
 * URL, no wait-time estimate — and the same Ontario-only assumption stated above.
 *
 * FOUNDER REVIEW, on the proper noun: "Accès Soins" is the French name of the Health Care
 * Connect program. Like "Santé811" above it was written from the same source as the
 * English line and not re-fetched here. It matters more than the other one, because this
 * is the name a parent has to say on the phone — a wrong program name is a wasted call,
 * which is exactly the discouragement this line exists to prevent.
 *
 * `Ce numéro répond aussi` rather than `Ce même numéro`: GSM-7 has no ê, and "aussi"
 * carries the "that same number" sense without it.
 */
export const PROVIDER_ACCESS_REPLY_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: PROVIDER_ACCESS_REPLY,
  fr: "Trouver un médecin pour vous, je ne peux pas - mais Accès Soins est la liste de l'Ontario pour un médecin de famille ou un pédiatre, et on s'y inscrit en composant le 811. Ce numéro répond aussi aux questions de santé à toute heure.",
};

/**
 * The DIRECT-ACCESS answer, for the provider classes an Ontario parent does not need a
 * registry or a referral to reach. v1 is eye care, and it exists because the line above
 * was sent to a founder who asked for an optometrist and was WRONG — not vague, wrong.
 *
 * Health Care Connect matches people to a family doctor, a nurse practitioner or a
 * primary care team, and nothing else; it does not find, register for or book
 * optometrists (ontario.ca "Find a family doctor or nurse practitioner", updated
 * 2026-08-09). 811 is the health-advice and navigation line, not a booking channel. So
 * the old reply sent a parent to a registry that would never have called them back,
 * about a service that needs no registry at all — a factual error, and the most
 * discouraging possible one, because the true answer is that this is EASY.
 *
 * WHY THIS ONE IS EMPOWERING RATHER THAN A DEFLECTION. Every clause is a barrier being
 * removed: it is free, it is annual, it needs no referral, and here is the list.
 *
 * VERIFIED CONTENT, claim by claim (researched and re-checked against primary sources
 * 2026-08-13). Do not paraphrase these — the wording is what was checked:
 *
 *   "book an optometrist directly - no referral needed" — optometrists in Ontario are
 *   direct-access primary eye care providers; OHIP billing for the under-20 exam
 *   validates on the health card alone (OHIP bulletin 240506; College of Optometrists of
 *   Ontario + OAO public booking paths). NOTE the one composite citation in this line:
 *   no ontario.ca page states "no referral" verbatim. It is established from the
 *   direct-access structure rather than one government sentence, and it is safe to say.
 *
 *   "a full eye exam every 12 months for anyone 19 and under" — OHIP covers "1 major eye
 *   exam (for vision and general eye health) every 12 months" plus medically necessary
 *   minor assessments, for ages 19 and under (ontario.ca "What OHIP covers", updated
 *   2026-04-22). The 12-MONTH wording is deliberate: some secondary sources say "per
 *   calendar year", which is a different and wrong promise.
 *
 *   "free with your child's health card" — the health card is the only thing a parent
 *   needs; no cost and no paperwork (same source).
 *
 *   "The Ontario Association of Optometrists lists them at FindAnEyeDoctor.ca" — the
 *   OAO's public directory, searchable by address or postal code (also reachable at
 *   find.optom.on.ca).
 *
 * WHAT IT DELIBERATELY LEAVES OUT. No fee amounts (the $51 child exam fee rides on an
 * OAO-Ministry agreement that expired 31 Mar 2025 with no announced successor, so a
 * number here would go stale silently). No Eye See...Eye Learn (real, and a genuinely
 * good deal for kindergarten, but its eligibility wording changes every program year).
 * No clinic names. Nothing about whether the child NEEDS an exam — that question has two
 * legitimate answers depending on age and risk, and this lane is BLIND to both: it sees
 * the message text and never the family, so an age-conditioned answer cannot be written
 * here. It belongs to the coach.
 *
 * THE ONE LINK, and why this file's no-URL rule bends exactly here. PROVIDER_ACCESS_REPLY
 * carries none because Health Care Connect is reached by a phone number, so a URL would
 * buy nothing against the risk of a mistyped link. Here the directory IS the answer, and
 * naming a tool without its address is the shape of help a parent cannot act on. The
 * precedent is WATCH_OFFER, which carries the privacy link at the consent moment for the
 * same reason: an authoritative third-party address, at a decision point, one per
 * message, no scheme (shorter, and every phone links a bare domain anyway).
 *
 * ONTARIO-ONLY, like the line above it and for the same reason — see its regional note.
 * OHIP is what makes the exam free; the direct-access structure is provincial too.
 */
export const DIRECT_ACCESS_EYE_REPLY =
  "You can book an optometrist directly - no referral needed. OHIP covers a full eye exam every 12 months for anyone 19 and under, so it's free with your child's health card. The Ontario Association of Optometrists lists them at FindAnEyeDoctor.ca.";

/**
 * The eye-care asks that get {@link DIRECT_ACCESS_EYE_REPLY} instead of the registry
 * line. Same shape as {@link EMERGENCY_TOKENS}, and it needs the same kind of bar.
 *
 * THE BAR: a token belongs only if a parent typing it is asking about the routine eye
 * care an optometrist provides on direct booking. That is what makes "free, annual, no
 * referral, here is the directory" the right four facts for every message it matches.
 *
 * "ophthalmologist" FAILS the bar and is deliberately absent. An ophthalmologist is a
 * physician specialist and IS the referral case, so telling that parent no referral is
 * needed would be the same class of error this constant exists to fix. "optician" is
 * absent too: opticians dispense glasses and do not examine eyes.
 *
 * A false positive here is cheap — a parent asking about eyes for a reason we did not
 * anticipate gets four true sentences about Ontario eye care. A false negative sends
 * them to Health Care Connect, which is the bug. Calibrated accordingly.
 *
 * Nothing here can reach a parent describing a HURT eye: the lane resolves
 * `safety_critical` before it ever asks this question (see the resolution order in
 * inbound-lane.md), so "she poked her eye and it's swollen" leaves by the 811 door.
 */
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

/**
 * What a parent hears when they ask Hale to place them with a practitioner it has NO
 * verified access path for — a paediatric dentist, an OT, a speech-language pathologist,
 * an audiologist, a physio, a child psychologist.
 *
 * THIS LINE IS THE POINT OF THE TABLE. Until it existed the provider door had two
 * branches and its DEFAULT was the registry, so every one of those asks was answered
 * with Health Care Connect — a program that has never placed any of them. That is not a
 * vague answer, it is a wrong one, and it is the most discouraging kind: the parent makes
 * a call that was never going to work and concludes the system has nothing for them.
 * The eye branch fixed one ask and left the shape (founder, live gate, 2026-08-13).
 *
 * SO IT SAYS IT DOES NOT KNOW. Honest ignorance is a correct answer and a guessed
 * registry is not, and the difference is a real phone call a parent does not waste.
 *
 * AND IT NAMES THE ADJACENT CAN, which is the capability table's rule for every refusal:
 * once they have a date, Hale puts it on the week and reminds them. That is true, it is
 * this thread's own next turn, and it is not a place a parent has to go — no app, no
 * page, no directory Hale has not verified.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It names no registry, no directory and no clinic; it
 * does not say "ask your family doctor for a referral", because whether a referral is
 * even needed depends on the class (an optometrist needs none, an ophthalmologist does)
 * and this line is the branch that fires when Hale does not know the class. It does not
 * name 811 either: this is not a health question, and the number that answers health
 * questions is not the number that books a speech therapist.
 */
export const UNPLACEABLE_PROVIDER_REPLY =
  "I don't have a verified way to get you that one, and I'd rather say so than send you somewhere that can't help. Once you've got an appointment, tell me and I'll put it on your week.";

/** The same refusal in French, with the same two halves: the honest no, then the can. */
export const UNPLACEABLE_PROVIDER_REPLY_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: UNPLACEABLE_PROVIDER_REPLY,
  fr: "Je n'ai pas de piste vérifiée pour celui-là, et je préfère le dire que vous envoyer au mauvais endroit. Dès que vous avez un rendez-vous, dites-le moi et je l'ajoute à votre semaine.",
};

/**
 * THE REFERRAL TABLE — which fixed answer a `provider_access` text gets, by SERVICE.
 *
 * Ordered, first match wins, and the order is load-bearing: "eye doctor" contains
 * "doctor", so eye care is asked first. A MISS is a real outcome and lands on
 * {@link UNPLACEABLE_PROVIDER_REPLY} — there is no default branch that answers an
 * unrecognised ask with somebody else's registry, which is the whole defect this
 * replaced.
 *
 * Deterministic, and no model is consulted, for the reason the door itself is
 * deterministic: this is what a parent is told about getting care for their child, and a
 * cheap model choosing between three reviewed sentences buys nothing.
 */
const REFERRAL_TABLE: ReadonlyArray<{
  service: 'eye-care' | 'primary-care';
  matches(body: string): boolean;
  reply(language: ReplyLanguage): string;
}> = [
  {
    service: 'eye-care',
    matches: asksAboutEyeCare,
    // DIRECT_ACCESS_EYE_REPLY has no French twin yet and its token list is English, so a
    // French eye question does not match here and leaves by the registry or the
    // unplaceable line in French rather than by this one in English.
    reply: () => DIRECT_ACCESS_EYE_REPLY,
  },
  {
    service: 'primary-care',
    matches: (body) => PRIMARY_CARE_PATTERN.test(body),
    reply: (language) => PROVIDER_ACCESS_REPLY_BY_LANGUAGE[language],
  },
];

/** The fixed answer for one provider-access text: the verified path for a service Hale
 * has one for, and an honest "I don't know" for every service it does not. */
export function referralReply(body: string, language: ReplyLanguage): string {
  const row = REFERRAL_TABLE.find((entry) => entry.matches(body));
  return row ? row.reply(language) : UNPLACEABLE_PROVIDER_REPLY_BY_LANGUAGE[language];
}
