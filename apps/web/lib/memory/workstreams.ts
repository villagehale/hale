import { type Database, WORKSTREAM_STATUSES, type WorkstreamStatus, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or } from 'drizzle-orm';

/**
 * VIL-419 — active workstreams.
 *
 * The model decides. This module stores the decision and enforces two limits:
 * how many threads a family may have open, and that a stale one closes itself.
 * It does not read the parent's words. A declined activity is stored as
 * `dropped`, never as an open or scheduled plan.
 *
 * Prompt injection, extraction, writes, and proactive follow-ups stay behind
 * {@link WORKSTREAMS_ENABLED_ENV}. Exactly `true`. Anything else does not call
 * the model and does not write a row.
 */

export const WORKSTREAMS_ENABLED_ENV = 'WORKSTREAMS_ENABLED';

/** Strict equality. `true\n` and `TRUE` stay off. */
export function workstreamsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[WORKSTREAMS_ENABLED_ENV] === 'true';
}

export const OPEN_WORKSTREAM_STATUSES = [
  'open',
  'waiting_on_parent',
  'waiting_on_third_party',
  'scheduled',
] as const satisfies readonly WorkstreamStatus[];

export type OpenWorkstreamStatus = (typeof OPEN_WORKSTREAM_STATUSES)[number];

const OPEN_STATUS_LIST: WorkstreamStatus[] = [...OPEN_WORKSTREAM_STATUSES];

/** A family may not accumulate an unbounded open list. */
export const MAX_OPEN_WORKSTREAMS = 8;

/** Omitted expiry. A thread with no horizon would never close itself. */
export const DEFAULT_WORKSTREAM_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

/** The prompt block. Compact on purpose: it rides every reply turn. */
export const WORKSTREAM_BLOCK_CHAR_BUDGET = 700;
const SHOWN_LIMIT = 6;
const TITLE_CHARS = 72;
const NEXT_CHARS = 72;

const CLOSED = new Set<WorkstreamStatus>(['done', 'dropped']);

export interface WorkstreamOp {
  action: 'none' | 'open' | 'update' | 'close' | 'drop';
  id?: string | null;
  title?: string | null;
  status?: WorkstreamStatus | null;
  nextStep?: string | null;
  checkBackAt?: string | null;
  expiresAt?: string | null;
  childIds?: readonly string[];
  eventIds?: readonly string[];
  activityRefs?: readonly string[];
  /** The model says the activity was declined or rejected. Stored as dropped. */
  declined?: boolean | null;
}

/**
 * A next step Hale would have to perform. Nothing in this system calls a desk,
 * emails a centre, or follows up with a camp, so that sentence is not stored
 * and is not handed back to the check-back as if it were a plan.
 *
 * A step the parent or a co-parent owns is theirs. "Parent to call the dentist"
 * and "Sam to email the coach" stay, with the status they were given.
 */
const HALE_ACTION_NEXT =
  /\b(follow up|email the|e-mail the|call the|check back|reach out|relancer|écrire (?:au|à)|ecrire (?:au|a)|contacter|write to|text the)\b/i;

const PARENT_OWNED_STEP = /^(?:parent|the parent|co-?parent|mom|dad|mum|maman|papa|i|we)\b/i;

const HALE_WE = /^we(?:['’]ll| will|['’]re| are going)\b/i;

