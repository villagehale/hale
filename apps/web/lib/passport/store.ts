import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import {
  type ChildRef,
  type ExistingStamp,
  type GroupProjection,
  type SourceType,
  type StampDraft,
  activityKeyOf,
  canUndo,
  planStampWrite,
  sourceLabel,
  stampFaceDate,
  subjectSnippet,
} from './signals';

const AUDIT_ACTIONS = {
  inferred: 'interest_stamp_inferred',
  confirmed: 'interest_stamp_confirmed',
  edited: 'interest_stamp_edited',
  removed: 'interest_stamp_removed',
  undone: 'interest_stamp_undone',
  shared: 'interest_stamp_shared',
  progress: 'interest_stamp_progress',
  familyShare: 'interest_family_share_set',
  declared: 'interest_stamp_confirmed',
} as const;

export interface AuditShape {
  state: string;
  kind: string;
  sourceType: string;
  shared: boolean;
}

function auditShape(row: {
  state: string;
  kind: string;
  sourceType: string;
  shared: boolean;
}): { [key: string]: string | boolean } {
  return {
    state: row.state,
    kind: row.kind,
    sourceType: row.sourceType,
    shared: row.shared,
  };
}

type InterestRow = typeof schema.kidInterests.$inferSelect;

function existingOf(rows: readonly InterestRow[]): ExistingStamp[] {
  return rows.map((row) => ({
    childId: row.childId,
    activityKey: row.activityKey,
    seasonKey: row.seasonKey,
    sourceRef: row.sourceRef,
    sourceType: row.sourceType as ExistingStamp['sourceType'],
    state: row.state as ExistingStamp['state'],
  }));
}

async function writeAudit(
  database: Database,
  input: {
    familyId: string;
    actor: string;
    action: string;
    targetId: string;
    targetTable?: string;
    after: { [key: string]: string | boolean };
  },
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.actor,
    actionTaken: input.action,
    targetTable: input.targetTable ?? 'kid_interests',
    targetId: input.targetId,
    after: input.after,
  });
}

export interface InferredWrite {
  familyId: string;
  actor: string;
  sourceType: 'gmail' | 'calendar';
  sourceRef: string;
  sourceOwnerUserId: string | null;
  /** Subject line only. A body passed here is not a parameter. */
  subject: string | null;
  seenOn: string | null;
  draft: StampDraft;
  asked: boolean;
  now: Date;
}

export type WriteOutcome =
  | { outcome: 'inserted' | 'updated'; id: string }
  | { outcome: 'skipped'; reason: string };

