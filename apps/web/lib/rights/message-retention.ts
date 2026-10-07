import { type Database, schema } from '@hale/db';
import {
  type AnyColumn,
  type SQL,
  and,
  asc,
  inArray,
  isNotNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { removeDocument } from '../docs/storage.js';

/**
 * Twelve-month message retention. The privacy promise is that a message is kept
 * for 365 days; this is the hourly delete-sweep step that makes that true
 * (VIL-115 named a retention schedule as one of the facts the policy has to
 * match). It is not behind a feature flag: a retention promise that stops when
 * a flag flips is not a retention promise. The thirty-day check-in purge and
 * the 72-hour forward purge stay stricter and run on their own clocks.
 *
 * Age is wall-clock and strict. A row is eligible only when its timestamp is
 * older than `now - 365 days`, so a message at 364 days is kept. Each table is
 * capped at {@link MESSAGE_RETENTION_BATCH} rows per invocation; whatever is
 * left waits for the next hour. A second run is a no-op: the predicate requires
 * the content to still be there.
 *
 * Counts only ever leave this function. Bodies, numbers, and addresses are
 * not selected into the return value and are not logged.
 *
 * Approach, per table. Delete when the row exists only to hold the message.
 * Redact when something else still needs the row: a foreign key, a count, or
 * a legal decision.
 *
 * | Table | Approach | Why |
 * | --- | --- | --- |
 * | `channel_messages` | REDACT `body` to null | Bookings, reviews, offers, and check-in notes reference the row, some NOT NULL, and the cap index counts rows. Migration 0121 forbids deleting one. Outbound rows already store no body. |
 * | `messages` | DELETE the row | The Ask Hale transcript. Soft-delete leaves `content` in place; the retention promise removes it. Audit rows store the id as text, not a foreign key. |
 * | `chat_attachments` | DELETE the bytes, then the row | The file, its path, and `original_name`. Bytes are purged before the row so a cascade cannot drop the path first. Unlinked uploads are included. |
 * | `sms_intake_sessions` | REDACT `data_encrypted` and `phone_encrypted` | The pre-account transcript, including a group-chat sender who never became a user. The row stays: it is how the funnel counts an arrival, and both columns are NOT NULL. `phone_hash` stays so the same number is still recognised. An open session is closed so a later text starts clean rather than decrypting a tombstone. |
 * | `email_forwards_pending` | DELETE the row | The raw forwarded document (`raw_body`, `original_from`, `subject`). The 72-hour sweep should already have removed it; this is the backstop. |
 * | `family_forward_senders` | REDACT `ask_body` to null | The row is the allow or block decision. The ask text is the message. |
 * | `consent_records` | REDACT message keys inside `evidence` | The row is the legal consent (granted, type, time). `verbatim`, `verbatimReply`, `question`, and `ask` are the words. A group member's seating reply lives here. |
 * | `family_check_in_notes` | DELETE the row | A copy of the parent's words. The thirty-day purge is the real clock; this deletes anything that outlived a year. The source `channel_messages` row is redacted, not deleted. |
 * | `events` | REDACT message keys inside `payload` | Ingest stores subject and body here. Deleting the event cascade-deletes `actions`. |
 * | `actions` | REDACT message keys inside `payload` and `executor_result` | A drafted email body. The row is the approval ledger, one per event. |
 *
 * Not message stores, and not touched: `audit_log` (immutable; writers store
 * counts and ids), `email_sends` (the CASL ledger, not a body), family memory,
 * week plans, `agent_commitments.summary`, `pending_disambiguations.options`,
 * `social_spots.raw_caption` (a public caption), roster numbers (their own
 * thirty-day release), and party RSVP phones (a consent to remind, not a message).
 */

/** How long a message body or transcript may live. */
export const MESSAGE_RETENTION_DAYS = 365;

const MESSAGE_RETENTION_MS = MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Rows handled per table per cron run. The hourly route has no extended
 * duration, so one backlog must not try to finish itself in a single tick.
 */
export const MESSAGE_RETENTION_BATCH = 200;

/**
 * Replacement for an intake ciphertext once the transcript and number are
 * gone. Stable, so a second run can see that the row is already done.
 * `data_encrypted` and `phone_encrypted` are NOT NULL, so null is not available.
 * Readers of an open session never see it: the sweep closes the session.
 */
export const INTAKE_CONTENT_REDACTED = 'redacted';

/**
 * JSON keys that hold a message body, a transcript, or a phone or email
 * address. Structural keys (a title, an interpretation, a channel) stay.
 * The list is a constant; it is interpolated as SQL identifiers of keys,
 * never as row content.
 */
const MESSAGE_JSON_KEYS = [
  'ask',
  'askBody',
  'bcc',
  'body',
  'cc',
  'email',
  'from',
  'html',
  'originalFrom',
  'phone',
  'preview',
  'question',
  'raw',
  'raw_content',
  'recipient',
  'reply_to',
  'replyTo',
  'sender',
  'snippet',
  'subject',
  'text',
  'to',
  'transcript',
  'verbatim',
  'verbatimReply',
] as const;

export interface MessageRetentionSummary {
  channelMessagesRedacted: number;
  messagesDeleted: number;
  chatAttachmentsDeleted: number;
  intakeSessionsRedacted: number;
  emailForwardsDeleted: number;
  forwardAsksRedacted: number;
  consentEvidenceRedacted: number;
  checkInNotesDeleted: number;
  eventPayloadsRedacted: number;
  actionPayloadsRedacted: number;
}

export interface MessageRetentionOptions {
  /** Defaults to {@link MESSAGE_RETENTION_BATCH}. Tests pass a smaller cap. */
  batchSize?: number;
  /** Storage-byte remover. Defaults to the private-bucket remover. */
  removeObject?: (path: string) => Promise<void>;
}

const EMPTY_SUMMARY: MessageRetentionSummary = {
  channelMessagesRedacted: 0,
  messagesDeleted: 0,
  chatAttachmentsDeleted: 0,
  intakeSessionsRedacted: 0,
  emailForwardsDeleted: 0,
  forwardAsksRedacted: 0,
  consentEvidenceRedacted: 0,
  checkInNotesDeleted: 0,
  eventPayloadsRedacted: 0,
  actionPayloadsRedacted: 0,
};

function jsonbHasMessageKey(column: AnyColumn): SQL {
  const list = MESSAGE_JSON_KEYS.map((key) => `'${key}'`).join(',');
  return sql`${column} ?| array[${sql.raw(list)}]`;
}

function jsonbWithoutMessageKeys(column: AnyColumn): SQL {
  const chain = MESSAGE_JSON_KEYS.map((key) => `- '${key}'`).join(' ');
  return sql`${column} ${sql.raw(chain)}`;
}

type RemoveObject = (path: string) => Promise<void>;

/**
 * Removes message content older than 365 days. See the module note for which
 * table is deleted and which is redacted. Idempotent, and capped per table.
 */
export async function sweepMessageRetention(
  database: Database,
  now: Date = new Date(),
  options: MessageRetentionOptions = {},
): Promise<MessageRetentionSummary> {
  const batch = options.batchSize ?? MESSAGE_RETENTION_BATCH;
  if (!Number.isInteger(batch) || batch < 1) {
    throw new Error('sweepMessageRetention: batchSize must be a positive integer');
  }
  const removeObject = options.removeObject ?? removeDocument;
  const cutoff = new Date(now.getTime() - MESSAGE_RETENTION_MS);
  const summary = { ...EMPTY_SUMMARY };

  summary.channelMessagesRedacted = await redactChannelMessages(database, cutoff, batch);
  const transcripts = await deleteTranscripts(database, cutoff, batch, removeObject);
  summary.messagesDeleted = transcripts.messagesDeleted;
  summary.chatAttachmentsDeleted += transcripts.chatAttachmentsDeleted;
  summary.chatAttachmentsDeleted += await deleteAgedAttachments(
    database,
    cutoff,
    batch,
    removeObject,
  );
  summary.intakeSessionsRedacted = await redactIntakeSessions(database, cutoff, batch, now);
  summary.emailForwardsDeleted = await deletePendingForwards(database, cutoff, batch);
  summary.forwardAsksRedacted = await redactForwardAsks(database, cutoff, batch);
  summary.consentEvidenceRedacted = await redactConsentEvidence(database, cutoff, batch);
  summary.checkInNotesDeleted = await deleteCheckInNotes(database, cutoff, batch);
  summary.eventPayloadsRedacted = await redactEventPayloads(database, cutoff, batch);
  summary.actionPayloadsRedacted = await redactActionPayloads(database, cutoff, batch);

  return summary;
}

async function redactChannelMessages(
  database: Database,
  cutoff: Date,
  batch: number,
): Promise<number> {
  const due = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(isNotNull(schema.channelMessages.body), lt(schema.channelMessages.createdAt, cutoff)),
    )
    .orderBy(asc(schema.channelMessages.createdAt), asc(schema.channelMessages.id))
    .limit(batch);
  if (due.length === 0) return 0;
  const updated = await database
    .update(schema.channelMessages)
    .set({ body: null })
    .where(
      inArray(
        schema.channelMessages.id,
        due.map((row) => row.id),
      ),
    )
    .returning({ id: schema.channelMessages.id });
  return updated.length;
}

