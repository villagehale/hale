import { type Database, schema } from '@hale/db';
import { and, asc, eq } from 'drizzle-orm';
import { channelSmsNoteKey } from '~/lib/coach/note-key';

/**
 * The part of a right-to-access copy that is about the requesting adult alone: their 1:1
 * text thread with Hale, the language Hale writes to them in, and each time that changed.
 *
 * Every read here is keyed on the requester, so nothing in this block can be about the
 * co-parent: the thread by its per-parent note key (note-key.ts), the settings by the
 * requester's own `users` row, and the language changes by the requester as actor. The
 * family-wide copy leaves `parent_language_changed` out for every parent
 * (NOT_IN_FAMILY_EXPORT), so this block is the only place those rows reach anyone.
 *
 * The thread keeps a turn the parent removed, stamped `removedAt`: Hale still holds its
 * words, and this copy goes only to the person who wrote or received them. The model
 * context a proactive turn carries (`messages.source`) is not part of it.
 */
export interface RequesterOnlyExport {
  textThread: {
    role: 'user' | 'assistant';
    content: string;
    topic: string | null;
    sentAt: string;
    removedAt: string | null;
  }[];
  /** Null `proactiveLanguage` means Hale writes in the family's primary language. */
  language: {
    proactiveLanguage: string | null;
    languageStreakTag: string | null;
    languageStreakCount: number;
  };
  languageChanges: {
    changedAt: string;
    from: string | null;
    to: string | null;
    why: string | null;
  }[];
}

function field(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === 'string' ? entry : null;
}

export async function loadRequesterOnlyExport(
  database: Database,
  familyId: string,
  requesterUserId: string,
): Promise<RequesterOnlyExport> {
  const [user] = await database
    .select({
      proactiveLanguage: schema.users.proactiveLanguage,
      languageStreakTag: schema.users.languageStreakTag,
      languageStreakCount: schema.users.languageStreakCount,
    })
    .from(schema.users)
    .where(eq(schema.users.id, requesterUserId))
    .limit(1);
  if (!user) {
    throw new Error('loadRequesterOnlyExport: no user row for the requester');
  }

  const turns = await database
    .select({
      role: schema.messages.role,
      content: schema.messages.content,
      topic: schema.messages.topic,
      createdAt: schema.messages.createdAt,
      deletedAt: schema.messages.deletedAt,
    })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(
      and(
        eq(schema.conversations.familyId, familyId),
        eq(schema.conversations.noteKey, channelSmsNoteKey(requesterUserId)),
      ),
    )
    .orderBy(asc(schema.messages.createdAt));

  const changes = await database
    .select({
      before: schema.auditLog.before,
      after: schema.auditLog.after,
      occurredAt: schema.auditLog.occurredAt,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'parent_language_changed'),
        eq(schema.auditLog.actor, requesterUserId),
      ),
    )
    .orderBy(asc(schema.auditLog.occurredAt));

  return {
    textThread: turns.map((turn) => ({
      role: turn.role,
      content: turn.content,
      topic: turn.topic,
      sentAt: turn.createdAt.toISOString(),
      removedAt: turn.deletedAt?.toISOString() ?? null,
    })),
    language: user,
    languageChanges: changes.map((row) => ({
      changedAt: row.occurredAt.toISOString(),
      from: field(row.before, 'language'),
      to: field(row.after, 'language'),
      why: field(row.after, 'why'),
    })),
  };
}