export async function commitInferredStamp(
  database: Database,
  input: InferredWrite,
): Promise<WriteOutcome> {
  const rows = await database
    .select()
    .from(schema.kidInterests)
    .where(eq(schema.kidInterests.familyId, input.familyId));
  const plan = planStampWrite(existingOf(rows), {
    childId: input.draft.childId,
    activityKey: input.draft.activityKey,
    seasonKey: input.draft.seasonKey,
    sourceRef: input.sourceRef,
    sourceType: input.sourceType,
  });
  if (plan.action === 'skip') return { outcome: 'skipped', reason: plan.reason };

  const subject = input.subject ? subjectSnippet(input.subject) : null;
  const completedAt = input.draft.completed ? input.now : null;

  if (plan.action === 'update_progress') {
    const live = rows.find(
      (row) =>
        row.state !== 'removed' &&
        row.childId === input.draft.childId &&
        ((row.activityKey === input.draft.activityKey && row.seasonKey === input.draft.seasonKey) ||
          row.sourceRef === input.sourceRef),
    );
    if (!live) return { outcome: 'skipped', reason: 'missing' };
    const takeEmail = input.sourceType === 'gmail' && live.sourceType !== 'gmail';
    await database
      .update(schema.kidInterests)
      .set({
        weeksTotal: input.draft.weeksTotal,
        weeksElapsed: input.draft.weeksElapsed,
        sessionStart: input.draft.sessionStart,
        sessionEnd: input.draft.sessionEnd,
        completedAt: completedAt ?? live.completedAt,
        seasonLabel: input.draft.seasonLabel,
        updatedAt: input.now,
        askedAt: input.asked && live.askedAt === null ? input.now : live.askedAt,
        ...(takeEmail
          ? {
              sourceType: 'gmail',
              sourceRef: input.sourceRef,
              sourceSubject: subject,
              sourceOwnerUserId: input.sourceOwnerUserId,
              sourceSeenOn: input.seenOn,
            }
          : {}),
      })
      .where(eq(schema.kidInterests.id, live.id));
    await writeAudit(database, {
      familyId: input.familyId,
      actor: input.actor,
      action: AUDIT_ACTIONS.progress,
      targetId: live.id,
      after: auditShape({ ...live, sourceType: takeEmail ? 'gmail' : live.sourceType }),
    });
    return { outcome: 'updated', id: live.id };
  }

  const inserted = await database
    .insert(schema.kidInterests)
    .values({
      familyId: input.familyId,
      childId: input.draft.childId,
      activity: input.draft.activity,
      activityKey: input.draft.activityKey,
      level: input.draft.level,
      seasonKey: input.draft.seasonKey,
      seasonLabel: input.draft.seasonLabel,
      kind: input.draft.kind,
      state: 'inferred',
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      sourceSubject: subject,
      sourceSeenOn: input.seenOn,
      sourceOwnerUserId: input.sourceOwnerUserId,
      whenLabel: input.draft.whenLabel,
      sessionStart: input.draft.sessionStart,
      sessionEnd: input.draft.sessionEnd,
      weeksTotal: input.draft.weeksTotal,
      weeksElapsed: input.draft.weeksElapsed,
      completedAt,
      askedAt: input.asked ? input.now : null,
      firstSeen: input.now,
      updatedAt: input.now,
    })
    .returning({ id: schema.kidInterests.id });
  const id = inserted[0]?.id;
  if (!id) return { outcome: 'skipped', reason: 'insert_failed' };
  await writeAudit(database, {
    familyId: input.familyId,
    actor: input.actor,
    action: AUDIT_ACTIONS.inferred,
    targetId: id,
    after: auditShape({
      state: 'inferred',
      kind: input.draft.kind,
      sourceType: input.sourceType,
      shared: false,
    }),
  });
  return { outcome: 'inserted', id };
}

async function ownedStamp(
  database: Database,
  familyId: string,
  stampId: string,
): Promise<InterestRow | null> {
  const [row] = await database
    .select()
    .from(schema.kidInterests)
    .where(and(eq(schema.kidInterests.id, stampId), eq(schema.kidInterests.familyId, familyId)));
  return row ?? null;
}

export async function confirmStamp(
  database: Database,
  input: {
    familyId: string;
    actor: string;
    stampId: string;
    childId: string | null;
    activity: string;
    level: string | null;
    whenLabel: string | null;
    now: Date;
  },
): Promise<WriteOutcome> {
  const row = await ownedStamp(database, input.familyId, input.stampId);
  if (!row || row.state === 'removed') return { outcome: 'skipped', reason: 'missing' };
  const edited =
    row.edited ||
    row.activity !== input.activity ||
    row.level !== input.level ||
    row.whenLabel !== input.whenLabel ||
    row.childId !== input.childId;
  await database
    .update(schema.kidInterests)
    .set({
      state: 'confirmed',
      confirmedAt: row.confirmedAt ?? input.now,
      childId: input.childId ?? row.childId,
      activity: input.activity,
      activityKey: activityKeyOf(input.activity),
      level: input.level,
      whenLabel: input.whenLabel,
      edited,
      updatedAt: input.now,
    })
    .where(eq(schema.kidInterests.id, row.id));
  await writeAudit(database, {
    familyId: input.familyId,
    actor: input.actor,
    action: edited ? AUDIT_ACTIONS.edited : AUDIT_ACTIONS.confirmed,
    targetId: row.id,
    after: auditShape({ ...row, state: 'confirmed' }),
  });
  return { outcome: 'updated', id: row.id };
}

