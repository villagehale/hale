import { appBaseUrl } from '~/lib/cron/email-compliance';

/**
 * VIL-214 · A3 — the one line A3 owns. Everything else Hale says over SMS belongs to
 * M2's intake copy or M6's caregiver copy; A3 only has to answer the case those two
 * cannot see, a message with no readable text.
 */

/**
 * MMS, v1. Hale does not fetch Twilio media URLs — that would pull a family's photos
 * (often OF their children) into our infrastructure, which needs its own privacy review
 * and retention story before a single byte moves (rule #1). Until then the honest
 * answer is that we cannot read it, and where to put it instead.
 */
export function mediaUnsupportedReply(): string {
  return `I can't read attachments over text yet - send it in the app and I'll pick it up there: ${appBaseUrl()}`;
}
