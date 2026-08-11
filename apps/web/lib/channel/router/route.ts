import { type Database, type UnmetIntentLane, schema } from '@hale/db';
import { scopedReply } from '~/lib/channel/caregiver/copy';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import type { OffDomainLane } from '~/lib/channel/off-domain/lane';
import { type FamilyRole, isCaregiverRole } from '~/lib/channel/role-scope';
import type { ChannelMessageReceivedJob } from '~/lib/channel/twilio/inbound';
import { appendMessage, resolveOrCreateNoteConversation } from '~/lib/coach/conversation';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import type { RateLimiter } from '~/lib/rate-limit/limiter';
import { type ChannelCoachRuntime, type ChannelTurn, draftsFromFailure } from './coach-runtime';
import { ACK_REPLY, FLOOD_REPLY, failureReply, partialFailureReply } from './copy';
import { AGENT_TURN_LIMIT, AGENT_TURN_ROUTE } from './flood';

/**
 * VIL-220 · C1 — the inbound router: the consumer of A3's `channel.message.received`.
 *
 * A3 answers "may this number talk to us at all" and writes the ledger row. This module
 * answers the next three questions, and the ORDER it answers them in is the whole
 * design:
 *
 *   1. WHO IS TALKING?   A caregiver is answered with M6's one static line and stops
 *      here. The webhook already refuses to enqueue a non-parent, so this is the second
 *      of two gates — deliberately, because the cost of the pair being wrong is a
 *      household agent answering a babysitter's question about a child (rule #1), and
 *      one gate is one edit away from none.
 *
 *   2. IS THIS A TURN, OR A COMMAND?   The deterministic handlers run FIRST, in order,
 *      and the first one to claim the message ends the turn. This is not an
 *      optimization. "done" is a family fact being filed, "YES 2" is consent to execute
 *      (rule #4), "waitlisted #3" starts a 36-hour clock — none of them may be
 *      paraphrased by a model, and the only way to guarantee that is for the model
 *      never to see them.
 *
 *   3. CAN WE AFFORD TO THINK?   Flood control sits BELOW the handlers, so a parent
 *      whose hour is spent can still approve, decline, and file a "done". Only the
 *      expensive half is held.
 *
 *   4. IS THIS EVEN OUR JOB?   (VIL-273) The last question before the expensive one,
 *      and the cheapest of the four that costs a model at all. Hale is a chief of staff,
 *      not an event finder and not a search box: "how's the weather" has a right answer
 *      that no coach turn improves, and on live-gate day 1 it cost ~42 seconds of one to
 *      say nothing. The off-domain lane answers those in one fixed line. It sits HERE
 *      rather than among the handlers because it is not deterministic — it costs a Haiku
 *      call, and a Haiku call must never be what stands between a parent and the word
 *      "yes".
 *
 * Everything the router does after that is bookkeeping it owes the parent: the turn is
 * threaded into their one long-lived conversation (visible in the app's Ask history),
 * every message either way is a `messages` row, every outbound is a ledger row plus an
 * immutable audit row (rule #6), and nothing that fails does so silently.
 *
 * PRIVACY. Bodies are never logged, in any branch — not the parent's message, not
 * Hale's reply, not the number. The log line carries ids and an outcome enum, which is
 * everything X1 needs to count and nothing a log aggregator should not hold (rule #1).
 */

/** The roles a household agent may speak to. A POSITIVE list, mirroring A3's: the
 * legacy `extended`/`service` buckets carry an empty content scope precisely so they
 * fail closed, and a negative check would route them. */
const PARENT_ROLES: ReadonlySet<string> = new Set(['primary_parent', 'co_parent']);

/**
 * Who texted, what they said, and where a reply can go — resolved in ONE read so the
 * router has no queries of its own. `phoneE164` is null unless there is an ACTIVE,
 * verified, non-revoked channel, which is what makes texting a stopped number
 * structurally impossible rather than merely unlikely (CASL, rule #1).
 */
