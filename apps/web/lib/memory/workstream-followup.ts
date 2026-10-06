import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { f14EnabledFor } from '~/lib/channel/f14';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import {
  type FamilyOutboundTarget,
  deliverFamilyOutbound,
  familyOutboundTarget,
} from '~/lib/channel/linq/family-outbound';
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
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import { gsmSafe } from '~/lib/loop/templates/weekly-plan/core';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { addCalendarDays, formatLocalDate, localDateParts, timezoneOffsetMs } from './period';
import { isoWeekdayIndex, localDate, localWeekday, workstreamLanguage } from './workstream-time';
import {
  type DueWorkstream,
  haleActionNextStep,
  listDueWorkstreams,
  markWorkstreamFollowedUp,
  workstreamsEnabled,
} from './workstreams';

/**
 * VIL-419 — a check-back on one open workstream.
 *
 * The model writes the text. This module stores nothing until a send is
 * allowed, and it never substitutes a sentence of its own. A second failure
 * inside one sweep sends nothing. A real miss is retried on a later sweep,
 * with backoff, and names the miss to #ops once. The cap is what stops it.
 *
 * Prompt context and this sweep stay behind WORKSTREAMS_ENABLED. The flag
 * check returns before any read.
 */

export const WORKSTREAM_FOLLOWUP_TEMPLATE_KEY = 'workstream:followup';

const TOOL_NAME = 'write_followup';
const BODY_MAX = 160;
const PAGE_ACTION = 'workstream_followup_unsent';
const DEFER_ACTION = 'workstream_followup_deferred';

/** Three real misses, then this check-back stops. The gaps are 6h and 24h. */
export const FOLLOWUP_ATTEMPT_CAP = 3;

/** Group quiet hours end at 08:00 local, the same window family outbound uses. */
const GROUP_QUIET_END_HOUR = 8;

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

const WEEKDAY_ISO: Record<string, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
  mon: 0,
  tue: 1,
  tues: 1,
  wed: 2,
  thu: 3,
  thur: 3,
  thurs: 3,
  fri: 4,
  sat: 5,
  sun: 6,
  lundi: 0,
  mardi: 1,
  mercredi: 2,
  jeudi: 3,
  vendredi: 4,
  samedi: 5,
  dimanche: 6,
  lun: 0,
  jeu: 3,
  ven: 4,
};

const WEEKDAY_WORD = String.raw`\b(?:(next|prochain(?:e)?)\s+)?(mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun|lun|jeu|ven)\b`;

/**
 * A future action whose subject is Hale: first person, first-person plural
 * (we / on / nous), or Hale by name. "Let me know" asks the parent; "let me
 * check" is Hale offering to act. The sweep does not perform any of these.
 */
