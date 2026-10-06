import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { f14EnabledFor } from '~/lib/channel/f14';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { deliverFamilyOutbound, familyOutboundTarget } from '~/lib/channel/linq/family-outbound';
import { OPT_OUT_LINE, OPT_OUT_SHORT } from '~/lib/channel/opt-out';
import {
  type OutboundGatePorts,
  type ProactiveHoldReason,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { createOutboundTransport } from '~/lib/channel/outbound-transport';
import { isGsm7 } from '~/lib/channel/sms-segments';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { loadCronSkill } from '~/lib/cron/skill';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  type DueWorkstream,
  listDueWorkstreams,
  markWorkstreamFollowedUp,
  workstreamsEnabled,
} from './workstreams';

/**
 * VIL-419 — a check-back on one open workstream.
 *
 * The model writes the text. This module stores nothing until a send is
 * allowed, and it never substitutes a sentence of its own. A second failure
 * sends nothing and names the miss to #ops.
 *
 * Prompt context and this sweep stay behind WORKSTREAMS_ENABLED. The flag
 * check returns before any read.
 */

export const WORKSTREAM_FOLLOWUP_TEMPLATE_KEY = 'workstream:followup';

const TOOL_NAME = 'write_followup';
const BODY_MAX = 160;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_ACTION = 'workstream_followup_unsent';

const bodySchema = z.object({ body: z.string() });

const bodyJsonSchema = {
  type: 'object',
  properties: { body: { type: 'string' } },
  required: ['body'],
} as const;

export function workstreamFollowupDedupeKey(id: string, checkBackAt: Date): string {
  return `workstream:${id}:${checkBackAt.toISOString()}`;
}

export type WorkstreamComposeResult = { ok: true; body: string } | { ok: false; reason: string };

/** Placeholder keys are not a client. A missing key is the same absence. */
export function workstreamFollowupClient(): AgentClient | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.startsWith('sk-')) return null;
  return budgetedAnthropic({ timeout: 20_000, maxRetries: 0 });
}

function refuseBody(body: string): string | null {
  const text = body.trim();
  if (!text) return 'empty';
  if (text.length > BODY_MAX) return 'too_long';
  if (!isGsm7(text)) return 'encoding';
  const folded = text.toLowerCase();
  if (folded.includes('http://') || folded.includes('https://') || folded.includes('www.')) {
    return 'link';
  }
  if (
    folded.includes(OPT_OUT_LINE.toLowerCase()) ||
    folded.includes(OPT_OUT_SHORT.toLowerCase()) ||
    folded.includes('reply yes')
  ) {
    return 'keyword_ask';
  }
  return null;
}

async function oneAttempt(
  client: AgentClient,
  input: { title: string; status: string; nextStep: string | null; refusal: string | null },
): Promise<WorkstreamComposeResult> {
  const skill = await loadCronSkill('workstream-followup');
  const refusal = input.refusal ? `\nprevious attempt refused: ${input.refusal}` : '';
  try {
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: `title: ${input.title}\nstatus: ${input.status}\nnext: ${input.nextStep ?? 'none'}${refusal}`,
      toolName: TOOL_NAME,
      toolDescription: 'The one check-back text for this open thread.',
      inputJsonSchema: bodyJsonSchema as unknown as Anthropic.Tool.InputSchema,
      schema: bodySchema,
      maxTokens: 256,
      transport: 'create',
    });
    const reason = refuseBody(value.body);
    if (reason) return { ok: false, reason };
    return { ok: true, body: value.body.trim() };
  } catch {
    return { ok: false, reason: 'model_failed' };
  }
}

/**
 * One friend-voice sentence, then one retry. The second failure is a miss,
 * not a fallback sentence.
 */
export async function composeWorkstreamFollowup(input: {
  client: AgentClient;
  title: string;
  status: string;
  nextStep: string | null;
}): Promise<WorkstreamComposeResult> {
  const first = await oneAttempt(input.client, { ...input, refusal: null });
  if (first.ok) return first;
  return oneAttempt(input.client, { ...input, refusal: first.reason });
}

export interface WorkstreamFollowupResult {
  enabled: boolean;
  considered: number;
  sent: number;
  held: Record<ProactiveHoldReason, number>;
  skipped: {
    f14: number;
    already_claimed: number;
    teen_redacted: number;
    no_parent: number;
    no_phone: number;
    not_configured: number;
    compose_failed: number;
  };
  failed: number;
}

