import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countTokens } from '@anthropic-ai/tokenizer';
import { resolveRepoFile } from './resolve-repo-file';
import { _internal } from './context';
import {
  EARLY,
  LONG_HISTORY_CASES,
  longHistoryEpisodes,
  longHistoryStoredSummary,
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
 * Tokens: the FULL prompt the coach lane sends — the coach skill (system) plus the
 * JSON-serialised context (user), as runAgent builds it — counted with the free local
 * @anthropic-ai/tokenizer. That tokenizer is Anthropic's published one, not the
 * current model's, so absolute numbers are approximate; the before/after comparison
 * uses the same counter on both sides. Tool schemas are identical on both sides and
 * are left out.
 */

export interface CaseResult {
  id: string;
  recalled: boolean;
  /** Full prompt tokens (system + context), this branch. */
  tokens: number;
  /** Full prompt tokens, pre-VIL-144 selection. */
  baselineTokens: number;
  /** Memory + thread slice only. */
  sliceTokens: number;
  baselineSliceTokens: number;
  pass: boolean;
}

export interface EvalOptions {
  broken?: boolean;
  limits?: { facts: number; episodes: number };
  /** Use the stored running summary (default true). */
  withSummary?: boolean;
}

interface Slice {
  memoryFacts: MemoryFactContext[];
  recentEpisodes: MemoryEpisodeContext[];
  transcript: TranscriptMessage[];
  transcriptSummary: string | null;
}

let coachSkill: string | null = null;
function system(): string {
  coachSkill ??= readFileSync(
    resolveRepoFile(join('packages', 'agent', 'skills', 'coach-channel-sms.md')),
    'utf8',
  );
  return coachSkill;
}

/** The rest of the context a texted turn carries, identical on both sides. */
function fullContext(slice: Slice, question: string) {
  return {
    parentName: 'Robin',
    location: { city: 'Toronto', province: 'ON', country: 'CA' },
    planTier: 'free',
    children: [
      { id: 'child-juniper', stage: 'school_age', name: 'Juniper', ageMonths: 98, teenRedacted: false },
      { id: 'child-theo', stage: 'preschool', name: 'Theo', ageMonths: 50, teenRedacted: false },
    ],
    focusedChild: null,
    stages: ['preschool', 'school_age'],
    memoryFacts: slice.memoryFacts,
    recentEpisodes: slice.recentEpisodes,
    memoryBrief: { text: '', status: 'empty' },
    transcript: slice.transcript,
    transcriptSummary: slice.transcriptSummary,
    question,
    intent: null,
    sourceNote: null,
    channel: 'sms',
    nowIso: '2026-10-20T14:00:00.000Z',
    registrationWindows: [],
  };
}

const sliceTokens = (s: Slice) => countTokens(JSON.stringify(s));
const promptTokens = (s: Slice, q: string) =>
  countTokens(system()) + countTokens(JSON.stringify(fullContext(s, q)));

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
  opts: EvalOptions,
): Slice {
  const thread = _internal.compactTranscript(
    transcript,
    question,
    opts.withSummary === false ? null : longHistoryStoredSummary(),
  );
  const memory = _internal.selectRelevantMemory(
    facts,
    episodes,
    { primary: question, secondary: transcript.slice(-4).map((t) => t.content) },
    opts.limits,
  );
  return { ...memory, ...thread };
}

export function runLongHistoryEval(opts: EvalOptions = {}): CaseResult[] {
  const facts = longHistoryFacts();
  const episodes = longHistoryEpisodes();
  const transcript = longHistoryTranscript();

  return LONG_HISTORY_CASES.map((c) => {
    const baseline = baselineSlice(facts, episodes, transcript);
    const slice = opts.broken ? baseline : currentSlice(facts, episodes, transcript, c.question, opts);
    const recalled =
      c.expects === 'fact'
        ? slice.memoryFacts.some((f) => f.factKey === EARLY.factKey)
        : c.expects === 'zhFact'
          ? slice.memoryFacts.some((f) => f.factKey === EARLY.zhFactKey)
          : c.expects === 'episode'
            ? slice.recentEpisodes.some((e) => e.summary.includes(EARLY.episodeMarker))
            : (slice.transcriptSummary ?? '').includes(EARLY.transcriptMarker);
    const t = promptTokens(slice, c.question);
    const b = promptTokens(baseline, c.question);
    return {
      id: c.id,
      recalled,
      tokens: t,
      baselineTokens: b,
      sliceTokens: sliceTokens(slice),
      baselineSliceTokens: sliceTokens(baseline),
      pass: recalled && t < b,
    };
  });
}
