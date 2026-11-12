import { type Database, schema } from '@hale/db';
import { and, asc, desc, eq, gt, gte, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { type InboundMediaPart, inboundMediaFromStored } from '~/lib/channel/inbound-media';
import type { ChannelMessageReceivedJob } from '~/lib/channel/inbound-route';
import { resolveNoteConversation } from '~/lib/coach/conversation';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { withoutLiveViewLinks } from '~/lib/signup/browser-use/live-view';
import type { BurstReading, InboundBurstReader } from './burst-reader';
import { DeadlineError, withTimeout } from './deadline';
import type { InboundContext } from './route';
import {
  TURN_ANSWERED_ACTION,
  TURN_DEFERRED_ACTION,
  TURN_FAILED_ACTION,
  TURN_FOLDED_ACTION,
  TURN_LEDGER_LOOKBACK_MS,
  TURN_LEDGER_TARGET,
} from './turn-ledger';

/**
 * BACK-TO-BACK TEXTS ARE ONE TURN (phase 1: settle, read, fold).
 *
 * A parent who types "$600 budget for a fall program", then "$900", gets one answer
 * threaded under the $900, not a $600 answer followed by a correction. Two unrelated asks
 * still get two answers, each under its own text. Nothing is dropped: a text is either
 * read into this turn or left for its own job, which runs next under the same per-parent
 * key.
 *
 * Everything happens at the top of the FIRST attempt of the turn that holds the parent's
 * key, before any gate reads a word. The merged words then go through every gate — the
 * opt-out reader, the smoke alarm, the resolver, the handlers, the flood limiter (counted
 * once), the off-domain screen and the coach — so a STOP or a crisis inside a burst
 * cannot skip one. Folding a text into a turn that is already RUNNING is phase 2: by then
 * those gates have run on the old words and the drafts are written.
 *
 *   SETTLE. Poll this text plus every newer, untouched text from the same parent in the
 *   same 1:1 chat until the newest is {@link BURST_QUIET_MS} old, or
 *   {@link BURST_MAX_HOLD_MS} has passed. These are reading-latency settings, the same
 *   kind as the holding line's wait, never a send rule.
 *   READ. Two or more texts: the model groups them by ask (burst-reader.ts).
 *   FOLD. Each other text in THIS text's group is claimed (the answer-claims table is the
 *   arbiter) and gets an `sms_turn_folded` row naming this turn. Its own job then reads
 *   `folded` at GATE 0 and stops. Texts in other groups are untouched; their own jobs
 *   come next and run this same plan over themselves.
 *
 * Group chats are out of phase 1: each sender has their own key, and other families read
 * the group.
 */

export const BURST_QUIET_MS = 2_500;
export const BURST_MAX_HOLD_MS = 8_000;
export const BURST_POLL_MS = 400;
export const BURST_MAX_MEMBERS = 6;
export const BURST_READ_BUDGET_MS = 6_000;

/** The reader outlived {@link BURST_READ_BUDGET_MS}; the texts are read as one turn. */
const BURST_READ_TIMEOUT = 'burst_read_timeout';

export { TURN_FOLDED_ACTION };

export interface BurstMember {
  channelMessageId: string;
  providerMessageId: string | null;
  body: string;
  media: readonly InboundMediaPart[];
  createdAt: Date;
}

/** How the grouping was decided: by the reader, or — when it could not answer — by
 * reading everything as one turn so nothing is dropped. */
export type BurstReadOutcome = 'read' | 'reader_unavailable';

export type BurstPlan =
  | {
      kind: 'lone';
      waitedMs: number;
      why: 'flag_off' | 'not_direct' | 're_driven' | 'alone' | 'kept_apart';
    }
  | {
      kind: 'anchor';
      /** The anchor first, then the folded texts, in the order they were sent. */
      members: readonly BurstMember[];
      /** The latest member: where the answer threads. */
      replyTo: BurstMember;
      waitedMs: number;
      read: BurstReadOutcome | 'decided_earlier';
    };

export interface BurstPorts {
  enabled(familyId: string): boolean;
  /** Non-nullable (rule #11): a reader that cannot run says so in its reading. */
  reader: InboundBurstReader;
  now(): Date;
  sleep(ms: number): Promise<void>;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
}

/** The router's seam: one plan per attempt. */
export interface InboundBurst {
  plan(job: ChannelMessageReceivedJob, stage: 'fresh' | 'deferred'): Promise<BurstPlan>;
}

export function createInboundBurst(database: Database, ports: BurstPorts): InboundBurst {
  return { plan: (job, stage) => planBurst(database, ports, job, stage) };
}

/** Every ledger verb that means a turn has already touched a text. */
const TOUCHED_ACTIONS = [
  TURN_ANSWERED_ACTION,
  TURN_DEFERRED_ACTION,
  TURN_FAILED_ACTION,
  TURN_FOLDED_ACTION,
  'sms_turn_unanswered',
];

const memberColumns = {
  channelMessageId: schema.channelMessages.id,
  providerMessageId: schema.channelMessages.providerMessageId,
  body: schema.channelMessages.body,
  inboundMedia: schema.channelMessages.inboundMedia,
  createdAt: schema.channelMessages.createdAt,
};

function toMember(row: {
  channelMessageId: string;
  providerMessageId: string | null;
  body: string | null;
  inboundMedia: unknown;
  createdAt: Date;
}): BurstMember {
  return {
    channelMessageId: row.channelMessageId,
    providerMessageId: row.providerMessageId,
    // At the source, so the reader, the merged body and each threaded row all start
    // from words that cannot carry a live-view link.
    body: withoutLiveViewLinks(row.body ?? ''),
    media: inboundMediaFromStored(row.inboundMedia),
    createdAt: row.createdAt,
  };
}

/** A row with neither words nor a part is not routable, so it is never a member. */
function routable(member: BurstMember): boolean {
  return member.body !== '' || member.media.length > 0;
}

/**
 * This text, then every NEWER text from the same parent, in the same family, channel
 * and 1:1 chat, that no turn has touched — no answer claim and no turn-ledger row —
 * oldest first, at most `limit` in all. Empty when the anchor row is not this family's.
 */
export async function pendingBurst(
  database: Database,
  anchor: { familyId: string; parentUserId: string; channelMessageId: string },
  limit: number,
): Promise<readonly BurstMember[]> {
  const [row] = await database
    .select({
      ...memberColumns,
      familyId: schema.channelMessages.familyId,
      channel: schema.channelMessages.channel,
      providerChatId: schema.channelMessages.providerChatId,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.id, anchor.channelMessageId))
    .limit(1);
  if (!row || row.familyId !== anchor.familyId) return [];

  const lookback = new Date(Date.now() - TURN_LEDGER_LOOKBACK_MS);
  const newer = await database
    .select(memberColumns)
    .from(schema.channelMessages)
    .where(
      and(
        // Leads with the cap index's columns (parent_user_id, category, created_at).
        eq(schema.channelMessages.parentUserId, anchor.parentUserId),
        eq(schema.channelMessages.category, 'reply'),
        gt(schema.channelMessages.createdAt, row.createdAt),
        eq(schema.channelMessages.familyId, anchor.familyId),
        eq(schema.channelMessages.direction, 'in'),
        eq(schema.channelMessages.channel, row.channel),
        row.providerChatId === null
          ? isNull(schema.channelMessages.providerChatId)
          : eq(schema.channelMessages.providerChatId, row.providerChatId),
        eq(schema.channelMessages.inGroup, false),
        notExists(
          database
            .select({ one: sql`1` })
            .from(schema.channelTurnAnswerClaims)
            .where(eq(schema.channelTurnAnswerClaims.channelMessageId, schema.channelMessages.id)),
        ),
        notExists(
          database
            .select({ one: sql`1` })
            .from(schema.auditLog)
            .where(
              and(
                eq(schema.auditLog.familyId, anchor.familyId),
                gte(schema.auditLog.occurredAt, lookback),
                eq(schema.auditLog.targetTable, TURN_LEDGER_TARGET),
                eq(schema.auditLog.targetId, sql`${schema.channelMessages.id}::text`),
                inArray(schema.auditLog.actionTaken, TOUCHED_ACTIONS),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(schema.channelMessages.createdAt), asc(schema.channelMessages.id))
    .limit(Math.max(0, limit - 1));

  return [toMember(row), ...newer.map(toMember).filter(routable)];
}

/**
 * Claim each member for the anchor's turn. One transaction per member: the claim row
 * (ON CONFLICT DO NOTHING — the arbiter, the same table an answer claims) and an
 * `sms_turn_folded` row naming the anchor. A member another attempt already claimed is
 * left out. Returns the ids this call won.
 *
 * The fold row is about one parent's texts, so it is tagged to that parent (VIL-635):
 * ids and enums only, never a body.
 */
export async function foldIntoAnchor(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    anchorId: string;
    memberIds: readonly string[];
    read: BurstReadOutcome;
  },
): Promise<readonly string[]> {
  const won: string[] = [];
  for (const memberId of input.memberIds) {
    const claimed = await database.transaction(async (tx) => {
      const rows = await tx
        .insert(schema.channelTurnAnswerClaims)
        .values({ channelMessageId: memberId })
        .onConflictDoNothing({ target: schema.channelTurnAnswerClaims.channelMessageId })
        .returning({ id: schema.channelTurnAnswerClaims.id });
      if (rows.length === 0) return false;
      await tx.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: input.parentUserId,
        actionTaken: TURN_FOLDED_ACTION,
        audience: input.parentUserId,
        targetTable: TURN_LEDGER_TARGET,
        targetId: memberId,
        after: { into: input.anchorId, read: input.read },
      });
      return true;
    });
    if (claimed) won.push(memberId);
  }
  return won;
}

/** The ids of the texts folded into an anchor's turn, from the fold rows alone: ids, never
 * a body, so a dead letter can name them (drain.ts). */
export async function foldedMemberIds(
  database: Database,
  input: { familyId: string; anchorId: string },
): Promise<readonly string[]> {
  const folded = await database
    .select({ targetId: schema.auditLog.targetId })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, input.familyId),
        gte(schema.auditLog.occurredAt, new Date(Date.now() - TURN_LEDGER_LOOKBACK_MS)),
        eq(schema.auditLog.actionTaken, TURN_FOLDED_ACTION),
        eq(schema.auditLog.targetTable, TURN_LEDGER_TARGET),
        sql`${schema.auditLog.after}->>'into' = ${input.anchorId}`,
      ),
    );
  return folded.flatMap((row) => (row.targetId ? [row.targetId] : []));
}

