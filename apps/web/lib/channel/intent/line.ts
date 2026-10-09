import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { pipelineClient } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { aiIntentRouterEnabled } from './flag';

const MAX_TOKENS = 400;

const lineSchema = z.object({
  text: z.string(),
});

const lineJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

/**
 * A judge on Hale's own draft. This does not read a parent's message.
 * A draft that tells them to reply with a keyword is unusable.
 */
const KEYWORD_ASK =
  /\b(?:reply|respond with|réponds|reponds|répondez|repondez)\s+(?:yes|no|less|daily|oui|non|1|2)\b/i;

export function parentLineProblem(
  text: string,
  facts: { complianceStop?: boolean },
): string | null {
  const body = text.trim();
  if (!body) return 'empty';
  if (/\bset me up\b/i.test(body)) return 'keyword_setup';
  if (KEYWORD_ASK.test(body)) {
    if (
      facts.complianceStop &&
      /\b(?:reply|répondez|repondez)\s+(?:stop|arret|arrêt)\b/i.test(body)
    ) {
      const withoutStop = body.replace(
        /\b(?:reply|répondez|repondez)\s+(?:stop|arret|arrêt)\b/gi,
        '',
      );
      if (!KEYWORD_ASK.test(withoutStop)) return null;
    }
    return 'keyword_ask';
  }
  return null;
}

export interface ParentLineInput {
  flow: string;
  facts: Record<string, unknown>;
  pendingAsk: string | null;
  language: ReplyLanguage;
  /** The line prod sends while the flag is off. Not a fallback when the flag is on. */
  locked: string;
}

export interface ParentLineComposer {
  compose(input: ParentLineInput, attempt: 'full' | 'retry'): Promise<string>;
}

export type SpokenLine = { body: string | null; source: 'locked' | 'composed' | 'unsent' };

/**
 * Flag off: the locked line, unchanged.
 * Flag on: the model writes it. One retry. A real failure sends nothing and
 * pages Slack #ops. There is no fixed sentence underneath.
 */
export async function speakParentLine(
  input: ParentLineInput,
  options: {
    composer?: ParentLineComposer | null;
    page?: (text: string) => Promise<unknown>;
  } = {},
): Promise<SpokenLine> {
  if (!aiIntentRouterEnabled()) return { body: input.locked, source: 'locked' };

  const page = options.page ?? postOpsSlack;
  const composer = options.composer === undefined ? defaultParentLineComposer() : options.composer;
  if (!composer) {
    await pageOnce(page, `parent line unsent flow=${input.flow} reason=voice_unavailable`);
    return { body: null, source: 'unsent' };
  }

  let problem = 'model_failed';
  for (const attempt of ['full', 'retry'] as const) {
    try {
      const draft = await composer.compose(input, attempt);
      const found = parentLineProblem(draft, {
        complianceStop: input.facts.complianceStop === true,
      });
      if (!found) return { body: draft.trim(), source: 'composed' };
      problem = found;
      console.error({ flow: input.flow, problem, attempt }, 'parent line: unusable draft');
    } catch (err) {
      problem = 'model_failed';
      console.error(
        { flow: input.flow, attempt, err: err instanceof Error ? err.name : 'unknown' },
        'parent line: compose failed',
      );
    }
  }
  await pageOnce(page, `parent line unsent flow=${input.flow} reason=${problem}`);
  return { body: null, source: 'unsent' };
}

async function pageOnce(page: (text: string) => Promise<unknown>, text: string): Promise<void> {
  try {
    await page(text);
  } catch (err) {
    console.error(
      { err: err instanceof Error ? err.name : 'unknown' },
      'parent line: ops page failed',
    );
  }
}

export function createParentLineComposer(client: AgentClient | null): ParentLineComposer | null {
  if (!client) return null;
  return {
    async compose(input, attempt) {
      const skill = await loadCronSkill('parent-line');
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: JSON.stringify({
          flow: input.flow,
          language: input.language,
          pendingAsk: input.pendingAsk,
          facts: input.facts,
          attempt,
        }),
        toolName: 'parent_line',
        toolDescription: 'Return the one text the parent will read.',
        inputJsonSchema: lineJsonSchema,
        schema: lineSchema,
        maxTokens: MAX_TOKENS,
      });
      return value.text;
    },
  };
}

/** The locked sentence is a fact (`sourceLine`), not a fallback. Flag off returns it unchanged. */
export async function voiceSourceLine(input: {
  flow: string;
  locked: string;
  language: ReplyLanguage;
  pendingAsk?: string | null;
  facts?: Record<string, unknown>;
}): Promise<string | null> {
  const spoken = await speakParentLine({
    flow: input.flow,
    facts: { sourceLine: input.locked, ...input.facts },
    pendingAsk: input.pendingAsk ?? null,
    language: input.language,
    locked: input.locked,
  });
  return spoken.body;
}

export function defaultParentLineComposer(): ParentLineComposer | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    return createParentLineComposer(pipelineClient());
  } catch (err) {
    console.error(
      { err: err instanceof Error ? err.name : 'unknown' },
      'parent line: client unavailable',
    );
    return null;
  }
}