export async function removeStamp(
  database: Database,
  input: { familyId: string; actor: string; stampId: string; now: Date },
): Promise<WriteOutcome> {
  const row = await ownedStamp(database, input.familyId, input.stampId);
  if (!row || row.state === 'removed') return { outcome: 'skipped', reason: 'missing' };
  await database
    .update(schema.kidInterests)
    .set({ state: 'removed', removedAt: input.now, updatedAt: input.now })
    .where(eq(schema.kidInterests.id, row.id));
  await writeAudit(database, {
    familyId: input.familyId,
    actor: input.actor,
    action: AUDIT_ACTIONS.removed,
    targetId: row.id,
    after: auditShape({ ...row, state: 'removed' }),
  });
  return { outcome: 'updated', id: row.id };
}

export async function undoRemove(
  database: Database,
  input: { familyId: string; actor: string; stampId: string; now: Date },
): Promise<WriteOutcome> {
  const row = await ownedStamp(database, input.familyId, input.stampId);
  if (!row || !canUndo(row.removedAt, input.now)) return { outcome: 'skipped', reason: 'missing' };
  const state = row.confirmedAt ? 'confirmed' : 'inferred';
  await database
    .update(schema.kidInterests)
    .set({ state, removedAt: null, updatedAt: input.now })
    .where(eq(schema.kidInterests.id, row.id));
  await writeAudit(database, {
    familyId: input.familyId,
    actor: input.actor,
    action: AUDIT_ACTIONS.undone,
    targetId: row.id,
    after: auditShape({ ...row, state }),
  });
  return { outcome: 'updated', id: row.id };
}

export async function setStampShared(
  database: Database,
  input: { familyId: string; actor: string; stampId: string; shared: boolean; now: Date },
): Promise<WriteOutcome> {
  const row = await ownedStamp(database, input.familyId, input.stampId);
  if (!row || row.state === 'removed') return { outcome: 'skipped', reason: 'missing' };
  await database
    .update(schema.kidInterests)
    .set({ shared: input.shared, updatedAt: input.now })
    .where(eq(schema.kidInterests.id, row.id));
  await writeAudit(database, {
    familyId: input.familyId,
    actor: input.actor,
    action: AUDIT_ACTIONS.shared,
    targetId: row.id,
    after: auditShape({ ...row, shared: input.shared }),
  });
  return { outcome: 'updated', id: row.id };
}

export async function setFamilyShare(
  database: Database,
  input: { familyId: string; actor: string; shareWithGroup: boolean; now: Date },
): Promise<void> {
  await database
    .insert(schema.familyInterestSettings)
    .values({
      familyId: input.familyId,
      shareWithGroup: input.shareWithGroup,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: schema.familyInterestSettings.familyId,
      set: { shareWithGroup: input.shareWithGroup, updatedAt: input.now },
    });
  await writeAudit(database, {
    familyId: input.familyId,
    actor: input.actor,
    action: AUDIT_ACTIONS.familyShare,
    targetId: input.familyId,
    targetTable: 'family_interest_settings',
    after: { shared: input.shareWithGroup },
  });
}

export async function savePassportProfile(
  database: Database,
  input: {
    familyId: string;
    actor: string;
    childId: string;
    grade: string | null;
    notes: string | null;
    schoolDayEnds: string | null;
    now: Date;
  },
): Promise<void> {
  const [child] = await database
    .select({ id: schema.children.id })
    .from(schema.children)
    .where(
      and(eq(schema.children.id, input.childId), eq(schema.children.familyId, input.familyId)),
    );
  if (!child) return;
  await database
    .insert(schema.kidPassportProfiles)
    .values({
      childId: input.childId,
      familyId: input.familyId,
      grade: input.grade,
      notes: input.notes,
      schoolDayEnds: input.schoolDayEnds,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: schema.kidPassportProfiles.childId,
      set: {
        grade: input.grade,
        notes: input.notes,
        schoolDayEnds: input.schoolDayEnds,
        updatedAt: input.now,
      },
    });
  await writeAudit(database, {
    familyId: input.familyId,
    actor: input.actor,
    action: AUDIT_ACTIONS.edited,
    targetId: input.childId,
    targetTable: 'kid_passport_profiles',
    after: { state: 'confirmed', kind: 'activity', sourceType: 'parent', shared: false },
  });
}

