import { type Database, schema } from '@hale/db';
import { and, eq, gte, isNull } from 'drizzle-orm';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import {
  type FamilyOutboundTarget,
  GROUP_DISCRETIONARY_DAY_MAX,
  GROUP_DISCRETIONARY_WEEK_MAX,
  GROUP_HARD_DAY_MAX,
  familyOutboundTarget,
  readGroupBubbleSpend,
} from '~/lib/channel/linq/family-outbound';
import { LinqSendError, sendLinqChatMessage } from '~/lib/channel/linq/transport';
import { withOptOut } from '~/lib/channel/opt-out';
import {
  type OutboundGatePorts,
  PROACTIVE_QUIET_HOURS,
  type ProactiveSendRequest,
  type ProactiveSendVerdict,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { isWithinQuietHours, localParts } from '~/lib/loop/prefs';
import { closeFacts, writeFact } from '~/lib/memory/facts';
import {
  type CadenceLine,
  type CadencePlan,
  DUTY_LLM_DAY_MAX,
  type DutyOccasion,
  type OpenDutyQuestion,
  dutyExtractorMayRun,
  localYmd,
  matchParentDutyAsk,
  planDutyCadence,
} from './cadence';
import { type DutyCopyId, dutyCopy, dutyCopyMayLeave } from './copy';
import { coparentDutySendsActive, coparentDutySendsArmed } from './flag';
import type { DutyExtractor } from './interpret';
import { type DutyRole, type DutyState, dutyStateFromFact, needsWhichKid } from './model';

/**
 * VIL-382 · duty asks in the Linq co-parent group.
 *
 * Flag off is a no-op before any read. A send goes to `families.linq_group_chat_id`
 * and nowhere else: no 1:1, no SMS, no email, no push. Copy leaves only when it
 * is locked and no longer a TODO-Design placeholder. Every fact write is an
 * audit row with `logistics_decision_recorded`. Nothing is deleted.
 *
 * Email stays out. This module does not read a mailbox. An occasion marked
 * `email` is dropped by the planner, including a party invite.
 */

export const DUTY_OPEN_FACT_KEY = 'duty-ask/open';
export const DUTY_REASK_PREFIX = 'duty-ask/reask/';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DutySendPorts {
  target: (database: Database, familyId: string) => Promise<FamilyOutboundTarget>;
  gate: (request: ProactiveSendRequest, ports: OutboundGatePorts) => Promise<ProactiveSendVerdict>;
  gatePorts: (database: Database) => OutboundGatePorts;
  send: (input: {
    chatId: string;
    text: string;
    fetch?: typeof fetch;
  }) => Promise<{ providerMessageId: string }>;
  spend: typeof readGroupBubbleSpend;
}

export function defaultDutySendPorts(): DutySendPorts {
  return {
    target: familyOutboundTarget,
    gate: assertProactiveSendAllowed,
    gatePorts: buildOutboundGatePorts,
    send: (input) =>
      sendLinqChatMessage({ chatId: input.chatId, text: input.text, fetch: input.fetch }),
    spend: readGroupBubbleSpend,
  };
}

export type DutyDelivery =
  | { status: 'sent'; chatId: string }
  | {
      status: 'skipped';
      reason: 'flag_off' | 'placeholder' | 'no_group' | 'deduped' | 'single_parent';
    }
  | {
      status: 'held';
      reason: 'quiet_hours' | 'frequency_cap' | 'not_enrolled' | 'no_watch_consent' | 'group_cap';
    }
  | { status: 'not_sent'; reason: string };

export interface DutySweepResult {
  enabled: boolean;
  considered: number;
  sent: number;
  invalidated: number;
  steppedDown: number;
  held: number;
  skipped: number;
}

export function emptyDutySweep(enabled: boolean): DutySweepResult {
  return {
    enabled,
    considered: 0,
    sent: 0,
    invalidated: 0,
    steppedDown: 0,
    held: 0,
    skipped: 0,
  };
}

/** Mail is not spoken in the group. Party invites included. */
export function emailDutyInGroup(): { suppressed: 'mail_not_in_group' } {
  return { suppressed: 'mail_not_in_group' };
}

export function roleFromTitle(title: string | null | undefined): DutyRole {
  const text = title ?? '';
  if (/\bdrop[\s-]?offs?\b/i.test(text)) return 'dropoff';
  if (/\bpick[\s-]?ups?\b/i.test(text)) return 'pickup';
  return 'attend';
}

interface AskFact {
  id: string;
  factKey: string;
  factValue: unknown;
}

async function loadLogisticFacts(database: Database, familyId: string): Promise<AskFact[]> {
  const rows = await database
    .select({
      id: schema.familyMemoryFacts.id,
      factKey: schema.familyMemoryFacts.factKey,
      factValue: schema.familyMemoryFacts.factValue,
      familyId: schema.familyMemoryFacts.familyId,
      factType: schema.familyMemoryFacts.factType,
      validUntil: schema.familyMemoryFacts.validUntil,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        eq(schema.familyMemoryFacts.factType, 'logistic'),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    );
  return rows
    .filter(
      (row) => row.familyId === familyId && row.factType === 'logistic' && row.validUntil === null,
    )
    .map((row) => ({ id: row.id, factKey: row.factKey, factValue: row.factValue }));
}

export function dutyOpenValue(input: {
  eventKey: string;
  role: DutyRole;
  unanswered: number;
  silentNamed: boolean;
  status: 'open' | 'stepped_down';
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'duty_open_question',
    eventKey: input.eventKey,
    role: input.role,
    unanswered: input.unanswered,
    silentNamed: input.silentNamed,
    status: input.status,
  };
}

function readOpen(value: unknown): OpenDutyQuestion | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as {
    kind?: string;
    eventKey?: string;
    role?: string;
    unanswered?: number;
    silentNamed?: boolean;
    status?: string;
  };
  if (row.kind !== 'duty_open_question') return null;
  if (row.role !== 'dropoff' && row.role !== 'pickup' && row.role !== 'attend') return null;
  if (typeof row.eventKey !== 'string' || row.eventKey.length === 0) return null;
  const status = row.status === 'stepped_down' ? 'stepped_down' : 'open';
  return {
    eventKey: row.eventKey,
    role: row.role,
    unanswered: typeof row.unanswered === 'number' ? row.unanswered : 0,
    silentNamed: row.silentNamed === true,
    status,
  };
}

function reaskKey(eventKey: string, role: DutyRole): string {
  return `${DUTY_REASK_PREFIX}${encodeURIComponent(eventKey)}/${role}`;
}

function quietStartMinutes(): number {
  const [hour, minute] = PROACTIVE_QUIET_HOURS.start.split(':').map(Number);
  return (hour ?? 21) * 60 + (minute ?? 0);
}

interface Household {
  parentIds: string[];
  primaryUserId: string | null;
  childNames: string[];
  timeZone: string;
  language: 'en' | 'fr';
  chatId: string | null;
}

async function loadHousehold(database: Database, familyId: string): Promise<Household> {
  const members = await database
    .select({
      userId: schema.familyMembers.userId,
      role: schema.familyMembers.role,
      familyId: schema.familyMembers.familyId,
    })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  const parentIds = [
    ...new Set(
      members
        .filter(
          (row) =>
            row.familyId === familyId &&
            (row.role === 'primary_parent' || row.role === 'co_parent') &&
            row.userId,
        )
        .map((row) => row.userId as string),
    ),
  ];
  const primary =
    members.find((row) => row.familyId === familyId && row.role === 'primary_parent')?.userId ??
    parentIds[0] ??
    null;
  const [family] = await database
    .select({
      primaryLanguage: schema.families.primaryLanguage,
      linqGroupChatId: schema.families.linqGroupChatId,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  let timeZone = 'America/Toronto';
  if (primary) {
    const [user] = await database
      .select({ timezone: schema.users.timezone })
      .from(schema.users)
      .where(eq(schema.users.id, primary))
      .limit(1);
    if (user?.timezone) timeZone = user.timezone;
  }
  const children = await database
    .select({ name: schema.children.name, familyId: schema.children.familyId })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return {
    parentIds,
    primaryUserId: primary,
    childNames: children
      .filter((row) => row.familyId === familyId && row.name)
      .map((row) => row.name),
    timeZone,
    language: family?.primaryLanguage?.toLowerCase().startsWith('fr') ? 'fr' : 'en',
    chatId: family?.linqGroupChatId ?? null,
  };
}

function occasionFor(input: {
  eventKey: string;
  role: DutyRole;
  startsAt: Date;
  title: string | null;
  cancelled: boolean;
  state: DutyState | null;
  childNames: readonly string[];
  reasked: boolean;
}): DutyOccasion {
  const state = input.state;
  return {
    eventKey: input.eventKey,
    role: input.role,
    startsAt: input.startsAt,
    hasOwner: state?.status === 'confirmed' && state.owner !== null,
    conflict: state?.status === 'conflict',
    needsWhichKid: needsWhichKid(input.title, input.childNames),
    cancelled: input.cancelled,
    hasDutyRecord: state !== null,
    reasked: input.reasked,
    source: 'calendar',
  };
}

async function buildOccasions(
  database: Database,
  familyId: string,
  childNames: readonly string[],
): Promise<{ occasions: DutyOccasion[]; open: OpenDutyQuestion | null; facts: AskFact[] }> {
  const facts = await loadLogisticFacts(database, familyId);
  const openFact = facts.find((row) => row.factKey === DUTY_OPEN_FACT_KEY);
  const reasked = new Set(
    facts.filter((row) => row.factKey.startsWith(DUTY_REASK_PREFIX)).map((row) => row.factKey),
  );
  const duties = facts
    .map((row) => ({ row, state: dutyStateFromFact(row.factKey, row.factValue) }))
    .filter((row): row is { row: AskFact; state: DutyState } => row.state !== null);

  const blocks = await database
    .select({
      eventId: schema.parentCalendarBlocks.eventId,
      startAt: schema.parentCalendarBlocks.startAt,
      title: schema.parentCalendarBlocks.title,
      status: schema.parentCalendarBlocks.status,
      kidRelated: schema.parentCalendarBlocks.kidRelated,
      familyId: schema.parentCalendarBlocks.familyId,
    })
    .from(schema.parentCalendarBlocks)
    .where(eq(schema.parentCalendarBlocks.familyId, familyId));
  const kidBlocks = blocks.filter((row) => row.familyId === familyId && row.kidRelated);
  const byEvent = new Map<string, typeof kidBlocks>();
  for (const block of kidBlocks) {
    const list = byEvent.get(block.eventId) ?? [];
    list.push(block);
    byEvent.set(block.eventId, list);
  }

  const occasions: DutyOccasion[] = [];
  for (const [eventKey, rows] of byEvent) {
    const active = rows.filter((row) => row.status !== 'cancelled');
    const cancelled = active.length === 0 && rows.some((row) => row.status === 'cancelled');
    const sample = active[0] ?? rows[0];
    if (!sample?.startAt) continue;
    const title = sample.title;
    const matching = duties.filter((row) => row.state.eventKey === eventKey);
    if (matching.length === 0) {
      const role = roleFromTitle(title);
      occasions.push(
        occasionFor({
          eventKey,
          role,
          startsAt: sample.startAt,
          title,
          cancelled,
          state: null,
          childNames,
          reasked: reasked.has(reaskKey(eventKey, role)),
        }),
      );
      continue;
    }
    for (const duty of matching) {
      occasions.push(
        occasionFor({
          eventKey,
          role: duty.state.role,
          startsAt: sample.startAt,
          title,
          cancelled,
          state: duty.state,
          childNames,
          reasked: reasked.has(reaskKey(eventKey, duty.state.role)),
        }),
      );
    }
  }
  return { occasions, open: openFact ? readOpen(openFact.factValue) : null, facts };
}

export type FamilyDutyView =
  | { skipped: 'flag_off' | 'single_parent' }
  | {
      plan: CadencePlan;
      chatId: string | null;
      parentUserId: string;
      language: 'en' | 'fr';
      timeZone: string;
      open: OpenDutyQuestion | null;
    };

export async function planFamilyDutyAsks(
  database: Database,
  input: {
    familyId: string;
    now: Date;
    bubbleLeaving: boolean;
    parentAsk?: { role: DutyRole | null; weekday: number | null } | null;
    ports?: Pick<DutySendPorts, 'spend'>;
  },
): Promise<FamilyDutyView> {
  if (!coparentDutySendsActive(input.familyId)) return { skipped: 'flag_off' };
  const home = await loadHousehold(database, input.familyId);
  if (home.parentIds.length < 2 || !home.primaryUserId) return { skipped: 'single_parent' };
  const built = await buildOccasions(database, input.familyId, home.childNames);
  const local = localParts(input.now, home.timeZone);
  let proactiveToday = 0;
  let discretionaryToday = 0;
  let discretionaryWeek = 0;
  if (home.chatId) {
    const spend = await (input.ports?.spend ?? readGroupBubbleSpend)(database, {
      familyId: input.familyId,
      chatId: home.chatId,
      now: input.now,
    });
    proactiveToday = spend.ceilingToday;
    discretionaryToday = spend.discretionaryDay;
    discretionaryWeek = spend.discretionaryWeek;
  }
  const plan = planDutyCadence({
    now: input.now,
    bubbleLeaving: input.bubbleLeaving,
    open: built.open,
    occasions: built.occasions,
    parentAsk: input.parentAsk ?? null,
    proactiveToday,
    discretionaryToday,
    discretionaryWeek,
    localMinutes: local.minutes,
    weekday: local.weekday,
    quiet: isWithinQuietHours(
      input.now,
      home.timeZone,
      PROACTIVE_QUIET_HOURS.start,
      PROACTIVE_QUIET_HOURS.end,
    ),
    quietStartMin: quietStartMinutes(),
    timeZone: home.timeZone,
  });
  return {
    plan,
    chatId: home.chatId,
    parentUserId: home.primaryUserId,
    language: home.language,
    timeZone: home.timeZone,
    open: built.open,
  };
}

function lineText(line: CadenceLine, language: 'en' | 'fr'): string {
  return dutyCopy(line.mode as DutyCopyId, language);
}

/** Joined copy for a bubble. Null when any line is still a placeholder or unlocked. */
export function renderDutyLines(
  lines: readonly CadenceLine[],
  language: 'en' | 'fr',
): string | null {
  if (lines.length === 0) return null;
  const parts = lines.map((line) => lineText(line, language));
  if (parts.some((part) => !dutyCopyMayLeave(part))) return null;
  return parts.join('\n');
}

async function auditDuty(
  database: Database,
  input: { familyId: string; after: Record<string, unknown> },
): Promise<void> {
  const row = {
    familyId: input.familyId,
    actor: 'system',
    actionTaken: 'logistics_decision_recorded',
    targetTable: 'family_memory_facts',
    targetId: input.familyId,
    after: input.after,
  };
  if (typeof database.transaction === 'function') {
    await database.transaction(async (tx) => {
      await tx.insert(schema.auditLog).values(row);
    });
  } else {
    await database.insert(schema.auditLog).values(row);
  }
}

async function invalidateCancelled(
  database: Database,
  familyId: string,
  eventKeys: readonly string[],
  now: Date,
): Promise<number> {
  if (eventKeys.length === 0) return 0;
  const facts = await loadLogisticFacts(database, familyId);
  const wanted = new Set(eventKeys);
  const ids = facts
    .filter((row) => {
      const state = dutyStateFromFact(row.factKey, row.factValue);
      return state !== null && wanted.has(state.eventKey);
    })
    .map((row) => row.id);
  if (ids.length === 0) return 0;
  const audit = {
    familyId,
    actor: 'system',
    actionTaken: 'logistics_decision_recorded',
    targetTable: 'family_memory_facts',
    targetId: familyId,
    after: { kind: 'duty', invalidated: true, reason: 'event_cancelled' },
  };
  const close = { factIds: ids, closedAt: now, supersededBy: null };
  if (typeof database.transaction === 'function') {
    await database.transaction(async (tx) => {
      const closed = await closeFacts(tx, close);
      if (closed.closedFactIds.length === 0) return;
      await tx.insert(schema.auditLog).values(audit);
    });
  } else {
    const closed = await closeFacts(database, close);
    if (closed.closedFactIds.length === 0) return 0;
    await database.insert(schema.auditLog).values(audit);
  }
  return ids.length;
}

async function writeStepDown(
  database: Database,
  familyId: string,
  open: OpenDutyQuestion,
  now: Date,
): Promise<void> {
  const value = dutyOpenValue({
    eventKey: open.eventKey,
    role: open.role,
    unanswered: open.unanswered,
    silentNamed: open.silentNamed,
    status: 'stepped_down',
  });
  const audit = {
    familyId,
    actor: 'system',
    actionTaken: 'logistics_decision_recorded',
    targetTable: 'family_memory_facts',
    targetId: familyId,
    after: { kind: 'duty_ask', status: 'stepped_down', role: open.role },
  };
  const fact = {
    familyId,
    childId: null,
    factType: 'logistic' as const,
    factKey: DUTY_OPEN_FACT_KEY,
    factValue: value,
    confidence: 1,
    inferredBy: 'coparent_duty_ask',
    validFrom: now,
  };
  if (typeof database.transaction === 'function') {
    await database.transaction(async (tx) => {
      await tx.insert(schema.auditLog).values(audit);
      await writeFact(tx, fact);
    });
  } else {
    await database.insert(schema.auditLog).values(audit);
    await writeFact(database, fact);
  }
}

async function noteLinesSent(
  database: Database,
  input: {
    familyId: string;
    lines: readonly CadenceLine[];
    open: OpenDutyQuestion | null;
    now: Date;
  },
): Promise<void> {
  const question = input.lines.find((row) => row.opensQuestion && row.eventKey && row.role);
  const silent = input.lines.some((row) => row.namesSilentParent);
  const reasks = input.lines.filter(
    (row): row is CadenceLine & { eventKey: string; role: DutyRole } =>
      row.mode === 'reask_48h' && row.eventKey !== null && row.role !== null,
  );
  if (!question && !silent && reasks.length === 0) return;
  const eventKey = question?.eventKey ?? input.open?.eventKey;
  const role = question?.role ?? input.open?.role;
  if (eventKey && role && (question || silent)) {
    await writeFact(database, {
      familyId: input.familyId,
      childId: null,
      factType: 'logistic',
      factKey: DUTY_OPEN_FACT_KEY,
      factValue: dutyOpenValue({
        eventKey,
        role,
        unanswered: (input.open?.unanswered ?? 0) + (question ? 1 : 0),
        silentNamed: silent || input.open?.silentNamed === true,
        status: 'open',
      }),
      confidence: 1,
      inferredBy: 'coparent_duty_ask',
      validFrom: input.now,
    });
    await auditDuty(database, {
      familyId: input.familyId,
      after: { kind: 'duty_ask', role, opened: question !== undefined },
    });
  }
  for (const reask of reasks) {
    await writeFact(database, {
      familyId: input.familyId,
      childId: null,
      factType: 'logistic',
      factKey: reaskKey(reask.eventKey, reask.role),
      factValue: {
        schemaVersion: 1,
        kind: 'duty_reask',
        eventKey: reask.eventKey,
        role: reask.role,
      },
      confidence: 1,
      inferredBy: 'coparent_duty_ask',
      validFrom: input.now,
    });
    await auditDuty(database, {
      familyId: input.familyId,
      after: { kind: 'duty_reask', role: reask.role },
    });
  }
}

export async function deliverDutyGroupLine(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    text: string;
    now: Date;
    dedupeKey: string;
    templateKey: string;
    bubbleKind: 'discretionary' | 'ceiling';
    sendsActive: boolean;
    fetch?: typeof fetch;
  },
  ports: DutySendPorts = defaultDutySendPorts(),
): Promise<DutyDelivery> {
  if (!input.sendsActive) return { status: 'skipped', reason: 'flag_off' };
  if (!dutyCopyMayLeave(input.text)) return { status: 'skipped', reason: 'placeholder' };
  const target = await ports.target(database, input.familyId);
  if (target.channel !== 'group') return { status: 'skipped', reason: 'no_group' };
  const verdict = await ports.gate(
    {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      kind: 'duty_ask',
      now: input.now,
    },
    ports.gatePorts(database),
  );
  if (!verdict.allowed) return { status: 'held', reason: verdict.reason };
  const spend = await ports.spend(database, {
    familyId: input.familyId,
    chatId: target.chatId,
    now: input.now,
  });
  if (spend.ceilingToday >= GROUP_HARD_DAY_MAX) return { status: 'held', reason: 'group_cap' };
  if (
    input.bubbleKind === 'discretionary' &&
    (spend.discretionaryDay >= GROUP_DISCRETIONARY_DAY_MAX ||
      spend.discretionaryWeek >= GROUP_DISCRETIONARY_WEEK_MAX)
  ) {
    return { status: 'held', reason: 'group_cap' };
  }
  if (await dedupeActive(input.dedupeKey, database))
    return { status: 'skipped', reason: 'deduped' };
  const body = withOptOut(input.text, verdict.optOut);
  if (body.includes('TODO-Design')) return { status: 'skipped', reason: 'placeholder' };
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'duty_ask',
      templateKey: input.templateKey,
      dedupeKey: input.dedupeKey,
      providerChatId: target.chatId,
      status: acceptedStatus('imessage'),
      sentAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return { status: 'skipped', reason: 'deduped' };
  try {
    const sent = await ports.send({ chatId: target.chatId, text: body, fetch: input.fetch });
    await database
      .update(schema.channelMessages)
      .set({ providerMessageId: sent.providerMessageId })
      .where(eq(schema.channelMessages.id, claimed.id));
    return { status: 'sent', chatId: target.chatId };
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code })
      .where(eq(schema.channelMessages.id, claimed.id));
    return { status: 'not_sent', reason: code };
  }
}

