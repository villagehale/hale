import { type Database, schema } from '@hale/db';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import type { ChannelMessageReceivedJob } from './inbound';

/**
 * The reader of `handed_off_at` — the half that makes the column mean something.
 *
 * A webhook records a parent's message, then hands it to C1's queue, and those are two
 * separate facts because the second one can fail on its own. When it does, the row is
 * left unmarked and the request answers `enqueue_failed`: honest, logged, and still a
 * message nobody has replied to. The provider cannot fix it — a retry loses the claim
 * index and answers 'duplicate' — so something has to come back later and finish the
 * job. This is that something.
 *
 * BOTH INBOUND DOORS, one reconciler. It lives in twilio/ because SMS was the first leg
 * to have one, but the column it reads is not the SMS leg's: the email webhook writes
 * and stamps `handed_off_at` identically (email/inbound.ts), so an email whose enqueue
 * failed is owed exactly what a text is. Email was excluded here until it was — #443
 * narrowed this sweep to sms while inbound email was still recorded-and-dropped, and
 * that exclusion expires with the phase that justified it.
 *
 * It is safe to re-drive blindly for two reasons that live elsewhere, and neither is
 * re-implemented here:
 *
 *   IDENTITY. The job id is the channel message id (channel/twilio/deps), so a message
 *   whose enqueue actually succeeded and whose mark failed cannot become a second job —
 *   pg-boss's insert conflicts and creates nothing. Without that, this module would be
 *   a machine for answering people twice.
 *
 *   CONSENT. A parent who pressed STOP between the text and this run resolves to no
 *   live channel, so the router answers `unreachable` and sends nothing (CASL, rule
 *   #1). A second consent check here would be a second copy that can drift, and the
 *   drifted copy is the one that fails an audit.
 *
 * And one reason that lives here: SCOPE. The select matches exactly the rows a hand-off
 * path records, and nothing else. The intake machine and the caregiver route also write
 * inbound rows and consume their own messages, so "unmarked" on one of theirs never
 * means "owed to C1", and re-driving one answers a parent twice (#443).
 */

/**
 * How long a row must sit unmarked before it counts as abandoned rather than in flight.
 * A request still running holds an unmarked row for its whole life, and Twilio's own
 * budget for the webhook is 15s — two minutes is far past any live attempt while still
 * being a delay a parent experiences as slow, not as ignored.
 */
export const HANDOFF_GRACE_MS = 2 * 60 * 1000;

/**
 * How far back to look. A text is worth answering late; it is not worth answering
 * whenever the queue happens to come back. Past a day the reply has stopped being
 * useful and started being strange, and the ceiling also bounds the damage if this
 * ever runs against a table that was never backfilled.
 */
export const HANDOFF_CEILING_MS = 24 * 60 * 60 * 1000;

/** One cron tick's worth of work. The cron runs every 10 minutes; a backlog deeper
 * than this is drained across ticks rather than in one long request. */
export const RECONCILE_BATCH_LIMIT = 100;

/** The age band a row must fall inside to be re-driven: older than the grace window,
 * younger than the ceiling. */
export function reconcileWindow(now: Date): { notBefore: Date; notAfter: Date } {
  return {
    notBefore: new Date(now.getTime() - HANDOFF_CEILING_MS),
    notAfter: new Date(now.getTime() - HANDOFF_GRACE_MS),
  };
}

export interface UnhandedInboundRow {
  id: string;
  familyId: string;
  parentUserId: string;
  providerMessageId: string;
  sentAt: Date | null;
  createdAt: Date;
}

/**
 * The doors C1 consumes. Both of them, and only them: a text and an email are one
 * queue, one router and one conversation, so a message owed a reply is owed one whichever
 * way it arrived (email/inbound.ts, router/reply-route.ts).
 */
const REDRIVEN_CHANNELS = ['sms', 'email'] as const;

