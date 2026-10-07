'use server';

import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { requireUserIdForUser, resolveFamilyForUser } from '~/lib/family';
import { addChildAction } from '~/lib/family/children-actions';
import { interestPassportEnabled } from './flag';
import { type ExistingStamp, activityKeyOf, planStampWrite } from './signals';
import {
  confirmStamp,
  removeStamp,
  savePassportProfile,
  setFamilyShare,
  setStampShared,
  undoRemove,
} from './store';

export type PassportActionResult = {
  status: 'saved' | 'preview' | 'off' | 'unauthenticated' | 'missing';
};

function blank(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : null;
}

async function context(): Promise<
  | { status: 'ready'; familyId: string; userId: string; database: ReturnType<typeof db> }
  | { status: 'preview' | 'off' | 'unauthenticated' }
> {
  if (!interestPassportEnabled()) return { status: 'off' };
  if (!process.env.DATABASE_URL || !authConfigured()) return { status: 'preview' };
  const session = await auth();
  const externalId = session?.user?.id;
  if (!externalId) return { status: 'unauthenticated' };
  const database = db();
  const familyId = await resolveFamilyForUser(externalId, database);
  if (!familyId) return { status: 'unauthenticated' };
  const userId = await requireUserIdForUser(externalId, database);
  return { status: 'ready', familyId, userId, database };
}

function refresh(childId: string | null) {
  revalidatePath('/family');
  if (childId) revalidatePath(`/family/${childId}`);
}

export async function confirmStampAction(formData: FormData): Promise<PassportActionResult> {
  return saveStamp(formData, true);
}

export async function saveStampAction(formData: FormData): Promise<PassportActionResult> {
  return saveStamp(formData, false);
}

async function saveStamp(formData: FormData, confirm: boolean): Promise<PassportActionResult> {
  const ctx = await context();
  if (ctx.status !== 'ready') return { status: ctx.status };
  const stampId = blank(formData.get('stampId'));
  const returnChild = blank(formData.get('returnChildId'));
  if (!stampId) return { status: 'missing' };
  const activity = (blank(formData.get('activity')) ?? '').slice(0, 80);
  if (!activity) return { status: 'missing' };
  const level = blank(formData.get('level'))?.slice(0, 40) ?? null;
  const whenLabel = blank(formData.get('when'))?.slice(0, 80) ?? null;
  const requested = blank(formData.get('childId'));
  const now = new Date();
  const [row] = await ctx.database
    .select()
    .from(schema.kidInterests)
    .where(
      and(eq(schema.kidInterests.id, stampId), eq(schema.kidInterests.familyId, ctx.familyId)),
    );
  if (!row) return { status: 'missing' };
  const children = await ctx.database
    .select({ id: schema.children.id })
    .from(schema.children)
    .where(eq(schema.children.familyId, ctx.familyId));
  const childIds =
    requested === 'both'
      ? children.map((child) => child.id)
      : [
          requested && children.some((child) => child.id === requested) ? requested : row.childId,
        ].filter((id): id is string => Boolean(id));
  const primary = childIds[0] ?? row.childId;
  if (confirm || primary) {
    await confirmStamp(ctx.database, {
      familyId: ctx.familyId,
      actor: ctx.userId,
      stampId,
      childId: primary,
      activity,
      level,
      whenLabel,
      now,
    });
  }
  if (!confirm) {
    await setStampShared(ctx.database, {
      familyId: ctx.familyId,
      actor: ctx.userId,
      stampId,
      shared: formData.get('shared') === 'on',
      now,
    });
  }
  const existing = await ctx.database
    .select()
    .from(schema.kidInterests)
    .where(eq(schema.kidInterests.familyId, ctx.familyId));
  const prior: ExistingStamp[] = existing.map((item) => ({
    childId: item.childId,
    activityKey: item.activityKey,
    seasonKey: item.seasonKey,
    sourceRef: item.sourceRef,
    sourceType: item.sourceType as ExistingStamp['sourceType'],
    state: item.state as ExistingStamp['state'],
  }));
  for (const childId of childIds.slice(1)) {
    const sourceRef = `${row.sourceRef}#${childId}`.slice(0, 200);
    const plan = planStampWrite(prior, {
      childId,
      activityKey: activityKeyOf(activity),
      seasonKey: row.seasonKey,
      sourceRef,
      sourceType: row.sourceType as ExistingStamp['sourceType'],
    });
    if (plan.action !== 'insert') continue;
    await ctx.database.insert(schema.kidInterests).values({
      familyId: ctx.familyId,
      childId,
      activity,
      activityKey: activityKeyOf(activity),
      level,
      seasonKey: row.seasonKey,
      seasonLabel: row.seasonLabel,
      kind: row.kind,
      state: 'confirmed',
      shared: false,
      sourceType: row.sourceType,
      sourceRef,
      sourceSubject: row.sourceSubject,
      sourceSeenOn: row.sourceSeenOn,
      sourceOwnerUserId: row.sourceOwnerUserId,
      whenLabel,
      confirmedAt: now,
      firstSeen: now,
      updatedAt: now,
    });
    await ctx.database.insert(schema.auditLog).values({
      familyId: ctx.familyId,
      actor: ctx.userId,
      actionTaken: 'interest_stamp_confirmed',
      targetTable: 'kid_interests',
      targetId: stampId,
      after: { state: 'confirmed', kind: row.kind, sourceType: row.sourceType, shared: false },
    });
  }
  refresh(returnChild);
  return { status: 'saved' };
}