export interface InboundContext {
  body: string;
  role: FamilyRole | null;
  /** Who a caregiver is pointed at (M6's copy), null when it cannot be resolved. */
  primaryParentName: string | null;
  phoneE164: string | null;
}

/** One turn as a deterministic handler sees it — the same shape the coach gets, so a
 * handler and the agent reason over identical inputs. */
export interface HandlerContext extends ChannelTurn {}

export type { ChannelCoachRuntime, ChannelTurn };

export type HandlerVerdict =
  /** Not mine — the router tries the next handler. */
  | { claimed: false }
  /** Mine, and finished. `reply` is null when the handler already answered for itself. */
  | { claimed: true; outcome: string; reply: string | null };

/**
 * A pre-agent answer that does not involve a model.
 *
 * Each one wraps a module that already owns its own certainty — M8's health replies,
 * M7's registration check-ins, C1's own approval grammar — and adapts it to this
 * contract. They are ordered by the caller (see `defaultHandlers`), and the order is a
 * product decision, not an implementation detail.
 */
export interface DeterministicHandler {
  readonly name: string;
  handle(database: Database, ctx: HandlerContext): Promise<HandlerVerdict>;
}

/** A cancellable delay, injected so the ack path is testable without real time. */
export interface AckTimer {
  readonly elapsed: Promise<void>;
  cancel(): void;
}

/** How long a turn may run before the parent is told it is still running. Under
 * Twilio's own patience and well under the 30s the ticket budgets for a full reply. */
export const ACK_AFTER_MS = 5_000;

export function realAckTimer(ms: number): AckTimer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return {
    elapsed,
    cancel: () => {
      if (handle) clearTimeout(handle);
    },
  };
}

export interface ChannelRouterDeps {
  database: Database;
  loadContext(
    database: Database,
    job: ChannelMessageReceivedJob,
  ): Promise<InboundContext | null>;
  transport: ChannelTransport;
  handlers: readonly DeterministicHandler[];
  /** The cheap screen that answers what Hale does not do, before the coach is woken.
   * Non-nullable (rule #11): "no lane wired" is not a state this router has — a lane
   * that cannot run says so by returning `in_domain` with a named fallback. */
  offDomain: OffDomainLane;
  coach: ChannelCoachRuntime;
  limiter: RateLimiter;
  ackTimer(ms: number): AckTimer;
  now(): Date;
  log: Pick<Console, 'info' | 'error'>;
}

export type RouterStatus =
  /** The ledger row named by the job is gone — nothing to route. */
  | 'unknown_message'
  /** Not a parent: answered with M6's line, never threaded, never modelled. */
  | 'not_a_parent'
  /** No active verified channel to answer on. Nothing sent (CASL). */
  | 'unreachable'
  /** A deterministic handler owned it. */
  | 'handled'
  | 'flood_held'
  /** The off-domain lane answered it with a fixed line; no coach turn was spent. */
  | 'deflected'
  | 'agent_replied'
  | 'agent_failed';

export interface RouterResult {
  status: RouterStatus;
  /** Which handler claimed it, when one did. */
  handler: string | null;
  conversationId: string | null;
  /** Which lane deflected it, when one did. Null for every other status — including an
   * in-domain turn, which is not an unmet intent and is counted as nothing. */
  lane: UnmetIntentLane | null;
}

