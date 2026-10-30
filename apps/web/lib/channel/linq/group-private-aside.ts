import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { type FamilyPrivateSlice, readFamilySliceForAudience } from './multi-family';

/**
 * VIL-457 — private info goes to that family 1:1, never into the group.
 *
 * In a shared multi-family group, the group line stays VIL-439-safe (busy/free only).
 * When a group message touches families' OWN private information (a group time that
 * clashes with their commitments, or a family asking about its own private things), each
 * of those families gets at most one private text, about only its own part:
 *
 *   1. READ (`group-private-aside-read`): the refs (f1, f2, ...) of the families whose own
 *      private information the answer depends on, possibly none. Meaning in any language;
 *      no names or words are matched in code. The read sees refs, kids' first names, and
 *      clock-shaped plan/event times as facts (not a word list). A private aside goes
 *      only to a family whose own facts actually clash with the plan; no clash means no
 *      text. Another family asking about someone's kid is NOT a reason: that family gets
 *      nothing (Sloane, #934) and the group reply stays busy/free.
 *   2. DRAFT (`group-private-aside-draft`), once per picked family: sees ONLY that family's
 *      consented slice, the public group text, that family's last delivered aside, and
 *      the same clock-shaped plan/event times. It writes the text, or declines, including
 *      when nothing overlaps or it would repeat the last aside with nothing changed. Code
 *      never compares texts or topics, and never decides a clash by keyword.
 *
 * Code checks facts only: each ref is a live, consented join in THIS chat; one aside per
 * (group message, family), keyed on the audit row; the draft is non-empty. A failed read
 * or draft sends nothing (no fixed copy, no fallback).
 */

export const PRIVATE_ASIDE_AUDIT = 'linq_private_aside_sent';

export interface PrivateAsideReadInput {
  text: string;
  senderFamily: string | null;
  families: readonly { ref: string; kids: readonly string[]; times: readonly string[] }[];
  /** Clock-shaped facts from the group message, when code could read a clock. */
  planTimes: readonly string[];
  recent: readonly { from: 'hale' | 'member'; text: string }[];
}

/** This family's last private aside in this chat, for the repeat call. Null when none. */
export interface LastPrivateAside {
  about: string;
  text: string;
  at: string;
}

export interface PrivateAsideDraftInput {
  groupText: string;
  askedByThisFamily: boolean;
  /** Clock-shaped facts from the group message, when code could read a clock. */
  planTimes: readonly string[];
  private: Omit<FamilyPrivateSlice, 'familyId'>;
  /** This family's own clock-shaped event times, when code could read a clock. */
  ownTimes: readonly string[];
  lastAside: LastPrivateAside | null;
  language: string | null;
}

export interface PrivateAsideDraft {
  send: boolean;
  /** A short gist of what the text is about, stored for the next repeat call. */
  about: string;
  text: string;
}

export interface PrivateAsideModel {
  /** Family refs (possibly empty), or null when the read failed. */
  read(input: PrivateAsideReadInput): Promise<string[] | null>;
  /** `{ send:false }` when the model declines (incl. a repeat); null when the draft failed. */
  draft(input: PrivateAsideDraftInput): Promise<PrivateAsideDraft | null>;
}

export type SendOneToOne = (input: {
  familyId: string;
  text: string;
  dedupeKey: string;
}) => Promise<'sent' | 'suppressed' | 'failed'>;

export type FamilyAsideOutcome =
  | 'already_handled'
  | 'no_private_data'
  | 'draft_failed'
  | 'declined'
  | 'sent'
  | 'suppressed'
  | 'failed';

export type PrivateAsideOutcome =
  | { outcome: 'no_families' }
  | { outcome: 'read_failed' }
  | { outcome: 'none' }
  | { outcome: 'unknown_ref'; refs: string[] }
  | { outcome: 'ran'; families: { familyId: string; outcome: FamilyAsideOutcome }[] };

const readSchema = z.object({ families: z.array(z.string().min(1)) });
const draftSchema = z.object({ send: z.boolean(), about: z.string(), text: z.string() });

/**
 * Clock-shaped strings the model may compare as facts. A digit plus a clock mark
 * (`9h`, `10am`, `4:30pm`) — not a word list of event types.
 */
const CLOCK_MARK = /\d{1,2}\s*h(?:\d{2})?\b|\d{1,2}:\d{2}|\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)\b/i;

export function clockBearingFacts(texts: readonly string[]): string[] {
  return [...new Set(texts.filter((text) => CLOCK_MARK.test(text)))];
}

