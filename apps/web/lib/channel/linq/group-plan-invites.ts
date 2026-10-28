import { createHash } from 'node:crypto';
import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import type {
  CalendarInviteMethod,
  CalendarInviteReport,
  CalendarInviteSender,
} from '@hale/worker/executor';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-455 (T13) — a plan made in a multi-family group lands on each family's calendar.
 *
 * The model reads which families are in (no keywords). Each `in` family gets its own
 * family_events copy and the SAME per-family calendar-invite sender a 1:1 placement uses.
 * The copy's idempotency key is scoped to (group plan, family), so a re-drive never
 * double-places or double-texts. An edit or a cancel re-drives every copy. When a copy or
 * its invite fails, that family alone gets a private, model-written 1:1 note; if the
 * model can't write it, nothing is sent (no fixed fallback line).
 *
 * The group -> families mapping (VIL-399) is not on main yet, so it is an interface
 * ({@link GroupFamilyDirectory}) with fixtures until it lands.
 */

export const GROUP_PLAN_ATTENDANCE = ['in', 'out', 'unclear'] as const;
export type GroupPlanAttendance = (typeof GROUP_PLAN_ATTENDANCE)[number];

export interface GroupPlanFamily {
  familyId: string;
  /** Display label, e.g. the family surname. Context for the read only. */
  label: string;
  memberFirstNames: readonly string[];
}

/** Pending VIL-399: which families share this group chat. */
export interface GroupFamilyDirectory {
  familiesInGroup(chatId: string): Promise<GroupPlanFamily[]>;
}

export interface GroupPlan {
  /** Stable id of the plan inside the group (one per plan, survives edits). */
  groupPlanId: string;
  chatId: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  cancelled: boolean;
}

export interface GroupPlanMessage {
  familyId: string | null;
  senderName: string | null;
  text: string;
}

export interface AttendanceReadInput {
  plan: Pick<GroupPlan, 'title' | 'startsAt' | 'endsAt' | 'location'>;
  families: readonly GroupPlanFamily[];
  messages: readonly GroupPlanMessage[];
}

export interface GroupPlanAttendanceReader {
  /** Null: the read failed after its retry. Every given family is in the map otherwise. */
  read(input: AttendanceReadInput): Promise<Map<string, GroupPlanAttendance> | null>;
}

const attendanceSchema = z.object({
  families: z.array(z.object({ key: z.string(), attendance: z.enum(GROUP_PLAN_ATTENDANCE) })),
});
export const ATTENDANCE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    families: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          attendance: { type: 'string', enum: [...GROUP_PLAN_ATTENDANCE] },
        },
        required: ['key', 'attendance'],
      },
    },
  },
  required: ['families'],
} as const;

/** Opaque per-call keys: the model never sees a family UUID. */
const familyKey = (index: number) => `f${index + 1}`;

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function attendanceUserMessage(input: AttendanceReadInput): string {
  const keyOf = new Map(input.families.map((f, i) => [f.familyId, familyKey(i)]));
  return JSON.stringify({
    plan: {
      title: input.plan.title,
      startsAt: input.plan.startsAt.toISOString(),
      endsAt: input.plan.endsAt?.toISOString() ?? null,
      location: input.plan.location,
    },
    families: input.families.map((f, i) => ({
      key: familyKey(i),
      label: f.label,
      members: [...f.memberFirstNames],
    })),
    messages: input.messages.map((m) => ({
      family: m.familyId ? (keyOf.get(m.familyId) ?? null) : null,
      from: m.senderName,
      text: m.text,
    })),
  });
}

/** Map the model's keyed answer back to family ids. Null when it skipped or invented a key. */
export function attendanceFromAnswer(
  families: readonly GroupPlanFamily[],
  answer: z.infer<typeof attendanceSchema>,
): Map<string, GroupPlanAttendance> | null {
  const byKey = new Map(answer.families.map((f) => [f.key, f.attendance]));
  if (byKey.size !== families.length) return null;
  const out = new Map<string, GroupPlanAttendance>();
  for (const [i, f] of families.entries()) {
    const a = byKey.get(familyKey(i));
    if (!a) return null;
    out.set(f.familyId, a);
  }
  return out;
}

export function createGroupPlanAttendanceReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): GroupPlanAttendanceReader {
  const once = async (input: AttendanceReadInput) => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
    const skill = await loadCronSkill('group-plan-attendance-read');
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: attendanceUserMessage(input),
      toolName: 'group_plan_attendance',
      toolDescription: 'Return, for each family key, whether that family is coming.',
      inputJsonSchema: ATTENDANCE_TOOL_SCHEMA,
      schema: attendanceSchema,
      maxTokens: 400,
    });
    return attendanceFromAnswer(input.families, value);
  };
  return {
    async read(input) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const reading = await once(input);
          if (reading) return reading;
        } catch (err) {
          console.warn(
            { attempt, err: err instanceof Error ? err.name : 'unknown' },
            'group plan attendance: read failed',
          );
        }
      }
      console.error({ outcome: 'group_plan_unread' }, 'group plan attendance: sending nothing');
      return null;
    },
  };
}

// ─── Private note when one family's copy fails ────────────────────────────────

export type GroupPlanFailure = 'placement_failed' | 'invite_failed' | 'cancel_failed';

export interface GroupPlanNoteInput {
  plan: Pick<GroupPlan, 'title' | 'startsAt' | 'endsAt' | 'location'>;
  familyLabel: string;
  failure: GroupPlanFailure;
}

export interface GroupPlanNoteWriter {
  /** Null: the model could not write it. The caller then sends nothing. */
  write(input: GroupPlanNoteInput): Promise<string | null>;
}

/** Sends to ONE family's own 1:1 thread(s). Never a group. */
export interface FamilyPrivateNoteSender {
  send(input: { familyId: string; text: string }): Promise<'sent' | 'not_sent'>;
}

const noteSchema = z.object({ text: z.string().trim().min(1) });
export const NOTE_TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

export function noteUserMessage(input: GroupPlanNoteInput): string {
  return JSON.stringify({
    plan: {
      title: input.plan.title,
      startsAt: input.plan.startsAt.toISOString(),
      endsAt: input.plan.endsAt?.toISOString() ?? null,
      location: input.plan.location,
    },
    family: input.familyLabel,
    failure: input.failure,
  });
}

export function createGroupPlanNoteWriter(
  clientOrResolver: AgentClient | (() => AgentClient),
): GroupPlanNoteWriter {
  return {
    async write(input) {
      try {
        const client =
          typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
        const skill = await loadCronSkill('group-plan-invite-note');
        const { value } = await forceToolJson({
          client,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: noteUserMessage(input),
          toolName: 'group_plan_note',
          toolDescription: 'Return the private note for this one family.',
          inputJsonSchema: NOTE_TOOL_SCHEMA,
          schema: noteSchema,
          maxTokens: 400,
        });
        return value.text;
      } catch (err) {
        console.warn(
          { err: err instanceof Error ? err.name : 'unknown' },
          'group plan note: draft failed, sending nothing',
        );
        return null;
      }
    },
  };
}

// ─── Per-family copies (group-plan-scoped dedupe) ─────────────────────────────

/**
 * The copy's claim key: a UUID derived from (group plan, family). It rides the existing
 * `family_events_placed_by_action_uniq` partial index, so a concurrent or redelivered
 * fan-out conflicts instead of placing a second copy. No migration.
 */