const COMMITMENT =
  /\b(?:i['’]ll|i will|i['’]m going to|i am going to|let me (?!know\b)|we['’]ll|we will|we['’]re going to|we are going to|hale(?:['’]s| is) going to|hale will|je vais|je relance|je rappelle|j['’](?:é|e)cris|je contacte|je v(?:é|e)rifie|je te tiens|on va|on relance|nous allons)\b/i;

const GREETING = /^(?:hey|hi|hello|bonjour|salut)\b[!,.]*\s*/i;

const STOCK_OPENER =
  /^(?:just (?:checking|wanted to check)|checking in\b|quick check-?in\b|hope your\b|hope you had\b|following up\b|circling back\b|petit suivi\b|still need to know\b)/i;

const PARENT_NEWS = /\b(?:any news|on your end|heard anything|des nouvelles|de ton c[oô]t[eé])\b/i;

/** A question about whether a third party has answered. A status is not one. */
const THIRD_PARTY_REPLY =
  /\b(?:hear back|heard back|update from|any update|news from|r[eé]pondu|r[eé]ponse)\b/i;

const FRENCH_ORDER = /\b(?:tu dois|il faut que tu|faut(?:\s+juste)?\s+que tu|il faut choisir)\b/i;

/**
 * A promised weekday that is today or earlier this week. "next Thursday" is
 * the following one, and a weekday with no promise attached is a status.
 * Short forms count: Thu, Thurs, jeu.
 */
export function promisedPassedWeekday(text: string, now: Date, timeZone: string): boolean {
  if (!COMMITMENT.test(text)) return false;
  const today = isoWeekdayIndex(now, timeZone);
  for (const match of text.matchAll(new RegExp(WEEKDAY_WORD, 'gi'))) {
    if (match[1]) continue;
    const raw = match[2]?.toLowerCase() ?? '';
    const iso = WEEKDAY_ISO[raw] ?? WEEKDAY_ISO[raw.replace(/s$/, '')];
    if (iso !== undefined && iso <= today) return true;
  }
  return false;
}

/** Any Hale-subject plan, including one with no day attached. */
export function inventedHalePromise(text: string): boolean {
  return COMMITMENT.test(text);
}

function stockOpener(text: string): boolean {
  const trimmed = text.trim();
  return STOCK_OPENER.test(trimmed) || STOCK_OPENER.test(trimmed.replace(GREETING, ''));
}

/**
 * A question that asks the parent what a third party did. "Any news" and
 * "des nouvelles" count even without a question mark, which is how the
 * earlier lines were written. A statement that the camp has not written
 * back is not a question.
 */
function asksParentForThirdPartyNews(text: string): boolean {
  if (PARENT_NEWS.test(text)) return true;
  if (!text.includes('?')) return false;
  return THIRD_PARTY_REPLY.test(text);
}

/**
 * An em dash between two letters becomes a spaced hyphen. Ranges (9—10) and
 * an edge dash stay for `gsmSafe`, which folds every dash to a bare hyphen
 * the way the other sends do. Spacing those changed their segment counts.
 */
function spaceFollowupEmDash(text: string): string {
  return text.replace(/([A-Za-zÀ-ÿ])\u2014([A-Za-zÀ-ÿ])/g, '$1 - $2');
}

/**
 * The body that may be sent. A follow-up spaces a word-bounded em dash, then
 * uses the same GSM fold as the other sends (`gsmSafe`). What is left must
 * still be GSM-7. An empty body is the model declining, not a failure.
 */
function prepareBody(
  body: string,
  now: Date,
  timeZone: string,
  status: string,
): { ok: true; body: string } | { ok: false; reason: string } {
  const text = body.trim();
  if (!text) return { ok: false, reason: 'empty' };
  const folded = gsmSafe(spaceFollowupEmDash(text)).trim();
  if (!folded) return { ok: false, reason: 'empty' };
  if (folded.length > BODY_MAX) return { ok: false, reason: 'too_long' };
  if (!isGsm7(folded)) return { ok: false, reason: 'encoding' };
  const lower = folded.toLowerCase();
  if (lower.includes('http://') || lower.includes('https://') || lower.includes('www.')) {
    return { ok: false, reason: 'link' };
  }
  if (
    lower.includes(OPT_OUT_LINE.toLowerCase()) ||
    lower.includes(OPT_OUT_SHORT.toLowerCase()) ||
    lower.includes('reply yes')
  ) {
    return { ok: false, reason: 'keyword_ask' };
  }
  if (stockOpener(folded)) return { ok: false, reason: 'stock_opener' };
  if (FRENCH_ORDER.test(folded)) return { ok: false, reason: 'order' };
  if (promisedPassedWeekday(folded, now, timeZone)) return { ok: false, reason: 'past_weekday' };
  if (inventedHalePromise(folded)) return { ok: false, reason: 'invented_promise' };
  if (status === 'waiting_on_third_party' && asksParentForThirdPartyNews(folded)) {
    return { ok: false, reason: 'parent_news' };
  }
  return { ok: true, body: folded };
}

/** Why a draft cannot be sent, or null when it can. Empty is its own reason. */
export function followupRefusal(
  body: string,
  now: Date,
  timeZone: string,
  status = 'waiting_on_parent',
): string | null {
  const prepared = prepareBody(body, now, timeZone, status);
  return prepared.ok ? null : prepared.reason;
}

function whoseMove(status: string): 'parent' | 'third_party' | 'scheduled' | 'open' {
  if (status === 'waiting_on_parent') return 'parent';
  if (status === 'waiting_on_third_party') return 'third_party';
  if (status === 'scheduled') return 'scheduled';
  return 'open';
}

async function oneAttempt(
  client: AgentClient,
  input: {
    title: string;
    status: string;
    nextStep: string | null;
    refusal: string | null;
    now: Date;
    timeZone: string;
    language: 'en' | 'fr';
  },
): Promise<WorkstreamComposeResult> {
  const skill = await loadCronSkill('workstream-followup');
  const refusal = input.refusal ? `\nprevious attempt refused: ${input.refusal}` : '';
  const userMessage = [
    `today: ${localDate(input.now, input.timeZone)}`,
    `weekday: ${localWeekday(input.now, input.timeZone, input.language)}`,
    `timezone: ${input.timeZone}`,
    `language: ${input.language}`,
    `whose_move: ${whoseMove(input.status)}`,
    `title: ${input.title}`,
    `status: ${input.status}`,
    `next: ${haleActionNextStep(input.nextStep) ? 'none' : (input.nextStep ?? 'none')}`,
  ].join('\n');
  try {
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: `${userMessage}${refusal}`,
      toolName: TOOL_NAME,
      toolDescription: 'The one check-back text for this open thread.',
      inputJsonSchema: bodyJsonSchema as unknown as Anthropic.Tool.InputSchema,
      schema: bodySchema,
      maxTokens: 256,
      transport: 'create',
    });
    return prepareBody(value.body, input.now, input.timeZone, input.status);
  } catch {
    return { ok: false, reason: 'model_failed' };
  }
}

