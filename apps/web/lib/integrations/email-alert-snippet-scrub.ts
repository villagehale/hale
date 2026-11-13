import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { parentUserIdFromSmsNoteKey } from '~/lib/coach/note-key';

/**
 * VIL-619 · the one-time scrub of sender words that email alerts stored before the private
 * flag. Every `messages.source` of kind `gmail` that still carries `snippet` is rewritten
 * to the ids and `private`, which is true exactly where the snippet was null (a 13+
 * child's mail). Soft-deleted rows are scrubbed too. Running it twice changes nothing.
 *
 * It deletes data, so it runs against prod only with Barton's OK
 * (scripts/scrub-email-alert-snippets.ts). Each (family, audience) pair gets one audit
 * row with the count. A 1:1 SMS thread names that parent as audience; a family thread
 * stays null.
 */

export interface EmailAlertSnippetScrubSummary {
  rows: number;
  /** Rows whose snippet was null, now `private: true`. */
  private: number;
  families: number;
  applied: boolean;
}

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
      returning c.family_id as "familyId",
                (m.source ->> 'private')::boolean as "isPrivate",
                c.note_key as "noteKey"
    `);
    const rows = rowsOf(result);
    const perAudience = new Map<
      string,
      { familyId: string; audience: string | null; count: number }
    >();
    for (const row of rows) {
      const audience = parentUserIdFromSmsNoteKey(row.noteKey ?? null);
      const key = `${row.familyId}\0${audience ?? ''}`;
      const existing = perAudience.get(key);
      if (existing) existing.count += 1;
      else perAudience.set(key, { familyId: row.familyId, audience, count: 1 });
    }
    if (perAudience.size > 0) {
      await tx.insert(schema.auditLog).values(
        [...perAudience.values()].map((group) => ({
          familyId: group.familyId,
          actor: 'system',
          actionTaken: 'email_alert_snippets_scrubbed',
          targetTable: 'messages',
          after: { rows: group.count },
          ...(group.audience ? { audience: group.audience } : {}),
        })),
      );
    }
    return summarize(rows, true);
  });
}

interface ScrubRow {
  familyId: string;
  isPrivate: boolean;
  noteKey?: string | null;
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
