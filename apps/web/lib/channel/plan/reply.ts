import { type Database, schema } from '@hale/db';
import { type FamilyStage, ageInMonths, deriveStage } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import { readAffirmative } from '~/lib/channel/affirmative';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { dedupeActive } from '~/lib/channel/ledger';
import { createTwilioTransport } from '~/lib/channel/twilio/transport';
import { frameworkGuidanceTool } from '~/lib/coach/framework-tool';
import { appendMessage, loadTranscript } from '~/lib/coach/conversation';
import { fulfillCommitment, loadOpenCommitment, recordCommitment } from '~/lib/commitments/ledger';
import { SAFETY_REPLY } from '~/lib/channel/off-domain/copy';
import { pipelineClient } from '~/lib/pipeline/client';
import { type PlanComposer, type PlanGrounding, createPlanComposer } from './compose';
import {
  PLAN_CHECK_IN_DAYS,
  type PlanTopic,
  isPlanTopic,
  planCheckInSummary,
  planFallbackQuestion,
} from './topics';

/**
 * THE YES — step two, and the only handler in the router chain that sends for itself.
 *
 * A parent was offered the complete plan and answered with one word. What they get back
 * is two or three ordered messages, which is why this cannot use the router's one-body
 * `reply` contract: a plan folded into a single text is exactly the amputation the
 * offer promised to undo.
 *
 * THE CLAIM IS DETERMINISTIC, the work after it is not. Claiming costs a vocabulary
 * check and — only if that passes — one indexed query for an open offer. Everything
 * expensive happens after the turn is already ours. That is the same shape the health
 * handler has (its "yes" runs the whole drafter/reviewer chain), and it is what keeps a
 * model out of the decision about what a parent's word MEANT.
 *
 * WHY THE OFFER MUST BE FRESH. A bare affirmative has several possible owners, and its
 * claim on this one expires: a parent typing "yes" a week after an unanswered offer is
 * answering something else, and a stale claim would send them a sleep plan instead of
 * reading what they actually said. Past the TTL this declines and the turn falls
 * through to the coach, which can read the message properly.
 *
 * CONVERGENT, NOT TRANSACTIONAL, like the intro sweep: every message carries its own
 * dedupe key, so a re-drained job re-sends only what did not land. The ledger closure
 * happens LAST, against the first message that actually went — a plan that half-sent
 * and then died is picked up rather than counted as kept.
 */

/** How many things Hale already knows may be shown to the composer. A handful: this
 * stage writes advice, and a wall of household facts would drown the question. */
const MAX_PLAN_FACTS = 5;

/**
 * The honest line when the plan could not be composed.
 *
 * It keeps the offer OPEN and says the word that retries it, because the alternative is
 * a parent who said yes, got an apology, and has no way back to the thing they asked
 * for. No app, no link, no errand beyond the one word they already typed.
 */
export const PLAN_UNAVAILABLE_REPLY =
  "I couldn't put that plan together just now. Reply YES again in a minute and I'll have it.";

export type PlanReplyOutcome =
  | { status: 'declined_to_claim' }
  /** Sent, closed, and the three-day check-in is on the ledger. */
  | { status: 'plan_sent'; sent: number }
  /** Composed nothing sendable. The offer stays open so a second YES retries it. */
  | { status: 'plan_unavailable'; reply: string }
  /** The plan reached for a phone number on a guidance topic — the reviewed line goes
   * instead, and the offer is left open rather than marked kept by a message that was
   * never the plan. */
  | { status: 'safety'; reply: string }
  /** Claimed, but nothing reached the parent. Named rather than folded into
   * `plan_unavailable` (rule #11): that one means Hale had nothing to say, this one
   * means it had a plan and the wire ate it, and only the second is a provider page. */
  | { status: 'not_delivered' };

/** One outbound plan message, as the ledger needs it. */
export interface PlanSendWrite {
  familyId: string;
  parentUserId: string;
  templateKey: string;
  dedupeKey: string;
  providerMessageId: string;
  relatedConversationId: string;
  sentAt: Date;
}