/** The anchor and the texts an earlier attempt folded into it, oldest first. Only the
 * anchor (no fold rows) is returned as an empty list: there is no burst to rebuild. */
export async function membersFoldedInto(
  database: Database,
  input: { familyId: string; anchorId: string },
): Promise<readonly BurstMember[]> {
  const ids = await foldedMemberIds(database, input);
  if (ids.length === 0) return [];
  const rows = await database
    .select(memberColumns)
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        inArray(schema.channelMessages.id, [input.anchorId, ...ids]),
      ),
    )
    .orderBy(asc(schema.channelMessages.createdAt), asc(schema.channelMessages.id));
  return rows.map(toMember);
}

/** The last thing Hale said in this parent's 1:1 thread, or null. The one piece of the
 * thread the reader sees: a "yes" is only placeable against the question it answers. */
async function lastHaleLine(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<string | null> {
  const conversationId = await resolveNoteConversation(
    input.familyId,
    channelSmsNoteKey(input.parentUserId),
    database,
  );
  if (!conversationId) return null;
  const [row] = await database
    .select({ content: schema.messages.content })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.role, 'assistant'),
        isNull(schema.messages.deletedAt),
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(1);
  return row?.content ?? null;
}

async function settle(
  database: Database,
  ports: BurstPorts,
  anchor: { familyId: string; parentUserId: string; channelMessageId: string },
): Promise<{ members: readonly BurstMember[]; waitedMs: number }> {
  const startedMs = ports.now().getTime();
  for (;;) {
    const members = await pendingBurst(database, anchor, BURST_MAX_MEMBERS);
    const nowMs = ports.now().getTime();
    const waitedMs = nowMs - startedMs;
    const newest = members.at(-1);
    if (!newest) return { members, waitedMs };
    const quietMs = nowMs - newest.createdAt.getTime();
    if (
      members.length >= BURST_MAX_MEMBERS ||
      quietMs >= BURST_QUIET_MS ||
      waitedMs >= BURST_MAX_HOLD_MS
    ) {
      return { members, waitedMs };
    }
    await ports.sleep(
      Math.min(BURST_POLL_MS, BURST_QUIET_MS - quietMs, BURST_MAX_HOLD_MS - waitedMs),
    );
  }
}

