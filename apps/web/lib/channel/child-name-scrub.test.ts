import { describe, expect, it } from 'vitest';
import { scrubChildNames } from './child-name-scrub';

/**
 * Rule #1: a child's name never crosses the border to the US search tool. These are the
 * asks the intake read now routes to a search in any language, so every alphabet a
 * Canadian or US family writes in has to lose the name before it leaves.
 */
describe('scrubChildNames', () => {
  it('drops an English name, and keeps the rest of the ask (positive control)', () => {
    const scrub = scrubChildNames('When does swim open for Ava?', ['Ava']);
    expect(scrub).toEqual({ ok: true, text: 'When does swim open for ?' });
  });

  it('drops a Chinese name written with no space around it', () => {
    const scrub = scrubChildNames('小明什么时候可以报名游泳课？', ['小明']);
    expect(scrub).toEqual({ ok: true, text: '什么时候可以报名游泳课?' });
  });

  it('drops an accented French name at the end of a word run', () => {
    const scrub = scrubChildNames('Quand ouvrent les inscriptions au camp pour Zoé?', ['Zoé']);
    expect(scrub.ok).toBe(true);
    if (!scrub.ok) return;
    expect(scrub.text).not.toMatch(/zo/i);
    expect(scrub.text).toContain('inscriptions au camp pour');
  });

  it('drops an accented Spanish name, whatever its case', () => {
    const scrub = scrubChildNames('¿Cuándo abren las clases de natación para JOSÉ?', ['José']);
    expect(scrub.ok).toBe(true);
    if (!scrub.ok) return;
    expect(scrub.text).not.toMatch(/jos/i);
    expect(scrub.text).toContain('natación');
  });

  it('drops a name split by an invisible character or written decomposed', () => {
    const zeroWidth = scrubChildNames('camp pour Zo​é?', ['Zoé']);
    const decomposed = scrubChildNames('camp pour Zoé?', ['Zoé']);
    expect(zeroWidth).toEqual({ ok: true, text: 'camp pour ?' });
    expect(decomposed).toEqual({ ok: true, text: 'camp pour ?' });
  });

  it('refuses when the name is still there without its accent, rather than search with it', () => {
    expect(scrubChildNames('camp pour Zoe?', ['Zoé'])).toEqual({
      ok: false,
      refusal: 'names_a_child',
    });
  });

  it('keeps a word that only contains a Latin name', () => {
    const scrub = scrubChildNames('Is the pool available for Ava?', ['Ava']);
    expect(scrub).toEqual({ ok: true, text: 'Is the pool available for ?' });
  });
});
