import { type Database, schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import { POLICY_VERSION } from '~/lib/consent';
import { f14EnabledFor } from '~/lib/channel/f14';
import { readAffirmative } from '~/lib/channel/affirmative';
import { RATE_LIMITS } from '~/lib/rate-limit/config';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import { domainOf, parseEmailAddress } from './address';
import type { AutomationKind } from './automated';
import type { EmailInboundConfig } from './config';
import {
  familyForForwardToken,
  forwardAnswerAddress,
  mintForwardRef,
} from './forward-address';
import {
  forwardAllowed,
  forwardAsk,
  forwardBlocked,
  forwardLocale,
  forwardUnclear,
  forwardUnknownRef,
} from './forward-copy';
import { parseForwardedMessage } from './forward-parse';
import { resolveEmailSender } from './identity';
import type { InboundEmailEvent } from './payload';
import { extractReply } from './reply-extract';
import { type EmailReplyDeps, sendEmailReply } from './reply-send';
import { resolveSendableEmail } from './sendable';
import { assessSenderTrust } from './trust';

/**
 * THE FORWARDING DOOR — what happens when a parent forwards somebody else's mail to their
 * own `hale+<token>@` address (VIL-352 rung 3a).
 *
 * It is a fork in the inbound router rather than a route of its own, because the door was
 * already open: any local part at the inbound domain reaches the same webhook. What
 * changes is WHO the message is from. On the reply door `From` is the identity; here the
 * `From` is the school on a filter auto-forward, so the RECIPIENT is the credential and
 * the sender is just a document's author (forward-address.ts).
 *
 * THE ORDER, and why it cannot be rearranged:
 *   1. TOKEN. A tag that resolves to no family stops here. It never falls through to the
 *      reply door, where `From` would quietly become an identity again.
 *   2. THE FLAG. Dark by default (D21), per family.
 *   3. MACHINE MAIL, per BRANCH rather than per door — see below.
 *   4. THE ANSWERABLE PARENT, resolved BEFORE the claim, because `parent_user_id` is NOT
 *      NULL on the ledger row and because a family with no reachable address is
 *      `forward_unroutable` rather than silence (rule #11).
 *   5. THE FAMILY-KEYED LIMIT, before the claim, so a throttled forward costs nothing and
 *      leaves no row claiming it was handled.
 *   6. THE LEDGER CLAIM, before any spend, any ask and any insert. This is the
 *      idempotency: the same partial unique index the reply door uses, so a Resend
 *      redelivery cannot buy a second ask — and, once PR2 lands, cannot buy a second
 *      model call or a second summary.
 *   7. The `.ref` decides ANSWER from DOCUMENT. The address is the state machine.
 *
 * TWO MACHINE-MAIL POLICIES, and the line between them is the BRANCH, not the door.
 * `automated.ts` refuses bulk and auto-reply mail because ANSWERING THE SENDER is how a
 * mail loop starts.
 *   - A forwarded DOCUMENT is answered to a verified parent resolved from the TOKEN,
 *     never to the message's sender, so no loop is possible: only `self` and `bounce`
 *     disqualify, and `bulk` — school newsletters, camp confirmations, registration
 *     receipts — is the highest-value class here rather than the one to drop.
 *   - An ANSWER is different in exactly the way that matters: the address that just wrote
 *     to Hale is the address Hale writes back to. A parent's out-of-office replying to
 *     the ask is a loop, every hop carrying a fresh Message-ID that nothing dedupes. So
 *     the answer branch keeps the reply door's policy in full. An instruction needs a
 *     person, and an auto-reply is not one.
 * The backstop under both, for a responder that sets no marker at all: an unclear answer
 * is re-asked ONCE and then met with silence, counted from the sender's own trail.
 *
 * PRIVACY (rule #1). No branch logs a body, a subject, a domain or an address. Outcomes
 * are an enum and ids. The domain reaches copy and a consent evidence field; the subject
 * reaches copy only. Neither ever reaches a log.
 */

const FORWARD_ROUTE = 'email-forward';

/** The roles that may decide what Hale reads. The same positive list the reply door
 * keeps (inbound.ts), for the same fail-closed reason. */
const PARENT_ROLES: readonly string[] = ['primary_parent', 'co_parent'];

/** The allowlist vocabulary. Text under a CHECK in the DB; validated here. */
type SenderState = 'pending' | 'allowed' | 'blocked';

export type EmailForwardOutcome =
  /** A `hale+` tag that resolves to no live family — revoked, mistyped, or guessed.
   * TERMINAL: it never falls through to the reply door. */
  | 'forward_unknown_token'
  /** The family is not armed for F14 yet (D21). */
  | 'forward_family_dark'
  /** Our own address, or a bounce: the only two machine verdicts that disqualify a
   * forwarded DOCUMENT, which is answered to a parent rather than to its sender. */
  | 'forward_machine'
  /** Machine mail addressed to the ANSWER address. An instruction needs a person, and
   * this is the branch where Hale would be writing back to whoever just wrote to it. */
  | 'forward_answer_machine'
  /** Nobody in the household has a usable address, so there is no one to answer. Named,
   * never silence (rule #11). */
  | 'forward_unroutable'
  | 'forward_rate_limited'
  /** Another delivery of this same Message-ID won the ledger claim. */
  | 'forward_duplicate'
  /** A new sender: held, and the parent was asked. */
  | 'forward_sender_pending'
  /** A sender already asked about: held, and deliberately NOT asked again. */
  | 'forward_sender_pending_again'
  /** The question could not be put — the transport refused it — so nothing was stored:
   * an un-asked ask must never sit in the database waiting to be purged. The next
   * forward from that sender asks again. */
  | 'forward_ask_failed'
  /** A sender the family said no to. Nothing stored, nothing sent. */
  | 'forward_sender_blocked'
  /** An allowed sender's document, and no summariser yet: PR1 reads nothing and stores
   * nothing. Named, logged and counted rather than silent (rule #11). */
  | 'forward_ready'
  /** A `.ref` naming no sender of that family — a stale or guessed answer address. */
  | 'forward_answer_unknown'
  /** An answer whose `From` is not a verified parent of that family. A forward is a
   * document and needs only the family; an INSTRUCTION needs a person. */
  | 'forward_answer_unauthorised'
  | 'forward_sender_allowed'
  | 'forward_sender_refused'
  /** Neither yes nor no, and the one re-ask this sender gets. */
  | 'forward_answer_unclear'
  /** Neither yes nor no, again. The re-ask is spent, so this one is answered with
   * silence — named and counted, because a deliberate silence is an outcome. */
  | 'forward_answer_unclear_again';

export interface EmailForwardDeps {
  database: Database;
  limiter: RateLimiter;
  /**
   * How Hale answers. A THUNK for the same reason the content reader is one: building it
   * reaches for a provider client, and a forged request must never cause one. Required,
   * never nullable (rule #11) — a door that asks a question it cannot send is a door that
   * holds a family's mail and says nothing.
   */
  reply: () => EmailReplyDeps;
  now: () => Date;
  log: Pick<Console, 'info' | 'error'>;
}

export interface EmailForwardInput {
  event: InboundEmailEvent;
  /** The tag the recipient carried. `ref` present means this is an ANSWER. */
  token: string;
  ref: string | null;
  /** The fetched plain part. Absent on an HTML-only message, which reads as a document
   * with no text rather than an error. */
  text: string | null;
  /** `automationKind`'s verdict, computed once by the router. */
  machine: AutomationKind | null;
  /** The fetched headers. Read on the ANSWER branch only, where DKIM alignment is what
   * turns a `From` into a person — see the asymmetry in the module note. */
  headers: Readonly<Record<string, string>>;
}

export async function routeEmailForward(
  deps: EmailForwardDeps,
  config: EmailInboundConfig,
  input: EmailForwardInput,
): Promise<EmailForwardOutcome> {
  const { event } = input;

  // The only refusal with no family behind it, and therefore the only one that can leave
  // no trail: there is no household to write the row against.
  const familyId = await familyForForwardToken(deps.database, input.token);
  if (!familyId) return 'forward_unknown_token';

  if (!f14EnabledFor(familyId)) return refuse(deps, { familyId }, 'forward_family_dark');

  const machine = machineRefusal(input);
  if (machine) return refuse(deps, { familyId }, machine);

  const parent = await answerableParent(deps.database, familyId, event.from);
  if (!parent) return refuse(deps, { familyId }, 'forward_unroutable');

  const decision = await deps.limiter.check(familyId, FORWARD_ROUTE, RATE_LIMITS[FORWARD_ROUTE]);
  if (!decision.allowed) {
    return refuse(deps, { familyId, actor: parent.userId }, 'forward_rate_limited');
  }

  const claimed = await claim(deps.database, { familyId, parent, event });
  // Not a refusal: another delivery of this Message-ID won the right to act, and its
  // trail row is the one that describes what happened to this message.
  if (!claimed) return 'forward_duplicate';

  return input.ref
    ? answer(deps, config, { ...input, familyId, parent })
    : document(deps, config, { ...input, familyId, parent });
}

/**
 * Which machine verdicts disqualify THIS message — see the two policies in the module
 * note. The asymmetry is the whole of it: a document is answered to somebody the token
 * named, an answer is answered to whoever sent it.
 */
function machineRefusal(
  input: Pick<EmailForwardInput, 'machine' | 'ref'>,
): 'forward_machine' | 'forward_answer_machine' | null {
  if (!input.machine) return null;
  if (input.ref) return 'forward_answer_machine';
  return input.machine === 'self' || input.machine === 'bounce' ? 'forward_machine' : null;
}

/**
 * Every way this door says no, and the trail row that says so (rule #6). A rejected
 * instruction against a household is a thing that happened to that household, and the
 * reason is the outcome token itself — never a subject, a body or an address (rule #1).
 */
type ForwardRefusal = Extract<
  EmailForwardOutcome,
  | 'forward_family_dark'
  | 'forward_machine'
  | 'forward_answer_machine'
  | 'forward_unroutable'
  | 'forward_rate_limited'
  | 'forward_ask_failed'
  | 'forward_sender_blocked'
  | 'forward_answer_unknown'
  | 'forward_answer_unauthorised'
  | 'forward_answer_unclear_again'
>;

async function refuse<Reason extends ForwardRefusal>(
  deps: EmailForwardDeps,
  args: { familyId: string; actor?: string },
  reason: Reason,
): Promise<Reason> {
  await deps.database.insert(schema.auditLog).values({
    familyId: args.familyId,
    // 'system' when the refusal is precisely that nobody was identified — an
    // unauthenticated answer, or a household with no reachable parent.
    actor: args.actor ?? 'system',
    actionTaken: 'email_forward_refused',
    after: { reason },
  });
  return reason;
}

/** The parent this door answers, with the address to answer them at. */
interface AnswerableParent {
  userId: string;
  address: string;
  locale: string | null;
}

/**
 * WHO IS ANSWERED, and never the message's `From`: the answer goes to a verified parent
 * of the family the TOKEN named. If the `From` happens to resolve to a parent of that
 * same family — a manual forward — answer them; otherwise the primary parent, because on
 * a filter auto-forward the sender is a school that must never be written to.
 *
 * That is also why the mail-loop guard can relax on this door: Hale cannot loop with an
 * out-of-office it never replies to.
 */
async function answerableParent(
  database: Database,
  familyId: string,
  from: string,
): Promise<AnswerableParent | null> {
  const members = await database
    .select({ userId: schema.familyMembers.userId, role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));

  const parents = members.filter((row) => PARENT_ROLES.includes(row.role));
  if (parents.length === 0) return null;

  const sender = parseEmailAddress(from);
  const owner = sender ? await resolveEmailSender(database, sender.address) : null;
  const forwarder =
    owner && owner.familyId === familyId && PARENT_ROLES.includes(owner.role)
      ? owner.userId
      : null;

  const ordered = [
    ...(forwarder ? [forwarder] : []),
    ...parents
      .filter((row) => row.userId !== forwarder)
      .sort((a, b) => Number(b.role === 'primary_parent') - Number(a.role === 'primary_parent'))
      .map((row) => row.userId),
  ];

  for (const userId of ordered) {
    const address = await resolveSendableEmail(database, userId);
    if (!address) continue;
    const [user] = await database
      .select({ locale: schema.users.locale })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    return { userId, address, locale: user?.locale ?? null };
  }
  return null;
}

/**
 * THE CLAIM, and the whole of this door's idempotency. Same partial unique index as the
 * reply door (`provider_message_id` where `direction = 'in'`), so exactly one delivery of
 * a Message-ID wins the right — and the duty — to act on it.
 *
 * `body` is NULL here, and it is the one place this door departs from the inbound
 * convention. The reply door stores the parent's own instruction because the approvals
 * path treats it as the legal instrument of a decision. A forwarded body is a third
 * party's document: it lives in `email_forwards_pending` while a decision is pending and
 * nowhere at all once the sender is allowed.
 */
async function claim(
  database: Database,
  args: { familyId: string; parent: AnswerableParent; event: InboundEmailEvent },
): Promise<boolean> {
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: args.familyId,
      parentUserId: args.parent.userId,
      channel: 'email',
      direction: 'in',
      category: 'forwarded_mail',
      providerMessageId: args.event.messageId,
      status: 'delivered',
      body: null,
      sentAt: args.event.receivedAt,
    })
    .onConflictDoNothing({
      target: schema.channelMessages.providerMessageId,
      where: sql`${schema.channelMessages.direction} = 'in' AND ${schema.channelMessages.providerMessageId} IS NOT NULL`,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) return false;

  await database.insert(schema.auditLog).values({
    familyId: args.familyId,
    actor: args.parent.userId,
    actionTaken: 'email_forward_received',
    targetTable: 'channel_messages',
    targetId: row.id,
  });
  return true;
}

