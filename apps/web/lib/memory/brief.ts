import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { readFamilyTimezone } from '~/lib/dashboard/trail-query';
import { CONFIDENCE_FLOOR } from './facts';
import { isReceiptKey, valueText } from './lexicon';
import { digestWindows } from './period';

/**
 * The memory one-pager injected at the start of an agent turn.
 *
 * It is assembled from live rows at read time, so it cannot lag a correction
 * that `writeFact` already committed. Digests are the only cached section, and
 * they carry an explicit freshness label. A failure returns `unavailable` with
 * an empty body — the turn still runs, and the model is told it does not know.
 *
 * Medical values, namespaced receipt keys, and every teen-attributed fact are
 * absent. Commitment summaries are absent too: the open-loop ledger's sentence
 * can repeat a thread, and the brief only needs the kind.
 */

export const MEMORY_BRIEF_CHAR_BUDGET = 1800;
const FACT_LINE_LIMIT = 4;
const WORKSTREAM_LIMIT = 4;
const VALUE_CHARS = 72;
const DAY_FRESH_MS = 36 * 60 * 60 * 1000;
const WEEK_FRESH_MS = 8 * 24 * 60 * 60 * 1000;

const AUTONOMY_TOKENS = new Set([
  'autonomy',
  'communication',
  'channel',
  'tone',
  'brevity',
  'texts',
  'sms',
]);

export type MemoryBriefStatus = 'ok' | 'empty' | 'stale' | 'unavailable';
export type DigestFreshness = 'fresh' | 'stale' | 'unavailable';

export interface MemoryBrief {
  status: MemoryBriefStatus;
  text: string;
  asOf: string | null;
  digestFreshness: DigestFreshness;
}

export function unavailableMemoryBrief(): MemoryBrief {
  return { status: 'unavailable', text: '', asOf: null, digestFreshness: 'unavailable' };
}

interface BriefFact {
  factType: string;
  factKey: string;
  factValue: unknown;
  confidence: number;
  validFrom: Date;
  childId: string | null;
}

interface BriefWorkstream {
  kind: string;
  topic: string | null;
  dueAt: Date;
}

interface BriefDigest {
  grain: 'day' | 'week';
  periodStart: string;
  generatedAt: Date;
  line: string;
}

export interface RenderMemoryBriefInput {
  now: Date;
  timeZone: string;
  facts: readonly BriefFact[];
  teenChildIds: ReadonlySet<string>;
  workstreams: readonly BriefWorkstream[];
  dayDigest: BriefDigest | null;
  weekDigest: BriefDigest | null;
  /** The completed local day the digest job would have written. */
  expectedDay: string;
  expectedWeek: string;
}

function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

