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
