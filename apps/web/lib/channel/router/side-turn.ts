import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { loadCoachTimeZone } from '~/lib/channel/coach/local-day';
import { familyLocalNow } from '~/lib/channel/coach/local-now';
import { plainText, redactTeenNames } from '~/lib/channel/coach/reply';
import type { ChannelMessageReceivedJob } from '~/lib/channel/inbound-route';
import { linqMessageEditEnabled } from '~/lib/channel/linq/edit';
import { familySpeechLanguage } from '~/lib/channel/linq/family-outbound';
import { SEND_TIMEOUT_MS } from '~/lib/channel/linq/transport';
import type { PendingAsk } from '~/lib/channel/off-domain/answer-request';
import type { ReplySource } from '~/lib/channel/off-domain/lane';
import type { MedicalReplySource } from '~/lib/channel/off-domain/medical';
import { observeParentLanguage } from '~/lib/channel/parent-language';
import { extractStateClaims } from '~/lib/channel/reconcile/claims';
import { isParentRole } from '~/lib/channel/role-scope';
import { loadAgentContext } from '~/lib/coach/context';
import { appendMessage, loadTranscript, resolveNoteConversation } from '~/lib/coach/conversation';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { noteCrisisReplySent, pageOps } from '~/lib/monitoring/failure-page';
import {
  BURST_MAX_MEMBERS,
  BURST_QUIET_MS,
  type BurstMember,
  type BurstPlan,
  pendingBurst,
} from './burst';
import { DeadlineError, turnRemainingMs, turnSignalAborted, withTimeout } from './deadline';
import { AGENT_TURN_LIMIT, AGENT_TURN_ROUTE } from './flood';
import type { ReplyRoute } from './reply-route';
import type { ChannelRouterDeps } from './route';
import type { SideTurnFamily, SideTurnReader } from './side-turn-reader';
import { type AnswerClaimOutcome, SIDE_TURN_TEMPLATE_KEY } from './turn-ledger';
import { pageUnwrittenCrisis } from './unwritten-moment';

/**
 * A QUICK QUESTION WHILE THE LAST ANSWER IS STILL COMING (phase 2 of back-to-back texts).
 *
 * One parent's turns run one at a time (the per-parent queue key), so a parent who asks
 * "what time is swim?" while Hale is 40 seconds into a search waits for the search. While
 * a turn runs, it now watches for a text that lands behind it. When exactly one does, and
 * it is quiet, it is read as a SIDE TURN: a quick question that stands on its own is
 * answered now, threaded under its own text; anything else is handed back and waits its
 * turn exactly as today.
 *
 * NOT A FOLD INTO THE RUNNING TURN. Every gate of that turn has already read its own
 * words, and its tool writes have already committed (burst.ts). The side turn runs the
 * gates on the new text itself, in the router's order:
 *
 *   the door's opt-out reader   before the text is queued at all (inbound-route.ts), so a
 *                               STOP never reaches a turn of any kind;
 *   the resolver's place        while Hale holds a question a handler acts on, every text
 *                               goes back: a bare "yes" names no question, so whether it
 *                               answers one is the resolver's read, in its own turn;
 *   the handlers' place         every deterministic handler's own matcher, run without
 *                               acting: a text one would take goes back to it, so a
 *                               "forget" or a disconnect is done, never only answered;
 *   the side read               hands back anything else that answers or decides something
 *                               Hale asked, needs a change, or is about the running turn;
 *   flood control               the same budget and the same first-refusal line;
 *   the off-domain lane         the same lane, crisis and medical answers among it;
 *   the answer                  the side read's own words, for a fact it can see, and
 *                               only when they claim no row (reconcile/claims.ts): a
 *                               claim is the claim gate's to cite, in its own turn.
 *
 * READ-ONLY. No tool, no draft, no offer, no consent, no reminder, and the questions Hale
 * left open stay open. What it writes is what any answer writes: the parent's row and the
 * reply in the thread, the reply's ledger and audit rows, the answer claim, the question
 * its own answer leaves open, and the parent's language.
 *
 * NEVER DROPPED, NEVER TWICE. Every side turn ends in exactly one
 * {@link SideTurnOutcome}. The answer claim, the arbiter the text's own job reads at
 * GATE 0, is taken BEFORE the reply is sent, with the parent's row in the thread.
 * Answered: the reply went under the claim, and its answered row stops that job. Queued:
 * nothing went, and that job answers the text after the running turn as it always has,
 * with the claim given back when it had been taken. The claim is a lease
 * ({@link SIDE_TURN_CLAIM_LEASE_MS}): one this turn could neither answer nor give back,
 * because it died or its release failed, lapses, and that job answers the text then.
 *
 * ONE AT A TIME. The running turn holds the parent's key, so it is the only place a side
 * turn can start, and it runs them in sequence. Two or more texts waiting is a burst, and
 * a burst is the queued turn's to read together. The running turn's job does not end
 * until a side turn in flight has, so the text cannot also start its own turn meanwhile.
 *
 * 1:1 iMessage only: the reply has to thread under its own text, and a group is read by
 * others.
 */

