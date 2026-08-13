/**
 * The follow-up ask — the two sentences Hale sends after something it set up actually
 * happened.
 *
 * FIXED TEXT, NO MODEL, for the same reason the intros copy is fixed: this is Hale
 * volunteering a question nobody asked for, and the whole value of it is that it reads
 * like a person remembering rather than a product surveying. A composed sentence would
 * need an eval to prove it never over-claims what Hale knows ("hope the swim went well!"
 * — Hale has no idea whether anyone went), while a fixed sentence needs only a test that
 * reads it.
 *
 * BOTH ASKS LIVE HERE, though one belongs to the intros lane and one to placements.
 * They are one class of message: one category, one daily rail, one sweep, and precedence
 * between them is a fact about the pair. Splitting the copy across two feature folders
 * would make that contract invisible from either half.
 *
 * The register is the intros copy module's — short, no exclamation, and an explicit exit
 * so a parent who does not want to answer is not left with an obligation.
 *
 * GSM-7 throughout (plain hyphens, straight apostrophes, no emoji), enforced by
 * lib/channel/sms-copy-encoding.test.ts, which reads this file off disk.
 */

/**
 * THE INTRO FOLLOW-UP — sent to each side, three days after the introduction email.
 *
 * "the other family" and not a name, because this text is a SECOND disclosure moment
 * even though it looks like small talk: Hale already handed both parents each other's
 * first name and email, and that was the disclosure both of them said yes to twice.
 * Repeating the name here would be Hale disclosing it again, unprompted, on its own
 * initiative — and to a household that may have decided in the meantime that it would
 * rather not be reminded.
 *
 * "No pressure either way" is doing real work. The honest answer is often "we did not",
 * and a question that only has a good answer is a question a parent skips.
 */
export const INTRO_FOLLOWUP_ASK =
  'Quick one - did you end up connecting with the other family? No pressure either way.';

/**
 * THE ACTIVITY FOLLOW-UP — sent the day after something Hale put on the calendar.
 *
 * `title` is the placement's own title, passed through VERBATIM, and it is safe to name
 * for two reasons that both have to hold. It is HALE-AUTHORED: only `source='placement'`
 * rows reach this copy, and those titles are minted by the calendar_add executor from an
 * artifact the parent approved, so there is no unbounded parent-typed string here and no
 * segment budget to defend. And it is NOT PRIVATE: the sweep drops any event
 * `isPrivateEvent` flags before composing, so a teen's item or anything health-flagged
 * never reaches this function at all (rule #1).
 *
 * One clause, no follow-on. The founder's words were "How was swim?", and every
 * addition tested against that made it worse: a "let me know" turns a question into a
 * task, and a "this helps me plan" is a promise about machinery the parent did not ask
 * about. A bare question is the version a person would actually text.
 */
export function activityFollowupAsk(title: string): string {
  return `How was ${title}?`;
}