type Branch = EmailForwardInput & { familyId: string; parent: AnswerableParent };

/** A forwarded DOCUMENT: the allowlist decides whether it is read at all. */
async function document(
  deps: EmailForwardDeps,
  config: EmailInboundConfig,
  input: Branch,
): Promise<EmailForwardOutcome> {
  const parsed = parseForwardedMessage(input.text ?? '');
  // A filter auto-forward carries no banner, so the envelope sender IS the school. The
  // router has already refused an unparseable `From`, so one of the two always resolves.
  const originalFrom = parsed.originalFrom ?? parseEmailAddress(input.event.from)?.address;
  if (!originalFrom) return refuse(deps, { familyId: input.familyId }, 'forward_unroutable');
  const domain = domainOf(originalFrom);

  const held = {
    familyId: input.familyId,
    providerMessageId: input.event.messageId,
    originalFrom,
    subject: parsed.originalSubject ?? input.event.subject,
    rawBody: parsed.body,
    receivedAt: input.event.receivedAt,
  };

  const existing = await senderByDomain(deps.database, input.familyId, domain);
  if (existing) return settled(deps, input, held, existing);

  // THE DOMAIN IS CLAIMED BEFORE THE ASK, and this is the ordering the ask's `Reply-To`
  // depends on. Two first forwards from one new school can race here; if the ask went
  // first, both would send one, the loser's INSERT would violate the domain index, and
  // the parent would hold a `.ref` that resolves to nothing — their YES answered by
  // silence. Claiming first makes the ref in a parent's hand always a ref Hale knows.
  // `DO UPDATE` on a column that is already that value, rather than `DO NOTHING`, so the
  // conflicting row comes back and the loser can hold against the winner's question.
  const ref = mintForwardRef();
  const [sender] = await deps.database
    .insert(schema.familyForwardSenders)
    .values({ familyId: input.familyId, senderDomain: domain, ref, state: 'pending' })
    .onConflictDoUpdate({
      target: [schema.familyForwardSenders.familyId, schema.familyForwardSenders.senderDomain],
      set: { senderDomain: domain },
    })
    .returning({
      id: schema.familyForwardSenders.id,
      ref: schema.familyForwardSenders.ref,
      state: schema.familyForwardSenders.state,
    });
  // An upsert always hands a row back, so this is the impossible branch — named anyway,
  // because the alternative is a throw that svix would redeliver into a duplicate.
  if (!sender) return refuse(deps, { familyId: input.familyId }, 'forward_ask_failed');
  if (sender.ref !== ref) {
    // Somebody else's row came back: another delivery asked about this domain first.
    return settled(deps, input, held, { id: sender.id, state: sender.state as SenderState });
  }

  const locale = forwardLocale(input.parent.locale);
  try {
    await sendEmailReply(deps.reply(), {
      to: input.parent.address,
      body: forwardAsk(locale, { subject: held.subject, domain }),
      inReplyTo: input.event.messageId,
      replyTo: forwardAnswerAddress(input.token, ref, config),
    });
  } catch (err) {
    // The claim is given back. Nothing may be left holding a document against a question
    // nobody was asked — the 72h sweep would then purge it in silence — so the next
    // forward from this school asks again. The held row is not written at all.
    deps.log.error(
      {
        familyId: input.familyId,
        providerMessageId: input.event.messageId,
        err: err instanceof Error ? err.message : String(err),
      },
      'email forward: the ask could not be sent — nothing was stored, the next forward asks again',
    );
    await deps.database
      .delete(schema.familyForwardSenders)
      .where(eq(schema.familyForwardSenders.id, sender.id));
    return refuse(deps, { familyId: input.familyId, actor: input.parent.userId }, 'forward_ask_failed');
  }

  await deps.database.transaction(async (tx) => {
    await tx
      .insert(schema.emailForwardsPending)
      .values({ ...held, senderId: sender.id })
      .onConflictDoNothing({ target: schema.emailForwardsPending.providerMessageId });
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parent.userId,
      actionTaken: 'email_forward_sender_asked',
      targetTable: 'family_forward_senders',
      targetId: sender.id,
      after: { senderDomain: domain },
    });
  });
  return 'forward_sender_pending';
}