/** How often a running turn looks for a text that landed behind it. */
export const SIDE_TURN_POLL_MS = 1_000;

/**
 * The most a side turn spends deciding. One starts only while the running turn has at
 * least this long before its deadline, so it never outlives that turn's queue expiry.
 */
export const SIDE_TURN_BUDGET_MS = 45_000;

/** How much of the end of the thread the side read sees. */
export const SIDE_TURN_THREAD_ROWS = 12;

/** Every side reply carries it, the flood line's included (turn-ledger.ts). */
export { SIDE_TURN_TEMPLATE_KEY };

/** The deferred-row reason for a side reply that was threaded and then not sent. DATA. */
export const SIDE_TURN_UNSENT = 'side_turn_unsent';

/** The deferred-row reason for a side claim whose lease lapsed with no answer. DATA. */
export const SIDE_TURN_LAPSED = 'side_turn_lapsed';

/**
 * How long a side reply's claim holds with no answered row behind it (turn-ledger.ts
 * `held`, then `lapsed`). Longer than the claim can stay unanswered while its side turn
 * lives: between the claim and its answered row is one reply's send, at most two Linq
 * calls (threaded, then plain when the thread is refused) of two attempts each, every
 * attempt bounded by SEND_TIMEOUT_MS, and one more for the writes on either side.
 */
export const SIDE_TURN_CLAIM_LEASE_MS = 5 * SEND_TIMEOUT_MS;

const SIDE_TURN_TIMEOUT = 'side_turn_timeout';

/** Why a text was left for its own turn. Each one is that turn's to answer, as today. */
export type SideTurnQueuedWhy =
  | 'unknown_message'
  | 'not_a_parent'
  | 'unreachable'
  /** Not a 1:1 iMessage chat whose reply threads under the text. */
  | 'not_threaded'
  /** A photo, a video or a file is the full turn's to read. */
  | 'has_media'
  | 'no_thread'
  /** A deterministic handler's own matcher takes it: that handler acts on it in its own
   * turn (GATE 2b). */
  | 'handler_takes'
  /** Hale holds a question a handler acts on the answer to. Whether this text is that
   * answer is the resolver's read, in its own turn. */
  | 'question_open'
  /** The side read said it belongs to its own turn. */
  | 'handed_back'
  | 'reader_unavailable'
  /** Over the parent's hourly budget: their own turn says so, once. */
  | 'over_limit'
  /** The answer claim was not taken: its write failed, or a claim is already held.
   * Nothing was written and nothing sent. */
  | 'unclaimed'
  | 'moment_unwritten'
  /** A question for the family's own facts that the side read had no words for. */
  | 'no_answer'
  /** The side read's words say a row exists (a booking, a watch, a follow-up): the claim
   * gate cites one or cuts it, in its own turn. */
  | 'makes_a_claim'
  | 'timeout'
  /** The running turn's deadline passed before anything was written. */
  | 'turn_over'
  /** Claimed and threaded, and the send failed: the claim is given back as a deferred
   * row, so its own turn answers it without threading or counting it again. */
  | 'send_failed'
  /** Claimed and threaded, the send failed, and the claim could not be given back. #ops
   * is paged; its own turn answers it once the claim's lease lapses. */
  | 'release_failed';

