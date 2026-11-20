import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';

export type ExperienceKind = (typeof schema.GROUP_EXPERIENCE_KINDS)[number];

export interface ExperienceRecord {
  id: string;
  chatId: string;
  familyId: string;
  kind: ExperienceKind;
  subjectKey: string;
  payload: Record<string, unknown>;
}

export interface GroupExperienceStore {
  loadLive(chatId: string, kind: ExperienceKind): Promise<ExperienceRecord | null>;
  loadLiveBySubject(
    chatId: string,
    kind: ExperienceKind,
    subjectKey: string,
  ): Promise<ExperienceRecord | null>;
  upsertLive(input: {
    chatId: string;
    familyId: string;
    kind: ExperienceKind;
    subjectKey: string;
    payload: Record<string, unknown>;
    now: Date;
  }): Promise<ExperienceRecord>;
  patchPayload(id: string, payload: Record<string, unknown>, now: Date): Promise<void>;
  close(id: string, now: Date): Promise<void>;
}

function asKind(value: string): ExperienceKind {
  if ((schema.GROUP_EXPERIENCE_KINDS as readonly string[]).includes(value)) {
    return value as ExperienceKind;
  }
  throw new Error(`linq group experience: unknown kind ${value}`);
}

function fromRow(row: typeof schema.linqGroupExperience.$inferSelect): ExperienceRecord {
  return {
    id: row.id,
    chatId: row.chatId,
    familyId: row.familyId,
    kind: asKind(row.kind),
    subjectKey: row.subjectKey,
    payload: (row.payload ?? {}) as Record<string, unknown>,
  };
}

export function createPostgresGroupExperienceStore(database: Database): GroupExperienceStore {
  return {
    async loadLive(chatId, kind) {
      const [row] = await database
        .select()
        .from(schema.linqGroupExperience)
        .where(
          and(
            eq(schema.linqGroupExperience.chatId, chatId),
            eq(schema.linqGroupExperience.kind, kind),
            isNull(schema.linqGroupExperience.closedAt),
          ),
        )
        .limit(1);
      return row ? fromRow(row) : null;
    },

    async loadLiveBySubject(chatId, kind, subjectKey) {
      const [row] = await database
        .select()
        .from(schema.linqGroupExperience)
        .where(
          and(
            eq(schema.linqGroupExperience.chatId, chatId),
            eq(schema.linqGroupExperience.kind, kind),
            eq(schema.linqGroupExperience.subjectKey, subjectKey),
            isNull(schema.linqGroupExperience.closedAt),
          ),
        )
        .limit(1);
      return row ? fromRow(row) : null;
    },

    async upsertLive(input) {
      const existing = await this.loadLiveBySubject(input.chatId, input.kind, input.subjectKey);
      if (existing) {
        await database
          .update(schema.linqGroupExperience)
          .set({ payload: input.payload, updatedAt: input.now })
          .where(eq(schema.linqGroupExperience.id, existing.id));
        return { ...existing, payload: input.payload };
      }
      const [row] = await database
        .insert(schema.linqGroupExperience)
        .values({
          chatId: input.chatId,
          familyId: input.familyId,
          kind: input.kind,
          subjectKey: input.subjectKey,
          payload: input.payload,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      if (!row) throw new Error('linq group experience: insert returned no row');
      return fromRow(row);
    },

    async patchPayload(id, payload, now) {
      await database
        .update(schema.linqGroupExperience)
        .set({ payload, updatedAt: now })
        .where(eq(schema.linqGroupExperience.id, id));
    },

    async close(id, now) {
      await database
        .update(schema.linqGroupExperience)
        .set({ closedAt: now, updatedAt: now })
        .where(eq(schema.linqGroupExperience.id, id));
    },
  };
}
