import { type Database, schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { emailBlindIndex } from '~/lib/crypto/blind-index';
import { RATE_LIMITS } from '~/lib/rate-limit/config';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import { parseEmailAddress } from './address';
import { automationKind } from './automated';
import {
  familyForForwardToken,
  forwardAddress,
  forwardClaimKey,
  forwardRecipient,
} from './forward-address';
import { type EmailForwardOutcome, routeEmailForward } from './forward';
import type { EmailReplyDeps } from './reply-send';
import { type EmailInboundConfig, emailInboundConfig } from './config';
import { honourEmailUnsubscribe } from './unsubscribe';
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
  /**
   * How Hale answers on the FORWARDING door (forward.ts). A thunk for the same reason
   * `content` is one: building it reaches for a provider client, and a forged request
   * must never cause one. Required, never nullable (rule #11) — a door that asks a
   * family whether it may read a school's mail and cannot send the question is a door
   * that holds their document and says nothing.
   */
  reply: () => EmailReplyDeps;
}

export type EmailInboundOutcome =
  /** Authentic, but not an inbound message we serve (another event type, or garbage). */
  | 'ignored_event'
  /** No routable sender address — nobody to attribute this to or answer. */
  | 'invalid_sender'
  | 'rate_limited'
  /** Already recorded under this Message-ID — a retry, not a second email. */
  | 'duplicate'
  /** The body can NEVER be fetched (the provider no longer has it). Named, never
   * treated as an empty message — and terminal, so it is acknowledged with a 200. */
  | 'content_unavailable'
  /** The body could not be fetched THIS TIME (rate limit, 5xx, unreachable provider).
   * Answered 5xx so svix redelivers — folding this into `content_unavailable` was a
   * 30-second provider blip permanently dropping a parent's email (PR #497 shape:
   * transient and permanent refusals are different types, not one string). */
  | 'content_fetch_transient'
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
  | 'enqueue_failed'
  /** The forwarding door's own outcomes (forward.ts). Folded into this union rather than
   * mapped onto it, because every one of them names a state the reply door has no word
   * for, and collapsing them would make the counter read as something it is not. */
  | EmailForwardOutcome;

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

  // THE PRE-FETCH BUDGET, and whose it is. Keyed on the SENDER on the reply door, where
  // the sender is the parent. On the forwarding door the sender is the school, so one busy
  // newsletter forwarded by several families would share a single bucket and the noisiest
  // household would silence the rest — the tag is keyed instead whenever `data.to` already
  // carries one.
  //
  // A TAG IS ONLY A BUDGET'S NAME ONCE IT NAMES A FAMILY. Reading a tag costs a regex and
  // proves nothing: 30 hex characters is a well-formed tag whoever wrote it, so keying on
  // an unverified one would let a single sender rotate guesses and draw a fresh bucket
  // for each — every one of them costing the content fetch this limit exists to bound.
  // One indexed lookup settles it, and a tag that resolves to nothing falls back to the
  // sender's own bucket rather than minting its own. Residual, named: when the tag is
  // only recoverable from the headers (which arrive with the fetch), this key stays the
  // sender.
  const tagged = forwardRecipient({ to: event.to, headers: {} }, config);
  // Resolved ONCE, and read twice: it is the budget's name below and the dedupe's scope
  // just after. One lookup rather than two of the same, and — more to the point — the two
  // questions cannot disagree about which household this delivery is for.
  const taggedFamilyId =
    tagged.kind === 'forward' ? await familyForForwardToken(deps.database, tagged.token) : null;
  const budgetKey =
    tagged.kind === 'forward' && taggedFamilyId
      ? forwardAddress(tagged.token, config)
      : sender.address;
  const decision = await deps.limiter.check(
    emailBlindIndex(budgetKey),
    INBOUND_ROUTE,
    RATE_LIMITS[INBOUND_ROUTE],
  );
  if (!decision.allowed) return 'rate_limited';

  // Before the fetch: a provider retry must not cost a second round-trip, and must never
  // produce a second ledger row. The Message-ID is the sender's own idempotency key — on
  // the reply door by itself, on the forwarding door only once the family is named with
  // it, because there the sender is a school rather than the household (see below).
  if (await alreadyRecorded(deps.database, event.messageId, taggedFamilyId)) return 'duplicate';

  const fetched = await deps.content().fetch(event.emailId);
  if (fetched.status === 'failed') {
    deps.log.error('inbound email: content unavailable', {
      emailId: event.emailId,
      reason: fetched.reason,
      transient: fetched.transient,
    });
    return fetched.transient ? 'content_fetch_transient' : 'content_unavailable';
  }
  const { headers, text } = fetched.content;
  const machine = automationKind({ from: event.from, headers }, config.inboundDomain);

  // THE FORK, and it sits here because three of the four places a forward tag can hide are
  // headers, which only exist after the fetch. Everything above — sender parse, the
  // sender-keyed limit, the pre-fetch dedupe, the fetch itself — is unchanged.
  //
  // A `hale+` tag STOPS here whatever happens next, including one we cannot read. Falling
  // through would hand the message to the reply door, where `From` silently becomes the
  // identity again — and on a filter auto-forward that `From` is the school.
  const recipient = forwardRecipient({ to: event.to, headers }, config);
  if (recipient.kind === 'malformed') return 'forward_unknown_token';
  if (recipient.kind === 'forward') {
    return routeEmailForward(
      {
        database: deps.database,
        limiter: deps.limiter,
        reply: deps.reply,
        now: deps.now ?? ((): Date => new Date()),
        log: deps.log,
      },
      config,
      { event, sender, token: recipient.token, ref: recipient.ref, text, machine, headers },
    );
  }

  if (machine) {
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
    return honourEmailUnsubscribe(deps.database, owner);
  }

  if (!body) return 'empty_after_extraction';

  return record(deps, { owner, event, body });
}

