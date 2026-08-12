/**
 * VIL-214 · A3 — the one line A3 owns. Everything else Hale says over SMS belongs to
 * M2's intake copy or M6's caregiver copy; A3 only has to answer the case those two
 * cannot see, a message with no readable text.
 */

/**
 * MMS, v1. Hale does not fetch Twilio media URLs — that would pull a family's photos
 * (often OF their children) into our infrastructure, which needs its own privacy review
 * and retention story before a single byte moves (rule #1). Until then the honest
 * answer is that we cannot read it.
 *
 * And the ask stays in the thread. "Send it in the app" (skill audit P0 #4) made a
 * parent who photographed a permission form at the door go and re-upload it somewhere
 * else; typing the date and the name is the smaller job, and it is one Hale can act on
 * the moment it arrives.
 */
export function mediaUnsupportedReply(): string {
  return "I can't read attachments over text yet - type me the bit that matters and I'll take it from there.";
}
