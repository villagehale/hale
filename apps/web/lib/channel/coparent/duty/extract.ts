import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import { needsWhichKid } from './model';
import {
  type DutyClaimKind,
  type DutyParse,
  type DutyParseInput,
  type DutySlot,
  finishDutyParse,
} from './parse';

/**
 * VIL-381 — structured extraction after the deterministic rules miss.
 *
 * The skill is loaded by name. A name the reply does not contain is dropped.
 * Confidence is capped, and anything under the memory floor does not write.
 */

const CLAIMS = [
  'self',
  'other_parent',
  'named',
  'both',
  'neither',
  'maybe',
  'not_me',
  'unclear',
] as const;

const ROLES = ['dropoff', 'pickup', 'attend'] as const;

const llmSchema = z.object({
  question: z.boolean().optional().default(false),
  confidence: z.number().min(0).max(1).optional().default(0),
  slots: z
    .array(
      z.object({
        role: z.enum(ROLES).optional().default('attend'),
        claim: z.enum(CLAIMS).optional().default('unclear'),
        name: z.string().nullable().optional().default(null),
        confidence: z.number().min(0).max(1).optional().default(0),
      }),
    )
    .optional()
    .default([]),
});

export const dutyToolJsonSchema = {
  type: 'object',
  properties: {
    question: { type: 'boolean' },
    confidence: { type: 'number' },
    slots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: [...ROLES] },
          claim: { type: 'string', enum: [...CLAIMS] },
          name: { type: ['string', 'null'] },
          confidence: { type: 'number' },
        },
        required: ['role', 'claim', 'name', 'confidence'],
      },
    },
  },
  required: ['question', 'confidence', 'slots'],
} as const;

const LLM_CONFIDENCE_CEILING = 0.9;

function wordIn(text: string, name: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (escaped.length < 2) return false;
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(` ${text} `);
}

function corroboratedSlot(
  text: string,
  input: DutyParseInput,
  row: { role: DutySlot['role']; claim: string; name: string | null; confidence: number },
): DutySlot | null {
  if (row.claim === 'unclear') return null;
  const claim = row.claim as DutyClaimKind;
  const confidence = Math.min(row.confidence, LLM_CONFIDENCE_CEILING);
  if (claim === 'named') {
    const name = row.name?.trim() ?? '';
    if (!name || !wordIn(text, name)) return null;
    const parent = input.parents.some(
      (item) => item.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (parent) return null;
    return { role: row.role, claim, name, userId: null, confidence };
  }
  if (claim === 'other_parent') {
    const name = row.name?.trim() ?? '';
    const parent =
      input.parents.find(
        (item) =>
          item.name.trim().toLowerCase() === name.toLowerCase() &&
          item.userId !== input.speakerUserId,
      ) ?? null;
    const you = /\b(you|toi)\b/i.test(text);
    if (!parent && !you) return null;
    const other =
      parent ?? input.parents.find((item) => item.userId !== input.speakerUserId) ?? null;
    if (!other) return null;
    return {
      role: row.role,
      claim,
      name: other.name,
      userId: other.userId,
      confidence,
    };
  }
  if (claim === 'self' || claim === 'not_me' || claim === 'maybe') {
    return {
      role: row.role,
      claim,
      name: null,
      userId: input.speakerUserId,
      confidence,
    };
  }
  return { role: row.role, claim, name: null, userId: null, confidence };
}

export function dutyParseFromExtraction(
  input: DutyParseInput,
  extracted: z.infer<typeof llmSchema>,
): DutyParse {
  const askWhichKid = needsWhichKid(input.eventTitle, input.childNames ?? []);
  if (extracted.question || input.text.includes('?')) {
    return finishDutyParse({
      method: 'llm',
      llm: 'used',
      slots: [],
      question: true,
      askWhichKid,
    });
  }
  const kept = extracted.slots
    .map((row) => corroboratedSlot(input.text, input, row))
    .filter((row): row is DutySlot => row !== null);
  const confidence = Math.min(
    extracted.confidence,
    kept.length === 0 ? 0 : Math.min(...kept.map((row) => row.confidence)),
  );
  return finishDutyParse({
    method: kept.length === 0 ? 'none' : 'llm',
    llm: 'used',
    slots: kept,
    question: false,
    askWhichKid,
    confidence,
  });
}

export async function extractDutyReply(
  input: DutyParseInput,
  client: AgentClient,
): Promise<DutyParse> {
  const skill = await loadCronSkill('extract-coparent-duty');
  const parents = input.parents
    .map((parent) => parent.name)
    .filter((name) => name.trim().length > 0);
  const { value } = await forceToolJson({
    client,
    lane: pickLane(skill.meta.task),
    system: skill.instructions,
    userMessage: JSON.stringify({
      reply: input.text,
      askedRole: input.askedRole ?? null,
      parentNames: parents,
    }),
    toolName: 'coparent_duty',
    toolDescription: 'Structured duty slots from one co-parent reply. Not a message to a parent.',
    inputJsonSchema: dutyToolJsonSchema,
    schema: llmSchema,
    maxTokens: 1024,
  });
  return dutyParseFromExtraction(input, value);
}
