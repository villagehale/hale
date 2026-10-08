import {
  type OpenQuestion,
  type OpenQuestionKind,
  answerable,
  questionGrade,
} from '~/lib/channel/router/open-questions';
import type { IntentConfidence, ParentIntentKind, ParentIntentReading } from './types';

/**
 * Whether this reading is sure enough to ACT.
 *
 * `low` never acts. An irreversible act needs `high`. A wrong signup, undo,
 * forget, disconnect, or "the paperwork is done" is not something to guess.
 */
const IRREVERSIBLE = new Set<ParentIntentKind>([
  'undo',
  'disconnect',
  'health_done',
  'registration',
  'signup',
  'join',
  'party',
  'choose',
]);

export type IntentDecision =
  | {
      action: 'resolved';
      kind: OpenQuestionKind;
      questionId: string;
      polarity: 'yes' | 'no';
      confidence: IntentConfidence;
    }
  | { action: 'directed'; reading: ParentIntentReading }
  | { action: 'coach'; reason: string };

export function confidenceEnough(
  kind: ParentIntentKind,
  confidence: IntentConfidence,
  value: string | null,
): boolean {
  if (confidence === 'low') return false;
  if (kind === 'cadence') return value === 'off' ? confidence === 'high' : true;
  if (kind === 'memory') return value === 'recall' || confidence === 'high';
  if (IRREVERSIBLE.has(kind)) return confidence === 'high';
  return true;
}

/**
 * Turn a model's reading into a decision a handler can act on.
 *
 * A target that is not in the pending list is not an answer. A confidence
 * below the grade for that act is not an answer. Both go to the coach, which
 * asks in a normal sentence. Nothing here guesses.
 */
export function decideIntentGate(
  reading: ParentIntentReading,
  questions: readonly OpenQuestion[],
): IntentDecision {
  if (reading.intent === 'unclear' || reading.intent === 'other') {
    return { action: 'coach', reason: reading.intent };
  }
  if (!confidenceEnough(reading.intent, reading.confidence, reading.value)) {
    return { action: 'coach', reason: 'below_grade' };
  }

  if (reading.intent === 'affirm' || reading.intent === 'decline') {
    const polarity = reading.intent === 'affirm' ? 'yes' : 'no';
    const question = questions.find((item) => item.id === reading.targetId);
    if (!question) return { action: 'coach', reason: 'no_target' };
    const grade = questionGrade(question.kind);
    if (reading.confidence === 'medium' && grade === 'consequential') {
      return { action: 'coach', reason: 'below_grade' };
    }
    if (!answerable(question, polarity)) return { action: 'coach', reason: 'not_answerable' };
    return {
      action: 'resolved',
      kind: question.kind,
      questionId: question.id,
      polarity,
      confidence: reading.confidence,
    };
  }

  return { action: 'directed', reading };
}
