import { type Database, schema } from '@hale/db';
import { autonomyActedDedupeKey, autonomyArmedDedupeKey } from '@hale/worker/memory-writer';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  MAX_REDRIVE_PER_RUN,
  REDRIVE_MAX_AGE_MS,
  isRedriveSlot,
  redriveParentTimeZone,
} from '~/lib/channel/redrive-slot';
import {
  type AutonomyNoticeOutcome,
  type AutonomyNoticePorts,
  type OpenAutonomyObligation,
  autonomousLaneOn,
  claimedAutonomyNoticeKeys,
  tellParentOpenNotices,
} from './notice';

/**
 * Open turn-on texts and on-its-own notices.
 *
 * The obligation is the audit row (the grant, or the autonomous execution), not the
 * suppression: a quiet-hours hold and a crash before the send are both still owed.
 * A turn-on text is owed for as long as the grant is live and undelivered. An
 * on-its-own notice older than the redrive window is marked and not sent, once.
 * One parent gets one text this pass, and that text covers every notice still open
 * for them. Armed is listed before acted, so a turn-on is the first item. Every
 * dedupe key in the text is claimed when it sends. Nothing inside the window is
 * left for a later pass, and nothing inside the window is aged out. Each live
 * parent is still a recipient of an on-its-own notice.
 * The morning pass only sends inside the re-drive hour. The drain pass tries
 * now, including right after an execution, and the gate holds quiet hours.
 * Nothing sends while the execute lane is off.
 */

interface OpenArmed {
  kind: 'armed';
  familyId: string;
  parentUserId: string;
  consentRecordId: string;
  actionType: string;
}

interface OpenActed {
  kind: 'acted';
  familyId: string;
  parentUserId: string;
  actionId: string;
  actionType: string;
}

type OpenNotice = OpenArmed | OpenActed;

interface AgedActed {
  familyId: string;
  actionId: string;
  parentUserId: string;
}

export interface AutonomyNoticeDispatchResult {
  open: number;
  due: number;
  deferred: number;
  sent: number;
  alreadySent: number;
  heldAgain: number;
  refused: number;
  dark: number;
  composeSkipped: number;
  sendFailed: number;
  noSendTarget: number;
  /** Open notices left unsent because the execute lane is not exactly `true`. */
  laneOff: number;
  /** On-its-own notices marked this pass as older than the redrive window. */
  agedOut: number;
}

export function emptyAutonomyNoticeDispatch(): AutonomyNoticeDispatchResult {
  return {
    open: 0,
    due: 0,
    deferred: 0,
    sent: 0,
    alreadySent: 0,
    heldAgain: 0,
    refused: 0,
    dark: 0,
    composeSkipped: 0,
    sendFailed: 0,
    noSendTarget: 0,
    laneOff: 0,
    agedOut: 0,
  };
}

function countOutcome(result: AutonomyNoticeDispatchResult, outcome: AutonomyNoticeOutcome): void {
  if (outcome === 'sent') result.sent += 1;
  else if (outcome === 'already_sent') result.alreadySent += 1;
  else if (outcome === 'lane_off') result.laneOff += 1;
  else if (outcome === 'dark') result.dark += 1;
  else if (outcome === 'no_send_target') result.noSendTarget += 1;
  else if (outcome === 'send_failed') result.sendFailed += 1;
  else if (outcome.startsWith('compose_skipped:')) result.composeSkipped += 1;
  else if (outcome === 'gate_refused:quiet_hours') result.heldAgain += 1;
  else result.refused += 1;
}

async function claimedKeys(database: Database, keys: string[]): Promise<Set<string>> {
  return claimedAutonomyNoticeKeys(database, keys);
}

async function agedOutMarks(database: Database, actionIds: string[]): Promise<Set<string>> {
  if (actionIds.length === 0) return new Set();
  const rows = await database
    .select({ targetId: schema.auditLog.targetId, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, 'autonomy_acted_notice_aged_out'),
        inArray(schema.auditLog.targetId, actionIds),
      ),
    );
  const keys = new Set<string>();
  for (const row of rows) {
    if (!row.targetId) continue;
    const after = row.after as { parentUserId?: unknown } | null;
    if (typeof after?.parentUserId !== 'string') continue;
    keys.add(`${row.targetId}:${after.parentUserId}`);
  }
  return keys;
}