export async function routeChannelMessage(
  deps: ChannelRouterDeps,
  job: ChannelMessageReceivedJob,
): Promise<RouterResult> {
  const now = deps.now();
  const context = await deps.loadContext(deps.database, job);
  if (!context) {
    return done(deps, job, {
      status: 'unknown_message',
      handler: null,
      conversationId: null,
      lane: null,
    });
  }

  // GATE 1 — who is talking. Before the thread is opened, so a non-parent's message can
  // never appear in the parents' Ask history.
  if (context.role === null || !PARENT_ROLES.has(context.role)) {
    if (context.phoneE164 && isOutsiderWeMayAnswer(context.role)) {
      // Ledgered and audited like every other outbound (rule #6) — but with NO
      // conversation, because a caregiver's exchange must never appear in the parents'
      // Ask history. That is the one difference between this send and a parent's.
      await sendReply(deps, {
        to: context.phoneE164,
        body: scopedReply(context.primaryParentName),
        job,
        conversationId: null,
      });
    }
    return done(deps, job, {
      status: 'not_a_parent',
      handler: null,
      conversationId: null,
      lane: null,
    });
  }

  if (!context.phoneE164) {
    return done(deps, job, {
      status: 'unreachable',
      handler: null,
      conversationId: null,
      lane: null,
    });
  }
  const phoneE164 = context.phoneE164;

  // THREAD. One long-lived conversation per parent, resolved through the note anchor's
  // partial unique index so two texts arriving together cannot fork it.
  const conversationId = await resolveOrCreateNoteConversation(
    job.family_id,
    channelSmsNoteKey(job.parent_user_id),
    deps.database,
  );
  await appendMessage(conversationId, 'user', context.body, deps.database);

  const turn: HandlerContext = {
    familyId: job.family_id,
    parentUserId: job.parent_user_id,
    conversationId,
    body: context.body,
    now,
  };

  const say = (body: string) =>
    sendReply(deps, { to: phoneE164, body, job, conversationId });

  // GATE 2 — the deterministic handlers, in order. First claim ends the turn.
  for (const handler of deps.handlers) {
    const verdict = await handler.handle(deps.database, turn);
    if (!verdict.claimed) continue;
    if (verdict.reply !== null) await say(verdict.reply);
    return done(deps, job, {
      status: 'handled',
      handler: handler.name,
      conversationId,
      lane: null,
    });
  }

  // GATE 3 — can we afford to think. Counted only here, so a deterministic answer never
  // spends a parent's hourly budget.
  const decision = await deps.limiter.check(
    job.parent_user_id,
    AGENT_TURN_ROUTE,
    AGENT_TURN_LIMIT,
  );
  if (!decision.allowed) {
    await say(FLOOD_REPLY);
    return done(deps, job, { status: 'flood_held', handler: null, conversationId, lane: null });
  }

  // GATE 4 — is this even our job. The screen reads the LEDGER body (the same words the
  // handlers just declined), stamps its verdict on that same row, and answers with a
  // fixed line — so a deflection costs one Haiku call and no coach turn at all. An
  // in-domain verdict, including every fail-open one, falls through untouched.
  const verdict = await deps.offDomain.consider({
    familyId: job.family_id,
    channelMessageId: job.channel_message_id,
    text: context.body,
  });
  if (verdict.status === 'deflected') {
    await say(verdict.reply);
    return done(deps, job, {
      status: 'deflected',
      handler: null,
      conversationId,
      lane: verdict.lane,
    });
  }

  return runAgentTurn(deps, { job, turn, say, conversationId });
}

/**
 * A message from a number that resolves to a household member who is not a parent.
 *
 * A caregiver gets M6's line. The legacy `extended`/`service` buckets get SILENCE: they
 * hold an empty content scope because we cannot say what they are entitled to, and
 * pointing them at a named parent ("that's one for Sam") is itself a small disclosure
 * to someone we cannot vouch for.
 */
function isOutsiderWeMayAnswer(role: FamilyRole | null): boolean {
  return role !== null && isCaregiverRole(role);
}

/**
 * The agent half. Two things it must never do: leave the parent with silence, or leave
 * them with an ack and nothing after it.
 *
 * The ack is raced against the turn rather than scheduled after it, so a fast turn
 * sends exactly one message and a slow one sends "on it" while the work continues. The
 * timer is always cancelled — a stray ack arriving after the answer would read as Hale
 * starting over.
 */