/** The child a plan is written about, resolved to the two things the composer needs. */
export interface PlanChild {
  ageMonths: number;
  stage: FamilyStage;
}

export interface PlanReplyDeps {
  loadOpenOffer: typeof loadOpenCommitment;
  /** The question the parent originally asked, read back off their own thread. */
  loadQuestion(database: Database, conversationId: string, current: string): Promise<string | null>;
  loadChild(database: Database, familyId: string, childId: string): Promise<PlanChild | null>;
  /** The Child Development & Wellbeing Companion for an age — the SAME tool the coach
   * calls, so the plan is grounded in the content the answer was grounded in. */
  loadGuidance(child: PlanChild | null, topic: PlanTopic): Promise<unknown>;
  loadFacts(database: Database, familyId: string): Promise<string[]>;
  composer: PlanComposer;
  /** REQUIRED (rule #11). A handler that can compose a plan and quietly fail to send it
   * is the worst version of this feature: the offer closes, the check-in is minted, and
   * the parent who said yes never hears anything. */
  transport: ChannelTransport;
  dedupeActive: typeof dedupeActive;
  /** Insert the outbound row and hand back its id. Its own writer rather than the
   * loop's `recordChannelMessage`, whose `LoopCategory` deliberately excludes 'reply' —
   * a plan is an answer to a text, so no loop policy or budget applies to it. */
  recordSend(database: Database, write: PlanSendWrite): Promise<string>;
  audit(database: Database, row: Record<string, unknown>): Promise<void>;
  appendMessage: typeof appendMessage;
  fulfillCommitment: typeof fulfillCommitment;
  recordCommitment: typeof recordCommitment;
}

export async function handlePlanYes(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    conversationId: string;
    body: string;
    phoneE164: string;
    now: Date;
  },
  deps: PlanReplyDeps,
): Promise<PlanReplyOutcome> {
  // Checked before any query: most inbound traffic is not a bare affirmative, and an
  // ordinary message must not cost this handler a round trip.
  if (readAffirmative(input.body) !== 'yes') return { status: 'declined_to_claim' };

  const offer = await deps.loadOpenOffer(database, input.familyId, 'plan_offer');
  if (!offer || offer.dueAt.getTime() < input.now.getTime()) {
    return { status: 'declined_to_claim' };
  }
  // A topic this build no longer knows cannot select a plan or a check-in sentence.
  // Declining hands the turn to the coach, which will read the message properly —
  // strictly better than grounding a plan on a guess.
  if (!isPlanTopic(offer.topic)) {
    console.error(
      { familyId: input.familyId, topic: offer.topic },
      'coach plan: open offer carries an unknown topic - declined, the coach will take the turn',
    );
    return { status: 'declined_to_claim' };
  }
  const topic = offer.topic;

  const child = offer.subjectChildId
    ? await deps.loadChild(database, input.familyId, offer.subjectChildId)
    : null;
  const [question, guidance, facts] = await Promise.all([
    deps.loadQuestion(database, input.conversationId, input.body),
    deps.loadGuidance(child, topic),
    deps.loadFacts(database, input.familyId),
  ]);

  const grounding: PlanGrounding = {
    topic,
    // The thread is the only place the parent's own words live, and a compacted or
    // deleted thread can lose them. The topic's generic question is a worse brief and an
    // honest one — logged, because a plan written from the category alone is a plan
    // that could not be aimed.
    question: question ?? namedFallbackQuestion(input.familyId, topic),
    child,
    guidance,
    facts: facts.slice(0, MAX_PLAN_FACTS),
  };

  const composed = await deps.composer.compose(grounding);
  if (composed.status === 'safety') {
    return { status: 'safety', reply: SAFETY_REPLY };
  }
  if (composed.status === 'unavailable') {
    return { status: 'plan_unavailable', reply: PLAN_UNAVAILABLE_REPLY };
  }

  const sentIds = await sendInOrder(database, deps, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    conversationId: input.conversationId,
    phoneE164: input.phoneE164,
    commitmentId: offer.id,
    topic,
    messages: composed.messages,
    now: input.now,
  });
  const first = sentIds[0];
  const last = sentIds[sentIds.length - 1];
  if (first === undefined || last === undefined) {
    console.error(
      { familyId: input.familyId, topic },
      'coach plan: composed a plan and delivered none of it - offer left open',
    );
    return { status: 'not_delivered' };
  }

  // Kept by the FIRST message, because that is the one that made good on "reply YES and
  // I'll send it"; owed a check-in by the LAST, because the promise to come back is the
  // one the end of the plan makes.
  await deps.fulfillCommitment(database, {
    familyId: input.familyId,
    kind: 'plan_offer',
    channelMessageId: first,
    now: input.now,
  });
  await deps.recordCommitment(database, {
    familyId: input.familyId,
    kind: 'plan_check_in',
    summary: planCheckInSummary(topic),
    topic,
    subjectChildId: offer.subjectChildId,
    dueAt: new Date(input.now.getTime() + PLAN_CHECK_IN_DAYS * 24 * 3_600_000),
    channelMessageId: last,
  });

  return { status: 'plan_sent', sent: sentIds.length };
}

