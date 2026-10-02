import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { sameActivityMeetEnabled } from './flag';
import { type LiveOptIn, SAME_ACTIVITY_KINDS, type SameActivityKind } from './match';

const KEY_MAX = 200;

export function parseActivityKey(value: string): string | null {
  const key = value.trim();
  if (key.length < 1 || key.length > KEY_MAX) return null;
  if (key.includes('\n') || key.includes('\r') || key.includes('@')) return null;
  return key;
}

export function parseMessageId(value: string): string | null {
  const id = value.trim();
  if (id.length < 1 || id.length > KEY_MAX) return null;
  if (id.includes('\n') || id.includes('\r')) return null;
  return id;
}

export function parseSameActivityKind(value: string): SameActivityKind | null {
  return (SAME_ACTIVITY_KINDS as readonly string[]).includes(value)
    ? (value as SameActivityKind)
    : null;
}

export type RecordOptInResult =
  | { status: 'skipped'; reason: 'flag_off' }
  | { status: 'refused'; reason: 'invalid_activity' | 'invalid_message' | 'invalid_kind' }
  | { status: 'recorded'; optInId: string }
  | { status: 'already'; optInId: string };

function isUniqueViolation(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: string }).code;
    if (code === '23505') return true;
    if (/duplicate key|unique constraint/i.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function liveRow(
  database: Database,
  input: { familyId: string; activityKey: string; kind: SameActivityKind },
): Promise<{ id: string } | undefined> {
  const [row] = await database
    .select({ id: schema.sameActivityOptIns.id })
    .from(schema.sameActivityOptIns)
    .where(
      and(
        eq(schema.sameActivityOptIns.familyId, input.familyId),
        eq(schema.sameActivityOptIns.activityKey, input.activityKey),
        eq(schema.sameActivityOptIns.kind, input.kind),
        isNull(schema.sameActivityOptIns.revokedAt),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Write this household's yes. Flag off writes nothing and names the skip.
 * The audit row carries the kind and the opaque key — never another family.
 */
export async function recordHouseholdOptIn(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    activityKey: string;
    kind: string;
    messageId: string;
  },
): Promise<RecordOptInResult> {
  if (!sameActivityMeetEnabled()) return { status: 'skipped', reason: 'flag_off' };
  const activityKey = parseActivityKey(input.activityKey);
  if (!activityKey) return { status: 'refused', reason: 'invalid_activity' };
  const messageId = parseMessageId(input.messageId);
  if (!messageId) return { status: 'refused', reason: 'invalid_message' };
  const kind = parseSameActivityKind(input.kind);
  if (!kind) return { status: 'refused', reason: 'invalid_kind' };

  const existing = await liveRow(database, { familyId: input.familyId, activityKey, kind });
  if (existing) return { status: 'already', optInId: existing.id };

  try {
    return await database.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(schema.sameActivityOptIns)
        .values({
          familyId: input.familyId,
          parentUserId: input.parentUserId,
          activityKey,
          kind,
          messageId,
        })
        .returning({ id: schema.sameActivityOptIns.id });
      if (!inserted) throw new Error('same_activity_opt_ins insert returned no row');
      await tx.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: input.parentUserId,
        actionTaken: 'same_activity_opt_in_recorded',
        targetTable: 'same_activity_opt_ins',
        targetId: inserted.id,
        after: { kind, activityKey },
      });
      return { status: 'recorded' as const, optInId: inserted.id };
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = await liveRow(database, { familyId: input.familyId, activityKey, kind });
    if (!raced) throw err;
    return { status: 'already', optInId: raced.id };
  }
}

export type RevokeOptInResult =
  | { status: 'refused'; reason: 'invalid_activity' | 'invalid_kind' }
  | { status: 'revoked' }
  | { status: 'already_off' };

/**
 * Withdrawal works with the flag off. A dark feature must not trap a yes
 * the household already gave.
 */
export async function revokeHouseholdOptIn(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    activityKey: string;
    kind: string;
  },
): Promise<RevokeOptInResult> {
  const activityKey = parseActivityKey(input.activityKey);
  if (!activityKey) return { status: 'refused', reason: 'invalid_activity' };
  const kind = parseSameActivityKind(input.kind);
  if (!kind) return { status: 'refused', reason: 'invalid_kind' };

  return database.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.sameActivityOptIns)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.sameActivityOptIns.familyId, input.familyId),
          eq(schema.sameActivityOptIns.activityKey, activityKey),
          eq(schema.sameActivityOptIns.kind, kind),
          isNull(schema.sameActivityOptIns.revokedAt),
        ),
      )
      .returning({ id: schema.sameActivityOptIns.id });
    if (!updated) return { status: 'already_off' };
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'same_activity_opt_in_revoked',
      targetTable: 'same_activity_opt_ins',
      targetId: updated.id,
      after: { kind, activityKey, revoked: true },
    });
    return { status: 'revoked' };
  });
}

/** This household's live yes only. Other families are not in the predicate. */
export async function loadCallerOptIn(
  database: Database,
  input: { familyId: string; activityKey: string; kind: SameActivityKind },
): Promise<{ id: string } | undefined> {
  return liveRow(database, input);
}

/**
 * Live yeses for one activity and one kind. Call only after the caller has
 * a live row of their own. Columns are the household id and the time — not
 * a parent, a message, a child, or a place.
 */
export async function loadActivityCohort(
  database: Database,
  input: { activityKey: string; kind: SameActivityKind },
): Promise<LiveOptIn[]> {
  const rows = await database
    .select({
      familyId: schema.sameActivityOptIns.familyId,
      createdAt: schema.sameActivityOptIns.createdAt,
    })
    .from(schema.sameActivityOptIns)
    .where(
      and(
        eq(schema.sameActivityOptIns.activityKey, input.activityKey),
        eq(schema.sameActivityOptIns.kind, input.kind),
        isNull(schema.sameActivityOptIns.revokedAt),
      ),
    );
  return rows.map((row) => ({
    familyId: row.familyId,
    activityKey: input.activityKey,
    kind: input.kind,
    createdAtMs: row.createdAt.getTime(),
  }));
}

/**
 * The other parent's stored name, and nothing else. Call only after a mutual
 * match, for that one household. Email, locale, and the message are not read.
 */
export async function loadCounterpartGivenName(
  database: Database,
  input: { familyId: string; activityKey: string; kind: SameActivityKind },
): Promise<string | null> {
  const rows = await database
    .select({ name: schema.users.name })
    .from(schema.sameActivityOptIns)
    .innerJoin(schema.users, eq(schema.users.id, schema.sameActivityOptIns.parentUserId))
    .where(
      and(
        eq(schema.sameActivityOptIns.familyId, input.familyId),
        eq(schema.sameActivityOptIns.activityKey, input.activityKey),
        eq(schema.sameActivityOptIns.kind, input.kind),
        isNull(schema.sameActivityOptIns.revokedAt),
      ),
    )
    .limit(1);
  return rows[0]?.name ?? null;
}
