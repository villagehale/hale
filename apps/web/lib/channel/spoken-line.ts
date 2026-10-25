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

const MAX_TOKENS = 400;

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

const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

export function acceptSpokenLine(
  text: string,
  verbatim: readonly string[] | undefined,
): string | null {
  const body = text.trim();
  if (body.length === 0) return null;
  if (verbatim?.some((piece) => piece.length > 0 && !body.includes(piece))) return null;
  return body;
}

function smallerLane(lane: LaneConfig): LaneConfig {
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
      const first = pickLane(skill.meta.task);
      const lanes = [first, smallerLane(first)];
      for (let attempt = 0; attempt < lanes.length; attempt += 1) {
        try {
          const { value } = await forceToolJson({
            client: client(),
            lane: lanes[attempt] ?? first,
            system: skill.instructions,
            userMessage: JSON.stringify({
              purpose: request.purpose,
              language: request.language,
              facts: request.facts ?? {},
              verbatim: request.verbatim ?? [],
            }),
            toolName: 'spoken_line',
            toolDescription: 'Write the one text Hale will send.',
            inputJsonSchema: outputJsonSchema,
            schema: outputSchema,
            maxTokens: MAX_TOKENS,
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