/**
 * Has this exact message already been filed? The index A2 left on `provider_message_id`
 * is what makes this cheap enough to run before the fetch.
 *
 * IT ASKS THE QUESTION EACH DOOR MEANS, and that is the whole of `forwardFamilyId`. On
 * the reply door a Message-ID is the parent's own envelope handle, so it is a sound
 * identity by itself and the global index answers. On the FORWARDING door the id belongs
 * to the school whose newsletter was forwarded, and two households can hold the same one
 * — so the identity there is (family, Message-ID) and the key is the ledger row's
 * `dedupe_key` (forward-address.ts `forwardClaimKey`). Asking the global question there
 * dropped the second household in silence.
 *
 * RESIDUAL, and named for the same reason the budget key above names its own: the family
 * is only known here when the tag was in `data.to`. A filter auto-forward that hides the
 * tag in a header falls to the global branch, which can no longer match a forward at all
 * (those rows carry no `provider_message_id`), so a redelivery of one costs one extra
 * content fetch and is then refused by the claim itself. A wasted round-trip, never a
 * wrong answer.
 *
 * The key is re-checked over the returned rows rather than trusted to the `where` alone —
 * the same defense in depth `resolveVerifiedChannelByPhone` documents. A dedupe that
 * matched the wrong row would silently swallow a real message.
 */
async function alreadyRecorded(
  database: Database,
  messageId: string,
  forwardFamilyId: string | null,
): Promise<boolean> {
  if (forwardFamilyId) {
    const key = forwardClaimKey(forwardFamilyId, messageId);
    const seen = await database
      .select({ dedupeKey: schema.channelMessages.dedupeKey })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.dedupeKey, key))
      .limit(1);
    return seen.some((row) => row.dedupeKey === key);
  }

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
 * Everything authentic answers 200 whatever the outcome — a 4xx/5xx would make the
 * provider retry a message we have already handled — with ONE exception:
 *   503 — the content fetch failed transiently, so the message was NOT handled and no
 *         row exists for the reconciler. svix retries on any non-2xx and on nothing
 *         else; this is the only path where a retry is the recovery.
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
  // Counted BEFORE the transient early-return: a retried delivery is still an outcome.
  deps.log.info('inbound email: routed', { outcome, emailId: event.emailId });
  await deps.countOutcome(outcome);
  if (outcome === 'content_fetch_transient') {
    return Response.json({ outcome }, { status: 503 });
  }
  return Response.json({ outcome });
}
