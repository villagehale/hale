import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickModel, runAgent } from '@hale/agent';
import { type Database, type DigestPerChildBreakdown, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { recordAgentRun, sonnetCostUsd } from '~/lib/agent-run';
import { type DigestEmailSender, createDigestEmailSender } from './email';
import { buildDailyBriefTools } from './digest-tools';
import { MAX_FAMILIES_PER_RUN, selectFamiliesForRun } from './families';
import { buildCronGuardDeps } from './guards';
import { loadDailyBriefSkill } from './skill';

/**
 * Composes ONE family's daily brief on the @hale/agent harness, stores it in
 * daily_digests, and emails it. The harness picks the model from the skill's
 * task (draft → Sonnet), dispatches every tool through the GUARDED invoker
 * (cap / audit / teen-redaction), and HARD-STOPS at maxSteps — the run cannot
 * loop forever or spend unboundedly (maxSteps × maxTokens is the per-family token
 * ceiling, and no monetary tool is in the brief's allowlist).
 *
 * Family-scoped (rule #1): the agent only sees THIS family's slice. The audit
 * actor is 'system' — a scheduled run, not a parent (rule #6). The Anthropic
 * client is injected so tests drive the loop mechanics with a fake; brief QUALITY
 * is an eval against real cached Claude (rule #8), not asserted here.
 */

const MAX_STEPS = 4;
const MAX_TOKENS = 1024;

export type DigestResult =
  | { status: 'sent'; emailed: boolean }
  | { status: 'no_recipient' }
  | { status: 'no_answer' };

export interface DigestDeps {
  client: AgentClient;
  email: DigestEmailSender;
}

let anthropicClient: Anthropic | undefined;

export function defaultDigestDeps(): DigestDeps {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  anthropicClient ??= new Anthropic({ apiKey });
  return { client: anthropicClient, email: createDigestEmailSender() };
}

/** The primary parent's email — the brief's recipient. Null when the family has
 * no primary parent linked yet (onboarding incomplete): nothing to send, not an
 * error. */
async function recipientEmail(
  familyId: string,
  database: Database,
): Promise<string | null> {
  const rows = await database
    .select({ email: schema.users.email })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);
  return rows[0]?.email ?? null;
}

/** Today in the digest's date column format (YYYY-MM-DD), in America/Toronto —
 * the schedule runs in the morning Toronto time, so the brief is dated to that
 * local day. */
function torontoDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export async function runDigestForFamily(
  familyId: string,
  database: Database,
  deps: DigestDeps,
  now: Date = new Date(),
): Promise<DigestResult> {
  const to = await recipientEmail(familyId, database);
  if (!to) {
    return { status: 'no_recipient' };
  }

  const skill = await loadDailyBriefSkill();
  const tools = buildDailyBriefTools(database, now);
  const guardDeps = buildCronGuardDeps(database);
  const modelUsed = pickModel(skill.meta.task);

  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof runAgent>>;
  try {
    result = await runAgent({
      skill,
      context: { familyId, today: torontoDate(now) },
      tools,
      client: deps.client,
      maxSteps: MAX_STEPS,
      maxTokens: MAX_TOKENS,
      toolContext: { familyId, actor: 'system' },
      guardDeps,
    });
  } catch (err) {
    // Rule #8: record the failed run (real model, latency) without swallowing.
    await recordAgentRun(database, {
      familyId,
      agentName: 'daily-brief',
      modelUsed,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      latencyMs: Date.now() - startedAt,
      status: 'failed',
    });
    throw err;
  }

  await recordAgentRun(database, {
    familyId,
    agentName: 'daily-brief',
    modelUsed,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    costUsd: sonnetCostUsd(result.usage),
    latencyMs: Date.now() - startedAt,
    status: result.answer === null ? 'failed' : 'completed',
  });

  if (result.answer === null) {
    return { status: 'no_answer' };
  }

  const digestDate = torontoDate(now);
  const breakdown: DigestPerChildBreakdown = {
    children: [],
    unattributed: {
      handledCount: 0,
      awaitingCount: 0,
      needsYouCount: 0,
      revertedCount: 0,
      totalCount: 0,
    },
    coordinationFlags: [],
    briefText: result.answer,
  };

  const row = {
    handledCount: 0,
    awaitingCount: 0,
    needsYouCount: 0,
    revertedCount: 0,
    totalCount: 0,
    perChildBreakdown: breakdown,
    generatedAt: now,
  };

  await database
    .insert(schema.dailyDigests)
    .values({ familyId, digestDate, ...row })
    .onConflictDoUpdate({
      target: [schema.dailyDigests.familyId, schema.dailyDigests.digestDate],
      set: row,
    });

  const emailed = await deps.email.sendDigest(to, 'your hale daily brief', result.answer);

  return { status: 'sent', emailed };
}

export interface DigestCronResult {
  processed: number;
  results: Array<
    | { familyId: string; result: DigestResult }
    | { familyId: string; error: string }
  >;
}

/**
 * The daily digest cron: compose + store + email a brief for each family, bounded
 * by the per-run family cap (the budget blast-radius bound). A per-family failure
 * is recorded against that family and the loop continues — one bad family can't
 * starve the batch.
 */
export async function runDigestCron(
  database: Database,
  deps: DigestDeps = defaultDigestDeps(),
  now: Date = new Date(),
): Promise<DigestCronResult> {
  const familyIds = await selectFamiliesForRun(database, MAX_FAMILIES_PER_RUN.digest);

  const results: DigestCronResult['results'] = [];
  for (const familyId of familyIds) {
    try {
      const result = await runDigestForFamily(familyId, database, deps, now);
      results.push({ familyId, result });
    } catch (err) {
      results.push({ familyId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { processed: familyIds.length, results };
}