/**
 * One friend-voice sentence, then one retry when the first attempt actually
 * failed. An empty body is the model declining to send, and is not retried.
 * The second failure is a miss, not a fallback sentence.
 */
export async function composeWorkstreamFollowup(input: {
  client: AgentClient;
  title: string;
  status: string;
  nextStep: string | null;
  now?: Date;
  timeZone?: string;
  language?: 'en' | 'fr';
}): Promise<WorkstreamComposeResult> {
  const attempt = {
    client: input.client,
    title: input.title,
    status: input.status,
    nextStep: input.nextStep,
    now: input.now ?? new Date(),
    timeZone: input.timeZone ?? DEFAULT_TIMEZONE,
    language: input.language ?? 'en',
  };
  const first = await oneAttempt(attempt.client, { ...attempt, refusal: null });
  if (first.ok || first.reason === 'empty') return first;
  return oneAttempt(attempt.client, { ...attempt, refusal: first.reason });
}

/** Group-level holds are not the per-parent follow-up cap. */
export type WorkstreamHoldReason = ProactiveHoldReason | 'group_cap' | 'coparent_ask';

export interface WorkstreamFollowupResult {
  enabled: boolean;
  considered: number;
  sent: number;
  held: Record<WorkstreamHoldReason, number>;
  skipped: {
    f14: number;
    already_claimed: number;
    teen_redacted: number;
    no_parent: number;
    no_phone: number;
    not_configured: number;
    nothing_to_say: number;
    compose_failed: number;
    deferred: number;
  };
  failed: number;
}

function emptyHeld(): WorkstreamFollowupResult['held'] {
  return {
    not_enrolled: 0,
    no_watch_consent: 0,
    frequency_cap: 0,
    quiet_hours: 0,
    group_cap: 0,
    coparent_ask: 0,
  };
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
      nothing_to_say: 0,
      compose_failed: 0,
      deferred: 0,
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
  alreadyPaged?: (
    database: Database,
    familyId: string,
    now: Date,
    workstream: { id: string; checkBackAt: Date },
  ) => Promise<boolean>;
  noteUnsent?: (
    database: Database,
    familyId: string,
    reason: string,
    now: Date,
    workstreamId: string,
    checkBackAt: Date,
  ) => Promise<void>;
  pendingDeferral?: (
    database: Database,
    workstream: { id: string; familyId: string; checkBackAt: Date },
    now: Date,
  ) => Promise<FollowupDeferral | null>;
  defer?: (
    database: Database,
    input: {
      familyId: string;
      workstreamId: string;
      checkBackAt: Date;
      until: Date;
      reason: string;
      attempt: number;
      now: Date;
    },
  ) => Promise<void>;
  timeZoneFor?: (database: Database, familyId: string) => Promise<string>;
  targetFor?: (database: Database, familyId: string) => Promise<FamilyOutboundTarget>;
  transport?: ChannelTransport;
}

export interface FollowupDeferral {
  until: Date;
  attempt: number;
  reason: string;
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

async function alreadyPaged(
  database: Database,
  familyId: string,
  _now: Date,
  workstream: { id: string; checkBackAt: Date },
): Promise<boolean> {
  const rows = await database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, PAGE_ACTION),
        eq(schema.auditLog.targetId, workstream.id),
      ),
    )
    .limit(20);
  const stamp = workstream.checkBackAt.toISOString();
  return rows.some((row) => {
    const after = row.after;
    return (
      !!after && typeof after === 'object' && 'checkBackAt' in after && after.checkBackAt === stamp
    );
  });
}

