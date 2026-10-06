import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import type { Database } from '@hale/db';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  type WorkstreamApplyResult,
  type WorkstreamOp,
  applyWorkstreamOps,
  listOpenWorkstreams,
} from './workstreams';

/**
 * VIL-419 — one structured extraction after a reply turn.
 *
 * The skill is loaded by name. The model returns ops. Code stores them.
 * Nothing here matches the parent's words. A failure is named and stores
 * nothing, so a bad extraction cannot invent a thread.
 */

const TOOL_NAME = 'record_workstreams';

/**
 * A configured Anthropic client, or null when the key is absent or is a
 * placeholder. Real keys start with `sk-`. A placeholder is `not_configured`
 * (rule #11): constructing a client from one would open a network call that
 * cannot succeed.
 */
export function workstreamExtractClient(): AgentClient | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.startsWith('sk-')) return null;
  return budgetedAnthropic({ timeout: 20_000, maxRetries: 0 });
}

const STATUSES = [
  'open',
  'waiting_on_parent',
  'waiting_on_third_party',
  'scheduled',
  'done',
  'dropped',
] as const;

const opSchema = z.object({
  action: z.enum(['none', 'open', 'update', 'close', 'drop']).default('none'),
  id: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  status: z.enum(STATUSES).nullable().optional(),
  nextStep: z.string().nullable().optional(),
  checkBackAt: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  childIds: z.array(z.string()).optional().default([]),
  eventIds: z.array(z.string()).optional().default([]),
  activityRefs: z.array(z.string()).optional().default([]),
  declined: z.boolean().optional().default(false),
});

const extractionSchema = z.object({
  ops: z.array(opSchema).max(4).default([]),
});

export const workstreamToolJsonSchema = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['none', 'open', 'update', 'close', 'drop'] },
          id: { type: ['string', 'null'] },
          title: { type: ['string', 'null'] },
          status: { type: ['string', 'null'], enum: [...STATUSES, null] },
          nextStep: { type: ['string', 'null'] },
          checkBackAt: { type: ['string', 'null'] },
          expiresAt: { type: ['string', 'null'] },
          childIds: { type: 'array', items: { type: 'string' } },
          eventIds: { type: 'array', items: { type: 'string' } },
          activityRefs: { type: 'array', items: { type: 'string' } },
          declined: { type: 'boolean' },
        },
        required: ['action'],
      },
    },
  },
  required: ['ops'],
} as const;

export type WorkstreamExtractResult =
  | { applied: WorkstreamApplyResult[]; skipped?: undefined }
  | { applied: []; skipped: 'empty_turn' | 'extract_failed' | 'not_configured' };

function toOp(value: z.infer<typeof opSchema>): WorkstreamOp {
  return {
    action: value.action,
    id: value.id,
    title: value.title,
    status: value.status,
    nextStep: value.nextStep,
    checkBackAt: value.checkBackAt,
    expiresAt: value.expiresAt,
    childIds: value.childIds,
    eventIds: value.eventIds,
    activityRefs: value.activityRefs,
    declined: value.declined,
  };
}

export async function rememberWorkstreamTurn(input: {
  database: Database;
  familyId: string;
  parentText: string;
  haleText: string;
  provenance: string;
  now: Date;
  client: AgentClient | null;
}): Promise<WorkstreamExtractResult> {
  const parentText = input.parentText.trim();
  if (!parentText) return { applied: [], skipped: 'empty_turn' };
  if (!input.client) {
    console.info({ skipped: 'not_configured' }, 'workstream extract: no model client');
    return { applied: [], skipped: 'not_configured' };
  }

  try {
    const open = await listOpenWorkstreams(input.database, input.familyId, input.now);
    const skill = await loadCronSkill('extract-workstream');
    const listed = open
      .map(
        (row) =>
          `- id=${row.id} status=${row.status} title=${row.title} next=${row.nextStep ?? 'none'}`,
      )
      .join('\n');
    const { value } = await forceToolJson({
      client: input.client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: `parent:\n${parentText}\n\nhale:\n${input.haleText}\n\nopen:\n${listed || 'none'}`,
      toolName: TOOL_NAME,
      toolDescription: 'Open, update, close, or drop workstreams from this one turn.',
      inputJsonSchema: workstreamToolJsonSchema as unknown as Anthropic.Tool.InputSchema,
      schema: extractionSchema,
      maxTokens: 2048,
      transport: 'create',
    });
    const applied = await applyWorkstreamOps(input.database, {
      familyId: input.familyId,
      provenance: input.provenance,
      now: input.now,
      ops: value.ops.map(toOp),
    });
    return { applied };
  } catch (err) {
    console.error(
      { skipped: 'extract_failed', err: err instanceof Error ? err.name : 'unknown' },
      'workstream extract failed',
    );
    return { applied: [], skipped: 'extract_failed' };
  }
}