/** What happens to a document whose sender the family has already met — reached from the
 * read before the claim, and again from losing the claim to a racing delivery. */
async function settled(
  deps: EmailForwardDeps,
  input: Branch,
  held: Omit<typeof schema.emailForwardsPending.$inferInsert, 'senderId'>,
  sender: { id: string; state: SenderState },
): Promise<EmailForwardOutcome> {
  if (sender.state === 'blocked') {
    return refuse(deps, { familyId: input.familyId }, 'forward_sender_blocked');
  }
  if (sender.state === 'allowed') return 'forward_ready';
  // Already asked about. A second forward is held, and deliberately NOT a second ask.
  await hold(deps.database, { ...held, senderId: sender.id });
  return 'forward_sender_pending_again';
}

/**
 * AN ANSWER about one pending sender. Unlike a document, this is an INSTRUCTION, so it
 * needs a person: the DKIM-aligned `From` must resolve to a parent of the family the token
 * named. That asymmetry is the whole point of the two address forms.
 */
async function answer(
  deps: EmailForwardDeps,
  config: EmailInboundConfig,
  input: Branch,
): Promise<EmailForwardOutcome> {
  // THE PERSON FIRST, before the question is even looked up: this branch writes back to
  // the address that wrote to it, so who that is decides whether Hale may speak at all.
  // A DOCUMENT needs only the family, because the TOKEN is the credential. An
  // INSTRUCTION needs a person, and a `From` is a claim until DKIM says otherwise — so
  // this branch, and only this branch, runs the reply door's trust gate (trust.ts).
  const from = parseEmailAddress(input.event.from);
  const trust = from
    ? assessSenderTrust({
        headers: input.headers,
        authservId: config.authservId,
        fromDomain: from.domain,
      })
    : { trusted: false as const, reason: 'no_trusted_verdict' as const, observedAuthservIds: [] };
  const owner =
    from && trust.trusted ? await resolveEmailSender(deps.database, from.address) : null;
  if (!owner || owner.familyId !== input.familyId || !PARENT_ROLES.includes(owner.role)) {
    return refuse(deps, { familyId: input.familyId }, 'forward_answer_unauthorised');
  }

  const locale = forwardLocale(input.parent.locale);
  const [sender] = await deps.database
    .select({
      id: schema.familyForwardSenders.id,
      senderDomain: schema.familyForwardSenders.senderDomain,
      state: schema.familyForwardSenders.state,
    })
    .from(schema.familyForwardSenders)
    .where(
      and(
        eq(schema.familyForwardSenders.familyId, input.familyId),
        eq(schema.familyForwardSenders.ref, input.ref as string),
      ),
    )
    .limit(1);
  if (!sender) {
    // A `.ref` Hale no longer holds — the three-day purge took the question with the
    // document it was about. A verified parent hears why rather than nothing (rule #11).
    await sendEmailReply(deps.reply(), {
      to: input.parent.address,
      body: forwardUnknownRef(locale),
      inReplyTo: input.event.messageId,
    });
    return refuse(deps, { familyId: input.familyId, actor: owner.userId }, 'forward_answer_unknown');
  }

  // STRIPPED BEFORE IT IS READ. `readAffirmative` is an exact-phrase lookup over the whole
  // normalized body, and every quoting client ships the ask back underneath a one-word
  // reply — so an unstripped "Yes" normalizes to "yes on tue hale wrote you forwarded …"
  // and reads as unclear. Every real YES would fail.
  const verdict = readAffirmative(extractReply(input.text ?? '').text);
  const domain = sender.senderDomain;

  if (verdict === 'unclear') {
    // ONE re-ask, counted from the sender's own trail rather than a column: the ask and
    // the re-ask are the only two rows this verb writes about this sender, so a third
    // question would be the first one nobody bounded. The machine check above catches an
    // auto-responder that announces itself; this catches one that does not.
    if ((await timesAsked(deps.database, input.familyId, sender.id)) >= 2) {
      return refuse(
        deps,
        { familyId: input.familyId, actor: owner.userId },
        'forward_answer_unclear_again',
      );
    }
    await sendEmailReply(deps.reply(), {
      to: input.parent.address,
      body: forwardUnclear(locale, { domain }),
      inReplyTo: input.event.messageId,
    });
    // Written after the send, as the first ask is: a question Hale is recorded as having
    // asked must be one a transport really accepted.
    await deps.database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: owner.userId,
      actionTaken: 'email_forward_sender_asked',
      targetTable: 'family_forward_senders',
      targetId: sender.id,
      after: { senderDomain: domain },
    });
    return 'forward_answer_unclear';
  }

  const allowed = verdict === 'yes';
  // THE DECISION COMMITS BEFORE THE ACKNOWLEDGEMENT, and the ask's ordering is inverted
  // here on purpose. A question must exist in the world before it is recorded; a parent's
  // own decision must be durable before anything else happens to it. Acknowledging first
  // would mean a DB failure leaving a household told "from now on I'll read…" over a
  // sender still pending, and a transport failure losing the YES to a redelivery the
  // ledger claim then dismisses as a duplicate.
  await deps.database.transaction(async (tx) => {
    await tx
      .update(schema.familyForwardSenders)
      .set({
        state: (allowed ? 'allowed' : 'blocked') satisfies SenderState,
        decidedBy: owner.userId,
        decidedAt: deps.now(),
      })
      .where(eq(schema.familyForwardSenders.id, sender.id));

    // The legal record of the same YES, beside the routing projection that reads it. The
    // evidence carries the parent's own words and the reading made of them, because
    // "they agreed" to a conversational consent is otherwise unfalsifiable.
    await tx.insert(schema.consentRecords).values({
      userId: owner.userId,
      familyId: input.familyId,
      consentType: 'integration_specific',
      consentScope: `email_forward:${domain}`,
      granted: allowed,
      policyVersion: POLICY_VERSION,
      evidence: {
        verbatimReply: extractReply(input.text ?? '').text,
        interpretation: verdict,
        ask: forwardAsk(locale, { subject: '', domain }),
      },
    });

    // Nothing raw survives a decision, in either direction: allowed means the body is
    // read live and never stored, blocked means it is gone.
    const purged = await tx
      .delete(schema.emailForwardsPending)
      .where(eq(schema.emailForwardsPending.senderId, sender.id))
      .returning({ id: schema.emailForwardsPending.id });

    // Two literal inserts rather than one with a ternary verb: the drift gate reads
    // `actionTaken` STATICALLY, and a computed token is a verb the trail cannot promise
    // it can describe (verbs-drift.test.ts).
    const row = {
      familyId: input.familyId,
      actor: owner.userId,
      targetTable: 'family_forward_senders',
      targetId: sender.id,
      after: { senderDomain: domain },
    };
    if (allowed) {
      await tx.insert(schema.auditLog).values({ ...row, actionTaken: 'email_forward_sender_allowed' });
    } else {
      await tx.insert(schema.auditLog).values({ ...row, actionTaken: 'email_forward_sender_blocked' });
    }
    if (purged.length > 0) {
      await tx.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: owner.userId,
        actionTaken: 'email_forward_raw_purged',
        targetTable: 'email_forwards_pending',
        targetId: sender.id,
        after: { purged: purged.length },
      });
    }
  });

  await sendEmailReply(deps.reply(), {
    to: input.parent.address,
    body: allowed ? forwardAllowed(locale, { domain }) : forwardBlocked(locale, { domain }),
    inReplyTo: input.event.messageId,
  });

  return allowed ? 'forward_sender_allowed' : 'forward_sender_refused';
}