export async function listFamilyChildren(
  database: Database,
  familyId: string,
  now: Date,
): Promise<ChildRef[]> {
  const rows = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    teenager: deriveStage(row.dateOfBirth, now) === 'teenager',
  }));
}

export function gmailSourceRef(integrationId: string, messageId: string): string {
  return `gmail:${integrationId}:${messageId}`.slice(0, 200);
}

export function calendarSourceRef(
  integrationId: string,
  recurringEventId: string,
  seasonKey: string,
): string {
  return `calendar:${integrationId}:${recurringEventId}:${seasonKey}`.slice(0, 200);
}

export async function integrationOwner(
  database: Database,
  integrationId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ userId: schema.integrations.userId })
    .from(schema.integrations)
    .where(eq(schema.integrations.id, integrationId));
  return row?.userId ?? null;
}

/**
 * A group share arrives as the three-field projection only. `ignoredSubject`
 * is accepted so a caller that still has an email subject cannot persist it.
 */
export async function ingestGroupProjection(
  database: Database,
  input: {
    familyId: string;
    childId: string;
    projection: GroupProjection;
    sharerFirstName: string;
    sourceRef: string;
    now: Date;
    ignoredSubject?: string | null;
  },
): Promise<WriteOutcome> {
  void input.ignoredSubject;
  const draft: StampDraft = {
    kind: 'activity',
    activity: input.projection.activity,
    activityKey: activityKeyOf(input.projection.activity),
    level: null,
    seasonKey: activityKeyOf(input.projection.season),
    seasonLabel: input.projection.season,
    childId: input.childId,
    ask: false,
    weeksTotal: null,
    weeksElapsed: 0,
    sessionStart: null,
    sessionEnd: null,
    completed: false,
    whenLabel: null,
    icon: '',
  };
  const rows = await database
    .select()
    .from(schema.kidInterests)
    .where(eq(schema.kidInterests.familyId, input.familyId));
  const plan = planStampWrite(existingOf(rows), {
    childId: input.childId,
    activityKey: draft.activityKey,
    seasonKey: draft.seasonKey,
    sourceRef: input.sourceRef,
    sourceType: 'group_share',
  });
  if (plan.action !== 'insert')
    return { outcome: 'skipped', reason: plan.action === 'skip' ? plan.reason : 'already_present' };
  const inserted = await database
    .insert(schema.kidInterests)
    .values({
      familyId: input.familyId,
      childId: input.childId,
      activity: draft.activity,
      activityKey: draft.activityKey,
      seasonKey: draft.seasonKey,
      seasonLabel: draft.seasonLabel,
      kind: 'activity',
      state: 'inferred',
      sourceType: 'group_share',
      sourceRef: input.sourceRef,
      sourceSubject: null,
      sharerFirstName: input.sharerFirstName.slice(0, 40),
      firstSeen: input.now,
      updatedAt: input.now,
    })
    .returning({ id: schema.kidInterests.id });
  const id = inserted[0]?.id;
  if (!id) return { outcome: 'skipped', reason: 'insert_failed' };
  await writeAudit(database, {
    familyId: input.familyId,
    actor: 'system',
    action: AUDIT_ACTIONS.inferred,
    targetId: id,
    after: auditShape({
      state: 'inferred',
      kind: 'activity',
      sourceType: 'group_share',
      shared: false,
    }),
  });
  return { outcome: 'inserted', id };
}

