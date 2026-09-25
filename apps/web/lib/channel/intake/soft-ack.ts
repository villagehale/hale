import { isCheerUpAsk, isLiveLookupAsk } from './live-lookup';
import { isOfficialPageAsk } from './official-page';

/**
 * A short ack after the year-find. No new string: this only decides whether
 * the next ladder beat has to be visible. A question or a new find is not soft.
 */

const SOFT_WORDS = new Set([
  'cool',
  'thanks',
  'thank',
  'you',
  'ty',
  'thx',
  'ok',
  'okay',
  'k',
  'kk',
  'nice',
  'perfect',
  'great',
  'awesome',
  'sweet',
  'lovely',
  'good',
  'sounds',
  'got',
  'it',
  'yep',
  'yup',
  'yeah',
  'yes',
  'sure',
  'alright',
  'all',
  'right',
  'word',
  'bet',
  'solid',
  'love',
  'this',
  'so',
  'very',
  'merci',
  'super',
  'parfait',
  'nickel',
  'oui',
  'ouais',
  'dac',
  'daccord',
]);

const SOFT_PHRASES = new Set([
  'cool',
  'thanks',
  'thank you',
  'ty',
  'thx',
  'ok',
  'okay',
  'k',
  'kk',
  'nice',
  'perfect',
  'great',
  'awesome',
  'sweet',
  'lovely',
  'good',
  'sounds good',
  'got it',
  'yep',
  'yup',
  'yeah',
  'yes',
  'sure',
  'alright',
  'all right',
  'word',
  'bet',
  'solid',
  'nice one',
  'love it',
  'love this',
  'cool thanks',
  'ok cool',
  'ok thanks',
  'thanks cool',
  'perfect thanks',
  'nice thanks',
  'sounds great',
  'looks good',
  'very cool',
  'so cool',
  'merci',
  'ok merci',
  'super',
  'parfait',
  'nickel',
  'cool merci',
  'daccord',
  'dac',
  'oui',
  'ouais',
]);

function normalizeAck(body: string): string {
  return body
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/g, '')
    .replace(/['’]/g, '')
    .replace(/\s+/g, ' ');
}

function isEmojiOnly(body: string): boolean {
  const stripped = body.replace(/\s/g, '');
  if (stripped.length === 0 || stripped.length > 16) return false;
  return /^(?:\p{Extended_Pictographic}|\uFE0F|\u200D)+$/u.test(stripped);
}

/** A question, or a request for another find. Not a soft ack. */
export function isQuestionOrNewFind(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes('?')) return true;
  if (isOfficialPageAsk(trimmed) || isLiveLookupAsk(trimmed) || isCheerUpAsk(trimmed)) return true;
  if (
    /\b(find|finding|look(?:ing)? for|search for|what'?s on|whats on|anything on|anything else|near me)\b/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  return /^(who|what|when|where|why|how|can you|could you|would you|is there|are there|do you)\b/i.test(
    trimmed,
  );
}

/** Short ack with no new ask: cool, thanks, ok, nice, perfect, emoji, and close cousins. */
export function isSoftLadderAck(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return false;
  if (isQuestionOrNewFind(trimmed)) return false;
  if (isEmojiOnly(trimmed)) return true;
  const normalized = normalizeAck(trimmed);
  if (SOFT_PHRASES.has(normalized)) return true;
  const words = normalized.split(' ').filter((word) => word.length > 0);
  if (words.length === 0 || words.length > 3) return false;
  return words.every((word) => SOFT_WORDS.has(word));
}
