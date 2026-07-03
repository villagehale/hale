import type { FamilyStage } from '@hale/types';
import { type AnswerPage, allAnswers } from '~/lib/answers/index';

/**
 * Up to three cornerstone answers for a milestone age's stage, drawn from the
 * existing answer corpus (the source of truth) rather than hardcoded slugs — so
 * the internal-link grid can never point at an answer that doesn’t exist. These
 * links are always renderable (the milestone page isn’t behind the answers’
 * publish gate), but they only surface answers that share the age’s stage.
 */
export function relatedAnswersForStage(stage: FamilyStage): AnswerPage[] {
  return allAnswers.filter((a) => a.stage === stage).slice(0, 3);
}