async function deleteTranscripts(
  database: Database,
  cutoff: Date,
  batch: number,
  removeObject: RemoveObject,
): Promise<{ messagesDeleted: number; chatAttachmentsDeleted: number }> {
  const due = await database
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(lt(schema.messages.createdAt, cutoff))
    .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id))
    .limit(batch);
  if (due.length === 0) return { messagesDeleted: 0, chatAttachmentsDeleted: 0 };
  const messageIds = due.map((row) => row.id);
  const attachments = await database
    .select({
      id: schema.chatAttachments.id,
      storagePath: schema.chatAttachments.storagePath,
    })
    .from(schema.chatAttachments)
    .where(inArray(schema.chatAttachments.messageId, messageIds));
  // Bytes first. A cascade from the message delete would drop the path and
  // leave the object in the bucket with nothing pointing at it.
  for (const attachment of attachments) {
    await removeObject(attachment.storagePath);
  }
  let chatAttachmentsDeleted = 0;
  if (attachments.length > 0) {
    const deletedAttachments = await database
      .delete(schema.chatAttachments)
      .where(
        inArray(
          schema.chatAttachments.id,
          attachments.map((row) => row.id),
        ),
      )
      .returning({ id: schema.chatAttachments.id });
    chatAttachmentsDeleted = deletedAttachments.length;
  }
  const deleted = await database
    .delete(schema.messages)
    .where(inArray(schema.messages.id, messageIds))
    .returning({ id: schema.messages.id });
  return { messagesDeleted: deleted.length, chatAttachmentsDeleted };
}

