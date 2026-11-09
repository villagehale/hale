import type { ReplyLanguage } from '~/lib/channel/language';

/**
 * VIL-581 · the sentences the claim reader numbers. Code owns the boundaries (ICU), so
 * the reader only ever cites an index, and every byte of the body sits in exactly one
 * segment.
 *
 * This reads HALE'S OUTBOUND body for segmentation only; nothing is classified here.
 */
export interface Segment {
  /** 0..n-1, contiguous; only segments with non-blank text are numbered. */
  index: number;
  /** The trimmed span text, which is what the model reads. */
  text: string;
  /** Raw span [start, end) into the body. The raw spans tile the body exactly. */
  start: number;
  end: number;
}

/**
 * The tag as Intl will take it, or undefined. A stored tag is checked only by shape
 * (`acceptReplyLanguage`), and shapes like `en-a1` make `Intl.Segmenter` and
 * `Intl.DateTimeFormat` throw a RangeError. A rejected tag is a degraded input, not a
 * failed read: the read goes on with the runtime default rules and one log line names it.
 */
export function claimReadLocale(language: ReplyLanguage | null): string | undefined {
  if (language === null) return undefined;
  try {
    return Intl.getCanonicalLocales(language)[0];
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    console.warn({ event: 'claim_read_language_rejected' }, 'claim reader: language tag dropped');
    return undefined;
  }
}

const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ['“', '”'],
  ['«', '»'],
  ['「', '」'],
  ['『', '』'],
];
// A CJK terminator ends the URL: zh puts no space after 。, so without it the next
// sentence would be masked into the URL and merged into this one.
const URL = /https?:\/\/[^\s"“”«»「」『』。！？，；：）]+/g;
const URL_TAIL = /[.,;:!?)]+$/;
const TERMINATOR_TAIL = /[.!?。！？]+$/;
const MASK = 'x';

/**
 * Same-length masking, so offsets carry over to the original text:
 *  - a URL becomes a letter run, except its trailing `.,;:!?)`, so a sentence that ends
 *    in a URL still ends there;
 *  - a quoted span keeps its delimiters; its interior becomes a letter run followed by
 *    the interior's own final terminator, flush against the closing mark, so a quote is
 *    never split inside (the French space before `»` included). An unclosed quote is
 *    left as it is, and ICU may split inside it.
 */
function masked(body: string): string {
  let out = body.replace(URL, (url) => {
    const tail = url.match(URL_TAIL)?.[0] ?? '';
    return MASK.repeat(url.length - tail.length) + tail;
  });
  for (const [open, close] of QUOTE_PAIRS) {
    let from = 0;
    for (;;) {
      const at = out.indexOf(open, from);
      if (at < 0) break;
      const end = out.indexOf(close, at + 1);
      if (end < 0) break;
      const interior = out.slice(at + 1, end);
      const terminator = interior.trimEnd().match(TERMINATOR_TAIL)?.[0] ?? '';
      const replacement = MASK.repeat(interior.length - terminator.length) + terminator;
      out = out.slice(0, at + 1) + replacement + out.slice(end);
      from = end + 1;
    }
  }
  return out;
}

export function segmentSentences(body: string, locale: string | undefined): Segment[] {
  const spans: Array<{ start: number; end: number }> = [];
  const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
  for (const piece of segmenter.segment(masked(body))) {
    const span = { start: piece.index, end: piece.index + piece.segment.length };
    const blank = body.slice(span.start, span.end).trim() === '';
    const previous = spans.at(-1);
    if (blank && previous) {
      previous.end = span.end;
    } else if (previous && body.slice(previous.start, previous.end).trim() === '') {
      // A leading whitespace-only span joins the first real segment.
      previous.end = span.end;
    } else {
      spans.push(span);
    }
  }
  return spans
    .filter((span) => body.slice(span.start, span.end).trim() !== '')
    .map((span, index) => ({
      index,
      text: body.slice(span.start, span.end).trim(),
      start: span.start,
      end: span.end,
    }));
}
