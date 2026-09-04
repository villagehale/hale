import { type Database, schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { type EmailType, recordOptOut } from '~/lib/cron/email-compliance';
import { UNSUBSCRIBABLE_STREAMS } from './streams';
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
import type { ChannelMessageReceivedJob } from '~/lib/channel/twilio/inbound';
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
 *  11. THE HANDOFF, which this leg now owns. The router C1 answers on the channel a
 *      message ARRIVED on (router/reply-route.ts), so a recorded email is a turn C1 can
 *      genuinely take — the same `channel.message.received` job A3 enqueues, pointing at
 *      the same ledger row, joining the same conversation. Two writes, in this order and
 *      never merged: the row is claimed by the INSERT, and `handed_off_at` is stamped
 *      only once the job really exists. A row left unmarked is an email still owed a
 *      reply, and the reconciler is what re-drives it.
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
  /** Hand the recorded email to C1. Required, never nullable (rule #11): a leg that
   * files a parent's message and cannot pass it on is a leg that swallows it. */
  enqueue: (job: ChannelMessageReceivedJob) => Promise<void>;
  now?: () => Date;
  /** Required, mirroring C1's router: every outcome this leg reaches without sending
   * anything is only visible if it is written down (rule #11). */
  log: Pick<Console, 'info' | 'error'>;
  /** Count one authentic request's FINAL outcome (PostHog, no PII — see
   * captureInboundRouted). Required (rule #11), the SMS door's exact twin: the
   * silence outcomes — rate_limited, unknown_sender, not_a_parent, automated — are
   * only distinguishable from "nobody emails us" if every one is written down as a
   * rate. Wired to a counter that never throws. */
  countOutcome: (outcome: EmailInboundOutcome) => Promise<void>;
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
  /** Filed in the family's ledger and handed to C1's queue. */
  | 'handed_off'
  /** Filed, but the queue refused it: the row is left unmarked for the reconciler, and
   * the parent is owed a reply Hale has not yet given. Never folded into `handed_off` —
   * that value is a claim that C1 has the email. */
  | 'enqueue_failed';

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
    deps.log.error('inbound email: content unavailable', {
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
    // MTA hostnames only (rule #1) — and the operator's one clue when the configured
    // authserv-id and the one the MTA really stamps disagree.
    deps.log.info(
      'inbound email: sender not trusted',
      trust.reason === 'no_trusted_verdict'
        ? { reason: trust.reason, observedAuthservIds: trust.observedAuthservIds }
        : { reason: trust.reason },
    );
    return 'untrusted';
  }

  const owner = await resolveEmailSender(deps.database, sender.address);
  if (!owner) return 'unknown_sender';
  if (!PARENT_ROLES.includes(owner.role)) return 'not_a_parent';

  // The new turn only. `text` may be absent on an HTML-only message; that is not an
  // error, it is a message with no plain part, and it reads as an empty turn rather than
  // being answered with stripped markup.
  const body = extractReply(text ?? '').text;

  // CASL before the attachment branch — see the module note. The keyword's language is
  // not read here: this path unsubscribes and replies with nothing, so ARRET and STOP
  // have the same one job.
  if (matchKeyword(body)?.keyword === 'stop') {
    return unsubscribe(deps, owner);
  }

  if (!body) return 'empty_after_extraction';

  return record(deps, { owner, event, body });
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
 *
 * The write goes through `recordOptOut`, the same function the unsubscribe LINK and the
 * settings toggle call, rather than a second inline insert that could drift from it. It
 * is idempotent on the unique (user, stream) index and reports whether THIS call was the
 * one that changed anything.
 *
 * That report is used, because an unsubscribe writes no `channel_messages` row and is
 * therefore invisible to the Message-ID dedupe above — every redelivery re-runs this. The
 * audit row is written only when a stream ACTUALLY changed, so a retried webhook does not
 * make the trail read as a parent unsubscribing over and over. Rule #6 asks for a row per
 * ACTION, and opting out something already opted out is not one; this is the same
 * reasoning as X1's STOP alert firing once per unsubscribe rather than once per click.
 */
async function unsubscribe(
  deps: EmailInboundDeps,
  args: { userId: string; familyId: string },
): Promise<EmailInboundOutcome> {
  await deps.database.transaction(async (tx) => {
    const changed: EmailType[] = [];
    for (const emailType of UNSUBSCRIBABLE_STREAMS) {
      const first = await recordOptOut(tx as unknown as Database, args.userId, emailType);
      if (first) changed.push(emailType);
    }
    if (changed.length === 0) return;

    await tx.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.userId,
      actionTaken: 'email_unsubscribe_received',
      targetTable: 'email_opt_outs',
      targetId: args.userId,
      after: { streams: changed, via: 'inbound_email' },
    });
  });
  return 'unsubscribed';
}

