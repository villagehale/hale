import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { emailBlindIndex } from '~/lib/crypto/blind-index';
import { RATE_LIMITS } from '~/lib/rate-limit/config';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import { parseEmailAddress } from './address';
import { automationKind } from './automated';
import { type EmailInboundConfig, emailInboundConfig } from './config';
import type { InboundContentReader } from './content';
import { resolveEmailSender } from './identity';
import { type InboundEmailEvent, parseInboundEmailEvent } from './payload';
import { extractReply } from './reply-extract';
import { isValidResendSignature } from './signature';
import { assessSenderTrust } from './trust';

/**
 * The inbound-email webhook: the OTHER door a parent can reach Hale through, and the
 * sibling of twilio/inbound.ts. It answers the same questions in the same order, for the
 * same reasons — the differences below are the ones email genuinely forces, and each one
 * is named rather than absorbed.
 *
 * The order, and why it cannot be rearranged:
 *
 *   1. CONFIG, then SIGNATURE. Both before anything is parsed, fetched or written. A
 *      forged request must cost us nothing — and here that matters more than it does on
 *      the SMS side, because reading an email requires a SECOND provider call (the
 *      webhook carries no body), and an unauthenticated endpoint that makes provider
 *      calls is an amplifier pointed at our own API quota.
 *   2. THE SENDER'S ADDRESS. Unparseable is undeliverable: there is nobody to answer.
 *   3. RATE LIMIT, keyed by the blind index of the address, before any spend.
 *   4. DUPLICATE. Providers retry; a retry must not re-fetch, re-file, or re-answer.
 *   5. FETCH the body and headers — the first thing that costs anything.
 *   6. MACHINE MAIL. An out-of-office, a bounce, or our own address: answered by nobody,
 *      because answering is how a mail loop starts (automated.ts). Email's own hazard;
 *      SMS has no equivalent, which is exactly why it is easy to leave out.
 *   7. TRUST. The `From` header is a claim until DKIM says otherwise, and on this leg
 *      `From` IS the identity — so the trust verdict gates identity resolution rather
 *      than sitting beside it. An untrusted message can never BE somebody (trust.ts).
 *   8. IDENTITY, then ROLE. Same positive parent list as A3, for the same reason: a role
 *      we cannot vouch for is silence, not disclosure.
 *   9. THE NEW TURN ONLY. Quoted history is stripped before anything reads the body, or
 *      Hale would re-read its own last message as though the parent had just said it.
 *  10. CASL KEYWORDS, and specifically BEFORE the attachment branch — a parent who
 *      unsubscribes with a photo attached has still unsubscribed, and answering that
 *      with "I can't read attachments" would be a compliance failure dressed up as a
 *      friendly reply. This is A3's rule, kept identical.
 *
 * WHAT THIS LEG DOES NOT DO YET, deliberately and visibly (rule #11). It records the
 * message and stops: it does not hand off to C1, and it sends nothing. The router C1
 * owns resolves a reply address with `resolveSendablePhone` and sends through the Twilio
 * transport — hand it an email today and a parent who wrote to Hale would be answered by
 * TEXT, or dropped as `unreachable` if they have no number. Neither is acceptable, and
 * generalizing the router's reply channel is a change to the live SMS path rather than an
 * addition to a dark one. So `recorded` is the honest terminal outcome for this phase,
 * and it is logged and counted as such rather than looking like a delivery.
 *
 * PRIVACY (rule #1). No branch logs a body, a subject, or an address. Outcomes are an
 * enum and ids; that is everything an operator needs to count and nothing a log
 * aggregator should hold.
 */

const INBOUND_ROUTE = 'email-inbound';

/** The roles a household agent may speak to. A POSITIVE list, mirroring A3's: the legacy
 * `extended`/`service` buckets hold an empty content scope precisely so they fail
 * closed, and a negative check would route them. */
const PARENT_ROLES: readonly string[] = ['primary_parent', 'co_parent'];

export interface EmailInboundDeps {
  database: Database;
  /**
   * Reads the body and headers the webhook does not carry. Built LAZILY by the route so
   * a forged request never constructs a provider client — the same reason A3 defers its
   * intake deps. Required, never nullable (rule #11): a leg that cannot read email has
   * no degraded mode worth having.
   */
  content: () => InboundContentReader;
  limiter: RateLimiter;
  now?: () => Date;
  log?: Pick<Console, 'info' | 'error'>;
}

