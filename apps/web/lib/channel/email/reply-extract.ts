/**
 * Inbound email · extracting THE NEW TURN from a reply body.
 *
 * Every mail client answers a message by shipping the entire conversation back to us:
 * the parent's two words on top, then Hale's own last message quoted underneath. To the
 * conversational intake machine downstream, that quoted block is indistinguishable from
 * something the parent just said — so an un-stripped reply makes Hale re-read its own
 * question as the parent's answer, and the whole intake goes sideways on turn two. This
 * module is the guard, and it runs BEFORE anything interprets the body.
 *
 * It is deliberately deterministic and model-free. Quoting is a mechanical convention of
 * a handful of clients, not a judgement call, and a probabilistic stripper would fail
 * differently on every message — which is the one failure mode you cannot debug from a
 * support ticket six weeks later.
 *
 * THE BOTTOM-POSTING RULE (the whole design turns on this). An attribution line — the
 * `On <date> … wrote:` that Gmail and Apple Mail emit — is only a SOFT boundary: the
 * attribution line itself is dropped, and the `>`-prefixed run below it is dropped as
 * quoted lines, but anything unprefixed after that run is kept, because a parent who
 * replies UNDER the quote is writing new text. This is why the extractor never picks "the
 * side above the boundary" — it removes marked history wherever it sits and keeps the
 * rest, which also gets inline/interleaved replies right for free.
 *
 * That only works while the quoted body marks itself. So an attribution whose following
 * body is NOT `>`-prefixed becomes a HARD cut to the end of the message, as do Outlook's
 * `-----Original Message-----`, Outlook's bare `From:/Sent:/To:/Subject:` slab, and a
 * forwarded-message banner. Those quote unprefixed, giving their history no end marker;
 * with no way to tell where it stops, keeping anything below it risks feeding Hale its
 * own words. Losing a rare bottom-post is the safe side of that trade.
 *
 * Over-stripping is the mirror failure and is guarded explicitly: a line only counts as
 * an attribution if it opens with a dated `On …` AND ends in `wrote:` (so "I wrote: pick
 * up milk" survives), a header slab needs a real run of headers including `From:` (so
 * prose containing an email address survives), the signature delimiter is RFC 3676's
 * exact dash-dash-SPACE (so a typed `--` survives), and a body that is ENTIRELY quote
 * markers with no attribution anywhere is returned as written — that is a parent typing a
 * quote deliberately, not a client quoting history.
 */

export type StripKind =
  | 'quote_header_split'
  | 'quoted_lines'
  | 'signature'
  | 'forward_block'
  | 'trailing_blank';

export interface ExtractedReply {
  /** The new turn's text, trimmed. Empty string when the message was nothing but
   * quoted history / a signature. */
  text: string;
  /** What was removed, in the order the strippers ran. Named, never silent — an
   * empty array means the body was already clean. */
  stripped: readonly StripKind[];
}

const FORWARD_BANNER = /^(?:-{2,}\s*forwarded message\s*-{2,}|begin forwarded message:)$/i;
const ORIGINAL_MESSAGE = /^-{2,}\s*original message\s*-{2,}$/i;
const HEADER_LINE = /^(?:from|sent|to|cc|bcc|subject|date|reply-to):/i;
const FROM_HEADER = /^from:/i;
/** A date or time is what separates a real attribution from the sentence "On Tuesday". */
const ATTRIBUTION_OPENER = /^on\b.*\d/i;
const ATTRIBUTION_CLOSER = /\bwrote:$/i;
const QUOTED_LINE = /^\s*>/;
const QUOTE_MARKERS = /^(?:\s*>)+\s?/;
/** RFC 3676 §4.3: dash, dash, space. Without the space it is something a parent typed. */
const SIGNATURE_DELIMITER = /^--[ \t]+$/;
const MOBILE_SIGNATURE =
  /^(?:sent from my (?:iphone|ipad|ipod|android|samsung|galaxy|blackberry|mobile|phone)\b|get outlook for (?:ios|android)\b)/i;

const HEADER_SLAB_MIN_LINES = 3;
/** Gmail wraps a long attribution over at most one or two extra lines. */
const ATTRIBUTION_WRAP_LINES = 2;

interface StripResult {
  lines: string[];
  changed: boolean;
}

interface AttributionSpan {
  start: number;
  end: number;
}

/** Classification reads through any depth of `>`, so history quoted inside history is
 * still recognisable as an attribution or a banner. */
function dequote(line: string | undefined): string {
  return (line ?? '').replace(QUOTE_MARKERS, '').trim();
}

