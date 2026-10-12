import { type Database, schema } from '@hale/db';
import { type AcceptedStatus, acceptedStatus } from '~/lib/channel/ledger';
import type { threadProactiveMessage } from '~/lib/channel/thread';
import type { ChannelCategory } from './queue';

/**
 * VIL-226 · what every reader sees after a proactive text left, written in one place so
 * the nudge sweep and the hourly decider leave the same rows behind:
 *
 *   - one `channel_messages` row per item the text carried, under the item's own
 *     template and dedupe key. That row is the sweep's dedupe, the weekday-care ask
 *     ledger (`already_asked`), and the open-question readers' antecedent;
 *   - the audit row the trail reads, pointing at the first of those rows;
 *   - the composed sentence in the recipient's own thread, where their reply is read.
 *
 * Called AFTER the transport accepted the text: a compose that never left is not
 * something Hale said.
 */

export interface ProactiveLedgerWrite {
  familyId: string;
  parentUserId: string;
  channel: 'sms' | 'imessage';
  category: ChannelCategory;
  templateKey: string;
  dedupeKey: string;
  status: AcceptedStatus;
  /** On the first row only: one provider message carries the whole text. */
  providerMessageId: string | null;
  providerChatId?: string | null;
  sentAt: Date;
}

export interface ProactiveAuditRow {
  familyId: string;
  actor: string;
  actionTaken: string;
  targetTable: string;
  targetId: string;
  after: Record<string, unknown>;
}

export interface SendFinalizerPorts {
  recordSend(database: Database, write: ProactiveLedgerWrite): Promise<string>;
  audit(database: Database, row: ProactiveAuditRow): Promise<void>;
  threadMessage: typeof threadProactiveMessage;
}

export async function recordProactiveSend(
  database: Database,
  write: ProactiveLedgerWrite,
): Promise<string> {
  const [row] = await database
    .insert(schema.channelMessages)
    .values({ ...write, direction: 'out' })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('recordProactiveSend: channel_messages insert returned no row');
  return row.id;
}

export async function writeProactiveAudit(
  database: Database,
  row: ProactiveAuditRow,
): Promise<void> {
  await database.insert(schema.auditLog).values(row);
}

/** Returns the id of the first ledger row, which the audit row points at. */
export async function finalizeProactiveSend(
  database: Database,
  ports: SendFinalizerPorts,
  input: {
    familyId: string;
    /** The parent this copy went to; the thread is theirs. */
    recipientUserId: string;
    channel: 'sms' | 'imessage';
    providerMessageId: string;
    providerChatId?: string | null;
    sentAt: Date;
    items: ReadonlyArray<{
      parentUserId: string;
      category: ChannelCategory;
      templateKey: string;
      dedupeKey: string;
    }>;
    /** The composed sentence, never the wire body. */
    composed: string;
    audit: { actionTaken: string; after: Record<string, unknown> };
  },
): Promise<string> {
  let firstId: string | null = null;
  for (const item of input.items) {
    const id = await ports.recordSend(database, {
      familyId: input.familyId,
      parentUserId: item.parentUserId,
      channel: input.channel,
      category: item.category,
      templateKey: item.templateKey,
      dedupeKey: item.dedupeKey,
      status: acceptedStatus(input.channel),
      providerMessageId: firstId === null ? input.providerMessageId : null,
      providerChatId: input.providerChatId,
      sentAt: input.sentAt,
    });
    firstId ??= id;
  }
  if (firstId === null) throw new Error('finalizeProactiveSend: a text that carried no item');
  await ports.audit(database, {
    familyId: input.familyId,
    actor: 'system',
    actionTaken: input.audit.actionTaken,
    targetTable: 'channel_messages',
    targetId: firstId,
    after: input.audit.after,
  });
  await ports.threadMessage(database, {
    familyId: input.familyId,
    parentUserId: input.recipientUserId,
    body: input.composed,
  });
  return firstId;
}