export type EmailInboundOutcome =
  /** Authentic, but not an inbound message we serve (another event type, or garbage). */
  | 'ignored_event'
  /** No routable sender address — nobody to attribute this to or answer. */
  | 'invalid_sender'
  | 'rate_limited'
  /** Already recorded under this Message-ID — a retry, not a second email. */
  | 'duplicate'
  /** The body could not be fetched. Named, never treated as an empty message. */
  | 'content_unavailable'
  /** An auto-reply, a bounce, or our own address. Nothing is answered (loop guard). */
  | 'automated'
  /** The sender could not be authenticated, so it may not become an identity. */
  | 'untrusted'
  /** Authenticated, but no account — a cold stranger. The intake path is phase 2. */
  | 'unknown_sender'
  /** A verified household member who is not a parent — never handed to an agent. */
  | 'not_a_parent'
  /** A CASL unsubscribe, honoured. */
  | 'unsubscribed'
  /** Nothing but quoted history and a signature once stripped — no turn to act on. */
  | 'empty_after_extraction'
  /** Filed in the family's ledger. The routing hand-off is phase 2 (see module note). */
  | 'recorded';

/** Everything one authenticated inbound is judged on, resolved once. */
interface Judged {
  event: InboundEmailEvent;
  address: string;
  body: string;
}

/**
 * Route one authenticated inbound email. Exported so every routing decision is testable
 * without building an HTTP request; the request shell is
 * {@link handleEmailInboundRequest}.
 */
export async function routeEmailInbound(
  deps: EmailInboundDeps,
  config: EmailInboundConfig,
  event: InboundEmailEvent,
): Promise<EmailInboundOutcome> {
  const sender = parseEmailAddress(event.from);
  if (!sender) return 'invalid_sender';

  const decision = await deps.limiter.check(
    emailBlindIndex(sender.address),
    INBOUND_ROUTE,
    RATE_LIMITS[INBOUND_ROUTE],
  );
  if (!decision.allowed) return 'rate_limited';

  // Before the fetch: a provider retry must not cost a second round-trip, and must never
  // produce a second ledger row. The Message-ID is the sender's own idempotency key.
  if (await alreadyRecorded(deps.database, event.messageId)) return 'duplicate';

  const fetched = await deps.content().fetch(event.emailId);
  if (fetched.status === 'failed') {
    deps.log?.error('inbound email: content unavailable', {
      emailId: event.emailId,
      reason: fetched.reason,
    });
    return 'content_unavailable';
  }
  const { headers, text } = fetched.content;

  if (automationKind({ from: event.from, headers }, config.inboundDomain)) {
    return 'automated';
  }

  const trust = assessSenderTrust({
    headers,
    authservId: config.authservId,
    fromDomain: sender.domain,
  });
  if (!trust.trusted) {
    deps.log?.info('inbound email: sender not trusted', { reason: trust.reason });
    return 'untrusted';
  }

  const owner = await resolveEmailSender(deps.database, sender.address);
  if (!owner) return 'unknown_sender';
  if (!PARENT_ROLES.includes(owner.role)) return 'not_a_parent';

  // The new turn only. `text` may be absent on an HTML-only message; that is not an
  // error, it is a message with no plain part, and it reads as an empty turn rather than
  // being answered with stripped markup.
  const body = extractReply(text ?? '').text;

  // CASL before the attachment branch — see the module note.
  if (matchKeyword(body) === 'stop') {
    return unsubscribe(deps, { ...owner, event });
  }

  if (!body) return 'empty_after_extraction';

  await record(deps, { owner, judged: { event, address: sender.address, body } });
  return 'recorded';
}

/**
 * Has this exact Message-ID already been filed? The index A2 left on
 * `provider_message_id` is what makes this cheap enough to run before the fetch.
 *
 * The id is re-checked over the returned rows rather than trusted to the `where` alone —
 * the same defense in depth `resolveVerifiedChannelByPhone` documents. A dedupe that
 * matched the wrong row would silently swallow a real message.
 */
async function alreadyRecorded(database: Database, messageId: string): Promise<boolean> {
  const seen = await database
    .select({
      id: schema.channelMessages.id,
      providerMessageId: schema.channelMessages.providerMessageId,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.providerMessageId, messageId))
    .limit(1);
  return seen.some((row) => row.providerMessageId === messageId);
}

/**
 * A CASL unsubscribe arriving by email.
 *
 * It writes to `email_opt_outs`, the store the app ALREADY treats as the live answer to
 * "may we email this person" — the absence of a row is the consent. Minting a second
 * store for the same question would create two readers that can disagree, and the wrong
 * one would email a parent who asked us to stop.
 *
 * It opts the sender out of EVERY stream, which is what the word means when a person
 * types it: a parent who writes "unsubscribe" has not asked to be removed from one
 * category and kept on five others. That is the same scope a texted STOP has, which
 * revokes the channel outright rather than one message class.
 *
 * Nothing is sent back. SMS answers a STOP because carriers require one final
 * confirmation; email has no such rule, and emailing someone who just asked not to be
 * emailed is the thing they asked us not to do.
 */
