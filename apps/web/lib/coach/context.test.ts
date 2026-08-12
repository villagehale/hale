import { describe, expect, it } from 'vitest';
import { _internal } from './context';

/**
 * Per-child focus reaching the agent context. The parent picks a child via the
 * chip; that child's slice must ground the agent on the right stage — and a teen's
 * slice must be redacted to stage only (rule #1: no name, no age, no companion
 * detail). A focus id naming no child of the family resolves to null (no
 * cross-family leak), falling back to the family scope.
 */

const NOW = new Date('2026-06-17T00:00:00Z');

const ROWS = [
  { id: 'tot', name: 'Mara', dateOfBirth: '2024-05-01' }, // ~25mo → toddler
  { id: 'teen', name: 'Eli', dateOfBirth: '2010-01-01' }, // 16y → teenager
];

describe('toFocusedChild', () => {
  it('surfaces a non-teen child with name, age, stage, and the companion view', () => {
    const focused = _internal.toFocusedChild('tot', ROWS, NOW);
    expect(focused).not.toBeNull();
    expect(focused?.id).toBe('tot');
    expect(focused?.stage).toBe('toddler');
    expect(focused?.name).toBe('Mara');
    expect(focused?.teenRedacted).toBe(false);
    // The deterministic companion view grounds the agent on the toddler stage.
    expect(focused?.companion?.stage).toBe('toddler');
    expect(focused?.ageMonths).toBe(25);
  });

  it('redacts a teenager to stage only — no name, age, or companion detail (rule #1)', () => {
    const focused = _internal.toFocusedChild('teen', ROWS, NOW);
    expect(focused?.stage).toBe('teenager');
    expect(focused?.teenRedacted).toBe(true);
    expect(focused?.name).toBeNull();
    expect(focused?.ageMonths).toBeNull();
    expect(focused?.companion).toBeNull();
  });

  it('resolves an unknown / cross-family focus id to null (no leak)', () => {
    expect(_internal.toFocusedChild('not-ours', ROWS, NOW)).toBeNull();
  });
});

/**
 * Recent episodes reach the agent (the LLM) via AgentContext.recentEpisodes. The
 * episodes table carries no teen flag, so an episode attributed to a 13+ child
 * would feed raw teen content to the model. Rule #1: a teen-scoped episode's
 * summary is redacted and its child scope dropped before it reaches the model,
 * while non-teen and family-wide episodes pass through.
 */
describe('redactEpisodesForTeens (rule #1)', () => {
  // DOB derived from the spec stage boundary (≥156 months) vs NOW, not code output.
  const stageByChild = new Map<string, 'teenager' | 'toddler'>([
    ['teen', 'teenager'],
    ['tot', 'toddler'],
  ]);

  it('redacts a teen episode summary and drops its child scope', () => {
    const out = _internal.redactEpisodesForTeens(
      [
        {
          childId: 'teen',
          episodeType: 'concern',
          summary: 'caught vaping behind the school',
          occurredAt: '2026-06-14T00:00:00.000Z',
        },
      ],
      stageByChild,
    );

    const [episode] = out;
    if (!episode) throw new Error('expected one redacted teen episode');
    expect(JSON.stringify(out)).not.toContain('vaping');
    expect(JSON.stringify(out)).not.toContain('school');
    expect(episode.childId).toBeNull();
    // Coarse type survives so the agent still knows the family logged a concern.
    expect(episode.episodeType).toBe('concern');
  });

  it('passes a non-teen and a family-wide episode through unchanged', () => {
    const input = [
      {
        childId: 'tot',
        episodeType: 'milestone',
        summary: 'first steps',
        occurredAt: '2026-06-13T00:00:00.000Z',
      },
      {
        childId: null,
        episodeType: 'logistic',
        summary: 'daycare tour booked',
        occurredAt: '2026-06-12T00:00:00.000Z',
      },
    ];
    const out = _internal.redactEpisodesForTeens(input, stageByChild);
    expect(out).toEqual(input);
  });
});

/**
 * Currently-valid facts reach the agent (the LLM) via AgentContext.memoryFacts.
 * Both the factKey (free text) and factValue (raw jsonb) can carry teen-specific
 * content, and the facts table is keyed by childId. Rule #1: a teen-scoped fact's
 * factKey AND factValue are redacted and its child scope dropped before it reaches
 * the model, while non-teen and family-wide facts pass through.
 */
