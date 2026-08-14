import { type Database, schema } from '@hale/db';
import { and, asc, eq, gt, isNotNull, isNull, lt } from 'drizzle-orm';
import type { ChannelMessageReceivedJob } from './inbound';

/**
 * The reader of `handed_off_at` — the half that makes the column mean something.
 *
 * The webhook records a parent's text, then hands it to C1's queue, and those are two
 * separate facts because the second one can fail on its own. When it does, the row is
 * left unmarked and the request answers `enqueue_failed`: honest, logged, and still a
 * text nobody has replied to. Twilio cannot fix it — its retry loses the claim index
 * and answers 'duplicate' — so something has to come back later and finish the job.
 * This is that something.
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
 * And one reason that lives here: SCOPE. The select matches exactly the rows the
 * webhook's hand-off path records — sms 'reply' rows. Other recorders of inbound rows
 * (the intake machine, the caregiver route, the email leg) consume their own messages,
 * so "unmarked" on their rows never means "owed to C1", and re-driving one answers a
 * parent twice.
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

/** Inbound rows C1 was never given, oldest first — a parent's texts are re-driven in
 * the order they were sent, the same order the singleton key preserves. */
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
        // Exactly what handOffToConversation records, and nothing else. Intake,
        // caregiver, and email rows are written by handlers that consume them
        // themselves — an unmarked row there is not a text C1 is owed, and sweeping
        // one in replays a message that was already answered.
        eq(schema.channelMessages.channel, 'sms'),
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