async function deleteAgedAttachments(
  database: Database,
  cutoff: Date,
  batch: number,
  removeObject: RemoveObject,
): Promise<number> {
  const due = await database
    .select({
      id: schema.chatAttachments.id,
      storagePath: schema.chatAttachments.storagePath,
    })
    .from(schema.chatAttachments)
    .where(lt(schema.chatAttachments.createdAt, cutoff))
    .orderBy(asc(schema.chatAttachments.createdAt), asc(schema.chatAttachments.id))
    .limit(batch);
  if (due.length === 0) return 0;
  for (const attachment of due) {
    await removeObject(attachment.storagePath);
  }
  const deleted = await database
    .delete(schema.chatAttachments)
    .where(
      inArray(
        schema.chatAttachments.id,
        due.map((row) => row.id),
      ),
    )
    .returning({ id: schema.chatAttachments.id });
  return deleted.length;
}

async function redactIntakeSessions(
  database: Database,
  cutoff: Date,
  batch: number,
  now: Date,
): Promise<number> {
  const due = await database
    .select({ id: schema.smsIntakeSessions.id })
    .from(schema.smsIntakeSessions)
    .where(
      and(
        lt(schema.smsIntakeSessions.updatedAt, cutoff),
        or(
          ne(schema.smsIntakeSessions.dataEncrypted, INTAKE_CONTENT_REDACTED),
          ne(schema.smsIntakeSessions.phoneEncrypted, INTAKE_CONTENT_REDACTED),
        ),
      ),
    )
    .orderBy(asc(schema.smsIntakeSessions.updatedAt), asc(schema.smsIntakeSessions.id))
    .limit(batch);
  if (due.length === 0) return 0;
  const updated = await database
    .update(schema.smsIntakeSessions)
    .set({
      dataEncrypted: INTAKE_CONTENT_REDACTED,
      phoneEncrypted: INTAKE_CONTENT_REDACTED,
      closedAt: sql`coalesce(${schema.smsIntakeSessions.closedAt}, ${now})`,
    })
    .where(
      inArray(
        schema.smsIntakeSessions.id,
        due.map((row) => row.id),
      ),
    )
    .returning({ id: schema.smsIntakeSessions.id });
  return updated.length;
}

async function deletePendingForwards(
  database: Database,
  cutoff: Date,
  batch: number,
): Promise<number> {
  const due = await database
    .select({ id: schema.emailForwardsPending.id })
    .from(schema.emailForwardsPending)
    .where(
      or(
        lt(schema.emailForwardsPending.createdAt, cutoff),
        lt(schema.emailForwardsPending.receivedAt, cutoff),
      ),
    )
    .orderBy(asc(schema.emailForwardsPending.createdAt), asc(schema.emailForwardsPending.id))
    .limit(batch);
  if (due.length === 0) return 0;
  const deleted = await database
    .delete(schema.emailForwardsPending)
    .where(
      inArray(
        schema.emailForwardsPending.id,
        due.map((row) => row.id),
      ),
    )
    .returning({ id: schema.emailForwardsPending.id });
  return deleted.length;
}

