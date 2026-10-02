import { type AgentClient, type Skill, agentRunCostUsd, pickModel, runAgent } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { recordAgentRun } from '~/lib/agent-run';
import { buildCronGuardDeps } from '~/lib/cron/guards';
import { loadCronSkill } from '~/lib/cron/skill';
import { traceAgentRun } from '~/lib/telemetry/langfuse';
import {
  type ReplyCopyCheck,
  type ReplyCopyFailure,
  type ReplyCopyLanguage,
  validateReplyCopy,
} from './validate';

/**
 * One model call for a duty or family-memory reply, then the validator.
 * Any miss — a bad answer, a failed check, a missing skill, an outage, an
 * audit that did not land — returns the locked string. The send is never
 * blocked on the model.
 *
 * Cost and the trace go through the same agent_runs + Langfuse seam as the
 * other voice composers. The client is injected. Tests never call a live model.
 */

const MAX_TOKENS = 320;

/** First balanced `{…}` in a model answer, or null. Kept local so this module
 * does not import the voice composer (that graph reaches the worker reviewer). */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export type ReplyCopySurface = 'duty' | 'memory';
export type ReplyCopyShape = 'prose' | 'frame';

export interface ReplyCopyRequest {
  client: AgentClient;
  database: Database;
  familyId: string;
  language: ReplyCopyLanguage;
  audience: 'direct' | 'group';
  surface: ReplyCopySurface;
  shape: ReplyCopyShape;
  facts: readonly string[];
  sealedValues?: readonly string[];
  questionAllowed: boolean;
  /** The locked sentence, or the locked header when `shape` is `frame`. */
  fallback: string;
  /** Locked closing sentence. Required for `frame`. */
  fallbackClosing?: string;
  skill?: Skill;
}

export interface ReplyCopyResult {
  source: 'model' | 'locked';
  /** Prose body, or the opening sentence when `shape` is `frame`. */
  text: string;
  /** Closing sentence when `shape` is `frame` and the model was kept. */
  closing: string | null;
  reason: ReplyCopyFailure | 'parse' | 'unavailable' | 'skill_load' | 'unaudited' | null;
}

interface FrameAnswer {
  opening: string;
  closing: string;
}

function parseAnswer(
  answer: string | null,
  shape: ReplyCopyShape,
): { text: string } | FrameAnswer | null {
  if (!answer) return null;
  const json = firstJsonObject(answer);
  if (!json) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (shape === 'frame') {
    if (typeof record.opening !== 'string' || typeof record.closing !== 'string') return null;
    return { opening: record.opening.trim(), closing: record.closing.trim() };
  }
  if (typeof record.text !== 'string') return null;
  return { text: record.text.trim() };
}

function checkFor(request: ReplyCopyRequest, role: ReplyCopyCheck['role']): ReplyCopyCheck {
  return {
    language: request.language,
    facts: request.facts,
    audience: request.audience,
    sealedValues: request.sealedValues,
    questionAllowed: role === 'opening' ? false : request.questionAllowed,
    role,
  };
}

async function auditComposed(
  database: Database,
  familyId: string,
  surface: ReplyCopySurface,
): Promise<boolean> {
  try {
    await database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'reply_copy_composed',
      targetTable: 'channel_messages',
      targetId: familyId,
      after: { surface, source: 'model', reason: null },
    });
    return true;
  } catch (err) {
    console.error({ err, familyId }, 'reply-copy: audit insert failed');
    return false;
  }
}

async function auditFallback(
  database: Database,
  familyId: string,
  surface: ReplyCopySurface,
  reason: string,
): Promise<boolean> {
  try {
    await database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'reply_copy_fallback',
      targetTable: 'channel_messages',
      targetId: familyId,
      after: { surface, source: 'locked', reason },
    });
    return true;
  } catch (err) {
    console.error({ err, familyId }, 'reply-copy: audit insert failed');
    return false;
  }
}

function locked(request: ReplyCopyRequest, reason: ReplyCopyResult['reason']): ReplyCopyResult {
  return {
    source: 'locked',
    text: request.fallback,
    closing: request.shape === 'frame' ? (request.fallbackClosing ?? null) : null,
    reason,
  };
}

export async function composeReplyCopy(request: ReplyCopyRequest): Promise<ReplyCopyResult> {
  let skill: Skill;
  try {
    skill = request.skill ?? (await loadCronSkill('reply-copy'));
  } catch (err) {
    console.error({ err, familyId: request.familyId }, 'reply-copy: skill load failed');
    const audited = await auditFallback(
      request.database,
      request.familyId,
      request.surface,
      'skill_load',
    );
    return locked(request, audited ? 'skill_load' : 'unaudited');
  }

  const modelUsed = pickModel(skill.meta.task);
  const guardDeps = buildCronGuardDeps(request.database);
  const context = {
    language: request.language,
    audience: request.audience,
    shape: request.shape,
    questionAllowed: request.questionAllowed,
    facts: request.facts,
  };

  try {
    return await traceAgentRun(
      {
        name: 'reply-copy',
        userId: 'system',
        tags: ['reply-copy', request.surface],
        metadata: { familyId: request.familyId },
      },
      async (trace) => {
        const startedAt = Date.now();
        const result = await runAgent({
          skill,
          context,
          tools: [],
          client: request.client,
          maxSteps: 1,
          maxTokens: MAX_TOKENS,
          toolContext: { familyId: request.familyId, actor: 'system' },
          guardDeps,
        });
        trace.recordGeneration('reply-copy', { model: modelUsed, usage: result.usage });
        const parsed = parseAnswer(result.answer, request.shape);
        let kept: { text: string; closing: string | null } | null = null;
        let reason: ReplyCopyResult['reason'] = null;
        if (!parsed) {
          reason = 'parse';
        } else if ('opening' in parsed) {
          const openFail = validateReplyCopy(parsed.opening, checkFor(request, 'opening'));
          const closeFail = validateReplyCopy(parsed.closing, checkFor(request, 'closing'));
          if (openFail || closeFail) reason = openFail ?? closeFail;
          else kept = { text: parsed.opening, closing: parsed.closing };
        } else {
          const failure = validateReplyCopy(parsed.text, checkFor(request, 'prose'));
          if (failure) reason = failure;
          else kept = { text: parsed.text, closing: null };
        }
        await recordAgentRun(request.database, {
          familyId: request.familyId,
          agentName: 'reply-copy',
          modelUsed,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          costUsd: agentRunCostUsd(modelUsed, result.usage),
          latencyMs: Date.now() - startedAt,
          status: kept ? 'completed' : 'failed',
          langfuseTraceId: trace.traceId,
        });
        const audited = kept
          ? await auditComposed(request.database, request.familyId, request.surface)
          : await auditFallback(
              request.database,
              request.familyId,
              request.surface,
              reason ?? 'parse',
            );
        if (!audited || !kept) return locked(request, audited ? reason : 'unaudited');
        return { source: 'model', text: kept.text, closing: kept.closing, reason: null };
      },
    );
  } catch (err) {
    console.error({ err, familyId: request.familyId }, 'reply-copy: model call failed');
    const audited = await auditFallback(
      request.database,
      request.familyId,
      request.surface,
      'unavailable',
    );
    return locked(request, audited ? 'unavailable' : 'unaudited');
  }
}