export type SideTurnOutcome =
  | { kind: 'answered'; by: 'side_read' | 'off_domain' | 'flood_line' }
  | { kind: 'queued'; why: SideTurnQueuedWhy };

export interface SideTurnPorts {
  /** INBOUND_MIDTURN_ENABLED, or the family allowlist. */
  enabled(familyId: string): boolean;
  /** Non-nullable (rule #11): a reader that cannot run says so in its reading. */
  reader: SideTurnReader;
  /** What the side read is told about the family and the thread. */
  family(input: {
    familyId: string;
    parentUserId: string;
    conversationId: string;
    now: Date;
  }): Promise<SideTurnFamily>;
  sleep(ms: number): Promise<void>;
  /** Test seam. Production uses {@link SIDE_TURN_BUDGET_MS}. */
  budgetMs?: number;
}

/** One side reply, handed to the router's own send. The router closes no open question on
 * it (route.ts): a side turn never closes one, and keeps the one its own answer leaves. */
export interface SideReply {
  route: ReplyRoute;
  body: string;
  job: ChannelMessageReceivedJob;
  conversationId: string;
  /** Once the transport took the reply: the answered row, under the claim already held. */
  claim: () => Promise<void>;
  templateKey: typeof SIDE_TURN_TEMPLATE_KEY;
  medicalSource: MedicalReplySource | null;
  replySource: ReplySource | null;
  /** The question an off-domain answer left open, as the lane said it. */
  pendingAsk: PendingAsk | null;
  onSent?: () => Promise<unknown>;
}

export interface SideTurnWatch {
  /** Stop looking, and wait for a side turn in flight. */
  stop(): Promise<void>;
}

const INERT: SideTurnWatch = { stop: async () => undefined };

interface SendPlan {
  kind: 'send';
  by: Extract<SideTurnOutcome, { kind: 'answered' }>['by'];
  body: string;
  medicalSource: MedicalReplySource | null;
  replySource: ReplySource | null;
  pendingAsk: PendingAsk | null;
  /** The screen's language tags for the text, when it read one. */
  language: { seen: string | null; requested: string | null } | null;
  crisis: boolean;
}

type Queued = Extract<SideTurnOutcome, { kind: 'queued' }>;

const queued = (why: SideTurnQueuedWhy): Queued => ({ kind: 'queued', why });

/**
 * Watch for texts behind a running 1:1 turn, from the moment its burst plan is decided.
 * Dark, or a turn that is not 1:1, returns before any read, timer or write.
 */
export function watchSideTurns(
  deps: ChannelRouterDeps,
  running: ChannelMessageReceivedJob,
  plan: BurstPlan,
  send: (reply: SideReply) => Promise<string>,
): SideTurnWatch {
  if (running.in_group !== false || !deps.sideTurn.enabled(running.family_id)) return INERT;

  let stopped = false;
  let wake = () => {};
  const stopping = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const anchor = {
    familyId: running.family_id,
    parentUserId: running.parent_user_id,
    channelMessageId: running.channel_message_id,
  };
  const considered = new Set<string>();

  const watching = (async () => {
    for (;;) {
      await Promise.race([deps.sideTurn.sleep(SIDE_TURN_POLL_MS), stopping]);
      if (stopped) return;
      const left = turnRemainingMs();
      if (left !== undefined && left < (deps.sideTurn.budgetMs ?? SIDE_TURN_BUDGET_MS)) return;
      const [head, ...waiting] = await pendingBurst(deps.database, anchor, BURST_MAX_MEMBERS);
      const [candidate, ...more] = waiting;
      if (!head || !candidate || more.length > 0) continue;
      if (considered.has(candidate.channelMessageId)) continue;
      if (deps.now().getTime() - candidate.createdAt.getTime() < BURST_QUIET_MS) continue;
      // A stop that landed while it looked: the running turn is over.
      if (stopped) return;
      considered.add(candidate.channelMessageId);
      const outcome = await runSideTurn(
        deps,
        {
          running,
          candidate,
          workingOn: plan.kind === 'anchor' ? plan.members.map((m) => m.body) : [head.body],
        },
        send,
      );
      deps.log.info(
        {
          runningId: running.channel_message_id,
          channelMessageId: candidate.channelMessageId,
          outcome: outcome.kind,
          ...(outcome.kind === 'answered' ? { by: outcome.by } : { why: outcome.why }),
        },
        'side turn: settled',
      );
    }
  })().catch((err: unknown) => {
    // The running turn never fails for a side turn. What became of the text, waiting its
    // turn, answered, or held until its claim lapses, is the ledger's to say.
    deps.log.error(
      {
        runningId: running.channel_message_id,
        err: err instanceof Error ? err.name : 'unknown',
      },
      'side turn: watch stopped on an error',
    );
  });

  return {
    async stop() {
      stopped = true;
      wake();
      await watching;
    },
  };
}