function emptyHeld(): WorkstreamFollowupResult['held'] {
  return { not_enrolled: 0, no_watch_consent: 0, frequency_cap: 0, quiet_hours: 0 };
}

function emptyResult(enabled: boolean): WorkstreamFollowupResult {
  return {
    enabled,
    considered: 0,
    sent: 0,
    held: emptyHeld(),
    skipped: {
      f14: 0,
      already_claimed: 0,
      teen_redacted: 0,
      no_parent: 0,
      no_phone: 0,
      not_configured: 0,
      compose_failed: 0,
    },
    failed: 0,
  };
}

export interface WorkstreamFollowupDeps {
  now?: () => Date;
  listDue?: (database: Database, now: Date) => Promise<readonly DueWorkstream[]>;
  f14?: (familyId: string) => boolean;
  parentFor?: (database: Database, familyId: string) => Promise<string | null>;
  linkedTeen?: (
    database: Database,
    familyId: string,
    childIds: readonly string[],
    now: Date,
  ) => Promise<boolean>;
  buildGate?: (database: Database) => OutboundGatePorts;
  dedupeActive?: (database: Database, dedupeKey: string) => Promise<boolean>;
  resolvePhone?: (database: Database, parentUserId: string) => Promise<string | null>;
  compose?: (row: DueWorkstream) => Promise<WorkstreamComposeResult>;
  deliver?: typeof deliverFamilyOutbound;
  recordSend?: (
    database: Database,
    write: {
      familyId: string;
      parentUserId: string;
      dedupeKey: string;
      providerMessageId: string;
      sentAt: Date;
      channel: 'sms' | 'imessage';
      providerChatId: string | null;
    },
  ) => Promise<void>;
  thread?: typeof threadProactiveMessage;
  stamp?: (database: Database, id: string, now: Date) => Promise<void>;
  page?: (text: string) => Promise<unknown>;
  alreadyPaged?: (database: Database, familyId: string, now: Date) => Promise<boolean>;
  noteUnsent?: (database: Database, familyId: string, reason: string, now: Date) => Promise<void>;
  transport?: ChannelTransport;
}

async function primaryParent(database: Database, familyId: string): Promise<string | null> {
  const rows = await database
    .select({ userId: schema.familyMembers.userId })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);
  return rows[0]?.userId ?? null;
}

async function linkedTeen(
  database: Database,
  familyId: string,
  childIds: readonly string[],
  now: Date,
): Promise<boolean> {
  if (childIds.length === 0) return false;
  const rows = await database
    .select({ dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(and(eq(schema.children.familyId, familyId), inArray(schema.children.id, [...childIds])));
  return rows.some((row) => deriveStage(row.dateOfBirth, now) === 'teenager');
}

async function alreadyPaged(database: Database, familyId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - DAY_MS);
  const rows = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, PAGE_ACTION),
        gte(schema.auditLog.occurredAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

function unsentPage(familyId: string, reason: string): string {
  return `workstream followup unsent family=${familyId} reason=${reason}`;
}

async function noteUnsent(
  database: Database,
  familyId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: PAGE_ACTION,
    targetTable: 'family_workstreams',
    after: { reason },
    occurredAt: now,
  });
}

async function defaultCompose(row: DueWorkstream): Promise<WorkstreamComposeResult> {
  const client = workstreamFollowupClient();
  if (!client) return { ok: false, reason: 'not_configured' };
  return composeWorkstreamFollowup({
    client,
    title: row.title,
    status: row.status,
    nextStep: row.nextStep,
  });
}

/**
 * Hourly rider on the nudge cron. Dark until WORKSTREAMS_ENABLED is exactly
 * `true`. Quiet hours and the follow-up cap are the outbound gate's, read
 * before any model call.
 */
