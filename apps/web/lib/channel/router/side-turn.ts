import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { loadCoachTimeZone } from '~/lib/channel/coach/local-day';
import { familyLocalNow } from '~/lib/channel/coach/local-now';
import { plainText, redactTeenNames } from '~/lib/channel/coach/reply';
import type { ChannelMessageReceivedJob } from '~/lib/channel/inbound-route';
import { linqMessageEditEnabled } from '~/lib/channel/linq/edit';
import { familySpeechLanguage } from '~/lib/channel/linq/family-outbound';
import type { ReplySource } from '~/lib/channel/off-domain/lane';
import type { MedicalReplySource } from '~/lib/channel/off-domain/medical';
import { isParentRole } from '~/lib/channel/role-scope';
import { loadAgentContext } from '~/lib/coach/context';
import { appendMessage, loadTranscript, resolveNoteConversation } from '~/lib/coach/conversation';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { noteCrisisReplySent } from '~/lib/monitoring/failure-page';
import {
  BURST_MAX_MEMBERS,
  BURST_QUIET_MS,
  type BurstMember,
  type BurstPlan,
  pendingBurst,
} from './burst';
import { DeadlineError, turnRemainingMs, turnSignalAborted, withTimeout } from './deadline';
import { AGENT_TURN_LIMIT, AGENT_TURN_ROUTE } from './flood';
import { FLOOD_LINE_TEMPLATE_KEY } from './flood-line';
import type { ReplyRoute } from './reply-route';
import type { ChannelRouterDeps } from './route';
import type { SideTurnFamily, SideTurnReader } from './side-turn-reader';

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
 *   the resolver's place        the side read hands back anything that answers or decides
 *                               something Hale asked, needs a change, or is about the
 *                               running turn;
 *   flood control               the same budget and the same first-refusal line;
 *   the off-domain lane         the same lane, crisis and medical answers among it;
 *   the answer                  the side read's own words, for a fact it can see.
 *
 * READ-ONLY. No tool, no draft, no offer, no consent, no reminder, and the questions Hale
 * left open stay open. What it writes is what any answer writes: the parent's row and the
 * reply in the thread, the reply's ledger and audit rows, and the answer claim.
 *
 * NEVER DROPPED. Every side turn ends in exactly one {@link SideTurnOutcome}: answered,
 * and claimed through the same arbiter as every answer, so the text's own job stops at
 * GATE 0; or queued, and that job answers it after the running turn as it always has.
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

/** The ledger name on a side turn's reply (`channel_messages.template_key`). A DATA value. */
export const SIDE_TURN_TEMPLATE_KEY = 'side_turn';

/** The deferred-row reason for a side reply that was threaded and then not sent. DATA. */
export const SIDE_TURN_UNSENT = 'side_turn_unsent';

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
  /** The side read said it belongs to its own turn. */
  | 'handed_back'
  | 'reader_unavailable'
  /** Over the parent's hourly budget: their own turn says so, once. */
  | 'over_limit'
  | 'moment_unwritten'
  /** A question for the family's own facts that the side read had no words for. */
  | 'no_answer'
  | 'timeout'
  /** The running turn's deadline passed before anything was written. */
  | 'turn_over'
  /** Threaded, and the send failed: recorded as deferred, so its own turn neither
   * re-threads nor re-counts it. */
  | 'send_failed';

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

/** One side reply, handed to the router's own send. The router keeps every open question
 * untouched on it (route.ts), so a side turn can never close one. */
export interface SideReply {
  route: ReplyRoute;
  body: string;
  job: ChannelMessageReceivedJob;
  conversationId: string;
  claim: () => Promise<void>;
  templateKey: string;
  medicalSource: MedicalReplySource | null;
  replySource: ReplySource | null;
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
  templateKey: string;
  medicalSource: MedicalReplySource | null;
  replySource: ReplySource | null;
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
    // The running turn never fails for a side turn. The text waits its turn.
    deps.log.error(
      {
        runningId: running.channel_message_id,
        err: err instanceof Error ? err.name : 'unknown',
      },
      'side turn: watch stopped on an error — the text waits its turn',
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
      templateKey: FLOOD_LINE_TEMPLATE_KEY,
      medicalSource: null,
      replySource: null,
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
    return queued('moment_unwritten');
  }
  if (verdict.status === 'deflected') {
    return {
      kind: 'send',
      by: 'off_domain',
      body: verdict.reply,
      templateKey: SIDE_TURN_TEMPLATE_KEY,
      medicalSource: verdict.medicalSource,
      replySource: verdict.replySource,
      crisis: verdict.crisisReply === true,
    };
  }
  const words = await finished(deps.database, job.family_id, reading.reply, now);
  if (words === '') return queued('no_answer');
  return {
    kind: 'send',
    by: 'side_read',
    body: words,
    templateKey: SIDE_TURN_TEMPLATE_KEY,
    medicalSource: null,
    replySource: null,
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

/** Thread the parent's text, then send and claim. */
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
  const providerMessageId = linqMessageEditEnabled() ? input.candidate.providerMessageId : null;
  await appendMessage(input.conversationId, 'user', input.candidate.body, deps.database, {
    childId: null,
    topic: null,
    ...(providerMessageId ? { providerMessageId } : {}),
  });
  let accepted = false;
  try {
    await send({
      route: input.route,
      body: plan.body,
      job,
      conversationId: input.conversationId,
      claim: async () => {
        accepted = true;
        const claim = await deps.turns.recordAnswered({
          familyId: job.family_id,
          parentUserId: job.parent_user_id,
          channelMessageId: job.channel_message_id,
          folded: [],
        });
        if (claim === 'already_answered') {
          deps.log.warn(
            { channelMessageId: job.channel_message_id, familyId: job.family_id },
            'side turn: answer already claimed — this send was a duplicate reply',
          );
        }
      },
      templateKey: plan.templateKey,
      medicalSource: plan.medicalSource,
      replySource: plan.replySource,
      ...(plan.crisis
        ? { onSent: () => noteCrisisReplySent(deps.database, job.provider_message_id, deps.now()) }
        : {}),
    });
    return { kind: 'answered', by: plan.by };
  } catch (err) {
    if (accepted) {
      deps.log.error(
        {
          channelMessageId: job.channel_message_id,
          err: err instanceof Error ? err.name : 'unknown',
        },
        'side turn: the reply landed; a receipt after it did not',
      );
      return { kind: 'answered', by: plan.by };
    }
    await deps.turns.recordDeferred({
      familyId: job.family_id,
      parentUserId: job.parent_user_id,
      channelMessageId: job.channel_message_id,
      reason: SIDE_TURN_UNSENT,
    });
    deps.log.warn(
      {
        channelMessageId: job.channel_message_id,
        err: err instanceof Error ? err.name : 'unknown',
      },
      'side turn: not sent — the text goes back to its own turn',
    );
    return queued('send_failed');
  }
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
        ageMonths: child.ageMonths,
      })),
      city: context.location.city,
      memory: context.memoryBrief.text === '' ? null : context.memoryBrief.text,
      localNow: timeZone ? familyLocalNow(now, timeZone) : null,
    };
  };
}