/** One text, read on its own while the turn in front of it runs. */
export async function runSideTurn(
  deps: ChannelRouterDeps,
  input: {
    running: ChannelMessageReceivedJob;
    candidate: BurstMember;
    workingOn: readonly string[];
  },
  send: (reply: SideReply) => Promise<string>,
): Promise<SideTurnOutcome> {
  const { running, candidate } = input;
  // No provider id, nothing to thread the reply under.
  if (candidate.providerMessageId === null) return queued('not_threaded');
  const job: ChannelMessageReceivedJob = {
    family_id: running.family_id,
    parent_user_id: running.parent_user_id,
    channel_message_id: candidate.channelMessageId,
    provider_message_id: candidate.providerMessageId,
    received_at: candidate.createdAt.toISOString(),
    in_group: false,
  };
  const context = await deps.loadContext(deps.database, job);
  if (!context) return queued('unknown_message');
  if (context.role === null || !isParentRole(context.role)) return queued('not_a_parent');
  const route = context.reply;
  if (!route) return queued('unreachable');
  if (
    context.inGroup ||
    route.channel !== 'imessage' ||
    route.service !== 'iMessage' ||
    route.replyToMessageId === null
  ) {
    return queued('not_threaded');
  }
  if ((context.media ?? []).length > 0) return queued('has_media');
  const conversationId = await resolveNoteConversation(
    job.family_id,
    channelSmsNoteKey(job.parent_user_id),
    deps.database,
  );
  if (!conversationId) return queued('no_thread');

  let decided: SendPlan | Queued;
  try {
    decided = await withTimeout(
      decide(deps, { job, route, conversationId, text: context.body, workingOn: input.workingOn }),
      deps.sideTurn.budgetMs ?? SIDE_TURN_BUDGET_MS,
      SIDE_TURN_TIMEOUT,
    );
  } catch (err) {
    if (err instanceof DeadlineError && err.reason === SIDE_TURN_TIMEOUT) return queued('timeout');
    throw err;
  }
  if (decided.kind === 'queued') return decided;
  return commit(deps, { job, route, conversationId, candidate, plan: decided }, send);
}

