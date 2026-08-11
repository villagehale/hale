/**
 * VIL-273 — every word the off-domain lane can send, in one file.
 *
 * This is the SPEC, not a template layer. The whole point of the lane is that these
 * three answers are NOT composed: a model that could write them could also write a
 * fourth, and the fourth is the one that tells a parent what to do about their child's
 * head injury. So the lane's only decision is WHICH of these goes out, and the words
 * are a reviewable diff — the same split intake/copy.ts makes, taken further, because
 * here even the warm line is fixed.
 *
 * Founder policy (live-gate day 1): Hale is a chief of staff, never an event finder and
 * never a search box. Being asked the weather is not a failure to be apologised for —
 * it is a boundary, and the voice for a boundary is charm plus a pointer back at the
 * job, in one line, without a link and without an offer to try harder next time.
 *
 * GSM-7 (VIL-265): plain hyphens, straight apostrophes, no em dashes, no emoji. Every
 * string here is scanned by lib/channel/sms-copy-encoding.test.ts and the rendered
 * results are segment-counted below it.
 */

/** The one true thing the deflection may add, when the family has one. Nothing here is
 * ever model-produced: it is a COUNT of rows already in the approvals queue, which is
 * why it cannot be wrong and cannot disclose what the drafts are (rule #1). */
export interface PendingWork {
  pendingApprovals: number;
}

/**
 * The charm deflect, plus at most one true next-useful-thing.
 *
 * The append is a count and a place, never a description: an action's own label is
 * enough to name a teenager's drafted change, and this line has not earned the right to
 * print one. It also deliberately does NOT invite a reply of "yes" — no numbered list
 * was sent, so a bare yes here would be consent to something the parent never read
 * (rule #4).
 *
 * With nothing pending the deflect stands alone. Padding it with "let me know if you
 * need anything" would be the exact register the F14 voice rules forbid: a dead end
 * dressed up as help.
 */
export function offDomainReply(work: PendingWork): string {
  const deflect =
    "Ha - not my department. I stick to your family's week: dates, plans, the stuff that slips.";
  if (work.pendingApprovals <= 0) return deflect;
  const waiting =
    work.pendingApprovals === 1
      ? "One thing's waiting on your OK in the app."
      : `${work.pendingApprovals} things are waiting on your OK in the app.`;
  return `${deflect} ${waiting}`;
}

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
 * REGIONAL ASSUMPTION, stated so it is reviewable: Health Care Connect is an Ontario
 * program. Hale's compliance baseline is Canada, and every family on the live gate is in
 * the GTA, so this line is correct for all of them today and wrong the day the first
 * family signs up outside Ontario. It is not gated on province because families have no
 * province field to gate on; adding one is the follow-up, not a silent guess here.
 */
export const PROVIDER_ACCESS_REPLY =
  "Finding you a doctor isn't something I can do - but Health Care Connect is Ontario's list for a family doctor or pediatrician, and you register by calling 811. That same number answers health questions any time, and walk-in pediatric clinics take same-day visits.";
