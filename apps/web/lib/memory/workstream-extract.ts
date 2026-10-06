import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { ageInMonths, deriveStage } from '@hale/types';
import { and, desc, eq, gt, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import { budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { formatOffsetIso, resolveCheckBackAt, workstreamLanguage } from './workstream-time';
import {
  type WorkstreamApplyResult,
  type WorkstreamOp,
  applyWorkstreamOps,
  haleActionNextStep,
  listOpenWorkstreams,
  workstreamsEnabled,
} from './workstreams';

/**
 * VIL-419 — one structured extraction after a reply turn.
 *
 * The skill is loaded by name. The model returns ops. Code stores them.
 * Nothing here matches the parent's words. A failure is named and stores
 * nothing, so a bad extraction cannot invent a thread.
 *
 * The whole call, including the write, stays behind WORKSTREAMS_ENABLED.
 * Exactly `true`. Anything else returns before a read or a model call.
 */

const TOOL_NAME = 'record_workstreams';
const EVENT_WINDOW_PAST_MS = 30 * 24 * 60 * 60 * 1000;
const EVENT_WINDOW_FUTURE_MS = 90 * 24 * 60 * 60 * 1000;
const EVENT_LIMIT = 8;

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
  | {
      applied: [];
      skipped: 'empty_turn' | 'flag_off' | 'extract_failed' | 'not_configured';
    };

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

interface ExtractChild {
  id: string;
  name: string;
  dateOfBirth: string;
}

interface ExtractEvent {
  id: string;
  title: string;
  startsAt: Date;
  childId: string | null;
}

interface ExtractContext {
  timeZone: string;
  language: 'en' | 'fr';
  children: ExtractChild[];
  events: ExtractEvent[];
}

function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first.replace(/[\r\n]/g, '').slice(0, 40);
}

function clipLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 80 ? collapsed : `${collapsed.slice(0, 79)}…`;
}

/** Ids the model was shown. A name, or an id from outside this list, is dropped. */
function keepListed(values: readonly string[] | undefined, allowed: ReadonlySet<string>): string[] {
  if (!values) return [];
  const out: string[] = [];
  for (const value of values) {
    const id = value.toLowerCase();
    if (!allowed.has(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 6) break;
  }
  return out;
}

function asCheckBackIso(
  value: string | null | undefined,
  now: Date,
  timeZone: string,
): string | null | undefined {
  const resolved = resolveCheckBackAt(value, now, timeZone);
  if (resolved === undefined) return undefined;
  if (resolved === null) return null;
  return resolved.toISOString();
}

function normalizeOp(op: WorkstreamOp, ctx: ExtractContext, now: Date): WorkstreamOp {
  const childAllowed = new Set(ctx.children.map((child) => child.id.toLowerCase()));
  const eventById = new Map(ctx.events.map((event) => [event.id.toLowerCase(), event]));
  const childIds = keepListed(op.childIds, childAllowed);
  const eventIds = keepListed(op.eventIds, new Set(eventById.keys()));
  const teenIds = new Set(
    ctx.children
      .filter((child) => deriveStage(child.dateOfBirth, now) === 'teenager')
      .map((child) => child.id.toLowerCase()),
  );
  for (const eventId of eventIds) {
    const childId = eventById.get(eventId)?.childId?.toLowerCase();
    if (!childId || !teenIds.has(childId) || childIds.includes(childId)) continue;
    childIds.push(childId);
  }
  return withoutHalePromise({
    ...op,
    childIds,
    eventIds,
    checkBackAt: asCheckBackIso(op.checkBackAt, now, ctx.timeZone),
  });
}

/**
 * A next step that says Hale will chase someone is not a plan. Drop it. The
 * wait, when the model had not already scheduled the occasion, is the outside
 * party's, with nothing promised on Hale's side.
 */
function withoutHalePromise(op: WorkstreamOp): WorkstreamOp {
  if (op.action !== 'open' && op.action !== 'update') return op;
  if (op.declined === true) return op;
  if (!haleActionNextStep(op.nextStep)) return op;
  const status =
    op.status === 'scheduled' || op.status === 'waiting_on_third_party'
      ? op.status
      : 'waiting_on_third_party';
  return { ...op, nextStep: null, status };
}

async function loadExtractContext(
  database: Database,
  familyId: string,
  now: Date,
): Promise<ExtractContext> {
  const [family] = await database
    .select({ primaryLanguage: schema.families.primaryLanguage })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  const [parent] = await database
    .select({ timezone: schema.users.timezone })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.familyMembers.userId))
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);
  const children = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  const events = await database
    .select({
      id: schema.familyEvents.id,
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
      childId: schema.familyEvents.childId,
    })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        isNull(schema.familyEvents.deletedAt),
        eq(schema.familyEvents.sensitive, false),
        gt(schema.familyEvents.startsAt, new Date(now.getTime() - EVENT_WINDOW_PAST_MS)),
        lt(schema.familyEvents.startsAt, new Date(now.getTime() + EVENT_WINDOW_FUTURE_MS)),
      ),
    )
    .orderBy(desc(schema.familyEvents.startsAt))
    .limit(EVENT_LIMIT);
  return {
    timeZone: parent?.timezone || DEFAULT_TIMEZONE,
    language: workstreamLanguage(family?.primaryLanguage),
    children,
    events,
  };
}