async function decide(
  deps: ChannelRouterDeps,
  input: {
    job: ChannelMessageReceivedJob;
    route: Extract<ReplyRoute, { channel: 'imessage' }>;
    conversationId: string;
    text: string;
    workingOn: readonly string[];
  },
): Promise<SendPlan | Queued> {
  const { job, route } = input;
  const now = deps.now();
  const [questions, family] = await Promise.all([
    deps.questions.open(deps.database, {
      familyId: job.family_id,
      parentUserId: job.parent_user_id,
      now,
      channelMessageId: job.channel_message_id,
    }),
    deps.sideTurn.family({
      familyId: job.family_id,
      parentUserId: job.parent_user_id,
      conversationId: input.conversationId,
      now,
    }),
  ]);

  // The resolver's place, before any model reads the text. The handlers behind these kinds
  // act only on what the resolver read, so no matcher below sees a bare "yes", "approve
  // it" or "oui, vas-y": while one of their questions stands, every text goes back.
  if (
    questions.some((question) =>
      deps.handlers.some((handler) => handler.resolves?.has(question.kind)),
    )
  ) {
    return queued('question_open');
  }

  // GATE 2b's place: what a handler would take is its.
  const detect = {
    familyId: job.family_id,
    parentUserId: job.parent_user_id,
    body: input.text,
    now,
    openQuestions: async () => questions,
    inboundChannelMessageId: job.channel_message_id,
  };
  for (const handler of deps.handlers) {
    if (await handler.detects(deps.database, detect)) return queued('handler_takes');
  }

  // The resolver's place: anything that answers, decides or changes goes back.
  const reading = await deps.sideTurn.reader.read({
    text: input.text,
    workingOn: input.workingOn,
    waitingOn: questions.map((question) => question.subject),
    family,
  });
  if (reading.status === 'unavailable') return queued('reader_unavailable');
  if (reading.verdict === 'hand_back') return queued('handed_back');

  // GATE 3's place, counted once for this text: its own turn will not count it again
  // unless the text goes back to it.
  const budget = await deps.limiter.check(job.parent_user_id, AGENT_TURN_ROUTE, AGENT_TURN_LIMIT);
  if (!budget.allowed) {
    if (!budget.firstDenied) return queued('over_limit');
    const composed = await deps.floodLine.compose({
      language: await familySpeechLanguage(deps.database, job.family_id),
      inGroup: false,
    });
    if (composed.status !== 'composed') return queued('over_limit');
    return {
      kind: 'send',
      by: 'flood_line',
      body: composed.line,
      medicalSource: null,
      replySource: null,
      pendingAsk: null,
      language: null,
      crisis: false,
    };
  }

  // GATE 4's place: the same lane, so a crisis or a symptom gets the same reply it would.
  const verdict = await deps.offDomain.consider({
    familyId: job.family_id,
    parentUserId: job.parent_user_id,
    channelMessageId: job.channel_message_id,
    text: input.text,
    now,
    thread: { channel: route.channel, providerChatId: route.chatId, inGroup: false },
  });
  if (verdict.status === 'unwritten') {
    deps.log.error(
      { familyId: job.family_id, moment: verdict.moment, reason: verdict.reason },
      'side turn: moment reply unwritten — the text goes back to its own turn',
    );
    // A crisis pages now, as GATE 4's does, not when the running turn ends.
    await pageUnwrittenCrisis(deps, job, verdict, 'side turn moment');
    return queued('moment_unwritten');
  }
  const language =
    typeof verdict.language === 'string' || typeof verdict.languageRequest === 'string'
      ? { seen: verdict.language ?? null, requested: verdict.languageRequest ?? null }
      : null;
  if (verdict.status === 'deflected') {
    return {
      kind: 'send',
      by: 'off_domain',
      body: verdict.reply,
      medicalSource: verdict.medicalSource,
      replySource: verdict.replySource,
      pendingAsk: verdict.pendingAsk,
      language,
      crisis: verdict.crisisReply === true,
    };
  }
  const words = await finished(deps.database, job.family_id, reading.reply, now);
  if (words === '') return queued('no_answer');
  if (extractStateClaims(words).length > 0) return queued('makes_a_claim');
  return {
    kind: 'send',
    by: 'side_read',
    body: words,
    medicalSource: null,
    replySource: null,
    pendingAsk: null,
    language,
    crisis: false,
  };
}

/** The side read's words finished as every coach reply is: plain text, and a teenager's
 * name never in it (rule #1, coach/reply.ts). */