function nextContentLine(lines: string[], after: number): number {
  for (let i = after + 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() !== '') return i;
  }
  return -1;
}

/**
 * Where an Outlook header slab begins, or -1. A single `From:` line is prose — "From: the
 * pickup list, please remove Dan" is a real thing a parent writes — so a slab has to be a
 * run of consecutive header lines that includes `From:`.
 */
function headerSlabStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (!HEADER_LINE.test(dequote(lines[i]))) continue;
    let end = i;
    while (end + 1 < lines.length && HEADER_LINE.test(dequote(lines[end + 1]))) end++;
    const run = lines.slice(i, end + 1);
    if (
      run.length >= HEADER_SLAB_MIN_LINES &&
      run.some((line) => FROM_HEADER.test(dequote(line)))
    ) {
      return i;
    }
    i = end;
  }
  return -1;
}

/** Attribution lines, each as the span it occupies — one line usually, more when the
 * client wrapped it and left `wrote:` stranded. */
function attributionSpans(lines: string[]): AttributionSpan[] {
  const spans: AttributionSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!ATTRIBUTION_CLOSER.test(dequote(lines[i]))) continue;
    for (let j = i; j >= 0 && i - j <= ATTRIBUTION_WRAP_LINES; j--) {
      const candidate = dequote(lines[j]);
      if (candidate === '') break;
      if (ATTRIBUTION_OPENER.test(candidate)) {
        spans.push({ start: j, end: i });
        break;
      }
    }
  }
  return spans;
}

/** True when the quoted body under this attribution carries no `>` markers, and therefore
 * has no detectable end — see the hard-cut rule in the module header. */
function quotesWithoutMarkers(lines: string[], span: AttributionSpan): boolean {
  const next = nextContentLine(lines, span.end);
  return next !== -1 && !QUOTED_LINE.test(lines[next] ?? '');
}

function stripQuoteHeaders(lines: string[]): StripResult {
  const spans = attributionSpans(lines);
  const cuts = [
    lines.findIndex((line) => ORIGINAL_MESSAGE.test(dequote(line))),
    headerSlabStart(lines),
    ...spans.filter((span) => quotesWithoutMarkers(lines, span)).map((span) => span.start),
  ].filter((index) => index !== -1);

  const cut = cuts.length > 0 ? Math.min(...cuts) : lines.length;
  const kept = lines
    .slice(0, cut)
    .filter((_, index) => !spans.some((span) => index >= span.start && index <= span.end));
  return { lines: kept, changed: kept.length !== lines.length };
}

function stripQuotedLines(lines: string[]): StripResult {
  const kept = lines.filter((line) => !QUOTED_LINE.test(line));
  return { lines: kept, changed: kept.length !== lines.length };
}

function stripSignature(lines: string[]): StripResult {
  const at = lines.findIndex(
    (line) => SIGNATURE_DELIMITER.test(line) || MOBILE_SIGNATURE.test(line.trim()),
  );
  if (at === -1) return { lines, changed: false };
  return { lines: lines.slice(0, at), changed: true };
}

/** Removing history from the middle of a body leaves holes: runs of blank lines that the
 * parent never typed. Collapse them to one, then trim the ends. */
function closeBlankGaps(lines: string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    const blank = line.trim() === '';
    if (blank && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(blank ? '' : line);
  }
  return out.join('\n').trim();
}

export function extractReply(rawText: string): ExtractedReply {
  const stripped: StripKind[] = [];
  const lines = rawText.split(/\r\n|\r|\n/);

  const banner = lines.findIndex((line) => FORWARD_BANNER.test(dequote(line)));
  let body = banner === -1 ? lines : lines.slice(0, banner);
  if (banner !== -1) stripped.push('forward_block');

  const headers = stripQuoteHeaders(body);
  if (headers.changed) {
    stripped.push('quote_header_split');
    body = headers.lines;
  }

  // Nothing has been stripped yet means no client marked this body as a reply, so a `>`
  // run that accounts for the whole message is the message.
  const clientQuoted = stripped.length > 0;
  const quoted = stripQuotedLines(body);
  const nothingLeft = quoted.lines.every((line) => line.trim() === '');
  if (quoted.changed && (clientQuoted || !nothingLeft)) {
    stripped.push('quoted_lines');
    body = quoted.lines;
  }

  const signature = stripSignature(body);
  if (signature.changed) {
    stripped.push('signature');
    body = signature.lines;
  }

  const text = closeBlankGaps(body);
  if (text !== body.join('\n')) stripped.push('trailing_blank');

  return { text, stripped };
}
