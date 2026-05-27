import { logger } from '../logger.js';
import type { FrameworkCitation } from '@mira/types';

interface CoachRunInput {
  familyId: string;
  childId?: string;
  trigger:
    | { kind: 'user_question'; question: string }
    | { kind: 'proactive'; context: Record<string, unknown> };
}

interface CoachRunOutput {
  adviceText: string;
  frameworkCitations: FrameworkCitation[];
  confidence: number;
  followUpQuestions: string[];
  flagForPediatrician: boolean;
}

/**
 * Coach agent — Claude Sonnet 4.6, RAG over coaching knowledge base.
 *
 * Privacy rule: Coach NEVER sees email contents, calendar events, or any
 * data outside its scoped slice. Only child profile + parenting style +
 * episode memory of relevant scenarios.
 *
 * STUB: returns a believable mock.
 */
export async function runCoach(input: CoachRunInput): Promise<CoachRunOutput> {
  logger.debug({ familyId: input.familyId, triggerKind: input.trigger.kind }, 'coach: stub run');

  return {
    adviceText:
      'around four months, many babies briefly regress in sleep as they reorganize their cycles. ' +
      'gentle approaches that work for many families: maintain a consistent wind-down routine, ' +
      'aim for naps every 1.5–2 hours of awake time, and lean into the dark/quiet environment.',
    frameworkCitations: [
      {
        framework: 'karp',
        reference: 'The Happiest Baby on the Block — 5 S\'s',
        excerpt: 'Swaddle, side-stomach (held), shush, swing, suck.',
      },
      {
        framework: 'health_canada',
        reference: 'Caring for Kids — Healthy Sleep Habits',
      },
    ],
    confidence: 0.88,
    followUpQuestions: [
      'is your wind-down routine consistent across both parents?',
      'has anything else changed in the last week (travel, illness, daycare)?',
    ],
    flagForPediatrician: false,
  };
}