/**
 * How many times this sender has been asked about. The audit trail is the count, not a
 * column: the verb is written exactly once per question actually sent, so the trail
 * already IS the state — and a bound that reads the same rows a parent can read is a
 * bound nobody has to keep in sync.
 */
async function timesAsked(
  database: Database,
  familyId: string,
  senderId: string,
): Promise<number> {
  const rows = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'email_forward_sender_asked'),
        eq(schema.auditLog.targetId, senderId),
      ),
    );
  return rows.length;
}

async function senderByDomain(
  database: Database,
  familyId: string,
  domain: string,
): Promise<{ id: string; state: SenderState } | null> {
  const rows = await database
    .select({
      id: schema.familyForwardSenders.id,
      senderDomain: schema.familyForwardSenders.senderDomain,
      state: schema.familyForwardSenders.state,
    })
    .from(schema.familyForwardSenders)
    .where(
      and(
        eq(schema.familyForwardSenders.familyId, familyId),
        eq(schema.familyForwardSenders.senderDomain, domain),
      ),
    )
    .limit(1);

  // Re-checked over the returned row rather than trusted to the predicate — the same
  // defense in depth identity.ts keeps. The wrong row here reads as somebody else's
  // allowlist decision.
  const row = rows.find((candidate) => candidate.senderDomain === domain);
  return row ? { id: row.id, state: row.state as SenderState } : null;
}

async function hold(
  database: Database,
  values: typeof schema.emailForwardsPending.$inferInsert,
): Promise<void> {
  await database
    .insert(schema.emailForwardsPending)
    .values(values)
    .onConflictDoNothing({ target: schema.emailForwardsPending.providerMessageId });
}
