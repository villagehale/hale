const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** Exactly one emoji, of any shape (a skin tone, a flag, a keycap). What a Linq sticker
 * peel or a custom tapback can carry; never a judgement about which emoji. */
export function isOneEmoji(text: string): boolean {
  return [...segmenter.segment(text)].length === 1 && PICTOGRAPH.test(text);
}