const NAMED_TO_ACT = /^([\p{Lu}][\p{L}'’-]*)\s+to\b/u;

function parentOwnedStep(text: string): boolean {
  if (HALE_WE.test(text)) return false;
  if (PARENT_OWNED_STEP.test(text)) return true;
  if (/\bremind me\b/i.test(text)) return true;
  const named = NAMED_TO_ACT.exec(text);
  if (!named) return false;
  return !/^hale$/i.test(named[1] ?? '');
}

export function haleActionNextStep(nextStep: string | null | undefined): boolean {
  const text = nextStep?.trim();
  if (!text) return false;
  if (parentOwnedStep(text)) return false;
  return HALE_ACTION_NEXT.test(text);
}

export type WorkstreamApplyResult =
  | { outcome: 'ignored' }
  | { outcome: 'opened' | 'updated' | 'closed' | 'dropped'; id: string; status: WorkstreamStatus }
  | { outcome: 'refused'; reason: 'max_open' | 'missing_title' };

function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

function parseInstant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A check-back that is already due would ride the next hourly sweep. A missing
 * value stays missing (an update keeps the row's time). A past or unreadable
 * value is stored as null.
 */
function storedCheckBack(value: string | null | undefined, now: Date): Date | null | undefined {
  if (value === undefined) return undefined;
  const parsed = parseInstant(value);
  if (!parsed || parsed.getTime() <= now.getTime()) return null;
  return parsed;
}

function isStatus(value: string | null | undefined): value is WorkstreamStatus {
  return !!value && (WORKSTREAM_STATUSES as readonly string[]).includes(value);
}

function isOpenStatus(value: WorkstreamStatus): value is OpenWorkstreamStatus {
  return (OPEN_WORKSTREAM_STATUSES as readonly string[]).includes(value);
}

/**
 * A decline is never a plan. `dropped` wins over a status the model also sent,
 * including `scheduled` and `done`.
 */
export function resolvedWorkstreamStatus(op: WorkstreamOp): WorkstreamStatus {
  if (op.declined === true || op.action === 'drop') return 'dropped';
  if (op.action === 'close') return 'done';
  if (isStatus(op.status) && isOpenStatus(op.status)) return op.status;
  return 'open';
}

function uuidList(values: readonly string[] | undefined, max: number): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      continue;
    }
    const id = value.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

function refList(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const out: string[] = [];
  for (const value of values) {
    const clipped = clip(value, 80);
    if (!clipped) continue;
    out.push(clipped);
    if (out.length >= 4) break;
  }
  return out;
}

async function audit(
  database: Database,
  row: {
    familyId: string;
    actionTaken: string;
    targetId: string | null;
    after: Record<string, unknown>;
  },
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: row.familyId,
    actor: 'system',
    actionTaken: row.actionTaken,
    targetTable: 'family_workstreams',
    targetId: row.targetId,
    after: row.after,
  });
}

async function countOpen(database: Database, familyId: string, now: Date): Promise<number> {
  const rows = await database
    .select({ id: schema.familyWorkstreams.id })
    .from(schema.familyWorkstreams)
    .where(
      and(
        eq(schema.familyWorkstreams.familyId, familyId),
        inArray(schema.familyWorkstreams.status, OPEN_STATUS_LIST),
        gt(schema.familyWorkstreams.expiresAt, now),
      ),
    );
  return rows.length;
}