/**
 * Inbound rows C1 was never given, oldest first — a parent's messages are re-driven in
 * the order they were sent, the same order the singleton key preserves.
 *
 * THE FILTER IS THE SAFETY, and it names what C1 owns rather than describing what it
 * does not. `direction: 'in'` alone is far too wide: the intake machine and M6's
 * caregiver leg both write inbound rows that no one ever marks handed-off, so an
 * unqualified sweep finds their finished work sitting permanently unmarked and pushes it
 * into a router that would answer a caregiver, or re-answer an intake turn (#443).
 * `category = 'reply'` is the line between them, and the channel list is the second half
 * of the same statement: it says which doors C1 can answer THROUGH, so a new inbound
 * channel is opt-in here rather than swept in by default.
 */
export async function selectUnhandedInbound(
  database: Database,
  now: Date,
): Promise<UnhandedInboundRow[]> {
  const { notBefore, notAfter } = reconcileWindow(now);
  const rows = await database
    .select({
      id: schema.channelMessages.id,
      familyId: schema.channelMessages.familyId,
      parentUserId: schema.channelMessages.parentUserId,
      providerMessageId: schema.channelMessages.providerMessageId,
      sentAt: schema.channelMessages.sentAt,
      createdAt: schema.channelMessages.createdAt,
    })
    .from(schema.channelMessages)
    .where(
      and(
        // Exactly what the two hand-off writers record, and nothing else. Intake and
        // caregiver rows are written by handlers that consume them themselves — an
        // unmarked row there is not a message C1 is owed, and sweeping one in replays
        // something that was already answered.
        inArray(schema.channelMessages.channel, [...REDRIVEN_CHANNELS]),
        eq(schema.channelMessages.category, 'reply'),
        eq(schema.channelMessages.direction, 'in'),
        isNull(schema.channelMessages.handedOffAt),
        isNotNull(schema.channelMessages.providerMessageId),
        lt(schema.channelMessages.createdAt, notAfter),
        gt(schema.channelMessages.createdAt, notBefore),
      ),
    )
    .orderBy(asc(schema.channelMessages.createdAt))
    .limit(RECONCILE_BATCH_LIMIT);

  // Restates the SQL's isNotNull for the type system, which cannot read a where clause.
  return rows.filter(
    (row): row is UnhandedInboundRow => row.providerMessageId !== null,
  );
}

export interface InboundReconcileDeps {
  database: Database;
  enqueue: (job: ChannelMessageReceivedJob) => Promise<void>;
  log: Pick<Console, 'warn' | 'error'>;
  now?: () => Date;
}

export interface InboundReconcileSummary {
  /** Rows found owing a hand-off. */
  scanned: number;
  redriven: number;
  /** Still owed after this run — the queue is still refusing them. */
  failed: number;
}

export async function reconcileUnhandedInbound(
  deps: InboundReconcileDeps,
): Promise<InboundReconcileSummary> {
  const now = deps.now?.() ?? new Date();
  const rows = await selectUnhandedInbound(deps.database, now);
  let redriven = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await deps.enqueue({
        family_id: row.familyId,
        parent_user_id: row.parentUserId,
        channel_message_id: row.id,
        provider_message_id: row.providerMessageId,
        // `sent_at` is when the parent actually sent it, which is what the turn should
        // reason about; created_at is only when we wrote the row.
        received_at: (row.sentAt ?? row.createdAt).toISOString(),
      });
      await deps.database
        .update(schema.channelMessages)
        .set({ handedOffAt: now })
        .where(eq(schema.channelMessages.id, row.id));
      redriven += 1;
    } catch (err) {
      // One unqueueable row must not strand the rest of the batch behind it.
      failed += 1;
      deps.log.error(
        {
          channelMessageId: row.id,
          providerMessageId: row.providerMessageId,
          err: err instanceof Error ? err.message : String(err),
        },
        'inbound reconcile: this text is still owed a reply — the queue refused it again',
      );
    }
  }

  if (redriven > 0 || failed > 0) {
    deps.log.warn(
      { scanned: rows.length, redriven, failed },
      'inbound reconcile: re-drove texts that were recorded but never queued for C1',
    );
  }
  return { scanned: rows.length, redriven, failed };
}
