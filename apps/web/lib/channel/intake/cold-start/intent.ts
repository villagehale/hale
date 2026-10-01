/**
 * VIL-392 — cold-start intent.
 *
 * STOP, UNSUBSCRIBE, HELP, INFO, and AIDE stay in matchKeyword and are decided
 * before this function ever sees a model. The phrase list is the deterministic
 * fallback and the set of examples. The model runs only when its own flag is
 * exactly `true` and a classifier was injected. stop_asking counts from the
 * model only at high confidence. This is the seam VIL-376's triage gate plugs
 * into; there is no inline prompt and no model call in this file.
 */

import { matchKeyword } from '../keywords';
import { coldStartIntentClassifierEnabled } from './flags';

export type ColdStartIntent = 'set_me_up' | 'what_can_you_do' | 'decline' | 'stop_asking' | 'none';

export type ColdStartConfidence = 'high' | 'low' | 'ambiguous';

export interface ColdStartJudgement {
  intent: ColdStartIntent;
  confidence: ColdStartConfidence;
  source: 'keyword' | 'phrase' | 'model';
}

export interface ColdStartModelJudgement {
  intent: Exclude<ColdStartIntent, 'none'>;
  confidence: ColdStartConfidence;
}

/** Injected. Absent, or the flag off, and the phrase list decides. */
export interface ColdStartClassifier {
  classify(text: string): Promise<ColdStartModelJudgement | null>;
}

const STOP_ASKING = new Set(['stop asking', 'useless', 'arrete de demander', 'inutile']);
const SET_ME_UP = new Set(['set me up', 'configure-moi', 'configure moi']);
const WHAT_CAN_YOU_DO = new Set([
  'what can you do',
  "qu'est-ce que tu peux faire",
  'qu’est-ce que tu peux faire',
]);
const DECLINE = new Set([
  'no',
  'nope',
  'nah',
  'dunno',
  'skip',
  'later',
  'non',
  'passe',
  'plus tard',
  'je sais pas',
]);

export function phraseIntent(text: string): Exclude<ColdStartIntent, 'none'> | null {
  const folded = foldPhrase(text);
  if (STOP_ASKING.has(folded)) return 'stop_asking';
  if (SET_ME_UP.has(folded)) return 'set_me_up';
  if (WHAT_CAN_YOU_DO.has(folded)) return 'what_can_you_do';
  if (DECLINE.has(folded)) return 'decline';
  return null;
}

export async function judgeColdStartIntent(input: {
  text: string;
  classifier?: ColdStartClassifier | null;
  env?: Record<string, string | undefined>;
}): Promise<ColdStartJudgement> {
  if (matchKeyword(input.text)) {
    return { intent: 'none', confidence: 'high', source: 'keyword' };
  }
  const phrase = phraseIntent(input.text);
  const enabled = coldStartIntentClassifierEnabled(input.env);
  if (!enabled || !input.classifier) {
    return phrase
      ? { intent: phrase, confidence: 'high', source: 'phrase' }
      : { intent: 'none', confidence: 'high', source: 'phrase' };
  }
  const judged = await input.classifier.classify(input.text);
  if (!judged) {
    return phrase
      ? { intent: phrase, confidence: 'high', source: 'phrase' }
      : { intent: 'none', confidence: 'high', source: 'model' };
  }
  if (judged.intent === 'stop_asking') {
    if (judged.confidence === 'high') {
      return { intent: 'stop_asking', confidence: 'high', source: 'model' };
    }
    return phrase === 'stop_asking'
      ? { intent: 'stop_asking', confidence: 'high', source: 'phrase' }
      : { intent: 'none', confidence: judged.confidence, source: 'model' };
  }
  if (judged.confidence === 'high') {
    return { intent: judged.intent, confidence: 'high', source: 'model' };
  }
  return phrase
    ? { intent: phrase, confidence: 'high', source: 'phrase' }
    : { intent: 'none', confidence: judged.confidence, source: 'model' };
}

function foldPhrase(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[’]/g, "'")
    .replace(/[.!?…]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