async function liveById(database: Database, familyId: string, id: string) {
  const rows = await database
    .select()
    .from(schema.familyWorkstreams)
    .where(
      and(eq(schema.familyWorkstreams.id, id), eq(schema.familyWorkstreams.familyId, familyId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function liveByTitle(database: Database, familyId: string, title: string, now: Date) {
  const rows = await database
    .select()
    .from(schema.familyWorkstreams)
    .where(
      and(
        eq(schema.familyWorkstreams.familyId, familyId),
        eq(schema.familyWorkstreams.title, title),
        inArray(schema.familyWorkstreams.status, OPEN_STATUS_LIST),
        gt(schema.familyWorkstreams.expiresAt, now),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Close threads whose expiry has passed. The row stays, with status `dropped`,
 * so a later turn does not treat it as still in progress.
 */
export async function expireStaleWorkstreams(
  database: Database,
  now: Date,
  familyId?: string,
): Promise<number> {
  const rows = await database
    .select({
      id: schema.familyWorkstreams.id,
      familyId: schema.familyWorkstreams.familyId,
    })
    .from(schema.familyWorkstreams)
    .where(
      and(
        familyId ? eq(schema.familyWorkstreams.familyId, familyId) : undefined,
        inArray(schema.familyWorkstreams.status, OPEN_STATUS_LIST),
        lte(schema.familyWorkstreams.expiresAt, now),
      ),
    )
    .limit(50);

  for (const row of rows) {
    await database
      .update(schema.familyWorkstreams)
      .set({
        status: 'dropped',
        closedAt: now,
        updatedAt: now,
        updatedFrom: 'expiry',
      })
      .where(eq(schema.familyWorkstreams.id, row.id));
    await audit(database, {
      familyId: row.familyId,
      actionTaken: 'workstream_expired',
      targetId: row.id,
      after: { status: 'dropped', reason: 'expired' },
    });
  }
  return rows.length;
}

export async function applyWorkstreamOp(
  database: Database,
  input: { familyId: string; provenance: string; now: Date; op: WorkstreamOp },
): Promise<WorkstreamApplyResult> {
  const { op, familyId, provenance, now } = input;
  if (op.action === 'none') return { outcome: 'ignored' };
  await expireStaleWorkstreams(database, now, familyId);

  const status = resolvedWorkstreamStatus(op);
  const title = op.title ? clip(op.title, 160) : '';
  const existing = op.id
    ? await liveById(database, familyId, op.id)
    : title
      ? await liveByTitle(database, familyId, title, now)
      : null;

  if (
    !existing &&
    (op.action === 'update' || op.action === 'close' || op.action === 'drop') &&
    op.id
  ) {
    return { outcome: 'ignored' };
  }

  if (!existing && !title) return { outcome: 'refused', reason: 'missing_title' };

  const closing = CLOSED.has(status);
  if (!existing && !closing && (await countOpen(database, familyId, now)) >= MAX_OPEN_WORKSTREAMS) {
    await audit(database, {
      familyId,
      actionTaken: 'workstream_refused',
      targetId: null,
      after: { reason: 'max_open' },
    });
    return { outcome: 'refused', reason: 'max_open' };
  }

  const expiresAt =
    parseInstant(op.expiresAt) ??
    (existing?.expiresAt && existing.expiresAt > now ? existing.expiresAt : null) ??
    new Date(now.getTime() + DEFAULT_WORKSTREAM_EXPIRY_MS);
  const checkBackAt = storedCheckBack(op.checkBackAt, now);
  const nextStep =
    op.nextStep === undefined || op.nextStep === null ? op.nextStep : clip(op.nextStep, 240);

  if (!existing) {
    const [row] = await database
      .insert(schema.familyWorkstreams)
      .values({
        familyId,
        title,
        status,
        nextStep: nextStep ?? null,
        checkBackAt: checkBackAt ?? null,
        childIds: uuidList(op.childIds, 6),
        eventIds: uuidList(op.eventIds, 6),
        activityRefs: refList(op.activityRefs),
        createdFrom: provenance,
        updatedFrom: provenance,
        expiresAt,
        closedAt: closing ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.familyWorkstreams.id });
    if (!row) throw new Error('workstream insert returned no row');
    await audit(database, {
      familyId,
      actionTaken: closing ? 'workstream_dropped' : 'workstream_opened',
      targetId: row.id,
      after: { status },
    });
    return {
      outcome: closing ? 'dropped' : 'opened',
      id: row.id,
      status,
    };
  }

  await database
    .update(schema.familyWorkstreams)
    .set({
      title: title || existing.title,
      status,
      nextStep: nextStep === undefined ? existing.nextStep : nextStep,
      checkBackAt: checkBackAt === undefined ? existing.checkBackAt : checkBackAt,
      childIds: op.childIds ? uuidList(op.childIds, 6) : existing.childIds,
      eventIds: op.eventIds ? uuidList(op.eventIds, 6) : existing.eventIds,
      activityRefs: op.activityRefs ? refList(op.activityRefs) : existing.activityRefs,
      updatedFrom: provenance,
      updatedAt: now,
      expiresAt,
      closedAt: closing ? (existing.closedAt ?? now) : null,
    })
    .where(eq(schema.familyWorkstreams.id, existing.id));

  const actionTaken =
    status === 'dropped'
      ? 'workstream_dropped'
      : status === 'done'
        ? 'workstream_closed'
        : 'workstream_updated';
  await audit(database, {
    familyId,
    actionTaken,
    targetId: existing.id,
    after: { status },
  });
  return {
    outcome: status === 'dropped' ? 'dropped' : status === 'done' ? 'closed' : 'updated',
    id: existing.id,
    status,
  };
}

export async function applyWorkstreamOps(
  database: Database,
  input: { familyId: string; provenance: string; now: Date; ops: readonly WorkstreamOp[] },
): Promise<WorkstreamApplyResult[]> {
  const results: WorkstreamApplyResult[] = [];
  for (const op of input.ops.slice(0, 4)) {
    results.push(await applyWorkstreamOp(database, { ...input, op }));
  }
  return results;
}

export interface OpenWorkstreamView {
  id: string;
  title: string;
  status: WorkstreamStatus;
  nextStep: string | null;
  checkBackAt: Date | null;
  childIds: readonly string[];
}

export async function listOpenWorkstreams(
  database: Database,
  familyId: string,
  now: Date,
): Promise<OpenWorkstreamView[]> {
  await expireStaleWorkstreams(database, now, familyId);
  const rows = await database
    .select({
      id: schema.familyWorkstreams.id,
      title: schema.familyWorkstreams.title,
      status: schema.familyWorkstreams.status,
      nextStep: schema.familyWorkstreams.nextStep,
      checkBackAt: schema.familyWorkstreams.checkBackAt,
      childIds: schema.familyWorkstreams.childIds,
      updatedAt: schema.familyWorkstreams.updatedAt,
    })
    .from(schema.familyWorkstreams)
    .where(
      and(
        eq(schema.familyWorkstreams.familyId, familyId),
        inArray(schema.familyWorkstreams.status, OPEN_STATUS_LIST),
        gt(schema.familyWorkstreams.expiresAt, now),
      ),
    )
    .orderBy(desc(schema.familyWorkstreams.updatedAt))
    .limit(SHOWN_LIMIT);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    nextStep: row.nextStep,
    checkBackAt: row.checkBackAt,
    childIds: row.childIds,
  }));
}

export function renderWorkstreamBlock(rows: readonly OpenWorkstreamView[]): string {
  if (rows.length === 0) return 'active_workstreams: none';
  const lines = [
    'active_workstreams: jobs in progress, separate from the promise-kind workstreams line. Say them in your own words. A declined activity is dropped, never confirmed.',
  ];
  for (const row of rows.slice(0, SHOWN_LIMIT)) {
    const check = row.checkBackAt ? row.checkBackAt.toISOString().slice(0, 10) : 'none';
    const next = row.nextStep ? clip(row.nextStep, NEXT_CHARS) : 'none';
    lines.push(
      `- id=${row.id} status=${row.status} check_back=${check} title=${clip(row.title, TITLE_CHARS)} next=${next}`,
    );
  }
  let text = lines.join('\n');
  if (text.length > WORKSTREAM_BLOCK_CHAR_BUDGET) {
    text = `${text.slice(0, WORKSTREAM_BLOCK_CHAR_BUDGET - 16)}\ntruncated=true`;
  }
  return text;
}

/**
 * The block for one reply turn, or null when the flag is off.
 * Null is omitted from the serialized context, so the cached skill prefix
 * does not change and a flag-off turn does not grow a field.
 */
export async function activeWorkstreamBlock(
  database: Database,
  familyId: string,
  now: Date,
): Promise<string | null> {
  if (!workstreamsEnabled()) return null;
  const [rows, children] = await Promise.all([
    listOpenWorkstreams(database, familyId, now),
    database
      .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
      .from(schema.children)
      .where(eq(schema.children.familyId, familyId)),
  ]);
  const teen = new Set(
    children
      .filter((row) => deriveStage(row.dateOfBirth, now) === 'teenager')
      .map((row) => row.id.toLowerCase()),
  );
  const visible = rows.filter((row) => !row.childIds.some((id) => teen.has(id.toLowerCase())));
  return renderWorkstreamBlock(visible);
}

export interface DueWorkstream {
  id: string;
  familyId: string;
  title: string;
  status: WorkstreamStatus;
  nextStep: string | null;
  checkBackAt: Date;
  childIds: readonly string[];
}

/**
 * Open threads whose check-back time has passed and that have not been
 * followed up for this check-back yet. The sweep decides whether a text
 * may go out. This query does not.
 */
export async function listDueWorkstreams(
  database: Database,
  now: Date,
  limit = 40,
): Promise<DueWorkstream[]> {
  const rows = await database
    .select({
      id: schema.familyWorkstreams.id,
      familyId: schema.familyWorkstreams.familyId,
      title: schema.familyWorkstreams.title,
      status: schema.familyWorkstreams.status,
      nextStep: schema.familyWorkstreams.nextStep,
      checkBackAt: schema.familyWorkstreams.checkBackAt,
      childIds: schema.familyWorkstreams.childIds,
    })
    .from(schema.familyWorkstreams)
    .where(
      and(
        inArray(schema.familyWorkstreams.status, OPEN_STATUS_LIST),
        lte(schema.familyWorkstreams.checkBackAt, now),
        gt(schema.familyWorkstreams.expiresAt, now),
        or(
          isNull(schema.familyWorkstreams.lastFollowedUpAt),
          lt(schema.familyWorkstreams.lastFollowedUpAt, schema.familyWorkstreams.checkBackAt),
        ),
      ),
    )
    .orderBy(asc(schema.familyWorkstreams.checkBackAt))
    .limit(limit);
  return rows.flatMap((row) =>
    row.checkBackAt
      ? [
          {
            id: row.id,
            familyId: row.familyId,
            title: row.title,
            status: row.status,
            nextStep: row.nextStep,
            checkBackAt: row.checkBackAt,
            childIds: row.childIds,
          },
        ]
      : [],
  );
}

/** The follow-up for this check-back went out, or was deliberately not sent. */
export async function markWorkstreamFollowedUp(
  database: Database,
  id: string,
  now: Date,
): Promise<void> {
  await database
    .update(schema.familyWorkstreams)
    .set({ lastFollowedUpAt: now, updatedAt: now })
    .where(eq(schema.familyWorkstreams.id, id));
}
