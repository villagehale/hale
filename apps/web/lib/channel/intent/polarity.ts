import { readAffirmative } from '~/lib/channel/affirmative';
import { looksLikeJoinRequest } from '~/lib/channel/join/parse';
import { productionParentIntentResolver } from './apply';
import { confidenceEnough } from './decide';
import { aiIntentRouterEnabled } from './flag';
import type { PendingOffer } from './types';

/**
 * Flag off: the existing word list.
 * Flag on: the intent resolver. Low confidence is not a yes and not a no.
 */
export async function directedPolarity(
  body: string,
  pending: PendingOffer,
): Promise<'yes' | 'no' | 'unclear'> {
  if (!aiIntentRouterEnabled()) return readAffirmative(body);
  const reading = await productionParentIntentResolver().read({
    text: body,
    recentTurns: [],
    pending: [pending],
  });
  if (!confidenceEnough(reading.intent, reading.confidence, reading.value)) return 'unclear';
  if (reading.intent === 'affirm' && reading.targetId === pending.id) return 'yes';
  if (reading.intent === 'decline' && reading.targetId === pending.id) return 'no';
  return 'unclear';
}

/** Flag off: the join phrase list. Flag on: a high-confidence `join` reading. */
export async function directedJoin(body: string): Promise<boolean> {
  if (!aiIntentRouterEnabled()) return looksLikeJoinRequest(body);
  const reading = await productionParentIntentResolver().read({
    text: body,
    recentTurns: [],
    pending: [],
  });
  return reading.intent === 'join' && reading.confidence === 'high';
}
