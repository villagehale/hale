import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';

/**
 * VIL-619 · the one-time scrub of sender words that email alerts stored before the private
 * flag. Every `messages.source` of kind `gmail` that still carries `snippet` is rewritten
 * to the ids and `private`, which is true exactly where the snippet was null (a 13+
 * child's mail). Soft-deleted rows are scrubbed too. Running it twice changes nothing.
 *
 * It deletes data, so it runs against prod only with Barton's OK
 * (scripts/scrub-email-alert-snippets.ts). Each family gets one audit row with the count.
 * The count covers the whole family's threads, so no row says which adult had alerts.
 */

export interface EmailAlertSnippetScrubSummary {
  rows: number;
  /** Rows whose snippet was null, now `private: true`. */
  private: number;
  families: number;
  applied: boolean;
}

export const EMAIL_ALERT_SNIPPET_SCRUB_ACTION = 'email_alert_snippets_scrubbed';

const HAS_SNIPPET = sql`m.source ->> 'kind' = 'gmail' and m.source -> 'snippet' is not null`;

export async function scrubEmailAlertSnippets(
  database: Database,
  options: { apply: boolean },
): Promise<EmailAlertSnippetScrubSummary> {
  if (!options.apply) {
    const result = await database.execute(sql`
      select c.family_id as "familyId",
             jsonb_typeof(m.source -> 'snippet') = 'null' as "isPrivate"
      from messages m
      join conversations c on c.id = m.conversation_id
      where ${HAS_SNIPPET}
    `);
    return summarize(rowsOf(result), false);
  }

  return database.transaction(async (tx) => {
    const result = await tx.execute(sql`
      update messages m
      set source = jsonb_build_object(
        'kind', 'gmail',
        'eventId', m.source -> 'eventId',
        'gmailMessageId', m.source -> 'gmailMessageId',
        'private', jsonb_typeof(m.source -> 'snippet') = 'null'
      )
      from conversations c
      where c.id = m.conversation_id and ${HAS_SNIPPET}
      returning c.family_id as "familyId", (m.source ->> 'private')::boolean as "isPrivate"
    `);
    const rows = rowsOf(result);
    const perFamily = new Map<string, number>();
    for (const row of rows) perFamily.set(row.familyId, (perFamily.get(row.familyId) ?? 0) + 1);
    if (perFamily.size > 0) {
      await tx.insert(schema.auditLog).values(
        [...perFamily].map(([familyId, count]) => ({
          familyId,
          actor: 'system',
          actionTaken: EMAIL_ALERT_SNIPPET_SCRUB_ACTION,
          targetTable: 'messages',
          after: { rows: count },
        })),
      );
    }
    return summarize(rows, true);
  });
}

interface ScrubRow {
  familyId: string;
  isPrivate: boolean;
}

function rowsOf(result: unknown): ScrubRow[] {
  return (Array.isArray(result) ? result : (result as { rows: ScrubRow[] }).rows) as ScrubRow[];
}

function summarize(rows: ScrubRow[], applied: boolean): EmailAlertSnippetScrubSummary {
  return {
    rows: rows.length,
    private: rows.filter((row) => row.isPrivate).length,
    families: new Set(rows.map((row) => row.familyId)).size,
    applied,
  };
}