export function groupPlanCopyKey(groupPlanId: string, familyId: string): string {
  const h = createHash('sha256').update(`group-plan:${groupPlanId}:${familyId}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export type CopyWrite =
  /** New copy, or an existing copy whose time/title/place changed: the invite is owed. */
  | { status: 'written'; familyEventId: string }
  /** Same copy, nothing changed: no invite. */
  | { status: 'unchanged'; familyEventId: string };

export interface GroupPlanCopyStore {
  upsertCopy(plan: GroupPlan, familyId: string): Promise<CopyWrite>;
  /** Soft-deletes the live copy. Null when this family never had one live. */
  cancelCopy(plan: GroupPlan, familyId: string): Promise<string | null>;
}

export function createFamilyEventsCopyStore(database: Database): GroupPlanCopyStore {
  const fe = schema.familyEvents;
  return {
    async upsertCopy(plan, familyId) {
      const key = groupPlanCopyKey(plan.groupPlanId, familyId);
      const values = {
        title: plan.title,
        startsAt: plan.startsAt,
        endsAt: plan.endsAt,
        location: plan.location,
      };
      const [inserted] = await database
        .insert(fe)
        .values({ familyId, source: 'placement', placedByActionId: key, ...values })
        .onConflictDoNothing({
          target: fe.placedByActionId,
          where: sql`${fe.placedByActionId} IS NOT NULL`,
        })
        .returning({ id: fe.id });
      if (inserted) return { status: 'written', familyEventId: inserted.id };
      const [row] = await database
        .select()
        .from(fe)
        .where(and(eq(fe.placedByActionId, key), eq(fe.familyId, familyId)))
        .limit(1);
      if (!row) throw new Error('group plan copy key held by another family');
      const same =
        row.deletedAt === null &&
        row.title === values.title &&
        row.startsAt.getTime() === values.startsAt.getTime() &&
        (row.endsAt?.getTime() ?? null) === (values.endsAt?.getTime() ?? null) &&
        row.location === values.location;
      if (same) return { status: 'unchanged', familyEventId: row.id };
      await database
        .update(fe)
        .set({ ...values, deletedAt: null })
        .where(eq(fe.id, row.id));
      return { status: 'written', familyEventId: row.id };
    },
    async cancelCopy(plan, familyId) {
      const key = groupPlanCopyKey(plan.groupPlanId, familyId);
      const [row] = await database
        .update(fe)
        .set({ deletedAt: new Date() })
        .where(and(eq(fe.placedByActionId, key), eq(fe.familyId, familyId), isNull(fe.deletedAt)))
        .returning({ id: fe.id });
      return row?.id ?? null;
    },
  };
}

/** Which copies exist (live or not) for these families — lets a cancel find every copy. */
export async function existingCopyFamilies(
  database: Database,
  plan: Pick<GroupPlan, 'groupPlanId'>,
  familyIds: readonly string[],
): Promise<Set<string>> {
  if (familyIds.length === 0) return new Set();
  const keys = familyIds.map((id) => groupPlanCopyKey(plan.groupPlanId, id));
  const rows = await database
    .select({ familyId: schema.familyEvents.familyId })
    .from(schema.familyEvents)
    .where(inArray(schema.familyEvents.placedByActionId, keys));
  return new Set(rows.map((r) => r.familyId));
}

// ─── The fan-out ──────────────────────────────────────────────────────────────

export interface GroupPlanInviteDeps {
  directory: GroupFamilyDirectory;
  reader: GroupPlanAttendanceReader;
  copies: GroupPlanCopyStore;
  /** The same per-family sender a 1:1 placement uses (VIL-249). */
  invites: CalendarInviteSender;
  noteWriter: GroupPlanNoteWriter;
  privateNotes: FamilyPrivateNoteSender;
}

export type FamilyFanOutOutcome =
  | 'invited'
  | 'unchanged'
  | 'cancelled'
  | 'not_in'
  | 'placement_failed'
  | 'invite_failed'
  | 'cancel_failed';

export interface FamilyFanOutResult {
  familyId: string;
  attendance: GroupPlanAttendance | 'cancelled_plan';
  outcome: FamilyFanOutOutcome;
  /** Set only on a failure: what became of the private note. */
  note?: 'sent' | 'not_sent' | 'draft_failed';
  invite?: CalendarInviteReport;
}

export type GroupPlanFanOutReport =
  | { status: 'no_families' }
  /** The attendance read failed: nothing placed, nothing sent. */
  | { status: 'unread' }
  | { status: 'done'; families: FamilyFanOutResult[] };

/**
 * A report is a failure (owed a private note) only when the send broke: the sender threw,
 * or a parent leg came back send_failed / event_not_found / compose_deferred. A leg the
 * dispatch policy suppressed (consent, quiet hours, cap) or a parent Hale can't reach
 * (no_channel / not_configured) is a named outcome, not a failure: a note would hit the
 * same wall or override the parent's own settings.
 */
export function inviteDelivered(report: CalendarInviteReport): boolean {
  if (report.status === 'errored') return false;
  if (report.status !== 'reported') return true;
  return !report.parents.some((p) =>
    ['send_failed', 'event_not_found', 'compose_deferred'].includes(p.outcome),
  );
}

export async function driveGroupPlan(
  deps: GroupPlanInviteDeps,
  plan: GroupPlan,
  messages: readonly GroupPlanMessage[],
  /** Families that already hold a copy (any state). A cancel or an `out` re-drives these. */
  existingCopies: ReadonlySet<string>,
): Promise<GroupPlanFanOutReport> {
  const families = await deps.directory.familiesInGroup(plan.chatId);
  if (families.length === 0) return { status: 'no_families' };

  let attendance: Map<string, GroupPlanAttendance> | null = null;
  if (!plan.cancelled) {
    attendance = await deps.reader.read({ plan, families, messages });
    if (!attendance) return { status: 'unread' };
  }

  const results: FamilyFanOutResult[] = [];
  for (const family of families) {
    const a = attendance?.get(family.familyId) ?? 'cancelled_plan';
    const result = await driveOne(deps, plan, family, a, existingCopies.has(family.familyId));
    results.push(result);
  }
  return { status: 'done', families: results };
}

async function sendInvite(
  deps: GroupPlanInviteDeps,
  familyId: string,
  familyEventId: string,
  method: CalendarInviteMethod,
): Promise<CalendarInviteReport> {
  try {
    return await deps.invites.send({ familyId, familyEventId, method });
  } catch (err) {
    return { status: 'errored', message: err instanceof Error ? err.message : 'unknown' };
  }
}

async function driveOne(
  deps: GroupPlanInviteDeps,
  plan: GroupPlan,
  family: GroupPlanFamily,
  attendance: GroupPlanAttendance | 'cancelled_plan',
  hasCopy: boolean,
): Promise<FamilyFanOutResult> {
  const base = { familyId: family.familyId, attendance };
  const fail = async (
    outcome: GroupPlanFailure,
    invite?: CalendarInviteReport,
  ): Promise<FamilyFanOutResult> => {
    const text = await deps.noteWriter.write({ plan, familyLabel: family.label, failure: outcome });
    const note = text
      ? await deps.privateNotes
          .send({ familyId: family.familyId, text })
          .catch(() => 'not_sent' as const)
      : ('draft_failed' as const);
    return { ...base, outcome, note, ...(invite ? { invite } : {}) };
  };

  if (attendance !== 'in') {
    // Cancelled plan, or a family that backed out / never said yes: take back any copy.
    if (!hasCopy) return { ...base, outcome: 'not_in' };
    let eventId: string | null;
    try {
      eventId = await deps.copies.cancelCopy(plan, family.familyId);
    } catch {
      return fail('cancel_failed');
    }
    if (!eventId)
      return { ...base, outcome: attendance === 'cancelled_plan' ? 'cancelled' : 'not_in' };
    const invite = await sendInvite(deps, family.familyId, eventId, 'CANCEL');
    if (!inviteDelivered(invite)) return fail('cancel_failed', invite);
    return { ...base, outcome: 'cancelled', invite };
  }

  let write: CopyWrite;
  try {
    write = await deps.copies.upsertCopy(plan, family.familyId);
  } catch {
    return fail('placement_failed');
  }
  if (write.status === 'unchanged') return { ...base, outcome: 'unchanged' };
  const invite = await sendInvite(deps, family.familyId, write.familyEventId, 'REQUEST');
  if (!inviteDelivered(invite)) return fail('invite_failed', invite);
  return { ...base, outcome: 'invited', invite };
}