export function privateTimesOf(
  slice: Pick<FamilyPrivateSlice, 'memory' | 'calendar' | 'signups'>,
): string[] {
  return clockBearingFacts([...slice.memory, ...slice.calendar, ...slice.signups]);
}

/** The read's user payload. Shared with the eval so it replays this exact request. */
export function privateAsideReadMessage(input: PrivateAsideReadInput): string {
  return JSON.stringify({
    text: input.text,
    senderFamily: input.senderFamily,
    families: input.families.map((f) => ({ ref: f.ref, kids: [...f.kids], times: [...f.times] })),
    planTimes: [...input.planTimes],
    recent: input.recent.slice(-6),
  });
}

/** The draft's user payload. Shared with the eval. */
export function privateAsideDraftMessage(input: PrivateAsideDraftInput): string {
  return JSON.stringify(input);
}

export function privateAsideReadSchema(refs: readonly string[]) {
  return {
    type: 'object',
    properties: {
      families: { type: 'array', items: { type: 'string', enum: [...refs] }, uniqueItems: true },
    },
    required: ['families'],
  } as const;
}

export const PRIVATE_ASIDE_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    send: { type: 'boolean' },
    about: { type: 'string' },
    text: { type: 'string' },
  },
  required: ['send', 'about', 'text'],
} as const;

export const PRIVATE_ASIDE_READ_MAX_TOKENS = 100;
export const PRIVATE_ASIDE_DRAFT_MAX_TOKENS = 400;

/** Live, consented joins for this chat, in join order: refs are f1, f2, ... in that order. */
async function joinedFamilies(database: Database, chatId: string): Promise<string[]> {
  const rows = await database
    .select({
      familyId: schema.linqMultiFamilyJoins.familyId,
      consentRecordId: schema.linqMultiFamilyJoins.consentRecordId,
    })
    .from(schema.linqMultiFamilyJoins)
    .where(
      and(
        eq(schema.linqMultiFamilyJoins.chatId, chatId),
        isNull(schema.linqMultiFamilyJoins.leftAt),
      ),
    )
    .orderBy(asc(schema.linqMultiFamilyJoins.joinedAt), asc(schema.linqMultiFamilyJoins.createdAt));
  return rows.filter((r) => r.consentRecordId).map((r) => r.familyId);
}

/** The cap: one aside per (group message, family). */
async function alreadyHandled(
  database: Database,
  inboundId: string,
  familyId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, PRIVATE_ASIDE_AUDIT),
        eq(schema.auditLog.targetId, inboundId),
        eq(schema.auditLog.familyId, familyId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** This family's last DELIVERED aside in this chat. A fact read; no text is compared. */
async function lastAsideOf(
  database: Database,
  chatId: string,
  familyId: string,
): Promise<LastPrivateAside | null> {
  const rows = await database
    .select({ after: schema.auditLog.after, at: schema.auditLog.occurredAt })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, PRIVATE_ASIDE_AUDIT),
        eq(schema.auditLog.familyId, familyId),
      ),
    )
    .orderBy(desc(schema.auditLog.occurredAt))
    .limit(20);
  for (const row of rows) {
    const after = row.after as {
      chatId?: string;
      delivered?: string;
      about?: string;
      text?: string;
    };
    if (after?.chatId === chatId && after.delivered === 'sent' && after.text) {
      return { about: after.about ?? '', text: after.text, at: row.at.toISOString() };
    }
  }
  return null;
}

function hasPrivateData(slice: FamilyPrivateSlice): boolean {
  return (
    slice.children.length +
      slice.memory.length +
      slice.calendar.length +
      slice.email.length +
      slice.signups.length >
    0
  );
}

async function asideForFamily(
  database: Database,
  deps: { model: PrivateAsideModel; sendOneToOne: SendOneToOne },
  input: {
    chatId: string;
    inboundId: string;
    text: string;
    senderFamilyId: string | null;
    language: string | null;
  },
  familyId: string,
  slice: FamilyPrivateSlice,
): Promise<FamilyAsideOutcome> {
  if (await alreadyHandled(database, input.inboundId, familyId)) return 'already_handled';
  if (!hasPrivateData(slice)) return 'no_private_data';
  const { familyId: _owner, ...privateOnly } = slice;
  const draft = await deps.model.draft({
    groupText: input.text,
    askedByThisFamily: input.senderFamilyId === familyId,
    planTimes: clockBearingFacts([input.text]),
    private: privateOnly,
    ownTimes: privateTimesOf(slice),
    lastAside: await lastAsideOf(database, input.chatId, familyId),
    language: input.language,
  });
  if (draft === null) return 'draft_failed';
  const text = draft.text.trim();
  if (!draft.send || text.length === 0) return 'declined';
  const delivered = await deps.sendOneToOne({
    familyId,
    text,
    dedupeKey: `linq:private_aside:${input.chatId}:${input.inboundId}:${familyId}`,
  });
  // Recorded whatever the delivery said, so a retry of the same message never re-sends to
  // this family. The text and gist are this family's own, kept on its own row so the next
  // draft can tell a repeat from a change.
  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: PRIVATE_ASIDE_AUDIT,
    targetTable: 'channel_messages',
    targetId: input.inboundId,
    after: { chatId: input.chatId, delivered, about: draft.about, text },
  });
  return delivered;
}

