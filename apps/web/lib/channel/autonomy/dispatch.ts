import { type Database, schema } from '@hale/db';
import { autonomyActedDedupeKey, autonomyArmedDedupeKey } from '@hale/worker/memory-writer';
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  MAX_REDRIVE_PER_RUN,
  REDRIVE_MAX_AGE_MS,
  isRedriveSlot,
  redriveParentTimeZone,
} from '~/lib/channel/redrive-slot';
import {
  type AutonomyNoticeOutcome,
  type AutonomyNoticePorts,
  tellParentHaleActed,
  tellParentKindArmed,
} from './notice';

/**
 * Open turn-on texts and on-its-own notices.
 *
 * The obligation is the audit row (the grant, or the autonomous execution), not the
 * suppression: a quiet-hours hold and a crash before the send are both still owed.
 * One parent hears at most one of these per pass, and a turn-on text goes first.
 * The morning pass only sends inside the re-drive hour; the drain pass tries now
 * and the gate holds quiet hours.
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
  };
}

function countOutcome(result: AutonomyNoticeDispatchResult, outcome: AutonomyNoticeOutcome): void {
  if (outcome === 'sent') result.sent += 1;
  else if (outcome === 'already_sent') result.alreadySent += 1;
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
): Promise<OpenNotice[]> {
  const since = new Date(now.getTime() - REDRIVE_MAX_AGE_MS);
  const grants = await database
    .select({
      familyId: schema.auditLog.familyId,
      parentUserId: schema.auditLog.actor,
      consentRecordId: schema.auditLog.targetId,
      after: schema.auditLog.after,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, 'autonomous_action_class.granted'),
        eq(schema.auditLog.targetTable, 'consent_records'),
        isNotNull(schema.auditLog.targetId),
        gte(schema.auditLog.occurredAt, since),
        familyId ? eq(schema.auditLog.familyId, familyId) : undefined,
      ),
    )
    .orderBy(asc(schema.auditLog.occurredAt));

  const armed: OpenArmed[] = [];
  for (const row of grants) {
    if (!row.consentRecordId) continue;
    const actionType =
      row.after && typeof row.after === 'object' && 'consentScope' in row.after
        ? String((row.after as { consentScope?: unknown }).consentScope ?? '')
        : '';
    if (!actionType) continue;
    armed.push({
      kind: 'armed',
      familyId: row.familyId,
      parentUserId: row.parentUserId,
      consentRecordId: row.consentRecordId,
      actionType,
    });
  }

  const executions = await database
    .select({
      familyId: schema.auditLog.familyId,
      actionId: schema.auditLog.targetId,
      after: schema.auditLog.after,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, 'action.executed'),
        eq(schema.auditLog.targetTable, 'actions'),
        isNotNull(schema.auditLog.targetId),
        gte(schema.auditLog.occurredAt, since),
        sql`${schema.auditLog.after} -> 'decision' ->> 'source' = 'autonomous'`,
        familyId ? eq(schema.auditLog.familyId, familyId) : undefined,
      ),
    )
    .orderBy(asc(schema.auditLog.occurredAt));

  const acted: OpenActed[] = [];
  for (const row of executions) {
    if (!row.actionId) continue;
    const actionType = await actionTypeOf(database, row.actionId);
    if (!actionType) continue;
    const parentUserId = await recipientForActed(database, row.familyId, actionType);
    if (!parentUserId) continue;
    acted.push({
      kind: 'acted',
      familyId: row.familyId,
      parentUserId,
      actionId: row.actionId,
      actionType,
    });
  }

  const keys = [
    ...armed.map((row) => autonomyArmedDedupeKey(row.consentRecordId)),
    ...acted.map((row) => autonomyActedDedupeKey(row.actionId)),
  ];
  const claimed = await claimedKeys(database, keys);
  const openArmed = armed.filter(
    (row) => !claimed.has(autonomyArmedDedupeKey(row.consentRecordId)),
  );
  const openActed = acted.filter((row) => !claimed.has(autonomyActedDedupeKey(row.actionId)));
  return [...openArmed, ...openActed];
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
  const open = await selectOpenAutonomyNotices(database, input.now, input.familyId);
  result.open = open.length;

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