function unsentPage(familyId: string, reason: string): string {
  return `workstream followup unsent family=${familyId} reason=${reason}`;
}

async function noteUnsent(
  database: Database,
  familyId: string,
  reason: string,
  now: Date,
  workstreamId: string,
  checkBackAt: Date,
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: PAGE_ACTION,
    targetTable: 'family_workstreams',
    targetId: workstreamId,
    after: { reason, checkBackAt: checkBackAt.toISOString() },
    occurredAt: now,
  });
}

function parseDeferral(after: unknown, checkBackAt: string): FollowupDeferral | null {
  if (!after || typeof after !== 'object') return null;
  const row = after as Record<string, unknown>;
  if (row.checkBackAt !== checkBackAt) return null;
  if (typeof row.until !== 'string' || typeof row.attempt !== 'number') return null;
  const until = new Date(row.until);
  if (Number.isNaN(until.getTime())) return null;
  return {
    until,
    attempt: row.attempt,
    reason: typeof row.reason === 'string' ? row.reason : 'deferred',
  };
}

async function pendingDeferral(
  database: Database,
  workstream: { id: string; familyId: string; checkBackAt: Date },
  _now: Date,
): Promise<FollowupDeferral | null> {
  const rows = await database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, workstream.familyId),
        eq(schema.auditLog.actionTaken, DEFER_ACTION),
        eq(schema.auditLog.targetId, workstream.id),
      ),
    )
    .orderBy(desc(schema.auditLog.occurredAt))
    .limit(20);
  const stamp = workstream.checkBackAt.toISOString();
  for (const row of rows) {
    const parsed = parseDeferral(row.after, stamp);
    if (parsed) return parsed;
  }
  return null;
}

async function noteDeferred(
  database: Database,
  input: {
    familyId: string;
    workstreamId: string;
    checkBackAt: Date;
    until: Date;
    reason: string;
    attempt: number;
    now: Date;
  },
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: 'system',
    actionTaken: DEFER_ACTION,
    targetTable: 'family_workstreams',
    targetId: input.workstreamId,
    after: {
      reason: input.reason,
      checkBackAt: input.checkBackAt.toISOString(),
      until: input.until.toISOString(),
      attempt: input.attempt,
    },
    occurredAt: input.now,
  });
}

/** The next local clock time strictly after `now`. Midnight is hour 0. */
function nextLocalClock(now: Date, timeZone: string, hour: number, minute: number): Date {
  const parts = localDateParts(now, timeZone);
  const at = (year: number, month: number, day: number) => {
    const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
    const offset = timezoneOffsetMs(guess, timeZone);
    const instant = new Date(guess.getTime() - offset);
    const atInstant = timezoneOffsetMs(instant, timeZone);
    return atInstant === offset ? instant : new Date(guess.getTime() - atInstant);
  };
  let when = at(parts.year, parts.month, parts.day);
  if (when.getTime() <= now.getTime()) {
    const next = addCalendarDays(formatLocalDate(parts), 1);
    const [year, month, day] = next.split('-').map(Number) as [number, number, number];
    when = at(year, month, day);
  }
  return when;
}

/**
 * How long a held send stays quiet when the clock is local. Quiet hours wait
 * until 08:00. A co-parent ask waits until the next local midnight.
 *
 * A group cap does not. That budget is a rolling 24h (and 7d) counted in
 * `family-outbound`, and the hold uses the `until` on the held result: the
 * moment the binding message leaves the window. Midnight was a day late.
 */
export function workstreamHoldUntil(
  reason: 'quiet_hours' | 'coparent_ask',
  now: Date,
  timeZone: string,
): Date {
  if (reason === 'quiet_hours') return nextLocalClock(now, timeZone, GROUP_QUIET_END_HOUR, 0);
  return nextLocalClock(now, timeZone, 0, 0);
}

