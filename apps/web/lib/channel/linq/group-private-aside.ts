import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { type FamilyPrivateSlice, readFamilySliceForAudience } from './multi-family';

/**
 * VIL-457 — private info goes to that family 1:1, never into the group.
 *
 * In a shared multi-family group, the group line stays VIL-439-safe (busy/free only).
 * When a group message touches one family's private information, this sends AT MOST ONE
 * private text, 1:1, to the family that owns it:
 *
 *   1. READ (`group-private-aside-read`): which family's private information the message
 *      touches, as a ref (f1, f2, ...) or `none`. The model reads meaning in any language;
 *      no names or words are matched in code. The read sees refs and kids' first names,
 *      never private content.
 *   2. DRAFT (`group-private-aside-draft`): sees ONLY that family's own consented slice
 *      plus the group message (already public), and writes the 1:1 text or declines.
 *      It cannot leak another family's data because it never has any.
 *
 * Code checks facts only: the ref names a family with a live, consented join in THIS
 * chat; the draft is non-empty; one aside per inbound group message. Any failed read or
 * draft sends nothing (no fixed copy, no fallback).
 */

export const PRIVATE_ASIDE_AUDIT = 'linq_private_aside_sent';

export interface PrivateAsideReadInput {
  text: string;
  senderFamily: string | null;
  families: readonly { ref: string; kids: readonly string[] }[];
  recent: readonly { from: 'hale' | 'member'; text: string }[];
}

export interface PrivateAsideDraftInput {
  groupText: string;
  askedByThisFamily: boolean;
  private: Omit<FamilyPrivateSlice, 'familyId'>;
  language: string | null;
}

export interface PrivateAsideModel {
  /** A family ref, `none`, or null when the read failed. */
  read(input: PrivateAsideReadInput): Promise<string | null>;
  /** `{ send:false }` when the model declines; null when the draft failed. */
  draft(input: PrivateAsideDraftInput): Promise<{ send: boolean; text: string } | null>;
}

export type SendOneToOne = (input: {
  familyId: string;
  text: string;
  dedupeKey: string;
}) => Promise<'sent' | 'suppressed' | 'failed'>;

export type PrivateAsideOutcome =
  | { outcome: 'no_families' }
  | { outcome: 'already_handled' }
  | { outcome: 'read_failed' }
  | { outcome: 'none' }
  | { outcome: 'unknown_ref'; ref: string }
  | { outcome: 'no_private_data'; familyId: string }
  | { outcome: 'draft_failed'; familyId: string }
  | { outcome: 'declined'; familyId: string }
  | { outcome: 'sent' | 'suppressed' | 'failed'; familyId: string };

const readSchema = z.object({ about: z.string().min(1) });
const draftSchema = z.object({ send: z.boolean(), text: z.string() });

/** The read's user payload. Shared with the eval so it replays this exact request. */
export function privateAsideReadMessage(input: PrivateAsideReadInput): string {
  return JSON.stringify({
    text: input.text,
    senderFamily: input.senderFamily,
    families: input.families.map((f) => ({ ref: f.ref, kids: [...f.kids] })),
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
    properties: { about: { type: 'string', enum: [...refs, 'none'] } },
    required: ['about'],
  } as const;
}

export const PRIVATE_ASIDE_DRAFT_SCHEMA = {
  type: 'object',
  properties: { send: { type: 'boolean' }, text: { type: 'string' } },
  required: ['send', 'text'],
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

async function alreadyHandled(database: Database, inboundId: string): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, PRIVATE_ASIDE_AUDIT),
        eq(schema.auditLog.targetId, inboundId),
      ),
    )
    .limit(1);
  return Boolean(row);
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

export async function runPrivateAside(
  database: Database,
  deps: { model: PrivateAsideModel; sendOneToOne: SendOneToOne },
  input: {
    chatId: string;
    /** The inbound group message id: the one-aside-per-turn key. */
    inboundId: string;
    text: string;
    senderFamilyId: string | null;
    recent: PrivateAsideReadInput['recent'];
    language: string | null;
  },
): Promise<PrivateAsideOutcome> {
  const familyIds = await joinedFamilies(database, input.chatId);
  if (familyIds.length === 0) return { outcome: 'no_families' };
  if (await alreadyHandled(database, input.inboundId)) return { outcome: 'already_handled' };

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

  const about = await deps.model.read({
    text: input.text,
    senderFamily: input.senderFamilyId ? (refOf.get(input.senderFamilyId) ?? null) : null,
    families: familyIds.map((id) => ({
      ref: refOf.get(id) as string,
      kids: slices.get(id)?.children ?? [],
    })),
    recent: input.recent,
  });
  if (about === null) return { outcome: 'read_failed' };
  if (about === 'none') return { outcome: 'none' };
  const familyId = idOf.get(about);
  if (!familyId) return { outcome: 'unknown_ref', ref: about };

  const slice = slices.get(familyId) as FamilyPrivateSlice;
  if (!hasPrivateData(slice)) return { outcome: 'no_private_data', familyId };
  const { familyId: _owner, ...privateOnly } = slice;
  const draft = await deps.model.draft({
    groupText: input.text,
    askedByThisFamily: input.senderFamilyId === familyId,
    private: privateOnly,
    language: input.language,
  });
  if (draft === null) return { outcome: 'draft_failed', familyId };
  const text = draft.text.trim();
  if (!draft.send || text.length === 0) return { outcome: 'declined', familyId };

  const delivered = await deps.sendOneToOne({
    familyId,
    text,
    dedupeKey: `linq:private_aside:${input.chatId}:${input.inboundId}`,
  });
  // Recorded whatever the delivery said, so a retry of the same inbound never asks twice.
  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: PRIVATE_ASIDE_AUDIT,
    targetTable: 'channel_messages',
    targetId: input.inboundId,
    after: { delivered },
  });
  return { outcome: delivered, familyId };
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
          toolDescription: "Return which family's private information this group message touches.",
          inputJsonSchema: privateAsideReadSchema(refs),
          schema: readSchema,
          maxTokens: PRIVATE_ASIDE_READ_MAX_TOKENS,
        });
        return value.about;
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
