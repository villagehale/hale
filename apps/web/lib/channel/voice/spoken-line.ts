import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { budgetedAnthropic, HOT_SMS_CLIENT_OPTIONS } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { type SpokenLineInput, judgeSpokenLine, spokenLineContext } from './judge';

export {
  DEFAULT_MAX_CHARS,
  judgeSpokenLine,
  spokenFactSlots,
  spokenLineContext,
  type SpokenFact,
  type SpokenLineInput,
  type SpokenLineJudgeFailure,
  type SpokenScalar,
  type SpokenTurn,
} from './judge';

/**
 * VIL-413 / VIL-417. One parent-facing line, written by the model from real facts.
 *
 * Founder rule, restated 2026-10-04: Hale never sends templated, canned, or
 * fixed-fallback copy to a parent anywhere. This module is the engine the
 * non-onboarding surfaces share. A skill (packages/agent/skills/<skill>.md)
 * holds the per-kind direction. Code supplies the facts, enforces the limits
 * the model is not trusted with, and decides whether the line goes out.
 *
 * A failed, judged-bad, or timed-out compose is retried once on a smaller
 * prompt. If that also fails, nothing canned goes out: the miss is logged,
 * #ops is paged, and the caller leaves its claim unspent so the next tick or
 * the next inbound tries again.
 */

const MAX_TOKENS = 400;
const SHORT_MAX_TOKENS = 160;

/** One model attempt. A hang past this retries on the smaller prompt. */
export const SPOKEN_LINE_ATTEMPT_TIMEOUT_MS = 12_000;

/**
 * Model instruction for the retry. Not a parent-facing message: the parent
 * only ever sees what the model returns.
 */
const SHORT_LINE_SYSTEM = [
  'You are Hale, texting a family. Write one short warm message in the given language, as a friend who is good at this.',
  'Use only the facts in the JSON. Do not invent a name, an activity, a date, a weekday, a time, a place, or a price.',
  'Follow questions exactly: 1 means your last sentence is the one question, 0 means no question mark at all.',
  'Mention every string in mustMention, copied as given.',
  'French: address vous means vous/votre, address tu means tu/ton. Real accents.',
  'Do not write a URL, a phone number, STOP, unsubscribe, or any compliance wording. No emoji. Two or three short sentences at most.',
].join(' ');

export type SpokenLineFallback =
  | 'voice_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'unusable';

export interface SpokenLineResult {
  body: string;
  source: 'composed' | 'retry' | 'unsent';
  fallback: SpokenLineFallback | null;
}

export interface SpokenLineComposer {
  compose(
    input: SpokenLineInput,
    options?: { prompt?: 'full' | 'short' },
  ): Promise<{ line: string }>;
}

export interface SpokenLineOptions {
  /** Test hook. Production pages Slack #ops. */
  page?: (text: string) => Promise<unknown>;
  /** Test hook. Production uses {@link SPOKEN_LINE_ATTEMPT_TIMEOUT_MS}. */
  attemptTimeoutMs?: number;
  /** `short` skips the skill and uses the smaller retry prompt first. */
  prompt?: 'full' | 'short';
}

const lineSchema = z.object({ line: z.string() }).strict();

const lineJsonSchema = {
  type: 'object',
  properties: { line: { type: 'string' } },
  required: ['line'],
} as const;

class SpokenLineTimeout extends Error {
  constructor() {
    super('spoken-line: attempt timed out');
    this.name = 'SpokenLineTimeout';
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return work;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SpokenLineTimeout()), ms);
    if (typeof timer.unref === 'function') timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function unsent(reason: SpokenLineFallback): SpokenLineResult {
  return { body: '', source: 'unsent', fallback: reason };
}

/** Skill, kind, and reason only. No parent words, no names, in #ops. */
function unsentPage(input: SpokenLineInput, reason: SpokenLineFallback): string {
  return `spoken line unsent skill=${input.skill} kind=${input.kind} reason=${reason}`;
}

export async function speakLine(
  composer: SpokenLineComposer | undefined,
  input: SpokenLineInput,
  options: SpokenLineOptions = {},
): Promise<SpokenLineResult> {
  const page = async (reason: SpokenLineFallback): Promise<void> => {
    console.error(
      { fallback: reason, skill: input.skill, kind: input.kind },
      'spoken-line: line not sent',
    );
    try {
      await (options.page ?? postOpsSlack)(unsentPage(input, reason));
    } catch (err) {
      console.error(
        { err: err instanceof Error ? err.name : 'unknown', skill: input.skill, kind: input.kind },
        'spoken-line: ops page failed',
      );
    }
  };

  if (!composer) {
    await page('voice_unavailable');
    return unsent('voice_unavailable');
  }

  const timeoutMs = options.attemptTimeoutMs ?? SPOKEN_LINE_ATTEMPT_TIMEOUT_MS;

  const attempt = async (
    prompt: 'full' | 'short',
  ): Promise<{ body: string } | { fail: SpokenLineFallback }> => {
    try {
      const composed = await withTimeout(composer.compose(input, { prompt }), timeoutMs);
      const body = composed.line.trim();
      const judged = judgeSpokenLine(body, input);
      if (!judged.ok) {
        console.error(
          { reason: judged.reason, skill: input.skill, kind: input.kind, prompt },
          'spoken-line: unusable line',
        );
        return { fail: 'unusable' };
      }
      return { body };
    } catch (err) {
      const skillMissing = err instanceof Error && /ENOENT|skill/i.test(err.message);
      console.error(
        {
          err: err instanceof Error ? err.name : 'unknown',
          skill: input.skill,
          kind: input.kind,
          prompt,
        },
        'spoken-line: compose failed',
      );
      return { fail: skillMissing && prompt === 'full' ? 'skill_unavailable' : 'model_failed' };
    }
  };

  const firstPrompt = options.prompt === 'short' ? 'short' : 'full';
  const first = await attempt(firstPrompt);
  if ('body' in first) {
    return {
      body: first.body,
      source: firstPrompt === 'short' ? 'retry' : 'composed',
      fallback: null,
    };
  }
  if (firstPrompt === 'short') {
    await page(first.fail);
    return unsent(first.fail);
  }
  const second = await attempt('short');
  if ('body' in second) return { body: second.body, source: 'retry', fallback: null };
  await page(second.fail);
  return unsent(second.fail);
}

export function createSpokenLineComposer(client: AgentClient | null): SpokenLineComposer {
  return {
    async compose(input, options) {
      if (!client) throw new Error('spoken-line: voice_unavailable');
      const short = options?.prompt === 'short';
      const skill = short ? null : await loadCronSkill(input.skill);
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill?.meta.task ?? 'speak'),
        system: skill?.instructions ?? SHORT_LINE_SYSTEM,
        userMessage: JSON.stringify(spokenLineContext(input)),
        toolName: 'line',
        toolDescription: 'Return the one text message to send.',
        inputJsonSchema: lineJsonSchema,
        schema: lineSchema,
        maxTokens: short ? SHORT_MAX_TOKENS : MAX_TOKENS,
        transport: 'stream',
      });
      return { line: value.line };
    },
  };
}

let defaultComposer: SpokenLineComposer | undefined;

/**
 * The production composer, built once from the environment. `undefined` when
 * no model key is set: {@link speakLine} then pages `voice_unavailable` and
 * sends nothing, which is the named outcome rule #11 asks for.
 */
export function defaultSpokenLineComposer(): SpokenLineComposer | undefined {
  if (defaultComposer) return defaultComposer;
  if (!process.env.ANTHROPIC_API_KEY) return undefined;
  defaultComposer = createSpokenLineComposer(budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return defaultComposer;
}
