import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, runAgent } from '@hale/agent';
import { type Database, schema, type WeekPlanItem } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { buildCronGuardDeps } from '~/lib/cron/guards';
import { loadWeekSummarySkill } from '~/lib/cron/skill';
import { readFamilyTimezone } from '~/lib/dashboard/trail-query';
import { weekWindow } from '~/lib/plan/spine';
import { gatherWeekPlanInputs } from './gather';
import { hasWeekPlan, readWeekPlan, upsertWeekPlan } from './queries';
import { composeWeekPlan } from './compose';
import { DEFAULT_SEND_WINDOW, isInSendWindow, type SendWindow } from './schedule';

/**
 * The weekly-plan cron (VIL-217 — "the Sunday brain"). Runs HOURLY and composes ONE
 * family's upcoming-week plan when the family's OWN local send window (default
 * Saturday 19:30) is now — the honest per-family-local version of the digest cron's
 * fixed-UTC + Toronto cheat.
 *
 * Deterministic orchestration; the LLM is a single optional STAGE, not a free loop:
 *   1. resolve the family's timezone (primary parent) → compute the UPCOMING Monday
 *      week window (weekOffset 1) → week_start.
 *   2. idempotent SPEND guard: if this week is already composed, skip before any model
 *      call (a wide send-slot + a retry must never re-spend).
 *   3. gather live signals → deterministic compose → typed items.
 *   4. optional one-sentence LLM summary via the agent seam; if the client is absent
 *      (no key / disabled) or the call fails, the plan persists WITHOUT the summary
 *      (graceful degradation, rule #8).
 *   5. idempotent upsert (family_id, week_start) + an immutable audit row (rule #6).
 */

const MAX_STEPS = 1;
const SUMMARY_MAX_TOKENS = 256;
/** Per-run family cap — the blast-radius bound, mirroring the digest cron. */
export const MAX_WEEK_PLAN_FAMILIES_PER_RUN = 100;

export interface WeekPlanDeps {
  /** The agent client for the summary stage, or null to run WITHOUT the LLM (the
   * deterministic plan still composes + persists). */
  client: AgentClient | null;
  /** The I/O gather step, injectable so the cron logic is unit-tested with a fake. */
  gather: typeof gatherWeekPlanInputs;
}

let anthropicClient: Anthropic | undefined;

export function defaultWeekPlanDeps(): WeekPlanDeps {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // No key, or the kill switch, disables the summary stage — the composer stays fully
  // functional (rule #8), just without the one-sentence summary.
  const client =
    apiKey && process.env.WEEK_PLAN_SUMMARY_DISABLED !== 'true'
      ? (anthropicClient ??= new Anthropic({ apiKey }))
      : null;
  return { client, gather: gatherWeekPlanInputs };
}

export type WeekPlanFamilyResult =
  | { familyId: string; status: 'composed'; weekStart: string; itemCount: number; summarized: boolean }
  | { familyId: string; status: 'skipped_existing'; weekStart: string };

/**
 * Compose (or skip) one family's upcoming-week plan. Idempotent: a second run for the
 * same week_start short-circuits BEFORE the model call and writes nothing new.
 */
export async function runWeekPlanForFamily(
  familyId: string,
  db: Database,
  deps: WeekPlanDeps,
  now: Date = new Date(),
): Promise<WeekPlanFamilyResult> {
  const timeZone = await readFamilyTimezone(db, familyId);
  // The composer covers the UPCOMING week; week_start is that week's MONDAY, family-
  // local (the artifact key is always Monday, independent of a viewer's display pref).
  const window = weekWindow(now, timeZone, 1, 1);
  const weekStart = window.startKey;

  if (await hasWeekPlan(db, familyId, weekStart)) {
    return { familyId, status: 'skipped_existing', weekStart };
  }

  const inputs = await deps.gather(db, familyId, window, timeZone, now);
  const items = composeWeekPlan(inputs, now);
  const summary = await summarizeWeek(items, deps, familyId, db);

  await upsertWeekPlan(db, { familyId, weekStart, summary, items });
  await writeComposeAudit(db, familyId, weekStart);

  return { familyId, status: 'composed', weekStart, itemCount: items.length, summarized: summary !== null };
}