async function applyPlan(
  database: Database,
  input: {
    familyId: string;
    now: Date;
    view: Exclude<FamilyDutyView, { skipped: 'flag_off' | 'single_parent' }>;
    lines: readonly CadenceLine[];
    bubbleKind: 'discretionary' | 'ceiling';
    templateKey: string;
    ports?: DutySendPorts;
  },
): Promise<DutyDelivery> {
  const text = renderDutyLines(input.lines, input.view.language);
  if (!text) return { status: 'skipped', reason: 'placeholder' };
  const first = input.lines[0];
  const ymd = localYmd(input.now, input.view.timeZone);
  const delivered = await deliverDutyGroupLine(
    database,
    {
      familyId: input.familyId,
      parentUserId: input.view.parentUserId,
      text,
      now: input.now,
      dedupeKey: `duty_ask:${first?.mode ?? 'none'}:${first?.eventKey ?? 'none'}:${first?.role ?? 'none'}:${ymd}`,
      templateKey: input.templateKey,
      bubbleKind: input.bubbleKind,
      sendsActive: true,
    },
    input.ports,
  );
  if (delivered.status === 'sent') {
    await noteLinesSent(database, {
      familyId: input.familyId,
      lines: input.lines,
      open: input.view.open,
      now: input.now,
    });
  }
  return delivered;
}

