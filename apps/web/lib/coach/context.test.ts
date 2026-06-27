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
