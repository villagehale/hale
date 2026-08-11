import { parseEmailAddress } from './address';

/**
 * Is this machine mail? The guard that keeps Hale out of a mail loop.
 *
 * Hale ANSWERS inbound email automatically. So does an out-of-office responder. Put the
 * two in a room together and they will talk to each other until someone notices the
 * bill: Hale replies, the responder replies to the reply, Hale replies again. The same
 * shape covers a bounce (Hale "answers" a delivery failure, generating another one) and
 * Hale's own address somehow reaching its own inbox through a forwarding
 * misconfiguration.
 *
 * SMS has no equivalent of this, which is exactly why it is easy to omit — there is no
 * such thing as an out-of-office text. It is the most common way a first email leg
 * fails in production, and the failure is expensive rather than merely wrong.
 *
 * Everything here is a POSITIVE marker the sender's own infrastructure set, matched on
 * whole values rather than substrings: the cost of a false positive is a real parent
 * being ignored, so "a subject line that happens to contain the word bulk" must not
 * trip it.
 */

export type AutomationKind =
  /** RFC 3834 / vendor out-of-office markers. */
  | 'auto_submitted'
  /** Bulk, list or junk precedence — mail nobody is waiting for a reply to. */
  | 'bulk'
  /** A delivery failure report. */
  | 'bounce'
  /** Our own machine domain. A loop by definition. */
  | 'self';

/** Bounce senders defined by convention (RFC 5321 §4.5.5 and long practice). */
const BOUNCE_LOCAL_PARTS: ReadonlySet<string> = new Set(['mailer-daemon', 'postmaster']);

const AUTO_SUBMITTED_MARKERS: ReadonlySet<string> = new Set(['auto-replied', 'auto-generated']);
const BULK_PRECEDENCE: ReadonlySet<string> = new Set(['bulk', 'list', 'junk', 'auto_reply']);

function header(headers: Readonly<Record<string, string>>, name: string): string {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return (found?.[1] ?? '').trim().toLowerCase();
}

/**
 * Why this message must not be answered, or null when it is ordinary mail from a person.
 *
 * `inboundDomain` is our own machine domain, from config — never inferred from the
 * message, or a sender could opt out of the self-check by claiming a different one.
 */
export function automationKind(
  message: { from: string; headers?: Readonly<Record<string, string>> },
  inboundDomain: string,
): AutomationKind | null {
  const headers = message.headers ?? {};

  // `Auto-Submitted: no` is the RFC's way of saying "a human sent this", so only the
  // affirmative markers count.
  if (AUTO_SUBMITTED_MARKERS.has(header(headers, 'auto-submitted'))) return 'auto_submitted';
  if (header(headers, 'x-autoreply') || header(headers, 'x-autorespond')) return 'auto_submitted';
  if (BULK_PRECEDENCE.has(header(headers, 'precedence'))) return 'bulk';

  // The empty return path SMTP requires on a bounce, so a failure report cannot itself
  // bounce. There is nothing to answer.
  if (header(headers, 'return-path') === '<>') return 'bounce';

  const sender = parseEmailAddress(message.from);
  if (!sender) return null;

  const localPart = sender.address.slice(0, sender.address.lastIndexOf('@'));
  if (BOUNCE_LOCAL_PARTS.has(localPart)) return 'bounce';

  const ours = inboundDomain.toLowerCase();
  if (sender.domain === ours || sender.domain.endsWith(`.${ours}`)) return 'self';

  return null;
}