export function renderWorkstreamExtractInput(input: {
  now: Date;
  timeZone: string;
  language: 'en' | 'fr';
  children: readonly { id: string; name: string; ageMonths: number }[];
  events: readonly { id: string; title: string; startsAt: string }[];
  parentText: string;
  haleText: string;
  openLines: string;
}): string {
  const children =
    input.children.length === 0
      ? 'none'
      : input.children
          .map((child) => `- id=${child.id} name=${child.name} age_months=${child.ageMonths}`)
          .join('\n');
  const events =
    input.events.length === 0
      ? 'none'
      : input.events
          .map((event) => `- id=${event.id} title=${event.title} starts=${event.startsAt}`)
          .join('\n');
  return [
    `now: ${formatOffsetIso(input.now, input.timeZone)}`,
    `timezone: ${input.timeZone}`,
    `language: ${input.language}`,
    '',
    'children:',
    children,
    '',
    'events:',
    events,
    '',
    'parent:',
    input.parentText,
    '',
    'hale:',
    input.haleText,
    '',
    'open:',
    input.openLines || 'none',
  ].join('\n');
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
  if (!workstreamsEnabled()) return { applied: [], skipped: 'flag_off' };
  if (!input.client) {
    console.info({ skipped: 'not_configured' }, 'workstream extract: no model client');
    return { applied: [], skipped: 'not_configured' };
  }

  try {
    const [open, ctx] = await Promise.all([
      listOpenWorkstreams(input.database, input.familyId, input.now),
      loadExtractContext(input.database, input.familyId, input.now),
    ]);
    const skill = await loadCronSkill('extract-workstream');
    const openLines = open
      .map(
        (row) =>
          `- id=${row.id} status=${row.status} title=${row.title} next=${row.nextStep ?? 'none'} children=${row.childIds.join(',') || 'none'}`,
      )
      .join('\n');
    const userMessage = renderWorkstreamExtractInput({
      now: input.now,
      timeZone: ctx.timeZone,
      language: ctx.language,
      children: ctx.children.map((child) => ({
        id: child.id,
        name: firstName(child.name),
        ageMonths: ageInMonths(child.dateOfBirth, input.now),
      })),
      events: ctx.events.map((event) => ({
        id: event.id,
        title: clipLine(event.title),
        startsAt: formatOffsetIso(event.startsAt, ctx.timeZone),
      })),
      parentText,
      haleText: input.haleText,
      openLines,
    });
    const { value } = await forceToolJson({
      client: input.client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage,
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
      ops: value.ops.map((op) => normalizeOp(toOp(op), ctx, input.now)),
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
