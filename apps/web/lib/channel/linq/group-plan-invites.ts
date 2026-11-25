import { createHash } from 'node:crypto';
import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-455 (T13) — a group plan's per-family pieces.
 *
 * Each family's family_events copy is keyed by (group plan, family), so a re-write never
 * double-places. The group plan calendar writes it only after that parent's own 1:1 OK
 * (VIL-773). The fan-out that placed a copy and an invite for every family the model read
 * as `in` from group words is gone; the attendance read and the failure note writer
 * below have no production caller.
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
 * The copy's claim key: a UUID derived from (group plan, family), stored in
 * `family_events.group_plan_copy_key` (migration 0188) with its own partial unique index,
 * so a concurrent or redelivered fan-out conflicts instead of placing a second copy.
 * `placed_by_action_id` stays null: readers join it to `actions`.
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
        .values({ familyId, source: 'placement', groupPlanCopyKey: key, ...values })
        .onConflictDoNothing({
          target: fe.groupPlanCopyKey,
          where: sql`${fe.groupPlanCopyKey} IS NOT NULL`,
        })
        .returning({ id: fe.id });
      if (inserted) return { status: 'written', familyEventId: inserted.id };
      const [row] = await database
        .select()
        .from(fe)
        .where(and(eq(fe.groupPlanCopyKey, key), eq(fe.familyId, familyId)))
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
        .where(and(eq(fe.groupPlanCopyKey, key), eq(fe.familyId, familyId), isNull(fe.deletedAt)))
        .returning({ id: fe.id });
      return row?.id ?? null;
    },
  };
}