/** Attempt 1 waits 6 hours. Attempt 2 waits 24. The cap gives up before a third wait. */
export function followupBackoffUntil(attempt: number, now: Date): Date {
  const hours = attempt <= 1 ? 6 : 24;
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

async function followupSpeech(
  database: Database,
  familyId: string,
): Promise<{ timeZone: string; language: 'en' | 'fr' }> {
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
  return {
    timeZone: parent?.timezone || DEFAULT_TIMEZONE,
    language: workstreamLanguage(family?.primaryLanguage),
  };
}

async function defaultCompose(
  database: Database,
  row: DueWorkstream,
  now: Date,
): Promise<WorkstreamComposeResult> {
  const client = workstreamFollowupClient();
  if (!client) return { ok: false, reason: 'not_configured' };
  const speech = await followupSpeech(database, row.familyId);
  return composeWorkstreamFollowup({
    client,
    title: row.title,
    status: row.status,
    nextStep: row.nextStep,
    now,
    timeZone: speech.timeZone,
    language: speech.language,
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
  const compose = deps.compose ?? ((row: DueWorkstream) => defaultCompose(database, row, now));
  const deliver = deps.deliver ?? deliverFamilyOutbound;
  const stamp = deps.stamp ?? markWorkstreamFollowedUp;
  const page = deps.page ?? postOpsSlack;
  const paged = deps.alreadyPaged ?? alreadyPaged;
  const recordMiss = deps.noteUnsent ?? noteUnsent;
  const readDeferral = deps.pendingDeferral ?? pendingDeferral;
  const defer = deps.defer ?? noteDeferred;
  const zoneFor =
    deps.timeZoneFor ?? (async (db, familyId) => (await followupSpeech(db, familyId)).timeZone);
  const thread = deps.thread ?? threadProactiveMessage;
  const targetFor = deps.targetFor ?? familyOutboundTarget;
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
      const waiting = await readDeferral(database, row, now);
      if (waiting && waiting.until.getTime() > now.getTime()) {
        result.skipped.deferred += 1;
        continue;
      }
      const backOff = async (reason: string) => {
        const attempt = (waiting?.attempt ?? 0) + 1;
        if (!(await paged(database, row.familyId, now, row))) {
          await page(unsentPage(row.familyId, reason));
          await recordMiss(database, row.familyId, reason, now, row.id, row.checkBackAt);
        }
        if (attempt >= FOLLOWUP_ATTEMPT_CAP) {
          await stamp(database, row.id, now);
          return;
        }
        await defer(database, {
          familyId: row.familyId,
          workstreamId: row.id,
          checkBackAt: row.checkBackAt,
          until: followupBackoffUntil(attempt, now),
          reason,
          attempt,
          now,
        });
      };
      const composed = await compose(row);
      if (!composed.ok) {
        if (composed.reason === 'not_configured') {
          result.skipped.not_configured += 1;
          continue;
        }
        // Empty is the model declining to send. A real failure retries once
        // inside compose, then waits out a backoff before the next sweep.
        // One page per check-back. The cap is what drops it.
        if (composed.reason === 'empty') {
          result.skipped.nothing_to_say += 1;
          await stamp(database, row.id, now);
          continue;
        }
        result.skipped.compose_failed += 1;
        await backOff(composed.reason);
        continue;
      }
      if (!composed.body) {
        await stamp(database, row.id, now);
        result.skipped.nothing_to_say += 1;
        continue;
      }
      const to = await phoneFor(database, parentUserId);
      if (!to) {
        result.skipped.no_phone += 1;
        continue;
      }
      const target = await targetFor(database, row.familyId);
      const transport = deps.transport ?? createOutboundTransport();
      let delivered: Awaited<ReturnType<typeof deliver>>;
      try {
        delivered = await deliver(database, {
          familyId: row.familyId,
          body: composed.body,
          to,
          legacy: transport,
          target,
          now,
          bubbleKind: 'discretionary',
        });
      } catch (err) {
        // Linq and Twilio throw a transient failure. A returned skip and a
        // throw are the same miss: backoff, one page, then stop.
        result.failed += 1;
        console.error(
          { err: err instanceof Error ? err.name : 'unknown', familyId: row.familyId },
          'workstream followup: send failed',
        );
        await backOff('send_failed');
        continue;
      }
      if (delivered.status === 'held') {
        result.held[delivered.reason] += 1;
        const timeZone = await zoneFor(database, row.familyId);
        await defer(database, {
          familyId: row.familyId,
          workstreamId: row.id,
          checkBackAt: row.checkBackAt,
          until:
            delivered.reason === 'group_cap'
              ? delivered.until
              : workstreamHoldUntil(delivered.reason, now, timeZone),
          reason: delivered.reason,
          attempt: waiting?.attempt ?? 0,
          now,
        });
        continue;
      }
      if (delivered.status !== 'sent') {
        result.failed += 1;
        await backOff(delivered.reason);
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
