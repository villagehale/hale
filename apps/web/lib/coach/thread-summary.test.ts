import { describe, expect, it, vi } from 'vitest';
import { _internal } from './context';
import type { TranscriptMessage } from './conversation';
import {
  REFRESH_STEP,
  type StoredThreadSummary,
  type ThreadSummaryStore,
  haikuThreadSummarizer,
  refreshThreadSummary,
} from './thread-summary';

const turns = (n: number): TranscriptMessage[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `t${i}` }));

function memStore(initial: StoredThreadSummary | null = null) {
  let row = initial;
  const save = vi.fn(async (_c: string, _f: string, next: StoredThreadSummary) => {
    row = next;
  });
  const store: ThreadSummaryStore = { load: async () => row, save };
  return { store, save, get: () => row };
}

const V = _internal.TRANSCRIPT_VERBATIM_TURNS;
const base = { conversationId: 'c1', familyId: 'f1', verbatimTurns: V };

describe('refreshThreadSummary (VIL-144)', () => {
  it('skips until REFRESH_STEP turns have left the window', async () => {
    const { store, save } = memStore();
    const summarize = vi.fn(async () => 'x');
    expect(await refreshThreadSummary({ ...base, store, summarize, transcript: turns(V + REFRESH_STEP - 1) })).toBe('skipped');
    expect(summarize).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('folds only the turns past the stored coverage, never the verbatim window', async () => {
    const { store, get } = memStore({ summary: 'old', coveredTurns: 10 });
    const summarize = vi.fn(async (_p: string, t: readonly TranscriptMessage[]) => `new:${t.length}`);
    const transcript = turns(V + 40);
    expect(await refreshThreadSummary({ ...base, store, summarize, transcript })).toBe('updated');
    expect(summarize).toHaveBeenCalledWith('old', transcript.slice(10, 40));
    expect(get()).toEqual({ summary: 'new:30', coveredTurns: 40 });
  });

  it('on a failed fold keeps the stored row untouched and writes nothing', async () => {
    const prior = { summary: 'keep me', coveredTurns: 0 };
    const { store, save, get } = memStore(prior);
    const out = await refreshThreadSummary({ ...base, store, summarize: async () => null, transcript: turns(V + 60) });
    expect(out).toBe('failed');
    expect(save).not.toHaveBeenCalled();
    expect(get()).toBe(prior);
  });

  it('restarts from empty when the thread shrank below coverage (soft-deleted turns)', async () => {
    const { store } = memStore({ summary: 'has deleted content', coveredTurns: 500 });
    const summarize = vi.fn(async () => 'fresh');
    await refreshThreadSummary({ ...base, store, summarize, transcript: turns(V + 30) });
    expect(summarize).toHaveBeenCalledWith('', expect.any(Array));
  });

  it('the Haiku summarizer returns null (no fallback text) when the client throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const summarize = haikuThreadSummarizer(() => {
      throw new Error('no key');
    });
    expect(await summarize('', turns(4))).toBeNull();
    expect(JSON.stringify(err.mock.calls)).not.toContain('t1');
    err.mockRestore();
  });
});

describe('compactTranscript with a stored summary (VIL-144)', () => {
  it('uses a summary that covers dropped turns, with a smaller excerpt budget', () => {
    const t = turns(V + 100);
    const out = _internal.compactTranscript(t, '', { summary: 'S-SUMMARY', coveredTurns: 80 });
    expect(out.transcriptSummary).toContain('S-SUMMARY');
    expect(out.transcript).toHaveLength(V);
  });

  it('ignores a summary claiming more turns than were cut (stale or forged)', () => {
    const out = _internal.compactTranscript(turns(V + 10), '', { summary: 'S-STALE', coveredTurns: 50 });
    expect(out.transcriptSummary).not.toContain('S-STALE');
  });

  it('without a summary the digest is exactly what it was', () => {
    const t = turns(V + 30);
    expect(_internal.compactTranscript(t, 'q', null)).toEqual(_internal.compactTranscript(t, 'q'));
  });
});
