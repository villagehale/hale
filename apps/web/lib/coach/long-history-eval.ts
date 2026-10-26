import { _internal } from './context';
import {
  EARLY,
  LONG_HISTORY_CASES,
  longHistoryEpisodes,
  longHistoryFacts,
  longHistoryTranscript,
} from './fixtures/long-history-family';
import type { MemoryEpisodeContext, MemoryFactContext } from './context';
import type { TranscriptMessage } from './conversation';

/**
 * VIL-144 long-history context eval. FREE: no model call, no key, no DB. It checks
 * the context the coach would be handed for a 7-month family:
 *   1. recall — the early detail each question needs is still in the context;
 *   2. tokens — the memory+thread payload is smaller than today's (pre-VIL-144)
 *      selection for the same family and message.
 * `broken: true` replays the pre-VIL-144 selection (fixed newest/most-confident
 * slice, newest-first digest) as the system under test, and MUST fail recall.
 * Token estimate is ~4 chars/token over the JSON the harness serialises.
 */

export interface CaseResult {
  id: string;
  recalled: boolean;
  tokens: number;
  baselineTokens: number;
  pass: boolean;
}

interface Slice {
  memoryFacts: MemoryFactContext[];
  recentEpisodes: MemoryEpisodeContext[];
  transcript: TranscriptMessage[];
  transcriptSummary: string | null;
}

const tokens = (s: Slice) => Math.ceil(JSON.stringify(s).length / 4);

/** The pre-VIL-144 selection, reproduced exactly (limits 30/10, 1,600-char newest-first digest). */
function baselineSlice(
  facts: MemoryFactContext[],
  episodes: MemoryEpisodeContext[],
  transcript: TranscriptMessage[],
): Slice {
  const verbatim = _internal.TRANSCRIPT_VERBATIM_TURNS;
  const cut = Math.max(0, transcript.length - verbatim);
  const older = transcript.slice(0, cut);
  const excerpts: string[] = [];
  let budget = 1_600;
  for (let i = older.length - 1; i >= 0; i -= 1) {
    const t = older[i];
    if (!t) continue;
    const c = t.content.replace(/\s+/g, ' ').trim();
    const e = `${t.role === 'assistant' ? 'Hale' : 'Parent'}: "${c.length <= 120 ? c : `${c.slice(0, 119)}…`}"`;
    if (e.length + 3 > budget) break;
    budget -= e.length + 3;
    excerpts.push(e);
  }
  excerpts.reverse();
  const omitted = older.length - excerpts.length;
  const summary =
    cut === 0
      ? null
      : [
          `${cut} earlier turns of this conversation are not shown.`,
          excerpts.length ? `What was said in that span, oldest first: ${excerpts.join(' | ')}.` : '',
          omitted ? `${omitted} older messages are omitted from this digest.` : '',
          'This is a partial record of the thread — do not treat it as complete, and ask rather than assume if an earlier detail matters.',
        ]
          .filter(Boolean)
          .join(' ');
  return {
    memoryFacts: facts.slice(0, 30),
    recentEpisodes: episodes.slice(0, 10),
    transcript: transcript.slice(cut),
    transcriptSummary: summary,
  };
}

function currentSlice(
  facts: MemoryFactContext[],
  episodes: MemoryEpisodeContext[],
  transcript: TranscriptMessage[],
  question: string,
): Slice {
  const thread = _internal.compactTranscript(transcript, question);
  const memory = _internal.selectRelevantMemory(facts, episodes, {
    primary: question,
    secondary: transcript.slice(-4).map((t) => t.content),
  });
  return { ...memory, ...thread };
}

export function runLongHistoryEval(opts: { broken?: boolean } = {}): CaseResult[] {
  const facts = longHistoryFacts();
  const episodes = longHistoryEpisodes();
  const transcript = longHistoryTranscript();

  return LONG_HISTORY_CASES.map((c) => {
    const baseline = baselineSlice(facts, episodes, transcript);
    const slice = opts.broken ? baseline : currentSlice(facts, episodes, transcript, c.question);
    const recalled =
      c.expects === 'fact'
        ? slice.memoryFacts.some((f) => f.factKey === EARLY.factKey)
        : c.expects === 'zhFact'
          ? slice.memoryFacts.some((f) => f.factKey === EARLY.zhFactKey)
          : c.expects === 'episode'
            ? slice.recentEpisodes.some((e) => e.summary.includes(EARLY.episodeMarker))
            : (slice.transcriptSummary ?? '').includes(EARLY.transcriptMarker);
    const t = tokens(slice);
    const b = tokens(baseline);
    return { id: c.id, recalled, tokens: t, baselineTokens: b, pass: recalled && t < b };
  });
}
