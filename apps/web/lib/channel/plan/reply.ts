import { type Database, schema } from '@hale/db';
import { type CoachingPlaybook, type FamilyStage, ageInMonths, deriveStage, playbookFor } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import { readAffirmative } from '~/lib/channel/affirmative';
import type { ReplySent } from '~/lib/channel/router/reply-route';
import { dedupeActive } from '~/lib/channel/ledger';
import { appendMessage, loadTranscript } from '~/lib/coach/conversation';
import {
  cancelCommitment,
  fulfillCommitment,
  loadOpenCommitment,
  recordCommitment,
} from '~/lib/commitments/ledger';
import { pipelineClient } from '~/lib/pipeline/client';
import { readFamilyTimezone } from '~/lib/dashboard/trail-query';
import { type PlanComposer, type PlanGrounding, createPlanComposer } from './compose';
import { type NoteComposer, createNoteComposer } from './note';
import {
  PLAN_CHECK_IN_DAY_CHOICES,
  type PlanCheckInDays,
  type PlanTopic,
  checkInWeekday,
  isPlanTopic,
  planCheckInSummary,
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

export type PlanReplyOutcome =
  | { status: 'declined_to_claim' }
  /** Sent, closed, and the check-in Hale promised is on the ledger. */
  | { status: 'plan_sent'; sent: number; checkInDays: PlanCheckInDays }
  /** The child is outside the method's age gate. The offer is VOIDED — it can no longer
   * be kept — and what went out is a composed refusal grounded on the playbook's own
   * words, never a plan. */
  | { status: 'age_gated'; sent: number }
  /** Claimed, but nothing reached the parent. Named rather than folded in with the
   * deferral (rule #11): a deferral means Hale had nothing sendable to say, this means
   * it had a plan and the wire ate it, and only the second is a provider page. */
  | { status: 'not_delivered' };

/**
 * The turn could not produce a sendable message and there is no canned one to fall back
 * on, so it DEFERS: thrown, caught by nothing here, and redriven by the drain.
 *
 * The offer stays open, which is what makes the redrive correct — the next attempt
 * re-claims the same YES and composes again, and a plan that lands late beats an
 * apology that lands on time. Typed so the router can tell it from a bug.
 */
export class PlanDeferred extends Error {
  readonly reason: string;

  constructor(reason: string, violations: readonly string[]) {
    super(`coach plan deferred: ${reason}${violations.length > 0 ? ` (${violations.join(' ')})` : ''}`);
    this.name = 'PlanDeferred';
    this.reason = reason;
  }
}

/**
 * The turn's way out, bound by the router to the channel this parent actually wrote in
 * on (router/reply-route.ts). A plan is the one answer Hale sends as several messages,
 * so this handler needs a sender rather than a body slot — but it gets the SENDER and
 * never a destination, which is what stops a plan being texted to someone who emailed.
 */
export type ReplySender = (body: string) => Promise<ReplySent>;

/** One outbound plan message, as the ledger needs it. */
export interface PlanSendWrite {
  familyId: string;
  parentUserId: string;
  /** Reported by the send that just happened, never assumed — a plan delivered by email
   * must not be filed as a text. */
  channel: ReplySent['channel'];
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
  loadFacts(database: Database, familyId: string): Promise<string[]>;
  /** The family's own clock, so the day Hale promises is the day they will live. */
  loadTimeZone(database: Database, familyId: string): Promise<string>;
  composer: PlanComposer;
  /** The one-line notes: the age-gate refusal here, the check-in in the sweep. */
  noteComposer: NoteComposer;
  dedupeActive: typeof dedupeActive;
  /** Insert the outbound row and hand back its id. Its own writer rather than the
   * loop's `recordChannelMessage`, whose `LoopCategory` deliberately excludes 'reply' —
   * a plan is an answer to a text, so no loop policy or budget applies to it. */
  recordSend(database: Database, write: PlanSendWrite): Promise<string>;
  audit(database: Database, row: Record<string, unknown>): Promise<void>;
  appendMessage: typeof appendMessage;
  fulfillCommitment: typeof fulfillCommitment;
  cancelCommitment: typeof cancelCommitment;
  recordCommitment: typeof recordCommitment;
}

export async function handlePlanYes(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    conversationId: string;
    body: string;
    send: ReplySender;
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

  const playbook = playbookFor(topic);
  const child = offer.subjectChildId
    ? await deps.loadChild(database, input.familyId, offer.subjectChildId)
    : null;

  // THE AGE GATE, IN CODE, BEFORE A MODEL IS ASKED FOR ANYTHING. A prompt cannot be
  // trusted with "never sleep train a baby under 6 months": the whole point of a gate is
  // that it holds on the run where the model would have said yes.
  //
  // It only fires on an age we actually KNOW. A plan whose offer named no child is
  // composed with no age and the playbook's own readiness signs in front of the model —
  // fabricating a refusal for an age nobody established would be its own kind of wrong.
  if (child !== null && outsideAgeGate(child.ageMonths, playbook)) {
    return sendAgeGateRefusal(database, deps, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      conversationId: input.conversationId,
      send: input.send,
      commitmentId: offer.id,
      topic,
      playbook,
      child,
      question: await deps.loadQuestion(database, input.conversationId, input.body),
      now: input.now,
    });
  }

  const [question, facts, timeZone] = await Promise.all([
    deps.loadQuestion(database, input.conversationId, input.body),
    deps.loadFacts(database, input.familyId),
    deps.loadTimeZone(database, input.familyId),
  ]);

  const grounding: PlanGrounding = {
    topic,
    // The thread is the only place the parent's own words live. A compacted or deleted
    // thread can lose them, and the method question ("how do we do this") is a worse
    // brief than the parent's own ("he wakes at 3am") — logged, because a plan written
    // from the category alone is a plan that could not be aimed.
    question: question ?? namedFallbackQuestion(input.familyId, topic, playbook),
    child,
    playbook,
    facts: facts.slice(0, MAX_PLAN_FACTS),
    checkInDayNames: weekdayChoices(input.now, timeZone),
  };

  const composed = await deps.composer.compose(grounding);
  if (composed.status === 'deferred') {
    // No canned apology. The offer stays open, the drain redrives the turn, and the
    // plan lands late rather than never.
    throw new PlanDeferred(composed.reason, composed.violations);
  }

  const sentIds = await sendInOrder(database, deps, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    conversationId: input.conversationId,
    send: input.send,
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

  // Kept by the FIRST message, because that is the one that made good on the offer;
  // owed a check-in by the LAST, because the promise to come back is the one the end of
  // the plan makes. `dueAt` derives from the SAME field the prose promised, so the day
  // Hale said and the day it returns cannot disagree.
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
    dueAt: new Date(input.now.getTime() + composed.checkInDays * 24 * 3_600_000),
    channelMessageId: last,
  });

  return { status: 'plan_sent', sent: sentIds.length, checkInDays: composed.checkInDays };
}