describe('redactFactsForTeens (rule #1)', () => {
  // DOB derived from the spec stage boundary (≥156 months) vs NOW, not code output.
  const stageByChild = new Map<string, 'teenager' | 'toddler'>([
    ['teen', 'teenager'],
    ['tot', 'toddler'],
  ]);

  it('redacts a teen fact factKey and factValue and drops its child scope', () => {
    const out = _internal.redactFactsForTeens(
      [
        {
          childId: 'teen',
          factType: 'medical',
          factKey: 'pregnancy scare with boyfriend',
          factValue: { note: 'asked about a clinic' },
          confidence: 0.9,
        },
      ],
      stageByChild,
    );

    const [fact] = out;
    if (!fact) throw new Error('expected one redacted teen fact');
    // Sensitive teen content lives in BOTH the factKey and factValue — neither
    // may survive into the agent's context (the residual VIL-150 closes).
    expect(JSON.stringify(out)).not.toContain('pregnancy');
    expect(JSON.stringify(out)).not.toContain('boyfriend');
    expect(JSON.stringify(out)).not.toContain('clinic');
    expect(fact.childId).toBeNull();
    // Coarse type survives so the agent still knows the family has medical activity.
    expect(fact.factType).toBe('medical');
  });

  it('passes a non-teen and a family-wide fact through unchanged', () => {
    const input = [
      {
        childId: 'tot',
        factType: 'routine',
        factKey: 'nap schedule',
        factValue: { window: '12:30-14:00' },
        confidence: 0.8,
      },
      {
        childId: null,
        factType: 'household',
        factKey: 'pediatrician',
        factValue: { name: 'Dr. Lee' },
        confidence: 1,
      },
    ];
    const out = _internal.redactFactsForTeens(input, stageByChild);
    expect(out).toEqual(input);
  });
});

/**
 * The transcript the agent reasons over is bounded (MEM-4).
 *
 * One conversation of record per family is the right architecture, but it made
 * the transcript grow without limit — a product built for ages 0–18 was loading
 * the family's entire history into every turn, so the coach got slower and
 * dumber the longer a family stayed. Newest-N verbatim plus one compacted digest
 * bounds it; the digest NAMES what it dropped rather than silently shrinking the
 * thread (the same discipline as the agent loop's tool-result truncation notice).
 */
describe('compactTranscript (MEM-4)', () => {
  const turn = (role: 'user' | 'assistant', content: string) => ({ role, content });

  function thread(pairs: number, prefix = 'turn'): Array<{ role: 'user' | 'assistant'; content: string }> {
    const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (let i = 0; i < pairs; i += 1) {
      out.push(turn('user', `${prefix} question ${i}`));
      out.push(turn('assistant', `${prefix} answer ${i}`));
    }
    return out;
  }

  it('passes a short thread through untouched, with no digest', () => {
    const short = thread(3);
    const out = _internal.compactTranscript(short);
    expect(out.transcript).toEqual(short);
    expect(out.transcriptSummary).toBeNull();
  });

  it('keeps exactly the newest N turns verbatim once the budget is exceeded', () => {
    const long = thread(40); // 80 turns
    const out = _internal.compactTranscript(long);

    expect(out.transcript).toHaveLength(_internal.TRANSCRIPT_VERBATIM_TURNS);
    // The tail that survives is the NEWEST tail, in order — the last turn of the
    // input must still be the last turn the model sees.
    expect(out.transcript).toEqual(long.slice(long.length - _internal.TRANSCRIPT_VERBATIM_TURNS));
    expect(out.transcript[out.transcript.length - 1]).toEqual(turn('assistant', 'turn answer 39'));
  });

  it('names how many turns were dropped and carries the parent\'s earlier asks', () => {
    const long = [
      turn('user', 'we switched Ella to the 2pm nap'),
      ...thread(30),
    ];
    const out = _internal.compactTranscript(long);
    const summary = out.transcriptSummary;
    if (!summary) throw new Error('expected a digest for an over-budget thread');

    // The count is the real number of dropped turns, not a vague "some".
    expect(summary).toContain(String(long.length - _internal.TRANSCRIPT_VERBATIM_TURNS));
    // The parent's own earlier words survive — that is the continuity the digest buys.
    expect(summary).toContain('we switched Ella to the 2pm nap');
    // ...and the model is told this is partial, so it asks instead of asserting.
    expect(summary).toMatch(/partial/i);
  });

  it('bounds the digest itself — it does not grow with the thread', () => {
    const chatty = (pairs: number) =>
      _internal.compactTranscript(
        Array.from({ length: pairs * 2 }, (_, i) => turn(i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(400))),
      ).transcriptSummary ?? '';

    const hundred = chatty(100);
    const fiveThousand = chatty(5_000);

    // A digest that scales with history just relocates the unbounded transcript.
    // 50x the history may only move the length by the digits of the dropped-turn
    // count; anything per-turn would be orders of magnitude, not a rounding error.
    expect(fiveThousand.length - hundred.length).toBeLessThan(10);
    // ~4 chars/token: the whole compacted block stays well inside one turn's budget.
    expect(fiveThousand.length / 4).toBeLessThanOrEqual(512);
    // And when the digest's own budget bites, that is said too — never silent.
    expect(fiveThousand).toMatch(/omitted/i);
  });

  it('holds the whole thread slice bounded regardless of family age', () => {
    const decade = _internal.compactTranscript(thread(5_000));
    const oneYear = _internal.compactTranscript(thread(500));

    // The slice the model sees is a constant number of turns whatever the family's
    // age — this is the whole point: loyalty must not buy a slower, dumber coach.
    expect(decade.transcript).toHaveLength(_internal.TRANSCRIPT_VERBATIM_TURNS);
    expect(oneYear.transcript).toHaveLength(_internal.TRANSCRIPT_VERBATIM_TURNS);
    // 10x the history, same payload size to within the dropped-count's digits.
    const grew = JSON.stringify(decade).length - JSON.stringify(oneYear).length;
    expect(grew).toBeLessThan(10);
  });
});