async function readWithin(
  reader: InboundBurstReader,
  input: Parameters<InboundBurstReader['read']>[0],
): Promise<BurstReading> {
  try {
    return await withTimeout(reader.read(input), BURST_READ_BUDGET_MS, BURST_READ_TIMEOUT);
  } catch (err) {
    if (err instanceof DeadlineError) return { status: 'unavailable', reason: 'timeout' };
    throw err;
  }
}

export async function planBurst(
  database: Database,
  ports: BurstPorts,
  job: ChannelMessageReceivedJob,
  stage: 'fresh' | 'deferred',
): Promise<BurstPlan> {
  if (job.in_group !== false) return { kind: 'lone', waitedMs: 0, why: 'not_direct' };
  const anchorRef = {
    familyId: job.family_id,
    parentUserId: job.parent_user_id,
    channelMessageId: job.channel_message_id,
  };
  const rebuild = async (): Promise<BurstPlan | null> => {
    const members = await membersFoldedInto(database, {
      familyId: job.family_id,
      anchorId: job.channel_message_id,
    });
    const replyTo = members.at(-1);
    if (!replyTo || members.length < 2) return null;
    return { kind: 'anchor', members, replyTo, waitedMs: 0, read: 'decided_earlier' };
  };

  // Whatever an earlier attempt folded is kept, flag or no flag: those texts' own jobs
  // already stopped at `folded`, so this turn is the only one that answers them. That
  // holds for a re-drive and for an attempt that crashed after folding and left no defer
  // row, which comes back `fresh`. Only planning a NEW burst depends on the flag.
  const earlier = await rebuild();
  if (earlier) return earlier;
  if (stage === 'deferred') return { kind: 'lone', waitedMs: 0, why: 're_driven' };
  if (!ports.enabled(job.family_id)) return { kind: 'lone', waitedMs: 0, why: 'flag_off' };

  const { members, waitedMs } = await settle(database, ports, anchorRef);
  const [anchor] = members;
  if (!anchor || members.length < 2) return { kind: 'lone', waitedMs, why: 'alone' };

  const refs = members.map((_, index) => `m${index + 1}`);
  const reading = await readWithin(ports.reader, {
    messages: members.map((member, index) => ({
      ref: refs[index] ?? '',
      text: member.body,
      attachments: member.media.map((part) => part.kind),
    })),
    previousHaleLine: await lastHaleLine(database, anchorRef),
  });
  const group =
    reading.status === 'read' ? reading.groups.find((g) => g.includes(refs[0] ?? '')) : undefined;
  const read: BurstReadOutcome = group ? 'read' : 'reader_unavailable';
  if (!group) {
    ports.log.warn(
      {
        channelMessageId: job.channel_message_id,
        familyId: job.family_id,
        outcome: 'reader_unavailable',
        reason: reading.status === 'unavailable' ? reading.reason : 'anchor_ungrouped',
        burstSize: members.length,
      },
      'inbound burst: reader could not group the texts, reading them as one turn',
    );
  }
  const together = members.filter((_, index) => (group ?? refs).includes(refs[index] ?? ''));
  const others = together.filter((member) => member !== anchor);
  if (others.length === 0) return { kind: 'lone', waitedMs, why: 'kept_apart' };

  const won = new Set(
    await foldIntoAnchor(database, {
      familyId: job.family_id,
      parentUserId: job.parent_user_id,
      anchorId: anchor.channelMessageId,
      memberIds: others.map((member) => member.channelMessageId),
      read,
    }),
  );
  const folded = [anchor, ...others.filter((member) => won.has(member.channelMessageId))];
  const replyTo = folded.at(-1);
  if (!replyTo || folded.length < 2) return { kind: 'lone', waitedMs, why: 'alone' };
  return { kind: 'anchor', members: folded, replyTo, waitedMs, read };
}

/**
 * The anchor's context, carrying the whole burst: the members' words joined by a line
 * break (the Linq door's precedent for a multi-part text), every member's media, and —
 * on iMessage — the answer threaded under the latest member. Built before any gate, so
 * every gate reads all of it.
 */
export function mergeBurstContext(
  context: InboundContext,
  plan: Extract<BurstPlan, { kind: 'anchor' }>,
): InboundContext {
  const body = plan.members
    .map((member) => member.body)
    .filter((words) => words !== '')
    .join('\n');
  const media = plan.members.flatMap((member) => member.media);
  const reply =
    context.reply?.channel === 'imessage'
      ? { ...context.reply, replyToMessageId: plan.replyTo.providerMessageId }
      : context.reply;
  return { ...context, body, reply, ...(media.length > 0 ? { media } : {}) };
}
