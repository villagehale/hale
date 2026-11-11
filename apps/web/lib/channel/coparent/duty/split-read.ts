import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { CONFIDENCE_FLOOR } from '~/lib/memory/facts';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { DutyClaimKind, DutyParent } from './parse';

/**
 * VIL-661 · a model reads who drives which kid. No keyword matching for meaning.
 * A miss, a low confidence, or `none` writes nothing.
 */

const CLAIMS = ['self', 'other_parent', 'named'] as const;
const KINDS = ['split', 'takes_both', 'change_of_mind', 'none'] as const;

const assignmentSchema = z.object({
  eventKey: z.string(),
  kid: z.string().nullable().optional().default(null),
  claim: z.enum(CLAIMS),
  name: z.string().nullable().optional().default(null),
  confidence: z.number().min(0).max(1).optional().default(0),
});

const llmSchema = z.object({
  kind: z.enum(KINDS).optional().default('none'),
  confidence: z.number().min(0).max(1).optional().default(0),
  assignments: z.array(assignmentSchema).optional().default([]),
});

export const splitDutyToolJsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...KINDS] },
    confidence: { type: 'number' },
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          eventKey: { type: 'string' },
          kid: { type: ['string', 'null'] },
          claim: { type: 'string', enum: [...CLAIMS] },
          name: { type: ['string', 'null'] },
          confidence: { type: 'number' },
        },
        required: ['eventKey', 'claim', 'confidence'],
      },
    },
  },
  required: ['kind', 'confidence', 'assignments'],
} as const;

export interface SplitDutyEvent {
  eventKey: string;
  role: 'dropoff' | 'pickup' | 'attend';
  kid: string | null;
  label: string | null;
  childId?: string | null;
}

export interface SplitDutyAssignment {
  eventKey: string;
  role: SplitDutyEvent['role'];
  kid: string | null;
  claim: Extract<DutyClaimKind, 'self' | 'other_parent' | 'named'>;
  name: string | null;
  userId: string | null;
  confidence: number;
}

export interface SplitDutyRead {
  kind: (typeof KINDS)[number];
  confidence: number;
  write: boolean;
  assignments: SplitDutyAssignment[];
}

export interface SplitDutyReadInput {
  text: string;
  speakerUserId: string;
  parents: readonly DutyParent[];
  events: readonly SplitDutyEvent[];
}

const LLM_CONFIDENCE_CEILING = 0.9;

function eventFor(
  events: readonly SplitDutyEvent[],
  eventKey: string,
  kid: string | null,
): SplitDutyEvent | null {
  const byKey = events.find((row) => row.eventKey === eventKey);
  if (byKey) return byKey;
  const needle = kid?.trim().toLowerCase();
  if (!needle) return null;
  const byKid = events.filter((row) => (row.kid ?? '').trim().toLowerCase() === needle);
  return byKid.length === 1 ? (byKid[0] ?? null) : null;
}

function resolveUser(
  input: SplitDutyReadInput,
  claim: SplitDutyAssignment['claim'],
  name: string | null,
): { name: string | null; userId: string | null } {
  if (claim === 'self') {
    const self = input.parents.find((row) => row.userId === input.speakerUserId);
    return { name: self?.name ?? null, userId: input.speakerUserId };
  }
  if (claim === 'other_parent') {
    const named = name?.trim().toLowerCase() ?? '';
    const parent =
      input.parents.find(
        (row) =>
          row.userId !== input.speakerUserId &&
          (named.length === 0 || row.name.trim().toLowerCase() === named),
      ) ?? null;
    if (!parent) return { name: null, userId: null };
    return { name: parent.name, userId: parent.userId };
  }
  return { name: name?.trim() || null, userId: null };
}

export function splitDutyReadFromExtraction(
  input: SplitDutyReadInput,
  extracted: z.infer<typeof llmSchema>,
): SplitDutyRead {
  const kind = extracted.kind;
  const confidence = Math.min(extracted.confidence, LLM_CONFIDENCE_CEILING);
  if (kind === 'none' || confidence < CONFIDENCE_FLOOR) {
    return { kind: kind === 'none' ? 'none' : kind, confidence, write: false, assignments: [] };
  }
  const wanted = new Map(input.events.map((row) => [row.eventKey, row]));
  const assignments: SplitDutyAssignment[] = [];
  for (const row of extracted.assignments) {
    const event = eventFor(input.events, row.eventKey, row.kid);
    if (!event || !wanted.has(event.eventKey)) continue;
    if (row.confidence < CONFIDENCE_FLOOR) continue;
    const resolved = resolveUser(input, row.claim, row.name);
    if (row.claim !== 'named' && !resolved.userId) continue;
    assignments.push({
      eventKey: event.eventKey,
      role: event.role,
      kid: event.kid,
      claim: row.claim,
      name: resolved.name,
      userId: resolved.userId,
      confidence: Math.min(row.confidence, LLM_CONFIDENCE_CEILING),
    });
    wanted.delete(event.eventKey);
  }
  const both =
    kind === 'takes_both' || kind === 'change_of_mind'
      ? assignments.length === input.events.length
      : assignments.length === input.events.length;
  if (!both) {
    return { kind, confidence, write: false, assignments: [] };
  }
  return { kind, confidence, write: true, assignments };
}

export async function extractSplitDutyReply(
  input: SplitDutyReadInput,
  client: AgentClient,
): Promise<SplitDutyRead> {
  const skill = await loadCronSkill('extract-split-duty');
  const { value } = await forceToolJson({
    client,
    lane: pickLane(skill.meta.task),
    system: skill.instructions,
    userMessage: JSON.stringify({
      reply: input.text,
      parents: input.parents.map((row) => row.name).filter((name) => name.trim().length > 0),
      events: input.events,
    }),
    toolName: 'split_duty',
    toolDescription: 'Who drives which kid, from one co-parent reply. Not a message to a parent.',
    inputJsonSchema: splitDutyToolJsonSchema,
    schema: llmSchema,
    maxTokens: 1024,
  });
  return splitDutyReadFromExtraction(input, value);
}

/** No model: the reply does not assign anyone. Hale does not assume. */
export function emptySplitDutyRead(): SplitDutyRead {
  return { kind: 'none', confidence: 0, write: false, assignments: [] };
}