export interface ParentIntent {
  intent: 'none' | 'confirm' | 'reassign' | 'remove' | 'declare';
  activity: string | null;
  level: string | null;
  childName: string | null;
  season: string | null;
  kind: 'activity' | 'outing' | null;
  weeks: number | null;
  start: string | null;
  end: string | null;
}

export const EMPTY_INTENT: ParentIntent = {
  intent: 'none',
  activity: null,
  level: null,
  childName: null,
  season: null,
  kind: null,
  weeks: null,
  start: null,
  end: null,
};

function childByName(children: readonly ChildRef[], name: string | null): ChildRef | null {
  if (!name) return null;
  const hit = children.filter((child) => child.name.toLowerCase() === name.trim().toLowerCase());
  return hit.length === 1 ? (hit[0] ?? null) : null;
}

export async function applyParentIntent(
  database: Database,
  input: {
    familyId: string;
    actor: string;
    intent: ParentIntent;
    children: readonly ChildRef[];
    now: Date;
  },
): Promise<{
  applied: boolean;
  acknowledgment: 'confirm' | 'remove' | 'reassign' | 'declare' | null;
}> {
  if (input.intent.intent === 'none') return { applied: false, acknowledgment: null };
  const rows = await database
    .select()
    .from(schema.kidInterests)
    .where(eq(schema.kidInterests.familyId, input.familyId));
  const named = input.intent.activity ? activityKeyOf(input.intent.activity) : null;
  const open = rows.filter((row) => row.state === 'inferred');
  const target =
    (named ? open.find((row) => row.activityKey === named) : null) ??
    (open.length === 1 ? open[0] : null);

  if (input.intent.intent === 'declare') {
    const activity = input.intent.activity?.trim();
    if (!activity) return { applied: false, acknowledgment: null };
    const named = input.intent.childName
      ? childByName(input.children, input.intent.childName)
      : null;
    if (input.intent.childName && !named) return { applied: false, acknowledgment: null };
    const child = named ?? (input.children.length === 1 ? (input.children[0] ?? null) : null);
    if (!child) return { applied: false, acknowledgment: null };
    const weeks =
      input.intent.weeks !== null && input.intent.weeks >= 1 && input.intent.weeks <= 60
        ? input.intent.weeks
        : null;
    const seasonKey = input.intent.season
      ? activityKeyOf(input.intent.season).slice(0, 40)
      : `parent-${input.now.toISOString().slice(0, 7)}`;
    const sourceRef = `parent:${createHash('sha256').update(`${input.familyId}:${activity}:${seasonKey}:${input.now.toISOString()}`).digest('hex').slice(0, 24)}`;
    const plan = planStampWrite(existingOf(rows), {
      childId: child.id,
      activityKey: activityKeyOf(activity),
      seasonKey,
      sourceRef,
      sourceType: 'parent',
    });
    if (plan.action === 'skip') return { applied: false, acknowledgment: null };
    const inserted = await database
      .insert(schema.kidInterests)
      .values({
        familyId: input.familyId,
        childId: child.id,
        activity: activity.slice(0, 80),
        activityKey: activityKeyOf(activity),
        level: input.intent.level,
        seasonKey,
        seasonLabel: (input.intent.season ?? 'This season').slice(0, 40),
        kind: input.intent.kind ?? 'activity',
        state: 'confirmed',
        sourceType: 'parent',
        sourceRef,
        confirmedAt: input.now,
        firstSeen: input.now,
        weeksTotal: weeks,
        weeksElapsed: 0,
        sessionStart: /^\d{4}-\d{2}-\d{2}$/.test(input.intent.start ?? '')
          ? input.intent.start
          : null,
        sessionEnd: /^\d{4}-\d{2}-\d{2}$/.test(input.intent.end ?? '') ? input.intent.end : null,
        updatedAt: input.now,
      })
      .returning({ id: schema.kidInterests.id });
    const id = inserted[0]?.id;
    if (!id) return { applied: false, acknowledgment: null };
    await writeAudit(database, {
      familyId: input.familyId,
      actor: input.actor,
      action: AUDIT_ACTIONS.declared,
      targetId: id,
      after: auditShape({
        state: 'confirmed',
        kind: input.intent.kind ?? 'activity',
        sourceType: 'parent',
        shared: false,
      }),
    });
    return { applied: true, acknowledgment: 'declare' };
  }

  if (!target) return { applied: false, acknowledgment: null };
  if (input.intent.intent === 'confirm') {
    await confirmStamp(database, {
      familyId: input.familyId,
      actor: input.actor,
      stampId: target.id,
      childId: target.childId,
      activity: target.activity,
      level: input.intent.level ?? target.level,
      whenLabel: target.whenLabel,
      now: input.now,
    });
    return { applied: true, acknowledgment: 'confirm' };
  }
  if (input.intent.intent === 'remove') {
    await removeStamp(database, {
      familyId: input.familyId,
      actor: input.actor,
      stampId: target.id,
      now: input.now,
    });
    return { applied: true, acknowledgment: 'remove' };
  }
  const next = childByName(input.children, input.intent.childName);
  if (!next || next.teenager) return { applied: false, acknowledgment: null };
  await database
    .update(schema.kidInterests)
    .set({ childId: next.id, updatedAt: input.now })
    .where(eq(schema.kidInterests.id, target.id));
  await writeAudit(database, {
    familyId: input.familyId,
    actor: input.actor,
    action: AUDIT_ACTIONS.edited,
    targetId: target.id,
    after: auditShape(target),
  });
  return { applied: true, acknowledgment: 'reassign' };
}

