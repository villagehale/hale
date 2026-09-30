import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import { normalizeSession } from './forms/details';
import type { BusyInterval, SignupIdentity, SignupOffer, SignupSession } from './types';
import { registrationUrlAllowed } from './url';

const KEY = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;

export type RecordOfferResult = { ok: true; id: string } | { ok: false; reason: string };

export async function recordSignupOffer(
  database: Database,
  input: {
    familyId: string;
    childId: string;
    parentUserId: string;
    activityKey: string;
    registrationUrl: string;
    sessions: SignupSession[];
    approvedPriceCents: number | null;
    now: Date;
  },
): Promise<RecordOfferResult> {
  if (!KEY.test(input.activityKey)) return { ok: false, reason: 'activity_key' };
  if (!registrationUrlAllowed(input.registrationUrl).ok)
    return { ok: false, reason: 'url_refused' };
  if (input.sessions.length === 0 || input.sessions.length > 12) {
    return { ok: false, reason: 'sessions' };
  }
  const sessions = input.sessions.map((session) => normalizeSession(session));
  if (
    sessions.some(
      (session) => session === null || !KEY.test(session.id) || session.label.trim().length === 0,
    )
  ) {
    return { ok: false, reason: 'sessions' };
  }
  const [child] = await database
    .select({ id: schema.children.id })
    .from(schema.children)
    .where(and(eq(schema.children.id, input.childId), eq(schema.children.familyId, input.familyId)))
    .limit(1);
  if (!child) return { ok: false, reason: 'child_missing' };
  const pending = await loadPendingOffer(database, input.familyId);
  if (pending) return { ok: false, reason: 'offer_exists' };
  const [row] = await database
    .insert(schema.authorizedSignupOffers)
    .values({
      familyId: input.familyId,
      childId: input.childId,
      parentUserId: input.parentUserId,
      activityKey: input.activityKey,
      registrationUrl: input.registrationUrl,
      sessions: sessions.filter((session): session is SignupSession => session !== null),
      approvedPriceCents: input.approvedPriceCents,
      status: 'pending',
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: schema.authorizedSignupOffers.id });
  if (!row) return { ok: false, reason: 'not_stored' };
  return { ok: true, id: row.id };
}

export async function loadPendingOffer(
  database: Database,
  familyId: string,
): Promise<SignupOffer | null> {
  const [row] = await database
    .select({
      id: schema.authorizedSignupOffers.id,
      familyId: schema.authorizedSignupOffers.familyId,
      childId: schema.authorizedSignupOffers.childId,
      activityKey: schema.authorizedSignupOffers.activityKey,
      registrationUrl: schema.authorizedSignupOffers.registrationUrl,
      sessions: schema.authorizedSignupOffers.sessions,
      approvedPriceCents: schema.authorizedSignupOffers.approvedPriceCents,
      status: schema.authorizedSignupOffers.status,
    })
    .from(schema.authorizedSignupOffers)
    .where(
      and(
        eq(schema.authorizedSignupOffers.familyId, familyId),
        eq(schema.authorizedSignupOffers.status, 'pending'),
      ),
    )
    .limit(1);
  if (!row || row.familyId !== familyId || row.status !== 'pending') return null;
  return {
    id: row.id,
    familyId: row.familyId,
    childId: row.childId,
    activityKey: row.activityKey,
    registrationUrl: row.registrationUrl,
    sessions: row.sessions,
    approvedPriceCents: row.approvedPriceCents,
  };
}

export async function markOffer(
  database: Database,
  input: {
    offerId: string;
    familyId: string;
    from: 'pending' | 'submitting';
    status: 'submitting' | 'completed' | 'handed_back';
    sessionId?: string | null;
    messageId?: string | null;
    now: Date;
  },
): Promise<boolean> {
  const patch: {
    status: string;
    updatedAt: Date;
    authorizedSessionId?: string | null;
    authorizingMessageId?: string | null;
  } = { status: input.status, updatedAt: input.now };
  if (input.sessionId !== undefined) patch.authorizedSessionId = input.sessionId;
  if (input.messageId !== undefined) patch.authorizingMessageId = input.messageId;
  const rows = await database
    .update(schema.authorizedSignupOffers)
    .set(patch)
    .where(
      and(
        eq(schema.authorizedSignupOffers.id, input.offerId),
        eq(schema.authorizedSignupOffers.familyId, input.familyId),
        eq(schema.authorizedSignupOffers.status, input.from),
      ),
    )
    .returning({ id: schema.authorizedSignupOffers.id });
  return rows.length > 0;
}

export async function loadSignupIdentity(
  database: Database,
  input: { familyId: string; childId: string; parentUserId: string; now: Date },
): Promise<SignupIdentity | null> {
  const [child] = await database
    .select({
      name: schema.children.name,
      lastName: schema.children.lastName,
      dateOfBirth: schema.children.dateOfBirth,
      dobPrecision: schema.children.dobPrecision,
      familyId: schema.children.familyId,
    })
    .from(schema.children)
    .where(and(eq(schema.children.id, input.childId), eq(schema.children.familyId, input.familyId)))
    .limit(1);
  if (!child || child.familyId !== input.familyId) return null;
  const [parent] = await database
    .select({ name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, input.parentUserId))
    .limit(1);
  const [family] = await database
    .select({ postalCode: schema.families.postalCode, id: schema.families.id })
    .from(schema.families)
    .where(eq(schema.families.id, input.familyId))
    .limit(1);
  if (!family || family.id !== input.familyId) return null;
  const teenager = deriveStage(child.dateOfBirth, input.now) === 'teenager';
  return {
    childFirstName: child.name,
    childLastName: child.lastName,
    childDob: child.dobPrecision === 'exact' ? child.dateOfBirth : null,
    parentFirstName: parent?.name ?? null,
    parentEmail: parent?.email ?? null,
    postalCode: family.postalCode,
    teenager,
  };
}

export async function loadBusy(database: Database, familyId: string): Promise<BusyInterval[]> {
  const rows = await database
    .select({
      startAt: schema.parentCalendarBlocks.startAt,
      endAt: schema.parentCalendarBlocks.endAt,
      familyId: schema.parentCalendarBlocks.familyId,
    })
    .from(schema.parentCalendarBlocks)
    .where(eq(schema.parentCalendarBlocks.familyId, familyId));
  return rows.flatMap((row) => {
    if (row.familyId !== familyId || !row.startAt || !row.endAt) return [];
    return [{ startsAt: row.startAt.toISOString(), endsAt: row.endAt.toISOString() }];
  });
}
