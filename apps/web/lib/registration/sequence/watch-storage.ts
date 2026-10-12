import { type Database, REGISTRATION_COURSE_URL_MAX_CHARS, schema } from '@hale/db';
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { LiveRegistrationReading } from '../live-reading';

/** Storage only: accepting a URL does not authorize reminders or make it safe to fetch.
 * The live-reader's network boundary must still validate the target before each fetch. */
export async function claimRegistrationWatch(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    childId?: string | null;
    sourceUrl: string;
    now: Date;
  },
): Promise<{ sequenceId: string; created: boolean }> {
  const url = new URL(input.sourceUrl);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('registration watch: expected a credential-free HTTPS URL');
  }
  const sourceUrl = url.toString();
  if (sourceUrl.length > REGISTRATION_COURSE_URL_MAX_CHARS) {
    throw new Error('registration watch: URL too long');
  }
  return database.transaction(async (tx) => {
    const [parent] = await tx
      .select({ id: schema.familyMembers.userId })
      .from(schema.familyMembers)
      .where(
        and(
          eq(schema.familyMembers.familyId, input.familyId),
          eq(schema.familyMembers.userId, input.parentUserId),
          inArray(schema.familyMembers.role, ['primary_parent', 'co_parent']),
        ),
      )
      .limit(1);
    if (!parent) throw new Error('registration watch: parent outside family');
    if (input.childId) {
      const [child] = await tx
        .select({ id: schema.children.id })
        .from(schema.children)
        .where(
          and(eq(schema.children.familyId, input.familyId), eq(schema.children.id, input.childId)),
        )
        .limit(1);
      if (!child) throw new Error('registration watch: child outside family');
    }
    const active = and(
      eq(schema.registrationSequences.familyId, input.familyId),
      eq(schema.registrationSequences.courseUrl, sourceUrl),
      or(
        isNull(schema.registrationSequences.outcome),
        eq(schema.registrationSequences.outcome, 'waitlisted'),
      ),
    );
    const findExisting = async () => {
      const [row] = await tx
        .select({ id: schema.registrationSequences.id })
        .from(schema.registrationSequences)
        .where(active)
        .orderBy(desc(schema.registrationSequences.createdAt))
        .limit(1);
      return row;
    };
    const existing = await findExisting();
    let sequenceId = existing?.id;
    let created = false;
    if (!existing) {
      const [inserted] = await tx
        .insert(schema.registrationSequences)
        .values({
          familyId: input.familyId,
          parentUserId: input.parentUserId,
          childId: input.childId ?? null,
          courseUrl: sourceUrl,
          nextCheckAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing({
          target: [schema.registrationSequences.familyId, schema.registrationSequences.courseUrl],
          where: sql`${schema.registrationSequences.windowId} IS NULL AND (${schema.registrationSequences.outcome} IS NULL OR ${schema.registrationSequences.outcome} = 'waitlisted')`,
        })
        .returning({ id: schema.registrationSequences.id });
      sequenceId = inserted?.id ?? (await findExisting())?.id;
      created = inserted !== undefined;
    }
    if (!sequenceId) throw new Error('registration watch: claim returned no row');
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: created ? 'registration_watch_created' : 'registration_watch_reused',
      targetTable: 'registration_sequences',
      targetId: sequenceId,
      after: { sourceHost: url.hostname },
      occurredAt: input.now,
    });
    return { sequenceId, created };
  });
}

/** Persist observations, not a scheduling decision. A failed read cannot clear a
 * cached anchor or a pending notification; the refresh/send phase owns those changes. */
export async function recordRegistrationRead(
  database: Database,
  input: {
    familyId: string;
    sequenceId: string;
    reading: LiveRegistrationReading;
    nextCheckAt: Date;
  },
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.registrationSequences)
      .set({
        lastReading: { ...input.reading, checkedAt: input.reading.checkedAt.toISOString() },
        lastReadAt: input.reading.checkedAt,
        nextCheckAt: input.nextCheckAt,
        updatedAt: input.reading.checkedAt,
      })
      .where(
        and(
          eq(schema.registrationSequences.id, input.sequenceId),
          eq(schema.registrationSequences.familyId, input.familyId),
          eq(schema.registrationSequences.courseUrl, input.reading.sourceUrl),
          or(
            isNull(schema.registrationSequences.lastReadAt),
            lte(schema.registrationSequences.lastReadAt, input.reading.checkedAt),
          ),
        ),
      )
      .returning({ id: schema.registrationSequences.id });
    if (!row) return false;
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'registration_watch_read',
      targetTable: 'registration_sequences',
      targetId: row.id,
      after: {
        reader: input.reading.reader,
        status: input.reading.status,
        checkedAt: input.reading.checkedAt.toISOString(),
      },
      occurredAt: input.reading.checkedAt,
    });
    return true;
  });
}
