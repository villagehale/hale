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
 *   3. MACHINE MAIL, and a DIFFERENT policy from the reply door's — see below.
 *   4. THE ANSWERABLE PARENT, resolved BEFORE the claim, because `parent_user_id` is NOT
 *      NULL on the ledger row and because a family with no reachable address is
 *      `forward_unroutable` rather than silence (rule #11).
 *   5. THE FAMILY-KEYED LIMIT, before the claim, so a throttled message is redelivered
 *      rather than marked seen.
 *   6. THE LEDGER CLAIM, before any spend, any ask and any insert. This is the
 *      idempotency: the same partial unique index the reply door uses, so a Resend
 *      redelivery cannot buy a second ask — and, once PR2 lands, cannot buy a second
 *      model call or a second summary.
 *   7. The `.ref` decides ANSWER from DOCUMENT. The address is the state machine.
 *
 * TWO DOORS, TWO MACHINE-MAIL POLICIES, both written down. `automated.ts` refuses bulk
 * and auto-reply mail because ANSWERING THE SENDER is how a mail loop starts. This door
 * never answers the sender: the reply goes to a verified parent's own address, resolved
 * from the token. So only `self` and `bounce` disqualify here, and `bulk` — school
 * newsletters, camp confirmations, registration receipts — is the highest-value class on
 * this door rather than the one to drop.
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
  /** Our own address, or a bounce. The only two machine verdicts that disqualify here. */
  | 'forward_machine'
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
  /** The transport refused the ask, so nothing was stored — an un-asked ask must never
   * sit in the database waiting to be purged. The next forward asks again. */
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
  /** Neither yes nor no. One re-ask, then silence. */
  | 'forward_answer_unclear';

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

  const familyId = await familyForForwardToken(deps.database, input.token);
  if (!familyId) return 'forward_unknown_token';
  if (!f14EnabledFor(familyId)) return 'forward_family_dark';
  if (input.machine === 'self' || input.machine === 'bounce') return 'forward_machine';

  const parent = await answerableParent(deps.database, familyId, event.from);
  if (!parent) return 'forward_unroutable';

  const decision = await deps.limiter.check(familyId, FORWARD_ROUTE, RATE_LIMITS[FORWARD_ROUTE]);
  if (!decision.allowed) return 'forward_rate_limited';

  const claimed = await claim(deps.database, { familyId, parent, event });
  if (!claimed) return 'forward_duplicate';

  return input.ref
    ? answer(deps, config, { ...input, familyId, parent })
    : document(deps, config, { ...input, familyId, parent });
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
  if (!originalFrom) return 'forward_unroutable';
  const domain = domainOf(originalFrom);

  const existing = await senderByDomain(deps.database, input.familyId, domain);
  if (existing?.state === 'blocked') return 'forward_sender_blocked';
  if (existing?.state === 'allowed') return 'forward_ready';

  const subject = parsed.originalSubject ?? input.event.subject;
  const held = {
    familyId: input.familyId,
    providerMessageId: input.event.messageId,
    originalFrom,
    subject,
    rawBody: parsed.body,
    receivedAt: input.event.receivedAt,
  };

  if (existing) {
    // Already asked about. A second forward is held, and deliberately NOT a second ask.
    await hold(deps.database, { ...held, senderId: existing.id });
    return 'forward_sender_pending_again';
  }

  // THE ASK GOES FIRST, and nothing is written until the transport accepts it (the
  // send-time discipline `email_alert_offers` keeps). A pending row behind an ask that was
  // never sent is a held document waiting for an answer to a question nobody was asked —
  // which the 72h sweep would then purge in silence.
  const ref = mintForwardRef();
  const locale = forwardLocale(input.parent.locale);
  try {
    await sendEmailReply(deps.reply(), {
      to: input.parent.address,
      body: forwardAsk(locale, { subject, domain }),
      inReplyTo: input.event.messageId,
      replyTo: forwardAnswerAddress(input.token, ref, config),
    });
  } catch (err) {
    deps.log.error(
      {
        familyId: input.familyId,
        providerMessageId: input.event.messageId,
        err: err instanceof Error ? err.message : String(err),
      },
      'email forward: the ask could not be sent — nothing was stored, the next forward asks again',
    );
    return 'forward_ask_failed';
  }

  await deps.database.transaction(async (tx) => {
    const [sender] = await tx
      .insert(schema.familyForwardSenders)
      .values({ familyId: input.familyId, senderDomain: domain, ref, state: 'pending' })
      .returning({ id: schema.familyForwardSenders.id });
    if (!sender) return;
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
  if (!sender) return 'forward_answer_unknown';

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
    return 'forward_answer_unauthorised';
  }

  // STRIPPED BEFORE IT IS READ. `readAffirmative` is an exact-phrase lookup over the whole
  // normalized body, and every quoting client ships the ask back underneath a one-word
  // reply — so an unstripped "Yes" normalizes to "yes on tue hale wrote you forwarded …"
  // and reads as unclear. Every real YES would fail.
  const verdict = readAffirmative(extractReply(input.text ?? '').text);
  const domain = sender.senderDomain;
  const locale = forwardLocale(input.parent.locale);

  if (verdict === 'unclear') {
    await sendEmailReply(deps.reply(), {
      to: input.parent.address,
      body: forwardUnclear(locale, { domain }),
      inReplyTo: input.event.messageId,
    });
    return 'forward_answer_unclear';
  }

  const allowed = verdict === 'yes';
  await sendEmailReply(deps.reply(), {
    to: input.parent.address,
    body: allowed
      ? forwardAllowed(locale, { domain })
      : forwardBlocked(locale, { domain }),
    inReplyTo: input.event.messageId,
  });

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

  return allowed ? 'forward_sender_allowed' : 'forward_sender_refused';
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