export async function removeStampAction(formData: FormData): Promise<void> {
  const ctx = await context();
  if (ctx.status !== 'ready') return;
  const stampId = blank(formData.get('stampId'));
  if (!stampId) return;
  await removeStamp(ctx.database, {
    familyId: ctx.familyId,
    actor: ctx.userId,
    stampId,
    now: new Date(),
  });
  refresh(blank(formData.get('childId')));
}

export async function undoStampAction(formData: FormData): Promise<void> {
  const ctx = await context();
  if (ctx.status !== 'ready') return;
  const stampId = blank(formData.get('stampId'));
  if (!stampId) return;
  await undoRemove(ctx.database, {
    familyId: ctx.familyId,
    actor: ctx.userId,
    stampId,
    now: new Date(),
  });
  refresh(blank(formData.get('childId')));
}

export async function shareStampAction(formData: FormData): Promise<void> {
  const ctx = await context();
  if (ctx.status !== 'ready') return;
  const stampId = blank(formData.get('stampId'));
  if (!stampId) return;
  await setStampShared(ctx.database, {
    familyId: ctx.familyId,
    actor: ctx.userId,
    stampId,
    shared: formData.get('shared') === 'true',
    now: new Date(),
  });
  refresh(blank(formData.get('childId')));
}

export async function familyShareAction(formData: FormData): Promise<void> {
  const ctx = await context();
  if (ctx.status !== 'ready') return;
  await setFamilyShare(ctx.database, {
    familyId: ctx.familyId,
    actor: ctx.userId,
    shareWithGroup: formData.get('share') === 'true',
    now: new Date(),
  });
  refresh(null);
}

export async function saveBasicsAction(formData: FormData): Promise<void> {
  const ctx = await context();
  if (ctx.status !== 'ready') return;
  const childId = blank(formData.get('childId'));
  if (!childId) return;
  await savePassportProfile(ctx.database, {
    familyId: ctx.familyId,
    actor: ctx.userId,
    childId,
    grade: blank(formData.get('grade'))?.slice(0, 40) ?? null,
    notes: blank(formData.get('notes'))?.replace(/\n/g, ' ').slice(0, 500) ?? null,
    schoolDayEnds: blank(formData.get('schoolDayEnds'))?.slice(0, 40) ?? null,
    now: new Date(),
  });
  refresh(childId);
}

export async function addPassportChildAction(formData: FormData): Promise<void> {
  if (!interestPassportEnabled()) return;
  await addChildAction({
    name: String(formData.get('name') ?? ''),
    dateOfBirth: String(formData.get('dateOfBirth') ?? ''),
  });
}
