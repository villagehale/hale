import { describe, expect, it } from 'vitest';
import { suggestionsForChildren, type SuggestionChild } from './suggestions';

/**
 * Dynamic stage-aware prompts replace the old static example chips. Each child's
 * suggestions are derived from their deriveStage + age via companionForChild, so a
 * toddler's parent and a teen's parent never see the same prompts. These assert the
 * STAGE drives the copy (derived from the spec, not copied from current output),
 * and that teen children surface generic family prompts only (rule #1 — no
 * teen-specific detail leaks into a chip).
 */

const NOW = new Date('2026-06-17T00:00:00Z');

function child(id: string, dateOfBirth: string, name: string | null): SuggestionChild {
  return { id, dateOfBirth, name };
}

describe('suggestionsForChildren', () => {
  it('gives a toddler parent toddler-stage prompts scoped to that child', () => {
    // Born May 2024 → ~25 months on the fixed NOW → toddler stage.
    const out = suggestionsForChildren([child('c1', '2024-05-01', 'Mara')], NOW);

    const toddler = out.find((g) => g.childId === 'c1');
    expect(toddler).toBeDefined();
    expect(toddler?.stage).toBe('toddler');
    // Toddler prompts mention tantrums / potty / words — never newborn or teen topics.
    const text = toddler?.prompts.join(' ').toLowerCase() ?? '';
    expect(text).toMatch(/tantrum|potty|words/);
    expect(text).not.toMatch(/solids|teen|curfew/);
  });

  it('gives a teen parent teen-appropriate prompts and never names the teen (rule #1)', () => {
    // Born 2010 → 16y → teenager.
    const out = suggestionsForChildren([child('c2', '2010-01-01', 'Eli')], NOW);

    const teen = out.find((g) => g.childId === 'c2');
    expect(teen?.stage).toBe('teenager');
    const text = teen?.prompts.join(' ') ?? '';
    expect(text.toLowerCase()).toMatch(/independ|privacy|screen|mood|wellbeing/);
    // Rule #1: a teen's name must not appear in a suggestion chip.
    expect(text).not.toContain('Eli');
  });

  it('always includes a whole-family group as the default scope', () => {
    const out = suggestionsForChildren([child('c1', '2024-05-01', 'Mara')], NOW);
    const family = out.find((g) => g.childId === null);
    expect(family).toBeDefined();
    expect(family?.prompts.length).toBeGreaterThan(0);
  });

  it('returns only the family group when there are no children', () => {
    const out = suggestionsForChildren([], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]?.childId).toBeNull();
  });
});