export async function selectOpenAutonomyNotices(
  database: Database,
  now: Date,
  familyId?: string,
): Promise<{ notices: OpenNotice[]; aged: AgedActed[] }> {
  const armed = await selectLiveArmed(database, familyId);
  const since = new Date(now.getTime() - REDRIVE_MAX_AGE_MS);
  const executions = await database
    .select({
      familyId: schema.auditLog.familyId,
      actionId: schema.auditLog.targetId,
      occurredAt: schema.auditLog.occurredAt,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, 'action.executed'),
        eq(schema.auditLog.targetTable, 'actions'),
        isNotNull(schema.auditLog.targetId),
        sql`${schema.auditLog.after} -> 'decision' ->> 'source' = 'autonomous'`,
        familyId ? eq(schema.auditLog.familyId, familyId) : undefined,
      ),
    )
    .orderBy(asc(schema.auditLog.occurredAt));

  const actedRows: Array<OpenActed & { occurredAt: Date }> = [];
  for (const row of executions) {
    if (!row.actionId) continue;
    const actionType = await actionTypeOf(database, row.actionId);
    if (!actionType) continue;
    const parentUserIds = await recipientsForActed(database, row.familyId, actionType);
    for (const parentUserId of parentUserIds) {
      actedRows.push({
        kind: 'acted',
        familyId: row.familyId,
        parentUserId,
        actionId: row.actionId,
        actionType,
        occurredAt: row.occurredAt,
      });
    }
  }

  const keys = [
    ...armed.map((row) => autonomyArmedDedupeKey(row.consentRecordId)),
    ...actedRows.map((row) => autonomyActedDedupeKey(row.actionId, row.parentUserId)),
  ];
  const claimed = await claimedKeys(database, keys);
  const marked = await agedOutMarks(database, [...new Set(actedRows.map((row) => row.actionId))]);
  const openArmed = armed.filter(
    (row) => !claimed.has(autonomyArmedDedupeKey(row.consentRecordId)),
  );
  const openActed: OpenActed[] = [];
  const aged: AgedActed[] = [];
  for (const row of actedRows) {
    const key = autonomyActedDedupeKey(row.actionId, row.parentUserId);
    if (claimed.has(key)) continue;
    if (marked.has(`${row.actionId}:${row.parentUserId}`)) continue;
    if (row.occurredAt.getTime() < since.getTime()) {
      aged.push({
        familyId: row.familyId,
        actionId: row.actionId,
        parentUserId: row.parentUserId,
      });
      continue;
    }
    openActed.push({
      kind: 'acted',
      familyId: row.familyId,
      parentUserId: row.parentUserId,
      actionId: row.actionId,
      actionType: row.actionType,
    });
  }
  return { notices: [...openArmed, ...openActed], aged };
}

/**
 * Live grants for a kind. A switch-off by either parent ends every grant before
 * it (revokeAutonomyForKind is the only writer of granted=false). Above it,
 * each parent's newest row decides for them. No age limit: a text that was
 * never delivered is still owed, including one written while the lane was off.
 */
async function selectLiveArmed(database: Database, familyId?: string): Promise<OpenArmed[]> {
  const rows = await database
    .select({
      id: schema.consentRecords.id,
      familyId: schema.consentRecords.familyId,
      userId: schema.consentRecords.userId,
      scope: schema.consentRecords.consentScope,
      granted: schema.consentRecords.granted,
      revokedAt: schema.consentRecords.revokedAt,
      grantedAt: schema.consentRecords.grantedAt,
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.consentType, 'autonomous_action_class'),
        familyId ? eq(schema.consentRecords.familyId, familyId) : undefined,
      ),
    )
    .orderBy(
      desc(schema.consentRecords.grantedAt),
      asc(schema.consentRecords.granted),
      desc(schema.consentRecords.id),
    );

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.familyId}:${row.scope ?? ''}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const armed: Array<OpenArmed & { grantedAt: Date }> = [];
  for (const list of groups.values()) {
    const decided = new Set<string>();
    for (const row of list) {
      if (!row.granted) break;
      if (!row.familyId || !row.scope) continue;
      if (decided.has(row.userId)) continue;
      decided.add(row.userId);
      if (row.revokedAt !== null) continue;
      armed.push({
        kind: 'armed',
        familyId: row.familyId,
        parentUserId: row.userId,
        consentRecordId: row.id,
        actionType: row.scope,
        grantedAt: row.grantedAt,
      });
    }
  }
  armed.sort((a, b) => a.grantedAt.getTime() - b.grantedAt.getTime());
  return armed.map((row) => ({
    kind: row.kind,
    familyId: row.familyId,
    parentUserId: row.parentUserId,
    consentRecordId: row.consentRecordId,
    actionType: row.actionType,
  }));
}

