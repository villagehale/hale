/**
 * VIL-715 · every amount of money in a text, in cents: the writer's number gate on a text
 * that states terms, and a parent's own limit on an ask with terms. One parser for the
 * forms a price takes in English, French and Chinese: `$84.88`, `84,88 $`, `1 234,50 $`,
 * `$1,234.50`, `84.88 dollars`, `84.88加元`. NFKC turns the non-breaking spaces a French
 * amount carries into plain ones. The words are currency units, never a read of intent.
 */
const NUMBER = String.raw`\d{1,3}(?:[, ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const BEFORE = String.raw`(?:C(?:A)?\$|US\$|[$€£¥]|(?<![a-z])(?:cad|usd)(?![a-z]))\s*`;
// A sign right before another number is that number's: "the 2027 $98 session" is $98.
const AFTER = String.raw`\s*(?:[$€£¥](?!\s*\d)|加元|加币|美元|元|块|(?:dollars?|bucks|cad|usd)(?![a-z]))`;
const amountPattern = (number: string) =>
  new RegExp(`(${BEFORE})?(?<!\\d)(${number})(?!\\d)(${AFTER})?`, 'giu');
const AMOUNT = amountPattern(NUMBER);
// In a parent's words only a non-breaking space groups digits: "level 3 100 dollars" is $100.
const NO_BREAK_GROUP = '\uE000';
const PARENT_NUMBER = String.raw`\d{1,3}(?:[,\uE000]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const PARENT_AMOUNT = amountPattern(PARENT_NUMBER);

function toCents(raw: string): number | null {
  const parts = /^(.*?)(?:[.,](\d{1,2}))?$/.exec(raw);
  if (!parts?.[1]) return null;
  const whole = Number(parts[1].replace(/[, \uE000]/g, ''));
  const fraction = parts[2] === undefined ? 0 : Number(parts[2].padEnd(2, '0'));
  const cents = whole * 100 + fraction;
  return Number.isSafeInteger(cents) ? cents : null;
}

export function moneyCentsWritten(text: string): number[] {
  const out: number[] = [];
  for (const match of text.normalize('NFKC').matchAll(AMOUNT)) {
    if (match[1] === undefined && match[3] === undefined) continue;
    const cents = match[2] === undefined ? null : toCents(match[2]);
    if (cents !== null) out.push(cents);
  }
  return out;
}

/**
 * The numbers in a parent's quoted words, for checking a limit the model read from them.
 * `marked` carry a currency; `bare` is every number, marked or not.
 */
export function parentAmountsIn(text: string): { marked: number[]; bare: number[] } {
  const grouped = text.replace(/(?<=\p{Nd})[\u00A0\u202F](?=\p{Nd})/gu, NO_BREAK_GROUP);
  const marked: number[] = [];
  const bare: number[] = [];
  for (const match of grouped.normalize('NFKC').matchAll(PARENT_AMOUNT)) {
    const cents = match[2] === undefined ? null : toCents(match[2]);
    if (cents === null) continue;
    bare.push(cents);
    if (match[1] !== undefined || match[3] !== undefined) marked.push(cents);
  }
  return { marked, bare };
}