/**
 * The single agent STAGE: one warm sentence summarizing the week, through the house
 * seam (skill body = the prompt, rule #2; model tier from the skill's task). Returns
 * null — and the plan persists without it — when the client is absent (no key / kill
 * switch) or the call fails/returns nothing (graceful degradation, rule #8). The
 * agent has NO tools: the composed items ride in `context`, so it can't fetch or act.
 */
async function summarizeWeek(
  items: WeekPlanItem[],
  deps: WeekPlanDeps,
  familyId: string,
  db: Database,
): Promise<string | null> {
  if (!deps.client || items.length === 0) return null;
  try {
    const skill = await loadWeekSummarySkill();
    const result = await runAgent({
      skill,
      context: { items: items.map((i) => ({ kind: i.kind, title: i.title, when: i.startsAt })) },
      tools: [],
      client: deps.client,
      maxSteps: MAX_STEPS,
      maxTokens: SUMMARY_MAX_TOKENS,
      toolContext: { familyId, actor: 'system' },
      guardDeps: buildCronGuardDeps(db),
    });
    return result.answer;
  } catch {
    // Degrade: the deterministic plan is already composed; the summary is optional.
    return null;
  }
}

/** One immutable audit row per compose (rule #6). Actor 'system' — a scheduled run. */
async function writeComposeAudit(db: Database, familyId: string, weekStart: string): Promise<void> {
  const plan = await readWeekPlan(db, familyId, weekStart);
  if (!plan) return;
  await db.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'compose_week_plan',
    targetTable: 'week_plans',
    targetId: plan.id,
  });
}

export interface WeekPlanCronResult {
  processed: number;
  results: Array<
    { familyId: string; result: WeekPlanFamilyResult } | { familyId: string; error: string }
  >;
}

/**
 * The hourly sweep: select families whose local send window is NOW (FILTER first,
 * then cap — a cap-then-filter would starve every family past the oldest N of their
 * weekly window forever), then compose each. A per-family failure is recorded and the
 * loop continues — one bad family can't starve the batch.
 */
export async function runWeekPlanCron(
  db: Database,
  deps: WeekPlanDeps = defaultWeekPlanDeps(),
  now: Date = new Date(),
  window: SendWindow = DEFAULT_SEND_WINDOW,
): Promise<WeekPlanCronResult> {
  const familyIds = await selectFamiliesInSendWindow(db, now, window);

  const results: WeekPlanCronResult['results'] = [];
  for (const familyId of familyIds) {
    try {
      const result = await runWeekPlanForFamily(familyId, db, deps, now);
      results.push({ familyId, result });
    } catch (err) {
      results.push({ familyId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { processed: familyIds.length, results };
}

/**
 * Families whose PRIMARY PARENT's local time is inside the send window right now,
 * capped. One join reads (family_id, timezone) for every family with a primary parent;
 * the in-window filter runs in memory per family zone (isInSendWindow), THEN the cap.
 * Families with no primary parent yet (onboarding incomplete) are absent — they start
 * getting a plan once linked.
 */
export async function selectFamiliesInSendWindow(
  db: Database,
  now: Date,
  window: SendWindow = DEFAULT_SEND_WINDOW,
): Promise<string[]> {
  const rows = await db
    .select({ familyId: schema.familyMembers.familyId, timezone: schema.users.timezone })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
    .where(eq(schema.familyMembers.role, 'primary_parent'));

  const inWindow: string[] = [];
  for (const row of rows) {
    if (inWindow.length >= MAX_WEEK_PLAN_FAMILIES_PER_RUN) break;
    if (isInSendWindow(now, row.timezone, window)) inWindow.push(row.familyId);
  }
  return inWindow;
}