function dayLabel(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function factLine(fact: BriefFact): string {
  return `${fact.factType}:${fact.factKey}=${clip(valueText(fact.factValue), VALUE_CHARS)} (valid_from=${dayLabel(fact.validFrom)})`;
}

function digestFreshness(
  digest: BriefDigest | null,
  expectedPeriod: string,
  maxAgeMs: number,
  now: Date,
): DigestFreshness {
  if (!digest) return 'unavailable';
  if (digest.periodStart !== expectedPeriod) return 'stale';
  if (now.getTime() - digest.generatedAt.getTime() > maxAgeMs) return 'stale';
  return 'fresh';
}

export function renderMemoryBrief(input: RenderMemoryBriefInput): MemoryBrief {
  const facts = input.facts.filter((fact) => {
    if (fact.confidence < CONFIDENCE_FLOOR) return false;
    if (fact.childId !== null && input.teenChildIds.has(fact.childId)) return false;
    if (isReceiptKey(fact.factKey) || fact.factKey.includes(':')) return false;
    return true;
  });

  const autonomy = facts
    .filter((fact) => {
      if (fact.factType === 'voice') return true;
      const key = fact.factKey.toLowerCase();
      for (const token of AUTONOMY_TOKENS) if (key.includes(token)) return true;
      return false;
    })
    .slice(0, FACT_LINE_LIMIT);
  const autonomyIds = new Set(autonomy.map((fact) => `${fact.factType}:${fact.factKey}`));
  const preferences = facts
    .filter((fact) => fact.factType === 'preference' || fact.factType === 'routine')
    .filter((fact) => !autonomyIds.has(`${fact.factType}:${fact.factKey}`))
    .slice(0, FACT_LINE_LIMIT);
  const preferenceIds = new Set(preferences.map((fact) => `${fact.factType}:${fact.factKey}`));
  const life = facts
    .filter((fact) => fact.factType === 'logistic' || fact.factType === 'relationship')
    .filter((fact) => !autonomyIds.has(`${fact.factType}:${fact.factKey}`))
    .filter((fact) => !preferenceIds.has(`${fact.factType}:${fact.factKey}`))
    .slice(0, FACT_LINE_LIMIT);
  const medicalOnFile = facts.filter((fact) => fact.factType === 'medical').length;

  const dayFresh = digestFreshness(input.dayDigest, input.expectedDay, DAY_FRESH_MS, input.now);
  const weekFresh = digestFreshness(input.weekDigest, input.expectedWeek, WEEK_FRESH_MS, input.now);
  const parts = [dayFresh, weekFresh];
  const digestFreshnessLabel: DigestFreshness = parts.includes('stale')
    ? 'stale'
    : parts.includes('fresh')
      ? 'fresh'
      : 'unavailable';

  const lines: string[] = [];
  if (autonomy.length > 0) lines.push(`autonomy: ${autonomy.map(factLine).join('; ')}`);
  if (preferences.length > 0) lines.push(`preferences: ${preferences.map(factLine).join('; ')}`);
  if (life.length > 0) lines.push(`life: ${life.map(factLine).join('; ')}`);
  if (input.workstreams.length > 0) {
    const shown = input.workstreams.slice(0, WORKSTREAM_LIMIT);
    lines.push(
      `workstreams: ${shown
        .map((row) => `${row.kind}${row.topic ? `/${row.topic}` : ''} due=${dayLabel(row.dueAt)}`)
        .join('; ')}`,
    );
  }
  if (input.dayDigest && dayFresh !== 'unavailable') {
    lines.push(`recency_day (${dayFresh}): ${input.dayDigest.line}`);
  }
  if (input.weekDigest && weekFresh !== 'unavailable') {
    lines.push(`recency_week (${weekFresh}): ${input.weekDigest.line}`);
  }
  if (medicalOnFile > 0) lines.push(`medical_on_file=${medicalOnFile}`);

  const newest = facts.reduce<Date | null>((max, fact) => {
    if (!max || fact.validFrom > max) return fact.validFrom;
    return max;
  }, null);
  const status: MemoryBriefStatus =
    lines.length === 0 ? 'empty' : digestFreshnessLabel === 'stale' ? 'stale' : 'ok';

  const header = `memory_brief status=${status} as_of=${input.now.toISOString()} tz=${input.timeZone} digest=${digestFreshnessLabel} facts_as_of=${newest ? newest.toISOString() : 'none'}`;
  let text = [header, ...lines].join('\n');
  if (text.length > MEMORY_BRIEF_CHAR_BUDGET) {
    text = `${text.slice(0, MEMORY_BRIEF_CHAR_BUDGET - 16)}\ntruncated=true`;
  }

  return {
    status,
    text,
    asOf: input.now.toISOString(),
    digestFreshness: digestFreshnessLabel,
  };
}

function digestLineOf(summary: unknown): string | null {
  if (!summary || typeof summary !== 'object') return null;
  const line = (summary as { line?: unknown }).line;
  return typeof line === 'string' ? line : null;
}

export async function assembleMemoryBrief(
  database: Database,
  familyId: string,
  now: Date = new Date(),
): Promise<MemoryBrief> {
  try {
    const timeZone = await readFamilyTimezone(database, familyId);
    const windows = digestWindows(now, timeZone);
    const [childRows, factRows, workstreamRows, dayRows, weekRows] = await Promise.all([
      database
        .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
        .from(schema.children)
        .where(eq(schema.children.familyId, familyId)),
      database
        .select({
          factType: schema.familyMemoryFacts.factType,
          factKey: schema.familyMemoryFacts.factKey,
          factValue: schema.familyMemoryFacts.factValue,
          confidence: schema.familyMemoryFacts.confidence,
          validFrom: schema.familyMemoryFacts.validFrom,
          childId: schema.familyMemoryFacts.childId,
        })
        .from(schema.familyMemoryFacts)
        .where(
          and(
            eq(schema.familyMemoryFacts.familyId, familyId),
            isNull(schema.familyMemoryFacts.validUntil),
          ),
        )
        .orderBy(
          desc(schema.familyMemoryFacts.confidence),
          desc(schema.familyMemoryFacts.validFrom),
          schema.familyMemoryFacts.id,
        )
        .limit(40),
      database
        .select({
          kind: schema.agentCommitments.commitmentKind,
          topic: schema.agentCommitments.topic,
          dueAt: schema.agentCommitments.dueAt,
        })
        .from(schema.agentCommitments)
        .where(
          and(
            eq(schema.agentCommitments.familyId, familyId),
            isNull(schema.agentCommitments.fulfilledAt),
            isNull(schema.agentCommitments.cancelledAt),
          ),
        )
        .orderBy(schema.agentCommitments.dueAt)
        .limit(WORKSTREAM_LIMIT),
      database
        .select({
          periodStart: schema.familyMemoryDigests.periodStart,
          generatedAt: schema.familyMemoryDigests.generatedAt,
          summary: schema.familyMemoryDigests.summary,
        })
        .from(schema.familyMemoryDigests)
        .where(
          and(
            eq(schema.familyMemoryDigests.familyId, familyId),
            eq(schema.familyMemoryDigests.grain, 'day'),
          ),
        )
        .orderBy(desc(schema.familyMemoryDigests.periodStart))
        .limit(1),
      database
        .select({
          periodStart: schema.familyMemoryDigests.periodStart,
          generatedAt: schema.familyMemoryDigests.generatedAt,
          summary: schema.familyMemoryDigests.summary,
        })
        .from(schema.familyMemoryDigests)
        .where(
          and(
            eq(schema.familyMemoryDigests.familyId, familyId),
            eq(schema.familyMemoryDigests.grain, 'week'),
          ),
        )
        .orderBy(desc(schema.familyMemoryDigests.periodStart))
        .limit(1),
    ]);

    const teenChildIds = new Set(
      childRows
        .filter((row) => deriveStage(row.dateOfBirth, now) === 'teenager')
        .map((row) => row.id),
    );

    const toDigest = (
      grain: 'day' | 'week',
      row: { periodStart: string; generatedAt: Date; summary: unknown } | undefined,
    ): BriefDigest | null => {
      if (!row) return null;
      const line = digestLineOf(row.summary);
      if (!line) return null;
      return { grain, periodStart: row.periodStart, generatedAt: row.generatedAt, line };
    };

    return renderMemoryBrief({
      now,
      timeZone,
      facts: factRows,
      teenChildIds,
      workstreams: workstreamRows.map((row) => ({
        kind: row.kind,
        topic: row.topic,
        dueAt: row.dueAt,
      })),
      dayDigest: toDigest('day', dayRows[0]),
      weekDigest: toDigest('week', weekRows[0]),
      expectedDay: windows.day.periodStart,
      expectedWeek: windows.week.periodStart,
    });
  } catch {
    return unavailableMemoryBrief();
  }
}
