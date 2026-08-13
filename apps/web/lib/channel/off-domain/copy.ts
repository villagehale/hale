/**
 * VIL-273 — every word the off-domain lane can send WITHOUT a model, in one file.
 *
 * This is the SPEC, not a template layer. The two door lines below are NOT composed: a
 * model that could write them could also write a third, and the third is the one that
 * tells a parent what to do about their child's head injury. So for those two the
 * lane's only decision is WHICH goes out, and the words are a reviewable diff.
 *
 * BOUNDARY V3 (founder-locked 2026-08-11) narrowed what belongs here. Hale is never a
 * SEARCH BOX — it does not run errands against the internet on demand. It is not,
 * however, a closed door: asked something a friend would just answer, it answers, once,
 * briefly, and stops (see answer.ts). The charm deflect that used to live here and go
 * out for weather, trivia, recipes and homework is retired; what survives is the line
 * for the one case where the answer could not be WRITTEN, and it now says that rather
 * than claiming a boundary Hale does not have.
 *
 * NOTHING HERE POINTS AT THE APP. Not as a fallback, not for an overflow. A parent who
 * texted is owed a text back, and "finish this in the app" is the shape of dead end the
 * F14 voice rules and the v3 doctrine both refuse.
 *
 * GSM-7 (VIL-265): plain hyphens, straight apostrophes, no em dashes, no emoji. Every
 * string here is scanned by lib/channel/sms-copy-encoding.test.ts and the rendered
 * results are segment-counted below it.
 */

/**
 * What a parent hears when the general answer could not be composed — a missing key, a
 * provider outage, or a body that came back unsendable (see GeneralAnswerFallback).
 *
 * It says the true thing. Under v3 "not my department" would be a claim about Hale's
 * boundaries that is no longer true, and a parent who got a real answer to this exact
 * question yesterday would be told a different policy today; an honest "I could not get
 * to it" survives both. It offers the one action that might work, so it is not a dead
 * end, and it names no queue, no count and no app.
 *
 * FOUNDER REVIEW (tone audit, 2026-08-13). This line predates the 2026-08-12 no-preset
 * doctrine and is the one surviving twin of the failure constant the apology arc retired
 * (router/apology.ts) — its triggers are the same DEFECT class (a skill that would not
 * load, a body the gates refused, a single failed call), and "Try me again in a minute"
 * is a shape apology.ts's own promised_a_time gate would refuse. NOT converted tonight
 * because the honest conversion is compose-or-DEFER, and gate 4 (route.ts) has no defer:
 * the deferral machinery — recordDeferred plus the TurnDeferred throw the re-drive reads
 * — lives inside runAgentTurn's catch, which the off-domain screen returns before. That
 * is a build, not a seam reuse. Options for the founder: (a) lift the defer out of
 * runAgentTurn so any gate can use it, then compose here; (b) declare this line an
 * allowed class; (c) leave the defect path answering with the composed apology and no
 * defer underneath it.
 */
export const ANSWER_UNAVAILABLE_REPLY =
  "Sorry - I couldn't get to that one just now. Try me again in a minute.";

/**
 * The safety answer. Fixed, never composed, never conditioned on anything in the
 * message.
 *
 * It names the two numbers and stops. It does not ask a follow-up question, because a
 * parent standing over a hurt child should be dialling rather than texting; it does not
 * say "it's probably fine" or "that sounds normal", because Hale cannot see the child
 * and a reassurance is a clinical judgement; and it does not point at the app, because
 * the app has nothing for them either.
 *
 * Health811 is the Ontario service behind 811. 911 is named for the emergency case so
 * that the one message covers both without asking the parent to self-triage first.
 */
export const SAFETY_REPLY =
  "That's not something I should advise on. Health811 (call 811) can help any time - and if it's an emergency, call 911.";

/**
 * The tokens that make {@link SAFETY_REPLY} go out with no model in the loop at all —
 * the outage smoke alarm's trigger (router/smoke-alarm.ts, founder-approved
 * 2026-08-12), and the ONE place Hale answers a parent without composing anything.
 *
 * THE BAR, and nothing else gets on this list: a token belongs only if sending the
 * safety line to someone who was NOT in an emergency is obviously acceptable, and
 * missing a real one is obviously not. "Fever", "rash" and "hit her head" all fail it —
 * a parent asking about a rash during an outage is owed a composed answer once the
 * model is back, not two phone numbers now. The six below pass it: there is no ordinary
 * Tuesday sentence they turn up in.
 *
 * No fuzzy matching, no scoring, no model. The alarm exists for the minutes when the
 * model is unreachable, so anything cleverer than a substring would be a dependency on
 * the thing that just failed.
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
const EMERGENCY_PATTERN = new RegExp(
  `(?<![\\w$])(?:${EMERGENCY_TOKENS.join('|')})(?!\\d)`,
  'i',
);

/** Whether an inbound text names an emergency unambiguously enough to answer without a
 * model. Calibrated toward the false positive on purpose — see the bar above. */
export function namesAnEmergency(body: string): boolean {
  return EMERGENCY_PATTERN.test(body);
}

/**
 * The tripwire that makes {@link SAFETY_REPLY} the ONLY siren Hale sends (skill audit
 * P0 #3).
 *
 * The lane screen fails open by design (screen.ts openTheGate), so a missing key, a
 * skill-load failure or a provider outage puts "she hit her head and won't stop crying"
 * in front of a model instead of in front of the line above — and both composing skills
 * answer that by writing a siren of their own, one of which names a doctor and no number
 * at all. The fix cannot be a better instruction: the paths that reach a model are
 * exactly the paths where the deterministic layer already failed.
 *
 * So the numbers themselves are the signal. Hale's own vocabulary contains 811 and 911
 * in two fixed lines and nowhere else, and neither passes through a composer — a
 * MODEL-WRITTEN body carrying either is a model reaching for the health line, and the
 * reviewed sentence is strictly better than whatever it reached for. Callers substitute
 * rather than refuse: a parent describing a hurt child must never be answered with "try
 * me again in a minute".
 *
 * Whole tokens only, so an ordinary week does not trip it — `9:11` is a swim time and
 * `647-555-0811` is a phone number, and neither contains the token. Calibrated toward
 * the false positive on purpose: sending the fixed line about a $911 fee is a bad
 * message, and missing a real one is the failure this file exists to prevent.
 *
 * What it does NOT catch, stated so nobody reads it as more than it is: an improvised
 * referral that names no number ("that one's for your doctor") is invisible here. The
 * skills' own siren prose and a coach-eval fixture that gates on both numbers are what
 * close that half; this closes the half a prompt cannot.
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