export async function sweepDutyAsks(
  database: Database,
  input: { now?: Date; ports?: DutySendPorts } = {},
): Promise<DutySweepResult> {
  if (!coparentDutySendsArmed()) return emptyDutySweep(false);
  const now = input.now ?? new Date();
  const result = emptyDutySweep(true);
  const families = await database
    .select({ id: schema.families.id, linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families);
  for (const family of families) {
    if (!family.linqGroupChatId || !coparentDutySendsActive(family.id)) continue;
    result.considered += 1;
    const view = await planFamilyDutyAsks(database, {
      familyId: family.id,
      now,
      bubbleLeaving: false,
      ports: input.ports,
    });
    if ('skipped' in view) {
      result.skipped += 1;
      continue;
    }
    result.invalidated += await invalidateCancelled(
      database,
      family.id,
      view.plan.invalidateEventKeys,
      now,
    );
    if (view.plan.stepDown && view.open) {
      await writeStepDown(database, family.id, view.open, now);
      result.steppedDown += 1;
    }
    if (view.plan.sendLines.length === 0) {
      if (view.plan.held) result.held += 1;
      continue;
    }
    if (!view.chatId) {
      result.skipped += 1;
      continue;
    }
    const discretionary = view.plan.sendLines.some((row) => row.discretionary);
    const delivered = await applyPlan(database, {
      familyId: family.id,
      now,
      view,
      lines: view.plan.sendLines,
      bubbleKind: discretionary ? 'discretionary' : 'ceiling',
      templateKey: view.plan.sendLines.some((row) => row.mode === 'parent_initiated')
        ? 'linq:group_duty_parent'
        : 'linq:group_duty_night_before',
      ports: input.ports,
    });
    if (delivered.status === 'sent') result.sent += 1;
    else if (delivered.status === 'held') result.held += 1;
    else result.skipped += 1;
  }
  return result;
}

export async function dutyOverviewForWeeklyBubble(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date },
): Promise<{ text: string; commit: () => Promise<void> } | null> {
  // The weekly bubble is already addressed to this parent. The fold does not
  // open a second recipient.
  void input.parentUserId;
  if (!coparentDutySendsActive(input.familyId)) return null;
  const view = await planFamilyDutyAsks(database, {
    familyId: input.familyId,
    now: input.now,
    bubbleLeaving: true,
  });
  if ('skipped' in view) return null;
  const text = renderDutyLines(view.plan.foldLines, view.language);
  if (!text) return null;
  return {
    text,
    commit: async () => {
      await noteLinesSent(database, {
        familyId: input.familyId,
        lines: view.plan.foldLines,
        open: view.open,
        now: input.now,
      });
    },
  };
}