export async function runWorkstreamFollowupSweep(
  database: Database,
  deps: WorkstreamFollowupDeps = {},
): Promise<WorkstreamFollowupResult> {
  if (!workstreamsEnabled()) return emptyResult(false);

  const now = deps.now?.() ?? new Date();
  const listDue = deps.listDue ?? listDueWorkstreams;
  const f14 = deps.f14 ?? f14EnabledFor;
  const parentFor = deps.parentFor ?? primaryParent;
  const teen = deps.linkedTeen ?? linkedTeen;
  const buildGate = deps.buildGate ?? buildOutboundGatePorts;
  const claimed = deps.dedupeActive ?? ((db, key) => dedupeActive(key, db));
  const phoneFor = deps.resolvePhone ?? resolveSendablePhone;
  const compose = deps.compose ?? defaultCompose;
  const deliver = deps.deliver ?? deliverFamilyOutbound;
  const stamp = deps.stamp ?? markWorkstreamFollowedUp;
  const page = deps.page ?? postOpsSlack;
  const paged = deps.alreadyPaged ?? alreadyPaged;
  const recordMiss = deps.noteUnsent ?? noteUnsent;
  const thread = deps.thread ?? threadProactiveMessage;
  const result = emptyResult(true);

  let due: readonly DueWorkstream[];
  try {
    due = await listDue(database, now);
  } catch (err) {
    result.failed += 1;
    console.error(
      { err: err instanceof Error ? err.name : 'unknown' },
      'workstream followup: due list failed',
    );
    return result;
  }

  for (const row of due) {
    result.considered += 1;
    try {
      if (!f14(row.familyId)) {
        result.skipped.f14 += 1;
        continue;
      }
      if (await teen(database, row.familyId, row.childIds, now)) {
        await stamp(database, row.id, now);
        result.skipped.teen_redacted += 1;
        continue;
      }
      const parentUserId = await parentFor(database, row.familyId);
      if (!parentUserId) {
        result.skipped.no_parent += 1;
        continue;
      }
      const dedupeKey = workstreamFollowupDedupeKey(row.id, row.checkBackAt);
      if (await claimed(database, dedupeKey)) {
        await stamp(database, row.id, now);
        result.skipped.already_claimed += 1;
        continue;
      }
      const verdict = await assertProactiveSendAllowed(
        { familyId: row.familyId, parentUserId, kind: 'followup', now },
        buildGate(database),
      );
      if (!verdict.allowed) {
        result.held[verdict.reason] += 1;
        continue;
      }
      const composed = await compose(row);
      if (!composed.ok) {
        if (composed.reason === 'not_configured') result.skipped.not_configured += 1;
        else result.skipped.compose_failed += 1;
        if (!(await paged(database, row.familyId, now))) {
          await page(unsentPage(row.familyId, composed.reason));
          await recordMiss(database, row.familyId, composed.reason, now);
        }
        continue;
      }
      const to = await phoneFor(database, parentUserId);
      if (!to) {
        result.skipped.no_phone += 1;
        continue;
      }
      const target = await familyOutboundTarget(database, row.familyId);
      const transport = deps.transport ?? createOutboundTransport();
      const delivered = await deliver(database, {
        familyId: row.familyId,
        body: composed.body,
        to,
        legacy: transport,
        target,
        now,
        bubbleKind: 'discretionary',
      });
      if (delivered.status === 'held') {
        result.held.frequency_cap += 1;
        continue;
      }
      if (delivered.status !== 'sent') {
        result.failed += 1;
        continue;
      }
      if (deps.recordSend) {
        await deps.recordSend(database, {
          familyId: row.familyId,
          parentUserId,
          dedupeKey,
          providerMessageId: delivered.providerMessageId,
          sentAt: now,
          channel: delivered.channel === 'imessage' ? 'imessage' : 'sms',
          providerChatId: delivered.chatId,
        });
      } else {
        await database.insert(schema.channelMessages).values({
          familyId: row.familyId,
          parentUserId,
          channel: delivered.channel === 'imessage' ? 'imessage' : 'sms',
          direction: 'out',
          category: 'followup',
          templateKey: WORKSTREAM_FOLLOWUP_TEMPLATE_KEY,
          dedupeKey,
          providerMessageId: delivered.providerMessageId,
          providerChatId: delivered.chatId,
          status: acceptedStatus(delivered.channel === 'imessage' ? 'imessage' : 'sms'),
          sentAt: now,
        });
      }
      await thread(database, { familyId: row.familyId, parentUserId, body: composed.body });
      await stamp(database, row.id, now);
      await database.insert(schema.auditLog).values({
        familyId: row.familyId,
        actor: 'system',
        actionTaken: 'workstream_followed_up',
        targetTable: 'family_workstreams',
        targetId: row.id,
        after: { status: row.status },
        occurredAt: now,
      });
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      console.error(
        { err: err instanceof Error ? err.name : 'unknown', familyId: row.familyId },
        'workstream followup: row failed',
      );
    }
  }
  return result;
}