export async function runPrivateAside(
  database: Database,
  deps: { model: PrivateAsideModel; sendOneToOne: SendOneToOne },
  input: {
    chatId: string;
    /** The inbound group message id: with the family, the one-per-family cap key. */
    inboundId: string;
    text: string;
    senderFamilyId: string | null;
    recent: PrivateAsideReadInput['recent'];
    language: string | null;
  },
): Promise<PrivateAsideOutcome> {
  const familyIds = await joinedFamilies(database, input.chatId);
  if (familyIds.length === 0) return { outcome: 'no_families' };

  const slices = new Map<string, FamilyPrivateSlice>();
  for (const familyId of familyIds) {
    const { slice } = await readFamilySliceForAudience(database, {
      chatId: input.chatId,
      dataFamilyId: familyId,
      audience: familyId,
    });
    slices.set(familyId, slice);
  }
  const refOf = new Map(familyIds.map((id, i) => [id, `f${i + 1}`]));
  const idOf = new Map(familyIds.map((id, i) => [`f${i + 1}`, id]));

  const refs = await deps.model.read({
    text: input.text,
    senderFamily: input.senderFamilyId ? (refOf.get(input.senderFamilyId) ?? null) : null,
    families: familyIds.map((id) => ({
      ref: refOf.get(id) as string,
      kids: slices.get(id)?.children ?? [],
      times: privateTimesOf(slices.get(id) ?? { memory: [], calendar: [], signups: [] }),
    })),
    planTimes: clockBearingFacts([input.text]),
    recent: input.recent,
  });
  if (refs === null) return { outcome: 'read_failed' };
  const unique = [...new Set(refs)];
  if (unique.length === 0) return { outcome: 'none' };
  const unknown = unique.filter((ref) => !idOf.has(ref));
  if (unknown.length > 0) return { outcome: 'unknown_ref', refs: unknown };

  const families: { familyId: string; outcome: FamilyAsideOutcome }[] = [];
  for (const ref of unique) {
    const familyId = idOf.get(ref) as string;
    families.push({
      familyId,
      outcome: await asideForFamily(
        database,
        deps,
        input,
        familyId,
        slices.get(familyId) as FamilyPrivateSlice,
      ),
    });
  }
  return { outcome: 'ran', families };
}

export function createPrivateAsideModel(
  clientOrResolver: AgentClient | (() => AgentClient),
): PrivateAsideModel {
  const client = () =>
    typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
  const twice = async <T>(label: string, fn: () => Promise<T | null>): Promise<T | null> => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const out = await fn();
        if (out !== null) return out;
      } catch (err) {
        console.warn(
          { attempt, err: err instanceof Error ? err.name : 'unknown' },
          `private aside: ${label} failed`,
        );
      }
    }
    return null;
  };
  return {
    read: (input) =>
      twice('read', async () => {
        const skill = await loadCronSkill('group-private-aside-read');
        const refs = input.families.map((f) => f.ref);
        const { value } = await forceToolJson({
          client: client(),
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: privateAsideReadMessage(input),
          toolName: 'private_aside_read',
          toolDescription:
            'Return the families whose own private information this group message touches.',
          inputJsonSchema: privateAsideReadSchema(refs),
          schema: readSchema,
          maxTokens: PRIVATE_ASIDE_READ_MAX_TOKENS,
        });
        return value.families;
      }),
    draft: (input) =>
      twice('draft', async () => {
        const skill = await loadCronSkill('group-private-aside-draft');
        const { value } = await forceToolJson({
          client: client(),
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: privateAsideDraftMessage(input),
          toolName: 'private_aside',
          toolDescription: 'Return the private 1:1 text for this family, or send false.',
          inputJsonSchema: PRIVATE_ASIDE_DRAFT_SCHEMA,
          schema: draftSchema,
          maxTokens: PRIVATE_ASIDE_DRAFT_MAX_TOKENS,
        });
        return value;
      }),
  };
}

let shared: PrivateAsideModel | null = null;

export function sharedPrivateAsideModel(): PrivateAsideModel {
  shared ??= createPrivateAsideModel(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}