async function finished(
  database: Database,
  familyId: string,
  reply: string,
  now: Date,
): Promise<string> {
  const children = await database
    .select({
      name: schema.children.name,
      gender: schema.children.gender,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return redactTeenNames(plainText(reply), children, now);
}

/**
 * Claim, then send. The text's answer claim and the parent's row in the thread commit
 * together before anything goes (turn-ledger.ts claimAhead). A claim that is not taken
 * sends nothing. A send that does not go gives the claim back, and the text's own job
 * answers it once. A write after the send that fails costs nothing more: the claim holds.
 */
async function commit(
  deps: ChannelRouterDeps,
  input: {
    job: ChannelMessageReceivedJob;
    route: Extract<ReplyRoute, { channel: 'imessage' }>;
    conversationId: string;
    candidate: BurstMember;
    plan: SendPlan;
  },
  send: (reply: SideReply) => Promise<string>,
): Promise<SideTurnOutcome> {
  const { job, plan } = input;
  if (turnSignalAborted()) return queued('turn_over');
  const text = {
    familyId: job.family_id,
    parentUserId: job.parent_user_id,
    channelMessageId: job.channel_message_id,
  };
  const providerMessageId = linqMessageEditEnabled() ? input.candidate.providerMessageId : null;
  let claim: AnswerClaimOutcome;
  try {
    claim = await deps.turns.claimAhead(text, (tx) =>
      appendMessage(input.conversationId, 'user', input.candidate.body, tx, {
        childId: null,
        topic: null,
        ...(providerMessageId ? { providerMessageId } : {}),
      }),
    );
  } catch (err) {
    deps.log.warn(
      {
        channelMessageId: job.channel_message_id,
        err: err instanceof Error ? err.name : 'unknown',
      },
      'side turn: the answer claim was not written — nothing sent, the text waits its turn',
    );
    return queued('unclaimed');
  }
  if (claim === 'already_answered') return queued('unclaimed');

  let accepted = false;
  try {
    await send({
      route: input.route,
      body: plan.body,
      job,
      conversationId: input.conversationId,
      claim: async () => {
        accepted = true;
        await deps.turns.recordAnsweredAhead(text);
      },
      templateKey: SIDE_TURN_TEMPLATE_KEY,
      medicalSource: plan.medicalSource,
      replySource: plan.replySource,
      pendingAsk: plan.pendingAsk,
      ...(plan.crisis
        ? { onSent: () => noteCrisisReplySent(deps.database, job.provider_message_id, deps.now()) }
        : {}),
    });
  } catch (err) {
    const code = err instanceof Error ? err.name : 'unknown';
    if (!accepted) {
      try {
        await deps.turns.releaseAhead({ ...text, reason: SIDE_TURN_UNSENT });
      } catch (releaseErr) {
        deps.log.error(
          {
            channelMessageId: job.channel_message_id,
            err: code,
            release: releaseErr instanceof Error ? releaseErr.name : 'unknown',
          },
          'side turn: not sent, and its claim was not given back — its own turn answers it once the claim lapses',
        );
        await pageOps(deps.database, {
          site: 'side_turn_claim_unreleased',
          facts: {},
          ref: job.channel_message_id,
        });
        return queued('release_failed');
      }
      deps.log.warn(
        { channelMessageId: job.channel_message_id, err: code },
        'side turn: not sent — the text goes back to its own turn',
      );
      return queued('send_failed');
    }
    deps.log.error(
      { channelMessageId: job.channel_message_id, err: code },
      'side turn: the reply landed; a receipt after it did not',
    );
  }
  if (plan.language) {
    const observed = await observeParentLanguage(deps.database, {
      familyId: job.family_id,
      parentUserId: job.parent_user_id,
      ...plan.language,
    });
    deps.log.info(
      { familyId: job.family_id, outcome: observed.status },
      'side turn: parent language',
    );
  }
  return { kind: 'answered', by: plan.by };
}

/**
 * The side read's view of the family, from the coach's own readers: the same children
 * (teenagers by stage only, rule #1), the same memory brief and the same thread, of which
 * it sees the end. An email's words in the thread are left out.
 */
export function productionSideTurnFamily(database: Database): SideTurnPorts['family'] {
  return async ({ familyId, parentUserId, conversationId, now }) => {
    const [transcript, timeZone] = await Promise.all([
      loadTranscript(conversationId, database),
      loadCoachTimeZone(database, familyId),
    ]);
    const context = await loadAgentContext(
      {
        familyId,
        question: '',
        intent: null,
        focusedChildId: null,
        transcript,
        sourceNote: null,
        readerUserId: parentUserId,
        inGroup: false,
      },
      database,
      now,
    );
    return {
      thread: context.transcript
        .flatMap((row) => (row.role === 'tool' ? [] : [{ role: row.role, content: row.content }]))
        .slice(-SIDE_TURN_THREAD_ROWS),
      children: context.children.map((child) => ({
        name: child.name,
        stage: child.stage,
        age:
          child.ageMonths === null
            ? null
            : { years: Math.floor(child.ageMonths / 12), months: child.ageMonths % 12 },
      })),
      city: context.location.city,
      memory: context.memoryBrief.text === '' ? null : context.memoryBrief.text,
      localNow: timeZone ? familyLocalNow(now, timeZone) : null,
    };
  };
}
