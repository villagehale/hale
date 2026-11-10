import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

export interface RegistrationRequestInput {
  text: string;
  sourceUrl: string | null;
  location: string | null;
}

const schema = z.object({
  intent: z.enum(['inspect', 'remind', 'none']),
  confidence: z.enum(['high', 'low']),
  needsLocation: z.boolean(),
});

export type RegistrationRequestReader = (
  input: RegistrationRequestInput,
) => Promise<z.infer<typeof schema> | null>;

export function createRegistrationRequestReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): RegistrationRequestReader {
  return async (input) => {
    try {
      const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
      const skill = await loadCronSkill('registration-request-read');
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: JSON.stringify(input),
        toolName: 'registration_request',
        toolDescription: 'Read registration reminder intent and whether a location is missing.',
        inputJsonSchema: {
          type: 'object',
          properties: {
            intent: { type: 'string', enum: ['inspect', 'remind', 'none'] },
            confidence: { type: 'string', enum: ['high', 'low'] },
            needsLocation: { type: 'boolean' },
          },
          required: ['intent', 'confidence', 'needsLocation'],
          additionalProperties: false,
        },
        schema,
        maxTokens: 256,
      });
      return value;
    } catch (error) {
      console.error(
        { reason: error instanceof Error ? error.constructor.name : 'unknown' },
        'registration request: intent unavailable, no approval or guessed-location search',
      );
      return null;
    }
  };
}