export async function latestUnasked(
  database: Database,
  familyId: string,
): Promise<InterestRow | null> {
  const rows = await database
    .select()
    .from(schema.kidInterests)
    .where(eq(schema.kidInterests.familyId, familyId));
  const open = rows
    .filter((row) => row.state === 'inferred' && row.askedAt === null)
    .sort((a, b) => b.firstSeen.getTime() - a.firstSeen.getTime());
  return open[0] ?? null;
}

export async function markAsked(
  database: Database,
  input: { familyId: string; stampId: string; now: Date },
): Promise<void> {
  const row = await ownedStamp(database, input.familyId, input.stampId);
  if (!row || row.askedAt) return;
  await database
    .update(schema.kidInterests)
    .set({ askedAt: input.now, updatedAt: input.now })
    .where(eq(schema.kidInterests.id, row.id));
}

export async function offeredThisSeason(
  database: Database,
  childId: string,
  seasonKey: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.interestNextStepOffers.id })
    .from(schema.interestNextStepOffers)
    .where(
      and(
        eq(schema.interestNextStepOffers.childId, childId),
        eq(schema.interestNextStepOffers.seasonKey, seasonKey),
      ),
    );
  return Boolean(row);
}

export async function recordNextStep(
  database: Database,
  input: { familyId: string; childId: string; seasonKey: string; now: Date },
): Promise<void> {
  await database
    .insert(schema.interestNextStepOffers)
    .values({
      familyId: input.familyId,
      childId: input.childId,
      seasonKey: input.seasonKey,
      offeredAt: input.now,
    })
    .onConflictDoNothing();
}

export function labelForStamp(
  row: InterestRow,
  viewerUserId: string | null,
  ownerFirstName: string | null,
): string {
  const told =
    row.sourceType === 'parent' && row.confirmedAt
      ? stampFaceDate(row.confirmedAt.toISOString().slice(0, 10))
      : null;
  return sourceLabel({
    sourceType: row.sourceType as SourceType,
    viewerIsOwner: row.sourceOwnerUserId !== null && row.sourceOwnerUserId === viewerUserId,
    ownerFirstName,
    sharerFirstName: row.sharerFirstName,
    toldOn: told,
  });
}