async function llmCallsToday(database: Database, familyId: string, now: Date): Promise<number> {
  try {
    const since = new Date(now.getTime() - DAY_MS);
    const rows = await database
      .select({
        familyId: schema.auditLog.familyId,
        actionTaken: schema.auditLog.actionTaken,
        after: schema.auditLog.after,
        occurredAt: schema.auditLog.occurredAt,
      })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.familyId, familyId), gte(schema.auditLog.occurredAt, since)));
    return rows.filter((row) => {
      if (row.familyId !== familyId || row.actionTaken !== 'logistics_decision_recorded')
        return false;
      const after = row.after;
      return Boolean(
        after && typeof after === 'object' && (after as { kind?: string }).kind === 'duty_llm',
      );
    }).length;
  } catch {
    return DUTY_LLM_DAY_MAX;
  }
}

export async function answerParentDutyAsk(
  database: Database,
  input: {
    familyId: string;
    actorUserId: string;
    text: string;
    now: Date;
    extract?: DutyExtractor;
    ports?: DutySendPorts;
  },
): Promise<
  | {
      skipped: 'flag_off' | 'no_match' | 'llm_cap' | 'single_parent' | 'no_event' | 'open_question';
    }
  | { delivery: DutyDelivery }
> {
  if (!coparentDutySendsActive(input.familyId)) return { skipped: 'flag_off' };
  let ask = matchParentDutyAsk(input.text);
  if (!ask && input.extract) {
    const calls = await llmCallsToday(database, input.familyId, input.now);
    if (!dutyExtractorMayRun({ sendsActive: true, callsToday: calls }))
      return { skipped: 'llm_cap' };
    await auditDuty(database, { familyId: input.familyId, after: { kind: 'duty_llm' } });
    try {
      const extracted = await input.extract({
        text: input.text,
        speakerUserId: input.actorUserId,
        parents: [],
      });
      const slot = extracted?.slots[0];
      if (!extracted?.question || !slot) return { skipped: 'no_match' };
      ask = { role: slot.role, weekday: null };
    } catch {
      return { skipped: 'no_match' };
    }
  }
  if (!ask) return { skipped: 'no_match' };
  const view = await planFamilyDutyAsks(database, {
    familyId: input.familyId,
    now: input.now,
    bubbleLeaving: false,
    parentAsk: ask,
    ports: input.ports,
  });
  if ('skipped' in view) return { skipped: view.skipped };
  if (view.plan.sendLines.length === 0) {
    if (view.plan.held === 'open_question') return { skipped: 'open_question' };
    if (view.plan.held === 'group_cap')
      return { delivery: { status: 'held', reason: 'group_cap' } };
    if (view.plan.held === 'quiet_hours')
      return { delivery: { status: 'held', reason: 'quiet_hours' } };
    return { skipped: 'no_event' };
  }
  const delivery = await applyPlan(database, {
    familyId: input.familyId,
    now: input.now,
    view,
    lines: view.plan.sendLines,
    bubbleKind: 'ceiling',
    templateKey: 'linq:group_duty_parent',
    ports: input.ports,
  });
  return { delivery };
}
