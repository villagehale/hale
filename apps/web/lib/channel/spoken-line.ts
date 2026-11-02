import { type AgentClient, HAIKU_MODEL, type LaneConfig, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * One parent-facing line, written by the model in whatever language the family
 * is using. There is no template behind it. The first attempt uses the skill's
 * lane. The second uses a smaller model. Both failing holds the send and pages.
 */

export const SPOKEN_LINE_MAX_TOKENS = 400;
export const SPOKEN_LINE_TOOL = 'spoken_line';
export const SPOKEN_LINE_TOOL_DESCRIPTION = 'Write the one text Hale will send.';

export interface SpokenLineRequest {
  purpose: string;
  language: string | null;
  facts?: Readonly<Record<string, string>>;
  /** Strings that must survive unchanged: a url, a phone line, a claim phrase. */
  verbatim?: readonly string[];
}

export interface SpokenLineWriter {
  write(request: SpokenLineRequest): Promise<string | null>;
}

const outputSchema = z.object({ text: z.string() });

export const spokenLineJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

/** The user message `createSpokenLineWriter` sends. The eval caches these exact bytes. */
export function spokenLineUserMessage(request: SpokenLineRequest): string {
  return JSON.stringify({
    purpose: request.purpose,
    language: request.language,
    facts: request.facts ?? {},
    verbatim: request.verbatim ?? [],
  });
}

/** The skill lane, then the smaller lane. One entry when the lane is already the smaller one. */
export function spokenLineLanes(): readonly LaneConfig[] {
  const first = pickLane('draft');
  const second = smallerLane(first);
  return second === first ? [first] : [first, second];
}

export function acceptSpokenLine(
  text: string,
  verbatim: readonly string[] | undefined,
): string | null {
  const body = text.trim();
  if (body.length === 0) return null;
  if (verbatim?.some((piece) => piece.length > 0 && !body.includes(piece))) return null;
  return body;
}

export function smallerLane(lane: LaneConfig): LaneConfig {
  if (lane.model === HAIKU_MODEL) {
    return lane.thinking === 'disabled'
      ? lane
      : { ...lane, thinking: 'disabled', effort: 'medium' };
  }
  return { model: HAIKU_MODEL, thinking: 'adaptive', effort: 'medium' };
}

export function createSpokenLineWriter(client: () => AgentClient): SpokenLineWriter {
  return {
    async write(request) {
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('spoken-line');
      } catch (err) {
        console.error(
          { purpose: request.purpose, err: err instanceof Error ? err.name : 'unknown' },
          'spoken line: skill load failed',
        );
        console.error(
          { urgent: true, purpose: request.purpose },
          'URGENT: spoken line unreachable - page #ops now',
        );
        return null;
      }
      const lanes = spokenLineLanes();
      for (let attempt = 0; attempt < lanes.length; attempt += 1) {
        const lane = lanes[attempt];
        if (!lane) continue;
        try {
          const { value } = await forceToolJson({
            client: client(),
            lane,
            system: skill.instructions,
            userMessage: spokenLineUserMessage(request),
            toolName: SPOKEN_LINE_TOOL,
            toolDescription: SPOKEN_LINE_TOOL_DESCRIPTION,
            inputJsonSchema: spokenLineJsonSchema,
            schema: outputSchema,
            maxTokens: SPOKEN_LINE_MAX_TOKENS,
          });
          const accepted = acceptSpokenLine(value.text, request.verbatim);
          if (accepted) return accepted;
        } catch (err) {
          console.error(
            {
              attempt: attempt + 1,
              purpose: request.purpose,
              err: err instanceof Error ? err.name : 'unknown',
            },
            'spoken line: write failed',
          );
        }
      }
      console.error(
        { urgent: true, purpose: request.purpose },
        'URGENT: spoken line unreachable after a smaller model - page #ops now',
      );
      return null;
    },
  };
}

let shared: SpokenLineWriter | null = null;

export function sharedSpokenLineWriter(): SpokenLineWriter {
  shared ??= createSpokenLineWriter(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}

/** Tests install a scripted writer here; null restores the real one. */
export function setSharedSpokenLineWriter(writer: SpokenLineWriter | null): void {
  shared = writer;
}

export function speak(request: SpokenLineRequest): Promise<string | null> {
  return sharedSpokenLineWriter().write(request);
}
