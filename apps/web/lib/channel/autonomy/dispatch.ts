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
  autonomousLaneOn,
  tellParentHaleActed,
  tellParentKindArmed,
} from './notice';

/**
 * Open turn-on texts and on-its-own notices.
 *
 * The obligation is the audit row (the grant, or the autonomous execution), not the
 * suppression: a quiet-hours hold and a crash before the send are both still owed.
 * A turn-on text is owed for as long as the grant is live and undelivered. An
 * on-its-own notice older than the redrive window is counted and not sent.
 * One parent hears at most one of these per pass, and a turn-on text goes first.
 * The morning pass only sends inside the re-drive hour; the drain pass tries now
 * and the gate holds quiet hours. Nothing sends while the execute lane is off.
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
  /** On-its-own notices older than the redrive window, still unsent, and counted. */
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
  if (keys.length === 0) return new Set();
  const rows = await database
    .select({ dedupeKey: schema.channelMessages.dedupeKey })
    .from(schema.channelMessages)
    .where(inArray(schema.channelMessages.dedupeKey, keys));
  return new Set(rows.flatMap((row) => (row.dedupeKey ? [row.dedupeKey] : [])));
}

export async function selectOpenAutonomyNotices(
  database: Database,
  now: Date,
  familyId?: string,
): Promise<{ notices: OpenNotice[]; agedOut: number }> {
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
    const parentUserId = await recipientForActed(database, row.familyId, actionType);
    if (!parentUserId) continue;
    actedRows.push({
      kind: 'acted',
      familyId: row.familyId,
      parentUserId,
      actionId: row.actionId,
      actionType,
      occurredAt: row.occurredAt,
    });
  }

  const keys = [
    ...armed.map((row) => autonomyArmedDedupeKey(row.consentRecordId)),
    ...actedRows.map((row) => autonomyActedDedupeKey(row.actionId)),
  ];
  const claimed = await claimedKeys(database, keys);
  const openArmed = armed.filter(
    (row) => !claimed.has(autonomyArmedDedupeKey(row.consentRecordId)),
  );
  const openActed: OpenActed[] = [];
  let agedOut = 0;
  for (const row of actedRows) {
    if (claimed.has(autonomyActedDedupeKey(row.actionId))) continue;
    if (row.occurredAt.getTime() < since.getTime()) {
      agedOut += 1;
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
  return { notices: [...openArmed, ...openActed], agedOut };
}

/**
 * Live grants, one per parent per kind. Each parent's own newest consent row
 * decides for that parent. One parent's decline does not close the others'
 * texts. No age limit: a text that was never delivered is still owed, including
 * one written while the lane was off.
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
      if (!row.familyId || !row.scope) continue;
      if (decided.has(row.userId)) continue;
      decided.add(row.userId);
      if (!row.granted || row.revokedAt !== null) continue;
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

async function recipientForActed(
  database: Database,
  familyId: string,
  actionType: string,
): Promise<string | null> {
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
  return live[0] ?? null;
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
  result.agedOut = selected.agedOut;
  if (selected.agedOut > 0) {
    console.info(
      { agedOut: selected.agedOut, familyId: input.familyId ?? null },
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

  const due: OpenNotice[] = [];
  const heard = new Set<string>();
  for (const notice of open) {
    if (input.slot === 'morning') {
      const zone = await redriveParentTimeZone(database, notice.parentUserId);
      if (!isRedriveSlot(input.now, zone)) continue;
    }
    const parentKey = `${notice.familyId}:${notice.parentUserId}`;
    if (heard.has(parentKey)) continue;
    heard.add(parentKey);
    due.push(notice);
  }
  result.due = due.length;
  result.deferred = Math.max(0, due.length - MAX_REDRIVE_PER_RUN);
  for (const notice of due.slice(0, MAX_REDRIVE_PER_RUN)) {
    const outcome =
      notice.kind === 'armed'
        ? await tellParentKindArmed(database, { ...notice, now: input.now }, ports)
        : await tellParentHaleActed(database, { ...notice, now: input.now }, ports);
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