function namedFallbackQuestion(familyId: string, topic: PlanTopic): string {
  console.error(
    { familyId, topic },
    'coach plan: the thread no longer holds the question - grounding on the topic alone',
  );
  return planFallbackQuestion(topic);
}

/**
 * Send the plan, in order, one message at a time.
 *
 * SEQUENTIAL AWAITS, not `Promise.all`: the order Hale hands messages to the provider is
 * the only part of arrival order it controls, and firing three concurrently would give
 * up even that. What it cannot promise is arrival order — carriers do not guarantee it
 * across separate messages — which is why the skill labels every stage with its own
 * timeframe ("Nights 1-3", "Week 1"). A plan that reads correctly out of order is the
 * real fix; sending in order is the cheap half.
 *
 * EACH MESSAGE HAS ITS OWN DEDUPE KEY, keyed on the commitment plus its index. That is
 * what makes a re-drained job converge: it re-sends only the messages that never landed,
 * rather than the whole plan or nothing.
 *
 * A FAILED SEND STOPS THE PLAN. Continuing would deliver stage 3 to a parent who never
 * got stage 2, and the dedupe keys mean the next attempt resumes exactly where this one
 * stopped.
 */
async function sendInOrder(
  database: Database,
  deps: PlanReplyDeps,
  args: {
    familyId: string;
    parentUserId: string;
    conversationId: string;
    phoneE164: string;
    commitmentId: string;
    topic: PlanTopic;
    messages: readonly string[];
    now: Date;
  },
): Promise<string[]> {
  const sent: string[] = [];
  for (const [index, body] of args.messages.entries()) {
    const dedupeKey = `coach_plan:${args.commitmentId}:${index}`;
    if (await deps.dedupeActive(dedupeKey, database)) continue;

    const { providerMessageId } = await deps.transport.send({ to: args.phoneE164, body });
    const channelMessageId = await deps.recordSend(database, {
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      templateKey: `coach_plan:${args.topic}`,
      dedupeKey,
      providerMessageId,
      relatedConversationId: args.conversationId,
      sentAt: args.now,
    });
    await deps.audit(database, {
      familyId: args.familyId,
      actor: args.parentUserId,
      actionTaken: 'coach_plan_message_sent',
      targetTable: 'channel_messages',
      targetId: channelMessageId,
      // Enum-shaped provenance only, never the rendered body (rule #1).
      after: { topic: args.topic, index },
    });
    // The thread carries what was actually SENT, the same discipline the router keeps —
    // so the next coach turn reads the plan back the way the parent saw it.
    await deps.appendMessage(args.conversationId, 'assistant', body, database);
    sent.push(channelMessageId);
  }
  return sent;
}

// ── prod wiring ──────────────────────────────────────────────────────────────

/**
 * The parent's own question, read back off their thread.
 *
 * The LAST user turn that is not the affirmative being handled right now. The router
 * has already appended the YES, so a naive "last user message" would hand the composer
 * the word "yes" as the brief.
 */
