import { BUSINESS_ADDRESS, SENDER_NAME } from '~/lib/cron/email-compliance';
import { RESEND_DEFAULT_FROM } from '~/lib/channel/adapters/resend-email';
import { type ResendTransport, createResendTransport } from '~/lib/channel/resend-transport';
import { type EmailInboundConfig, emailInboundConfig } from './config';

/**
 * HALE ANSWERING AN EMAIL — the envelope around a reply the coach composed.
 *
 * The BODY is never this module's. C2 writes it, exactly as it writes a text; what lives
 * here is everything that is not words: who it is from, where a reply goes, which thread
 * it belongs to, and the two lines CASL wants under it. That split is the doctrine —
 * Hale composes, it does not recite — and the footer is the named exception, because a
 * mailing address is a legal instrument rather than a sentence.
 *
 * THREADING, and what it can and cannot promise. `In-Reply-To` and `References` carry
 * the Message-ID of the email being answered, which is what RFC 5322 clients (Apple
 * Mail, Outlook, Thunderbird) thread on — so the answer lands under the parent's own
 * message rather than beside it. Gmail additionally weighs the SUBJECT, and Hale does
 * not have the parent's: the webhook carries it, the ledger row does not, and putting a
 * parent's words through pg-boss to get them here would break the rule that their
 * message lives in exactly one place (rule #1, wiring.ts). So the subject is the
 * THREAD'S name rather than an echo of theirs — stable across every reply, which is what
 * keeps every turn after the first in one Gmail conversation. The cost is the first
 * answer to a brand-new subject: Gmail may show it as its own thread. That is a known,
 * bounded cosmetic gap, and the fix when it matters is a nullable `inbound_subject`
 * column, not a queue payload that carries what a parent wrote.
 *
 * REPLY-TO is derived from the inbound domain, never hard-coded and never the sending
 * identity: the address a parent's answer must reach is the one whose MX points at the
 * receiving webhook. Deriving it from the same config the webhook is gated on is what
 * makes the round trip impossible to half-provision — an environment that can receive
 * can be replied to, and one that cannot never advertises an address.
 */

/**
 * The name of the thread, and therefore the subject of every reply in it. Stable BY
 * DESIGN (see the module note): a subject that changed per message would scatter one
 * conversation across a parent's inbox.
 */
export const EMAIL_REPLY_SUBJECT = 'Your thread with Hale';

/**
 * The local part Hale receives on. Any local part at the inbound domain reaches the
 * webhook — it routes on the sender, never the recipient — so this is a legibility
 * choice, and the domain beside it is the provisioned fact.
 */
const REPLY_TO_LOCAL_PART = 'hale';

export function inboundReplyToAddress(config: EmailInboundConfig): string {
  return `${REPLY_TO_LOCAL_PART}@${config.inboundDomain}`;
}

/**
 * The footer, and the whole of what this module writes.
 *
 * A reply is a RESPONSE to a message the parent sent, which CASL treats differently from
 * the weekly plan: there is no stream to unsubscribe from and no consent being relied
 * on, so the loop templates' "You turned on X — Unsubscribe" line would be a link to
 * nowhere. What stays is the identification CASL asks of every message, plus the one
 * sentence that makes the stop path findable — the same word the webhook already honours
 * (inbound.ts), so it is a signpost to existing machinery rather than a second one.
 */
export function replyFooter(): string {
  return `Sent by ${SENDER_NAME} · ${BUSINESS_ADDRESS}\nReply STOP and Hale will stop emailing you.`;
}

/** A Message-ID in the form a header takes. Providers hand it back either way, and an
 * unbracketed value in `In-Reply-To` is silently ignored by the clients that matter. */
export function messageIdHeader(messageId: string): string | null {
  const trimmed = messageId.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed : `<${trimmed}>`;
}

export interface EmailReplyDeps {
  transport: ResendTransport;
  config: EmailInboundConfig;
  from: string;
}

/**
 * Send one composed reply. Throws on anything short of an accepted send, and that is the
 * contract the router depends on: it claims the turn ANSWERED the moment this returns, so
 * a send that quietly did nothing would put words in a parent's thread that no inbox ever
 * received. A null provider id is that case exactly — the shared transport degrades to a
 * no-op when it has no credentials — and it is refused by name rather than passed on.
 */
export async function sendEmailReply(
  deps: EmailReplyDeps,
  input: { to: string; body: string; inReplyTo: string | null },
): Promise<{ providerMessageId: string }> {
  const reference = input.inReplyTo ? messageIdHeader(input.inReplyTo) : null;
  const { id, error } = await deps.transport.send({
    from: deps.from,
    to: input.to,
    replyTo: inboundReplyToAddress(deps.config),
    subject: EMAIL_REPLY_SUBJECT,
    text: `${input.body}\n\n--\n${replyFooter()}\n`,
    headers: reference ? { 'In-Reply-To': reference, References: reference } : undefined,
  });
  if (error) {
    throw new Error(`email reply: provider refused the send (${error.name})`);
  }
  if (!id) {
    throw new Error('email reply: nothing was sent — the Resend transport has no credentials');
  }
  return { providerMessageId: id };
}

/**
 * The production sender, or null when the inbound leg is not provisioned.
 *
 * Null is not a degraded mode: with no inbound config there are no inbound emails, so
 * there is nothing to answer. It is returned rather than thrown so the wiring can name
 * the state once, at build time, instead of every turn discovering it (rule #11).
 */
export function productionEmailReply(): EmailReplyDeps | null {
  const config = emailInboundConfig();
  if (!config) return null;
  return {
    transport: createResendTransport({ apiKey: process.env.RESEND_API_KEY }),
    config,
    from: process.env.RESEND_FROM ?? RESEND_DEFAULT_FROM,
  };
}
