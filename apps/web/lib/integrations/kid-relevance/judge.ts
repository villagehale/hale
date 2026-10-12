import { createHash } from 'node:crypto';
import { type AgentClient, type LaneConfig, pickLane, withoutThinking } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { loadKidItemClassifierSkill } from '~/lib/cron/skill';
import { kidRelevanceInputIndex } from '~/lib/crypto/blind-index';
import { StructuredOutputError, forceToolJson, llmTransport } from '~/lib/pipeline/structured';
import {
  KID_JUDGE_ITEMS_PER_CALL,
  KID_JUDGE_MAX_TOKENS,
  KID_VERDICT_TOOL,
  KID_VERDICT_TOOL_DESCRIPTION,
  type KidRelevanceChild,
  type KidRelevanceItem,
  type KidVerdictValue,
  type KidVerdictsAnswer,
  kidItemText,
  kidSkillInputFor,
  kidSkillMessage,
  kidVerdictsContract,
  storedReason,
} from './skill-contract';

/**
 * VIL-226 / VIL-403. One AI judge for "is this about the kids?", run before Hale tracks,
 * reminds about or texts about anything it read from a parent's calendar, mailbox or
 * household group.
 *
 * `unsure` and every failure mean the item is not tracked. A failure is never a verdict:
 * it comes back `held` with why, nothing is written, and the next tick asks again.
 *
 * Verdicts are cached in `kid_relevance_verdicts` by a keyed hash of the input, so an
 * unchanged item costs nothing and the stored hash confirms no guessed title. A `parent` row is the parent's own word ("that's mine") and is never
 * re-judged or overwritten by a model upsert.
 *
 * Privacy (rule #1): the model sees titles, places and senders; the table stores none of
 * them. A reason is stored only for a non-teen kid verdict, and not when it is long or
 * repeats the item's title, place or sender. A teenager's item carries
 * its child id and no reason; a kid item tied to no named child keeps no reason when the
 * family has a teenager.
 *
 * A refused or failed batch stores nothing: its items are asked again one per call, only
 * an item that fails on its own is held, and only an item refused on its own is stored
 * `unsure` (with no reason).
 *
 * Bounds are infrastructure, not cadence (D-G): items per call come from the eval's
 * measured output ceiling, and calls stop at `deadline`; the rest come back
 * `judge_deferred` for the next tick and are never dropped.
 */

export type { KidRelevanceChild, KidRelevanceItem, KidRelevanceSource } from './skill-contract';

export type KidJudgement =
  | {
      ref: string;
      verdict: KidVerdictValue;
      childId: string | null;
      teen: boolean;
      verdictId: string;
    }
  | { ref: string; verdict: 'held'; why: 'judge_failed' | 'judge_deferred' | 'no_parent_timezone' };

/** Judgements by itemKey. */
export type KidVerdicts = ReadonlyMap<string, KidJudgement>;

export interface KidJudgeInput {
  familyId: string;
  items: readonly KidRelevanceItem[];
  now: Date;
  deadline: Date;
}

export interface KidJudgePorts {
  client: AgentClient;
  children: readonly KidRelevanceChild[];
  /** Kinds of thing the parent said are theirs (see untrack.ts). */
  notMineHints: readonly string[];
}

type VerdictRow = typeof schema.kidRelevanceVerdicts.$inferSelect;

interface Pending {
  identity: string;
  item: KidRelevanceItem;
  inputHash: string;
}

type CallResult =
  | { kind: 'answered'; answer: Map<string, KidVerdictsAnswer['verdicts'][number]> }
  | { kind: 'refused' }
  | { kind: 'failed' };