async function runAgentTurn(
  deps: ChannelRouterDeps,
  args: {
    job: ChannelMessageReceivedJob;
    turn: HandlerContext;
    say: (body: string) => Promise<void>;
    conversationId: string;
  },
): Promise<RouterResult> {
  const timer = deps.ackTimer(ACK_AFTER_MS);
  const pending = deps.coach.respond(args.turn);
  // Settled either way: the race only asks "is this taking a while", and a REJECTED
  // turn is not slow — it is finished, and the failure line below is its answer.
  const settled = pending.then(
    () => 'settled' as const,
    () => 'settled' as const,
  );

  try {
    const first = await Promise.race([settled, timer.elapsed.then(() => 'slow' as const)]);
    if (first === 'slow') await args.say(ACK_REPLY);
  } finally {
    timer.cancel();
  }

  try {
    const { reply } = await pending;
    await args.say(reply);
    return done(deps, args.job, {
      status: 'agent_replied',
      handler: null,
      conversationId: args.conversationId,
      lane: null,
    });
  } catch (err) {
    // A turn can break AFTER its drafts landed, and those are real rows the parent can
    // approve. Saying "nothing was changed" would be false AND would orphan them — see
    // coach-runtime.ts (VIL-260).
    const drafted = draftsFromFailure(err);
    // The error object may carry a provider payload, so only its class and message are
    // kept — never the turn body (rule #1).
    deps.log.error(
      {
        channelMessageId: args.job.channel_message_id,
        err: err instanceof Error ? err.message : 'unknown',
        draftedThisTurn: drafted.length,
      },
      'channel router: agent turn failed',
    );
    await args.say(drafted.length > 0 ? partialFailureReply(drafted.length) : failureReply());
    return done(deps, args.job, {
      status: 'agent_failed',
      handler: null,
      conversationId: args.conversationId,
      lane: null,
    });
  }
}

/**
 * Send one reply and record it three ways: the transport, the delivery ledger, and the
 * thread.
 *
 * The ledger row carries NO body. The reply's text lives in `messages`, which is what
 * the app renders and what the next turn reads back; copying it into channel_messages
 * would put a second copy of household detail in a table that exists to track delivery
 * (the M6 / loop-ledger discipline, rule #1).
 *
 * `conversationId` is null for the one reply that belongs to no thread — the caregiver
 * line. It still gets its ledger and audit rows, because rule #6 is about the ACT of
 * texting someone, not about which thread it landed in; it simply gets no `messages`
 * row, which is what keeps it out of the parents' history.
 *
 * Ordering: send first, then record. A recorded message that never went out would make
 * the thread lie to the parent about what Hale said; a sent message whose ledger row
 * failed is visible as a provider row we can reconcile. The audit row (rule #6) is
 * written with the ledger row it describes.
 */
async function sendReply(
  deps: ChannelRouterDeps,
  args: {
    to: string;
    body: string;
    job: ChannelMessageReceivedJob;
    conversationId: string | null;
  },
): Promise<void> {
  const { providerMessageId } = await deps.transport.send({ to: args.to, body: args.body });

  const [row] = await deps.database
    .insert(schema.channelMessages)
    .values({
      familyId: args.job.family_id,
      parentUserId: args.job.parent_user_id,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      providerMessageId,
      status: 'sent',
      body: null,
      relatedConversationId: args.conversationId,
      sentAt: deps.now(),
    })
    .returning({ id: schema.channelMessages.id });
  const channelMessageId = row?.id;
  if (!channelMessageId) {
    throw new Error('channel router: channel_messages insert returned no row');
  }

  await deps.database.insert(schema.auditLog).values({
    familyId: args.job.family_id,
    actor: args.job.parent_user_id,
    actionTaken: 'sms_reply_sent',
    targetTable: 'channel_messages',
    targetId: channelMessageId,
  });

  if (args.conversationId) {
    await appendMessage(args.conversationId, 'assistant', args.body, deps.database);
  }
}

/** One structured line per routed message: ids and outcome enums, never a body. The
 * lane rides along because a deflection is the one outcome where Hale said no, and how
 * often it does that is the number X1 reports weekly. */
function done(
  deps: ChannelRouterDeps,
  job: ChannelMessageReceivedJob,
  result: RouterResult,
): RouterResult {
  deps.log.info(
    {
      channelMessageId: job.channel_message_id,
      status: result.status,
      handler: result.handler,
      lane: result.lane,
    },
    'channel router: routed',
  );
  return result;
}
