import { type AgentClient, HAIKU_MODEL, type LaneConfig, forceToolJson } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import type { TranscriptMessage } from './conversation';

/**
 * VIL-144 — the running summary of a conversation's older turns.
 *
 * INTERNAL MODEL CONTEXT ONLY. It is never sent to a parent, so it is not parent
 * copy: there is no template and no fallback text. When the Haiku call fails the
 * stored row is left exactly as it was (the turn keeps the retrieved digest it
 * already had), nothing is written, nothing is sent, and the failure is logged by
 * fault class only (no content — rule #1).
 *
 * Refresh is batched: the summary only re-folds once at least REFRESH_STEP turns have
 * left the verbatim window since it was last written, so the Haiku call runs about
 * once every ten exchanges, off the parent's critical path.
 */

export interface StoredThreadSummary {
  summary: string;
  /** How many of the oldest live turns the summary spans. */
  coveredTurns: number;
}

export interface ThreadSummaryStore {
  load(conversationId: string, familyId: string): Promise<StoredThreadSummary | null>;
  save(conversationId: string, familyId: string, next: StoredThreadSummary, model: string): Promise<void>;
}

/** Folds `turns` into `previous`; null on any failure (never a fallback string). */
export type ThreadSummarizer = (previous: string, turns: readonly TranscriptMessage[]) => Promise<string | null>;

export const REFRESH_STEP = 20;
/** Upper bound on turns folded in one call; a bigger backlog folds over later turns. */
export const MAX_TURNS_PER_FOLD = 200;
const MAX_TOKENS = 700;
const LANE: LaneConfig = { model: HAIKU_MODEL, thinking: 'disabled', effort: 'medium' };

export function dbThreadSummaryStore(database: Database): ThreadSummaryStore {
  const t = schema.conversationSummaries;
  return {
    async load(conversationId, familyId) {
      const rows = await database
        .select({ summary: t.summary, coveredTurns: t.coveredTurns })
        .from(t)
        // Keyed on BOTH ids: a conversation id from another family reads nothing (rule #1).
        .where(and(eq(t.conversationId, conversationId), eq(t.familyId, familyId)))
        .limit(1);
      return rows[0] ?? null;
    },
    async save(conversationId, familyId, next, model) {
      await database
        .insert(t)
        .values({ conversationId, familyId, summary: next.summary, coveredTurns: next.coveredTurns, model })
        .onConflictDoUpdate({
          target: t.conversationId,
          set: { summary: next.summary, coveredTurns: next.coveredTurns, model, updatedAt: new Date() },
          setWhere: eq(t.familyId, familyId),
        });
    },
  };
}

const outputSchema = z.object({ summary: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
} as const;

export function haikuThreadSummarizer(client: () => AgentClient): ThreadSummarizer {
  return async (previous, turns) => {
    try {
      const skill = await loadCronSkill('thread-summary');
      const { value } = await forceToolJson({
        client: client(),
        lane: LANE,
        system: skill.instructions,
        userMessage: JSON.stringify({ previous_summary: previous, turns }),
        toolName: 'thread_summary',
        toolDescription: 'Return the updated running summary.',
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: MAX_TOKENS,
      });
      const summary = value.summary.trim();
      return summary.length > 0 ? summary : null;
    } catch (err) {
      console.error({ fault: err instanceof Error ? err.name : typeof err }, 'thread summary: fold failed');
      return null;
    }
  };
}

export type RefreshOutcome = 'skipped' | 'updated' | 'failed';

/**
 * Fold whatever has left the verbatim window since the last write. `verbatimTurns`
 * is the coach's window size, so the summary never duplicates turns the model sees
 * verbatim. A transcript that SHRANK below the covered count (soft-deleted turns)
 * restarts the summary from scratch rather than keeping deleted content (rule #6).
 */
export async function refreshThreadSummary(args: {
  store: ThreadSummaryStore;
  summarize: ThreadSummarizer;
  conversationId: string;
  familyId: string;
  transcript: readonly TranscriptMessage[];
  verbatimTurns: number;
}): Promise<RefreshOutcome> {
  const older = args.transcript.length - args.verbatimTurns;
  if (older <= 0) return 'skipped';
  const stored = await args.store.load(args.conversationId, args.familyId);
  const restart = !stored || stored.coveredTurns > older;
  const covered = restart ? 0 : stored.coveredTurns;
  if (older - covered < REFRESH_STEP) return 'skipped';

  const end = Math.min(older, covered + MAX_TURNS_PER_FOLD);
  const next = await args.summarize(restart ? '' : stored.summary, args.transcript.slice(covered, end));
  if (next === null) return 'failed';
  await args.store.save(args.conversationId, args.familyId, { summary: next, coveredTurns: end }, LANE.model);
  return 'updated';
}