function identityOf(item: Pick<KidRelevanceItem, 'source' | 'integrationId' | 'itemKey'>): string {
  return JSON.stringify([item.source, item.integrationId, item.itemKey]);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function judgeKidRelevance(
  database: Database,
  input: KidJudgeInput,
  ports: KidJudgePorts,
): Promise<KidJudgement[]> {
  const representatives = new Map<string, KidRelevanceItem>();
  for (const item of input.items) {
    const identity = identityOf(item);
    if (!representatives.has(identity)) representatives.set(identity, item);
  }
  if (representatives.size === 0) return [];

  const skill = await loadKidItemClassifierSkill();
  const lane = pickLane(skill.meta.task);
  const skillHash = sha256(`${skill.meta.task}\n${skill.instructions}`);
  const model = lane.model;
  const context = kidSkillInputFor([], ports.children, ports.notMineHints, input.now);
  const hashOf = (item: KidRelevanceItem) =>
    kidRelevanceInputIndex(
      JSON.stringify({
        model,
        skillHash,
        children: context.children,
        notMineHints: [...ports.notMineHints].sort(),
        item: { source: item.source, text: kidItemText(item), startsAt: item.startsAt },
      }),
    );

  const resolved = new Map<string, KidJudgement>();
  const known = await loadVerdictRows(database, input.familyId, [...representatives.values()]);
  const pending: Pending[] = [];
  for (const [identity, item] of representatives) {
    const inputHash = hashOf(item);
    const row = known.get(identity);
    if (row && (row.decidedBy === 'parent' || row.inputHash === inputHash)) {
      resolved.set(identity, judgementFrom(item.ref, row));
    } else {
      pending.push({ identity, item, inputHash });
    }
  }

  const pastDeadline = () => Date.now() >= input.deadline.getTime();
  const defer = (entries: readonly Pending[]) => {
    for (const entry of entries) {
      resolved.set(entry.identity, { ref: entry.item.ref, verdict: 'held', why: 'judge_deferred' });
    }
  };
  const hold = (entries: readonly Pending[]) => {
    console.error(
      { familyId: input.familyId, items: entries.length },
      'kid-relevance: judge failed after one retry - items held',
    );
    for (const entry of entries) {
      resolved.set(entry.identity, { ref: entry.item.ref, verdict: 'held', why: 'judge_failed' });
    }
  };
  const store = async (
    entries: readonly Pending[],
    result: Exclude<CallResult, { kind: 'failed' }>,
  ) => {
    const rows = entries.map((entry, index) =>
      verdictRowFor(input, ports, entry, result, `i${index}`, model, skillHash),
    );
    await upsertModelVerdicts(database, rows);
    const stored = await loadVerdictRows(
      database,
      input.familyId,
      entries.map((entry) => entry.item),
    );
    for (const entry of entries) {
      const row = stored.get(entry.identity);
      if (!row) throw new Error('kid-relevance: verdict upsert left no row');
      resolved.set(entry.identity, judgementFrom(entry.item.ref, row));
    }
  };

  for (let start = 0; start < pending.length; start += KID_JUDGE_ITEMS_PER_CALL) {
    const batch = pending.slice(start, start + KID_JUDGE_ITEMS_PER_CALL);
    if (pastDeadline()) {
      defer(pending.slice(start));
      break;
    }
    const result = await callJudge(ports, skill.instructions, lane, batch, input.now);
    if (batch.length === 1) {
      if (result.kind === 'failed') hold(batch);
      else await store(batch, result);
      continue;
    }
    if (result.kind === 'answered') {
      await store(batch, result);
      continue;
    }
    // A refusal or a failure is about the batch's text, not about each item in it, so it
    // is never held or cached against all of them: each item is asked on its own, only an
    // item that fails alone is held, and only an item refused alone is stored `unsure`.
    for (const [index, entry] of batch.entries()) {
      if (pastDeadline()) {
        defer(batch.slice(index));
        break;
      }
      const alone = await callJudge(ports, skill.instructions, lane, [entry], input.now);
      if (alone.kind === 'failed') hold([entry]);
      else await store([entry], alone);
    }
  }

  return input.items.map((item) => {
    const judgement = resolved.get(identityOf(item));
    if (!judgement) throw new Error('kid-relevance: an item was neither judged nor held');
    return { ...judgement, ref: item.ref };
  });
}

async function callJudge(
  ports: KidJudgePorts,
  instructions: string,
  lane: LaneConfig,
  batch: readonly Pending[],
  now: Date,
): Promise<CallResult> {
  const refs = batch.map((_entry, index) => `i${index}`);
  const userMessage = kidSkillMessage(
    kidSkillInputFor(
      batch.map((entry) => entry.item),
      ports.children,
      ports.notMineHints,
      now,
    ),
  );
  const contract = kidVerdictsContract(ports.children.map((child) => child.name));
  const ask = async (onLane: LaneConfig): Promise<CallResult> => {
    const { value } = await forceToolJson({
      client: ports.client,
      lane: onLane,
      system: instructions,
      userMessage,
      toolName: KID_VERDICT_TOOL,
      toolDescription: KID_VERDICT_TOOL_DESCRIPTION,
      inputJsonSchema: contract.jsonSchema,
      schema: contract.schema,
      maxTokens: KID_JUDGE_MAX_TOKENS,
      transport: llmTransport(),
    });
    const answer = new Map(value.verdicts.map((entry) => [entry.ref, entry]));
    const missing = refs.filter((ref) => !answer.has(ref));
    if (missing.length > 0) {
      throw new Error(`${KID_VERDICT_TOOL}: ${missing.length} item(s) left unanswered`);
    }
    return { kind: 'answered', answer };
  };

  try {
    return await ask(lane);
  } catch (err) {
    if (err instanceof StructuredOutputError && err.outcome === 'refusal')
      return { kind: 'refused' };
  }
  try {
    return await ask(withoutThinking(lane) ?? lane);
  } catch (err) {
    if (err instanceof StructuredOutputError && err.outcome === 'refusal')
      return { kind: 'refused' };
    return { kind: 'failed' };
  }
}

function verdictRowFor(
  input: KidJudgeInput,
  ports: KidJudgePorts,
  entry: Pending,
  result: Exclude<CallResult, { kind: 'failed' }>,
  ref: string,
  model: string,
  skillHash: string,
): typeof schema.kidRelevanceVerdicts.$inferInsert {
  const base = {
    familyId: input.familyId,
    source: entry.item.source,
    integrationId: entry.item.integrationId,
    itemKey: entry.item.itemKey,
    inputHash: entry.inputHash,
    decidedBy: 'model' as const,
    model,
    skillHash,
    decidedAt: input.now,
  };
  const answer = result.kind === 'answered' ? result.answer.get(ref) : undefined;
  if (!answer || answer.verdict !== 'kid') {
    return {
      ...base,
      verdict: answer?.verdict ?? 'unsure',
      childId: null,
      teen: false,
      reason: null,
    };
  }
  const child =
    answer.childName === null
      ? undefined
      : ports.children.find((candidate) => candidate.name === answer.childName);
  const isTeen = (candidate: KidRelevanceChild) =>
    deriveStage(candidate.dateOfBirth, input.now) === 'teenager';
  const teen = child ? isTeen(child) : false;
  // An item the model did not tie to a named child may still be a teenager's, so it keeps
  // no words when the family has one.
  const mayBeTeen = child ? teen : ports.children.some(isTeen);
  return {
    ...base,
    verdict: 'kid',
    childId: child?.id ?? null,
    teen,
    reason: mayBeTeen ? null : storedReason(answer.reason, entry.item),
  };
}

async function upsertModelVerdicts(
  database: Database,
  rows: readonly (typeof schema.kidRelevanceVerdicts.$inferInsert)[],
): Promise<void> {
  if (rows.length === 0) return;
  const table = schema.kidRelevanceVerdicts;
  await database
    .insert(table)
    .values([...rows])
    .onConflictDoUpdate({
      target: [table.familyId, table.source, table.integrationId, table.itemKey],
      set: {
        inputHash: sql.raw('excluded.input_hash'),
        verdict: sql.raw('excluded.verdict'),
        childId: sql.raw('excluded.child_id'),
        teen: sql.raw('excluded.teen'),
        reason: sql.raw('excluded.reason'),
        model: sql.raw('excluded.model'),
        skillHash: sql.raw('excluded.skill_hash'),
        decidedAt: sql.raw('excluded.decided_at'),
      },
      // A parent's own word is final; only a model row is ever replaced.
      setWhere: eq(table.decidedBy, 'model'),
    });
}

async function loadVerdictRows(
  database: Database,
  familyId: string,
  items: readonly Pick<KidRelevanceItem, 'source' | 'integrationId' | 'itemKey'>[],
): Promise<Map<string, VerdictRow>> {
  const keys = [...new Set(items.map((item) => item.itemKey))];
  if (keys.length === 0) return new Map();
  const rows = await database
    .select()
    .from(schema.kidRelevanceVerdicts)
    .where(
      and(
        eq(schema.kidRelevanceVerdicts.familyId, familyId),
        inArray(schema.kidRelevanceVerdicts.itemKey, keys),
      ),
    );
  return new Map(rows.map((row) => [identityOf(row), row]));
}

function judgementFrom(ref: string, row: VerdictRow): KidJudgement {
  return {
    ref,
    verdict: row.verdict,
    childId: row.childId,
    teen: row.teen,
    verdictId: row.id,
  };
}

/** The series a calendar event belongs to, as Hale last saw it, or the event itself. */
export async function seriesKeyForEvent(
  database: Database,
  integrationId: string,
  eventId: string,
): Promise<string> {
  const [row] = await database
    .select({ recurringEventId: schema.calendarEventSnapshots.recurringEventId })
    .from(schema.calendarEventSnapshots)
    .where(
      and(
        eq(schema.calendarEventSnapshots.integrationId, integrationId),
        eq(schema.calendarEventSnapshots.eventId, eventId),
      ),
    );
  return row?.recurringEventId ?? eventId;
}

/** The children the judge names, read from `children` only. */
export async function loadKidRelevanceChildren(
  database: Database,
  familyId: string,
): Promise<KidRelevanceChild[]> {
  const rows = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return rows.filter((row) => row.name.trim().length > 0);
}

/** The kinds of thing this parent has said are theirs, from their own adult verdicts. */
export async function loadNotMineHints(database: Database, familyId: string): Promise<string[]> {
  const table = schema.kidRelevanceVerdicts;
  const rows = await database
    .select({ hint: table.hint })
    .from(table)
    .where(
      and(
        eq(table.familyId, familyId),
        eq(table.decidedBy, 'parent'),
        eq(table.verdict, 'adult'),
        isNotNull(table.hint),
      ),
    );
  const kinds = rows
    .map((row) => row.hint)
    .filter((kind): kind is string => kind !== null && kind.trim().length > 0);
  return [...new Set(kinds)].sort();
}