async function unsubscribe(
  deps: EmailInboundDeps,
  args: { userId: string; familyId: string; event: InboundEmailEvent },
): Promise<EmailInboundOutcome> {
  const now = deps.now?.() ?? new Date();
  await deps.database.transaction(async (tx) => {
    for (const emailType of UNSUBSCRIBABLE_STREAMS) {
      await tx
        .insert(schema.emailOptOuts)
        .values({ userId: args.userId, emailType, optedOutAt: now })
        .onConflictDoNothing({
          target: [schema.emailOptOuts.userId, schema.emailOptOuts.emailType],
        });
    }
    await tx.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.userId,
      actionTaken: 'email_unsubscribe_received',
      targetTable: 'email_opt_outs',
      targetId: args.userId,
      after: { streams: [...UNSUBSCRIBABLE_STREAMS], via: 'inbound_email' },
    });
  });
  return 'unsubscribed';
}

/** Every stream a typed "unsubscribe" covers. Listed explicitly rather than derived, so
 * adding a stream is a decision about whether an unsubscribe should reach it. */
const UNSUBSCRIBABLE_STREAMS = [
  'daily_digest',
  'weekly_plan',
  'reminder',
  'approval',
  'alert',
] as const;

/**
 * File the message in the family's ledger, with its audit row (rule #6).
 *
 * The body stored is the EXTRACTED turn, not the raw email. Quoted history is a copy of
 * messages already in this ledger, and a signature block is contact data nobody asked us
 * to keep — storing either would mean holding more of a family's data than the exchange
 * needs (rule #1). Inbound bodies ARE stored, as on the SMS side: this is the parent's
 * own instruction, and the approvals path treats it as the legal instrument of a
 * decision.
 */
async function record(
  deps: EmailInboundDeps,
  args: { owner: { userId: string; familyId: string }; judged: Judged },
): Promise<void> {
  const { owner, judged } = args;
  const [row] = await deps.database
    .insert(schema.channelMessages)
    .values({
      familyId: owner.familyId,
      parentUserId: owner.userId,
      channel: 'email',
      direction: 'in',
      category: 'reply',
      providerMessageId: judged.event.messageId,
      status: 'delivered',
      body: judged.body,
      sentAt: judged.event.receivedAt,
    })
    .returning({ id: schema.channelMessages.id });
  const channelMessageId = row?.id;
  if (!channelMessageId) {
    throw new Error('email inbound: channel_messages insert returned no row');
  }

  await deps.database.insert(schema.auditLog).values({
    familyId: owner.familyId,
    actor: owner.userId,
    actionTaken: 'email_reply_received',
    targetTable: 'channel_messages',
    targetId: channelMessageId,
  });

  // Named rather than silent (rule #11): the message is filed and NOTHING will answer it
  // until the router speaks email. An operator reading this line knows the difference
  // between "we replied" and "we have it".
  deps.log?.info('inbound email recorded; no reply — router is sms-only (phase 2)', {
    familyId: owner.familyId,
    channelMessageId,
  });
}

/**
 * `POST /api/channels/email/inbound`.
 *
 * Two refusals, in this order and before anything else happens:
 *   503 — the leg is not provisioned. Nothing is parsed, nothing is fetched, nothing is
 *         written. Dark by construction rather than by a flag.
 *   403 — the signature does not verify. Same: zero side effects.
 * Everything authentic answers 200 whatever the outcome, because a 4xx/5xx would make
 * the provider retry a message we have already handled.
 */
export async function handleEmailInboundRequest(
  req: Request,
  deps: EmailInboundDeps,
): Promise<Response> {
  const config = emailInboundConfig();
  if (!config) {
    return Response.json({ error: 'email_inbound_not_configured' }, { status: 503 });
  }

  // The RAW body: the digest covers the bytes as sent, so it must be read as text and
  // parsed only after the signature verifies.
  const rawBody = await req.text();
  const valid = isValidResendSignature({
    secret: config.webhookSecret,
    id: req.headers.get('svix-id'),
    timestamp: req.headers.get('svix-timestamp'),
    signature: req.headers.get('svix-signature'),
    payload: rawBody,
    now: deps.now?.() ?? new Date(),
  });
  if (!valid) {
    return Response.json({ error: 'invalid_signature' }, { status: 403 });
  }

  const event = parseInboundEmailEvent(rawBody);
  if (!event) {
    return Response.json({ outcome: 'ignored_event' satisfies EmailInboundOutcome });
  }

  const outcome = await routeEmailInbound(deps, config, event);
  return Response.json({ outcome });
}
