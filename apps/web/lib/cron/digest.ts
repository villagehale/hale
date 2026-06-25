import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickModel, runAgent } from '@hale/agent';
import { type Database, type DigestPerChildBreakdown, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { recordAgentRun, sonnetCostUsd } from '~/lib/agent-run';
import { traceAgentRun } from '~/lib/telemetry/langfuse';
import { type DigestEmailSender, createDigestEmailSender } from './email';
import {
  hasOptedOut,
  recordEmailSend,
  unsubscribeUrl,
} from './email-compliance';
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
  | { status: 'no_answer' }
  /** Brief composed + stored, but not emailed: the send flag is off, the
   * recipient opted out, or no unsubscribe secret is configured to mint the
   * CASL-required link. The dashboard still shows the stored brief. */
  | { status: 'send_skipped'; reason: 'flag_off' | 'opted_out' | 'no_unsub_secret' };

const DIGEST_EMAIL_TYPE = 'daily_digest' as const;

/** The send flag: emailing real users stays OFF until the sending domain is
 * verified and this is flipped to 'true' on purpose. Composing + storing the
 * brief is unaffected — only the outbound send is gated. */
function digestSendEnabled(): boolean {
  return process.env.DIGEST_SEND_ENABLED === 'true';
}

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

/** The primary parent (id + email) — the brief's recipient. Null when the family
 * has no primary parent linked yet (onboarding incomplete): nothing to send, not
 * an error. The id keys the per-recipient opt-out + send ledger. */
async function recipient(
  familyId: string,
  database: Database,
): Promise<{ userId: string; email: string } | null> {
  const rows = await database
    .select({ userId: schema.users.id, email: schema.users.email })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? { userId: row.userId, email: row.email } : null;
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
  const parent = await recipient(familyId, database);
  if (!parent) {
    return { status: 'no_recipient' };
  }

  const skill = await loadDailyBriefSkill();
  const tools = buildDailyBriefTools(database, now);
  const guardDeps = buildCronGuardDeps(database);
  const modelUsed = pickModel(skill.meta.task);

  // Trace the brief: a scheduled run (userId 'system'), familyId is correlating
  // metadata. The mask keeps teen/PII out of the trace (rule #1).
  return traceAgentRun(
    {
      name: 'daily-brief',
      userId: 'system',
      tags: ['daily-brief'],
      metadata: { familyId },
    },
    async (trace) => {
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
          langfuseTraceId: trace.traceId,
        });
        throw err;
      }

      trace.recordGeneration('daily-brief-loop', { model: modelUsed, usage: result.usage });

      await recordAgentRun(database, {
        familyId,
        agentName: 'daily-brief',
        modelUsed,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        costUsd: sonnetCostUsd(result.usage),
        latencyMs: Date.now() - startedAt,
        status: result.answer === null ? 'failed' : 'completed',
        langfuseTraceId: trace.traceId,
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

      // The brief is composed + stored regardless; the SEND is gated twice. The
      // flag keeps real users unemailed until the domain is verified and it is
      // flipped on purpose; the opt-out is the CASL consent check. Either gate
      // skips the send (the dashboard still shows the stored brief).
      if (!digestSendEnabled()) {
        return { status: 'send_skipped', reason: 'flag_off' };
      }
      if (await hasOptedOut(database, parent.userId, DIGEST_EMAIL_TYPE)) {
        return { status: 'send_skipped', reason: 'opted_out' };
      }

      const unsubUrl = unsubscribeUrl({ userId: parent.userId, emailType: DIGEST_EMAIL_TYPE });
      if (!unsubUrl) {
        // No UNSUBSCRIBE_SECRET → a CASL-required unsubscribe link cannot be
        // minted, so we must NOT send (fail closed) rather than email without one.
        return { status: 'send_skipped', reason: 'no_unsub_secret' };
      }

      const sendResult = await deps.email.sendDigest(
        parent.email,
        'your hale daily brief',
        result.answer,
        unsubUrl,
      );

      if (sendResult.accepted) {
        await recordEmailSend(database, {
          userId: parent.userId,
          familyId,
          emailType: DIGEST_EMAIL_TYPE,
          recipient: parent.email,
          providerMessageId: sendResult.providerMessageId,
        });
      }

      return { status: 'sent', emailed: sendResult.accepted };
    },
  );
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
