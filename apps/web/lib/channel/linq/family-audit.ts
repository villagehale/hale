import { type Database, schema } from '@hale/db';
import { type SQL, and, or, sql } from 'drizzle-orm';
import { linqChatBlindIndex } from '~/lib/crypto/blind-index';

/**
 * What a Linq row in audit_log may say. audit_log is immutable and every adult in the
 * family gets a copy, so a row names a chat by its keyed index, never the raw Linq id,
 * and a refused seat says only `number_unavailable` when the reason is another household.
 * The precise reason stays in the caller's outcome and its counts-only log.
 */

/** The `after` field a Linq audit row names its chat with. */
export function linqChatAuditKey(chatId: string): { chatKey: string } {
  return { chatKey: linqChatBlindIndex(chatId) };
}

/**
 * The chat a Linq audit row names, as its key. A row written before the key carries the
 * raw chat id, which is keyed here: audit rows are never rewritten. Null when the row
 * names no chat.
 */
export function auditRowChatKey(after: unknown): string | null {
  if (typeof after !== 'object' || after === null) return null;
  const row = after as { chatKey?: unknown; chatId?: unknown };
  if (typeof row.chatKey === 'string') return row.chatKey;
  return typeof row.chatId === 'string' ? linqChatBlindIndex(row.chatId) : null;
}

/** SQL: this audit row names this chat, by key or by an older row's raw id. */
export function auditRowNamesChat(chatId: string): SQL {
  return or(
    sql`${schema.auditLog.after}->>'chatKey' = ${linqChatBlindIndex(chatId)}`,
    sql`${schema.auditLog.after}->>'chatId' = ${chatId}`,
  ) as SQL;
}

/** SQL: this audit row names no chat at all. */
export function auditRowNamesNoChat(): SQL {
  return and(
    sql`${schema.auditLog.after}->>'chatKey' is null`,
    sql`${schema.auditLog.after}->>'chatId' is null`,
  ) as SQL;
}

const OTHER_HOUSEHOLD = ['other_family', 'other_chat', 'opted_out_elsewhere'] as const;
type OtherHouseholdReason = (typeof OTHER_HOUSEHOLD)[number];

function isOtherHousehold(reason: string): reason is OtherHouseholdReason {
  return (OTHER_HOUSEHOLD as readonly string[]).includes(reason);
}

/**
 * Writes a `linq_group_member_refused` row. A reason about another household (its family,
 * its chat, its STOP) reaches this family's row only as `number_unavailable`.
 */
export async function recordSeatRefusal<R extends string>(
  database: Database,
  row: {
    familyId: string;
    actor: string;
    targetTable: string;
    targetId: string;
    reason: R;
    via?: string;
  },
): Promise<void> {
  const reason = isOtherHousehold(row.reason) ? 'number_unavailable' : row.reason;
  await database.insert(schema.auditLog).values({
    familyId: row.familyId,
    actor: row.actor,
    actionTaken: 'linq_group_member_refused',
    targetTable: row.targetTable,
    targetId: row.targetId,
    after: row.via ? { reason, via: row.via } : { reason },
  });
}