async function redactForwardAsks(database: Database, cutoff: Date, batch: number): Promise<number> {
  const due = await database
    .select({ id: schema.familyForwardSenders.id })
    .from(schema.familyForwardSenders)
    .where(
      and(
        isNotNull(schema.familyForwardSenders.askBody),
        lt(schema.familyForwardSenders.createdAt, cutoff),
      ),
    )
    .orderBy(asc(schema.familyForwardSenders.createdAt), asc(schema.familyForwardSenders.id))
    .limit(batch);
  if (due.length === 0) return 0;
  const updated = await database
    .update(schema.familyForwardSenders)
    .set({ askBody: null })
    .where(
      inArray(
        schema.familyForwardSenders.id,
        due.map((row) => row.id),
      ),
    )
    .returning({ id: schema.familyForwardSenders.id });
  return updated.length;
}

async function redactConsentEvidence(
  database: Database,
  cutoff: Date,
  batch: number,
): Promise<number> {
  const due = await database
    .select({ id: schema.consentRecords.id })
    .from(schema.consentRecords)
    .where(
      and(
        isNotNull(schema.consentRecords.evidence),
        lt(schema.consentRecords.grantedAt, cutoff),
        jsonbHasMessageKey(schema.consentRecords.evidence),
      ),
    )
    .orderBy(asc(schema.consentRecords.grantedAt), asc(schema.consentRecords.id))
    .limit(batch);
  if (due.length === 0) return 0;
  const updated = await database
    .update(schema.consentRecords)
    .set({ evidence: jsonbWithoutMessageKeys(schema.consentRecords.evidence) })
    .where(
      inArray(
        schema.consentRecords.id,
        due.map((row) => row.id),
      ),
    )
    .returning({ id: schema.consentRecords.id });
  return updated.length;
}

async function deleteCheckInNotes(
  database: Database,
  cutoff: Date,
  batch: number,
): Promise<number> {
  const due = await database
    .select({ id: schema.familyCheckInNotes.id })
    .from(schema.familyCheckInNotes)
    .where(lt(schema.familyCheckInNotes.createdAt, cutoff))
    .orderBy(asc(schema.familyCheckInNotes.createdAt), asc(schema.familyCheckInNotes.id))
    .limit(batch);
  if (due.length === 0) return 0;
  const deleted = await database
    .delete(schema.familyCheckInNotes)
    .where(
      inArray(
        schema.familyCheckInNotes.id,
        due.map((row) => row.id),
      ),
    )
    .returning({ id: schema.familyCheckInNotes.id });
  return deleted.length;
}

async function redactEventPayloads(
  database: Database,
  cutoff: Date,
  batch: number,
): Promise<number> {
  const due = await database
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(and(lt(schema.events.receivedAt, cutoff), jsonbHasMessageKey(schema.events.payload)))
    .orderBy(asc(schema.events.receivedAt), asc(schema.events.id))
    .limit(batch);
  if (due.length === 0) return 0;
  const updated = await database
    .update(schema.events)
    .set({ payload: jsonbWithoutMessageKeys(schema.events.payload) })
    .where(
      inArray(
        schema.events.id,
        due.map((row) => row.id),
      ),
    )
    .returning({ id: schema.events.id });
  return updated.length;
}

async function redactActionPayloads(
  database: Database,
  cutoff: Date,
  batch: number,
): Promise<number> {
  const due = await database
    .select({ id: schema.actions.id })
    .from(schema.actions)
    .where(
      and(
        lt(schema.actions.draftedAt, cutoff),
        or(
          jsonbHasMessageKey(schema.actions.payload),
          jsonbHasMessageKey(schema.actions.executorResult),
        ),
      ),
    )
    .orderBy(asc(schema.actions.draftedAt), asc(schema.actions.id))
    .limit(batch);
  if (due.length === 0) return 0;
  const updated = await database
    .update(schema.actions)
    .set({
      payload: jsonbWithoutMessageKeys(schema.actions.payload),
      executorResult: jsonbWithoutMessageKeys(schema.actions.executorResult),
    })
    .where(
      inArray(
        schema.actions.id,
        due.map((row) => row.id),
      ),
    )
    .returning({ id: schema.actions.id });
  return updated.length;
}