export async function loadPlanQuestion(
  database: Database,
  conversationId: string,
  current: string,
): Promise<string | null> {
  const transcript = await loadTranscript(conversationId, database);
  const userTurns = transcript.filter((turn) => turn.role === 'user');
  for (let i = userTurns.length - 1; i >= 0; i -= 1) {
    const content = userTurns[i]?.content?.trim();
    if (content && content !== current.trim()) return content;
  }
  return null;
}

/** The child the offer named, aged at read time. Family-scoped: an id from another
 * household resolves to null and the plan is written for the house (rule #1). */
export async function loadPlanChild(
  database: Database,
  familyId: string,
  childId: string,
): Promise<PlanChild | null> {
  const [row] = await database
    .select({ dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(and(eq(schema.children.id, childId), eq(schema.children.familyId, familyId)))
    .limit(1);
  if (!row) return null;
  return { ageMonths: ageInMonths(row.dateOfBirth), stage: deriveStage(row.dateOfBirth) };
}

/**
 * The companion content, through the REAL tool the coach calls.
 *
 * Not a second reader of the same content: the answer the parent already has was
 * grounded in `get_framework_guidance`, and a plan grounded in anything else would
 * quietly contradict it. With no child named it answers for the stage's midpoint, which
 * is what the tool does for the coach too.
 */
export async function loadPlanGuidance(child: PlanChild | null): Promise<unknown> {
  const tool = frameworkGuidanceTool();
  return tool.handler(
    child ? { stage: child.stage, ageMonths: child.ageMonths } : { stage: 'toddler' },
    { familyId: 'plan-composer', actor: 'system' },
  );
}

/**
 * A few things Hale already knows about this household, as plain sentences.
 *
 * Teen-scoped facts are excluded at the QUERY, not filtered after: this stage never
 * needs one, and the cheapest way to keep a 13-year-old's detail out of a composed plan
 * is never to load it (rule #1).
 */
export async function loadPlanFacts(database: Database, familyId: string): Promise<string[]> {
  const rows = await database
    .select({ factValue: schema.familyMemoryFacts.factValue })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        eq(schema.familyMemoryFacts.factType, 'preference'),
      ),
    )
    .limit(MAX_PLAN_FACTS);
  return rows
    .map((row) => {
      const value = row.factValue as { summary?: unknown } | null;
      return typeof value?.summary === 'string' ? value.summary : null;
    })
    .filter((summary): summary is string => summary !== null);
}

/**
 * The outbound row for one plan message.
 *
 * `category: 'reply'` because a plan answers a message the parent sent — the outbound
 * gate's proactive budgets have nothing to say about it, and only the check-in three
 * days later is unprompted. The `dedupeKey` is what makes the send loop convergent.
 */
export async function recordPlanSend(
  database: Database,
  write: PlanSendWrite,
): Promise<string> {
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: write.familyId,
      parentUserId: write.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      templateKey: write.templateKey,
      dedupeKey: write.dedupeKey,
      providerMessageId: write.providerMessageId,
      status: 'sent',
      relatedConversationId: write.relatedConversationId,
      sentAt: write.sentAt,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('coach plan: channel_messages insert returned no row');
  return row.id;
}

export function defaultPlanReplyDeps(): PlanReplyDeps {
  return {
    loadOpenOffer: loadOpenCommitment,
    loadQuestion: loadPlanQuestion,
    loadChild: loadPlanChild,
    loadGuidance: (child) => loadPlanGuidance(child),
    loadFacts: loadPlanFacts,
    // The repo's shared lazy resolver, not a fourth private copy of it: it caches one
    // instance and throws on a missing key, which is what buys the composer's honest
    // `client_unavailable` outcome instead of a route that dies at wiring time.
    composer: createPlanComposer(pipelineClient),
    transport: createTwilioTransport(),
    dedupeActive,
    recordSend: recordPlanSend,
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row as never);
    },
    appendMessage,
    fulfillCommitment,
    recordCommitment,
  };
}
