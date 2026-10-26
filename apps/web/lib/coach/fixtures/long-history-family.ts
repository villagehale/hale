import type { MemoryEpisodeContext, MemoryFactContext } from '../context';
import type { TranscriptMessage } from '../conversation';

/**
 * VIL-144 — a fictional family with seven months of history (2026-03 → 2026-10).
 * No real family data. The early details planted in month one are what the
 * long-history eval asks about in month seven; everything else is filler that
 * outnumbers them, outranks them on confidence, and is newer than them.
 */

export const EARLY = {
  factKey: 'juniper_allergy_sesame',
  episodeMarker: 'Riverdale pool',
  transcriptMarker: 'Dr. Okafor',
  zhFactKey: 'juniper_violin_teacher',
} as const;

const START = Date.UTC(2026, 2, 1);
const DAY = 86_400_000;
const iso = (day: number) => new Date(START + day * DAY).toISOString();

/** Facts rows as the context loader orders them: confidence desc, valid_from desc. */
export function longHistoryFacts(): MemoryFactContext[] {
  const filler: MemoryFactContext[] = Array.from({ length: 220 }, (_, i) => ({
    childId: i % 2 === 0 ? 'child-juniper' : 'child-theo',
    factType: ['routine', 'preference', 'logistics'][i % 3] ?? 'routine',
    factKey: `weekly_note_${i}`,
    factValue: { note: `Saturday market stall ${i} and soccer carpool rota week ${i % 30}` },
    confidence: 0.95 - (i % 20) / 100,
  }));
  const early: MemoryFactContext[] = [
    {
      childId: 'child-juniper',
      factType: 'health',
      factKey: EARLY.factKey,
      factValue: { detail: 'Juniper is allergic to sesame; carries an EpiPen' },
      confidence: 0.6,
    },
    {
      childId: 'child-juniper',
      factType: 'activity',
      factKey: EARLY.zhFactKey,
      factValue: { detail: '小提琴老师是王老师，周三下午上课' },
      confidence: 0.55,
    },
  ];
  return [...filler, ...early];
}

/** Episodes newest-first, as the loader reads them. */
export function longHistoryEpisodes(): MemoryEpisodeContext[] {
  const filler: MemoryEpisodeContext[] = Array.from({ length: 200 }, (_, i) => ({
    childId: 'child-theo',
    occurredAt: iso(10 + i),
    episodeType: 'outing',
    summary: `Theo went to the library story time and the park, week ${i}`,
  }));
  const early: MemoryEpisodeContext = {
    childId: 'child-juniper',
    occurredAt: iso(3),
    episodeType: 'activity',
    summary: `Juniper had her first swim lesson at ${EARLY.episodeMarker}; loved it, cried at the deep end`,
  };
  return [...filler, early].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

/** ~900 turns over seven months, with the dentist detail in week one. */
export function longHistoryTranscript(): TranscriptMessage[] {
  const out: TranscriptMessage[] = [
    { role: 'user', content: `Juniper's dentist is ${EARLY.transcriptMarker} on Bloor, cleaning every six months` },
    { role: 'assistant', content: `Got it, ${EARLY.transcriptMarker} on Bloor for Juniper's cleanings.` },
  ];
  for (let i = 0; i < 450; i += 1) {
    out.push({ role: 'user', content: `anything fun this weekend near us? week ${i}` });
    out.push({ role: 'assistant', content: `Found a farmers market and a puppet show for week ${i}.` });
  }
  return out;
}

export interface LongHistoryCase {
  id: string;
  question: string;
  /** Which planted early detail the context must still carry for this question. */
  expects: 'fact' | 'episode' | 'transcript' | 'zhFact';
}

export const LONG_HISTORY_CASES: LongHistoryCase[] = [
  { id: 'en-sesame', question: 'Is the bakery birthday party safe for Juniper with her sesame thing?', expects: 'fact' },
  { id: 'en-swim', question: 'Should Juniper go back to swim lessons at Riverdale pool this winter?', expects: 'episode' },
  { id: 'en-dentist', question: "When is Juniper due at the dentist again, who was it?", expects: 'transcript' },
  { id: 'zh-violin', question: '王老师的小提琴课这周还上吗？', expects: 'zhFact' },
  { id: 'es-sesame', question: '¿La fiesta tiene sesame? Juniper no puede comerlo', expects: 'fact' },
];

/**
 * A stored running summary as the thread-summary lane would leave it after folding
 * the first 800 turns. HAND-WRITTEN FIXTURE, labelled as such — not a recorded model
 * output (no paid call was made). Fictional family.
 */
export function longHistoryStoredSummary(): { summary: string; coveredTurns: number } {
  return {
    coveredTurns: 800,
    summary: `Parent said Juniper's dentist is ${EARLY.transcriptMarker} on Bloor, cleanings every six months; Hale confirmed. Most later turns: parent asks for weekend ideas near home; Hale suggested farmers markets and puppet shows.`,
  };
}