/** Whether this child is outside the method's verified bounds. */
export function outsideAgeGate(ageMonths: number, playbook: CoachingPlaybook): boolean {
  const { minMonths, maxMonths } = playbook.ageBound;
  return ageMonths < minMonths || (maxMonths !== null && ageMonths > maxMonths);
}

/** The weekday each allowed offset lands on, so the composer promises a day rather than
 * doing calendar arithmetic in its head. */
function weekdayChoices(now: Date, timeZone: string): Record<PlanCheckInDays, string> {
  const names = {} as Record<PlanCheckInDays, string>;
  for (const days of PLAN_CHECK_IN_DAY_CHOICES) {
    names[days] = checkInWeekday(now, days, timeZone);
  }
  return names;
}

/**
 * The child is too young (or too old) for this method, so what goes out is a composed
 * refusal grounded on the playbook's own verified words — never a plan, and never a
 * canned line either.
 *
 * The offer is VOIDED rather than fulfilled. The promise was a plan; a refusal does not
 * keep it, and marking it kept would put a false entry in the one ledger that says what
 * Hale actually did. Voiding also stops a second YES re-refusing forever.
 */
async function sendAgeGateRefusal(
  database: Database,
  deps: PlanReplyDeps,
  args: {
    familyId: string;
    parentUserId: string;
    conversationId: string;
    send: ReplySender;
    commitmentId: string;
    topic: PlanTopic;
    playbook: CoachingPlaybook;
    child: PlanChild;
    question: string | null;
    now: Date;
  },
): Promise<PlanReplyOutcome> {
  const composed = await deps.noteComposer.compose({
    kind: 'too_young',
    topic: args.topic,
    playbook: args.playbook,
    child: { ageMonths: args.child.ageMonths },
    question: args.question,
    promise: null,
  });
  if (composed.status === 'deferred') {
    throw new PlanDeferred(composed.reason, composed.violations);
  }

  const sent = await sendInOrder(database, deps, {
    familyId: args.familyId,
    parentUserId: args.parentUserId,
    conversationId: args.conversationId,
    send: args.send,
    commitmentId: args.commitmentId,
    topic: args.topic,
    messages: [composed.message],
    now: args.now,
  });
  if (sent.length === 0) return { status: 'not_delivered' };

  await deps.cancelCommitment(database, {
    familyId: args.familyId,
    kind: 'plan_offer',
    reason: 'plan_age_gated',
    now: args.now,
  });
  return { status: 'age_gated', sent: sent.length };
}

function namedFallbackQuestion(
  familyId: string,
  topic: PlanTopic,
  playbook: CoachingPlaybook,
): string {
  console.error(
    { familyId, topic },
    'coach plan: the thread no longer holds the question - grounding on the method alone',
  );
  return `How do we do ${playbook.primaryMethod.name}?`;
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
    send: ReplySender;
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

    const { providerMessageId, channel } = await args.send(body);
    const channelMessageId = await deps.recordSend(database, {
      familyId: args.familyId,
      parentUserId: args.parentUserId,
      channel,
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
      channel: write.channel,
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
    loadFacts: loadPlanFacts,
    loadTimeZone: (database, familyId) => readFamilyTimezone(database, familyId),
    // The repo's shared lazy resolver, not a private copy of it: it caches one instance
    // and throws on a missing key, which is what buys the composers' honest
    // `client_unavailable` outcome instead of a route that dies at wiring time.
    composer: createPlanComposer(pipelineClient),
    noteComposer: createNoteComposer(pipelineClient),
    dedupeActive,
    recordSend: recordPlanSend,
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row as never);
    },
    appendMessage,
    fulfillCommitment,
    cancelCommitment,
    recordCommitment,
  };
}