/**
 * File the message in the family's ledger, audit it (rule #6), and hand it to C1.
 *
 * The body stored is the EXTRACTED turn, not the raw email. Quoted history is a copy of
 * messages already in this ledger, and a signature block is contact data nobody asked us
 * to keep — storing either would mean holding more of a family's data than the exchange
 * needs (rule #1). Inbound bodies ARE stored, as on the SMS side: this is the parent's
 * own instruction, and the approvals path treats it as the legal instrument of a
 * decision.
 *
 * THE INSERT IS THE CLAIM, exactly as it is on the SMS side, and the pre-fetch dedupe
 * above does not replace it. That check runs before the content fetch to save a provider
 * round-trip on a retry; it cannot settle a race, because two deliveries of one
 * Message-ID can both pass it while the first is still in flight. The partial unique
 * index on (`provider_message_id`) where `direction = 'in'` decides it in the database
 * instead — exactly one request wins the row, and winning the row is what confers the
 * right (and the duty) to enqueue. Without it the loser would raise a unique violation,
 * the webhook would 500, and the provider would redeliver a message we already had.
 *
 * `handed_off_at` then answers a DIFFERENT question from "have we seen this email": it
 * answers "does C1 actually have it". Marked only after the job really exists, so a row
 * left null is an email still owed a reply and `reconcileUnhandedInbound` is what
 * re-drives it. Nothing re-drives it inside the request — a retry arriving seconds later
 * cannot tell a dead attempt from one still in flight, and the reconciler can, by age.
 */
async function record(
  deps: EmailInboundDeps,
  args: {
    owner: { userId: string; familyId: string };
    event: InboundEmailEvent;
    body: string;
  },
): Promise<EmailInboundOutcome> {
  const { owner, event, body } = args;
  const [row] = await deps.database
    .insert(schema.channelMessages)
    .values({
      familyId: owner.familyId,
      parentUserId: owner.userId,
      channel: 'email',
      direction: 'in',
      category: 'reply',
      providerMessageId: event.messageId,
      status: 'delivered',
      body,
      sentAt: event.receivedAt,
    })
    .onConflictDoNothing({
      target: schema.channelMessages.providerMessageId,
      where: sql`${schema.channelMessages.direction} = 'in' AND ${schema.channelMessages.providerMessageId} IS NOT NULL`,
    })
    .returning({ id: schema.channelMessages.id });
  // No row means another delivery of this same Message-ID won the claim. It owns the
  // hand-off; a second job here would be a second reply to one email.
  const channelMessageId = row?.id;
  if (!channelMessageId) return 'duplicate';

  await deps.database.insert(schema.auditLog).values({
    familyId: owner.familyId,
    actor: owner.userId,
    actionTaken: 'email_reply_received',
    targetTable: 'channel_messages',
    targetId: channelMessageId,
  });

  try {
    await deps.enqueue({
      family_id: owner.familyId,
      parent_user_id: owner.userId,
      channel_message_id: channelMessageId,
      provider_message_id: event.messageId,
      received_at: event.receivedAt.toISOString(),
    });
  } catch (err) {
    // The ids an operator can act on, and nothing the parent wrote (rule #1). The
    // Message-ID is the sender's own envelope handle, not their words — the same value
    // the SMS twin logs for the same reason.
    deps.log.error(
      {
        channelMessageId,
        providerMessageId: event.messageId,
        err: err instanceof Error ? err.message : String(err),
      },
      'email inbound: recorded the message but could not queue it for C1 — left unmarked for the reconciler',
    );
    return 'enqueue_failed';
  }

  await deps.database
    .update(schema.channelMessages)
    .set({ handedOffAt: deps.now?.() ?? new Date() })
    .where(eq(schema.channelMessages.id, channelMessageId));
  return 'handed_off';
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
    deps.log.info('inbound email: routed', { outcome: 'ignored_event' });
    await deps.countOutcome('ignored_event');
    return Response.json({ outcome: 'ignored_event' satisfies EmailInboundOutcome });
  }

  const outcome = await routeEmailInbound(deps, config, event);
  // The one line every authentic request ends with, and its counter twin — the
  // outcome JSON below goes back to svix, which discards it, so this is the only
  // place the silence outcomes become visible (rule #11). The email id is the
  // provider's envelope handle, never the sender or a word of the message (rule #1).
  deps.log.info('inbound email: routed', { outcome, emailId: event.emailId });
  await deps.countOutcome(outcome);
  return Response.json({ outcome });
}