async function actionTypeOf(database: Database, actionId: string): Promise<string | null> {
  const rows = await database
    .select({ actionType: schema.actions.actionType })
    .from(schema.actions)
    .where(eq(schema.actions.id, actionId))
    .limit(1);
  return rows[0]?.actionType ?? null;
}

async function recipientsForActed(
  database: Database,
  familyId: string,
  actionType: string,
): Promise<string[]> {
  const rows = await database
    .select({
      userId: schema.consentRecords.userId,
      granted: schema.consentRecords.granted,
      revokedAt: schema.consentRecords.revokedAt,
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.familyId, familyId),
        eq(schema.consentRecords.consentType, 'autonomous_action_class'),
        eq(schema.consentRecords.consentScope, actionType),
      ),
    )
    .orderBy(
      desc(schema.consentRecords.grantedAt),
      asc(schema.consentRecords.granted),
      desc(schema.consentRecords.id),
    );
  const live: string[] = [];
  const decided = new Set<string>();
  for (const row of rows) {
    if (!row.granted) break;
    if (decided.has(row.userId)) continue;
    decided.add(row.userId);
    if (row.revokedAt === null) live.push(row.userId);
  }
  live.sort();
  return live;
}

async function markAgedOut(database: Database, aged: AgedActed[]): Promise<void> {
  for (const row of aged) {
    await database.insert(schema.auditLog).values({
      familyId: row.familyId,
      actor: 'system',
      actionTaken: 'autonomy_acted_notice_aged_out',
      targetTable: 'actions',
      targetId: row.actionId,
      after: { parentUserId: row.parentUserId },
    });
  }
}

export async function dispatchAutonomyNotices(
  database: Database,
  input: { now: Date; familyId?: string; slot: 'now' | 'morning' },
  ports: AutonomyNoticePorts,
): Promise<AutonomyNoticeDispatchResult> {
  const result = emptyAutonomyNoticeDispatch();
  const selected = await selectOpenAutonomyNotices(database, input.now, input.familyId);
  const open = selected.notices;
  result.open = open.length;
  result.agedOut = selected.aged.length;
  await markAgedOut(database, selected.aged);
  if (selected.aged.length > 0) {
    console.info(
      { agedOut: selected.aged.length, familyId: input.familyId ?? null },
      'autonomy notice: on-its-own texts older than 7 days were left unsent',
    );
  }
  if (!autonomousLaneOn()) {
    result.laneOff = open.length;
    if (open.length > 0) {
      console.info(
        { open: open.length, familyId: input.familyId ?? null },
        'autonomy notice: lane is off, texts stay owed',
      );
    }
    return result;
  }

  const dueNotices: OpenNotice[] = [];
  for (const notice of open) {
    if (input.slot === 'morning') {
      const zone = await redriveParentTimeZone(database, notice.parentUserId);
      if (!isRedriveSlot(input.now, zone)) continue;
    }
    dueNotices.push(notice);
  }
  const groups: OpenNotice[][] = [];
  const byParent = new Map<string, OpenNotice[]>();
  for (const notice of dueNotices) {
    const parentKey = `${notice.familyId}:${notice.parentUserId}`;
    const list = byParent.get(parentKey);
    if (list) list.push(notice);
    else {
      const created = [notice];
      byParent.set(parentKey, created);
      groups.push(created);
    }
  }
  result.due = groups.length;
  result.deferred = Math.max(0, groups.length - MAX_REDRIVE_PER_RUN);
  for (const group of groups.slice(0, MAX_REDRIVE_PER_RUN)) {
    const [first] = group;
    if (!first) continue;
    const notices: OpenAutonomyObligation[] = group.map((notice) =>
      notice.kind === 'armed'
        ? {
            kind: 'armed' as const,
            consentRecordId: notice.consentRecordId,
            actionType: notice.actionType,
          }
        : {
            kind: 'acted' as const,
            actionId: notice.actionId,
            actionType: notice.actionType,
          },
    );
    const outcome = await tellParentOpenNotices(
      database,
      {
        familyId: first.familyId,
        parentUserId: first.parentUserId,
        now: input.now,
        notices,
      },
      ports,
    );
    countOutcome(result, outcome);
  }
  return result;
}

export async function runAutonomyNoticeRedrive(
  database: Database,
  deps: { ports: AutonomyNoticePorts },
  now: Date = new Date(),
): Promise<AutonomyNoticeDispatchResult> {
  return dispatchAutonomyNotices(database, { now, slot: 'morning' }, deps.ports);
}
